import type { HeatmapGrid } from './heatmap';

/**
 * v0.7.0 Fix A — CONSERVATIVE handling of UNMEASURED ground (docs/SIMULATION_MODEL.md §41).
 *
 * Rule (heuristic, deterministic, ground-station data only):
 *   the dose rate ASSUMED for an unmeasured heat-map cell is the HIGHEST measured cell mean whose
 *   cell centre lies within `radius_m` of that cell's centre; if no measured cell is that close, the
 *   highest measured cell mean anywhere on the received map; if nothing has been measured at all,
 *   no value (null) — there is then no basis for any dose figure.
 *
 * Meaning: "unmeasured ground is never assumed to be lower than the highest level actually observed
 * near it". It is a HEURISTIC CONSERVATIVE ESTIMATE, not a statistical upper bound: a source hidden
 * in an unmeasured area could be stronger than anything observed. It replaces the Phase 3 assumption
 * "unknown = background × unknownMultiplier (3 × 0.1 µSv/h)", which made unmeasured ground look
 * almost clean next to measured cells of several µSv/h and steered planners into it.
 *
 * Default radius 12 m = 3 heat-map cells = the 3×3-cell smoothing span already used for rescue
 * planning (rescue.ts smoothedGrid) and the IDW display-estimate reach (interpolateIdw(…, 12)).
 * Sensitivity to the radius is reported in docs/VALIDATION_V0.7.0.md.
 */
export type UnknownPolicy = 'CONSERVATIVE_NEIGHBOURHOOD' | 'BACKGROUND_MULTIPLE';

export interface ConservativeEnvelope {
  radius_m: number;
  /** Highest measured cell mean on the map, µSv/h (null = no measurement at all). */
  globalMax: number | null;
  /** Assumed rate at (x, z): the envelope of the heat-map cell containing the point; null = no data at all. */
  lookup: (x: number, z: number) => number | null;
  /** Per-cell envelope (row-major, NaN when no data at all). */
  cells: Float64Array;
}

export function conservativeEnvelope(g: HeatmapGrid, radius_m: number): ConservativeEnvelope {
  const N = g.nx * g.nz;
  const cells = new Float64Array(N).fill(Number.NaN);
  let globalMax: number | null = null;
  for (let k = 0; k < N; k++) if (g.counts[k] > 0 && Number.isFinite(g.values[k]) && (globalMax === null || g.values[k] > globalMax)) globalMax = g.values[k];
  const reach = Math.ceil(radius_m / g.cell);
  const r2 = radius_m * radius_m + 1e-9;
  // envelope at an arbitrary point given in cell-centre coordinates (works outside the grid too)
  const at = (px: number, pz: number): number | null => {
    if (globalMax === null) return null;
    const ci = Math.floor((px - g.x0) / g.cell);
    const cj = Math.floor((pz - g.z0) / g.cell);
    let best: number | null = null;
    for (let j = Math.max(0, cj - reach); j <= Math.min(g.nz - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(g.nx - 1, ci + reach); i++) {
        const k = j * g.nx + i;
        if (!(g.counts[k] > 0)) continue;
        const dx = g.x0 + (i + 0.5) * g.cell - px;
        const dz = g.z0 + (j + 0.5) * g.cell - pz;
        if (dx * dx + dz * dz > r2) continue;
        if (best === null || g.values[k] > best) best = g.values[k];
      }
    }
    return best ?? globalMax;
  };
  if (globalMax !== null) {
    for (let j = 0; j < g.nz; j++) {
      for (let i = 0; i < g.nx; i++) {
        const v = at(g.x0 + (i + 0.5) * g.cell, g.z0 + (j + 0.5) * g.cell);
        cells[j * g.nx + i] = v === null ? Number.NaN : v;
      }
    }
  }
  const lookup = (x: number, z: number): number | null => {
    if (globalMax === null) return null;
    const i = Math.floor((x - g.x0) / g.cell);
    const j = Math.floor((z - g.z0) / g.cell);
    if (i >= 0 && j >= 0 && i < g.nx && j < g.nz) return cells[j * g.nx + i];
    // outside the heat-map grid: same rule, centred on the virtual cell containing the point
    return at(g.x0 + (i + 0.5) * g.cell, g.z0 + (j + 0.5) * g.cell);
  };
  return { radius_m, globalMax, lookup, cells };
}
