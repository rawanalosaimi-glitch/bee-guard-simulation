import { classifyRisk, hrScore, rrScore } from './casualty';
import type { RiskClass } from './casualty';

/**
 * v0.7.0 Fix B — STABILIZED reporting of the illustrative risk class (docs/SIMULATION_MODEL.md §42).
 *
 * The RAW class is unchanged: the v0.6.0 rule (classifyRisk on the mean of the last N vitals samples),
 * recomputed at every new sample. It is kept, exported and counted. The REPORTED class (what BEE-02
 * sends to the ground station and what the event log records) follows it with asymmetric confirmation:
 *
 *   escalation (raw class above the reported one): confirmed after `escalateWindows` consecutive
 *     windows above (default 3 → ≈ 2 s later than the raw class at 1 sample/s). No margin is required:
 *     a possible deterioration is never held back by an uncertainty test.
 *   de-escalation (raw class below): confirmed after `deescalateWindows` consecutive windows (default
 *     10 ≈ 10 s) in which the class is lower even at the PESSIMISTIC end of the window mean's ± k·SEM
 *     interval (k = marginSEM, default 1). SEM = √(mean σᵢ²) / √N from the per-sample noise model.
 *   borderline: the class at the pessimistic and optimistic ends of that interval differ — the mean is
 *     within k·SEM of a score-band edge; reported as a flag, it does not change the class.
 *
 * The first assessment is the raw class of the first full window (unchanged from v0.6.0). Escalation
 * goes to the LOWEST raw class seen during the confirming streak (the level every window supported),
 * de-escalation to the HIGHEST (conservative). Illustrative demo rule, not clinical (see classifyRisk).
 */
export interface RiskStabilizationConfig {
  enabled: boolean;
  escalateWindows: number;
  deescalateWindows: number;
  marginSEM: number;
}

export const RISK_RANK: Record<RiskClass, number> = { LOW: 0, MODERATE: 1, HIGH: 2 };

/** Highest and lowest score of a value interval (scores are evaluated on the rounded values, as in classifyRisk). */
function scoreRange(lo: number, hi: number, score: (v: number) => number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const a = Math.round(lo);
  const b = Math.round(hi);
  for (let v = a; v <= b; v++) {
    const s = score(v);
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max };
}

const classOf = (h: number, r: number): RiskClass => (h + r >= 5 || h === 3 || r === 3 ? 'HIGH' : h + r >= 3 ? 'MODERATE' : 'LOW');

/** Risk class at the pessimistic (highest) and optimistic (lowest) end of the ±k·SEM interval of the window means. */
export function riskInterval(hr: number, rr: number, hrSem: number, rrSem: number, k: number): { pessimistic: RiskClass; optimistic: RiskClass } {
  const h = scoreRange(hr - k * hrSem, hr + k * hrSem, hrScore);
  const r = scoreRange(rr - k * rrSem, rr + k * rrSem, rrScore);
  return { pessimistic: classOf(h.max, r.max), optimistic: classOf(h.min, r.min) };
}

export interface RiskTrackerState {
  reported: RiskClass | null;
  borderline: boolean;
  streakDir: 0 | 1 | -1;
  streakLen: number;
  /** min (escalation) / max (de-escalation) raw class seen during the current streak. */
  streakBound: RiskClass | null;
  rawChanges: number;
  reportedChanges: number;
  lastRaw: RiskClass | null;
  windows: number;
}

export function initialRiskTracker(): RiskTrackerState {
  return { reported: null, borderline: false, streakDir: 0, streakLen: 0, streakBound: null, rawChanges: 0, reportedChanges: 0, lastRaw: null, windows: 0 };
}

/**
 * Feed one window (mean HR / RR and their SEMs). Returns the reported class before and after.
 * Pure state update (deterministic).
 */
export function updateRiskTracker(
  t: RiskTrackerState,
  hr: number,
  rr: number,
  hrSem: number,
  rrSem: number,
  cfg: RiskStabilizationConfig,
): { raw: RiskClass; before: RiskClass | null; after: RiskClass } {
  const raw = classifyRisk(hr, rr).risk;
  const iv = riskInterval(hr, rr, hrSem, rrSem, cfg.marginSEM);
  t.windows++;
  if (t.lastRaw !== null && raw !== t.lastRaw) t.rawChanges++;
  t.lastRaw = raw;
  t.borderline = iv.pessimistic !== iv.optimistic;
  const before = t.reported;
  if (!cfg.enabled || t.reported === null) {
    t.reported = raw;
    t.streakDir = 0;
    t.streakLen = 0;
    t.streakBound = null;
  } else {
    const cur = RISK_RANK[t.reported];
    const up = RISK_RANK[raw] > cur;
    const down = RISK_RANK[raw] < cur && RISK_RANK[iv.pessimistic] < cur;
    if (up) {
      if (t.streakDir !== 1) {
        t.streakDir = 1;
        t.streakLen = 0;
        t.streakBound = raw;
      }
      t.streakLen++;
      if (RISK_RANK[raw] < RISK_RANK[t.streakBound as RiskClass]) t.streakBound = raw;
      if (t.streakLen >= cfg.escalateWindows) {
        t.reported = t.streakBound as RiskClass;
        t.streakDir = 0;
        t.streakLen = 0;
        t.streakBound = null;
      }
    } else if (down) {
      const lowered: RiskClass = RISK_RANK[raw] > RISK_RANK[iv.pessimistic] ? raw : iv.pessimistic;
      if (t.streakDir !== -1) {
        t.streakDir = -1;
        t.streakLen = 0;
        t.streakBound = lowered;
      }
      t.streakLen++;
      if (RISK_RANK[lowered] > RISK_RANK[t.streakBound as RiskClass]) t.streakBound = lowered;
      if (t.streakLen >= cfg.deescalateWindows) {
        t.reported = t.streakBound as RiskClass;
        t.streakDir = 0;
        t.streakLen = 0;
        t.streakBound = null;
      }
    } else {
      t.streakDir = 0;
      t.streakLen = 0;
      t.streakBound = null;
    }
  }
  if (before !== null && t.reported !== before) t.reportedChanges++;
  return { raw, before, after: t.reported as RiskClass };
}
