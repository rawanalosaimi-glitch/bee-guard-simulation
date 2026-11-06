import { rescueTruth } from '../src/sim/rescue';
import { describe, expect, it } from 'vitest';
import { comparisonRoutes, doseAt, doseFromRate, doseProfile, uSvToMSv } from '../src/sim';
import type { DoseProfile } from '../src/sim';
import { completedRun } from './helpers';

/** 10×3 grid of 4 m cells starting at (0, 0); `rate(ix)` per column, NaN = unmeasured. */
function grid(rate: (ix: number) => number) {
  const nx = 10;
  const nz = 3;
  const values = new Float64Array(nx * nz);
  const counts = new Uint32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const v = rate(ix);
      values[iz * nx + ix] = v;
      counts[iz * nx + ix] = Number.isNaN(v) ? 0 : 1;
    }
  return { x0: 0, z0: 0, cell: 4, nx, nz, values, counts };
}
const line = (x1: number) => [
  { x: 0, z: 6 },
  { x: x1, z: 6 },
];
const close = (a: number, b: number, tol = 1e-12) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('Phase 3B+ — cumulative dose integration (dose comparison chart)', () => {
  it('converts units: µSv → mSv and µSv/h × s → µSv', () => {
    expect(uSvToMSv(1000)).toBe(1);
    close(uSvToMSv(4.9e-3), 4.9e-6);
    expect(doseFromRate(1, 3600)).toBe(1); // 1 µSv/h for 1 h = 1 µSv
    close(doseFromRate(3.6, 10), 0.01);
  });

  it('integrates a constant rate exactly: D = Ḣ · (L / v) / 3600, linear in time', () => {
    const p = doseProfile(line(36), grid(() => 3.6), 1, 'SURVEYED');
    close(p.duration_s, 36, 1e-9);
    close(p.total_uSv, (3.6 * 36) / 3600);
    close(doseAt(p, 18), p.total_uSv / 2);
    expect(p.lowerBound).toBe(false);
    expect(p.points.every((q) => q.kind === 'MEASURED')).toBe(true);
    // slower team → proportionally more time and dose
    const slow = doseProfile(line(36), grid(() => 3.6), 0.5, 'SURVEYED');
    close(slow.duration_s, 72, 1e-9);
    close(slow.total_uSv, 2 * p.total_uSv);
  });

  it('integrates a stepped field cell by cell (∫ Ḣ dt, not a drawn curve)', () => {
    // columns 0–4 at 1 µSv/h, 5–9 at 10 µSv/h; route 0 → 40 m at 2 m/s
    const p = doseProfile(line(40), grid((ix) => (ix < 5 ? 1 : 10)), 2, 'SURVEYED');
    close(p.total_uSv, (1 * 10 + 10 * 10) / 3600, 1e-12);
    close(doseAt(p, 10), (1 * 10) / 3600, 1e-12);
    // non-decreasing, times strictly increasing
    for (let i = 1; i < p.points.length; i++) {
      expect(p.points[i].t_s).toBeGreaterThan(p.points[i - 1].t_s);
      expect(p.points[i].dose_uSv).toBeGreaterThanOrEqual(p.points[i - 1].dose_uSv);
    }
    expect(doseAt(p, 1e9)).toBe(p.total_uSv); // held after arrival
    expect(doseAt(p, -1)).toBe(0);
  });

  it('missing data: not counted (lower bound) unless the route is SURVEYED, where short gaps use the adjacent rate', () => {
    const g = grid((ix) => (ix === 4 ? Number.NaN : ix < 4 ? 1 : 3));
    const partial = doseProfile(line(40), g, 1, 'PARTIAL');
    expect(partial.lowerBound).toBe(true);
    close(partial.unknown_s, 4, 1e-9);
    close(partial.total_uSv, (1 * 16 + 3 * 20) / 3600);
    expect(partial.points.some((q) => q.kind === 'UNKNOWN' && q.rate_uSv_h === null)).toBe(true);
    const surveyed = doseProfile(line(40), g, 1, 'SURVEYED');
    expect(surveyed.lowerBound).toBe(false);
    close(surveyed.gapFill_s, 4, 1e-9);
    close(surveyed.total_uSv, (1 * 16 + 3 * 4 + 3 * 20) / 3600); // gap at max(adjacent) = 3 µSv/h
    // a route with no data at all is all UNKNOWN with zero (lower-bound) dose — never invented
    const none = doseProfile(line(40), grid(() => Number.NaN), 1, 'UNKNOWN');
    expect(none.total_uSv).toBe(0);
    expect(none.lowerBound).toBe(true);
  });

  it('compares routes by role and never invents a missing one', () => {
    const prof = (d: number): DoseProfile => ({ points: [{ t_s: 0, dose_uSv: 0, kind: 'MEASURED', rate_uSv_h: 1 }, { t_s: 10, dose_uSv: d, kind: 'MEASURED', rate_uSv_h: 1 }], duration_s: 10, total_uSv: d, lowerBound: false, measured_s: 10, gapFill_s: 0, unknown_s: 0 });
    const cand = (id: string, d: number) => ({ id, label: id, verified: true, evaluation: { doseTotal_uSv: d, doseMeasured_uSv: d, doseTotalSigma_uSv: 0, doseMeasuredSigma_uSv: 0, coverage: 1 }, profile: prof(d) });
    const three = comparisonRoutes([cand('R1', 2), cand('R2', 5), cand('R3', 3), cand('R4', 4)], 'R1');
    expect(three.map((r) => [r.role, r.candidateId])).toEqual([
      ['HIGHEST', 'R2'],
      ['ALTERNATIVE', 'R4'],
      ['RECOMMENDED', 'R1'],
    ]);
    expect(comparisonRoutes([cand('R1', 2), cand('R2', 5)], 'R1').map((r) => r.role)).toEqual(['HIGHEST', 'RECOMMENDED']);
    expect(comparisonRoutes([cand('R1', 2)], 'R1').map((r) => r.role)).toEqual(['RECOMMENDED']);
    expect(comparisonRoutes([], null)).toEqual([]);
  });
});

describe('Phase 3B+ — dose profiles of the actual rescue plan', () => {
  const { engine, state } = completedRun();
  const p = state.rescue.current!;

  it('every candidate curve ends at the route dose of the Evacuation metrics and lasts the walk time', () => {
    expect(p.candidates.length).toBeGreaterThan(0);
    for (const c of p.candidates) {
      const ev = c.evaluation;
      close(c.profile.total_uSv, ev.doseTotal_uSv ?? ev.doseMeasured_uSv, 1e-12);
      close(c.profile.duration_s, ev.walkTime_s, 1e-6);
      close(c.profile.duration_s, ev.length_m / engine.config.evacuation.walkingSpeed_mps, 1e-6);
      expect(c.profile.lowerBound).toBe(ev.doseTotal_uSv === null && ev.unknownLength_m > 0);
    }
  });

  it('the comparison keeps the recommended route green and stays available after COMPLETE', () => {
    expect(state.status).toBe('COMPLETE');
    const routes = comparisonRoutes(p.candidates, p.recommendedId);
    expect(routes.length).toBe(Math.min(3, p.candidates.length));
    expect(routes.filter((r) => r.role === 'RECOMMENDED').map((r) => r.candidateId)).toEqual([p.recommendedId]);
    const others = routes.filter((r) => r.role !== 'RECOMMENDED');
    if (others.length === 2) expect(others[0].dose_uSv).toBeGreaterThanOrEqual(others[1].dose_uSv);
    // unit: mSv values of the right magnitude (µSv / 1000)
    for (const r of routes) close(uSvToMSv(r.dose_uSv) * 1000, r.dose_uSv, 1e-15);
  });

  it('flags insufficient data: a detour over unsurveyed ground is a lower bound in an UNVERIFIED plan', () => {
    // v0.7.0: this situation (a detour over unsurveyed ground) only arises with the v0.6.0 unknown-ground
    // rule, which costs unmeasured ground at 3 × background; with the default conservative rule the planner
    // finds a measured detour instead (next test). The profile logic is tested on the v0.6.0 rule.
    const r = completedRun({ radiation: { sourcePosition: { x: -36, y: 0.5, z: 30 } }, evacuation: { unknownPolicy: 'BACKGROUND_MULTIPLE' } });
    const q = r.state.rescue.current!;
    expect(q.status).toBe('UNVERIFIED');
    const routes = comparisonRoutes(q.candidates, q.recommendedId);
    const green = routes.find((x) => x.role === 'RECOMMENDED')!;
    expect(green.profile.lowerBound).toBe(true);
    expect(green.profile.unknown_s).toBeGreaterThan(10);
    // the direct route through the hotspot is the red, highest-exposure curve
    const red = routes.find((x) => x.role === 'HIGHEST')!;
    expect(red.dose_uSv).toBeGreaterThan(green.dose_uSv);
  });

  it('v0.7.0 conservative rule: same source — the recommended detour runs over MEASURED ground, avoids the hotspot and is verified on data', () => {
    const r = completedRun({ radiation: { sourcePosition: { x: -36, y: 0.5, z: 30 } } });
    const q = r.state.rescue.current!;
    const rec = q.candidates.find((c) => c.id === q.recommendedId)!;
    const short = q.candidates.find((c) => c.kappa === 0)!;
    expect(q.status).toBe('VERIFIED');
    expect(rec.dataCheck).toBe('PASS');
    expect(rec.rateCheck).toBe('PASS');
    expect(rec.evaluation.coverage).toBeGreaterThanOrEqual(0.9);
    // the recommendation avoids the hotspot on the direct route (true dose, evaluation only)
    expect(rescueTruth(rec, r.engine.config).at1m.dose_uSv).toBeLessThan(0.2 * rescueTruth(short, r.engine.config).at1m.dose_uSv);
  });
});
