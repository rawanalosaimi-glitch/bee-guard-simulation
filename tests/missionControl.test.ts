import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  SimEngine,
  cumulativeDose,
  datasetFiles,
  gsDoseSeries,
  missionAlerts,
  missionControlSnapshot,
  missionMilestones,
  onboardDoseSeries,
  parseCsv,
  patientViews,
  swarmStatus,
  GS_RADIATION_COLUMNS,
  EVAC_PLAN_COLUMNS,
  WORLD,
} from '../src/sim';
import { completedRun } from './helpers';

const R = DEFAULT_CONFIG.radiation;

describe('ground-station data (what the dashboard may use)', () => {
  const { state } = completedRun();

  it('GS radiation samples are exactly the delivered RAD_SAMPLE messages', () => {
    const delivered = state.comms.messages.filter((m) => m.type === 'RAD_SAMPLE' && m.status === 'DELIVERED');
    expect(state.comms.gs.radiationSamples).toHaveLength(delivered.length);
    const onboard = new Map(state.radiation.samples.map((s) => [s.id, s]));
    for (const g of state.comms.gs.radiationSamples) {
      const o = onboard.get(g.sampleId)!;
      expect(g.measured_uSv_h).toBe(o.measured_uSv_h);
      expect(g.x).toBe(o.x);
      expect(g.rxTime).toBeGreaterThan(g.sampleTime);
    }
    expect(state.comms.gs.radiationSamples.length).toBeLessThan(state.radiation.samples.length);
  });

  it('one patient record (single casualty), built from delivered casualty packets only', () => {
    expect(state.comms.gs.patients).toHaveLength(1);
    const p = state.comms.gs.patients[0];
    expect(p.patientId).toBe(WORLD.casualty.id);
    expect(p.assessment === null).toBe(false);
    // the GS assessment is exactly the newest assessment packet that was DELIVERED
    const st = state.comms.messages.filter((m) => m.type === 'CASUALTY_STATUS' && m.status === 'DELIVERED' && typeof m.data.assessedAt === 'number');
    const newest = st.reduce((a, m) => ((m.data.sampleTime as number) >= (a.data.sampleTime as number) ? m : a));
    expect(p.assessment!.hr).toBe(newest.data.hr as number);
    // the GS record never contains true values
    expect(JSON.stringify(p).includes('true')).toBe(false);
  });

  it('patient data becomes UNAVAILABLE when stale while BEE-02 is still on task', () => {
    const e = new SimEngine({ alerts: { patientStale_s: 0.001 } });
    e.start();
    e.runUntil((s) => s.survey.surveyCompleteTime !== null);
    e.state.time += 1; // inspect as if time had moved on with no new packets
    const v = patientViews(e.state, e.config)[0];
    expect(v.dataState).toBe('UNAVAILABLE');
    // the record itself is kept (the UI shows it as LAST RECORDED)
    expect(v.record.assessment === null).toBe(false);
    // while BEE-02 is still monitoring (objectives complete, before recovery) the record is fresh
    const live = new SimEngine();
    live.start();
    live.runUntil((s) => s.survey.surveyCompleteTime !== null);
    expect(patientViews(live.state, DEFAULT_CONFIG)[0].dataState).toBe('ASSESSED');
    // Phase 3B+: after BEE-02 is recalled the live feed has ended by design → RECORDED (not blanked)
    const end = patientViews(state, DEFAULT_CONFIG)[0];
    expect(end.dataState).toBe('RECORDED');
    expect(end.feedEndedReason === null).toBe(false);
    expect(end.unavailableReason).toBe(null);
  });
});

describe('cumulative dose estimate', () => {
  const { state } = completedRun();

  it('onboard log: Σ rate × window / 3600 with Poisson σ, and COMPLETE basis', () => {
    const d = cumulativeDose(onboardDoseSeries(state), R);
    const manual = state.radiation.samples.reduce((a, s) => a + (s.measured_uSv_h * s.liveTime_s) / 3600, 0);
    const N = state.radiation.samples.reduce((a, s) => a + s.counts, 0);
    expect(Math.abs(d.dose_uSv - manual)).toBeLessThan(1e-12);
    expect(Math.abs(d.sigma_uSv - Math.sqrt(N) / (R.sensitivity_cps_per_uSv_h * 3600))).toBeLessThan(1e-12);
    expect(d.basis).toBe('COMPLETE');
    expect(d.missingWindows).toBe(0);
  });

  it('GS-received: lost windows are counted as missing, not filled in', () => {
    const d = cumulativeDose(gsDoseSeries(state.comms.gs.radiationSamples), R);
    const on = cumulativeDose(onboardDoseSeries(state), R);
    expect(d.basis).toBe('PARTIAL');
    expect(d.missingWindows).toBeGreaterThan(0);
    expect(d.dose_uSv).toBeLessThan(on.dose_uSv);
    // Phase 3B+: windows can close early (spatial sampling) → covered time = Σ live times received
    const live = state.comms.gs.radiationSamples.reduce((a, r) => a + r.liveTime_s, 0);
    expect(Math.abs(d.coveredTime_s - live)).toBeLessThan(1e-6);
  });

  it('no data → NO_DATA, zero dose', () => {
    expect(cumulativeDose([], R).basis).toBe('NO_DATA');
  });

  it('cumulative curve is non-decreasing and ends at the total', () => {
    const d = cumulativeDose(onboardDoseSeries(state), R);
    for (let i = 1; i < d.curve.length; i++) expect(d.curve[i].dose_uSv).toBeGreaterThanOrEqual(d.curve[i - 1].dose_uSv);
    expect(d.curve[d.curve.length - 1].dose_uSv).toBe(d.dose_uSv);
  });
});

describe('swarm status, milestones and alerts', () => {
  const { engine, state } = completedRun();

  it('one status per bee, consistent with the comms log', () => {
    const st = swarmStatus(state, engine.config, engine.world);
    expect(st.map((x) => x.id)).toEqual(['BEE-01', 'BEE-02', 'BEE-03']);
    for (const s of st) {
      const msgs = state.comms.messages.filter((m) => m.src === s.id);
      expect(s.sent).toBe(msgs.length);
      expect(s.delivered).toBe(msgs.filter((m) => m.status === 'DELIVERED').length);
      expect(s.signalQualityEst as number).toBeGreaterThanOrEqual(0);
      expect(s.signalQualityEst as number).toBeLessThanOrEqual(1);
    }
  });

  it('a docked bee is DOCKED; with total loss airborne bees are OFFLINE', () => {
    const e = new SimEngine();
    expect(swarmStatus(e.state, e.config, e.world).every((x) => x.state === 'DOCKED')).toBe(true);
    const bad = new SimEngine({ comms: { packetLossBase: 1, packetLossEdge: 1 } });
    bad.start();
    bad.runUntil((s) => s.mission.objectivesCompleteAt !== null); // all three airborne, before recovery
    expect(swarmStatus(bad.state, bad.config, bad.world).every((x) => x.state === 'OFFLINE')).toBe(true);
    expect(missionAlerts(bad.state, bad.config).some((a) => a.code === 'LINK_LOST' && a.severity === 'critical')).toBe(true);
  });

  it('milestones reflect events; evacuated is not done without operator confirmation', () => {
    const m = missionMilestones(state);
    const by = Object.fromEntries(m.map((x) => [x.key, x]));
    expect(by.arrive.done && by.deploy.done && by.detected.done && by.assessed.done && by.route.done).toBe(true);
    expect(by.rescue.done).toBe(false);
    expect(by.evacuated.done).toBe(false);
  });

  it('a HIGH-risk assessment raises a critical alert', () => {
    const risk = state.comms.gs.patients[0].assessment!.risk;
    const has = missionAlerts(state, engine.config).some((a) => a.code === 'PATIENT_RISK_HIGH');
    expect(has).toBe(risk === 'HIGH');
  });
});

describe('Mission Control exports', () => {
  const { engine, state } = completedRun();
  const snap = JSON.parse(JSON.stringify(missionControlSnapshot(engine)));

  it('snapshot has ids, units, drones, patients, evacuation and SIMULATED marking', () => {
    expect(snap.scenario_id).toBe(engine.world.scenarioId);
    expect(snap.run_id).toBe(engine.runId);
    expect(snap.seed).toBe(engine.config.seed);
    expect(snap.data_source).toBe('SIMULATED');
    expect(snap.units.dose_rate).toBe('µSv/h');
    expect(snap.units.cumulative_dose).toBe('µSv');
    expect(snap.drones.map((d: { drone_id: string }) => d.drone_id)).toEqual(['BEE-01', 'BEE-02', 'BEE-03']);
    expect(snap.patients).toHaveLength(1);
    expect(snap.patients[0].patient_id).toBe('CAS-1');
    expect(snap.evacuation.planning_only).toBe(true);
    expect(snap.evacuation.cases[0].stage).toBe('ROUTE_PLANNED');
    expect(snap.radiation.grid.interpolation.startsWith('none')).toBe(true);
    expect(snap.radiation.grid.measured_cells + snap.radiation.grid.unsampled_cells).toBe(snap.radiation.grid.nx * snap.radiation.grid.nz);
  });

  it('snapshot contains no ground truth', () => {
    const text = JSON.stringify({ ...snap, disclaimer: '' });
    for (const k of ['hr_true', 'rr_true', 'trueWindowMean', 'true_dose', 'hrTrue', 'truth']) expect(text.includes(k)).toBe(false);
  });

  it('new CSVs: headers, row counts, data_source; existing files unchanged in name', () => {
    const files = datasetFiles(engine);
    const base = engine.runId;
    const gs = parseCsv(files[`${base}/mission_control/gs_radiation_received.csv`]);
    expect(gs[0]).toEqual([...GS_RADIATION_COLUMNS]);
    expect(gs.length - 1).toBe(state.comms.gs.radiationSamples.length);
    const ev = parseCsv(files[`${base}/mission_control/evacuation_plans.csv`]);
    expect(ev[0]).toEqual([...EVAC_PLAN_COLUMNS]);
    expect(ev.length - 1).toBe(state.evacuation.cases.reduce((a, c) => a + c.plans.length, 0));
    for (const k of ['measurements/positions.csv', 'measurements/events.csv', 'measurements/radiation_measurements.csv', 'measurements/vitals_measurements.csv', 'measurements/comms_log.csv', 'ground_truth/radiation_truth.csv', 'ground_truth/vitals_truth.csv', 'run_metadata.json']) {
      expect(`${base}/${k}` in files).toBe(true);
    }
  });

  it('snapshot is deterministic for the same seed', () => {
    const a = new SimEngine({ seed: 11 });
    a.runToCompletion();
    const b = new SimEngine({ seed: 11 });
    b.runToCompletion();
    expect(JSON.stringify(missionControlSnapshot(a))).toBe(JSON.stringify(missionControlSnapshot(b)));
  });
});

describe('Mission Control v2: received vitals history and optional interpolation', () => {
  const { state, engine } = completedRun();

  it('patient vitals history contains exactly the delivered VITALS samples, in sample-time order', () => {
    const p = state.comms.gs.patients[0];
    const delivered = state.comms.messages.filter((m) => m.type === 'VITALS' && m.status === 'DELIVERED');
    expect(p.vitalsHistory).toHaveLength(delivered.length);
    for (let i = 1; i < p.vitalsHistory.length; i++) expect(p.vitalsHistory[i].t).toBeGreaterThanOrEqual(p.vitalsHistory[i - 1].t);
    const onboard = new Map(state.casualty.measurements.map((m) => [m.id, m]));
    for (const v of p.vitalsHistory) expect(v.hr).toBe(onboard.get(v.sampleId)!.hr_measured);
    expect(p.vitalsHistory.length).toBeLessThanOrEqual(state.casualty.measurements.length);
  });

  it('IDW estimate never changes measured cells and never fills beyond the max distance', async () => {
    const { gsRadiationGrid, interpolateIdw, CELL_MEASURED, CELL_ESTIMATED, CELL_UNKNOWN } = await import('../src/sim');
    const g = gsRadiationGrid({ state, config: engine.config });
    const it2 = interpolateIdw(g, 12, 2);
    let est = 0;
    for (let k = 0; k < g.values.length; k++) {
      if (!Number.isNaN(g.values[k])) {
        expect(it2.kind[k]).toBe(CELL_MEASURED);
        expect(it2.values[k]).toBe(g.values[k]);
      } else if (it2.kind[k] === CELL_ESTIMATED) {
        est++;
        // nearest measured cell must lie within 12 m
        const ix = k % g.nx;
        const iz = Math.floor(k / g.nx);
        let best = Infinity;
        for (let j = 0; j < g.values.length; j++) if (!Number.isNaN(g.values[j])) best = Math.min(best, Math.hypot((j % g.nx) - ix, Math.floor(j / g.nx) - iz) * g.cell);
        expect(best).toBeLessThanOrEqual(12 + 1e-9);
      } else {
        expect(it2.kind[k]).toBe(CELL_UNKNOWN);
        expect(Number.isNaN(it2.values[k])).toBe(true);
      }
    }
    expect(est).toBe(it2.estimated);
    expect(est).toBeGreaterThan(0);
    // the evacuation plan and exports still see measured cells only
    const plans = engine.state.evacuation.cases[0].plans;
    for (const pl of [plans[0], plans[plans.length - 1]]) {
      const used = { ...state, comms: { ...state.comms, gs: { ...state.comms.gs, radiationSamples: state.comms.gs.radiationSamples.slice(0, pl.basis.gsRadiationSamples) } } };
      expect(gsRadiationGrid({ state: used, config: engine.config }).filled).toBe(pl.basis.measuredCells);
    }
  });

  it('IDW estimates stay within the range of measured values', async () => {
    const { gsRadiationGrid, interpolateIdw, CELL_ESTIMATED } = await import('../src/sim');
    const g = gsRadiationGrid({ state, config: engine.config });
    const it2 = interpolateIdw(g);
    for (let k = 0; k < g.values.length; k++) {
      if (it2.kind[k] !== CELL_ESTIMATED) continue;
      expect(it2.values[k]).toBeGreaterThanOrEqual(g.min - 1e-12);
      expect(it2.values[k]).toBeLessThanOrEqual(g.max + 1e-12);
    }
  });
});
