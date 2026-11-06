import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SimEngine, WORLD, classifyRisk, hrScore, rrScore } from '../src/sim';
import { completedRun, eventsOf } from './helpers';

const C = DEFAULT_CONFIG.casualty;

describe('illustrative risk rules (not clinical)', () => {
  it('HR bands', () => {
    const cases: [number, number][] = [[40, 3], [41, 1], [50, 1], [51, 0], [90, 0], [91, 1], [110, 1], [111, 2], [130, 2], [131, 3]];
    for (const [hr, sc] of cases) expect(hrScore(hr)).toBe(sc);
  });
  it('RR bands', () => {
    const cases: [number, number][] = [[8, 3], [9, 1], [11, 1], [12, 0], [20, 0], [21, 2], [24, 2], [25, 3]];
    for (const [rr, sc] of cases) expect(rrScore(rr)).toBe(sc);
  });
  it('class rule: any 3 or total ≥ 5 → HIGH; 3–4 → MODERATE; else LOW', () => {
    expect(classifyRisk(75, 16).risk).toBe('LOW');
    expect(classifyRisk(100, 16).risk).toBe('LOW');
    expect(classifyRisk(115, 16).risk).toBe('LOW');
    expect(classifyRisk(100, 22).risk).toBe('MODERATE');
    expect(classifyRisk(115, 22).risk).toBe('MODERATE');
    expect(classifyRisk(75, 26).risk).toBe('HIGH');
    expect(classifyRisk(135, 16).risk).toBe('HIGH');
  });
});

describe('BEE-02 casualty detection and assessment', () => {
  const { engine, state } = completedRun();
  const c = state.casualty;
  const bee02 = state.bees.find((b) => b.id === 'BEE-02')!;

  it('scenario has exactly one casualty', () => {
    expect(WORLD.casualty.id).toBe(c.id);
    expect(eventsOf(state, 'CASUALTY_DETECTED')).toHaveLength(1);
  });

  it('detection happens only within detection range, after release and after first being in range', () => {
    expect(c.detectionTime).not.toBe(null);
    expect(c.detectionDistance_m as number).toBeLessThan(C.detection.range_m + 1e-9);
    expect(c.detectionTime as number).toBeGreaterThan(bee02.releaseTime as number);
    expect(c.detectionTime as number).toBeGreaterThanOrEqual(c.firstInRangeTime as number);
  });

  it('records detection and assessment delays consistently', () => {
    expect(Math.abs((c.detectionDelayFromRelease_s as number) - ((c.detectionTime as number) - (bee02.releaseTime as number)))).toBeLessThan(1e-9);
    expect(Math.abs((c.detectionDelayFromInRange_s as number) - ((c.detectionTime as number) - (c.firstInRangeTime as number)))).toBeLessThan(1e-9);
    expect(Math.abs((c.assessmentDelay_s as number) - ((c.assessmentTime as number) - (c.detectionTime as number)))).toBeLessThan(1e-9);
    expect(c.assessmentDelay_s as number).toBeGreaterThanOrEqual((C.vitals.samplesForAssessment - 1) * C.vitals.sampleInterval_s - 1e-9);
  });

  it('no detection when the casualty is out of range (range = 0.5 m)', () => {
    const s = new SimEngine({ casualty: { detection: { range_m: 0.5 } } }).runToCompletion();
    expect(s.casualty.detectionTime).toBe(null);
    expect(s.casualty.measurements).toHaveLength(0);
    expect(s.casualty.status).toBe('ASSESSMENT_TIMEOUT');
  });

  it('vitals are only measured after detection, within range and while slow', () => {
    expect(c.measurements.length).toBeGreaterThanOrEqual(C.vitals.samplesForAssessment);
    for (const m of c.measurements) {
      expect(m.time).toBeGreaterThanOrEqual(c.detectionTime as number);
      expect(m.distance_m).toBeLessThan(C.vitals.range_m + 1e-9);
      expect(m.beeSpeed_mps).toBeLessThan(C.vitals.maxBeeSpeed_mps + 1e-9);
    }
  });

  it('truth and measurements are stored separately and joinable on step', () => {
    const truth = new Map(c.truthTimeline.map((t) => [t.step, t]));
    let differs = 0;
    for (const m of c.measurements) {
      const t = truth.get(m.step);
      expect(t === undefined).toBe(false);
      if (Math.abs(m.hr_measured - (t as { hr_true: number }).hr_true) > 1e-6) differs++;
      expect('hr_true' in m).toBe(false);
    }
    expect(differs).toBe(c.measurements.length);
  });

  it('truth timeline covers the whole mission at 1 Hz and is independent of sensing', () => {
    expect(c.truthTimeline[0].time).toBe(0);
    for (let i = 1; i < c.truthTimeline.length; i++) {
      expect(Math.abs(c.truthTimeline[i].time - c.truthTimeline[i - 1].time - C.truthInterval_s)).toBeLessThan(1e-9);
    }
    // turning detection off must not change the ground-truth physiology
    const s2 = new SimEngine({ casualty: { detection: { range_m: 0.5 } } }).runToCompletion();
    const n = Math.min(c.truthTimeline.length, s2.casualty.truthTimeline.length);
    for (let i = 0; i < n; i++) expect(s2.casualty.truthTimeline[i].hr_true).toBe(c.truthTimeline[i].hr_true);
  });

  it('assessment classifies the mean of the first N measured samples', () => {
    const N = C.vitals.samplesForAssessment;
    const first = c.measurements.slice(0, N);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const expected = classifyRisk(mean(first.map((m) => m.hr_measured)), mean(first.map((m) => m.rr_measured)));
    expect(c.initialAssessment).toEqual(expected);
    expect(eventsOf(state, 'ASSESSMENT_COMPLETE', 'BEE-02')).toHaveLength(1);
    void engine;
  });
});
