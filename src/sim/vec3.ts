/**
 * Minimal, allocation-light 3D vector helpers for the simulation engine.
 * The engine deliberately does NOT depend on Three.js so it can run in Node
 * (tests, batch runs) and later be ported or mirrored in Python.
 *
 * World frame (shared with the 3D view): right-handed, metres.
 *   x = east, y = up (altitude above flat ground), z = south.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const copyInto = (out: Vec3, a: Vec3): Vec3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const lenXZ = (a: Vec3): number => Math.hypot(a.x, a.z);
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Limit vector length to `max` (returns a new vector). */
export const clampLen = (a: Vec3, max: number): Vec3 => {
  const l = len(a);
  return l > max && l > 0 ? scale(a, max / l) : clone(a);
};

/** Move `current` toward `target` by at most `maxDelta` (vector rate limiter). */
export const approach = (current: Vec3, target: Vec3, maxDelta: number): Vec3 => {
  const d = sub(target, current);
  const l = len(d);
  if (l <= maxDelta || l === 0) return clone(target);
  return add(current, scale(d, maxDelta / l));
};

export const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};
