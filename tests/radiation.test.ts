import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SeededRng, SimEngine, buildHeatmap, poisson, trueDoseRate } from '../src/sim';
import { completedRun, eventsOf } from './helpers';

const R = DEFAULT_CONFIG.radiation;

describe('BEE-01 radiation — ground-truth model', () => {
  it('follows the inverse-square law plus background', () => {
    const s = R.sourcePosition;
    const at = (d: number) => trueDoseRate(R, { x: s.x + d, y: s.y, z: s.z });
    expect(Math.abs(at(1) - (R.background_uSv_h + R.sourceStrength_uSv_h_at_1m))).toBeLessThan(1e-9);
    expect(Math.abs(at(2) - (R.background_uSv_h + R.sourceStrength_uSv_h_at_1m / 4))).toBeLessThan(1e-9);
    expect(Math.abs(at(10) - (R.background_uSv_h + R.sourceStrength_uSv_h_at_1m / 100))).toBeLessThan(1e-9);
  });

  it('clamps at the minimum distance and tends to background far away', () => {
    const s = R.sourcePosition;
    expect(trueDoseRate(R, s)).toBe(R.background_uSv_h + R.sourceStrength_uSv_h_at_1m);
    const far = trueDoseRate(R, { x: s.x + 5000, y: s.y, z: s.z });
    expect(Math.abs(far - R.background_uSv_h)).toBeLessThan(1e-4);
  });

  it('source strength is configurable and scales the field linearly', () => {
    const cfg = { ...R, sourceStrength_uSv_h_at_1m: 2000, background_uSv_h: 0 };
    const p = { x: 30, y: 10, z: 30 };
    expect(Math.abs(trueDoseRate(cfg, p) / trueDoseRate({ ...cfg, sourceStrength_uSv_h_at_1m: 1000 }, p) - 2)).toBeLessThan(1e-12);
  });
});

describe('BEE-01 radiation — simulated detector', () => {
  it('Poisson sampler has mean ≈ variance ≈ λ (small and large λ)', () => {
    for (const lambda of [3, 120]) {
      const rng = new SeededRng(11);
      const n = 20000;
      let sum = 0;
      let sq = 0;
      for (let i = 0; i < n; i++) {
        const k = poisson(rng, lambda);
        sum += k;
        sq += k * k;
      }
      const mean = sum / n;
      const variance = sq / n - mean * mean;
      expect(Math.abs(mean - lambda) / lambda).toBeLessThan(0.03);
      expect(Math.abs(variance - lambda) / lambda).toBeLessThan(0.08);
    }
  });

  const { engine, state } = completedRun();
  const samples = state.radiation.samples;

  it('records samples only from BEE-01 and only after it left the bay', () => {
    expect(samples.length).toBeGreaterThan(40);
    const release = state.bees[0].releaseTime as number;
    for (const s of samples) {
      expect(s.droneId).toBe('BEE-01');
      expect(s.time).toBeGreaterThan(release);
    }
    expect(eventsOf(state, 'RADIATION_SURVEY_START', 'BEE-01')).toHaveLength(1);
  });

  it('stores timestamps, coordinates, counts, truth and measurement for every sample', () => {
    for (const s of samples) {
      for (const v of [s.time, s.x, s.y, s.z, s.counts, s.measured_uSv_h, s.trueWindowMean_uSv_h, s.trueAtPosition_uSv_h]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(Math.abs(s.time - s.step * engine.config.dt)).toBeLessThan(1e-9);
      // Phase 3B+: a window lasts T, or closes early once the drone has flown maxSampleSpacing_m
      expect(s.liveTime_s).toBeGreaterThan(0);
      expect(s.liveTime_s).toBeLessThanOrEqual(R.integrationTime_s + 1e-9);
    }
  });

  it('measured value = counts / (sensitivity × live time) — derived only from counts', () => {
    for (const s of samples) {
      expect(Math.abs(s.measured_uSv_h - s.counts / (R.sensitivity_cps_per_uSv_h * s.liveTime_s))).toBeLessThan(1e-9);
    }
  });

  it('point truth is reproducible from the recorded position', () => {
    for (const s of samples) {
      expect(Math.abs(s.trueAtPosition_uSv_h - trueDoseRate(R, { x: s.x, y: s.y, z: s.z }))).toBeLessThan(1e-9);
    }
  });

  it('measurement is noisy but unbiased against window-mean truth', () => {
    const differs = samples.filter((s) => Math.abs(s.measured_uSv_h - s.trueWindowMean_uSv_h) > 1e-6).length;
    expect(differs).toBeGreaterThan(samples.length * 0.8);
    // pooled over many seeds the relative bias is small
    let m = 0;
    let t = 0;
    for (let seed = 1; seed <= 15; seed++) {
      const s = new SimEngine({ seed }).runToCompletion();
      for (const x of s.radiation.samples) {
        m += x.measured_uSv_h;
        t += x.trueWindowMean_uSv_h;
      }
    }
    expect(Math.abs(m / t - 1)).toBeLessThan(0.02);
  });

  it('readings rise when BEE-01 is near the source', () => {
    const near = samples.filter((s) => s.distance_m < 12);
    const far = samples.filter((s) => s.distance_m > 25);
    const avg = (a: typeof samples) => a.reduce((x, s) => x + s.trueWindowMean_uSv_h, 0) / a.length;
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    expect(avg(near)).toBeGreaterThan(5 * avg(far));
  });

  it('heat-map cells are the mean of the measured samples inside them', () => {
    const grid = buildHeatmap(samples, R.heatmap);
    expect(grid.filled).toBeGreaterThan(5);
    let checked = 0;
    for (let iz = 0; iz < grid.nz; iz++) {
      for (let ix = 0; ix < grid.nx; ix++) {
        const inCell = samples.filter(
          (s) => Math.floor((s.x - grid.x0) / grid.cell) === ix && Math.floor((s.z - grid.z0) / grid.cell) === iz,
        );
        const v = grid.values[iz * grid.nx + ix];
        if (!inCell.length) {
          expect(Number.isNaN(v)).toBe(true);
          continue;
        }
        const mean = inCell.reduce((a, s) => a + s.measured_uSv_h, 0) / inCell.length;
        expect(Math.abs(v - mean)).toBeLessThan(1e-9);
        checked++;
      }
    }
    expect(checked).toBe(grid.filled);
  });
});
