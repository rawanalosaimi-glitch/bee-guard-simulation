import type { RiskClass } from './casualty';
import { RISK_RANK } from './riskStability';

type W = { time: number; raw: RiskClass; reported: RiskClass; borderline: boolean; truth: RiskClass | null };

/**
 * v0.7.0 Fix B evaluation metrics over the per-window risk timeline (TRUE class = classifyRisk of the
 * true HR/RR averaged over the same window; evaluation only).
 *  - changes of the raw, reported and true class;
 *  - window agreement with the true class (raw / reported);
 *  - HIGH under-reporting: fraction of windows whose TRUE class is HIGH but the class is lower;
 *  - escalation delay: for every onset of a true HIGH episode (truth turns HIGH from a lower class,
 *    or the first window is HIGH), the time until the raw / reported class is HIGH, s (null = never).
 */
export function riskTimelineMetrics(tl: readonly W[]) {
  const changes = (k: 'raw' | 'reported' | 'truth') => {
    let n = 0;
    for (let i = 1; i < tl.length; i++) if (tl[i][k] !== null && tl[i - 1][k] !== null && tl[i][k] !== tl[i - 1][k]) n++;
    return n;
  };
  const withTruth = tl.filter((w) => w.truth !== null);
  const agree = (k: 'raw' | 'reported') => (withTruth.length ? withTruth.filter((w) => w[k] === w.truth).length / withTruth.length : null);
  const highs = withTruth.filter((w) => w.truth === 'HIGH');
  const under = (k: 'raw' | 'reported') => (highs.length ? highs.filter((w) => RISK_RANK[w[k]] < RISK_RANK.HIGH).length / highs.length : null);
  const onsets: { time: number; rawDelay_s: number | null; reportedDelay_s: number | null }[] = [];
  for (let i = 0; i < tl.length; i++) {
    if (tl[i].truth !== 'HIGH' || (i > 0 && tl[i - 1].truth === 'HIGH')) continue;
    const t0 = tl[i].time;
    const first = (k: 'raw' | 'reported') => {
      for (let j = i; j < tl.length; j++) if (tl[j][k] === 'HIGH') return tl[j].time - t0;
      return null;
    };
    onsets.push({ time: t0, rawDelay_s: first('raw'), reportedDelay_s: first('reported') });
  }
  const maxOf = (k: 'rawDelay_s' | 'reportedDelay_s') => {
    const v = onsets.map((o) => o[k]).filter((x): x is number => x !== null);
    return v.length ? Math.max(...v) : null;
  };
  const never = (k: 'rawDelay_s' | 'reportedDelay_s') => onsets.filter((o) => o[k] === null).length;
  return {
    windows: tl.length,
    raw_changes: changes('raw'),
    reported_changes: changes('reported'),
    truth_changes: changes('truth'),
    window_agreement_raw: agree('raw'),
    window_agreement_reported: agree('reported'),
    borderline_fraction: tl.length ? tl.filter((w) => w.borderline).length / tl.length : null,
    truth_high_windows: highs.length,
    high_underreport_fraction_raw: under('raw'),
    high_underreport_fraction_reported: under('reported'),
    high_onsets: onsets.length,
    max_high_escalation_delay_raw_s: maxOf('rawDelay_s'),
    max_high_escalation_delay_reported_s: maxOf('reportedDelay_s'),
    /** onsets after which the class never reached HIGH before the end of the vitals feed */
    high_onsets_never_escalated_raw: never('rawDelay_s'),
    high_onsets_never_escalated_reported: never('reportedDelay_s'),
    high_onset_delays: onsets,
    latest_reported: tl.length ? tl[tl.length - 1].reported : null,
  };
}
