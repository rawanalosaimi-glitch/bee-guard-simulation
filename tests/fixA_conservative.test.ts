import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SimEngine, makeConfig } from '../src/sim';
import type { SimConfig } from '../src/sim';
import { conservativeEnvelope } from '../src/sim/conservative';
import { buildGrid } from '../src/sim/heatmap';
import { computeRescuePlan, RATE_LIMIT_LABEL, unverifiedReasonOf } from '../src/sim/rescue';
import { planRoute } from '../src/sim/routePlanner';
import { EXPERIMENT_SCENARIOS, scenarioConfig } from '../src/sim/experiment';

/**
 * v0.7.0 Fix A — conservative handling of unmeasured ground, separate data / rate checks,
 * the illustrative 2.5 µSv/h planning threshold (unchanged), never "safe" on missing data.
 */
const world = new SimEngine({}).world;
const HM = DEFAULT_CONFIG.radiation.heatmap;
const cellCentre = (i: number, j: number) => ({ x: HM.x0 + (i + 0.5) * HM.cell, z: HM.z0 + (j + 0.5) * HM.cell });

/** One synthetic received sample per heat-map cell where rate(x, z) is not null. */
function samples(rate: (x: number, z: number) => number | null) {
  const out = [];
  let id = 0;
  for (let j = 0; j < HM.nz; j++)
    for (let i = 0; i < HM.nx; i++) {
      const c = cellCentre(i, j);
      const v = rate(c.x, c.z);
      if (v === null) continue;
      out.push({ sampleId: ++id, droneId: 'BEE-01', sampleTime: 100, rxTime: 100, x: c.x, y: 15, z: c.z, liveTime_s: 1, counts: v * DEFAULT_CONFIG.radiation.sensitivity_cps_per_uSv_h, measured_uSv_h: v });
    }
  return out;
}
function plan(rate: (x: number, z: number) => number | null, goal = { x: -16, z: 14 }, config: SimConfig = makeConfig({})) {
  const state = { time: 500, comms: { gs: { radiationSamples: samples(rate) } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return computeRescuePlan({ config, world, state: state as any }, { patientId: 'CAS-1', x: goal.x, z: goal.z, sigma_m: 0.1 }, 100, 1);
}
const near = (x: number, z: number, g: { x: number; z: number }, r: number) => Math.hypot(x - g.x, z - g.z) <= r;

describe('Fix A — threshold and labels', () => {
  it('keeps the 2.5 µSv/h threshold unchanged (rescue route and dashboard alert) and labels it illustrative', () => {
    expect(DEFAULT_CONFIG.rescue.maxRate_uSv_h).toBe(2.5);
    expect(DEFAULT_CONFIG.alerts.doseRate_uSv_h).toBe(2.5);
    expect(RATE_LIMIT_LABEL).toContain('not a validated emergency-rescue safety limit');
    expect(DEFAULT_CONFIG.evacuation.unknownPolicy).toBe('CONSERVATIVE_NEIGHBOURHOOD');
    expect(DEFAULT_CONFIG.evacuation.conservativeRadius_m).toBe(12);
  });

  it('reason mapping', () => {
    expect(unverifiedReasonOf('PASS', 'PASS')).toBe(null);
    expect(unverifiedReasonOf('FAIL', 'PASS')).toBe('INSUFFICIENT_DATA');
    expect(unverifiedReasonOf('PASS', 'FAIL')).toBe('ABOVE_LIMIT');
    expect(unverifiedReasonOf('FAIL', 'FAIL')).toBe('INSUFFICIENT_DATA_AND_ABOVE_LIMIT');
    expect(unverifiedReasonOf('FAIL', 'NO_DATA')).toBe('NO_DATA');
  });
});

describe('Fix A — conservative neighbourhood envelope', () => {
  it('unmeasured cell next to a hot measured cell is assumed at least that hot; far cells take the map maximum', () => {
    const g = buildGrid(
      [
        { x: cellCentre(10, 10).x, y: 15, z: cellCentre(10, 10).z, value: 4, time: 0 },
        { x: cellCentre(30, 25).x, y: 15, z: cellCentre(30, 25).z, value: 0.2, time: 0 },
      ],
      HM,
    );
    const env = conservativeEnvelope(g, 12);
    expect(env.globalMax).toBe(4);
    const nb = cellCentre(12, 10); // 8 m away
    expect(env.lookup(nb.x, nb.z)).toBe(4);
    const nb2 = cellCentre(13, 10); // 12 m away (boundary included)
    expect(env.lookup(nb2.x, nb2.z)).toBe(4);
    const nb3 = cellCentre(30, 24); // 4 m from the 0.2 cell, far from the 4 cell
    expect(env.lookup(nb3.x, nb3.z)).toBe(0.2);
    const far = cellCentre(20, 30); // nothing within 12 m → map maximum
    expect(env.lookup(far.x, far.z)).toBe(4);
    // outside the heat-map grid: same rule
    expect(env.lookup(-105, -100)).toBe(4);
  });

  it('no measurement at all → no value (no dose figure is made up)', () => {
    const env = conservativeEnvelope(buildGrid([], HM), 12);
    expect(env.globalMax).toBe(null);
    expect(env.lookup(0, 0)).toBe(null);
  });

  it('the planner does not treat unmeasured ground as clean when the conservative rule is given', () => {
    // straight line from A to B crosses MEASURED clean ground; a shorter-looking unmeasured strip lies beside a hot cell
    const pts = [];
    for (let x = -40; x <= 40; x += 4) for (let z = -2; z <= 2; z += 4) pts.push({ x, y: 15, z, value: 0.1, time: 0 });
    pts.push({ x: 0, y: 15, z: 10, value: 50, time: 0 });
    const g = buildGrid(pts, HM);
    const env = conservativeEnvelope(g, 12);
    const dose = (x: number, z: number) => {
      const i = Math.floor((x - g.x0) / g.cell);
      const j = Math.floor((z - g.z0) / g.cell);
      const v = g.values[j * g.nx + i];
      return Number.isNaN(v) ? null : v;
    };
    const prm = { cell: 1, clearance: 0.5, walkingSpeed_mps: 1, radiationWeight: 4, unknownMultiplier: 3, background_uSv_h: 0.1, bounds: { x0: -45, z0: -20, x1: 45, z1: 20 } };
    const r = planRoute({ x: -38, z: 0 }, { x: 38, z: 0 }, [], dose, prm, env.lookup);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.metrics.doseConservative_uSv).not.toBe(null);
    expect(r.metrics.doseConservative_uSv as number).toBeGreaterThanOrEqual(r.metrics.doseMeasuredStretches_uSv);
    // without the rule the same evaluation has no conservative figure (v0.6.0 behaviour)
    const legacy = planRoute({ x: -38, z: 0 }, { x: 38, z: 0 }, [], dose, prm);
    expect(legacy.ok && legacy.metrics.doseConservative_uSv).toBe(null);
  });
});

describe('Fix A — rescue route: separate checks, never "safe" on missing or above-threshold data', () => {
  it('fully measured, all below the threshold → VERIFIED (data PASS, rate PASS)', () => {
    const p = plan(() => 0.1);
    expect(p.status).toBe('VERIFIED');
    const rec = p.candidates.find((c) => c.id === p.recommendedId)!;
    expect(rec.dataCheck).toBe('PASS');
    expect(rec.rateCheck).toBe('PASS');
    expect(p.unverifiedReason).toBe(null);
    expect(p.destination.aboveLimit).toBe(false);
  });

  it('an unmeasured strip across every route → UNVERIFIED (INSUFFICIENT_DATA), never VERIFIED', () => {
    const p = plan((x) => (x > -48 && x < -36 ? null : 0.1));
    expect(p.status).toBe('UNVERIFIED');
    expect(p.unverifiedReason).toBe('INSUFFICIENT_DATA');
    for (const c of p.candidates) expect(c.verified).toBe(false);
    expect(p.warnings.join(' ')).toContain('Do not treat this route as safe');
    const rec = p.candidates.find((c) => c.id === p.recommendedId)!;
    // unmeasured stretch assumed at the highest nearby measured rate (0.1 here), never at zero
    expect(rec.unmeasuredConservativeDose_uSv as number).toBeGreaterThan(0);
    expect(rec.doseConservative_uSv as number).toBeGreaterThan(rec.evaluation.doseMeasured_uSv);
  });

  it('exactly 2.5 µSv/h at the casualty → ABOVE_LIMIT and destination flagged; 2.4999 passes', () => {
    const goal = { x: -16, z: 14 };
    const at = plan((x, z) => (near(x, z, goal, 3) ? 2.5 : 0.1), goal);
    expect(at.status).toBe('UNVERIFIED');
    expect(at.unverifiedReason).toBe('ABOVE_LIMIT');
    expect(at.destination.aboveLimit).toBe(true);
    expect(at.warnings.join(' ')).toContain(RATE_LIMIT_LABEL);
    expect(at.warnings.join(' ')).toContain('casualty location itself');
    const below = plan((x, z) => (near(x, z, goal, 3) ? 2.4999 : 0.1), goal);
    expect(below.status).toBe('VERIFIED');
    expect(below.destination.aboveLimit).toBe(false);
  });

  it('nothing measured → UNVERIFIED (NO_DATA) with no dose figure', () => {
    const p = plan(() => null);
    expect(p.status).toBe('UNVERIFIED');
    expect(p.unverifiedReason).toBe('NO_DATA');
    for (const c of p.candidates) expect(c.doseConservative_uSv).toBe(null);
    expect(p.destination.aboveLimit).toBe(null);
  });

  it('measured-only dose ≤ total (SURVEYED) ≤ conservative estimate, on a real mission', () => {
    const e = new SimEngine({ seed: 42 });
    e.runToCompletion();
    const p = e.state.rescue.current!;
    for (const c of p.candidates) {
      expect(c.doseConservative_uSv as number).toBeGreaterThanOrEqual(c.evaluation.doseMeasured_uSv - 1e-15);
      if (c.evaluation.doseTotal_uSv !== null) {
        expect(c.evaluation.doseTotal_uSv).toBeGreaterThanOrEqual(c.evaluation.doseMeasured_uSv - 1e-15);
        expect(c.doseConservative_uSv as number).toBeGreaterThanOrEqual(c.evaluation.doseTotal_uSv - 1e-12);
      }
      // invariant: verified ⇔ both checks pass
      expect(c.verified).toBe(c.dataCheck === 'PASS' && c.rateCheck === 'PASS');
    }
  });

  it('HIGH scenario: the well-measured route is preferred over a poorly measured detour, still UNVERIFIED (ABOVE_LIMIT); v0.6.0 rule reproduces the old choice', () => {
    const sc = EXPERIMENT_SCENARIOS.find((s) => s.id === 'HIGH')!;
    const e = new SimEngine(scenarioConfig(sc, 102));
    e.runToCompletion();
    const p = e.state.rescue.current!;
    const rec = p.candidates.find((c) => c.id === p.recommendedId)!;
    expect(p.status).toBe('UNVERIFIED');
    expect(p.unverifiedReason).toBe('ABOVE_LIMIT');
    expect(p.destination.aboveLimit).toBe(true);
    // the recommendation is the lowest conservative estimate, and it is a well-measured route
    expect(rec.doseConservative_uSv).toBe(Math.min(...p.candidates.map((c) => c.doseConservative_uSv as number)));
    expect(rec.evaluation.coverage).toBeGreaterThan(0.9);
    expect(rec.dataCheck).toBe('PASS');
    expect(p.warnings.join(' ')).toContain('Do not treat this route as safe');

    const legacy = new SimEngine(scenarioConfig(sc, 102, { evacuation: { unknownPolicy: 'BACKGROUND_MULTIPLE' } }));
    legacy.runToCompletion();
    const lp = legacy.state.rescue.current!;
    const lrec = lp.candidates.find((c) => c.id === lp.recommendedId)!;
    expect(lp.status).toBe('UNVERIFIED');
    expect(lrec.evaluation.coverage).toBeLessThan(0.5); // the v0.6.0 fallback picked a poorly measured detour
  });
});
