import type { SimEngine } from './engine';
import {
  commsToCsv,
  corridorHistoryToCsv,
  dockingAttemptsToCsv,
  missionPhasesToCsv,
  evacuationPlansToCsv,
  patientRecordsToCsv,
  rescueRoutesToCsv,
  rescueSectionsToCsv,
  rescueTruthToCsv,
  eventsToCsv,
  gsRadiationToCsv,
  positionsToCsv,
  radiationMeasurementsToCsv,
  radiationTruthToCsv,
  routeCandidatesToCsv,
  routePlanToCsv,
  routeTruthToCsv,
  runMetadata,
  temperatureMeasurementsToCsv,
  temperatureTruthToCsv,
  vitalsMeasurementsToCsv,
  vitalsTruthToCsv,
} from './csv';
import { buildZip } from './zip';
import { missionControlSnapshot } from './missionControl';

/**
 * Complete scientific dataset for one run.
 *
 *   measurements/   — what the simulated sensors and network produced
 *   ground_truth/   — simulator reference values (for MAE/RMSE), never sent over comms
 *
 * Join keys: radiation → sample_id; vitals → step (truth timeline is at 1 Hz
 * on the same steps the vitals sensor samples); positions → step + entity_id.
 */
export function datasetFiles(engine: SimEngine): Record<string, string> {
  const base = engine.runId;
  return {
    [`${base}/README.txt`]: readme(engine),
    [`${base}/run_metadata.json`]: JSON.stringify(runMetadata(engine), null, 2),
    [`${base}/measurements/positions.csv`]: positionsToCsv(engine),
    [`${base}/measurements/events.csv`]: eventsToCsv(engine),
    [`${base}/measurements/radiation_measurements.csv`]: radiationMeasurementsToCsv(engine),
    [`${base}/measurements/vitals_measurements.csv`]: vitalsMeasurementsToCsv(engine),
    [`${base}/measurements/temperature_measurements.csv`]: temperatureMeasurementsToCsv(engine),
    [`${base}/measurements/comms_log.csv`]: commsToCsv(engine),
    [`${base}/mission_control/mission_control.json`]: JSON.stringify(missionControlSnapshot(engine), null, 2),
    [`${base}/mission_control/gs_radiation_received.csv`]: gsRadiationToCsv(engine),
    [`${base}/mission_control/evacuation_plans.csv`]: evacuationPlansToCsv(engine),
    [`${base}/mission_control/patient_records.csv`]: patientRecordsToCsv(engine),
    ...(engine.state.rescue.enabled
      ? {
          [`${base}/mission_control/rescue_routes.csv`]: rescueRoutesToCsv(engine),
          [`${base}/mission_control/rescue_route_sections.csv`]: rescueSectionsToCsv(engine),
        }
      : {}),
    ...(engine.state.corridor.enabled
      ? {
          [`${base}/mission_control/route_candidates.csv`]: routeCandidatesToCsv(engine),
          [`${base}/mission_control/corridor_evaluations.csv`]: corridorHistoryToCsv(engine),
        }
      : {}),
    ...(engine.state.survey.enabled ? { [`${base}/measurements/bee01_route_plan.csv`]: routePlanToCsv(engine) } : {}),
    ...(engine.state.mission.lifecycle
      ? {
          [`${base}/measurements/mission_phases.csv`]: missionPhasesToCsv(engine),
          [`${base}/measurements/docking_attempts.csv`]: dockingAttemptsToCsv(engine),
        }
      : {}),
    [`${base}/ground_truth/radiation_truth.csv`]: radiationTruthToCsv(engine),
    [`${base}/ground_truth/vitals_truth.csv`]: vitalsTruthToCsv(engine),
    [`${base}/ground_truth/temperature_truth.csv`]: temperatureTruthToCsv(engine),
    ...(engine.state.corridor.enabled ? { [`${base}/ground_truth/route_candidates_truth.csv`]: routeTruthToCsv(engine) } : {}),
    ...(engine.state.rescue.enabled ? { [`${base}/ground_truth/rescue_route_truth.csv`]: rescueTruthToCsv(engine) } : {}),
    [`${base}/dataset_full.json`]: JSON.stringify(datasetJson(engine)),
  };
}

export function datasetZip(engine: SimEngine): Uint8Array {
  return buildZip(datasetFiles(engine));
}

/** Everything in one JSON document, with measurements and ground truth in separate branches. */
export function datasetJson(engine: SimEngine) {
  const s = engine.state;
  const c = s.casualty;
  return {
    metadata: runMetadata(engine),
    measurements: {
      positions: s.samples,
      events: s.events,
      radiation: s.radiation.samples.map((r) => ({
        sample_id: r.id,
        sim_time_s: r.time,
        step: r.step,
        drone_id: r.droneId,
        x_m: r.x,
        y_m: r.y,
        z_m: r.z,
        live_time_s: r.liveTime_s,
        counts: r.counts,
        measured_dose_rate_uSv_h: r.measured_uSv_h,
      })),
      vitals: c.measurements.map((m) => ({
        sample_id: m.id,
        sim_time_s: m.time,
        step: m.step,
        drone_id: m.droneId,
        casualty_id: c.id,
        x_m: m.x,
        y_m: m.y,
        z_m: m.z,
        distance_to_casualty_m: m.distance_m,
        drone_speed_mps: m.beeSpeed_mps,
        hr_measured_bpm: m.hr_measured,
        rr_measured_brpm: m.rr_measured,
        hr_sensor_sigma_bpm: m.hrSigma,
        rr_sensor_sigma_brpm: m.rrSigma,
      })),
      temperature: c.temperatureMeasurements.map((m) => ({
        temp_sample_id: m.id,
        sim_time_s: m.time,
        step: m.step,
        drone_id: m.droneId,
        casualty_id: c.id,
        distance_to_casualty_m: m.distance_m,
        drone_speed_mps: m.beeSpeed_mps,
        measured_quantity: 'SKIN_IR',
        skin_temp_measured_c: m.skin_measured_c,
        temp_sensor_sigma_c: m.sigma_c,
        unit: 'degC',
      })),
      comms: s.comms.messages.map((m) => ({
        msg_id: m.id,
        msg_type: m.type,
        src_id: m.src,
        dst_id: m.dst,
        route: m.route,
        hop_distances_m: m.hopDistances_m,
        sim_time_sent_s: m.tSent,
        sim_time_received_s: m.tReceived,
        latency_ms: m.latency_ms,
        status: m.status,
        drop_hop: m.dropHop,
        payload: m.data,
      })),
    },
    ground_truth: {
      radiation: s.radiation.samples.map((r) => ({
        sample_id: r.id,
        sim_time_s: r.time,
        step: r.step,
        x_m: r.x,
        y_m: r.y,
        z_m: r.z,
        distance_to_source_m: r.distance_m,
        true_dose_rate_window_mean_uSv_h: r.trueWindowMean_uSv_h,
        true_dose_rate_at_position_uSv_h: r.trueAtPosition_uSv_h,
      })),
      vitals: c.truthTimeline.map((t) => ({
        sim_time_s: t.time,
        step: t.step,
        casualty_id: c.id,
        hr_true_bpm: t.hr_true,
        rr_true_brpm: t.rr_true,
        hr_score: t.hrScore,
        rr_score: t.rrScore,
        risk_class_true_illustrative: t.risk_true,
      })),
      temperature: c.temperatureTruth.map((t) => ({ sim_time_s: t.time, step: t.step, casualty_id: c.id, skin_temp_true_c: t.skin_true_c, core_temp_true_c_reference_only: t.core_true_c, unit: 'degC' })),
      radiation_source: engine.config.radiation,
      casualty_position: engine.world.casualty.position,
    },
  };
}

function readme(engine: SimEngine): string {
  return [
    `BEE-GUARD simulated dataset — ${engine.runId}`,
    `scenario=${engine.world.scenarioId} seed=${engine.config.seed} dt=${engine.config.dt}s final_t=${engine.state.time.toFixed(2)}s status=${engine.state.status}`,
    '',
    'ALL DATA IS SIMULATED. No real sensor measurements. Not a validated physical digital twin.',
    'Casualty risk classes use illustrative thresholds (adapted from NEWS2 HR/RR bands) and are not clinical.',
    '',
    'measurements/  data_source=SIMULATED (what simulated sensors/network produced)',
    'ground_truth/  data_source=SIMULATED_GROUND_TRUTH (simulator reference; for MAE/RMSE)',
    'mission_control/  ground-station view only (received data, patients, link status, evacuation PLANNING) — no truth',
    '  route_candidates.csv      Phase 3A: candidate evacuation corridors — coverage, gaps, dose ± 1σ, SURVEYED/PARTIAL/UNKNOWN, selection',
    '  corridor_evaluations.csv  Phase 3A: candidate coverage/dose at each ground-station evaluation',
    'measurements/bee01_route_plan.csv  Phase 3A: BEE-01 waypoints as finally planned (lanes, adaptive scans, corridor task, hold)',
    'measurements/mission_phases.csv   Phase 3B: lifecycle phase start times (TAKEOFF … LANDING, COMPLETE / INCOMPLETE / TIMEOUT)',
    'measurements/docking_attempts.csv Phase 3B: every docking attempt with alignment, ascent and capture errors and the result',
    'ground_truth/route_candidates_truth.csv  Phase 3A: reference dose along each candidate at corridor altitude and at 1 m (evaluation only)',
    'mission_control/patient_records.csv       Phase 3B+: casualty record as held at the GS at export (last recorded assessment, readings, location, times; §40 skin temperature, status)',
    'measurements/temperature_measurements.csv §40: BEE-02 body-temperature readings = SKIN (surface) temperature by non-contact IR, °C ± 1σ — NOT core temperature',
    'ground_truth/temperature_truth.csv        §40: true skin temperature (the measurand) and core temperature (reference only, never measured)',
    'mission_control/rescue_routes.csv         Phase 3B+: rescue-team route candidates (start → casualty) with coverage, dose, status; recommended flag',
    'mission_control/rescue_route_sections.csv Phase 3B+: recommended rescue route split into MEASURED / ESTIMATED / UNKNOWN sections',
    'ground_truth/rescue_route_truth.csv       Phase 3B+: true dose along each rescue candidate at 1 m and survey altitude (evaluation only)',
    '',
    'Join keys:',
    '  radiation_measurements.sample_id  <->  radiation_truth.sample_id',
    '  vitals_measurements.step          <->  vitals_truth.step',
    '  temperature_measurements.step     <->  temperature_truth.step',
    '',
    'Python example:',
    '  import pandas as pd, numpy as np',
    "  m = pd.read_csv('measurements/radiation_measurements.csv')",
    "  t = pd.read_csv('ground_truth/radiation_truth.csv')",
    "  j = m.merge(t, on='sample_id')",
    "  e = j.measured_dose_rate_uSv_h - j.true_dose_rate_window_mean_uSv_h",
    '  print(e.abs().mean(), np.sqrt((e**2).mean()))',
    '',
    'Reproduce: same sim_version + same seed + same config (run_metadata.json) => identical files.',
    '',
  ].join('\r\n');
}
