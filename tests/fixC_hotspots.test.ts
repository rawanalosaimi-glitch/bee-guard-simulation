import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SimEngine } from '../src/sim';
import type { SimConfigOverrides } from '../src/sim';
import { buildGrid } from '../src/sim/heatmap';
import { findPeaks } from '../src/sim/hotspotDetect';
import type { HotspotParams } from '../src/sim/hotspotDetect';
import { SeededRng, poisson } from '../src/sim/rng';
import { EXPERIMENT_SCENARIOS, scenarioConfig } from '../src/sim/experiment';
import { eventsOf } from './helpers';

/** v0.7.0 Fix C — significance + prominence hotspot detection, no duplicates, separate sources kept, early scan. */
const HM = DEFAULT_CONFIG.radiation.heatmap;
const A = DEFAULT_CONFIG.survey.adaptive;
const R = DEFAULT_CONFIG.radiation;
const P: HotspotParams = {
  background_uSv_h: R.background_uSv_h,
  sensitivity_cps_per_uSv_h: R.sensitivity_cps_per_uSv_h,
  calibrationFactor: R.calibrationFactor,
  zTrigger: A.zTrigger,
  minFactorOverBackground: A.minFactorOverBackground,
  confirmRadius_m: A.confirmRadius_m,
  confirmCompleteness: A.confirmCompleteness,
  dipSigma: A.dipSigma,
  dipFraction: A.dipFraction,
  equalValueTieBreak: A.equalValueTieBreak,
};
const H = 13.7; // survey altitude above the source, m

/** Synthetic on-board map: one 1 s reading per cell of the survey area, Poisson counts (seeded). */
function map(sources: { x: number; z: number; s: number }[], seed = 1, noise = true) {
  const rng = new SeededRng(seed);
  const pts = [];
  const reach = new Uint8Array(HM.nx * HM.nz);
  const a = DEFAULT_CONFIG.survey.area;
  for (let j = 0; j < HM.nz; j++)
    for (let i = 0; i < HM.nx; i++) {
      const x = HM.x0 + (i + 0.5) * HM.cell;
      const z = HM.z0 + (j + 0.5) * HM.cell;
      if (x < a.x0 || x > a.x1 || z < a.z0 || z > a.z1) continue;
      reach[j * HM.nx + i] = 1;
      let rate = R.background_uSv_h;
      for (const q of sources) rate += q.s / ((x - q.x) ** 2 + (z - q.z) ** 2 + H * H);
      const lam = rate * R.sensitivity_cps_per_uSv_h;
      const counts = noise ? poisson(rng, lam) : lam;
      pts.push({ x, y: 15, z, value: counts / R.sensitivity_cps_per_uSv_h, time: 0, counts, live: 1 });
    }
  return { g: buildGrid(pts, HM), reach };
}
const near = (pk: { x: number; z: number }, q: { x: number; z: number }, d: number) => Math.hypot(pk.x - q.x, pk.z - q.z) <= d;

describe('Fix C — detection rule (synthetic maps)', () => {
  it('defaults: 5σ, 3 × background (v0.7.1 experiment 2 × not adopted), 28 m confirmation, 80 % completeness, dip 3σ and 10 %, equal-value tie break', () => {
    expect([A.detection, A.zTrigger, A.minFactorOverBackground, A.confirmRadius_m, A.confirmCompleteness, A.dipSigma, A.dipFraction, A.scanTiming, A.equalValueTieBreak]).toEqual([
      'SIGNIFICANCE_PROMINENCE', 5, 3, 28, 0.8, 3, 0.1, 'NEXT_LANE_END', true,
    ]);
  });

  it('background only: no hotspot in 50 independent noisy maps (false alarms)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { g, reach } = map([], seed);
      expect(findPeaks(g, reach, P, true).length).toBe(0);
    }
  });

  it('one source — weak (LOW), default (MEDIUM) or strong (HIGH): exactly ONE peak, within two cells (8 m) of the source', () => {
    for (const s of [50, 500, 5000]) {
      for (let seed = 1; seed <= 10; seed++) {
        const src = { x: 18, z: 21.3, s };
        const peaks = findPeaks(map([src], seed).g, map([src], seed).reach, P, true);
        expect(peaks.length).toBe(1);
        expect(near(peaks[0], src, 8)).toBe(true);
      }
    }
  });

  it('two separate sources are BOTH kept (not suppressed): 30 m equal, 40 m equal, 40 m at 1:2 strength', () => {
    for (const [d, s2] of [[40, 500], [30, 500], [40, 250]] as const) {
      for (let seed = 1; seed <= 5; seed++) {
        const a = { x: 0, z: 0, s: 500 };
        const b = { x: d, z: 0, s: s2 };
        const { g, reach } = map([a, b], seed);
        const peaks = findPeaks(g, reach, P, true);
        expect(peaks.length).toBe(2);
        // within 2 cells: the stronger source's slope shifts the weaker apparent peak toward it (superposition)
        expect(peaks.some((p) => near(p, a, 8))).toBe(true);
        expect(peaks.some((p) => near(p, b, 8))).toBe(true);
      }
    }
  });

  it('DOCUMENTED LIMITATION: a source half as strong 30 m from a stronger one is merged (dip ≈ 5 %, not significant from 13.7 m above)', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { g, reach } = map([{ x: 0, z: 0, s: 500 }, { x: 30, z: 0, s: 250 }], seed);
      expect(findPeaks(g, reach, P, true).length).toBe(1);
    }
  });

  it('physical resolution limit: sources 8 m apart seen from 13.7 m above form ONE peak (no dip exists in the field)', () => {
    const { g, reach } = map([{ x: 0, z: 0, s: 500 }, { x: 8, z: 0, s: 500 }], 1, false);
    expect(findPeaks(g, reach, P, true).length).toBe(1);
  });

  it('confirmation waits for the neighbourhood: a half-surveyed peak is not confirmed until the final evaluation', () => {
    const src = { x: 18, z: 21.3, s: 500 };
    const full = map([src], 3);
    // keep only cells with z ≤ source z (lanes not yet flown beyond the peak)
    const pts = [];
    for (let k = 0; k < HM.nx * HM.nz; k++) {
      if (!(full.g.counts[k] > 0)) continue;
      const x = HM.x0 + ((k % HM.nx) + 0.5) * HM.cell;
      const z = HM.z0 + (Math.floor(k / HM.nx) + 0.5) * HM.cell;
      if (z > 24) continue;
      pts.push({ x, y: 15, z, value: full.g.values[k], time: 0, counts: full.g.countSum[k], live: full.g.liveSum[k] });
    }
    const half = buildGrid(pts, HM);
    const notFinal = findPeaks(half, full.reach, P, false);
    expect(notFinal.every((p) => !p.confirmed)).toBe(true);
    expect(findPeaks(half, full.reach, P, true).filter((p) => p.confirmed).length).toBeGreaterThanOrEqual(1);
  });
});

function run(o: SimConfigOverrides) {
  const e = new SimEngine(o);
  e.runToCompletion();
  return e;
}

describe('0.8.0-rc1 — equal-value duplicate-peak defect (fixed)', () => {
  // the 4 single-source maps (of 2100) in which v0.7.0/v0.7.1 found TWO peaks with exactly equal smoothed values
  const CASES = [[40, 60015], [40, 60143], [75, 60207], [100, 60248]] as const;
  const src = (s: number) => ({ x: 18, z: 21.3, s });

  it('defect reproduced with the tie break off (v0.7.0 behaviour): two equal-valued peaks for ONE source', () => {
    for (const [s, seed] of CASES) {
      const { g, reach } = map([src(s)], seed);
      const peaks = findPeaks(g, reach, { ...P, equalValueTieBreak: false }, true).filter((p) => near(p, src(s), 28));
      expect(peaks.length).toBe(2);
      expect(peaks[0].value_uSv_h).toBe(peaks[1].value_uSv_h);
    }
  });

  it('fixed (default): exactly ONE peak, near the source, in the same maps', () => {
    for (const [s, seed] of CASES) {
      const { g, reach } = map([src(s)], seed);
      const peaks = findPeaks(g, reach, P, true);
      expect(peaks.length).toBe(1);
      expect(near(peaks[0], src(s), 8)).toBe(true);
    }
  });

  it('genuinely separate sources with EXACTLY equal peak values are still both detected (mirror-symmetric pair, 40 m apart, noise-free)', () => {
    // symmetric about x = 20 → mirror cells have identical true rates; the dip between them keeps them separate
    const a = { x: 0, z: 2, s: 500 };
    const b = { x: 40, z: 2, s: 500 };
    const { g, reach } = map([a, b], 1, false);
    const peaks = findPeaks(g, reach, P, true);
    expect(peaks.length).toBe(2);
    expect(peaks.some((p) => near(p, a, 8))).toBe(true);
    expect(peaks.some((p) => near(p, b, 8))).toBe(true);
  });

  it('the tie break does not change two-source resolution (20 noisy maps per case, 32/40/48 m equal, 40/48 m at 1:2)', () => {
    for (const [d, s2] of [[32, 500], [40, 500], [48, 500], [40, 250], [48, 250]] as const)
      for (let seed = 2001; seed <= 2020; seed++) {
        const { g, reach } = map([{ x: 0, z: 0, s: 500 }, { x: d, z: 0, s: s2 }], seed);
        const on = findPeaks(g, reach, P, true).length;
        const off = findPeaks(g, reach, { ...P, equalValueTieBreak: false }, true).length;
        expect(on).toBe(off);
      }
  });
});

describe('Fix C — in the mission', () => {
  it('HIGH: one hotspot (no duplicate), near the source, scanned at the lane end where it is confirmed; lanes resumed, coverage objective met', () => {
    const sc = EXPERIMENT_SCENARIOS.find((s) => s.id === 'HIGH')!;
    const e = run(scenarioConfig(sc, 101));
    const hs = e.state.survey.hotspots;
    expect(hs.length).toBe(1);
    const src = e.config.radiation.sourcePosition;
    expect(Math.hypot(hs[0].x - src.x, hs[0].z - src.z)).toBeLessThan(8);
    const det = eventsOf(e.state, 'HOTSPOT_DETECTED')[0];
    const start = eventsOf(e.state, 'ADAPTIVE_SCAN_START')[0];
    expect(start.time - det.time).toBeLessThan(1);
    const done = eventsOf(e.state, 'SURVEY_COMPLETE')[0];
    expect(start.time).toBeLessThan(done.time);
    expect(e.state.survey.coverageObjectiveMet).toBe(true);
    expect(e.state.mission.phase).toBe('COMPLETE');
  });

  it('LOW: the weak source is now detected and scanned (v0.6.0 never triggered)', () => {
    const sc = EXPERIMENT_SCENARIOS.find((s) => s.id === 'LOW')!;
    const e = run(scenarioConfig(sc, 101));
    expect(e.state.survey.hotspots.length).toBe(1);
    expect(e.state.survey.hotspots[0].scanEnd).not.toBe(null);
    const legacy = run(scenarioConfig(sc, 101, { survey: { adaptive: { detection: 'LEGACY_THRESHOLD', scanTiming: 'AFTER_AREA' } } }));
    expect(legacy.state.survey.hotspots.length).toBe(0);
  });

  it('two separate sources 36 m apart in the mission: two hotspots, one near each source', () => {
    const extra = { position: { x: -18, y: 1.3, z: 21.3 }, strength_uSv_h_at_1m: 500 };
    const e = run({ seed: 7, radiation: { additionalSources: [extra] } });
    const hs = e.state.survey.hotspots;
    expect(hs.length).toBe(2);
    const src = e.config.radiation.sourcePosition;
    expect(hs.some((h) => Math.hypot(h.x - src.x, h.z - src.z) < 8)).toBe(true);
    expect(hs.some((h) => Math.hypot(h.x - extra.position.x, h.z - extra.position.z) < 8)).toBe(true);
  });

  it('no source (background only): no hotspot, no adaptive scan', () => {
    for (const seed of [1, 2]) {
      const e = run({ seed, radiation: { sourceStrength_uSv_h_at_1m: 0 } });
      expect(e.state.survey.hotspots.length).toBe(0);
      expect(eventsOf(e.state, 'ADAPTIVE_SCAN_START').length).toBe(0);
    }
  });

  it('v0.6.0 rule reproduces the old timing (default mission: detected at ≈ 222 s, scanned after the lanes)', () => {
    const e = run({ seed: 42, survey: { adaptive: { detection: 'LEGACY_THRESHOLD', scanTiming: 'AFTER_AREA' } } });
    const det = eventsOf(e.state, 'HOTSPOT_DETECTED');
    expect(det.length).toBe(1);
    expect(Math.abs(det[0].time - 222.3)).toBeLessThan(0.5);
    expect(eventsOf(e.state, 'ADAPTIVE_SCAN_START')[0].time).toBeGreaterThanOrEqual(eventsOf(e.state, 'SURVEY_COMPLETE')[0].time - 1e-9);
  });
});
