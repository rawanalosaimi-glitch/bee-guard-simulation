/**
 * Stage 4 — layout of the decorative emergency-response props (pure data; unit-tested against the
 * simulation geometry in tests/visualStage4.test.ts). PRESENTATION ONLY: none of these is an obstacle
 * in the simulation, so each must stay clear of everything the simulation uses:
 *   - outside every WORLD obstacle footprint (+1 m),
 *   - ≥ 15 m (horizontal) from the casualty,
 *   - clear of the landing pad (+4 m),
 *   - ≥ 3 m from the recommended rescue route and from the casualty → CCP evacuation corridor,
 *   - top ≤ 5.2 m (below the lowest flight altitude in the model, 8 m).
 * Footprints are axis-aligned bounding boxes of the rotated prop, in world metres.
 */
export interface PropPlacement {
  id: string;
  kind: 'fire_truck' | 'ambulance' | 'hazmat_van' | 'tent' | 'barrier' | 'container' | 'pipe_rack';
  x: number;
  z: number;
  /** Rotation about +y, rad. */
  rotY: number;
  /** Local half-extents (x = width/2, z = length/2) and height, m. */
  hx: number;
  hz: number;
  height: number;
  /** Only in Balanced / High. */
  rich?: boolean;
}

export const PROPS: readonly PropPlacement[] = [
  { id: 'FIRE-1', kind: 'fire_truck', x: -38, z: 68, rotY: Math.PI / 2, hx: 1.3, hz: 4.3, height: 3.3 },
  { id: 'EMS-1', kind: 'ambulance', x: -68, z: 43, rotY: 1.15, hx: 1.1, hz: 3.0, height: 2.8 },
  { id: 'EMS-2', kind: 'ambulance', x: -61, z: 38, rotY: 1.4, hx: 1.1, hz: 3.0, height: 2.8, rich: true },
  { id: 'CBRN-1', kind: 'hazmat_van', x: -21, z: 63, rotY: Math.PI / 2 + 0.3, hx: 1.1, hz: 3.0, height: 4.6 },
  // decon tent (local z ∈ [−3, 11.3] incl. the wash pools in front of it)
  { id: 'DECON-1', kind: 'tent', x: -30, z: 64, rotY: Math.PI, hx: 2.1, hz: 7.2, height: 3.0 },
  // barrier lines: centre, direction, half-length (hz); tape and cones 1.6 m to the side (hx covers them)
  { id: 'CORDON-W', kind: 'barrier', x: -39, z: 57, rotY: Math.PI / 2, hx: 1.9, hz: 5.0, height: 1.0 },
  { id: 'CORDON-E', kind: 'barrier', x: -9, z: 50, rotY: Math.PI / 2, hx: 1.9, hz: 5.0, height: 1.0, rich: false },
  { id: 'CONT-1', kind: 'container', x: 50, z: -47, rotY: 0, hx: 3.03, hz: 1.22, height: 5.2 },
  { id: 'CONT-2', kind: 'container', x: 50, z: -44.2, rotY: 0, hx: 3.03, hz: 1.22, height: 2.6 },
  { id: 'CONT-3', kind: 'container', x: 57, z: -47, rotY: Math.PI / 2, hx: 3.03, hz: 1.22, height: 2.6, rich: true },
  { id: 'CONT-4', kind: 'container', x: 57, z: -40, rotY: Math.PI / 2, hx: 3.03, hz: 1.22, height: 2.6, rich: true },
  { id: 'RACK-1', kind: 'pipe_rack', x: 28.5, z: 0, rotY: 0, hx: 1.0, hz: 5.0, height: 4.7 },
];

/** World-space axis-aligned box of a placement: [x0, z0, x1, z1]. */
export function propAabb(p: PropPlacement): [number, number, number, number] {
  const c = Math.abs(Math.cos(p.rotY));
  const s = Math.abs(Math.sin(p.rotY));
  const ex = p.hx * c + p.hz * s;
  const ez = p.hx * s + p.hz * c;
  // local origin of the tent and the cordons is at one end: shift the centre along the local z axis
  const off = p.kind === 'tent' ? 4.15 : 0;
  const cx = p.x + Math.sin(p.rotY) * off;
  const cz = p.z + Math.cos(p.rotY) * off;
  return [cx - ex, cz - ez, cx + ex, cz + ez];
}
