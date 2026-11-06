import type { SimConfig } from './config';
import type { HeatmapGrid } from './heatmap';
import { trueDoseRate } from './radiation';
import { smoothedGrid } from './rescue';

/**
 * Stage 2 (scientific audit B1/B5): MAP-LEVEL quality of a radiation heat-map against the simulator's
 * ground-truth field — evaluation only, never used by any on-board or ground-station logic.
 *
 * Reference for a measured cell = true dose rate H*(x_c, h_c, z_c) at the cell CENTRE and the mean
 * altitude h_c of the samples in that cell. The cell error therefore contains counting noise AND
 * spatial representativeness (samples are spread over the 4 m cell). This is what a map user sees;
 * it is not circular like the per-sample error against the window-mean truth.
 *
 *   error_i = map_i − truth_i;  MAE, RMSE, bias over measured cells; Spearman ρ over cells;
 *   hotspot localisation = horizontal distance from the max cell centre to the true source;
 *   peak bias = (max cell value − truth at that cell) / truth;
 *   alert-cell classification: cell "above alert" if value ≥ alert level, vs truth ≥ alert level
 *   (sensitivity, specificity, counts) — dose-rate alert level from config.alerts (not regulatory).
 * Zero-count cells are valid measurements (no log metrics are computed; audit B11).
 */
export interface MapQuality {
  cells_measured: number;
  mae_uSv_h: number | null;
  rmse_uSv_h: number | null;
  bias_uSv_h: number | null;
  /** Relative error |e| / truth, median over cells. */
  median_rel_error: number | null;
  spearman_rho: number | null;
  peak_cell_value_uSv_h: number | null;
  peak_cell_truth_uSv_h: number | null;
  peak_rel_bias: number | null;
  hotspot_localisation_error_m: number | null;
  alert_level_uSv_h: number;
  alert_true_positive: number;
  alert_false_positive: number;
  alert_false_negative: number;
  alert_true_negative: number;
  alert_sensitivity: number | null;
  alert_specificity: number | null;
}

function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank for ties
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(a: number[], b: number[]): number | null {
  if (a.length < 3) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (ra[i] - ma) * (rb[i] - mb);
    saa += (ra[i] - ma) ** 2;
    sbb += (rb[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

export function mapQuality(grid: HeatmapGrid, cfg: SimConfig): MapQuality {
  const vals: number[] = [];
  const truths: number[] = [];
  let best = -1;
  let bestTruth = 0;
  let bx = 0;
  let bz = 0;
  const A = cfg.alerts.doseRate_uSv_h;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let iz = 0; iz < grid.nz; iz++)
    for (let ix = 0; ix < grid.nx; ix++) {
      const i = iz * grid.nx + ix;
      if (!grid.counts[i] || !Number.isFinite(grid.values[i])) continue;
      const x = grid.x0 + (ix + 0.5) * grid.cell;
      const z = grid.z0 + (iz + 0.5) * grid.cell;
      const h = Number.isFinite(grid.meanAlt[i]) ? grid.meanAlt[i] : cfg.survey.altitude_m;
      const t = trueDoseRate(cfg.radiation, { x, y: h, z });
      const v = grid.values[i];
      vals.push(v);
      truths.push(t);
      if (v > best) {
        best = v;
        bestTruth = t;
        bx = x;
        bz = z;
      }
      const pm = v >= A;
      const pt = t >= A;
      if (pm && pt) tp++;
      else if (pm) fp++;
      else if (pt) fn++;
      else tn++;
    }
  const n = vals.length;
  const r = (v: number | null, d = 5) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
  if (!n)
    return {
      cells_measured: 0, mae_uSv_h: null, rmse_uSv_h: null, bias_uSv_h: null, median_rel_error: null, spearman_rho: null,
      peak_cell_value_uSv_h: null, peak_cell_truth_uSv_h: null, peak_rel_bias: null, hotspot_localisation_error_m: null,
      alert_level_uSv_h: A, alert_true_positive: 0, alert_false_positive: 0, alert_false_negative: 0, alert_true_negative: 0, alert_sensitivity: null, alert_specificity: null,
    };
  let ae = 0;
  let se = 0;
  let be = 0;
  const rel: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = vals[i] - truths[i];
    ae += Math.abs(e);
    se += e * e;
    be += e;
    rel.push(Math.abs(e) / truths[i]);
  }
  rel.sort((a, b) => a - b);
  const med = n % 2 ? rel[(n - 1) / 2] : (rel[n / 2 - 1] + rel[n / 2]) / 2;
  const src = cfg.radiation.sourcePosition;
  return {
    cells_measured: n,
    mae_uSv_h: r(ae / n),
    rmse_uSv_h: r(Math.sqrt(se / n)),
    bias_uSv_h: r(be / n),
    median_rel_error: r(med, 4),
    spearman_rho: r(spearman(vals, truths), 4),
    peak_cell_value_uSv_h: r(best),
    peak_cell_truth_uSv_h: r(bestTruth),
    peak_rel_bias: r((best - bestTruth) / bestTruth, 4),
    hotspot_localisation_error_m: r(Math.hypot(bx - src.x, bz - src.z), 3),
    alert_level_uSv_h: A,
    alert_true_positive: tp,
    alert_false_positive: fp,
    alert_false_negative: fn,
    alert_true_negative: tn,
    alert_sensitivity: tp + fn ? r(tp / (tp + fn), 4) : null,
    alert_specificity: tn + fp ? r(tn / (tn + fp), 4) : null,
  };
}

/** Raw and display-smoothed (3×3 live-time-weighted, measured cells only) map quality. */
export function mapQualityPair(grid: HeatmapGrid, cfg: SimConfig): { raw: MapQuality; smoothed: MapQuality } {
  return { raw: mapQuality(grid, cfg), smoothed: mapQuality(smoothedGrid(grid), cfg) };
}
