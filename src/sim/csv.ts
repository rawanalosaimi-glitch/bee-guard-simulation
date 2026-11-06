import { SIM_VERSION } from './config';
import type { SimEngine } from './engine';
import { computeSummary } from './metrics';
import { corridorTruth } from './corridor';
import { patientViews } from './missionControl';
import { rescueTruth } from './rescue';

/**
 * CSV export. Every file is generated directly from engine state — the same
 * arrays the UI displays. Nothing is recomputed or fabricated for export.
 *
 * MEASUREMENT files carry data_source = SIMULATED.
 * GROUND-TRUTH files carry data_source = SIMULATED_GROUND_TRUTH and are kept
 * separate so analysts can compute MAE/RMSE by joining on the key columns.
 *
 * Line endings are CRLF (RFC 4180); numbers use '.' as decimal separator.
 */

export const DATA_SOURCE = 'SIMULATED';
export const TRUTH_SOURCE = 'SIMULATED_GROUND_TRUTH';

const ID_COLUMNS = ['scenario_id', 'run_id', 'seed'] as const;

export const POSITION_COLUMNS = [
  ...ID_COLUMNS,
  'sim_time_s',
  'step',
  'entity_id',
  'entity_type',
  'mode',
  'mission_status',
  'x_m',
  'y_m',
  'z_m',
  'vx_mps',
  'vy_mps',
  'vz_mps',
  'speed_mps',
  'waypoint_index',
  'waypoint_total',
  'hatch_open_frac',
  'avoidance_active',
  'data_source',
] as const;

export const EVENT_COLUMNS = [...ID_COLUMNS, 'sim_time_s', 'step', 'entity_id', 'event_type', 'details', 'data_source'] as const;

export const RADIATION_MEASUREMENT_COLUMNS = [
  ...ID_COLUMNS,
  'sample_id',
  'sim_time_s',
  'step',
  'drone_id',
  'x_m',
  'y_m',
  'z_m',
  'live_time_s',
  'counts',
  'measured_dose_rate_uSv_h',
  'data_source',
] as const;

export const RADIATION_TRUTH_COLUMNS = [
  ...ID_COLUMNS,
  'sample_id',
  'sim_time_s',
  'step',
  'x_m',
  'y_m',
  'z_m',
  'distance_to_source_m',
  'true_dose_rate_window_mean_uSv_h',
  'true_dose_rate_at_position_uSv_h',
  'data_source',
] as const;

export const VITALS_MEASUREMENT_COLUMNS = [
  ...ID_COLUMNS,
  'sample_id',
  'sim_time_s',
  'step',
  'drone_id',
  'casualty_id',
  'x_m',
  'y_m',
  'z_m',
  'distance_to_casualty_m',
  'drone_speed_mps',
  'hr_measured_bpm',
  'rr_measured_brpm',
  'hr_sensor_sigma_bpm',
  'rr_sensor_sigma_brpm',
  'data_source',
] as const;

export const VITALS_TRUTH_COLUMNS = [
  ...ID_COLUMNS,
  'sim_time_s',
  'step',
  'casualty_id',
  'hr_true_bpm',
  'rr_true_brpm',
  'hr_score',
  'rr_score',
  'risk_class_true_illustrative',
  'data_source',
] as const;

/** §40: body-temperature readings — SKIN (surface) temperature by non-contact IR on BEE-02; not core. */
export const TEMPERATURE_MEASUREMENT_COLUMNS = [
  ...ID_COLUMNS,
  'temp_sample_id',
  'sim_time_s',
  'step',
  'drone_id',
  'casualty_id',
  'x_m',
  'y_m',
  'z_m',
  'distance_to_casualty_m',
  'drone_speed_mps',
  'measured_quantity',
  'skin_temp_measured_c',
  'temp_sensor_sigma_c',
  'unit',
  'data_source',
] as const;

/** §40: temperature model truth (skin = the measurand; core = reference only, never measured). */
export const TEMPERATURE_TRUTH_COLUMNS = [...ID_COLUMNS, 'sim_time_s', 'step', 'casualty_id', 'skin_temp_true_c', 'core_temp_true_c_reference_only', 'unit', 'data_source'] as const;

export const COMMS_COLUMNS = [
  ...ID_COLUMNS,
  'msg_id',
  'msg_type',
  'src_id',
  'dst_id',
  'route',
  'hops',
  'hop_distances_m',
  'sim_time_sent_s',
  'step_sent',
  'sim_time_received_s',
  'step_processed',
  'latency_ms',
  'status',
  'drop_hop',
  'payload',
  'data_source',
] as const;

/** Mission Control: radiation measurements as RECEIVED at the ground station (rx time added). */
export const GS_RADIATION_COLUMNS = [
  ...ID_COLUMNS,
  'sample_id',
  'drone_id',
  'sim_time_sample_s',
  'sim_time_received_s',
  'x_m',
  'y_m',
  'z_m',
  'live_time_s',
  'counts',
  'measured_dose_rate_uSv_h',
  'data_source',
] as const;

/** Mission Control: every evacuation plan computed (planning only). */
export const EVAC_PLAN_COLUMNS = [
  ...ID_COLUMNS,
  'plan_id',
  'patient_id',
  'sim_time_s',
  'step',
  'ok',
  'fail_reason',
  'start_x_m',
  'start_z_m',
  'start_sigma_m',
  'goal_id',
  'goal_x_m',
  'goal_z_m',
  'length_m',
  'walk_time_s',
  'measured_length_m',
  'unknown_length_m',
  'dose_measured_stretches_uSv',
  'max_measured_rate_uSv_h',
  'min_obstacle_distance_m',
  'shortest_length_m',
  'shortest_dose_measured_stretches_uSv',
  'gs_radiation_samples_used',
  'measured_cells',
  'waypoints_xz',
  'data_source',
] as const;

/** Phase 3A: latest evaluation of every evacuation-corridor candidate + the decision (GS data only). */
export const ROUTE_CANDIDATE_COLUMNS = [
  ...ID_COLUMNS,
  'candidate_id',
  'kind',
  'label',
  'tasked_to_bee01',
  'evaluated_at_s',
  'length_m',
  'walk_time_s',
  'walking_speed_mps',
  'coverage_measured_fraction',
  'measured_length_m',
  'unknown_length_m',
  'longest_gap_m',
  'gap_count',
  'cells_on_route',
  'cells_measured',
  'dose_measured_stretches_uSv',
  'dose_measured_sigma_uSv',
  'gap_dose_assumed_uSv',
  'dose_total_uSv',
  'dose_total_sigma_uSv',
  'max_measured_rate_uSv_h',
  'mean_measured_rate_uSv_h',
  'min_obstacle_distance_m',
  'survey_status',
  'reasons',
  'selected',
  'decision_status',
  'decision_final',
  'decision_provisional',
  'decision_rule',
  'waypoints_xz',
  'data_source',
] as const;

/** Phase 3A: candidate coverage/dose at every GS evaluation (how the corridor survey progressed). */
export const CORRIDOR_HISTORY_COLUMNS = [...ID_COLUMNS, 'sim_time_s', 'candidate_id', 'coverage_measured_fraction', 'dose_measured_stretches_uSv', 'survey_status', 'data_source'] as const;

/** Phase 3A: BEE-01 route as finally planned (area lanes, adaptive scans, corridor task, hold). */
export const ROUTE_PLAN_COLUMNS = [...ID_COLUMNS, 'drone_id', 'waypoint_index', 'x_m', 'y_m', 'z_m', 'speed_cap_mps', 'tag', 'block', 'data_source'] as const;

/** Phase 3A ground truth: reference dose along each candidate (evaluation only). */
export const ROUTE_TRUTH_COLUMNS = [
  ...ID_COLUMNS,
  'candidate_id',
  'length_m',
  'walk_time_s',
  'true_dose_at_corridor_altitude_uSv',
  'true_max_rate_at_corridor_altitude_uSv_h',
  'corridor_altitude_m',
  'true_dose_at_1m_uSv',
  'true_max_rate_at_1m_uSv_h',
  'data_source',
] as const;

/** Phase 3B: mission phase transitions and docking attempts. */
export const MISSION_PHASE_COLUMNS = [...ID_COLUMNS, 'phase', 'sim_time_start_s', 'data_source'] as const;
export const DOCKING_COLUMNS = [
  ...ID_COLUMNS,
  'bee_id',
  'attempt',
  'result',
  'sim_time_start_s',
  'sim_time_end_s',
  'align_error_m',
  'max_ascent_error_m',
  'capture_error_m',
  'data_source',
] as const;

const EOL = '\r\n';

export function csvEscape(value: string | number | boolean | null): string {
  if (value === null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const num = (n: number, d: number): string => {
  const r = Number(n.toFixed(d));
  return String(Object.is(r, -0) ? 0 : r);
};

function table(header: readonly string[], rows: (string | number | boolean | null)[][]): string {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return lines.join(EOL) + EOL;
}

const ids = (e: SimEngine) => [e.world.scenarioId, e.runId, e.config.seed] as const;

export function positionsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  return table(
    POSITION_COLUMNS,
    engine.state.samples.map((s) => [
      ...id,
      num(s.time, 3),
      s.step,
      s.entityId,
      s.entityType,
      s.mode,
      s.missionStatus,
      num(s.x, 4),
      num(s.y, 4),
      num(s.z, 4),
      num(s.vx, 4),
      num(s.vy, 4),
      num(s.vz, 4),
      num(s.speed, 4),
      // 1-based waypoint for humans; 0 for the mother (no route)
      s.entityType === 'bee' ? s.waypointIndex + 1 : 0,
      s.waypointTotal,
      num(s.hatchOpen, 4),
      s.avoidanceActive ? 1 : 0,
      DATA_SOURCE,
    ]),
  );
}

export function eventsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  return table(
    EVENT_COLUMNS,
    engine.state.events.map((e) => [...id, num(e.time, 3), e.step, e.entityId, e.type, e.details, DATA_SOURCE]),
  );
}

export function radiationMeasurementsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  return table(
    RADIATION_MEASUREMENT_COLUMNS,
    engine.state.radiation.samples.map((r) => [
      ...id,
      r.id,
      num(r.time, 3),
      r.step,
      r.droneId,
      num(r.x, 4),
      num(r.y, 4),
      num(r.z, 4),
      num(r.liveTime_s, 3),
      r.counts,
      num(r.measured_uSv_h, 6),
      DATA_SOURCE,
    ]),
  );
}

export function radiationTruthToCsv(engine: SimEngine): string {
  const id = ids(engine);
  return table(
    RADIATION_TRUTH_COLUMNS,
    engine.state.radiation.samples.map((r) => [
      ...id,
      r.id,
      num(r.time, 3),
      r.step,
      num(r.x, 4),
      num(r.y, 4),
      num(r.z, 4),
      num(r.distance_m, 4),
      num(r.trueWindowMean_uSv_h, 6),
      num(r.trueAtPosition_uSv_h, 6),
      TRUTH_SOURCE,
    ]),
  );
}

export function vitalsMeasurementsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const c = engine.state.casualty;
  return table(
    VITALS_MEASUREMENT_COLUMNS,
    c.measurements.map((m) => [
      ...id,
      m.id,
      num(m.time, 3),
      m.step,
      m.droneId,
      c.id,
      num(m.x, 4),
      num(m.y, 4),
      num(m.z, 4),
      num(m.distance_m, 4),
      num(m.beeSpeed_mps, 4),
      num(m.hr_measured, 3),
      num(m.rr_measured, 3),
      num(m.hrSigma, 3),
      num(m.rrSigma, 3),
      DATA_SOURCE,
    ]),
  );
}

export function vitalsTruthToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const c = engine.state.casualty;
  return table(
    VITALS_TRUTH_COLUMNS,
    c.truthTimeline.map((t) => [
      ...id,
      num(t.time, 3),
      t.step,
      c.id,
      num(t.hr_true, 3),
      num(t.rr_true, 3),
      t.hrScore,
      t.rrScore,
      t.risk_true,
      TRUTH_SOURCE,
    ]),
  );
}

export function temperatureMeasurementsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const c = engine.state.casualty;
  return table(
    TEMPERATURE_MEASUREMENT_COLUMNS,
    c.temperatureMeasurements.map((m) => [
      ...id, m.id, num(m.time, 3), m.step, m.droneId, c.id, num(m.x, 4), num(m.y, 4), num(m.z, 4), num(m.distance_m, 4), num(m.beeSpeed_mps, 4),
      'SKIN_IR', num(m.skin_measured_c, 3), num(m.sigma_c, 3), 'degC', DATA_SOURCE,
    ]),
  );
}

export function temperatureTruthToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const c = engine.state.casualty;
  return table(
    TEMPERATURE_TRUTH_COLUMNS,
    c.temperatureTruth.map((t) => [...id, num(t.time, 3), t.step, c.id, num(t.skin_true_c, 3), num(t.core_true_c, 3), 'degC', TRUTH_SOURCE]),
  );
}

export function commsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  return table(
    COMMS_COLUMNS,
    engine.state.comms.messages.map((m) => [
      ...id,
      m.id,
      m.type,
      m.src,
      m.dst,
      m.route.join('>'),
      m.route.length ? m.route.length - 1 : 0,
      m.hopDistances_m.map((d) => num(d, 2)).join('|'),
      num(m.tSent, 3),
      m.stepSent,
      m.tReceived === null ? null : num(m.tReceived, 4),
      m.stepReceived,
      m.latency_ms === null ? null : num(m.latency_ms, 2),
      m.status,
      m.dropHop,
      m.payload,
      DATA_SOURCE,
    ]),
  );
}

export function gsRadiationToCsv(engine: SimEngine): string {
  const id = ids(engine);
  return table(
    GS_RADIATION_COLUMNS,
    engine.state.comms.gs.radiationSamples.map((r) => [
      ...id,
      r.sampleId,
      r.droneId,
      num(r.sampleTime, 3),
      num(r.rxTime, 4),
      num(r.x, 4),
      num(r.y, 4),
      num(r.z, 4),
      num(r.liveTime_s, 3),
      r.counts,
      num(r.measured_uSv_h, 6),
      DATA_SOURCE,
    ]),
  );
}

export function evacuationPlansToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const n = (v: number | null | undefined, d: number) => (v === null || v === undefined ? null : num(v, d));
  const rows: (string | number | boolean | null)[][] = [];
  for (const c of engine.state.evacuation.cases) {
    for (const p of c.plans) {
      rows.push([
        ...id,
        p.planId,
        p.patientId,
        num(p.time, 3),
        p.step,
        p.ok ? 1 : 0,
        p.failReason,
        num(p.start.x, 3),
        num(p.start.z, 3),
        num(p.startSigma_m, 3),
        p.goal.id,
        num(p.goal.x, 3),
        num(p.goal.z, 3),
        n(p.metrics?.length_m, 3),
        n(p.metrics?.walkTime_s, 2),
        n(p.metrics?.measuredLength_m, 3),
        n(p.metrics?.unknownLength_m, 3),
        n(p.metrics?.doseMeasuredStretches_uSv, 8),
        n(p.metrics?.maxMeasuredRate_uSv_h, 6),
        n(p.metrics?.minObstacleDistance_m, 3),
        n(p.shortest?.metrics.length_m, 3),
        n(p.shortest?.metrics.doseMeasuredStretches_uSv, 8),
        p.basis.gsRadiationSamples,
        p.basis.measuredCells,
        p.waypoints.map((w) => `${num(w.x, 2)} ${num(w.z, 2)}`).join('|'),
        DATA_SOURCE,
      ]);
    }
  }
  return table(EVAC_PLAN_COLUMNS, rows);
}

export function routeCandidatesToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const cs = engine.state.corridor;
  const n = (v: number | null | undefined, d: number) => (v === null || v === undefined ? null : num(v, d));
  return table(
    ROUTE_CANDIDATE_COLUMNS,
    cs.candidates.map((c) => {
      const e = cs.evaluations.find((x) => x.candidateId === c.id) ?? null;
      return [
        ...id,
        c.id,
        c.kind,
        c.label,
        c.tasked ? 1 : 0,
        n(e?.time, 3),
        n(e?.length_m, 3),
        n(e?.walkTime_s, 2),
        engine.config.evacuation.walkingSpeed_mps,
        n(e?.coverage, 5),
        n(e?.measuredLength_m, 3),
        n(e?.unknownLength_m, 3),
        n(e?.longestGap_m, 3),
        e ? e.gaps.length : null,
        e ? e.cellsOnRoute : null,
        e ? e.cellsMeasured : null,
        n(e?.doseMeasured_uSv, 9),
        n(e?.doseMeasuredSigma_uSv, 9),
        n(e?.gapDose_uSv, 9),
        n(e?.doseTotal_uSv, 9),
        n(e?.doseTotalSigma_uSv, 9),
        n(e?.maxRate_uSv_h, 6),
        n(e?.meanMeasuredRate_uSv_h, 6),
        n(e?.minObstacleDistance_m, 3),
        e ? e.status : null,
        e ? e.reasons.join(' | ') : null,
        cs.decision.selectedId === c.id ? 1 : 0,
        cs.decision.status,
        cs.decision.final ? 1 : 0,
        cs.decision.provisional ? 1 : 0,
        cs.decision.rule,
        c.waypoints.map((w) => `${num(w.x, 2)} ${num(w.z, 2)}`).join('|'),
        DATA_SOURCE,
      ];
    }),
  );
}

export function corridorHistoryToCsv(engine: SimEngine): string {
  const id = ids(engine);
  return table(
    CORRIDOR_HISTORY_COLUMNS,
    engine.state.corridor.history.map((h) => [...id, num(h.t, 3), h.id, num(h.coverage, 5), num(h.doseMeasured_uSv, 9), h.status, DATA_SOURCE]),
  );
}

export function routePlanToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const b = engine.state.bees.find((x) => x.id === 'BEE-01')!;
  return table(
    ROUTE_PLAN_COLUMNS,
    b.route.map((w, i) => [...id, b.id, i, num(w.x, 3), num(w.y, 3), num(w.z, 3), w.speed === undefined ? null : num(w.speed, 2), w.tag ?? null, w.block ?? null, DATA_SOURCE]),
  );
}

export function routeTruthToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const cfg = engine.config;
  const alt = cfg.survey.corridor.altitude_m;
  return table(
    ROUTE_TRUTH_COLUMNS,
    engine.state.corridor.candidates.map((c) => {
      let L = 0;
      for (let i = 1; i < c.waypoints.length; i++) L += Math.hypot(c.waypoints[i].x - c.waypoints[i - 1].x, c.waypoints[i].z - c.waypoints[i - 1].z);
      const a = corridorTruth(c.waypoints, cfg, alt);
      const g = corridorTruth(c.waypoints, cfg, 1);
      return [...id, c.id, num(L, 3), num(L / cfg.evacuation.walkingSpeed_mps, 2), num(a.dose_uSv, 9), num(a.maxRate_uSv_h, 6), alt, num(g.dose_uSv, 9), num(g.maxRate_uSv_h, 6), TRUTH_SOURCE];
    }),
  );
}

export function missionPhasesToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const rows = Object.entries(engine.state.mission.phaseTimes)
    .sort((a, b) => (a[1] as number) - (b[1] as number))
    .map(([p, t]) => [...id, p, num(t as number, 3), DATA_SOURCE]);
  return table(MISSION_PHASE_COLUMNS, rows);
}

export function dockingAttemptsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const n = (v: number | null, d: number) => (v === null ? null : num(v, d));
  return table(
    DOCKING_COLUMNS,
    engine.state.mission.recovery.attempts.map((a) => [...id, a.bee, a.attempt, a.result, num(a.start, 3), n(a.end, 3), n(a.alignError_m, 4), n(a.maxAscentError_m, 4), n(a.captureError_m, 4), DATA_SOURCE]),
  );
}

export const PATIENT_RECORD_COLUMNS = [
  'scenario_id', 'run_id', 'seed', 'patient_id', 'reported_by', 'data_state_at_export', 'feed_ended_reason',
  'detected_at_s', 'assessed_at_s', 'assessment_hr_bpm', 'assessment_rr_brpm', 'assessment_score', 'assessment_risk',
  'last_vitals_sample_time_s', 'last_hr_bpm', 'last_rr_brpm', 'last_rx_time_s', 'received_vitals_samples',
  'location_x_m', 'location_z_m', 'location_sigma_m', 'evac_stage',
  'temp_status', 'temp_measured_quantity', 'last_temp_c', 'last_temp_sigma_c', 'temp_unit', 'last_temp_sample_time_s', 'received_temp_samples',
  'export_sim_time_s', 'data_source',
  // v0.7.0 (appended): assessment_risk is the REPORTED (stabilized) class; raw class of the latest window and borderline flag
  'assessment_risk_raw', 'assessment_risk_borderline',
] as const;

/**
 * Phase 3B+: the casualty record AS HELD AT THE GROUND STATION when exported (last recorded
 * assessment and readings, location estimate, timestamps). Illustrative risk, not clinical.
 */
export function patientRecordsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const s = engine.state;
  const n = (v: number | null | undefined, d: number) => (v === null || v === undefined ? null : num(v, d));
  return table(
    PATIENT_RECORD_COLUMNS,
    patientViews(s, engine.config).map((p) => {
      const r = p.record;
      const a = r.assessment;
      const v = r.latestVitals;
      return [
        ...id, r.patientId, r.reportedBy, p.dataState, p.feedEndedReason,
        n(r.detectedAt, 3), n(a?.assessedAt, 3), n(a?.hr, 2), n(a?.rr, 2), a ? a.total : null, a ? a.risk : null,
        n(v?.sampleTime, 3), n(v?.hr, 2), n(v?.rr, 2), n(r.lastRxTime, 3), r.vitalsHistory.length,
        n(r.location?.x, 3), n(r.location?.z, 3), n(r.location?.sigma_m, 3), p.evacStage,
        p.temperature.status, 'SKIN_IR', n(p.temperature.skin_c, 2), n(p.temperature.sigma_c, 3), 'degC', n(p.temperature.sampleTime, 3), r.temperatureHistory.length,
        num(s.time, 3), DATA_SOURCE,
        a ? a.riskRaw : null, a ? a.riskBorderline : null,
      ];
    }),
  );
}

export const RESCUE_ROUTE_COLUMNS = [
  'scenario_id', 'run_id', 'seed', 'plan_id', 'plan_time_s', 'plan_status', 'candidate_id', 'recommended', 'radiation_weight_kappa',
  'start_id', 'start_x_m', 'start_z_m', 'goal_patient_id', 'goal_x_m', 'goal_z_m', 'length_m', 'walk_time_s',
  'measured_fraction', 'measured_length_m', 'estimated_length_m', 'unknown_length_m', 'longest_gap_m',
  'dose_measured_uSv', 'dose_measured_sigma_uSv', 'dose_total_uSv', 'dose_total_sigma_uSv', 'dose_estimated_stretches_uSv',
  'max_measured_rate_uSv_h', 'min_obstacle_distance_m', 'corridor_status', 'verified', 'issues', 'waypoints_xz', 'data_source',
  // v0.7.0 (appended; all earlier columns unchanged): separate checks, reason, conservative estimate (heuristic, not a statistical bound)
  'data_check', 'rate_check', 'unverified_reason', 'rate_threshold_uSv_h', 'unknown_policy',
  'dose_unmeasured_conservative_uSv', 'dose_conservative_uSv', 'destination_measured_rate_uSv_h', 'destination_above_threshold',
] as const;

/** Phase 3B+: rescue-team route candidates of the latest (or frozen) plan — GS data, planning only. */
export function rescueRoutesToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const p = engine.state.rescue.current;
  const n = (v: number | null | undefined, d: number) => (v === null || v === undefined || !Number.isFinite(v) ? null : num(v, d));
  if (!p) return table(RESCUE_ROUTE_COLUMNS, []);
  return table(
    RESCUE_ROUTE_COLUMNS,
    p.candidates.map((c) => {
      const e = c.evaluation;
      return [
        ...id, p.planId, num(p.time, 3), p.status, c.id, c.id === p.recommendedId, c.kappa,
        p.start.id, num(p.start.x, 3), num(p.start.z, 3), p.goal.patientId, num(p.goal.x, 3), num(p.goal.z, 3), num(e.length_m, 3), num(e.walkTime_s, 3),
        num(e.coverage, 4), num(e.measuredLength_m, 3), num(c.estimatedLength_m, 3), num(e.unknownLength_m, 3), num(e.longestGap_m, 3),
        n(e.doseMeasured_uSv, 8), n(e.doseMeasuredSigma_uSv, 8), n(e.doseTotal_uSv, 8), n(e.doseTotalSigma_uSv, 8), n(c.estimatedDose_uSv, 8),
        n(e.maxRate_uSv_h, 5), n(e.minObstacleDistance_m, 3), e.status, c.verified, c.issues.join('; '),
        c.waypoints.map((w) => `${w.x.toFixed(2)} ${w.z.toFixed(2)}`).join('|'), DATA_SOURCE,
        c.dataCheck, c.rateCheck, c.unverifiedReason, p.rateLimit_uSv_h, p.unknownPolicy,
        n(c.unmeasuredConservativeDose_uSv, 8), n(c.doseConservative_uSv, 8), n(p.destination.measuredRate_uSv_h, 5), p.destination.aboveLimit,
      ];
    }),
  );
}

export const RESCUE_SECTION_COLUMNS = ['scenario_id', 'run_id', 'seed', 'plan_id', 'candidate_id', 'section', 'kind', 'length_m', 'points_xz', 'data_source'] as const;

/** Phase 3B+: the recommended rescue route split into MEASURED / ESTIMATED / UNKNOWN sections, in walking order. */
export function rescueSectionsToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const p = engine.state.rescue.current;
  if (!p || !p.recommendedId) return table(RESCUE_SECTION_COLUMNS, []);
  return table(
    RESCUE_SECTION_COLUMNS,
    p.sections.map((s, i) => [...id, p.planId, p.recommendedId, i + 1, s.kind, num(s.length_m, 3), s.points.map((w) => `${w.x.toFixed(2)} ${w.z.toFixed(2)}`).join('|'), DATA_SOURCE]),
  );
}

export const RESCUE_TRUTH_COLUMNS = [
  'scenario_id', 'run_id', 'seed', 'plan_id', 'candidate_id', 'recommended', 'true_dose_1m_uSv', 'true_max_rate_1m_uSv_h', 'true_dose_survey_alt_uSv', 'true_max_rate_survey_alt_uSv_h', 'data_source',
] as const;

/** Ground truth for the rescue candidates (evaluation only — never used by the planner or the dashboard). */
export function rescueTruthToCsv(engine: SimEngine): string {
  const id = ids(engine);
  const p = engine.state.rescue.current;
  if (!p) return table(RESCUE_TRUTH_COLUMNS, []);
  return table(
    RESCUE_TRUTH_COLUMNS,
    p.candidates.map((c) => {
      const t = rescueTruth(c, engine.config);
      return [...id, p.planId, c.id, c.id === p.recommendedId, num(t.at1m.dose_uSv, 8), num(t.at1m.maxRate_uSv_h, 5), num(t.atSurvey.dose_uSv, 8), num(t.atSurvey.maxRate_uSv_h, 5), TRUTH_SOURCE];
    }),
  );
}

/** Run metadata (JSON): exact configuration + computed summary of this run. */
export function runMetadata(engine: SimEngine): Record<string, unknown> {
  const s = engine.state;
  return {
    data_source: DATA_SOURCE,
    disclaimer:
      'Simulated research prototype output. No real sensor measurements. Not a validated physical digital twin. ' +
      'Casualty risk classes use illustrative thresholds and are not a clinical assessment.',
    sim_version: SIM_VERSION,
    run_id: engine.runId,
    scenario_id: engine.world.scenarioId,
    seed: engine.config.seed,
    fixed_step_s: engine.config.dt,
    sample_interval_s: engine.config.sampleInterval,
    status: s.status,
    final_step: s.step,
    final_sim_time_s: Number(s.time.toFixed(3)),
    frame: 'Right-handed, metres. x = east, y = up (altitude above flat ground), z = south.',
    units: {
      position: 'm',
      velocity: 'm/s',
      time: 's',
      hatch_open_frac: '0..1',
      dose_rate: 'µSv/h (ambient dose-rate equivalent, notional)',
      hr: 'beats/min',
      rr: 'breaths/min',
      latency: 'ms',
    },
    summary: computeSummary(engine),
    bee_route_complete_time_s: Object.fromEntries(s.bees.map((b) => [b.id, b.routeCompleteTime])),
    bee_min_obstacle_clearance_m: Object.fromEntries(
      Object.entries(s.minClearance).map(([k, v]) => [k, Number.isFinite(v) ? Number(v.toFixed(3)) : null]),
    ),
    config: engine.config,
    world: engine.world,
  };
}

/** Minimal RFC 4180 parser (used by tests to validate exported files). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
