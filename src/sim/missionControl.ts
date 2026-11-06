import { BEE_IDS, SIM_VERSION } from './config';
import type { BeeId, SimConfig } from './config';
import { hopLossProbability, isAirborne } from './comms';
import type { CommMessage, PatientRecord, ReceivedRadiationSample } from './comms';
import { EVAC_STAGES, activePlan, gsRadiationGrid } from './evacuation';
import type { EvacStage } from './evacuation';
import type { SimEngine } from './engine';
import type { SimState } from './types';
import type { WorldDefinition } from './world';
import { decodeHotspots, surveyCoverage } from './survey';
import { gridLookup } from './heatmap';
import { splitRuns } from './routePlanner';
import type { P2, RouteRun } from './routePlanner';
import type { AreaCoverage, ReportedHotspot } from './survey';

/**
 * Mission Control view-model — pure functions of engine state.
 *
 * Everything here is derived from data the GROUND STATION has (delivered
 * packets, its own message bookkeeping, the site map) unless a function name
 * says "onboard". No ground truth is read in this module.
 */

// ------------------------------------------------------------ radiation analytics

export interface DoseSeriesPoint {
  sampleId: number;
  t: number;
  rate_uSv_h: number;
  liveTime_s: number;
  counts: number;
}

export interface CumulativeDose {
  /** Σ Ḣ_i·T_i over the windows in the series, µSv. */
  dose_uSv: number;
  /** 1σ counting uncertainty, µSv:  c·√ΣN / (k·3600). */
  sigma_uSv: number;
  /** Time covered by those windows, s. */
  coveredTime_s: number;
  /** Survey span from first window start to last window end, s. */
  spanTime_s: number;
  /** Windows expected in the span but not in the series (lost packets / not yet received). */
  missingWindows: number;
  coverage: number;
  /** COMPLETE when no window is missing; PARTIAL otherwise (dose covers received windows only). */
  basis: 'COMPLETE' | 'PARTIAL' | 'NO_DATA';
  /** Running cumulative dose after each window, for charts. */
  curve: { t: number; dose_uSv: number }[];
}

/**
 * Estimated cumulative ambient dose at the detector's position along the flight path.
 * Each sample is the mean dose rate over its own counting window T, so
 *   D = Σ Ḣ_i · T_i / 3600     [µSv]
 * needs NO interpolation. Windows that never reached the GS are NOT filled in;
 * they are counted and reported (basis = PARTIAL).
 */
export function cumulativeDose(series: readonly DoseSeriesPoint[], cfg: SimConfig['radiation']): CumulativeDose {
  if (!series.length) {
    return { dose_uSv: 0, sigma_uSv: 0, coveredTime_s: 0, spanTime_s: 0, missingWindows: 0, coverage: 0, basis: 'NO_DATA', curve: [] };
  }
  const sorted = [...series].sort((a, b) => a.sampleId - b.sampleId);
  let dose = 0;
  let counts = 0;
  let covered = 0;
  const curve: { t: number; dose_uSv: number }[] = [];
  for (const s of sorted) {
    dose += (s.rate_uSv_h * s.liveTime_s) / 3600;
    counts += s.counts;
    covered += s.liveTime_s;
    curve.push({ t: s.t, dose_uSv: dose });
  }
  const T = cfg.integrationTime_s;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const expected = last.sampleId - first.sampleId + 1; // sample ids are consecutive on board
  const missing = expected - sorted.length;
  const span = last.t - (first.t - first.liveTime_s);
  return {
    dose_uSv: dose,
    sigma_uSv: (cfg.calibrationFactor * Math.sqrt(counts)) / (cfg.sensitivity_cps_per_uSv_h * 3600),
    coveredTime_s: covered,
    // with spatial sampling (Phase 3B+) windows can be shorter than T, so expected × T would overstate the span
    spanTime_s: cfg.maxSampleSpacing_m > 0 ? span : Math.max(span, expected * T),
    missingWindows: missing,
    coverage: sorted.length / expected,
    basis: missing === 0 ? 'COMPLETE' : 'PARTIAL',
    curve,
  };
}

export const gsDoseSeries = (rx: readonly ReceivedRadiationSample[]): DoseSeriesPoint[] =>
  [...rx]
    .sort((a, b) => a.sampleId - b.sampleId)
    .map((r) => ({ sampleId: r.sampleId, t: r.sampleTime, rate_uSv_h: r.measured_uSv_h, liveTime_s: r.liveTime_s, counts: r.counts }));

/** On-board log (complete; in reality available only after the drone is recovered). */
export const onboardDoseSeries = (s: SimState): DoseSeriesPoint[] =>
  s.radiation.samples.map((r) => ({ sampleId: r.id, t: r.time, rate_uSv_h: r.measured_uSv_h, liveTime_s: r.liveTime_s, counts: r.counts }));

export function radiationStats(rx: readonly ReceivedRadiationSample[], s: SimState, cfg: SimConfig) {
  const grid = gsRadiationGrid({ state: s, config: cfg });
  let peak: ReceivedRadiationSample | null = null;
  let sum = 0;
  let above = 0;
  for (const r of rx) {
    sum += r.measured_uSv_h;
    if (!peak || r.measured_uSv_h > peak.measured_uSv_h) peak = r;
    if (r.measured_uSv_h >= cfg.alerts.doseRate_uSv_h) above++;
  }
  const latest = rx.length ? rx.reduce((a, b) => (b.sampleTime > a.sampleTime ? b : a)) : null;
  return {
    received: rx.length,
    sentOnboard: s.radiation.samples.length,
    latest,
    peak,
    mean_uSv_h: rx.length ? sum / rx.length : null,
    samplesAboveAlert: above,
    measuredCells: grid.filled,
    totalCells: grid.nx * grid.nz,
    grid,
  };
}

// ------------------------------------------------------------ patients

/**
 * DETECTED / ASSESSED = live feed; UNAVAILABLE = feed interrupted while the reporting bee is still
 * on task (stale / link lost); RECORDED (Phase 3B+) = the live feed has ENDED because the reporting
 * bee was recalled (recovery, return, landing, mission end) — the last recorded assessment is kept
 * and shown as such. Patient records are never deleted during a run; only Reset / a new mission
 * clears them (the UI archives them first).
 */
export type PatientDataState = 'DETECTED' | 'ASSESSED' | 'UNAVAILABLE' | 'RECORDED';

export interface PatientView {
  record: PatientRecord;
  dataState: PatientDataState;
  /** Why the data is unavailable (stale / link lost), if it is. */
  unavailableReason: string | null;
  /** Why the live feed ended (state RECORDED), e.g. "BEE-02 recalled for recovery at t = 689.1 s". */
  feedEndedReason: string | null;
  ageSinceUpdate_s: number;
  evacStage: EvacStage | null;
  /** §40: body-temperature (SKIN, non-contact IR) status as held at the GS. */
  temperature: TemperatureView;
}

/**
 * §40 body-temperature status at the GS:
 *   LIVE          — patient feed live and a reading younger than the stale limit;
 *   LAST_RECORDED — a reading exists but the feed ended / the reading is older (kept, with its time);
 *   UNAVAILABLE   — no defensible reading was ever received (shown as "-- °C"; nothing is invented).
 * The value is SKIN (surface) temperature from non-contact IR — not core body temperature.
 */
export type TemperatureStatus = 'LIVE' | 'LAST_RECORDED' | 'UNAVAILABLE';
export interface TemperatureView {
  status: TemperatureStatus;
  skin_c: number | null;
  sigma_c: number | null;
  sampleTime: number | null;
  /** Measured quantity, e.g. "SKIN (surface) temperature — non-contact IR; not core". */
  site: string;
  reason: string | null;
}

export const TEMPERATURE_SITE = 'SKIN (surface) temperature — non-contact IR; not core body temperature';

function temperatureView(p: PatientRecord, live: boolean, s: SimState, cfg: SimConfig): TemperatureView {
  const t = p.latestTemperature;
  const tc = cfg.casualty.temperature;
  if (!t)
    return {
      status: 'UNAVAILABLE',
      skin_c: null,
      sigma_c: null,
      sampleTime: null,
      site: TEMPERATURE_SITE,
      reason: !tc.enabled ? 'temperature sensor disabled' : 'no valid temperature reading received',
    };
  const fresh = s.time - t.sampleTime <= Math.max(10, 4 * tc.sampleInterval_s);
  return {
    status: live && fresh ? 'LIVE' : 'LAST_RECORDED',
    skin_c: t.skin_c,
    sigma_c: t.sigma_c,
    sampleTime: t.sampleTime,
    site: TEMPERATURE_SITE,
    reason: live && fresh ? null : live ? `no new temperature reading for ${(s.time - t.sampleTime).toFixed(0)} s` : 'live feed ended',
  };
}

const ENDED_PHASES = new Set(['RECOVERY', 'RETURN', 'LANDING', 'COMPLETE', 'INCOMPLETE', 'TIMEOUT']);

export function patientViews(s: SimState, cfg: SimConfig): PatientView[] {
  return s.comms.gs.patients.map((p) => {
    const age = s.time - p.lastRxTime;
    const linkDown = !s.comms.linkUp[p.reportedBy];
    const reporter = s.bees.find((b) => b.id === p.reportedBy);
    // the live feed ends by design once the reporting bee is recalled (Phase 3B lifecycle)
    let ended: string | null = null;
    if (s.mission.lifecycle && reporter && (reporter.rtb || ENDED_PHASES.has(s.mission.phase) || ['STAGED', 'DOCK_APPROACH', 'DOCKING'].includes(reporter.mode) || (reporter.mode === 'DOCKED' && s.mission.recovery.docked.includes(reporter.id)))) {
      const t = s.mission.recovery.startedAt;
      ended = `${p.reportedBy} recalled for recovery${t !== null ? ` at t = ${t.toFixed(1)} s` : ''} — live feed ended`;
    }
    let reason: string | null = null;
    if (!ended) {
      if (age > cfg.alerts.patientStale_s) reason = `no update for ${age.toFixed(0)} s`;
      else if (linkDown) reason = `link to ${p.reportedBy} lost`;
    }
    const c = s.evacuation.cases.find((x) => x.patientId === p.patientId);
    const dataState: PatientDataState = ended && (p.assessment || p.latestVitals) ? 'RECORDED' : reason || ended ? 'UNAVAILABLE' : p.assessment ? 'ASSESSED' : 'DETECTED';
    return {
      record: p,
      dataState,
      unavailableReason: reason ?? (ended && !(p.assessment || p.latestVitals) ? ended : null),
      feedEndedReason: ended,
      ageSinceUpdate_s: age,
      evacStage: c?.stage ?? null,
      temperature: temperatureView(p, dataState === 'ASSESSED' || dataState === 'DETECTED', s, cfg),
    };
  });
}

// ------------------------------------------------------------ swarm link status

export interface SwarmMemberStatus {
  id: BeeId;
  role: string;
  state: 'DOCKED' | 'ONLINE' | 'OFFLINE';
  route: 'direct' | 'relay' | 'none';
  lastRxTime: number | null;
  ageSinceRx_s: number | null;
  /** Delivered fraction of this node's last N messages (from per-node sequence gaps at the GS). */
  signalQualityEst: number | null;
  qualityWindow: number;
  latencyMean_ms: number | null;
  latencyLast_ms: number | null;
  sent: number;
  delivered: number;
  deliveryRatio: number | null;
  /** Link-model success probability for the route at the drone's current position (model value). */
  modelLinkSuccess: number | null;
  distanceToGs_m: number;
}

const ROLE: Record<BeeId, string> = { 'BEE-01': 'Radiation area & corridor survey', 'BEE-02': 'Casualty assessment', 'BEE-03': 'Comms relay' };

export function swarmStatus(s: SimState, cfg: SimConfig, world: WorldDefinition, window = 10): SwarmMemberStatus[] {
  const g = world.groundStation.position;
  const gs = { x: g.x, y: g.y + cfg.comms.gsAntennaHeight_m, z: g.z };
  const d3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const relay = s.bees.find((b) => b.id === cfg.comms.relayId)!;
  const bySrc = new Map<string, CommMessage[]>();
  for (const m of s.comms.messages) {
    const l = bySrc.get(m.src);
    if (l) l.push(m);
    else bySrc.set(m.src, [m]);
  }
  return BEE_IDS.map((id) => {
    const b = s.bees.find((x) => x.id === id)!;
    const msgs = bySrc.get(id) ?? [];
    const decided = msgs.filter((m) => m.status !== 'IN_FLIGHT');
    const recent = decided.slice(-window);
    const delivered = msgs.filter((m) => m.status === 'DELIVERED');
    const recentDel = delivered.slice(-window);
    const last = s.comms.gs.lastRxTime[id];
    const airborne = isAirborne(b);
    const dGs = d3(b.position, gs);
    let model: number | null = null;
    if (airborne) {
      if (dGs <= cfg.comms.linkRange_m) model = 1 - hopLossProbability(cfg.comms, dGs);
      else if (id !== cfg.comms.relayId && isAirborne(relay)) {
        const d1 = d3(b.position, relay.position);
        const d2 = d3(relay.position, gs);
        model = d1 <= cfg.comms.linkRange_m && d2 <= cfg.comms.linkRange_m ? (1 - hopLossProbability(cfg.comms, d1)) * (1 - hopLossProbability(cfg.comms, d2)) : 0;
      } else model = 0;
    }
    return {
      id,
      role: ROLE[id],
      state: !airborne ? 'DOCKED' : s.comms.linkUp[id] && last !== null && s.time - last <= cfg.alerts.droneOffline_s ? 'ONLINE' : 'OFFLINE',
      route: s.comms.lastRoute[id],
      lastRxTime: last,
      ageSinceRx_s: last === null ? null : s.time - last,
      signalQualityEst: recent.length ? recent.filter((m) => m.status === 'DELIVERED').length / recent.length : null,
      qualityWindow: recent.length,
      latencyMean_ms: recentDel.length ? recentDel.reduce((a, m) => a + (m.latency_ms as number), 0) / recentDel.length : null,
      latencyLast_ms: recentDel.length ? (recentDel[recentDel.length - 1].latency_ms as number) : null,
      sent: msgs.length,
      delivered: delivered.length,
      deliveryRatio: decided.length ? delivered.length / decided.length : null,
      modelLinkSuccess: model,
      distanceToGs_m: dGs,
    };
  });
}

// ------------------------------------------------------------ mission progress & alerts

export interface Milestone {
  key: string;
  label: string;
  done: boolean;
  time: number | null;
}

/** Coverage objective recorded with the survey state (0 = none). */
const cfgObjective = (s: SimState) => s.survey.objective ?? 0;

export function missionMilestones(s: SimState): Milestone[] {
  const ev = (type: string, id?: string) => s.events.find((e) => e.type === type && (id === undefined || e.entityId === id))?.time ?? null;
  const bee1 = s.bees.find((b) => b.id === 'BEE-01')!;
  const relay = s.bees.find((b) => b.id === 'BEE-03')!;
  const c = s.evacuation.cases[0];
  const st = (k: EvacStage) => (c?.stageTimes[k] ?? null);
  const lc = s.mission.lifecycle;
  const list: [string, string, number | null][] = [
    ...(lc ? ([['takeoff', 'Takeoff from ground station', ev('TAKEOFF_COMPLETE')]] as [string, string, number | null][]) : []),
    ['arrive', 'Mother on station', ev('MOTHER_ARRIVED')],
    ['deploy', 'Bees deployed 3/3', ev('BEE_CLEAR_OF_BAY', 'BEE-03')],
    // latched on the first ROUTE_COMPLETE: the RTB re-route (Phase 3B) resets routeCompleteTime
    ['relay', 'Relay on station', ev('ROUTE_COMPLETE', 'BEE-03') ?? relay.routeCompleteTime],
    s.survey.enabled
      ? cfgObjective(s) > 0
        ? ['survey', `Full-area survey ≥ ${Math.round(cfgObjective(s) * 100)}% flyable cells`, s.survey.coverageObjectiveMet ? s.survey.surveyCompleteTime : null]
        : ['survey', 'Area survey lanes flown', s.survey.surveyCompleteTime]
      : ['survey', `Radiation survey ${Math.min(bee1.waypointIndex + (bee1.mode === 'LOITER' ? 1 : 0), bee1.waypointTotal)}/${bee1.waypointTotal}`, ev('ROUTE_COMPLETE', 'BEE-01') ?? bee1.routeCompleteTime],
    ['detected', 'Casualty detected (GS)', st('DETECTED')],
    ['assessed', 'Casualty assessed (GS)', st('ASSESSED')],
    ['route', 'Evacuation route planned', st('ROUTE_PLANNED')],
    ...(s.corridor.enabled
      ? ([
          ['corridor', 'Corridor survey complete (GS)', s.corridor.task?.completeAt ?? null],
          ['validated', 'Route survey-validated', s.corridor.decision.final && s.corridor.decision.status === 'SURVEY_VALIDATED' ? s.corridor.decision.time : null],
        ] as [string, string, number | null][])
      : []),
    ...(lc
      ? ([
          ['recovered', `Bees recovered ${s.mission.recovery.docked.length}/3`, ev('RECOVERY_COMPLETE')],
          ['landed', 'Landed at ground station', s.mission.phase === 'COMPLETE' ? (s.mission.phaseTimes.COMPLETE ?? null) : null],
        ] as [string, string, number | null][])
      : []),
    ['rescue', 'Rescue requested (operator)', st('AWAITING_RESCUE')],
    ['evacuated', 'Evacuated (operator-confirmed)', st('EVACUATED')],
  ];
  return list.map(([key, label, time]) => ({ key, label, done: time !== null, time }));
}

export type AlertSeverity = 'critical' | 'warning' | 'info';
export interface MissionAlert {
  severity: AlertSeverity;
  code: string;
  source: string;
  message: string;
  since: number | null;
}

export function missionAlerts(s: SimState, cfg: SimConfig): MissionAlert[] {
  const out: MissionAlert[] = [];
  for (const w of s.comms.warnings) {
    out.push({ severity: w.code === 'LINK_LOST' || w.code === 'NO_RELAY' ? 'critical' : 'warning', code: w.code, source: w.nodeId, message: w.message, since: w.since });
  }
  for (const p of patientViews(s, cfg)) {
    const a = p.record.assessment;
    if (a && a.risk === 'HIGH') out.push({ severity: 'critical', code: 'PATIENT_RISK_HIGH', source: p.record.patientId, message: `${p.record.patientId}: risk HIGH (illustrative) — HR ${a.hr.toFixed(0)} bpm, RR ${a.rr.toFixed(0)} /min`, since: a.rxTime });
    else if (a && a.risk === 'MODERATE') out.push({ severity: 'warning', code: 'PATIENT_RISK_MODERATE', source: p.record.patientId, message: `${p.record.patientId}: risk MODERATE (illustrative)`, since: a.rxTime });
    if (p.dataState === 'UNAVAILABLE') out.push({ severity: 'warning', code: 'PATIENT_DATA_UNAVAILABLE', source: p.record.patientId, message: `${p.record.patientId}: data unavailable (${p.unavailableReason})`, since: p.record.lastRxTime });
  }
  const rx = s.comms.gs.radiationSamples;
  const latest = rx.length ? rx.reduce((a, b) => (b.sampleTime > a.sampleTime ? b : a)) : null;
  if (latest && latest.measured_uSv_h >= cfg.alerts.doseRate_uSv_h) {
    out.push({ severity: 'warning', code: 'DOSE_RATE_HIGH', source: latest.droneId, message: `Measured ${latest.measured_uSv_h.toFixed(2)} µSv/h ≥ alert level ${cfg.alerts.doseRate_uSv_h} µSv/h at (${latest.x.toFixed(0)}, ${latest.z.toFixed(0)})`, since: latest.sampleTime });
  }
  for (const c of s.evacuation.cases) {
    const pl = activePlan(c);
    if (pl?.metrics && pl.metrics.unknownFraction > 0.5) {
      out.push({ severity: 'info', code: 'ROUTE_UNSURVEYED', source: c.patientId, message: `${(pl.metrics.unknownFraction * 100).toFixed(0)}% of the proposed route crosses unsurveyed ground — dose there is unknown`, since: pl.time });
    }
    const failed = c.plans[c.plans.length - 1];
    if (failed && !failed.ok) out.push({ severity: 'warning', code: 'ROUTE_PLAN_FAILED', source: c.patientId, message: `Route planning failed: ${failed.failReason}`, since: failed.time });
  }
  const cd = s.corridor.decision;
  if (s.corridor.enabled && s.corridor.candidates.length) {
    if (cd.status === 'SURVEY_INCOMPLETE' && cd.final) {
      out.push({ severity: 'warning', code: 'ROUTE_SURVEY_INCOMPLETE', source: 'GS-1', message: `Evacuation corridor survey incomplete — no route has enough measurements (${cd.reasons[0] ?? 'see Evacuation tab'})`, since: cd.time });
    } else if (!cd.final) {
      out.push({ severity: 'info', code: 'CORRIDOR_SURVEY_PENDING', source: 'GS-1', message: `Corridor survey ${s.corridor.task ? s.corridor.task.state.replace('_', ' ').toLowerCase() : 'not tasked'} — route not yet validated`, since: s.corridor.candidatesAt });
    }
  }
  if (s.survey.enabled && s.survey.coverageObjectiveMet === false && s.survey.coverageAtComplete) {
    const c = s.survey.coverageAtComplete;
    out.push({ severity: 'warning', code: 'SURVEY_INCOMPLETE', source: 'BEE-01', message: `Area survey INCOMPLETE: ${(c.fractionReachable * 100).toFixed(1)}% of flyable cells measured (objective ${Math.round(cfg.survey.coverageObjective * 100)}%)`, since: s.survey.surveyCompleteTime });
  }
  for (const f of s.mission.recovery.failed) {
    out.push({ severity: 'critical', code: 'BEE_NOT_RECOVERED', source: f.bee, message: `${f.bee} NOT recovered (${f.reason.replace(/_/g, ' ').toLowerCase()}) — left in the field`, since: f.time });
  }
  if (s.mission.landing.onPad === false) out.push({ severity: 'warning', code: 'LANDING_OFF_PAD', source: 'MOTHER-01', message: `Touchdown ${s.mission.landing.horizontalError_m?.toFixed(2)} m from the pad centre`, since: s.mission.landing.touchdown });
  if (s.events.some((e) => e.type === 'MISSION_TIMEOUT')) out.push({ severity: 'critical', code: 'MISSION_TIMEOUT', source: 'MOTHER-01', message: 'Mission stopped at the safety time cap', since: s.time });
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ------------------------------------------------------------ structured JSON

const r = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/**
 * Mission Control snapshot (structured JSON). Contains ONLY ground-station-side
 * information (no ground truth). Safe to stream to an external dashboard.
 */
export function missionControlSnapshot(engine: SimEngine) {
  const s = engine.state;
  const cfg = engine.config;
  const rx = s.comms.gs.radiationSamples;
  const stats = radiationStats(rx, s, cfg);
  const dose = cumulativeDose(gsDoseSeries(rx), cfg.radiation);
  const grid = stats.grid;
  const cells: { ix: number; iz: number; x_m: number; z_m: number; mean_uSv_h: number; n: number; last_sample_time_s: number; mean_altitude_m: number }[] = [];
  for (let iz = 0; iz < grid.nz; iz++) {
    for (let ix = 0; ix < grid.nx; ix++) {
      const k = iz * grid.nx + ix;
      if (!grid.counts[k]) continue;
      cells.push({
        ix,
        iz,
        x_m: grid.x0 + (ix + 0.5) * grid.cell,
        z_m: grid.z0 + (iz + 0.5) * grid.cell,
        mean_uSv_h: r(grid.values[k], 6) as number,
        n: grid.counts[k],
        last_sample_time_s: r(grid.lastTime[k], 3) as number,
        mean_altitude_m: r(grid.meanAlt[k], 2) as number,
      });
    }
  }
  return {
    schema: 'beeguard.mission_control.v2',
    data_source: 'SIMULATED',
    disclaimer:
      'Simulated research prototype. Ground-station view only (no ground truth). Risk classes are illustrative, not clinical. Evacuation is PLANNING ONLY — no rescue movement is simulated.',
    sim_version: SIM_VERSION,
    scenario_id: engine.world.scenarioId,
    run_id: engine.runId,
    seed: cfg.seed,
    sim_time_s: r(s.time, 3),
    step: s.step,
    status: s.status,
    units: {
      time: 's (simulation time)',
      position: 'm (x east, y up, z south)',
      dose_rate: 'µSv/h',
      cumulative_dose: 'µSv',
      hr: 'beats/min',
      rr: 'breaths/min',
      latency: 'ms',
      ratio: '0..1',
    },
    milestones: missionMilestones(s),
    alerts: missionAlerts(s, cfg),
    drones: swarmStatus(s, cfg, engine.world).map((d) => ({
      drone_id: d.id,
      role: d.role,
      link_state: d.state,
      route: d.route,
      last_rx_time_s: r(d.lastRxTime, 3),
      signal_quality_est: r(d.signalQualityEst),
      quality_window_messages: d.qualityWindow,
      latency_mean_ms: r(d.latencyMean_ms, 2),
      messages_sent: d.sent,
      messages_delivered: d.delivered,
      delivery_ratio: r(d.deliveryRatio),
      model_link_success: r(d.modelLinkSuccess),
    })),
    patients: patientViews(s, cfg).map((p) => ({
      patient_id: p.record.patientId,
      reported_by: p.record.reportedBy,
      data_state: p.dataState,
      unavailable_reason: p.unavailableReason,
      feed_ended_reason: p.feedEndedReason,
      detected_at_s: r(p.record.detectedAt, 3),
      last_update_rx_s: r(p.record.lastRxTime, 3),
      onboard_status: p.record.onboardStatus,
      received_vitals_samples: p.record.vitalsHistory.length,
      location_estimate: p.record.location
        ? { x_m: r(p.record.location.x, 3), z_m: r(p.record.location.z, 3), sigma_m: r(p.record.location.sigma_m, 3), sample_time_s: r(p.record.location.sampleTime, 3) }
        : null,
      latest_vitals: p.record.latestVitals
        ? { hr_bpm: r(p.record.latestVitals.hr, 2), rr_brpm: r(p.record.latestVitals.rr, 2), sample_time_s: r(p.record.latestVitals.sampleTime, 3) }
        : null,
      body_temperature: {
        status: p.temperature.status,
        measured_quantity: p.temperature.site,
        value_c: r(p.temperature.skin_c, 2),
        sigma_c: r(p.temperature.sigma_c, 3),
        unit: '°C',
        sample_time_s: r(p.temperature.sampleTime, 3),
        received_samples: p.record.temperatureHistory.length,
        reason: p.temperature.reason,
      },
      assessment: p.record.assessment
        ? {
            hr_bpm: r(p.record.assessment.hr, 2),
            rr_brpm: r(p.record.assessment.rr, 2),
            hr_score: p.record.assessment.hrScore,
            rr_score: p.record.assessment.rrScore,
            total_score: p.record.assessment.total,
            risk_class_illustrative: p.record.assessment.risk,
            assessed_at_s: r(p.record.assessment.assessedAt, 3),
            received_at_s: r(p.record.assessment.rxTime, 3),
          }
        : null,
      evacuation_stage: p.evacStage,
    })),
    radiation: {
      source_of_values: 'measurements received at the ground station',
      samples_received: stats.received,
      latest: stats.latest ? { sample_id: stats.latest.sampleId, sample_time_s: r(stats.latest.sampleTime, 3), measured_uSv_h: r(stats.latest.measured_uSv_h, 6) } : null,
      peak: stats.peak ? { sample_id: stats.peak.sampleId, x_m: r(stats.peak.x, 2), z_m: r(stats.peak.z, 2), measured_uSv_h: r(stats.peak.measured_uSv_h, 6) } : null,
      mean_uSv_h: r(stats.mean_uSv_h, 6),
      alert_level_uSv_h: cfg.alerts.doseRate_uSv_h,
      cumulative_dose_at_detector: {
        dose_uSv: r(dose.dose_uSv, 6),
        sigma_uSv: r(dose.sigma_uSv, 6),
        basis: dose.basis,
        covered_time_s: r(dose.coveredTime_s, 3),
        missing_windows: dose.missingWindows,
        assumption: 'Σ measured rate × counting window over received windows only; missing windows are not filled in.',
      },
      grid: {
        x0_m: grid.x0,
        z0_m: grid.z0,
        cell_m: grid.cell,
        nx: grid.nx,
        nz: grid.nz,
        measured_cells: grid.filled,
        unsampled_cells: grid.nx * grid.nz - grid.filled,
        interpolation: 'none — unsampled cells are unknown',
        cells,
      },
    },
    evacuation: {
      planning_only: true,
      collection_point: cfg.evacuation.collectionPoint,
      stages: EVAC_STAGES,
      cases: s.evacuation.cases.map((c) => {
        const pl = activePlan(c);
        return {
          patient_id: c.patientId,
          stage: c.stage,
          stage_times_s: c.stageTimes,
          evacuated_by: c.evacuatedBy,
          route_frozen: c.frozen,
          plans_computed: c.plans.length,
          active_plan: pl
            ? {
                plan_id: pl.planId,
                planned_at_s: r(pl.time, 3),
                start: { x_m: r(pl.start.x, 3), z_m: r(pl.start.z, 3), sigma_m: r(pl.startSigma_m, 3) },
                goal: pl.goal,
                waypoints: pl.waypoints.map((w) => ({ x_m: r(w.x, 3), z_m: r(w.z, 3) })),
                length_m: r(pl.metrics?.length_m ?? null, 2),
                walk_time_s: r(pl.metrics?.walkTime_s ?? null, 1),
                measured_length_m: r(pl.metrics?.measuredLength_m ?? null, 2),
                unknown_length_m: r(pl.metrics?.unknownLength_m ?? null, 2),
                dose_over_measured_stretches_uSv: r(pl.metrics?.doseMeasuredStretches_uSv ?? null, 6),
                dose_note: 'Measured stretches only, using flight-altitude readings; unknown stretches are excluded, so this is a partial estimate.',
                min_obstacle_distance_m: r(pl.metrics?.minObstacleDistance_m ?? null, 2),
                shortest_route_length_m: r(pl.shortest?.metrics.length_m ?? null, 2),
                basis: pl.basis,
              }
            : null,
        };
      }),
      operator_actions: s.evacuation.operatorActions,
    },
    mission: {
      lifecycle: s.mission.lifecycle,
      phase: s.mission.phase,
      phase_start_times_s: s.mission.phaseTimes,
      mother_mode: s.mother.mode,
      recovery: { stage: s.mission.recovery.stage, docked: s.mission.recovery.docked, not_recovered: s.mission.recovery.failed },
      landing: s.mission.landing,
      note: 'Mother/lifecycle state is the simulator state (its command link is not part of the comms model).',
    },
    rescue_route: (() => {
      const p = s.rescue.current;
      if (!s.rescue.enabled) return { enabled: false };
      if (!p) return { enabled: true, plan: null };
      const rec = p.candidates.find((c) => c.id === p.recommendedId) ?? null;
      return {
        enabled: true,
        legend: 'Recommended Rescue Route — Radiation-Minimized (planning only; not proof that the route is safe)',
        plan_id: p.planId,
        planned_at_s: r(p.time, 2),
        frozen: p.frozen,
        status: p.status,
        unverified_reason: p.unverifiedReason,
        rate_threshold_uSv_h: p.rateLimit_uSv_h,
        rate_threshold_note: 'illustrative planning threshold — not a validated emergency-rescue safety limit',
        unknown_policy: p.unknownPolicy,
        destination: { measured_rate_uSv_h: r(p.destination.measuredRate_uSv_h, 5), above_threshold: p.destination.aboveLimit },
        rule: p.rule,
        warnings: p.warnings,
        start: p.start,
        goal: p.goal,
        recommended: rec
          ? {
              id: rec.id,
              label: rec.label,
              length_m: r(rec.evaluation.length_m, 2),
              walk_time_s: r(rec.evaluation.walkTime_s, 1),
              measured_fraction: r(rec.evaluation.coverage, 4),
              estimated_length_m: r(rec.estimatedLength_m, 2),
              unknown_length_m: r(rec.evaluation.unknownLength_m, 2),
              dose_total_uSv: r(rec.evaluation.doseTotal_uSv, 8),
              dose_total_sigma_uSv: r(rec.evaluation.doseTotalSigma_uSv, 8),
              dose_measured_uSv: r(rec.evaluation.doseMeasured_uSv, 8),
              max_measured_rate_uSv_h: r(rec.evaluation.maxRate_uSv_h, 5),
              data_check: rec.dataCheck,
              rate_check: rec.rateCheck,
              dose_unmeasured_conservative_uSv: r(rec.unmeasuredConservativeDose_uSv, 8),
              dose_conservative_uSv: r(rec.doseConservative_uSv, 8),
              dose_conservative_note: 'measured stretches + unmeasured stretches at the highest nearby measured rate — heuristic conservative estimate, not a statistical upper bound',
              sections: p.sections.map((x) => ({ kind: x.kind, length_m: r(x.length_m, 2) })),
            }
          : null,
        alternatives: p.candidates
          .filter((c) => c.id !== p.recommendedId)
          .map((c) => ({ id: c.id, label: c.label, length_m: r(c.evaluation.length_m, 2), measured_fraction: r(c.evaluation.coverage, 4), dose_total_uSv: r(c.evaluation.doseTotal_uSv, 8), dose_measured_uSv: r(c.evaluation.doseMeasured_uSv, 8), dose_conservative_uSv: r(c.doseConservative_uSv, 8), data_check: c.dataCheck, rate_check: c.rateCheck, verified: c.verified, issues: c.issues })),
      };
    })(),
    survey: (() => {
      const v = gsSurveyView(s, cfg, engine.world);
      if (!v) return { enabled: false };
      return {
        enabled: true,
        area: cfg.survey.area,
        altitude_m: cfg.survey.altitude_m,
        lane_spacing_m: cfg.survey.laneSpacing_m,
        reported_phase: v.reportedPhase,
        coverage_gs_received: {
          cells: v.coverage.cells,
          measured: v.coverage.measured,
          coverage: r(v.coverage.fraction, 4),
          reachable_cells: v.coverage.reachableCells,
          measured_reachable: v.coverage.measuredReachable,
          coverage_reachable: r(v.coverage.fractionReachable, 4),
          rule: 'cell counted only if ≥ 1 received measurement lies in it; estimates excluded',
        },
        hotspots_reported: v.hotspots,
      };
    })(),
    corridor: corridorSnapshot(s, cfg),
  };
}

// ------------------------------------------------------------ Phase 3A views

export interface GsSurveyView {
  coverage: AreaCoverage;
  reportedPhase: string | null;
  reportedAt: number | null;
  hotspots: ReportedHotspot[];
  task: { id: string; state: string; progress: number } | null;
  /**
   * Phase 3B+: area-survey completion as REPORTED by BEE-01 (heartbeat): lanes + gap fill done?,
   * coverage objective MET / NOT_MET (on-board coverage of flyable cells), objective fraction.
   * Null fields = not reported yet / no objective configured.
   */
  areaSurvey: { done: boolean | null; objective: 'MET' | 'NOT_MET' | null; onboardReachable: number | null; objectiveFraction: number };
}

/** Survey status as known at the GS (received measurements + BEE-01 heartbeat fields). */
export function gsSurveyView(s: SimState, cfg: SimConfig, world: WorldDefinition): GsSurveyView | null {
  if (!s.survey.enabled) return null;
  const hb = s.comms.gs.beeReports['BEE-01'];
  const t = s.corridor.task;
  return {
    coverage: surveyCoverage(gsRadiationGrid({ state: s, config: cfg }), cfg, world),
    reportedPhase: hb ? String(hb.fields.phase ?? '') || null : null,
    reportedAt: hb ? hb.sampleTime : null,
    hotspots: hb ? decodeHotspots(hb.fields.hotspots) : [],
    task: t ? { id: t.taskId, state: t.state, progress: t.progress } : null,
    areaSurvey: {
      done: hb && hb.fields.areaDone !== undefined ? Number(hb.fields.areaDone) === 1 : null,
      objective: hb && (hb.fields.areaObj === 'MET' || hb.fields.areaObj === 'NOT_MET') ? (hb.fields.areaObj as 'MET' | 'NOT_MET') : null,
      onboardReachable: hb && hb.fields.areaCov !== undefined && Number(hb.fields.areaCov) >= 0 ? Number(hb.fields.areaCov) : null,
      objectiveFraction: cfg.survey.coverageObjective,
    },
  };
}

function corridorSnapshot(s: SimState, cfg: SimConfig) {
  const cs = s.corridor;
  if (!cs.enabled) return { enabled: false };
  return {
    enabled: true,
    patient_id: cs.patientId,
    candidates_generated_at_s: r(cs.candidatesAt, 3),
    task: cs.task
      ? { task_id: cs.task.taskId, state: cs.task.state, attempts: cs.task.attempts, progress: r(cs.task.progress, 3), reason: cs.task.reason, ack_at_s: r(cs.task.ackAt, 3), complete_at_s: r(cs.task.completeAt, 3) }
      : null,
    decision: {
      status: cs.decision.status,
      final: cs.decision.final,
      selected: cs.decision.selectedId,
      provisional: cs.decision.provisional,
      rule: cs.decision.rule,
      reasons: cs.decision.reasons,
      decided_at_s: r(cs.decision.time, 3),
    },
    walking_speed_mps: cfg.evacuation.walkingSpeed_mps,
    validation_thresholds: cfg.survey.validation,
    candidates: cs.candidates.map((c) => {
      const e = cs.evaluations.find((x) => x.candidateId === c.id);
      return {
        id: c.id,
        kind: c.kind,
        label: c.label,
        tasked_to_bee01: c.tasked,
        waypoints: c.waypoints.map((w) => ({ x_m: r(w.x, 3), z_m: r(w.z, 3) })),
        evaluation: e
          ? {
              evaluated_at_s: r(e.time, 3),
              status: e.status,
              length_m: r(e.length_m, 2),
              walk_time_s: r(e.walkTime_s, 1),
              coverage: r(e.coverage, 4),
              measured_length_m: r(e.measuredLength_m, 2),
              unknown_length_m: r(e.unknownLength_m, 2),
              longest_gap_m: r(e.longestGap_m, 2),
              dose_measured_stretches_uSv: r(e.doseMeasured_uSv, 7),
              dose_measured_sigma_uSv: r(e.doseMeasuredSigma_uSv, 7),
              dose_total_uSv: r(e.doseTotal_uSv, 7),
              dose_total_sigma_uSv: r(e.doseTotalSigma_uSv, 7),
              max_rate_uSv_h: r(e.maxRate_uSv_h, 5),
              min_obstacle_distance_m: r(e.minObstacleDistance_m, 2),
              reasons: e.reasons,
            }
          : null,
      };
    }),
    dose_note:
      'One-way traverse at the walking speed; rates are received measurements at drone altitude (not ground level). dose_total only for SURVEYED routes (short gaps assumed at the adjacent measured rate, σ = 100 %); otherwise only the measured-stretch dose is given and the unmeasured part is NOT assumed zero.',
  };
}

export interface RecommendedRoute {
  source: 'CORRIDOR_SELECTION' | 'PLANNER';
  candidateId: string | null;
  label: string;
  /** SURVEY_VALIDATED / SURVEY_INCOMPLETE / PENDING (corridor) or PLANNED (planner only). */
  status: string;
  provisional: boolean;
  final: boolean;
  waypoints: P2[];
  /** Measured / unknown runs on the GS-received map. */
  runs: RouteRun[];
}

/**
 * The route Mission Control shows as "the" evacuation route: the corridor
 * selection when Phase 3A corridor validation is active, else the planner route.
 * Runs are split on the RECEIVED map (solid = measured, dashed = unknown).
 */
export function recommendedRoute(s: SimState, cfg: SimConfig, patientId?: string): RecommendedRoute | null {
  const cs = s.corridor;
  const c = patientId ? s.evacuation.cases.find((x) => x.patientId === patientId) : s.evacuation.cases[0];
  if (cs.enabled && cs.candidates.length && cs.decision.selectedId && (!c || c.patientId === cs.patientId)) {
    const k = cs.candidates.find((x) => x.id === cs.decision.selectedId);
    if (k) {
      const look = gridLookup(gsRadiationGrid({ state: s, config: cfg }));
      return {
        source: 'CORRIDOR_SELECTION',
        candidateId: k.id,
        label: `${k.id} · ${k.label}`,
        status: cs.decision.final ? cs.decision.status : 'PENDING',
        provisional: cs.decision.provisional || !cs.decision.final,
        final: cs.decision.final,
        waypoints: k.waypoints,
        runs: splitRuns(k.waypoints, look),
      };
    }
  }
  const pl = c ? activePlan(c) : null;
  if (!pl || !pl.ok) return null;
  return { source: 'PLANNER', candidateId: null, label: `planner route #${pl.planId}`, status: 'PLANNED', provisional: true, final: false, waypoints: pl.waypoints, runs: pl.runs };
}
