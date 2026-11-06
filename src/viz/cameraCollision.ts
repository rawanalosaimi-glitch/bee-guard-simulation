import { obstacleProximity } from '../sim';
import type { Obstacle } from '../sim';

/**
 * Pure camera-collision helpers (no Three.js), so they can be unit-tested.
 * Points are mutated in place.
 */
export interface P3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Keep `cam` at least `margin` metres away from every obstacle footprint below
 * its roof: move horizontally out of the footprint, or lift above the roof,
 * whichever is the smaller displacement.
 */
export function pushOutOfObstacles(cam: P3, obstacles: readonly Obstacle[], margin: number): void {
  for (const o of obstacles) {
    const top = o.height + margin;
    if (cam.y >= top) continue;
    const p = obstacleProximity(o, cam.x, cam.z);
    if (!p.inside && p.distance >= margin) continue;
    let escape: number;
    if (p.inside) {
      if (o.shape === 'cylinder') escape = o.radius - Math.hypot(cam.x - o.cx, cam.z - o.cz) + margin;
      else escape = Math.min(o.hx - Math.abs(cam.x - o.cx), o.hz - Math.abs(cam.z - o.cz)) + margin;
    } else {
      escape = margin - p.distance;
    }
    const lift = top - cam.y;
    if (lift < escape) cam.y = top;
    else {
      cam.x += p.nx * escape;
      cam.z += p.nz * escape;
    }
  }
}

/** Keep `cam` outside a sphere of radius r centred at c. */
export function pushOutOfSphere(cam: P3, c: P3, r: number): void {
  const dx = cam.x - c.x;
  const dy = cam.y - c.y;
  const dz = cam.z - c.z;
  const d = Math.hypot(dx, dy, dz);
  if (d >= r) return;
  if (d < 1e-6) {
    cam.y = c.y + r;
    return;
  }
  const f = r / d;
  cam.x = c.x + dx * f;
  cam.y = c.y + dy * f;
  cam.z = c.z + dz * f;
}
