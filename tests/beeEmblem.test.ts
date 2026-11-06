import { describe, expect, it } from 'vitest';
import { EMBLEM, EMBLEM_ASPECT, bodyRadiusAt, emblemBounds, emblemDecal } from '../src/viz/models/beeEmblemLayout';

/** Emblem decal on the bee flanks — placement and surface fit (presentation only). */
describe('Bee emblem decal', () => {
  const d = emblemDecal();
  const nv = d.positions.length / 3;

  it('sits on the middle YELLOW panel of both flanks, between the dark bands (not on a band)', () => {
    const r = emblemBounds(1);
    const l = emblemBounds(-1);
    expect(r.x[0]).toBeGreaterThan(0.11);
    expect(l.x[1]).toBeLessThan(-0.11);
    expect(Math.abs(r.x[0] + l.x[1])).toBeLessThan(1e-9);
    expect(r.z).toEqual(l.z);
    // dark bands: z −0.045…+0.005 and z −0.165…−0.115 (plus a 2 mm edge ramp) — the decal stays between them
    expect(r.z[1]).toBeLessThan(-0.045 - 0.002);
    expect(r.z[0]).toBeGreaterThan(-0.115 + 0.002);
    // between the front (z = +0.2) and rear (z = −0.2) rotors
    expect(r.z[0]).toBeGreaterThan(-0.2);
    expect(r.z[1]).toBeLessThan(0.2);
    // artwork aspect kept (610 × 662.42)
    expect(Math.abs(EMBLEM.width / EMBLEM.height - EMBLEM_ASPECT)).toBeLessThan(1e-12);
  });

  it('is flush with the yellow capsule surface (r = 0.13) at a 1.2 mm stand-off everywhere', () => {
    for (let k = 0; k < nv; k++) {
      const x = d.positions[3 * k];
      const y = d.positions[3 * k + 1];
      const z = d.positions[3 * k + 2];
      expect(bodyRadiusAt(z)).toBe(0.13); // yellow only: no band under any vertex
      expect(Math.abs(Math.hypot(x, y) - (0.13 + EMBLEM.offset))).toBeLessThan(1e-9);
    }
  });

  it('stays clear of the side sensor box, rotor arms, ducts and legs', () => {
    const r = emblemBounds(1);
    // right-flank sensor box: z 0.025…0.095
    expect(r.z[1]).toBeLessThan(0.025);
    // under the duct lower-rim tubes (y ≈ 0.014) and the rotor support arms (y ≥ 0.0375)
    expect(r.y[1]).toBeLessThan(0.014);
    // ducts (x = ±0.31, z = ±0.2, r = 0.17) never reach the decal
    for (const zc of [0.2, -0.2]) for (const z of [r.z[0], r.z[1]]) expect(Math.hypot(r.x[1] - 0.31, z - zc)).toBeGreaterThan(0.17);
    // above the leg hips on the belly (y = −0.08)
    expect(r.y[0]).toBeGreaterThan(-0.07);
  });

  it('valid UVs and outward-facing triangles on both sides', () => {
    for (const u of d.uvs) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
    const p = (i: number) => [d.positions[3 * i], d.positions[3 * i + 1], d.positions[3 * i + 2]];
    for (let t = 0; t < d.indices.length; t += 3) {
      const [a, b, c] = [p(d.indices[t]), p(d.indices[t + 1]), p(d.indices[t + 2])];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = u[1] * v[2] - u[2] * v[1];
      expect(Math.sign(nx)).toBe(Math.sign(a[0])); // normal points away from the body axis
    }
  });
});
