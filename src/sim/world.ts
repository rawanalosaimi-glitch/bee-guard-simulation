import type { Vec3 } from './vec3';

/**
 * Static scenario world for Phase 1 ("P1-BASE").
 *
 * SINGLE SOURCE OF TRUTH: the 3D view draws every collidable structure from
 * this list, and the engine collides against exactly the same footprints.
 * Decorative items in the view (sand dunes, small rocks, fence posts) are
 * either outside the operations area or lower than every flight altitude.
 *
 * Ground is assumed flat (y = 0) inside the operations area.
 * All obstacles are axis-aligned boxes or vertical cylinders (2.5-D: a
 * footprint on the ground extruded to a height).
 */

export type ObstacleKind =
  | 'warehouse'
  | 'control-building'
  | 'tank'
  | 'stack'
  | 'container'
  | 'debris';

interface ObstacleBase {
  id: string;
  kind: ObstacleKind;
  label: string;
  /** Top of the obstacle above ground, metres. */
  height: number;
}

export interface BoxObstacle extends ObstacleBase {
  shape: 'box';
  /** Footprint centre (x, z) in metres. */
  cx: number;
  cz: number;
  /** Half-extents along x and z, metres. */
  hx: number;
  hz: number;
}

export interface CylinderObstacle extends ObstacleBase {
  shape: 'cylinder';
  cx: number;
  cz: number;
  radius: number;
}

export type Obstacle = BoxObstacle | CylinderObstacle;

export interface PointFeature {
  id: string;
  label: string;
  position: Vec3;
}

export interface WorldDefinition {
  scenarioId: string;
  /** Half-size of the flat operations area (square, centred on origin), metres. */
  opsAreaHalfSize: number;
  obstacles: Obstacle[];
  radiationSource: PointFeature;
  casualty: PointFeature & { headingRad: number };
  groundStation: PointFeature;
}

export const WORLD: WorldDefinition = {
  scenarioId: 'P1-BASE',
  opsAreaHalfSize: 110,
  obstacles: [
    { id: 'OBS-WH-A', kind: 'warehouse', label: 'Warehouse A (damaged)', shape: 'box', cx: 10, cz: -10, hx: 14, hz: 9, height: 12 },
    { id: 'OBS-CTRL', kind: 'control-building', label: 'Control building', shape: 'box', cx: -25, cz: -22, hx: 8, hz: 6, height: 9 },
    { id: 'OBS-TK-1', kind: 'tank', label: 'Storage tank 1', shape: 'cylinder', cx: 36, cz: 14, radius: 6, height: 14 },
    { id: 'OBS-TK-2', kind: 'tank', label: 'Storage tank 2', shape: 'cylinder', cx: 36, cz: 32, radius: 6, height: 14 },
    { id: 'OBS-TK-3', kind: 'tank', label: 'Storage tank 3', shape: 'cylinder', cx: 52, cz: 23, radius: 5, height: 11 },
    { id: 'OBS-STACK', kind: 'stack', label: 'Exhaust stack', shape: 'cylinder', cx: -5, cz: -42, radius: 2.2, height: 38 },
    { id: 'OBS-CONT', kind: 'container', label: 'Breached container', shape: 'box', cx: 18, cz: 23, hx: 3, hz: 1.25, height: 2.6 },
    { id: 'OBS-DEB-1', kind: 'debris', label: 'Debris pile 1', shape: 'cylinder', cx: 2, cz: 6, radius: 3, height: 3 },
    { id: 'OBS-DEB-2', kind: 'debris', label: 'Debris pile 2', shape: 'box', cx: -30, cz: 4, hx: 3, hz: 2, height: 2.5 },
  ],
  radiationSource: {
    id: 'RAD-SRC-1',
    label: 'Radiation source (location only — field model is Phase 2)',
    position: { x: 18, y: 1.3, z: 21.3 },
  },
  casualty: {
    id: 'CAS-1',
    label: 'Casualty',
    position: { x: -16, y: 0, z: 14 },
    headingRad: 0.6,
  },
  groundStation: {
    id: 'GS-1',
    label: 'Ground station',
    position: { x: -72, y: 0, z: 58 },
  },
};

export interface ObstacleProximity {
  /** Horizontal distance from point to obstacle footprint (0 if inside). */
  distance: number;
  /** Unit outward normal in the x–z plane. */
  nx: number;
  nz: number;
  inside: boolean;
}

/**
 * Horizontal (x–z) proximity of a point to an obstacle footprint.
 * Inside points get distance 0 and a normal pointing out of the nearest face.
 */
export function obstacleProximity(o: Obstacle, px: number, pz: number): ObstacleProximity {
  if (o.shape === 'cylinder') {
    const dx = px - o.cx;
    const dz = pz - o.cz;
    const r = Math.hypot(dx, dz);
    const nx = r > 1e-9 ? dx / r : 1;
    const nz = r > 1e-9 ? dz / r : 0;
    const d = r - o.radius;
    return { distance: Math.max(0, d), nx, nz, inside: d < 0 };
  }
  const lx = px - o.cx;
  const lz = pz - o.cz;
  const qx = Math.abs(lx) - o.hx;
  const qz = Math.abs(lz) - o.hz;
  if (qx <= 0 && qz <= 0) {
    // inside: push out through nearest face
    if (qx > qz) return { distance: 0, nx: Math.sign(lx) || 1, nz: 0, inside: true };
    return { distance: 0, nx: 0, nz: Math.sign(lz) || 1, inside: true };
  }
  const ox = Math.max(qx, 0) * (Math.sign(lx) || 1);
  const oz = Math.max(qz, 0) * (Math.sign(lz) || 1);
  const d = Math.hypot(ox, oz);
  return { distance: d, nx: ox / d, nz: oz / d, inside: false };
}
