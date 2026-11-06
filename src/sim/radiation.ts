import type { RadiationConfig } from './config';
import { SeededRng, poisson } from './rng';
import type { CommsNetwork } from './comms';
import type { SubsystemContext } from './types';
import type { Vec3 } from './vec3';

/**
 * BEE-01 radiation detection — SIMULATED (docs/SIMULATION_MODEL.md §10).
 *
 * Ground truth (reference field): isotropic point source, inverse-square law
 *   H*(r) = B + S · exp(−μ·r) / max(r, r_min)²      [µSv/h]
 * with S = dose rate at 1 m, B = uniform background, r = 3-D distance.
 * No shielding by buildings, no scatter/build-up, no terrain effects.
 *
 * Simulated sensor: counting detector with sensitivity k [cps per µSv/h].
 * Phase 3B+ spatial sampling: a window closes after T OR once the drone has moved
 * `maxSampleSpacing_m` horizontally, whichever comes first, so a fast drone still records
 * ≥ 2 samples per heat-map cell (shorter live time → fewer counts → larger σ, which the
 * per-sample live time and the cell σ = √N/(k·T_live) report honestly).
 * Expected counts are accumulated every fixed step over the integration window T:
 *   λ = Σ k·H*(p_i)·dt
 * The detector reports N ~ Poisson(λ) counts and the measured dose rate
 *   Ĥ = c · N / (k·T)        (c = calibration factor, 1 by default)
 * Reference values written to the ground-truth export:
 *   - window-mean truth  λ/(k·T)  (what an ideal detector would report; use for MAE/RMSE)
 *   - point truth at the window-mean position.
 */

export interface RadiationSample {
  id: number;
  step: number;
  time: number;
  droneId: string;
  /** Window-mean position (no navigation error is modelled). */
  x: number;
  y: number;
  z: number;
  distance_m: number;
  liveTime_s: number;
  /** --- measurement --- */
  counts: number;
  measured_uSv_h: number;
  /** --- ground truth (kept in the sample object; exported to a separate file) --- */
  trueWindowMean_uSv_h: number;
  trueAtPosition_uSv_h: number;
}

export interface RadiationState {
  samples: RadiationSample[];
  latest: RadiationSample | null;
  peakMeasured: RadiationSample | null;
  surveying: boolean;
}

export const initialRadiationState = (): RadiationState => ({
  samples: [],
  latest: null,
  peakMeasured: null,
  surveying: false,
});

/** Ground-truth ambient dose-rate model, µSv/h. */
export function trueDoseRate(cfg: RadiationConfig, p: Vec3): number {
  const s = cfg.sourcePosition;
  const r = Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z);
  const rEff = Math.max(r, cfg.minDistance_m);
  let v = cfg.background_uSv_h + (cfg.sourceStrength_uSv_h_at_1m * Math.exp(-cfg.airAttenuation_per_m * r)) / (rEff * rEff);
  // v0.7.0: optional extra point sources (validation scenarios only; none by default)
  const extra = cfg.additionalSources;
  if (extra && extra.length) {
    for (const q of extra) {
      const r2 = Math.hypot(p.x - q.position.x, p.y - q.position.y, p.z - q.position.z);
      const e = Math.max(r2, cfg.minDistance_m);
      v += (q.strength_uSv_h_at_1m * Math.exp(-cfg.airAttenuation_per_m * r2)) / (e * e);
    }
  }
  return v;
}

export class RadiationSensor {
  static readonly DRONE = 'BEE-01';
  private rng: SeededRng;
  private lambda = 0;
  private sx = 0;
  private sy = 0;
  private sz = 0;
  private n = 0;
  private stepsPerWindow = 1;
  /** Horizontal path length flown in the current window, m. */
  private path = 0;
  private lastX: number | null = null;
  private lastZ: number | null = null;

  constructor(seed: number) {
    this.rng = new SeededRng(seed);
  }

  step(ctx: SubsystemContext, comms: CommsNetwork): void {
    const { state: s, config } = ctx;
    const cfg = config.radiation;
    this.stepsPerWindow = Math.max(1, Math.round(cfg.integrationTime_s / config.dt));
    const bee = s.bees.find((b) => b.id === RadiationSensor.DRONE)!;
    const airborne = bee.mode !== 'DOCKED' && bee.mode !== 'RELEASING';
    if (!airborne) return;

    if (!s.radiation.surveying) {
      s.radiation.surveying = true;
      this.lambda = 0;
      this.n = 0;
      this.sx = this.sy = this.sz = 0;
      this.path = 0;
      this.lastX = this.lastZ = null;
      ctx.log(
        bee.id,
        'RADIATION_SURVEY_START',
        `detector on: k=${cfg.sensitivity_cps_per_uSv_h} cps/(µSv/h), T=${cfg.integrationTime_s}s` + (cfg.maxSampleSpacing_m > 0 ? `, or every ${cfg.maxSampleSpacing_m} m flown` : ''),
      );
    }

    // accumulate expected counts and mean position over the window
    this.lambda += cfg.sensitivity_cps_per_uSv_h * trueDoseRate(cfg, bee.position) * config.dt;
    this.sx += bee.position.x;
    this.sy += bee.position.y;
    this.sz += bee.position.z;
    this.n += 1;
    if (this.lastX !== null && this.lastZ !== null) this.path += Math.hypot(bee.position.x - this.lastX, bee.position.z - this.lastZ);
    this.lastX = bee.position.x;
    this.lastZ = bee.position.z;

    const spaced = cfg.maxSampleSpacing_m > 0 && this.path >= cfg.maxSampleSpacing_m - 1e-9;
    if (this.n < this.stepsPerWindow && !spaced) return;

    const live = this.n * config.dt;
    const counts = poisson(this.rng, this.lambda);
    const p = { x: this.sx / this.n, y: this.sy / this.n, z: this.sz / this.n };
    const src = cfg.sourcePosition;
    const sample: RadiationSample = {
      id: s.radiation.samples.length + 1,
      step: s.step,
      time: s.time,
      droneId: bee.id,
      x: p.x,
      y: p.y,
      z: p.z,
      distance_m: Math.hypot(p.x - src.x, p.y - src.y, p.z - src.z),
      liveTime_s: live,
      counts,
      measured_uSv_h: (cfg.calibrationFactor * counts) / (cfg.sensitivity_cps_per_uSv_h * live),
      trueWindowMean_uSv_h: this.lambda / (cfg.sensitivity_cps_per_uSv_h * live),
      trueAtPosition_uSv_h: trueDoseRate(cfg, p),
    };
    s.radiation.samples.push(sample);
    s.radiation.latest = sample;
    if (!s.radiation.peakMeasured || sample.measured_uSv_h > s.radiation.peakMeasured.measured_uSv_h) {
      s.radiation.peakMeasured = sample;
    }
    this.lambda = 0;
    this.n = 0;
    this.sx = this.sy = this.sz = 0;
    this.path = 0;

    // only the MEASUREMENT is transmitted — never the truth
    comms.send(ctx, 'BEE-01', 'RAD_SAMPLE', {
      sample: sample.id,
      sampleTime: sample.time,
      measured: sample.measured_uSv_h,
      counts: sample.counts,
      liveTime: sample.liveTime_s,
      x: sample.x,
      y: sample.y,
      z: sample.z,
    });
  }
}
