import { describe, expect, it } from 'vitest';
import { WORLD, obstacleProximity } from '../src/sim';
import { pushOutOfObstacles, pushOutOfSphere } from '../src/viz/cameraCollision';

describe('camera collision helpers', () => {
  const margin = 1.5;

  it('a camera inside a building ends up outside it (or above its roof)', () => {
    for (const o of WORLD.obstacles) {
      const cam = { x: o.cx + 0.3, y: o.height * 0.5, z: o.cz - 0.2 };
      pushOutOfObstacles(cam, WORLD.obstacles, margin);
      const p = obstacleProximity(o, cam.x, cam.z);
      const clear = cam.y >= o.height + margin - 1e-9 || (!p.inside && p.distance >= margin - 1e-6);
      expect(clear).toBe(true);
    }
  });

  it('a camera above every roof is not moved', () => {
    const cam = { x: 10, y: 60, z: -10 };
    pushOutOfObstacles(cam, WORLD.obstacles, margin);
    expect(cam).toEqual({ x: 10, y: 60, z: -10 });
  });

  it('a camera inside the mother sphere is pushed to its surface', () => {
    const c = { x: 0, y: 26, z: 0 };
    const cam = { x: 1, y: 26, z: 0 };
    pushOutOfSphere(cam, c, 10);
    expect(Math.abs(Math.hypot(cam.x - c.x, cam.y - c.y, cam.z - c.z) - 10)).toBeLessThan(1e-9);
  });
});
