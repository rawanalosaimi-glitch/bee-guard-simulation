import { describe, expect, it } from 'vitest';
import { CLEAN_TRAIL_SAMPLES, LABEL_PRIORITY, activeLeg, declutter, fadingTrail } from '../src/viz/overlayStyle';
import type { LabelBox } from '../src/viz/overlayStyle';
import { CLOSE_UP_MODES, cameraSubject, isCloseUp } from '../src/state/cameraModes';
import { DEFAULT_CONFIG } from '../src/sim';

/** Stage 5 (presentation only) — clean overlays, label de-cluttering, close-up camera modes. */
type P3 = [number, number, number];
const line = (n: number): P3[] => Array.from({ length: n }, (_, i) => [i, 10, 0] as P3);

describe('Stage 5 — clean overlay helpers', () => {
  it('the clean trail window is the last 30 s of 0.5 s samples', () => {
    expect(DEFAULT_CONFIG.sampleInterval).toBe(0.5);
    expect(CLEAN_TRAIL_SAMPLES * DEFAULT_CONFIG.sampleInterval).toBe(30);
  });

  it('fading trail: only the tail, continuous pieces, opacity rising toward the newest end', () => {
    const pts = line(200);
    const pieces = fadingTrail(pts);
    expect(pieces.length).toBe(3);
    // starts at the first sample of the 60-sample tail and ends at the newest point
    expect(pieces[0].pts[0]).toEqual(pts[200 - CLEAN_TRAIL_SAMPLES]);
    expect(pieces[2].pts[pieces[2].pts.length - 1]).toEqual(pts[199]);
    // consecutive pieces share their joint point (no gaps)
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].pts[0]).toEqual(pieces[i - 1].pts[pieces[i - 1].pts.length - 1]);
    expect(pieces.map((p) => p.age)).toEqual([1 / 3, 2 / 3, 1]);
    // short or empty trails
    expect(fadingTrail(line(1))).toEqual([]);
    expect(fadingTrail(line(2)).length).toBe(1);
    expect(fadingTrail(line(2))[0].pts.length).toBe(2);
  });

  it('active leg: current position followed by the next waypoints only', () => {
    const route = line(10);
    const pos: P3 = [0.5, 9, 1];
    expect(activeLeg(pos, route, 3)).toEqual([pos, route[3], route[4]]);
    expect(activeLeg(pos, route, 9)).toEqual([pos, route[9]]);
    expect(activeLeg(pos, route, 10)).toEqual([]);
    expect(activeLeg(pos, route, 3, 1)).toEqual([pos, route[3]]);
  });

  it('declutter keeps the higher-priority label of an overlapping pair and every non-overlapping one', () => {
    const box = (id: string, x: number, y: number, priority: number, onScreen = true): LabelBox => ({ id, x, y, w: 80, h: 16, priority, onScreen });
    const v = declutter([
      box('bee', 100, 100, LABEL_PRIORITY.bee),
      box('mother', 120, 105, LABEL_PRIORITY.mother), // overlaps "bee", higher priority
      box('cas', 400, 300, LABEL_PRIORITY.casualty), // alone
      box('gs', 100, 140, LABEL_PRIORITY.groundStation), // 40 px below: clear of both
      box('off', 120, 100, 999, false), // off screen: never shown, never blocks
    ]);
    expect([...v].sort()).toEqual(['cas', 'gs', 'mother']);
    // the followed drone always wins
    const w = declutter([box('a', 0, 0, LABEL_PRIORITY.casualty), box('f', 5, 5, LABEL_PRIORITY.followed)]);
    expect([...w]).toEqual(['f']);
  });
});

describe('Stage 5 — close-up cameras', () => {
  it('close-up modes and their subjects', () => {
    expect([...CLOSE_UP_MODES]).toEqual(['CLOSE-MOTHER-01', 'CLOSE-BEE-01', 'CLOSE-BEE-02', 'CLOSE-BEE-03', 'TAKEOFF']);
    for (const m of CLOSE_UP_MODES) expect(isCloseUp(m)).toBe(true);
    for (const m of ['overview', 'top', 'base', 'MOTHER-01', 'BEE-01'] as const) expect(isCloseUp(m)).toBe(false);
    expect(cameraSubject('CLOSE-BEE-02')).toBe('BEE-02');
    expect(cameraSubject('CLOSE-MOTHER-01')).toBe('MOTHER-01');
    expect(cameraSubject('TAKEOFF')).toBe('MOTHER-01');
    expect(cameraSubject('BEE-03')).toBe('BEE-03');
    expect(cameraSubject('overview')).toBe(null);
  });
});
