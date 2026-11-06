import { riskTimelineMetrics } from './riskMetrics';
import type { SimEngine } from './engine';
import { rescueTruth } from './rescue';
import { commsStats } from './comms';
import { cumulativeDose, gsDoseSeries, onboardDoseSeries } from './missionControl';
import { activePlan, gsRadiationGrid } from './evacuation';
import { buildHeatmap } from './heatmap';
import { surveyCoverage } from './survey';
import { corridorTruth } from './corridor';
import { mapQualityPair } from './mapQuality';

/**
 * Run summary metrics, computed ONLY from this run's recorded simulated data.
 * Error metrics compare simulated measurements against the simulator's own
 * ground truth; they describe the noise model, not real sensor accuracy.
 */

export interface ErrorStats {
  n: number;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
}

export function errorStats(pairs: [measured: number, truth: number][]): ErrorStats {
  if (!pairs.length) return { n: 0, mae: null, rmse: null, bias: null };
  let a = 0;
  let sq = 0;
  let b = 0;
  for (const [m, t] of pairs) {
    const e = m - t;
    a += Math.abs(e);
    sq += e * e;
    b += e;
  }
  const n = pairs.length;
  return { n, mae: a / n, rmse: Math.sqrt(sq / n), bias: b / n };
}

const r = (v: number | null, d = 4) => (v === null ? null : Number(v.toFixed(d)));
const rs = (e: ErrorStats, d = 4) => ({ n: e.n, mae: r(e.mae, d), rmse: r(e.rmse, d), bias: r(e.bias, d) });

export function computeSummary(engine: SimEngine) {
  const s = engine.state;
  const rad = s.radiation.samples;
  const c = s.casualty;
  const truthByStep = new Map(c.truthTimeline.map((t) => [t.step, t]));
  const hrPairs: [number, number][] = [];
  const rrPairs: [number, number][] = [];
  for (const m of c.measurements) {
    const t = truthByStep.get(m.step);
    if (!t) continue;
    hrPairs.push([m.hr_measured, t.hr_true]);
    rrPairs.push([m.rr_measured, t.rr_true]);
  }
  const bee02 = s.bees.find((b) => b.id === 'BEE-02');
  const cs = commsStats(s.comms.messages);
  const perSrc = Object.fromEntries(
    ['BEE-01', 'BEE-02', 'BEE-03'].map((id) => {
      const st = commsStats(s.comms.messages.filter((m) => m.src === id));
      return [id, { sent: st.sent, delivered: st.delivered, droppedLink: st.droppedLink, droppedNoRoute: st.droppedNoRoute, deliveryRatio: r(st.deliveryRatio), latencyMean_ms: r(st.latencyMean_ms, 2), viaRelay: st.viaRelay }];
    }),
  );
  return {
    radiation: {
      samples: rad.length,
      peak_measured_uSv_h: r(s.radiation.peakMeasured?.measured_uSv_h ?? null),
      peak_measured_position: s.radiation.peakMeasured
        ? { x: r(s.radiation.peakMeasured.x, 2), y: r(s.radiation.peakMeasured.y, 2), z: r(s.radiation.peakMeasured.z, 2) }
        : null,
      error_vs_window_mean_truth_uSv_h: rs(errorStats(rad.map((x) => [x.measured_uSv_h, x.trueWindowMean_uSv_h]))),
      error_note: 'error_vs_window_mean_truth checks the counting-noise model only (circular, audit B1); use map_quality for mapping performance.',
      map_quality: {
        note: 'Heat-map cell (4 m) vs true field at the cell centre and the cells mean sample altitude — evaluation only; see docs/SCIENTIFIC_AUDIT.md.',
        gs_received: mapQualityPair(gsRadiationGrid({ state: s, config: engine.config }), engine.config),
        onboard: mapQualityPair(buildHeatmap(rad, engine.config.radiation.heatmap), engine.config),
      },
      cumulative_dose_at_detector_uSv: (() => {
        const on = cumulativeDose(onboardDoseSeries(s), engine.config.radiation);
        const gs = cumulativeDose(gsDoseSeries(s.comms.gs.radiationSamples), engine.config.radiation);
        const truth = rad.reduce((a, x) => a + (x.trueWindowMean_uSv_h * x.liveTime_s) / 3600, 0);
        return {
          onboard_measured: r(on.dose_uSv, 6),
          onboard_sigma: r(on.sigma_uSv, 6),
          gs_received_measured: r(gs.dose_uSv, 6),
          gs_missing_windows: gs.missingWindows,
          truth_reference: r(truth, 6),
        };
      })(),
    },
    casualty: {
      id: c.id,
      status: c.status,
      bee02_release_time_s: bee02?.releaseTime ?? null,
      first_in_range_time_s: r(c.firstInRangeTime, 3),
      detection_time_s: r(c.detectionTime, 3),
      detection_distance_m: r(c.detectionDistance_m, 3),
      detection_scans: c.scans,
      detection_delay_from_release_s: r(c.detectionDelayFromRelease_s, 3),
      detection_delay_from_in_range_s: r(c.detectionDelayFromInRange_s, 3),
      first_vitals_time_s: r(c.firstVitalsTime, 3),
      assessment_time_s: r(c.assessmentTime, 3),
      assessment_delay_from_detection_s: r(c.assessmentDelay_s, 3),
      vitals_samples: c.measurements.length,
      initial_assessment_measured: c.initialAssessment,
      initial_assessment_truth_same_window: c.initialTruthAssessment,
      latest_assessment_measured: c.estimate,
      latest_assessment_truth_same_window: c.truthAtEstimate,
      hr_error_bpm: rs(errorStats(hrPairs), 3),
      skin_temperature_error_c: rs(
        errorStats(
          c.temperatureMeasurements
            .map((m) => [m, c.temperatureTruth.find((t) => t.step === m._truthStep)] as const)
            .filter((x) => !!x[1])
            .map(([m, t]) => [m.skin_measured_c, t!.skin_true_c]),
        ),
        3,
      ),
      temperature_samples: c.temperatureMeasurements.length,
      risk_class_agreement_initial: c.initialAssessment && c.initialTruthAssessment ? c.initialAssessment.risk === c.initialTruthAssessment.risk : null,
      risk_class_agreement_latest: c.estimate && c.truthAtEstimate ? c.estimate.risk === c.truthAtEstimate.risk : null,
      // v0.7.0 Fix B: stabilized reported class vs raw class vs truth over every window
      risk_reported_latest: c.riskTracker.reported,
      risk_class_agreement_latest_reported: c.riskTracker.reported && c.truthAtEstimate ? c.riskTracker.reported === c.truthAtEstimate.risk : null,
      risk_stability: riskTimelineMetrics(c.riskTimeline),
      rr_error_brpm: rs(errorStats(rrPairs), 3),
      location_estimate: c.locationEstimate
        ? {
            x: r(c.locationEstimate.x, 3),
            z: r(c.locationEstimate.z, 3),
            sigma_m: r(c.locationEstimate.sigma_m, 3),
            fixes: c.locationEstimate.fixes,
            error_vs_truth_m: r(Math.hypot(c.locationEstimate.x - engine.world.casualty.position.x, c.locationEstimate.z - engine.world.casualty.position.z), 3),
          }
        : null,
      risk_rule_note: 'Illustrative thresholds adapted from NEWS2 HR/RR bands; not a clinical assessment.',
    },
    comms: {
      sent: cs.sent,
      delivered: cs.delivered,
      dropped_link: cs.droppedLink,
      dropped_no_route: cs.droppedNoRoute,
      in_flight: cs.inFlight,
      delivery_ratio: r(cs.deliveryRatio),
      latency_mean_ms: r(cs.latencyMean_ms, 2),
      latency_p95_ms: r(cs.latencyP95_ms, 2),
      latency_max_ms: r(cs.latencyMax_ms, 2),
      delivered_via_relay: cs.viaRelay,
      per_source: perSrc,
      link_lost_events: s.events.filter((e) => e.type === 'LINK_LOST').length,
    },
    mission: missionSummary(engine),
    rescue_route: rescueSummary(engine),
    survey: surveySummary(engine),
    corridor: corridorSummary(engine),
    mission_duration_s: r(s.time, 2),
    evacuation: s.evacuation.cases.map((c) => {
      const p = activePlan(c);
      return {
        patient_id: c.patientId,
        stage: c.stage,
        stage_times_s: c.stageTimes,
        plans_computed: c.plans.length,
        active_plan_length_m: r(p?.metrics?.length_m ?? null, 2),
        active_plan_unknown_fraction: r(p?.metrics?.unknownFraction ?? null, 4),
        planning_only: true,
      };
    }),
  };
}

/** Phase 3A: area-survey coverage metrics (measured cells only — estimates are never counted). */
export function surveySummary(engine: SimEngine) {
  const s = engine.state;
  const cfg = engine.config;
  const sv = s.survey;
  if (!sv.enabled) return { enabled: false };
  const on = surveyCoverage(buildHeatmap(s.radiation.samples, cfg.radiation.heatmap), cfg, engine.world);
  const gs = surveyCoverage(gsRadiationGrid({ state: s, config: cfg }), cfg, engine.world);
  const cov = (c: typeof on) => ({
    cells: c.cells,
    measured: c.measured,
    coverage: r(c.fraction, 4),
    reachable_cells: c.reachableCells,
    measured_reachable: c.measuredReachable,
    coverage_reachable: r(c.fractionReachable, 4),
    blocked_cells: c.blockedCells,
    measured_outside_area: c.measuredOutsideArea,
  });
  const bee = s.bees.find((b) => b.id === 'BEE-01')!;
  return {
    enabled: true,
    area: sv.area,
    altitude_m: cfg.survey.altitude_m,
    lanes: sv.laneZ.length,
    lane_spacing_m: cfg.survey.laneSpacing_m,
    planned_area_length_m: r(sv.plannedSurveyLength_m, 1),
    survey_start_s: r(sv.surveyStartTime, 2),
    survey_complete_s: r(sv.surveyCompleteTime, 2),
    survey_duration_s: sv.surveyStartTime !== null && sv.surveyCompleteTime !== null ? r(sv.surveyCompleteTime - sv.surveyStartTime, 2) : null,
    coverage_onboard: cov(on),
    coverage_gs_received: cov(gs),
    hotspots: sv.hotspots.map((h) => ({ id: h.id, x: r(h.x, 2), z: r(h.z, 2), peak_uSv_h: r(h.peak_uSv_h, 4), detected_s: r(h.detectedAt, 2), scan_start_s: r(h.scanStart, 2), scan_end_s: r(h.scanEnd, 2) })),
    bee01_route_waypoints: bee.route.length,
    bee01_skipped_waypoints: s.events.filter((e) => e.entityId === 'BEE-01' && e.type === 'WAYPOINT_SKIPPED').length,
    bee01_min_obstacle_clearance_m: r(Number.isFinite(s.minClearance['BEE-01']) ? s.minClearance['BEE-01'] : null, 3),
    min_bee_bee_separation_m: r(Number.isFinite(s.minSeparation.beeBee_m) ? s.minSeparation.beeBee_m : null, 3),
    min_bee_bee_separation_pair: s.minSeparation.beeBeePair,
    min_mother_bee_separation_m: r(Number.isFinite(s.minSeparation.motherBee_m) ? s.minSeparation.motherBee_m : null, 3),
    plan_warnings: sv.planWarnings,
    note: 'Coverage = heat-map cells (4 m) inside the area holding ≥ 1 measurement. "Reachable" excludes cells within the flight clearance of structures that block at survey altitude.',
  };
}

/** Phase 3A: corridor survey, candidate comparison and selection (+ truth comparison for evaluation only). */
export function corridorSummary(engine: SimEngine) {
  const s = engine.state;
  const cfg = engine.config;
  const cs = s.corridor;
  if (!cs.enabled) return { enabled: false };
  const onTask = s.survey.tasks[0] ?? null;
  return {
    enabled: true,
    candidates_generated_s: r(cs.candidatesAt, 2),
    task: cs.task
      ? {
          id: cs.task.taskId,
          state: cs.task.state,
          attempts: cs.task.attempts,
          first_sent_s: r(cs.task.firstSentAt, 2),
          ack_rx_s: r(cs.task.ackAt, 3),
          complete_rx_s: r(cs.task.completeAt, 3),
          reason: cs.task.reason,
          gs_estimated_duration_s: r(cs.task.estDuration_s, 1),
          onboard_received_s: r(onTask?.receivedAt ?? null, 3),
          onboard_started_s: r(onTask?.startedAt ?? null, 3),
          onboard_completed_s: r(onTask?.completedAt ?? null, 3),
          onboard_duration_s: onTask && onTask.startedAt !== null && onTask.completedAt !== null ? r(onTask.completedAt - onTask.startedAt, 2) : null,
          onboard_estimated_duration_s: r(onTask?.estDuration_s ?? null, 1),
          completion: r(cs.task.progress, 3),
        }
      : null,
    decision: { ...cs.decision, time: r(cs.decision.time, 2) },
    candidates: cs.evaluations.map((e) => {
      const c = cs.candidates.find((k) => k.id === e.candidateId)!;
      const tAlt = corridorTruth(c.waypoints, cfg, cfg.survey.corridor.altitude_m);
      const tGround = corridorTruth(c.waypoints, cfg, 1);
      return {
        id: e.candidateId,
        kind: c.kind,
        tasked: c.tasked,
        length_m: r(e.length_m, 2),
        walk_time_s: r(e.walkTime_s, 1),
        coverage: r(e.coverage, 4),
        longest_gap_m: r(e.longestGap_m, 2),
        status: e.status,
        dose_measured_uSv: r(e.doseMeasured_uSv, 7),
        dose_measured_sigma_uSv: r(e.doseMeasuredSigma_uSv, 7),
        dose_total_uSv: r(e.doseTotal_uSv, 7),
        dose_total_sigma_uSv: r(e.doseTotalSigma_uSv, 7),
        // ground truth — evaluation only, never used by the GS logic
        truth_dose_at_survey_altitude_uSv: r(tAlt.dose_uSv, 7),
        truth_dose_at_1m_uSv: r(tGround.dose_uSv, 7),
        selected: cs.decision.selectedId === e.candidateId,
      };
    }),
    note: 'Dose = one-way traverse at the walking speed, from received dose-rate measurements at corridor/survey altitude (not ground level). Truth columns are for evaluation only.',
  };
}

/** Phase 3B: mission lifecycle metrics (takeoff, recovery, return, landing). */
export function missionSummary(engine: SimEngine) {
  const s = engine.state;
  const ms = s.mission;
  if (!ms.lifecycle) return { lifecycle: false, final_phase: ms.phase };
  const r = ms.recovery;
  return {
    lifecycle: true,
    final_phase: ms.phase,
    phase_start_times_s: Object.fromEntries(Object.entries(ms.phaseTimes).map(([k, v]) => [k, r2(v as number, 2)])),
    takeoff: { start_s: r2(ms.takeoff.start, 2), end_s: r2(ms.takeoff.end, 2), max_horizontal_drift_m: r2(ms.takeoff.maxDrift_m, 3) },
    objectives_complete_s: r2(ms.objectivesCompleteAt, 2),
    recovery: {
      started_s: r2(r.startedAt, 2),
      completed_s: r2(r.completedAt, 2),
      duration_s: r.startedAt !== null && r.completedAt !== null ? r2(r.completedAt - r.startedAt, 2) : null,
      docked: r.docked,
      not_recovered: r.failed,
      attempts: r.attempts.map((a) => ({ bee: a.bee, attempt: a.attempt, result: a.result, start_s: r2(a.start, 2), end_s: r2(a.end, 2), align_error_m: r2(a.alignError_m, 4), max_ascent_error_m: r2(a.maxAscentError_m, 4), capture_error_m: r2(a.captureError_m, 4) })),
    },
    landing: {
      start_s: r2(ms.landing.start, 2),
      touchdown_s: r2(ms.landing.touchdown, 2),
      horizontal_error_m: r2(ms.landing.horizontalError_m, 3),
      vertical_speed_mps: r2(ms.landing.verticalSpeed_mps, 3),
      on_pad: ms.landing.onPad,
    },
    mother_min_obstacle_clearance_m: Number.isFinite(ms.motherMinClearance_m) ? r2(ms.motherMinClearance_m, 2) : null,
    note: 'COMPLETE requires a verified touchdown within the landing tolerance with all three bees docked; otherwise INCOMPLETE or TIMEOUT.',
  };
}

/** Phase 3B+: recommended rescue-team route (GS data) with the TRUE dose for evaluation. */
export function rescueSummary(engine: SimEngine) {
  const p = engine.state.rescue.current;
  if (!engine.state.rescue.enabled) return { enabled: false };
  if (!p) return { enabled: true, status: 'NOT_PLANNED' };
  const rec = p.candidates.find((c) => c.id === p.recommendedId) ?? null;
  const t = rec ? rescueTruth(rec, engine.config) : null;
  return {
    enabled: true,
    status: p.status,
    plans_computed: engine.state.rescue.plansComputed,
    recommended_id: p.recommendedId,
    candidates: p.candidates.length,
    length_m: rec ? r2(rec.evaluation.length_m, 2) : null,
    walk_time_s: rec ? r2(rec.evaluation.walkTime_s, 1) : null,
    measured_fraction: rec ? r2(rec.evaluation.coverage, 4) : null,
    dose_estimate_uSv: rec ? r2(rec.evaluation.doseTotal_uSv ?? rec.evaluation.doseMeasured_uSv, 8) : null,
    dose_estimate_is_lower_bound: rec ? rec.evaluation.doseTotal_uSv === null : null,
    true_dose_1m_uSv: t ? r2(t.at1m.dose_uSv, 8) : null,
    true_dose_survey_alt_uSv: t ? r2(t.atSurvey.dose_uSv, 8) : null,
    // v0.7.0 (Fix A): measured dose ± counting σ, heuristic conservative estimate, separate checks
    dose_measured_uSv: rec ? r2(rec.evaluation.doseMeasured_uSv, 8) : null,
    dose_measured_sigma_uSv: rec ? r2(rec.evaluation.doseMeasuredSigma_uSv, 8) : null,
    dose_total_sigma_uSv: rec ? r2(rec.evaluation.doseTotalSigma_uSv, 8) : null,
    dose_conservative_uSv: rec ? r2(rec.doseConservative_uSv, 8) : null,
    max_measured_rate_uSv_h: rec ? r2(rec.evaluation.maxRate_uSv_h, 5) : null,
    data_check: rec ? rec.dataCheck : null,
    rate_check: rec ? rec.rateCheck : null,
    unverified_reason: p.unverifiedReason,
    rate_threshold_uSv_h: p.rateLimit_uSv_h,
    destination_measured_rate_uSv_h: r2(p.destination.measuredRate_uSv_h, 5),
    destination_above_threshold: p.destination.aboveLimit,
    unknown_policy: p.unknownPolicy,
    warnings: p.warnings,
  };
}

const r2 = (v: number | null | undefined, d: number) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
