import { describe, expect, it } from 'vitest';
import { SimEngine, TEMPERATURE_SITE, classifyRisk, datasetFiles, datasetJson, missionControlSnapshot, parseCsv, patientViews, temperatureMeasurementsToCsv, vitalsMeasurementsToCsv, vitalsTruthToCsv, radiationMeasurementsToCsv } from '../src/sim';
import { completedRun } from './helpers';

/** §40 — BEE-02 body temperature: separate non-contact IR SKIN-temperature sensor. */
describe('§40 body temperature — sensor model', () => {
  const { engine, state } = completedRun();
  const c = state.casualty;
  const tc = engine.config.casualty.temperature;
  const truth = new Map(c.temperatureTruth.map((t) => [t.step, t]));

  it('produces readings with their own id, timestamp, σ, and validity limits', () => {
    expect(c.temperatureMeasurements.length).toBeGreaterThan(50);
    c.temperatureMeasurements.forEach((m, i) => {
      expect(m.id).toBe(i + 1);
      expect(m.droneId).toBe('BEE-02');
      expect(m.distance_m).toBeLessThanOrEqual(tc.range_m + 1e-9);
      expect(m.beeSpeed_mps).toBeLessThanOrEqual(tc.maxBeeSpeed_mps + 1e-9);
      expect(Math.abs(m.sigma_c - (tc.sigmaBase_c + tc.sigmaPerM_c * m.distance_m + tc.motionSigmaPerMps_c * m.beeSpeed_mps))).toBeLessThan(1e-12);
      expect(m.sigma_c).toBeLessThanOrEqual(tc.maxSigma_c);
      expect(truth.has(m._truthStep)).toBe(true);
      if (i > 0) expect(m.time).toBeGreaterThan(c.temperatureMeasurements[i - 1].time);
    });
  });

  it('measurement error is unbiased and consistent with the stated σ (skin temperature is the measurand)', () => {
    const z = c.temperatureMeasurements.map((m) => (m.skin_measured_c - truth.get(m._truthStep)!.skin_true_c) / m.sigma_c);
    const mean = z.reduce((a, b) => a + b, 0) / z.length;
    const sd = Math.sqrt(z.reduce((a, b) => a + (b - mean) ** 2, 0) / (z.length - 1));
    expect(Math.abs(mean)).toBeLessThan(4 / Math.sqrt(z.length));
    expect(sd).toBeGreaterThan(0.8);
    expect(sd).toBeLessThan(1.2);
    // plausible exposed-skin range, and clearly below the (reference-only) core temperature
    for (const t of c.temperatureTruth) {
      expect(t.skin_true_c).toBeGreaterThan(30);
      expect(t.skin_true_c).toBeLessThan(37);
      expect(t.core_true_c).toBeGreaterThan(t.skin_true_c);
    }
  });

  it('is independent of heart rate and respiratory rate (own truth model and RNG streams)', () => {
    const other = completedRun({ casualty: { hr: { base: 70, slope_per_s: 0 }, rr: { base: 14 } } }).state.casualty;
    expect(other.estimate!.risk).not.toBe(c.estimate!.risk); // the HR/RR change matters to the risk rule…
    expect(other.temperatureTruth).toEqual(c.temperatureTruth); // …but not to temperature
    expect(other.temperatureMeasurements.map((m) => [m.step, m.skin_measured_c])).toEqual(c.temperatureMeasurements.map((m) => [m.step, m.skin_measured_c]));
  });

  it('adding the sensor changes no HR/RR, radiation or risk output; temperature settings do not either', () => {
    const off = completedRun({ casualty: { temperature: { enabled: false } } }).engine;
    const warm = completedRun({ casualty: { temperature: { skinBase_c: 35.5, sigmaBase_c: 0.6 } } }).engine;
    for (const e of [off, warm]) {
      expect(vitalsMeasurementsToCsv(e).replaceAll(e.runId, 'R')).toBe(vitalsMeasurementsToCsv(engine).replaceAll(engine.runId, 'R'));
      expect(vitalsTruthToCsv(e).replaceAll(e.runId, 'R')).toBe(vitalsTruthToCsv(engine).replaceAll(engine.runId, 'R'));
      expect(radiationMeasurementsToCsv(e).replaceAll(e.runId, 'R')).toBe(radiationMeasurementsToCsv(engine).replaceAll(engine.runId, 'R'));
      expect(e.state.comms.gs.patients[0].assessment).toEqual(state.comms.gs.patients[0].assessment);
    }
    // the illustrative risk rule takes HR and RR only
    expect(classifyRisk.length).toBe(2);
  });
});

describe('§40 body temperature — ground-station record and dashboard status', () => {
  it('the GS holds only received readings, labelled as SKIN (IR) temperature, never as core', () => {
    const { engine, state } = completedRun();
    const p = state.comms.gs.patients[0];
    const byId = new Map(state.casualty.temperatureMeasurements.map((m) => [m.id, m]));
    expect(p.temperatureHistory.length).toBeGreaterThan(0);
    expect(p.temperatureHistory.length).toBeLessThanOrEqual(byId.size);
    for (const h of p.temperatureHistory) {
      const m = byId.get(h.sampleId)!;
      expect(Math.abs(h.skin_c - m.skin_measured_c)).toBeLessThan(1e-4);
      expect(Math.abs(h.t - m.time)).toBeLessThan(1e-9);
    }
    const v = patientViews(state, engine.config)[0];
    expect(v.temperature.site).toBe(TEMPERATURE_SITE);
    expect(/SKIN/.test(TEMPERATURE_SITE)).toBe(true);
    expect(/not core/.test(TEMPERATURE_SITE)).toBe(true);
    expect(v.temperature.skin_c).toBe(p.latestTemperature!.skin_c);
    expect(p.latestTemperature!.modality).toBe('IR_SKIN');
  });

  it('LIVE while on station, then LAST RECORDED (same value) through RECOVERY, RETURN, LANDING and COMPLETE', () => {
    const e = new SimEngine();
    e.start();
    e.runUntil((s) => s.survey.surveyCompleteTime !== null);
    const live = patientViews(e.state, e.config)[0].temperature;
    expect(live.status).toBe('LIVE');
    expect(live.skin_c).not.toBe(null);
    let last: number | null = null;
    for (const ph of ['RECOVERY', 'RETURN', 'LANDING', 'COMPLETE'] as const) {
      e.runUntil((s) => s.mission.phase === ph);
      e.step();
      const t = patientViews(e.state, e.config)[0].temperature;
      expect(t.status).toBe('LAST_RECORDED');
      expect(t.skin_c).not.toBe(null);
      expect(t.sampleTime).not.toBe(null);
      // the last RECEIVED reading is kept (late packets from the recall leg may still update it during RECOVERY)
      expect(t.skin_c).toBe(e.state.comms.gs.patients[0].latestTemperature!.skin_c);
      if (ph !== 'RECOVERY' && ph !== 'RETURN') expect(t.skin_c).toBe(last); // after the recall leg: unchanged, never reset or extrapolated
      last = t.skin_c;
    }
    expect(e.state.status).toBe('COMPLETE');
  });

  it('shows UNAVAILABLE with no value when no defensible reading exists (sensor off, out of range, σ too large)', () => {
    for (const temperature of [{ enabled: false }, { range_m: 3 }, { maxSigma_c: 0.2 }]) {
      const { engine, state } = completedRun({ casualty: { temperature } });
      const v = patientViews(state, engine.config)[0];
      expect(v.record.latestVitals).not.toBe(null); // HR/RR still there
      expect(v.temperature.status).toBe('UNAVAILABLE');
      expect(v.temperature.skin_c).toBe(null);
      expect(v.temperature.sampleTime).toBe(null);
      expect((temperature.enabled === false ? /disabled/ : /no valid/).test(v.temperature.reason ?? '')).toBe(true);
    }
    const r = completedRun({ casualty: { temperature: { maxSigma_c: 0.2 } } }).state.casualty;
    expect(r.temperatureMeasurements).toHaveLength(0);
    expect(r.temperatureRejected).toBeGreaterThan(0);
  });
});

describe('§40 body temperature — exports', () => {
  const { engine, state } = completedRun();
  const files = datasetFiles(engine);
  const get = (suffix: string) => Object.entries(files).find(([k]) => k.endsWith(suffix))![1] as string;

  it('patient_records.csv carries value, unit, timestamp, status and measured quantity', () => {
    const rows = parseCsv(get('mission_control/patient_records.csv'));
    const col = (c: string) => rows[1][rows[0].indexOf(c)];
    const t = patientViews(state, engine.config)[0].temperature;
    expect(col('temp_status')).toBe('LAST_RECORDED');
    expect(col('temp_measured_quantity')).toBe('SKIN_IR');
    expect(col('temp_unit')).toBe('degC');
    expect(Math.abs(Number(col('last_temp_c')) - t.skin_c!)).toBeLessThan(0.006);
    expect(Math.abs(Number(col('last_temp_sample_time_s')) - t.sampleTime!)).toBeLessThan(1e-3);
    expect(Number(col('received_temp_samples'))).toBe(state.comms.gs.patients[0].temperatureHistory.length);
    const off = completedRun({ casualty: { temperature: { enabled: false } } }).engine;
    const ro = parseCsv(Object.entries(datasetFiles(off)).find(([k]) => k.endsWith('patient_records.csv'))![1] as string);
    expect(ro[1][ro[0].indexOf('temp_status')]).toBe('UNAVAILABLE');
    expect(ro[1][ro[0].indexOf('last_temp_c')]).toBe('');
  });

  it('measurement and truth files join on step; the measurement file has no core-temperature column', () => {
    const m = parseCsv(temperatureMeasurementsToCsv(engine));
    expect(m[0].some((c) => c.includes('core'))).toBe(false);
    expect(m.slice(1).every((r) => r[m[0].indexOf('measured_quantity')] === 'SKIN_IR' && r[m[0].indexOf('unit')] === 'degC')).toBe(true);
    const tr = parseCsv(get('ground_truth/temperature_truth.csv'));
    const steps = new Set(tr.slice(1).map((r) => r[tr[0].indexOf('step')]));
    for (const r of m.slice(1)) expect(steps.has(r[m[0].indexOf('step')])).toBe(true);
    const j = JSON.parse(JSON.stringify(datasetJson(engine)));
    expect(j.measurements.temperature).toHaveLength(state.casualty.temperatureMeasurements.length);
    expect('skin_temp_true_c' in j.measurements.temperature[0]).toBe(false);
    const snap = missionControlSnapshot(engine) as { patients: { body_temperature: { status: string; unit: string; measured_quantity: string } }[] };
    expect(snap.patients[0].body_temperature.status).toBe('LAST_RECORDED');
    expect(snap.patients[0].body_temperature.unit).toBe('°C');
    expect(/not core/.test(snap.patients[0].body_temperature.measured_quantity)).toBe(true);
  });
});
