import type { RadiationConfig } from './config';
import type { RadiationSample } from './radiation';

/**
 * Grid aggregation of radiation measurements on a regular x–z grid.
 *
 * Each cell holds the MEAN of the measurements whose (window-mean) position
 * falls inside it. Cells without samples are NaN = UNSAMPLED. There is NO
 * interpolation: a cell is either measured or unknown, and the UI must show
 * unknown cells as unknown.
 *
 * Note: samples are taken at flight altitude (≈ 10–22 m), not at ground level.
 */
export interface HeatmapGrid {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** Row-major (iz * nx + ix) cell means, NaN = no data. */
  values: Float64Array;
  counts: Uint32Array;
  /** Sample time of the newest / oldest measurement in each cell, s (NaN = none). */
  lastTime: Float64Array;
  firstTime: Float64Array;
  /** Mean altitude of the samples in each cell, m (NaN = none). */
  meanAlt: Float64Array;
  /** Phase 3A: Σ detector counts and Σ live time per cell (0 when the points carry no counts). */
  countSum: Float64Array;
  liveSum: Float64Array;
  min: number;
  max: number;
  filled: number;
}

export interface GridPoint {
  x: number;
  y: number;
  z: number;
  value: number;
  time: number;
  /** Optional raw counts and live time (for counting-statistics uncertainty). */
  counts?: number;
  live?: number;
}

export function buildGrid(points: readonly GridPoint[], spec: RadiationConfig['heatmap']): HeatmapGrid {
  const { x0, z0, cell, nx, nz } = spec;
  const n = nx * nz;
  const sums = new Float64Array(n);
  const alt = new Float64Array(n);
  const counts = new Uint32Array(n);
  const lastTime = new Float64Array(n).fill(Number.NaN);
  const firstTime = new Float64Array(n).fill(Number.NaN);
  const countSum = new Float64Array(n);
  const liveSum = new Float64Array(n);
  for (const p of points) {
    const ix = Math.floor((p.x - x0) / cell);
    const iz = Math.floor((p.z - z0) / cell);
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue;
    const k = iz * nx + ix;
    sums[k] += p.value;
    alt[k] += p.y;
    counts[k] += 1;
    if (p.counts !== undefined && p.live !== undefined) {
      countSum[k] += p.counts;
      liveSum[k] += p.live;
    }
    if (!(lastTime[k] >= p.time)) lastTime[k] = p.time;
    if (!(firstTime[k] <= p.time)) firstTime[k] = p.time;
  }
  const values = new Float64Array(n);
  const meanAlt = new Float64Array(n);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let filled = 0;
  for (let i = 0; i < n; i++) {
    if (counts[i] === 0) {
      values[i] = Number.NaN;
      meanAlt[i] = Number.NaN;
      continue;
    }
    const v = sums[i] / counts[i];
    values[i] = v;
    meanAlt[i] = alt[i] / counts[i];
    filled++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { x0, z0, cell, nx, nz, values, counts, lastTime, firstTime, meanAlt, countSum, liveSum, min: filled ? min : 0, max: filled ? max : 0, filled };
}

/** Phase 2 API: grid of on-board samples (measured by default; 'truth' for evaluation only). */
export function buildHeatmap(
  samples: readonly RadiationSample[],
  spec: RadiationConfig['heatmap'],
  field: 'measured' | 'truth' = 'measured',
): HeatmapGrid {
  return buildGrid(
    samples.map((s) => ({
      x: s.x,
      y: s.y,
      z: s.z,
      time: s.time,
      value: field === 'measured' ? s.measured_uSv_h : s.trueWindowMean_uSv_h,
      counts: s.counts,
      live: s.liveTime_s,
    })),
    spec,
  );
}

/** Value lookup for a grid: measured cell mean, or null when the point is unsampled / outside. */
export function gridLookup(g: HeatmapGrid): (x: number, z: number) => number | null {
  return (x, z) => {
    const ix = Math.floor((x - g.x0) / g.cell);
    const iz = Math.floor((z - g.z0) / g.cell);
    if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return null;
    const v = g.values[iz * g.nx + ix];
    return Number.isNaN(v) ? null : v;
  };
}

/**
 * OPTIONAL display estimate — inverse-distance-weighted (IDW) interpolation.
 *
 *  - Measured cells keep their measured mean exactly (kind = MEASURED).
 *  - An unmeasured cell whose centre lies within `maxDistance` metres of at
 *    least one measured cell centre gets  Σ wᵢ vᵢ / Σ wᵢ,  wᵢ = 1 / dᵢ^power,
 *    over measured cells within that distance (kind = ESTIMATED).
 *  - Everything else stays unknown (kind = UNKNOWN, value NaN).
 *
 * This is a visual aid only: estimated cells are never used for evacuation
 * planning, dose analytics or exports, and the UI must label them as estimates.
 */
export type CellKind = 0 | 1 | 2; // 0 = UNKNOWN, 1 = MEASURED, 2 = ESTIMATED
export const CELL_UNKNOWN = 0;
export const CELL_MEASURED = 1;
export const CELL_ESTIMATED = 2;

export interface InterpolatedGrid {
  values: Float64Array;
  kind: Uint8Array;
  estimated: number;
  maxDistance: number;
  power: number;
}

export function interpolateIdw(g: HeatmapGrid, maxDistance = 12, power = 2): InterpolatedGrid {
  const n = g.nx * g.nz;
  const values = new Float64Array(n).fill(Number.NaN);
  const kind = new Uint8Array(n);
  for (let iz = 0; iz < g.nz; iz++) {
    for (let ix = 0; ix < g.nx; ix++) {
      const k = iz * g.nx + ix;
      if (!Number.isNaN(g.values[k])) {
        values[k] = g.values[k];
        kind[k] = CELL_MEASURED;
      }
    }
  }
  const R = Math.ceil(maxDistance / g.cell);
  let estimated = 0;
  for (let iz = 0; iz < g.nz; iz++) {
    for (let ix = 0; ix < g.nx; ix++) {
      const k = iz * g.nx + ix;
      if (kind[k] === CELL_MEASURED) continue;
      let sw = 0;
      let sv = 0;
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const jx = ix + dx;
          const jz = iz + dz;
          if (jx < 0 || jz < 0 || jx >= g.nx || jz >= g.nz) continue;
          const j = jz * g.nx + jx;
          if (kind[j] !== CELL_MEASURED) continue;
          const d = Math.hypot(dx, dz) * g.cell;
          if (d > maxDistance) continue;
          const w = 1 / d ** power;
          sw += w;
          sv += w * g.values[j];
        }
      }
      if (sw > 0) {
        values[k] = sv / sw;
        kind[k] = CELL_ESTIMATED;
        estimated++;
      }
    }
  }
  return { values, kind, estimated, maxDistance, power };
}

/**
 * Counting-statistics 1σ of a cell mean, µSv/h:  σ = c·√ΣN / (k·ΣT).
 * With zero counts, one count is used (an upper-side estimate). Spatial
 * variation inside the cell and altitude differences are NOT included.
 * Returns null for unmeasured cells or cells without count information.
 */
export function cellSigma(g: HeatmapGrid, k: number, cfg: Pick<RadiationConfig, 'sensitivity_cps_per_uSv_h' | 'calibrationFactor'>): number | null {
  if (g.counts[k] === 0 || !(g.liveSum[k] > 0)) return null;
  return (cfg.calibrationFactor * Math.sqrt(Math.max(1, g.countSum[k]))) / (cfg.sensitivity_cps_per_uSv_h * g.liveSum[k]);
}
