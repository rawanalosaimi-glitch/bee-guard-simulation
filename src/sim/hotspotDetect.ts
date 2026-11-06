import type { HeatmapGrid } from './heatmap';

/**
 * v0.7.0 Fix C — hotspot detection on BEE-01's ON-BOARD map (docs/SIMULATION_MODEL.md §43). Pure,
 * deterministic; uses only on-board measurements (never the source position).
 *
 *  1. Smoothing: live-time-weighted 3×3-cell mean (12 m), summed counts and live time (same definition
 *     as the rescue planning field, rescue.ts smoothedGrid).
 *  2. Significance: a cell is significant when its 3×3 summed counts exceed the BACKGROUND expectation
 *     by ≥ zTrigger standard deviations (Poisson, Gaussian approximation):
 *         λ_B = B · S · Σt_live / c,   z = (Σcounts − λ_B) / √λ_B  ≥ zTrigger (default 5)
 *     AND its smoothed rate is ≥ minFactor × background (default 3×; the v0.7.1 experiment with 2×
 *     was not adopted). This replaces the fixed
 *     1.5 µSv/h trigger, which a weak source never reached (LOW) and a strong one exceeded ~58 m away (HIGH).
 *  3. Peak: a significant cell that is a local maximum of the smoothed map (8 neighbours) and is not
 *     the SHOULDER of a higher cell within confirmRadius_m. "Shoulder" = no significant dip between the
 *     two along the straight line: dip = value − min(smoothed values on the line) must exceed BOTH
 *     dipSigma × σ (counting) and dipFraction × value for the two to count as SEPARATE sources.
 *     A higher cell beyond a significant dip never suppresses a peak, so genuinely separate sources
 *     are kept; if no measured cell lies between them, they are also kept separate (cannot tell).
 *  4. Confirmation: the peak is confirmed when ≥ completeness of the reachable area cells within
 *     confirmRadius_m hold a measurement (so "highest nearby" is known), or at the final evaluation
 *     after the area lanes (`final`).
 *
 * Default confirmRadius_m = 28 m ≈ 2 h, h = survey altitude above the source (15 − 1.3 m): at 2 h the
 * field of a point source seen at altitude has fallen to 1/5 of its on-axis value, so any higher
 * reading within 2 h with no dip between belongs to the same source. Sensitivity in docs/VALIDATION_V0.7.0.md.
 */
export interface HotspotParams {
  background_uSv_h: number;
  sensitivity_cps_per_uSv_h: number;
  calibrationFactor: number;
  zTrigger: number;
  minFactorOverBackground: number;
  confirmRadius_m: number;
  confirmCompleteness: number;
  dipSigma: number;
  dipFraction: number;
  /** 0.8.0-rc1: equal smoothed value + lower index counts as "higher" in the shoulder test (defect fix). */
  equalValueTieBreak?: boolean;
}

export interface SmoothedField {
  values: Float64Array; // NaN = unmeasured
  countSum: Float64Array;
  liveSum: Float64Array;
}

export interface PeakCandidate {
  k: number;
  x: number;
  z: number;
  value_uSv_h: number;
  sigma_uSv_h: number;
  zScore: number;
  /** Measured fraction of reachable area cells within confirmRadius_m. */
  completeness: number;
  confirmed: boolean;
}

export function smoothField(g: HeatmapGrid): SmoothedField {
  const n = g.nx * g.nz;
  const values = new Float64Array(n).fill(Number.NaN);
  const countSum = new Float64Array(n);
  const liveSum = new Float64Array(n);
  for (let iz = 0; iz < g.nz; iz++)
    for (let ix = 0; ix < g.nx; ix++) {
      const k = iz * g.nx + ix;
      if (!(g.counts[k] > 0)) continue;
      let sv = 0;
      let sw = 0;
      let sc = 0;
      let sl = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx;
          const jz = iz + dz;
          if (jx < 0 || jz < 0 || jx >= g.nx || jz >= g.nz) continue;
          const j = jz * g.nx + jx;
          if (!(g.counts[j] > 0)) continue;
          const w = g.liveSum[j] > 0 ? g.liveSum[j] : g.counts[j];
          sv += g.values[j] * w;
          sw += w;
          sc += g.countSum[j];
          sl += g.liveSum[j];
        }
      values[k] = sv / sw;
      countSum[k] = sc;
      liveSum[k] = sl;
    }
  return { values, countSum, liveSum };
}

/** Significance of a smoothed cell vs background: z-score of the summed counts (Poisson, Gaussian approx.). */
export function significance(f: SmoothedField, k: number, p: HotspotParams): number {
  const lamB = (p.background_uSv_h * p.sensitivity_cps_per_uSv_h * f.liveSum[k]) / p.calibrationFactor;
  if (!(lamB > 0)) return 0;
  return (f.countSum[k] - lamB) / Math.sqrt(lamB);
}

/** Counting 1σ of a smoothed cell value, µSv/h. */
export function smoothedSigma(f: SmoothedField, k: number, p: HotspotParams): number {
  if (!(f.liveSum[k] > 0)) return Number.POSITIVE_INFINITY;
  return (p.calibrationFactor * Math.sqrt(Math.max(1, f.countSum[k]))) / (p.sensitivity_cps_per_uSv_h * f.liveSum[k]);
}

const centre = (g: HeatmapGrid, k: number) => ({ x: g.x0 + ((k % g.nx) + 0.5) * g.cell, z: g.z0 + (Math.floor(k / g.nx) + 0.5) * g.cell });

/**
 * Do cells a and b belong to the SAME source? True when the smoothed map shows no significant dip on the
 * straight line between them (relative to the LOWER of the two). False when there is a significant dip,
 * or when no measured cell lies between them (cannot tell → kept separate).
 */
export function sameSource(g: HeatmapGrid, f: SmoothedField, a: number, b: number, p: HotspotParams): boolean {
  if (a === b) return true;
  const pa = centre(g, a);
  const pb = centre(g, b);
  const low = f.values[a] <= f.values[b] ? a : b;
  const L = Math.hypot(pb.x - pa.x, pb.z - pa.z);
  const n = Math.max(2, Math.ceil(L / (g.cell / 2)));
  let min = Number.POSITIVE_INFINITY;
  let seen = 0;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const ix = Math.floor((pa.x + (pb.x - pa.x) * t - g.x0) / g.cell);
    const iz = Math.floor((pa.z + (pb.z - pa.z) * t - g.z0) / g.cell);
    if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) continue;
    const k = iz * g.nx + ix;
    if (k === a || k === b || Number.isNaN(f.values[k])) continue;
    seen++;
    if (f.values[k] < min) min = f.values[k];
  }
  if (seen === 0) return L <= g.cell * Math.SQRT2 + 1e-9; // adjacent cells are one blob; otherwise cannot tell
  const v = f.values[low];
  const dip = v - min;
  const separate = dip > p.dipSigma * smoothedSigma(f, low, p) && dip > p.dipFraction * v;
  return !separate;
}

/**
 * Peaks of the on-board map (sorted by smoothed value, highest first). `reachable` marks the area cells
 * the lanes can measure (1 = reachable) — the completeness test uses only those.
 */
export function findPeaks(g: HeatmapGrid, reachable: Uint8Array, p: HotspotParams, final: boolean): PeakCandidate[] {
  const f = smoothField(g);
  const n = g.nx * g.nz;
  const R = p.confirmRadius_m;
  const reach = Math.ceil(R / g.cell);
  const sig = new Uint8Array(n);
  const zs = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (Number.isNaN(f.values[k])) continue;
    zs[k] = significance(f, k, p);
    if (zs[k] >= p.zTrigger && f.values[k] >= p.minFactorOverBackground * p.background_uSv_h) sig[k] = 1;
  }
  const out: PeakCandidate[] = [];
  for (let k = 0; k < n; k++) {
    if (!sig[k]) continue;
    const ix = k % g.nx;
    const iz = Math.floor(k / g.nx);
    const v = f.values[k];
    // local maximum (ties broken by index, so a flat top yields one peak)
    let isMax = true;
    for (let dz = -1; dz <= 1 && isMax; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= g.nx || jz >= g.nz) continue;
        const j = jz * g.nx + jx;
        const w = f.values[j];
        if (Number.isNaN(w)) continue;
        if (w > v || (w === v && j < k)) {
          isMax = false;
          break;
        }
      }
    if (!isMax) continue;
    // not the shoulder of a higher cell within R (no significant dip between)
    let shoulder = false;
    let reachCells = 0;
    let measReach = 0;
    for (let jz = Math.max(0, iz - reach); jz <= Math.min(g.nz - 1, iz + reach); jz++)
      for (let jx = Math.max(0, ix - reach); jx <= Math.min(g.nx - 1, ix + reach); jx++) {
        const dxm = (jx - ix) * g.cell;
        const dzm = (jz - iz) * g.cell;
        if (dxm * dxm + dzm * dzm > R * R + 1e-9) continue;
        const j = jz * g.nx + jx;
        if (reachable[j]) {
          reachCells++;
          if (!Number.isNaN(f.values[j]) && g.counts[j] > 0) measReach++;
        }
        const higher = f.values[j] > v || (p.equalValueTieBreak === true && f.values[j] === v && j < k);
        if (!shoulder && j !== k && !Number.isNaN(f.values[j]) && higher && sameSource(g, f, k, j, p)) shoulder = true;
      }
    if (shoulder) continue;
    const completeness = reachCells ? measReach / reachCells : 1;
    const c = centre(g, k);
    out.push({ k, x: c.x, z: c.z, value_uSv_h: v, sigma_uSv_h: smoothedSigma(f, k, p), zScore: zs[k], completeness, confirmed: final || completeness >= p.confirmCompleteness - 1e-12 });
  }
  return out.sort((a, b) => b.value_uSv_h - a.value_uSv_h || a.k - b.k);
}
