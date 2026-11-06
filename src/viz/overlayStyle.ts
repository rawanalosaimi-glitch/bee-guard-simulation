/**
 * Stage 5 — overlay de-cluttering (presentation only; pure functions, unit-tested).
 *
 * Nothing here reads or changes simulation state: the 3D overlay components pass engine data in
 * and draw less of it. Exports, the dashboard and the aerial map are unaffected.
 */

type P3 = [number, number, number];

/** Trail samples are recorded every 0.5 s (config.sampleInterval), so 60 samples ≈ the last 30 s of flight. */
export const CLEAN_TRAIL_SAMPLES = 60;

export interface TrailPiece {
  pts: P3[];
  /** 0 (oldest) … 1 (newest): used for opacity. */
  age: number;
}

/**
 * Split the tail of a trail into `pieces` consecutive chunks (oldest first) that share their joint
 * points, so the line is continuous while the opacity steps down toward the oldest end.
 */
export function fadingTrail(pts: P3[], maxSamples = CLEAN_TRAIL_SAMPLES, pieces = 3): TrailPiece[] {
  const tail = pts.slice(Math.max(0, pts.length - maxSamples));
  if (tail.length < 2) return [];
  const n = Math.max(1, Math.min(pieces, tail.length - 1));
  const out: TrailPiece[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * (tail.length - 1)) / n);
    const b = Math.floor(((i + 1) * (tail.length - 1)) / n);
    if (b > a) out.push({ pts: tail.slice(a, b + 1), age: n === 1 ? 1 : (i + 1) / n });
  }
  return out;
}

/**
 * The part of a planned route still to fly, limited to the next `legs` waypoints, starting at the
 * drone's current position. Empty when there is nothing ahead.
 */
export function activeLeg(position: P3, route: P3[], waypointIndex: number, legs = 2): P3[] {
  if (waypointIndex >= route.length) return [];
  const ahead = route.slice(waypointIndex, waypointIndex + legs);
  return [position, ...ahead];
}

export interface LabelBox {
  id: string;
  /** Screen-space centre, px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Higher wins. */
  priority: number;
  /** In front of the camera and inside the viewport. */
  onScreen: boolean;
}

/**
 * Greedy screen-space de-cluttering: labels are accepted in priority order and a label is hidden
 * when its box (grown by `pad` px) overlaps an already accepted one. Ties keep the input order.
 */
export function declutter(labels: LabelBox[], pad = 3): Set<string> {
  const order = labels.map((l, i) => ({ l, i })).sort((a, b) => b.l.priority - a.l.priority || a.i - b.i);
  const kept: LabelBox[] = [];
  const visible = new Set<string>();
  for (const { l } of order) {
    if (!l.onScreen) continue;
    const hit = kept.some((k) => Math.abs(k.x - l.x) * 2 < k.w + l.w + 2 * pad && Math.abs(k.y - l.y) * 2 < k.h + l.h + 2 * pad);
    if (!hit) {
      kept.push(l);
      visible.add(l.id);
    }
  }
  return visible;
}

/** Label priorities (higher = kept when labels collide). The followed drone always wins. */
export const LABEL_PRIORITY = {
  followed: 100,
  casualty: 60,
  radSource: 55,
  mother: 50,
  bee: 45,
  waypoint: 40,
  groundStation: 30,
  ccp: 25,
} as const;
