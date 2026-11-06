import { SIM_VERSION } from './config';
import type { SimConfigOverrides } from './config';
import { SimEngine } from './engine';
import { datasetFiles } from './dataset';
import { computeSummary } from './metrics';
import { patientViews } from './missionControl';

/**
 * Stage 3 — controlled experiment workflow (docs/EXPERIMENTS.md). Pure: no file system access here;
 * the CLI (experiments/run.ts) writes what these functions return.
 *
 * Design (approved 2026-10-19): three scenarios LOW / MEDIUM / HIGH that vary ONLY
 *   (1) radiation source strength at 1 m and (2) casualty physiology (true illustrative risk class);
 * everything else = DEFAULT_CONFIG (same site, same geometry, same comms). Paired design: the SAME
 * 10 seeds in every scenario (common random numbers). Runs are headless with NO operator actions.
 * Failed / incomplete runs are kept: every scenario × seed produces exactly one row.
 */
export const EXPERIMENT_SEEDS: readonly number[] = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];

export interface ExperimentScenario {
  id: 'LOW' | 'MEDIUM' | 'HIGH';
  description: string;
  /** Intended TRUE illustrative risk class of the casualty (design target, verified per run). */
  intendedCasualtyRisk: 'LOW' | 'MODERATE' | 'HIGH';
  overrides: SimConfigOverrides;
}

export const EXPERIMENT_SCENARIOS: readonly ExperimentScenario[] = [
  {
    id: 'LOW',
    description: 'Weak source (50 µSv/h at 1 m); stable casualty (HR ≈ 75 /min, RR ≈ 15 /min → true class LOW).',
    intendedCasualtyRisk: 'LOW',
    overrides: {
      radiation: { sourceStrength_uSv_h_at_1m: 50 },
      casualty: { hr: { base: 75, slope_per_s: 0 }, rr: { base: 15, slope_per_s: 0 } },
    },
  },
  {
    id: 'MEDIUM',
    description: 'Default source (500 µSv/h at 1 m); casualty HR ≈ 98 /min, RR ≈ 22.5 /min → true class MODERATE.',
    intendedCasualtyRisk: 'MODERATE',
    overrides: {
      radiation: { sourceStrength_uSv_h_at_1m: 500 },
      casualty: { hr: { base: 98, slope_per_s: 0 }, rr: { base: 22.5, slope_per_s: 0 } },
    },
  },
  {
    id: 'HIGH',
    description: 'Strong source (5000 µSv/h at 1 m); casualty HR ≈ 120 /min, RR ≈ 27 /min → true class HIGH.',
    intendedCasualtyRisk: 'HIGH',
    overrides: {
      radiation: { sourceStrength_uSv_h_at_1m: 5000 },
      casualty: { hr: { base: 120, slope_per_s: 0 }, rr: { base: 27, slope_per_s: 0 } },
    },
  },
];

/** Analysis-ready per-run columns (one row per scenario × seed, failed runs included). */
export const RUN_SUMMARY_COLUMNS = [
  'scenario', 'seed', 'run_id', 'sim_version', 'run_status', 'error', 'final_phase', 'mission_duration_s',
  'intended_casualty_risk', 'truth_risk_initial', 'measured_risk_initial', 'risk_agreement_initial', 'truth_risk_latest', 'measured_risk_latest', 'risk_agreement_latest',
  'rad_samples', 'rad_sample_mae_uSv_h', 'rad_sample_rmse_uSv_h', 'rad_peak_sample_uSv_h',
  'map_gs_cells', 'map_gs_mae_uSv_h', 'map_gs_rmse_uSv_h', 'map_gs_bias_uSv_h', 'map_gs_median_rel_error', 'map_gs_spearman',
  'map_gs_peak_cell_uSv_h', 'map_gs_peak_truth_uSv_h', 'map_gs_peak_rel_bias', 'map_gs_hotspot_error_m', 'map_gs_alert_sensitivity', 'map_gs_alert_specificity',
  'map_gs_smooth_rmse_uSv_h', 'map_gs_smooth_peak_rel_bias', 'map_gs_smooth_hotspot_error_m',
  'map_onboard_rmse_uSv_h', 'map_onboard_hotspot_error_m',
  'coverage_onboard_reachable', 'coverage_gs_reachable', 'survey_duration_s',
  'detection_delay_from_release_s', 'detection_delay_from_in_range_s', 'assessment_delay_s', 'location_error_m',
  'hr_mae_bpm', 'rr_mae_brpm', 'temp_samples', 'skin_temp_mae_c', 'skin_temp_rmse_c', 'skin_temp_bias_c', 'gs_temp_status', 'gs_last_skin_temp_c',
  'comms_sent', 'comms_delivered', 'comms_delivery_ratio', 'comms_latency_mean_ms', 'comms_latency_p95_ms', 'comms_via_relay', 'bee01_delivery_ratio', 'bee02_delivery_ratio', 'link_lost_events',
  'bees_docked', 'bees_not_recovered', 'recovery_duration_s', 'landing_on_pad', 'landing_horizontal_error_m',
  'rescue_status', 'rescue_length_m', 'rescue_walk_time_s', 'rescue_measured_fraction', 'rescue_dose_estimate_uSv', 'rescue_dose_is_lower_bound',
  'rescue_true_dose_1m_uSv', 'rescue_true_dose_survey_alt_uSv', 'rescue_estimate_over_true_1m',
  'min_bee_bee_separation_m', 'bee01_min_obstacle_clearance_m',
  // v0.7.0 (appended; every column above keeps its v0.6.0 definition) — docs/EXPERIMENTS.md §v0.7.0 columns
  'rescue_dose_measured_uSv', 'rescue_dose_measured_sigma_uSv', 'rescue_dose_conservative_uSv', 'rescue_conservative_over_true_1m',
  'rescue_truth_in_measured_to_conservative', 'rescue_max_measured_rate_uSv_h', 'rescue_data_check', 'rescue_rate_check', 'rescue_unverified_reason',
  'rescue_destination_measured_rate_uSv_h', 'rescue_destination_above_threshold',
  'measured_risk_latest_reported', 'risk_agreement_latest_reported', 'risk_windows', 'risk_raw_changes', 'risk_reported_changes', 'risk_truth_changes',
  'risk_window_agreement_raw', 'risk_window_agreement_reported', 'risk_borderline_fraction', 'risk_truth_high_windows',
  'risk_high_underreport_fraction_raw', 'risk_high_underreport_fraction_reported', 'risk_high_onsets',
  'risk_max_high_escalation_delay_raw_s', 'risk_max_high_escalation_delay_reported_s', 'risk_high_onsets_never_escalated_reported',
] as const;
export type RunSummaryRow = Record<(typeof RUN_SUMMARY_COLUMNS)[number], string | number | boolean | null>;

export interface RunResult {
  scenario: ExperimentScenario['id'];
  seed: number;
  runId: string | null;
  /** OK = the engine ran to its end state (the MISSION outcome is in final_phase, e.g. COMPLETE / INCOMPLETE / TIMEOUT); ERROR = exception. */
  status: 'OK' | 'ERROR';
  error: string | null;
  /** Dataset files keyed by relative path (empty on ERROR). */
  files: Record<string, string>;
  metrics: unknown;
  row: RunSummaryRow;
}

/** Deep merge of plain override objects (b wins). */
function merge<T>(a: T, b: unknown): T {
  if (b === undefined) return a;
  if (typeof a !== 'object' || a === null || Array.isArray(a) || typeof b !== 'object' || b === null || Array.isArray(b)) return b as T;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge(out[k], v);
  return out as T;
}

export function scenarioConfig(sc: ExperimentScenario, seed: number, extra: SimConfigOverrides = {}): SimConfigOverrides {
  return merge(merge<SimConfigOverrides>({}, sc.overrides), { ...extra, seed });
}

const rnd = (v: unknown, d = 4): number | null => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Run one scenario × seed headless (no operator actions). Never throws: exceptions become an ERROR row. */
export function runOne(
  sc: ExperimentScenario,
  seed: number,
  opts: { fullJson?: boolean; extra?: SimConfigOverrides; maxSteps?: number; engineFactory?: (cfg: SimConfigOverrides) => SimEngine } = {},
): RunResult {
  const base: RunSummaryRow = Object.fromEntries(RUN_SUMMARY_COLUMNS.map((c) => [c, null])) as RunSummaryRow;
  base.scenario = sc.id;
  base.seed = seed;
  base.sim_version = SIM_VERSION;
  base.intended_casualty_risk = sc.intendedCasualtyRisk;
  try {
    const cfg = scenarioConfig(sc, seed, opts.extra);
    const engine = opts.engineFactory ? opts.engineFactory(cfg) : new SimEngine(cfg);
    engine.runToCompletion(opts.maxSteps);
    const all = datasetFiles(engine);
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      const rel = k.split('/').slice(1).join('/');
      if (!opts.fullJson && rel === 'dataset_full.json') continue;
      files[rel] = v;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = computeSummary(engine) as any;
    const s = engine.state;
    const rq = m.radiation.map_quality;
    const ca = m.casualty;
    const rr = m.rescue_route;
    const pv = patientViews(s, engine.config)[0];
    const row: RunSummaryRow = {
      ...base,
      run_id: engine.runId,
      run_status: 'OK',
      final_phase: s.mission.phase,
      mission_duration_s: m.mission_duration_s,
      truth_risk_initial: ca.initial_assessment_truth_same_window?.risk ?? null,
      measured_risk_initial: ca.initial_assessment_measured?.risk ?? null,
      risk_agreement_initial: ca.risk_class_agreement_initial,
      truth_risk_latest: ca.latest_assessment_truth_same_window?.risk ?? null,
      measured_risk_latest: ca.latest_assessment_measured?.risk ?? null,
      risk_agreement_latest: ca.risk_class_agreement_latest,
      rad_samples: m.radiation.samples,
      rad_sample_mae_uSv_h: m.radiation.error_vs_window_mean_truth_uSv_h.mae,
      rad_sample_rmse_uSv_h: m.radiation.error_vs_window_mean_truth_uSv_h.rmse,
      rad_peak_sample_uSv_h: m.radiation.peak_measured_uSv_h,
      map_gs_cells: rq.gs_received.raw.cells_measured,
      map_gs_mae_uSv_h: rq.gs_received.raw.mae_uSv_h,
      map_gs_rmse_uSv_h: rq.gs_received.raw.rmse_uSv_h,
      map_gs_bias_uSv_h: rq.gs_received.raw.bias_uSv_h,
      map_gs_median_rel_error: rq.gs_received.raw.median_rel_error,
      map_gs_spearman: rq.gs_received.raw.spearman_rho,
      map_gs_peak_cell_uSv_h: rq.gs_received.raw.peak_cell_value_uSv_h,
      map_gs_peak_truth_uSv_h: rq.gs_received.raw.peak_cell_truth_uSv_h,
      map_gs_peak_rel_bias: rq.gs_received.raw.peak_rel_bias,
      map_gs_hotspot_error_m: rq.gs_received.raw.hotspot_localisation_error_m,
      map_gs_alert_sensitivity: rq.gs_received.raw.alert_sensitivity,
      map_gs_alert_specificity: rq.gs_received.raw.alert_specificity,
      map_gs_smooth_rmse_uSv_h: rq.gs_received.smoothed.rmse_uSv_h,
      map_gs_smooth_peak_rel_bias: rq.gs_received.smoothed.peak_rel_bias,
      map_gs_smooth_hotspot_error_m: rq.gs_received.smoothed.hotspot_localisation_error_m,
      map_onboard_rmse_uSv_h: rq.onboard.raw.rmse_uSv_h,
      map_onboard_hotspot_error_m: rq.onboard.raw.hotspot_localisation_error_m,
      coverage_onboard_reachable: m.survey.coverage_onboard?.coverage_reachable ?? null,
      coverage_gs_reachable: m.survey.coverage_gs_received?.coverage_reachable ?? null,
      survey_duration_s: m.survey.survey_duration_s ?? null,
      detection_delay_from_release_s: ca.detection_delay_from_release_s,
      detection_delay_from_in_range_s: ca.detection_delay_from_in_range_s,
      assessment_delay_s: ca.assessment_delay_from_detection_s,
      location_error_m: ca.location_estimate?.error_vs_truth_m ?? null,
      hr_mae_bpm: ca.hr_error_bpm.mae,
      rr_mae_brpm: ca.rr_error_brpm.mae,
      temp_samples: ca.temperature_samples,
      skin_temp_mae_c: ca.skin_temperature_error_c.mae,
      skin_temp_rmse_c: ca.skin_temperature_error_c.rmse,
      skin_temp_bias_c: ca.skin_temperature_error_c.bias,
      gs_temp_status: pv ? pv.temperature.status : 'NO_PATIENT',
      gs_last_skin_temp_c: pv && pv.temperature.skin_c !== null ? Number(pv.temperature.skin_c.toFixed(3)) : null,
      comms_sent: m.comms.sent,
      comms_delivered: m.comms.delivered,
      comms_delivery_ratio: m.comms.delivery_ratio,
      comms_latency_mean_ms: m.comms.latency_mean_ms,
      comms_latency_p95_ms: m.comms.latency_p95_ms,
      comms_via_relay: m.comms.delivered_via_relay,
      bee01_delivery_ratio: m.comms.per_source['BEE-01'].deliveryRatio,
      bee02_delivery_ratio: m.comms.per_source['BEE-02'].deliveryRatio,
      link_lost_events: m.comms.link_lost_events,
      bees_docked: m.mission.recovery ? m.mission.recovery.docked.length : null,
      bees_not_recovered: m.mission.recovery ? m.mission.recovery.not_recovered.length : null,
      recovery_duration_s: m.mission.recovery?.duration_s ?? null,
      landing_on_pad: m.mission.landing?.on_pad ?? null,
      landing_horizontal_error_m: m.mission.landing?.horizontal_error_m ?? null,
      rescue_status: rr.status ?? null,
      rescue_length_m: rr.length_m ?? null,
      rescue_walk_time_s: rr.walk_time_s ?? null,
      rescue_measured_fraction: rr.measured_fraction ?? null,
      rescue_dose_estimate_uSv: rr.dose_estimate_uSv ?? null,
      rescue_dose_is_lower_bound: rr.dose_estimate_is_lower_bound ?? null,
      rescue_true_dose_1m_uSv: rr.true_dose_1m_uSv ?? null,
      rescue_true_dose_survey_alt_uSv: rr.true_dose_survey_alt_uSv ?? null,
      rescue_estimate_over_true_1m: num(rr.dose_estimate_uSv) !== null && num(rr.true_dose_1m_uSv) ? Number((rr.dose_estimate_uSv / rr.true_dose_1m_uSv).toFixed(4)) : null,
      min_bee_bee_separation_m: m.survey.min_bee_bee_separation_m ?? null,
      bee01_min_obstacle_clearance_m: m.survey.bee01_min_obstacle_clearance_m ?? null,
      rescue_dose_measured_uSv: rr.dose_measured_uSv ?? null,
      rescue_dose_measured_sigma_uSv: rr.dose_measured_sigma_uSv ?? null,
      rescue_dose_conservative_uSv: rr.dose_conservative_uSv ?? null,
      rescue_conservative_over_true_1m: num(rr.dose_conservative_uSv) !== null && num(rr.true_dose_1m_uSv) ? Number((rr.dose_conservative_uSv / rr.true_dose_1m_uSv).toFixed(4)) : null,
      // is the TRUE 1 m dose inside [measured-only dose, conservative estimate]? (evaluation only)
      rescue_truth_in_measured_to_conservative:
        num(rr.dose_conservative_uSv) !== null && num(rr.dose_measured_uSv) !== null && num(rr.true_dose_1m_uSv) !== null
          ? rr.true_dose_1m_uSv >= rr.dose_measured_uSv && rr.true_dose_1m_uSv <= rr.dose_conservative_uSv
          : null,
      rescue_max_measured_rate_uSv_h: rr.max_measured_rate_uSv_h ?? null,
      rescue_data_check: rr.data_check ?? null,
      rescue_rate_check: rr.rate_check ?? null,
      rescue_unverified_reason: rr.unverified_reason ?? null,
      rescue_destination_measured_rate_uSv_h: rr.destination_measured_rate_uSv_h ?? null,
      rescue_destination_above_threshold: rr.destination_above_threshold ?? null,
      measured_risk_latest_reported: ca.risk_reported_latest ?? null,
      risk_agreement_latest_reported: ca.risk_class_agreement_latest_reported ?? null,
      risk_windows: ca.risk_stability.windows,
      risk_raw_changes: ca.risk_stability.raw_changes,
      risk_reported_changes: ca.risk_stability.reported_changes,
      risk_truth_changes: ca.risk_stability.truth_changes,
      risk_window_agreement_raw: rnd(ca.risk_stability.window_agreement_raw),
      risk_window_agreement_reported: rnd(ca.risk_stability.window_agreement_reported),
      risk_borderline_fraction: rnd(ca.risk_stability.borderline_fraction),
      risk_truth_high_windows: ca.risk_stability.truth_high_windows,
      risk_high_underreport_fraction_raw: rnd(ca.risk_stability.high_underreport_fraction_raw),
      risk_high_underreport_fraction_reported: rnd(ca.risk_stability.high_underreport_fraction_reported),
      risk_high_onsets: ca.risk_stability.high_onsets,
      risk_max_high_escalation_delay_raw_s: rnd(ca.risk_stability.max_high_escalation_delay_raw_s),
      risk_max_high_escalation_delay_reported_s: rnd(ca.risk_stability.max_high_escalation_delay_reported_s),
      risk_high_onsets_never_escalated_reported: ca.risk_stability.high_onsets_never_escalated_reported,
    };
    return { scenario: sc.id, seed, runId: engine.runId, status: 'OK', error: null, files, metrics: m, row };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { scenario: sc.id, seed, runId: null, status: 'ERROR', error: msg, files: {}, metrics: null, row: { ...base, run_status: 'ERROR', error: msg } };
  }
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function rowsToCsv(cols: readonly string[], rows: Record<string, unknown>[]): string {
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

export const SCENARIO_SUMMARY_COLUMNS = ['scenario', 'metric', 'n_runs', 'n_values', 'mean', 'sd', 'median', 'min', 'max', 'ci95_half_width'] as const;

/**
 * Per-scenario descriptive statistics of every numeric column, over the runs that HAVE a value
 * (n_values ≤ n_runs is reported, never hidden). SD = sample SD (n − 1); CI = t(0.975, n−1)·SD/√n.
 * Plus categorical counts (final_phase, run_status, rescue_status, risk agreement) as metric "count:<col>=<value>".
 */
export function scenarioSummary(rows: RunSummaryRow[]): Record<string, unknown>[] {
  const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
  const out: Record<string, unknown>[] = [];
  const scenarios = [...new Set(rows.map((r) => String(r.scenario)))];
  const numericCols = RUN_SUMMARY_COLUMNS.filter((c) => c !== 'seed' && rows.some((r) => typeof r[c] === 'number'));
  const catCols = ['run_status', 'final_phase', 'rescue_status', 'risk_agreement_initial', 'risk_agreement_latest', 'measured_risk_latest', 'truth_risk_latest', 'gs_temp_status', 'landing_on_pad',
    'measured_risk_latest_reported', 'risk_agreement_latest_reported',
    'rescue_truth_in_measured_to_conservative', 'rescue_data_check', 'rescue_rate_check', 'rescue_unverified_reason', 'rescue_destination_above_threshold'] as const;
  const f = (v: number) => Number(v.toPrecision(6));
  for (const sc of scenarios) {
    const rs = rows.filter((r) => String(r.scenario) === sc);
    for (const c of numericCols) {
      const v = rs.map((r) => r[c]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
      const n = v.length;
      if (!n) {
        out.push({ scenario: sc, metric: c, n_runs: rs.length, n_values: 0, mean: null, sd: null, median: null, min: null, max: null, ci95_half_width: null });
        continue;
      }
      const mean = v.reduce((a, b) => a + b, 0) / n;
      const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
      const sorted = [...v].sort((a, b) => a - b);
      const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      const t = n - 1 < T975.length ? T975[n - 1] : 1.96;
      out.push({ scenario: sc, metric: c, n_runs: rs.length, n_values: n, mean: f(mean), sd: sd === null ? null : f(sd), median: f(median), min: f(sorted[0]), max: f(sorted[n - 1]), ci95_half_width: sd === null ? null : f((t * sd) / Math.sqrt(n)) });
    }
    for (const c of catCols) {
      const counts = new Map<string, number>();
      for (const r of rs) counts.set(String(r[c] ?? 'null'), (counts.get(String(r[c] ?? 'null')) ?? 0) + 1);
      for (const [k, n] of [...counts].sort()) out.push({ scenario: sc, metric: `count:${c}=${k}`, n_runs: rs.length, n_values: n, mean: null, sd: null, median: null, min: null, max: null, ci95_half_width: null });
    }
  }
  return out;
}
