import { describe, expect, it } from 'vitest';
import { CELL_ESTIMATED } from '../src/sim';
import { buildEstimateField, buildHeatField, contourSegments } from '../src/viz/heatField';

/** 6×5 grid: a 3×3 measured block (values 1..9) plus one isolated measured cell; the rest unknown. */
function grid() {
  const nx = 6;
  const nz = 5;
  const values = new Float64Array(nx * nz).fill(Number.NaN);
  let v = 1;
  for (let iz = 1; iz <= 3; iz++) for (let ix = 0; ix <= 2; ix++) values[iz * nx + ix] = v++;
  values[0 * nx + 5] = 0.5; // isolated cell
  return { nx, nz, values };
}

describe('Phase 3B — aerial heat field (display only)', () => {
  const g = grid();
  const ppc = 8;
  const f = buildHeatField(g, ppc);
  const ownCell = (px: number, py: number) => Math.floor(py / ppc) * g.nx + Math.floor(px / ppc);

  it('is fully transparent over every unmeasured cell (no false coverage)', () => {
    for (let py = 0; py < f.h; py++)
      for (let px = 0; px < f.w; px++) {
        const i = py * f.w + px;
        if (Number.isNaN(g.values[ownCell(px, py)])) {
          expect(f.alpha[i]).toBe(0);
          expect(Number.isNaN(f.value[i])).toBe(true);
        }
      }
  });

  it('is opaque in the interior of the measured region and fades at its boundary', () => {
    const centre = (ix: number, iz: number) => (iz * ppc + ppc / 2) * f.w + ix * ppc + ppc / 2;
    expect(f.alpha[centre(1, 2)]).toBeGreaterThan(0.95); // interior of the 3×3 block
    expect(f.alpha[centre(0, 1)]).toBeGreaterThan(0); // corner cell still shown…
    expect(f.alpha[centre(0, 1)]).toBeLessThan(f.alpha[centre(1, 2)]); // …but softer
    // the pixel right at the block's outer edge is almost transparent
    const edge = (2 * ppc + 4) * f.w + (3 * ppc - 1);
    expect(f.alpha[edge]).toBeLessThan(0.1);
    // the isolated measurement is visible but faint
    const iso = centre(5, 0);
    expect(f.alpha[iso]).toBeGreaterThan(0.1);
    expect(f.alpha[iso]).toBeLessThan(0.7);
  });

  it('never shows values outside the range of the measured neighbours', () => {
    for (let i = 0; i < f.value.length; i++) {
      if (Number.isNaN(f.value[i])) continue;
      expect(f.value[i]).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(f.value[i]).toBeLessThanOrEqual(9 + 1e-9);
    }
    // the isolated cell is not blended with the far-away block
    const iso = (ppc / 2) * f.w + 5 * ppc + ppc / 2;
    expect(Math.abs(f.value[iso] - 0.5)).toBeLessThan(1e-9);
  });

  it('draws contours only through squares whose four corners are measured', () => {
    const segs = contourSegments(g, 4.5);
    expect(segs.length).toBeGreaterThan(0);
    for (const [x1, z1, x2, z2] of segs) {
      for (const [x, z] of [
        [x1, z1],
        [x2, z2],
      ]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(2);
        expect(z).toBeGreaterThanOrEqual(1);
        expect(z).toBeLessThanOrEqual(3);
      }
    }
    expect(contourSegments(g, 100)).toEqual([]);
  });

  it('keeps the estimate layer separate from measured cells', () => {
    const kind = new Uint8Array(g.nx * g.nz);
    const ev = new Float64Array(g.nx * g.nz).fill(Number.NaN);
    kind[4 * g.nx + 4] = CELL_ESTIMATED;
    ev[4 * g.nx + 4] = 2;
    const e = buildEstimateField(g, { values: ev, kind } as never, ppc);
    for (let py = 0; py < e.h; py++)
      for (let px = 0; px < e.w; px++) {
        const k = ownCell(px, py);
        if (k !== 4 * g.nx + 4) expect(e.alpha[py * e.w + px]).toBe(0);
      }
  });
});
