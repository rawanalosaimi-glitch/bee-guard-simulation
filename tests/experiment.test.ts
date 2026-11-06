import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  EXPERIMENT_SCENARIOS,
  EXPERIMENT_SEEDS,
  RUN_SUMMARY_COLUMNS,
  SimEngine,
  buildGrid,
  classifyRisk,
  mapQuality,
  parseCsv,
  rowsToCsv,
  runOne,
  scenarioConfig,
  scenarioSummary,
  spearman,
  trueDoseRate,
} from '../src/sim';
import type { RunSummaryRow } from '../src/sim';

const cfg = new SimEngine().config;
const spec = cfg.radiation.heatmap;

/** A grid whose every cell holds exactly the true field at its centre and altitude h. */
function truthGrid(h: number, f: (x: number, z: number, t: number) => number = (_x, _z, t) => t) {
  const pts = [];
  for (let iz = 0; iz < spec.nz; iz++)
    for (let ix = 0; ix < spec.nx; ix++) {
      const x = spec.x0 + (ix + 0.5) * spec.cell;
      const z = spec.z0 + (iz + 0.5) * spec.cell;
      pts.push({ x, y: h, z, value: f(x, z, trueDoseRate(cfg.radiation, { x, y: h, z })), time: 0, counts: 1, live: 1 });
    }
  return buildGrid(pts, spec);
}

describe('Stage 2 — map-level quality metrics (evaluation only)', () => {
  it('a perfect map has zero error, ρ = 1, and the hotspot within one cell of the source', () => {
    const q = mapQuality(truthGrid(15), cfg);
    expect(q.cells_measured).toBe(spec.nx * spec.nz);
    expect(q.mae_uSv_h).toBe(0);
    expect(q.rmse_uSv_h).toBe(0);
    expect(q.spearman_rho).toBe(1);
    expect(q.peak_rel_bias).toBe(0);
    expect(q.hotspot_localisation_error_m!).toBeLessThanOrEqual((spec.cell * Math.SQRT2) / 2 + 1e-9);
    expect(q.alert_false_positive + q.alert_false_negative).toBe(0);
  });

  it('a constant offset shows up as bias = MAE = RMSE; doubling shows as +100 % peak bias', () => {
    const q = mapQuality(truthGrid(15, (_x, _z, t) => t + 0.05), cfg);
    expect(Math.abs(q.bias_uSv_h! - 0.05)).toBeLessThan(1e-9);
    expect(Math.abs(q.mae_uSv_h! - 0.05)).toBeLessThan(1e-9);
    expect(Math.abs(q.rmse_uSv_h! - 0.05)).toBeLessThan(1e-9);
    expect(Math.abs(mapQuality(truthGrid(15, (_x, _z, t) => 2 * t), cfg).peak_rel_bias! - 1)).toBeLessThan(1e-4);
  });

  it('Spearman handles ties and anti-correlation; an empty grid gives nulls, not zeros', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    expect(Math.abs(spearman([1, 1, 2, 2], [1, 1, 2, 2])! - 1)).toBeLessThan(1e-12);
    expect(spearman([1, 2], [1, 2])).toBe(null);
    const q = mapQuality(buildGrid([], spec), cfg);
    expect(q.cells_measured).toBe(0);
    expect(q.rmse_uSv_h).toBe(null);
    expect(q.hotspot_localisation_error_m).toBe(null);
  });
});

describe('Stage 3 — controlled scenarios', () => {
  it('three scenarios with explicit overrides; only source strength and casualty physiology differ from the defaults', () => {
    expect(EXPERIMENT_SCENARIOS.map((s) => s.id)).toEqual(['LOW', 'MEDIUM', 'HIGH']);
    expect([...EXPERIMENT_SEEDS]).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    for (const s of EXPERIMENT_SCENARIOS) {
      expect(Object.keys(s.overrides).sort()).toEqual(['casualty', 'radiation']);
      expect(Object.keys(s.overrides.radiation!)).toEqual(['sourceStrength_uSv_h_at_1m']);
      expect(Object.keys(s.overrides.casualty!).sort()).toEqual(['hr', 'rr']);
      const e = new SimEngine(scenarioConfig(s, 7));
      expect(e.config.seed).toBe(7);
      expect(e.config.radiation.sourcePosition).toEqual(DEFAULT_CONFIG.radiation.sourcePosition);
      expect(e.config.comms).toEqual(DEFAULT_CONFIG.comms);
      expect(e.config.casualty.temperature).toEqual(DEFAULT_CONFIG.casualty.temperature);
      // design target: the base physiology falls in the intended illustrative class
      expect(classifyRisk(e.config.casualty.hr.base, e.config.casualty.rr.base).risk).toBe(s.intendedCasualtyRisk);
    }
    const sources = EXPERIMENT_SCENARIOS.map((s) => s.overrides.radiation!.sourceStrength_uSv_h_at_1m!);
    expect(sources).toEqual([50, 500, 5000]);
  });

  it('runOne is reproducible and keeps a full row; the dataset excludes the large JSON unless asked', () => {
    const sc = EXPERIMENT_SCENARIOS[0];
    const a = runOne(sc, 101);
    const b = runOne(sc, 101);
    expect(a.status).toBe('OK');
    expect(a.row).toEqual(b.row);
    expect(Object.keys(a.files).sort()).toEqual(Object.keys(b.files).sort());
    for (const k of Object.keys(a.files)) expect(a.files[k]).toBe(b.files[k]);
    expect(Object.keys(a.row).sort()).toEqual([...RUN_SUMMARY_COLUMNS].sort());
    expect('dataset_full.json' in a.files).toBe(false);
    for (const k of ['measurements/positions.csv', 'measurements/radiation_measurements.csv', 'measurements/temperature_measurements.csv', 'measurements/comms_log.csv', 'ground_truth/radiation_truth.csv', 'mission_control/patient_records.csv', 'run_metadata.json'])
      expect(k in a.files).toBe(true);
    expect(a.row.final_phase).toBe('COMPLETE');
    expect(a.row.truth_risk_latest).toBe('LOW');
    expect(typeof a.row.map_gs_rmse_uSv_h).toBe('number');
    const c = runOne(sc, 102);
    expect(c.row.map_gs_rmse_uSv_h).not.toBe(a.row.map_gs_rmse_uSv_h); // seeds matter — values are computed, not fixed
  });

  it('never drops a run: a mission cut short and an engine exception both produce rows', () => {
    const sc = EXPERIMENT_SCENARIOS[1];
    const short = runOne(sc, 101, { maxSteps: 400 });
    expect(short.status).toBe('OK');
    expect(short.row.final_phase).not.toBe('COMPLETE');
    const boom = runOne(sc, 101, {
      engineFactory: () => {
        throw new Error('injected failure');
      },
    });
    expect(boom.status).toBe('ERROR');
    expect(boom.row.run_status).toBe('ERROR');
    expect(boom.row.error).toBe('Error: injected failure');
    expect(boom.row.scenario).toBe('MEDIUM');
    expect(boom.row.seed).toBe(101);
    const rows = [short.row, boom.row] as RunSummaryRow[];
    const csv = parseCsv(rowsToCsv(RUN_SUMMARY_COLUMNS, rows));
    expect(csv.length).toBe(3);
    const sum = scenarioSummary(rows);
    const n = sum.find((r) => r.metric === 'mission_duration_s')!;
    expect(n.n_runs).toBe(2);
    expect(n.n_values).toBe(1); // the failed run has no value — reported, not imputed
    expect(sum.some((r) => r.metric === 'count:run_status=ERROR' && r.n_values === 1)).toBe(true);
  });

  it('scenario summary statistics are computed correctly (sample SD, t-based 95 % CI)', () => {
    const rows = [1, 2, 3, 4].map((v) => ({ scenario: 'X', seed: v, mission_duration_s: v }) as unknown as RunSummaryRow);
    const r = scenarioSummary(rows).find((x) => x.metric === 'mission_duration_s')!;
    expect(r.mean).toBe(2.5);
    expect(r.median).toBe(2.5);
    expect(Math.abs((r.sd as number) - Math.sqrt(5 / 3))).toBeLessThan(1e-5);
    expect(Math.abs((r.ci95_half_width as number) - (3.182 * Math.sqrt(5 / 3)) / 2)).toBeLessThan(1e-4);
  });
});
