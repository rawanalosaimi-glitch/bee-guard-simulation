/**
 * Placement and surface geometry of the emblem decal on the bee drone's body sides (pure, no three.js;
 * unit-tested in tests/beeEmblem.test.ts). Presentation only.
 *
 * Bee body (BeeModel.tsx, forward = +z, up = +y, metres) — inspected, not guessed:
 *   - yellow capsule, radius 0.13, cylindrical part z −0.15…+0.15 (+ hemispherical caps)
 *   - two dark bands, radius 0.136, 0.05 m wide, at z = −0.02 (z −0.045…+0.005) and z = −0.14 (z −0.165…−0.115)
 *   - YELLOW side panels on the cylindrical part: front z +0.005…+0.15 (carries the side sensor box on
 *     the right flank: x 0.11…0.14, y −0.01…0.05, z 0.025…0.095), MIDDLE z −0.115…−0.045 (clear on
 *     both flanks), rear z −0.165…−0.15 (too short)
 *   - rotor ducts x = ±0.31, z = ±0.2, r = 0.17, y 0.025…0.095 (lower rim tube down to y ≈ 0.014); seen
 *     from the side they cover the flank above y ≈ 0.014
 *   - rotor support arms near the body at y ≈ 0.0375…0.0625; legs hang from the belly (hips at y = −0.08)
 * The emblem therefore sits on the MIDDLE YELLOW PANEL of both flanks — between the two dark bands, under
 * the duct rims, clear of the sensor box, arms, ducts and legs — flush with the yellow capsule surface
 * (radius 0.13) at a 1.2 mm stand-off, so it neither floats nor z-fights.
 */
/** Aspect (width / height) of the emblem artwork (Emblem_of_Saudi_Arabia.svg: 610 × 662.42). */
export const EMBLEM_ASPECT = 610 / 662.42;
const H = 0.0706;
export const EMBLEM = {
  /** Centre along the body axis, m: middle of the yellow panel between the dark bands (z −0.115…−0.045). */
  zCenter: -0.08,
  /** Width along the body (image horizontal), m — artwork aspect, ≥ 2.5 mm clear of each band edge. */
  width: H * EMBLEM_ASPECT,
  /** Height around the body (image vertical, measured along the surface), m. */
  height: H,
  /** Centre of the decal around the body, rad (negative = below the equator): top edge at y ≈ 0.008, under the duct rims. */
  angleCenter: -0.208,
  /** Stand-off above the surface, m. */
  offset: 0.0012,
} as const;

const BODY_R = 0.13;
const BAND_R = 0.136;
const BAND_HALF = 0.025;
const BANDS = [-0.02, -0.14];

/** Body surface radius at a position along the axis (cylindrical part), with a 2 mm ramp at band edges. */
export function bodyRadiusAt(z: number): number {
  let r = BODY_R;
  for (const c of BANDS) {
    const d = Math.abs(z - c);
    if (d <= BAND_HALF) r = Math.max(r, BAND_R);
    else if (d < BAND_HALF + 0.002) r = Math.max(r, BAND_R - ((BAND_R - BODY_R) * (d - BAND_HALF)) / 0.002);
  }
  return r;
}

export interface DecalMesh {
  positions: number[];
  uvs: number[];
  indices: number[];
}

/**
 * Curved decal for both flanks in one mesh (one draw call per drone). Image u runs along the body and
 * is oriented so the emblem reads correctly from outside on each side; v runs up the flank.
 */
export function emblemDecal(segAround = 12, segAlong = 28): DecalMesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const meanR = BAND_R;
  const halfAngle = EMBLEM.height / 2 / meanR;
  const z0 = EMBLEM.zCenter - EMBLEM.width / 2;
  for (const side of [1, -1]) {
    const base = positions.length / 3;
    for (let i = 0; i <= segAround; i++) {
      const th = EMBLEM.angleCenter - halfAngle + (2 * halfAngle * i) / segAround; // angle above the equator
      for (let j = 0; j <= segAlong; j++) {
        const z = z0 + (EMBLEM.width * j) / segAlong;
        const r = bodyRadiusAt(z) + EMBLEM.offset;
        positions.push(side * r * Math.cos(th), r * Math.sin(th), z);
        // viewed from +x the drone's +z is on the viewer's LEFT; from −x it is on the RIGHT
        const u = side > 0 ? 1 - j / segAlong : j / segAlong;
        uvs.push(u, i / segAround);
      }
    }
    const row = segAlong + 1;
    for (let i = 0; i < segAround; i++)
      for (let j = 0; j < segAlong; j++) {
        const a = base + i * row + j;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        // counter-clockwise seen from outside
        if (side > 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, b, c, b, d, c);
      }
  }
  return { positions, uvs, indices };
}

/** Axis-aligned bounds of one flank's decal (for clearance checks). */
export function emblemBounds(side: 1 | -1): { x: [number, number]; y: [number, number]; z: [number, number] } {
  const { positions } = emblemDecal();
  const n = positions.length / 6; // vertices per side
  const start = side > 0 ? 0 : n;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let k = start; k < start + n; k++) {
    xs.push(positions[3 * k]);
    ys.push(positions[3 * k + 1]);
    zs.push(positions[3 * k + 2]);
  }
  const mm = (a: number[]): [number, number] => [Math.min(...a), Math.max(...a)];
  return { x: mm(xs), y: mm(ys), z: mm(zs) };
}
