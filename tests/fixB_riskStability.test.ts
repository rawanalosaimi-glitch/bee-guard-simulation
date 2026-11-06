import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SimEngine, classifyRisk } from '../src/sim';
import { initialRiskTracker, riskInterval, updateRiskTracker } from '../src/sim/riskStability';
import type { RiskStabilizationConfig } from '../src/sim/riskStability';
import { riskTimelineMetrics } from '../src/sim/riskMetrics';
import { SeededRng } from '../src/sim/rng';
import { eventsOf } from './helpers';

/** v0.7.0 Fix B — stabilized risk reporting: raw class preserved, fast escalation, slow margin-based de-escalation. */
const CFG: RiskStabilizationConfig = DEFAULT_CONFIG.casualty.riskStabilization;
/** The v0.7.x option (3-window escalation), kept testable as an option. */
const CFG3: RiskStabilizationConfig = { ...CFG, escalateWindows: 3 };
// window means: HR 112 (score 2); RR picks the class: 22 → MODERATE (2+2=4), 26 → HIGH (RR score 3)
const MOD = { hr: 112, rr: 22 };
const HIGH = { hr: 112, rr: 26 };
const SEM = { hr: 0.7, rr: 0.4 };

function feed(seq: { hr: number; rr: number }[], cfg = CFG) {
  const t = initialRiskTracker();
  return { t, out: seq.map((w) => updateRiskTracker(t, w.hr, w.rr, SEM.hr, SEM.rr, cfg)) };
}

describe('Fix B — configuration', () => {
  it('defaults (0.8.0-rc1): escalate immediately (1 window), de-escalate after 10 windows beyond 1 SEM', () => {
    expect(CFG).toEqual({ enabled: true, escalateWindows: 1, deescalateWindows: 10, marginSEM: 1 });
  });
});

describe('Fix B — tracker rules', () => {
  it('the first assessment is the raw class (unchanged from v0.6.0)', () => {
    expect(feed([HIGH]).out[0].after).toBe('HIGH');
    expect(feed([MOD]).out[0].after).toBe('MODERATE');
  });

  it('the raw class is exactly the v0.6.0 rule', () => {
    const rng = new SeededRng(7);
    const t = initialRiskTracker();
    for (let i = 0; i < 500; i++) {
      const hr = 40 + 100 * rng.next();
      const rr = 5 + 25 * rng.next();
      expect(updateRiskTracker(t, hr, rr, 1, 1, CFG).raw).toBe(classifyRisk(hr, rr).risk);
    }
  });

  it('DEFAULT: escalation MODERATE → HIGH is reported at the FIRST HIGH window (never later than the raw class)', () => {
    const { out } = feed([MOD, MOD, HIGH, HIGH]);
    expect(out.map((o) => o.after)).toEqual(['MODERATE', 'MODERATE', 'HIGH', 'HIGH']);
  });

  it('DEFAULT SAFETY invariant: the reported class is never below the raw class (5 noisy sequences × 800 windows)', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const rng = new SeededRng(100 + seed);
      const seq = Array.from({ length: 800 }, () => ({ hr: 105 + 10 * rng.next(), rr: 24.5 + 1.2 * rng.gaussian() }));
      const rank = { LOW: 0, MODERATE: 1, HIGH: 2 } as const;
      for (const o of feed(seq).out) expect(rank[o.after]).toBeGreaterThanOrEqual(rank[o.raw]);
    }
  });

  it('DEFAULT: a 1-window raw blip escalates immediately and is held for the 10-window confirmed de-escalation (over-triage by design)', () => {
    const { out } = feed([MOD, HIGH, ...Array(12).fill(MOD)]);
    expect(out[1].after).toBe('HIGH');
    expect(out.slice(1, 11).every((o) => o.after === 'HIGH')).toBe(true);
    expect(out[11].after).toBe('MODERATE');
  });

  it('3-window option: escalation MODERATE → HIGH is reported at the 3rd consecutive HIGH window', () => {
    const { out } = feed([MOD, MOD, HIGH, HIGH, HIGH, HIGH], CFG3);
    expect(out.map((o) => o.after)).toEqual(['MODERATE', 'MODERATE', 'MODERATE', 'MODERATE', 'HIGH', 'HIGH']);
  });

  it('3-window option: a 1–2 window raw blip does not change the reported class', () => {
    const { out, t } = feed([MOD, HIGH, HIGH, MOD, HIGH, MOD, MOD], CFG3);
    expect(out.every((o) => o.after === 'MODERATE')).toBe(true);
    expect(t.rawChanges).toBe(4);
    expect(t.reportedChanges).toBe(0);
  });

  it('escalation is NOT held back when the mean is borderline (no margin on the way up)', () => {
    // RR 24.6 rounds to 25 → score 3 (HIGH); within 1 SEM (0.4) of the 24.5 band edge → borderline
    const edge = { hr: 112, rr: 24.6 };
    expect(riskInterval(edge.hr, edge.rr, SEM.hr, SEM.rr, 1).optimistic).toBe('MODERATE');
    const { out, t } = feed([MOD, edge, edge, edge], CFG3);
    expect(out[3].after).toBe('HIGH');
    expect(feed([MOD, edge]).out[1].after).toBe('HIGH'); // default: at once
    expect(t.borderline).toBe(true);
  });

  it('de-escalation HIGH → MODERATE needs 10 consecutive windows beyond 1 SEM', () => {
    const seq = [HIGH, ...Array(10).fill(MOD)];
    const { out } = feed(seq);
    expect(out.slice(0, 10).every((o) => o.after === 'HIGH')).toBe(true);
    expect(out[10].after).toBe('MODERATE');
  });

  it('no de-escalation while the mean stays within 1 SEM of the band edge', () => {
    // RR 24.3 → rounds to 24 → raw MODERATE, but RR + SEM = 24.7 → pessimistic HIGH
    const near = { hr: 112, rr: 24.3 };
    const { out } = feed([HIGH, ...Array(40).fill(near)]);
    expect(out[0].raw).toBe('HIGH');
    expect(out[1].raw).toBe('MODERATE');
    expect(out.every((o) => o.after === 'HIGH')).toBe(true);
  });

  it('noisy steady signal on a band edge: far fewer reported than raw changes', () => {
    const rng = new SeededRng(3);
    const seq = Array.from({ length: 800 }, () => ({ hr: 112, rr: 24.5 + 0.6 * rng.gaussian() }));
    const { t } = feed(seq);
    expect(t.rawChanges).toBeGreaterThan(100);
    expect(t.reportedChanges).toBeLessThan(t.rawChanges / 5);
  });

  it('disabled → reported = raw at every window (v0.6.0 behaviour)', () => {
    const rng = new SeededRng(5);
    const seq = Array.from({ length: 300 }, () => ({ hr: 112, rr: 24.5 + 0.6 * rng.gaussian() }));
    const { out } = feed(seq, { ...CFG, enabled: false });
    for (const o of out) expect(o.after).toBe(o.raw);
  });
});

describe('Fix B — in the simulation', () => {
  it('raw class sequence and raw change count are those of v0.6.0 (stabilization disabled); RISK_CHANGED logs the reported class', () => {
    const on = new SimEngine({ seed: 42 });
    on.runToCompletion();
    const off = new SimEngine({ seed: 42, casualty: { riskStabilization: { enabled: false } } });
    off.runToCompletion();
    const c1 = on.state.casualty;
    const c0 = off.state.casualty;
    expect(c1.riskTimeline.map((w) => w.raw)).toEqual(c0.riskTimeline.map((w) => w.raw));
    expect(c0.riskTimeline.every((w) => w.raw === w.reported)).toBe(true);
    // v0.6.0: one RISK_CHANGED per raw change (14 in seed 42, docs/SCIENTIFIC_AUDIT); v0.7.0: one per reported change
    expect(eventsOf(off.state, 'RISK_CHANGED').length).toBe(c0.riskTracker.rawChanges);
    expect(eventsOf(on.state, 'RISK_CHANGED').length).toBe(c1.riskTracker.reportedChanges);
    expect(c1.riskTracker.reportedChanges).toBeLessThan(c1.riskTracker.rawChanges);
    // the ground station shows the reported class, with the raw class alongside
    const a = on.state.comms.gs.patients[0].assessment!;
    expect(['LOW', 'MODERATE', 'HIGH']).toContain(a.risk);
    expect(['LOW', 'MODERATE', 'HIGH']).toContain(a.riskRaw as string);
    // initial assessment unchanged
    expect(c1.initialAssessment).toEqual(c0.initialAssessment);
  });

  it('SAFETY: a patient deteriorating into HIGH is reported HIGH no later than the raw class (default) — and ≤ 2 s later with the 3-window option', () => {
    const e = new SimEngine({
      seed: 11,
      casualty: { hr: { base: 112, slope_per_s: 0, amp: 0, ouSigma: 0 }, rr: { base: 21.5, slope_per_s: 0.012, amp: 0, ouSigma: 0 } },
    });
    e.runToCompletion();
    const m = riskTimelineMetrics(e.state.casualty.riskTimeline);
    expect(m.high_onsets).toBeGreaterThanOrEqual(1);
    expect(m.high_onsets_never_escalated_reported).toBe(0);
    for (const o of m.high_onset_delays) {
      expect(o.rawDelay_s).not.toBe(null);
      expect(o.reportedDelay_s as number).toBeLessThanOrEqual((o.rawDelay_s as number) + 1e-6);
    }
    const e3 = new SimEngine({
      seed: 11,
      casualty: { hr: { base: 112, slope_per_s: 0, amp: 0, ouSigma: 0 }, rr: { base: 21.5, slope_per_s: 0.012, amp: 0, ouSigma: 0 }, riskStabilization: { escalateWindows: 3 } },
    });
    e3.runToCompletion();
    for (const o of riskTimelineMetrics(e3.state.casualty.riskTimeline).high_onset_delays)
      expect(o.reportedDelay_s as number).toBeLessThanOrEqual((o.rawDelay_s as number) + 2 * DEFAULT_CONFIG.casualty.vitals.sampleInterval_s + 1e-6);
  });
});
