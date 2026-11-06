import { describe, expect, it } from 'vitest';
import {
  COMMS_COLUMNS,
  RADIATION_MEASUREMENT_COLUMNS,
  RADIATION_TRUTH_COLUMNS,
  SimEngine,
  TEMPERATURE_MEASUREMENT_COLUMNS,
  TEMPERATURE_TRUTH_COLUMNS,
  VITALS_MEASUREMENT_COLUMNS,
  VITALS_TRUTH_COLUMNS,
  commsToCsv,
  datasetFiles,
  datasetJson,
  datasetZip,
  parseCsv,
  positionsToCsv,
  radiationMeasurementsToCsv,
  radiationTruthToCsv,
  readZip,
  runMetadata,
  temperatureMeasurementsToCsv,
  temperatureTruthToCsv,
  vitalsMeasurementsToCsv,
  vitalsTruthToCsv,
} from '../src/sim';
import { completedRun } from './helpers';

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe('Phase 2 scientific exports', () => {
  const { engine, state } = completedRun();

  const cases: [string, () => string, readonly string[], number, string][] = [
    ['radiation measurements', () => radiationMeasurementsToCsv(engine), RADIATION_MEASUREMENT_COLUMNS, state.radiation.samples.length, 'SIMULATED'],
    ['radiation truth', () => radiationTruthToCsv(engine), RADIATION_TRUTH_COLUMNS, state.radiation.samples.length, 'SIMULATED_GROUND_TRUTH'],
    ['vitals measurements', () => vitalsMeasurementsToCsv(engine), VITALS_MEASUREMENT_COLUMNS, state.casualty.measurements.length, 'SIMULATED'],
    ['vitals truth', () => vitalsTruthToCsv(engine), VITALS_TRUTH_COLUMNS, state.casualty.truthTimeline.length, 'SIMULATED_GROUND_TRUTH'],
    ['comms log', () => commsToCsv(engine), COMMS_COLUMNS, state.comms.messages.length, 'SIMULATED'],
    ['temperature measurements', () => temperatureMeasurementsToCsv(engine), TEMPERATURE_MEASUREMENT_COLUMNS, state.casualty.temperatureMeasurements.length, 'SIMULATED'],
    ['temperature truth', () => temperatureTruthToCsv(engine), TEMPERATURE_TRUTH_COLUMNS, state.casualty.temperatureTruth.length, 'SIMULATED_GROUND_TRUTH'],
  ];

  for (const [name, fn, cols, n, source] of cases) {
    it(`${name}: header, row count, ids and data_source`, () => {
      const rows = parseCsv(fn());
      expect(rows[0]).toEqual([...cols]);
      expect(rows.length - 1).toBe(n);
      const si = cols.indexOf('scenario_id');
      const ri = cols.indexOf('run_id');
      const di = cols.indexOf('seed');
      const ds = cols.indexOf('data_source');
      for (const r of rows.slice(1)) {
        expect(r.length).toBe(cols.length);
        expect(r[si]).toBe(engine.world.scenarioId);
        expect(r[ri]).toBe(engine.runId);
        expect(r[di]).toBe(String(engine.config.seed));
        expect(r[ds]).toBe(source);
      }
    });
  }

  it('measurement files contain no ground-truth columns', () => {
    for (const cols of [RADIATION_MEASUREMENT_COLUMNS, VITALS_MEASUREMENT_COLUMNS, COMMS_COLUMNS, TEMPERATURE_MEASUREMENT_COLUMNS]) {
      for (const c of cols) expect(c.includes('true')).toBe(false);
    }
  });

  it('radiation measurement and truth files join 1:1 on sample_id', () => {
    const m = parseCsv(radiationMeasurementsToCsv(engine)).slice(1);
    const t = parseCsv(radiationTruthToCsv(engine)).slice(1);
    const mi = RADIATION_MEASUREMENT_COLUMNS.indexOf('sample_id');
    const ti = RADIATION_TRUTH_COLUMNS.indexOf('sample_id');
    expect(m.map((r) => r[mi])).toEqual(t.map((r) => r[ti]));
  });

  it('every vitals measurement has a truth row with the same step', () => {
    const steps = new Set(parseCsv(vitalsTruthToCsv(engine)).slice(1).map((r) => r[VITALS_TRUTH_COLUMNS.indexOf('step')]));
    for (const r of parseCsv(vitalsMeasurementsToCsv(engine)).slice(1)) {
      expect(steps.has(r[VITALS_MEASUREMENT_COLUMNS.indexOf('step')])).toBe(true);
    }
  });

  it('positions CSV now carries scenario_id', () => {
    const rows = parseCsv(positionsToCsv(engine));
    expect(rows[0][0]).toBe('scenario_id');
    expect(rows[1][0]).toBe(engine.world.scenarioId);
  });

  it('run JSON includes ids, config and a summary computed from the data', () => {
    const meta = JSON.parse(JSON.stringify(runMetadata(engine)));
    expect(meta.scenario_id).toBe(engine.world.scenarioId);
    expect(meta.run_id).toBe(engine.runId);
    expect(meta.seed).toBe(engine.config.seed);
    expect(meta.summary.radiation.samples).toBe(state.radiation.samples.length);
    expect(meta.summary.comms.sent).toBe(state.comms.messages.length);
    expect(meta.summary.casualty.detection_time_s).toBe(Number((state.casualty.detectionTime as number).toFixed(3)));
    expect(meta.config.radiation.sourceStrength_uSv_h_at_1m).toBe(engine.config.radiation.sourceStrength_uSv_h_at_1m);
  });

  it('full JSON keeps measurements and ground truth in separate branches', () => {
    const j = JSON.parse(JSON.stringify(datasetJson(engine)));
    expect(j.measurements.radiation).toHaveLength(state.radiation.samples.length);
    expect(j.ground_truth.radiation).toHaveLength(state.radiation.samples.length);
    expect('true_dose_rate_window_mean_uSv_h' in j.measurements.radiation[0]).toBe(false);
    expect('measured_dose_rate_uSv_h' in j.ground_truth.radiation[0]).toBe(false);
    expect(j.measurements.comms).toHaveLength(state.comms.messages.length);
  });

  it('dataset ZIP round-trips with CRC check and contains every file', () => {
    const files = datasetFiles(engine);
    const back = readZip(datasetZip(engine));
    expect(Object.keys(back).sort()).toEqual(Object.keys(files).sort());
    for (const k of Object.keys(files)) expect(back[k]).toBe(files[k]);
    const names = Object.keys(files).join('\n');
    expect(names.includes('ground_truth/radiation_truth.csv')).toBe(true);
    expect(names.includes('ground_truth/vitals_truth.csv')).toBe(true);
    expect(names.includes('measurements/temperature_measurements.csv')).toBe(true);
    expect(names.includes('ground_truth/temperature_truth.csv')).toBe(true);
    expect(names.includes('measurements/comms_log.csv')).toBe(true);
  });

  it('the complete dataset is byte-identical after reset and across engines (same seed)', () => {
    const a = new SimEngine({ seed: 9 });
    a.runToCompletion();
    const zipA = datasetZip(a);
    a.reset();
    a.runToCompletion();
    const zipA2 = datasetZip(a);
    const b = new SimEngine({ seed: 9 });
    b.runToCompletion();
    expect(sameBytes(zipA2, zipA)).toBe(true);
    expect(sameBytes(datasetZip(b), zipA)).toBe(true);
  });

  it('sensor and link settings never change the mother, BEE-02 or BEE-03 trajectory (independent RNG streams)', () => {
    // BEE-01 is excluded on purpose since Phase 3A: its adaptive scans react to radiation
    // readings and its corridor task depends on when the GS receives the casualty data.
    const base = new SimEngine({ seed: 3 });
    const other = new SimEngine({
      seed: 3,
      radiation: { sourceStrength_uSv_h_at_1m: 5000 },
      comms: { packetLossBase: 0.5 },
    });
    base.runToCompletion();
    other.runToCompletion();
    // compare samples taken at the same step (the runs end at different times). Phase 3B: the
    // recovery starts when the objectives are complete, which depends on data → compare until then.
    const key = (s: { step: number; entityId: string }) => `${s.step}|${s.entityId}`;
    const ref = new Map(base.state.samples.map((s) => [key(s), s]));
    const until = Math.min(base.state.mission.objectivesCompleteAt as number, other.state.mission.objectivesCompleteAt as number);
    let compared = 0;
    for (const s of other.state.samples) {
      const b = ref.get(key(s));
      if (!b || s.entityId === 'BEE-01' || s.time >= until) continue;
      expect(s.x).toBe(b.x);
      expect(s.z).toBe(b.z);
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
  });
});

describe('run id', () => {
  it('is scenario + seed for the default config, and gains a config hash otherwise', () => {
    expect(new SimEngine({ seed: 5 }).runId).toBe('P1-BASE-seed5');
    const a = new SimEngine({ seed: 5, radiation: { sourceStrength_uSv_h_at_1m: 900 } }).runId;
    const b = new SimEngine({ seed: 5, radiation: { sourceStrength_uSv_h_at_1m: 900 } }).runId;
    const c = new SimEngine({ seed: 5, comms: { packetLossBase: 0.3 } }).runId;
    expect(a.startsWith('P1-BASE-seed5-cfg')).toBe(true);
    expect(a).toBe(b);
    expect(a === c).toBe(false);
  });
});
