import type { HeatmapGrid } from '../sim';
import { CELL_ESTIMATED } from '../sim';
import type { InterpolatedGrid } from '../sim';

/**
 * Display field for the aerial radiation overlay (pure — unit-tested).
 *
 * Super-samples the heat-map grid at `ppc` pixels per cell:
 *  - value  : bilinear blend of the surrounding cell means, using MEASURED cells only
 *             (weights renormalised over the measured neighbours);
 *  - alpha  : 0 in every pixel whose own cell is unmeasured (no spill onto unknown
 *             ground). Inside measured cells it follows a smooth coverage mask
 *             m = Σ inc·K / Σ K (compact kernel K, radius 1.25 cells, partition of
 *             unity) so the edge of the measured region fades out INSIDE the
 *             measured cells and convex corners are rounded — no square cell outlines.
 *             m = 0.5 on a measured/unknown boundary → alpha 0 there; m = 1 in the
 *             interior → alpha 1; an isolated single measured cell stays faint.
 * The same is produced separately for ESTIMATED cells (IDW layer) so the UI can
 * draw them with a different, clearly marked style.
 */
export interface HeatField {
  w: number;
  h: number;
  ppc: number;
  value: Float32Array;
  alpha: Float32Array;
}

const KR = 1.25;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function buildHeatField(
  g: Pick<HeatmapGrid, 'nx' | 'nz' | 'values'>,
  ppc: number,
  include: (k: number) => boolean = (k) => !Number.isNaN(g.values[k]),
  valueOf: (k: number) => number = (k) => g.values[k],
): HeatField {
  const w = g.nx * ppc;
  const h = g.nz * ppc;
  const value = new Float32Array(w * h).fill(Number.NaN);
  const alpha = new Float32Array(w * h);
  const inc = (ix: number, iz: number) => ix >= 0 && iz >= 0 && ix < g.nx && iz < g.nz && include(iz * g.nx + ix);
  for (let py = 0; py < h; py++) {
    // position in cell units, relative to cell centres
    const fz = (py + 0.5) / ppc - 0.5;
    const iz0 = Math.floor(fz);
    const tz = fz - iz0;
    const ownZ = Math.floor((py + 0.5) / ppc);
    for (let px = 0; px < w; px++) {
      const ownX = Math.floor((px + 0.5) / ppc);
      if (!inc(ownX, ownZ)) continue; // unknown / not this layer → transparent
      const fx = (px + 0.5) / ppc - 0.5;
      const ix0 = Math.floor(fx);
      const tx = fx - ix0;
      let sw = 0;
      let sv = 0;
      for (const [dx, dz, wgt] of [
        [0, 0, (1 - tx) * (1 - tz)],
        [1, 0, tx * (1 - tz)],
        [0, 1, (1 - tx) * tz],
        [1, 1, tx * tz],
      ] as const) {
        if (inc(ix0 + dx, iz0 + dz)) {
          sw += wgt;
          sv += wgt * Math.log(Math.max(1e-6, valueOf((iz0 + dz) * g.nx + ix0 + dx)));
        }
      }
      // smooth coverage mask over the 5×5 cell neighbourhood
      let km = 0;
      let kt = 0;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const cx = ownX + dx;
          const cz = ownZ + dz;
          const ddx = fx - cx;
          const ddz = fz - cz;
          const q = 1 - (ddx * ddx + ddz * ddz) / (KR * KR);
          if (q <= 0) continue;
          const k = q * q;
          kt += k;
          if (inc(cx, cz)) km += k;
        }
      }
      const m = kt > 0 ? km / kt : 1;
      const i = py * w + px;
      value[i] = sw > 0 ? Math.exp(sv / sw) : valueOf(ownZ * g.nx + ownX);
      alpha[i] = smooth(0.5, 0.92, m);
    }
  }
  return { w, h, ppc, value, alpha };
}

/** Field for the IDW estimate layer (estimated cells only, never measured ones). */
export function buildEstimateField(g: Pick<HeatmapGrid, 'nx' | 'nz' | 'values'>, est: InterpolatedGrid, ppc: number): HeatField {
  return buildHeatField(g, ppc, (k) => est.kind[k] === CELL_ESTIMATED, (k) => est.values[k]);
}

/**
 * Iso-lines of the measured field (marching squares on cell centres). A square
 * contributes only when all four corner cells are measured — contours never
 * cross unknown ground. Returns segments in grid-centre units [x1, z1, x2, z2].
 */
export function contourSegments(g: Pick<HeatmapGrid, 'nx' | 'nz' | 'values'>, level: number): number[][] {
  const out: number[][] = [];
  const v = (ix: number, iz: number) => g.values[iz * g.nx + ix];
  for (let iz = 0; iz < g.nz - 1; iz++) {
    for (let ix = 0; ix < g.nx - 1; ix++) {
      const a = v(ix, iz);
      const b = v(ix + 1, iz);
      const c = v(ix + 1, iz + 1);
      const d = v(ix, iz + 1);
      if ([a, b, c, d].some((x) => Number.isNaN(x))) continue;
      const pts: [number, number][] = [];
      const edge = (p: number, q: number, x1: number, z1: number, x2: number, z2: number) => {
        if ((p >= level) !== (q >= level)) {
          const t = (level - p) / (q - p);
          pts.push([x1 + (x2 - x1) * t, z1 + (z2 - z1) * t]);
        }
      };
      edge(a, b, ix, iz, ix + 1, iz);
      edge(b, c, ix + 1, iz, ix + 1, iz + 1);
      edge(c, d, ix + 1, iz + 1, ix, iz + 1);
      edge(d, a, ix, iz + 1, ix, iz);
      if (pts.length === 2) out.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
      else if (pts.length === 4) {
        out.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
        out.push([pts[2][0], pts[2][1], pts[3][0], pts[3][1]]);
      }
    }
  }
  return out;
}
