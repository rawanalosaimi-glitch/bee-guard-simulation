import { initialRiskTracker, RISK_RANK, updateRiskTracker } from './riskStability';
import type { RiskTrackerState } from './riskStability';
import type { CasualtyConfig } from './config';
import { SeededRng } from './rng';
import type { CommsNetwork } from './comms';
import type { SubsystemContext } from './types';

/**
 * BEE-02 casualty detection and assessment — SIMULATED (docs/SIMULATION_MODEL.md §11).
 *
 * ILLUSTRATIVE ONLY. The physiology, sensor and risk rules below are
 * simulation assumptions for a research prototype. They are not a clinical
 * model, not a diagnostic device and must not be used for medical decisions.
 *
 * Ground truth (exactly one casualty):
 *   HR(t) = base + slope·t + amp·sin(2πt/period) + OU(σ, τ)     [beats/min]
 *   RR(t) = same form                                           [breaths/min]
 * Detection: every scanInterval, if the 3-D distance d ≤ R the scan succeeds
 *   with probability pMax·(1 − (d/R)²).
 * Vital-sign measurement (notional non-contact sensor), valid only when the
 *   casualty is detected, d ≤ R_v and bee speed ≤ v_max:
 *   measured = true + N(0, σ),  σ = σ0 + σ_d·d + σ_v·speed
 * Assessment: after N valid samples, the mean of the last N measured HR and RR
 *   values is classified with the rules in `classifyRisk`.
 * Body temperature (§40): a SEPARATE notional sensor — non-contact radiometric
 *   LWIR thermography of exposed skin. Truth: T_skin(t) = base + slope·t + OU(σ, τ)
 *   with its own RNG streams (never derived from HR/RR). Measured SKIN temperature
 *   = T_skin + N(0, σ_T), σ_T = σ0 + σ_d·d + σ_v·speed, valid only when d ≤ R_T,
 *   speed ≤ v_max and σ_T ≤ σ_max. It is NOT core body temperature, is not
 *   converted to core, and is not used by `classifyRisk`.
 */

export type CasualtyStatus = 'NOT_DETECTED' | 'IN_RANGE' | 'DETECTED' | 'ASSESSING' | 'ASSESSED' | 'ASSESSMENT_TIMEOUT';
export type RiskClass = 'LOW' | 'MODERATE' | 'HIGH';

export interface VitalsTruthSample {
  step: number;
  time: number;
  hr_true: number;
  rr_true: number;
  hrScore: number;
  rrScore: number;
  risk_true: RiskClass;
}

export interface VitalsMeasurement {
  id: number;
  step: number;
  time: number;
  droneId: string;
  x: number;
  y: number;
  z: number;
  distance_m: number;
  beeSpeed_mps: number;
  hr_measured: number;
  rr_measured: number;
  hrSigma: number;
  rrSigma: number;
  /** Not exported with measurements — kept for joining/tests only. */
  _truthStep: number;
}

/** Ground truth of the temperature model (simulator reference). */
export interface TemperatureTruthSample {
  step: number;
  time: number;
  /** True skin (surface) temperature of the exposed skin the sensor views, °C — the measurand. */
  skin_true_c: number;
  /** True core temperature, °C — reference only; no sensor in the simulation measures it. */
  core_true_c: number;
}

/** One body-temperature reading of the notional non-contact IR sensor on BEE-02 (skin temperature). */
export interface TemperatureMeasurement {
  id: number;
  step: number;
  time: number;
  droneId: string;
  x: number;
  y: number;
  z: number;
  distance_m: number;
  beeSpeed_mps: number;
  /** Measured SKIN (surface) temperature, °C. */
  skin_measured_c: number;
  /** 1σ measurement uncertainty, °C. */
  sigma_c: number;
  /** Not exported with measurements — kept for joining/tests only. */
  _truthStep: number;
}

export interface RiskAssessment {
  hr: number;
  rr: number;
  hrScore: number;
  rrScore: number;
  total: number;
  risk: RiskClass;
}

export interface CasualtyState {
  id: string;
  status: CasualtyStatus;
  /** Current ground truth (updated every step). */
  hrTrue: number;
  rrTrue: number;
  truthTimeline: VitalsTruthSample[];
  measurements: VitalsMeasurement[];
  /** §40: current true skin / core temperature (updated every step), °C. */
  skinTempTrue_c: number;
  coreTempTrue_c: number;
  temperatureTruth: TemperatureTruthSample[];
  /** Accepted skin-temperature readings (BEE-02, non-contact IR). */
  temperatureMeasurements: TemperatureMeasurement[];
  /** Sampling opportunities rejected because σ exceeded the maximum. */
  temperatureRejected: number;
  scans: number;
  firstInRangeTime: number | null;
  detectionTime: number | null;
  detectionDistance_m: number | null;
  /**
   * Drone-side estimate of the casualty's ground position (inverse-variance
   * mean of all position fixes). This — not the true position — is what is
   * transmitted and used for evacuation planning.
   */
  locationEstimate: { x: number; z: number; sigma_m: number; fixes: number; sampleTime: number } | null;
  firstVitalsTime: number | null;
  assessmentTime: number | null;
  /**
   * v0.7.0 Fix B: stabilized reporting of the risk class (riskStability.ts). `estimate.risk` stays the
   * RAW class of the latest window (v0.6.0 meaning); `riskTracker.reported` is what is transmitted.
   */
  riskTracker: RiskTrackerState;
  /** One record per assessment window: raw and reported class, borderline flag, and the TRUE class over the same window (evaluation only). */
  riskTimeline: { time: number; raw: RiskClass; reported: RiskClass; borderline: boolean; truth: RiskClass | null }[];
  /** Measured estimate (mean of last N valid samples). */
  estimate: RiskAssessment | null;
  /** Ground-truth classification over the same sample times as `estimate`. */
  truthAtEstimate: RiskAssessment | null;
  /** Assessment as frozen at ASSESSMENT_COMPLETE. */
  initialAssessment: RiskAssessment | null;
  initialTruthAssessment: RiskAssessment | null;
  detectionDelayFromRelease_s: number | null;
  detectionDelayFromInRange_s: number | null;
  assessmentDelay_s: number | null;
}

// ------------------------------------------------------------ risk rules

/**
 * ILLUSTRATIVE score bands. They follow the HR and RR bands of the UK
 * National Early Warning Score 2 (NEWS2), used here only as a familiar,
 * published reference point for a demo. Only two of NEWS2's seven
 * parameters are used, so this is NOT NEWS2 and has no clinical validity.
 *
 *   HR (beats/min): ≤40 → 3 · 41–50 → 1 · 51–90 → 0 · 91–110 → 1 · 111–130 → 2 · ≥131 → 3
 *   RR (breaths/min): ≤8 → 3 · 9–11 → 1 · 12–20 → 0 · 21–24 → 2 · ≥25 → 3
 * Values are rounded to the nearest integer before banding.
 */
export function hrScore(hr: number): number {
  const v = Math.round(hr);
  if (v <= 40) return 3;
  if (v <= 50) return 1;
  if (v <= 90) return 0;
  if (v <= 110) return 1;
  if (v <= 130) return 2;
  return 3;
}

export function rrScore(rr: number): number {
  const v = Math.round(rr);
  if (v <= 8) return 3;
  if (v <= 11) return 1;
  if (v <= 20) return 0;
  if (v <= 24) return 2;
  return 3;
}

/**
 * Illustrative risk class (simulation demo rule, not clinical):
 *   HIGH     if total ≥ 5 or any single score = 3
 *   MODERATE if total 3–4
 *   LOW      if total 0–2
 */
export function classifyRisk(hr: number, rr: number): RiskAssessment {
  const h = hrScore(hr);
  const r = rrScore(rr);
  const total = h + r;
  const risk: RiskClass = total >= 5 || h === 3 || r === 3 ? 'HIGH' : total >= 3 ? 'MODERATE' : 'LOW';
  return { hr, rr, hrScore: h, rrScore: r, total, risk };
}

export function initialCasualtyState(cfg: CasualtyConfig, id: string): CasualtyState {
  return {
    id,
    status: 'NOT_DETECTED',
    hrTrue: cfg.hr.base,
    rrTrue: cfg.rr.base,
    truthTimeline: [],
    measurements: [],
    skinTempTrue_c: cfg.temperature.skinBase_c,
    coreTempTrue_c: cfg.temperature.coreBase_c,
    temperatureTruth: [],
    temperatureMeasurements: [],
    temperatureRejected: 0,
    scans: 0,
    firstInRangeTime: null,
    detectionTime: null,
    detectionDistance_m: null,
    locationEstimate: null,
    firstVitalsTime: null,
    assessmentTime: null,
    riskTracker: initialRiskTracker(),
    riskTimeline: [],
    estimate: null,
    truthAtEstimate: null,
    initialAssessment: null,
    initialTruthAssessment: null,
    detectionDelayFromRelease_s: null,
    detectionDelayFromInRange_s: null,
    assessmentDelay_s: null,
  };
}

export class CasualtyAssessor {
  static readonly DRONE = 'BEE-02';
  private truthRng: SeededRng;
  private detectRng: SeededRng;
  private noiseRng: SeededRng;
  private locRng: SeededRng;
  private locSumW = 0;
  private locSumX = 0;
  private locSumZ = 0;
  private ouHr = 0;
  private ouRr = 0;
  private nextStatusTime = Number.POSITIVE_INFINITY;
  private truthByStep = new Map<number, VitalsTruthSample>();
  private tempTruthRng: SeededRng;
  private tempNoiseRng: SeededRng;
  private ouSkin = 0;
  /** Latest accepted temperature reading not yet transmitted (sent with the next VITALS packet). */
  private pendingTemp: TemperatureMeasurement | null = null;

  constructor(truthSeed: number, detectSeed: number, noiseSeed: number, locSeed: number, tempTruthSeed: number, tempNoiseSeed: number) {
    this.tempTruthRng = new SeededRng(tempTruthSeed);
    this.tempNoiseRng = new SeededRng(tempNoiseSeed);
    this.locRng = new SeededRng(locSeed);
    this.truthRng = new SeededRng(truthSeed);
    this.detectRng = new SeededRng(detectSeed);
    this.noiseRng = new SeededRng(noiseSeed);
  }

  /**
   * One position fix of the casualty from the drone (notional sensor):
   * fix = true + N(0, σ) per horizontal axis, σ = 0.5 m + 0.05·d.
   * Combined estimate = inverse-variance weighted mean of all fixes.
   * Uses its own RNG stream, so Phase-2 outputs are unaffected.
   */
  private addLocationFix(ctx: SubsystemContext, d: number): void {
    const cp = ctx.world.casualty.position;
    const c = ctx.state.casualty;
    const sigma = 0.5 + 0.05 * d;
    const fx = cp.x + sigma * this.locRng.gaussian();
    const fz = cp.z + sigma * this.locRng.gaussian();
    const w = 1 / (sigma * sigma);
    this.locSumW += w;
    this.locSumX += w * fx;
    this.locSumZ += w * fz;
    c.locationEstimate = {
      x: this.locSumX / this.locSumW,
      z: this.locSumZ / this.locSumW,
      sigma_m: 1 / Math.sqrt(this.locSumW),
      fixes: (c.locationEstimate?.fixes ?? 0) + 1,
      sampleTime: ctx.state.time,
    };
  }

  /** Ground-truth physiology, advanced every fixed step (independent of sensing). */
  updateTruth(ctx: SubsystemContext): void {
    const { state: s, config } = ctx;
    const cfg = config.casualty;
    const dt = config.dt;
    const t = s.time;
    const ou = (x: number, sigma: number, tau: number) => {
      const a = dt / tau;
      return x - a * x + sigma * Math.sqrt(2 * a) * this.truthRng.gaussian();
    };
    if (s.step > 0) {
      this.ouHr = ou(this.ouHr, cfg.hr.ouSigma, cfg.hr.ouTau_s);
      this.ouRr = ou(this.ouRr, cfg.rr.ouSigma, cfg.rr.ouTau_s);
    }
    const c = s.casualty;
    c.hrTrue = clamp(cfg.hr.base + cfg.hr.slope_per_s * t + cfg.hr.amp * Math.sin((2 * Math.PI * t) / cfg.hr.period_s) + this.ouHr, 20, 220);
    c.rrTrue = clamp(cfg.rr.base + cfg.rr.slope_per_s * t + cfg.rr.amp * Math.sin((2 * Math.PI * t) / cfg.rr.period_s + 1) + this.ouRr, 4, 60);

    // §40 temperature truth — own model and own RNG stream (independent of HR / RR)
    const tc = cfg.temperature;
    if (s.step > 0) {
      const a = dt / tc.skinOuTau_s;
      this.ouSkin = this.ouSkin - a * this.ouSkin + tc.skinOuSigma_c * Math.sqrt(2 * a) * this.tempTruthRng.gaussian();
    }
    c.skinTempTrue_c = clamp(tc.skinBase_c + tc.skinSlope_c_per_s * t + this.ouSkin, 20, 42);
    c.coreTempTrue_c = clamp(tc.coreBase_c + tc.coreSlope_c_per_s * t, 30, 43);

    const every = Math.max(1, Math.round(cfg.truthInterval_s / dt));
    if (s.step % every === 0) c.temperatureTruth.push({ step: s.step, time: s.time, skin_true_c: c.skinTempTrue_c, core_true_c: c.coreTempTrue_c });
    if (s.step % every === 0) {
      const r = classifyRisk(c.hrTrue, c.rrTrue);
      const ts: VitalsTruthSample = {
        step: s.step,
        time: s.time,
        hr_true: c.hrTrue,
        rr_true: c.rrTrue,
        hrScore: r.hrScore,
        rrScore: r.rrScore,
        risk_true: r.risk,
      };
      c.truthTimeline.push(ts);
      this.truthByStep.set(s.step, ts);
    }
  }

  step(ctx: SubsystemContext, comms: CommsNetwork): void {
    const { state: s, config, world } = ctx;
    const cfg = config.casualty;
    const c = s.casualty;
    const bee = s.bees.find((b) => b.id === CasualtyAssessor.DRONE)!;
    if (bee.mode === 'DOCKED' || bee.mode === 'RELEASING') return;
    const cp = world.casualty.position;
    const d = Math.hypot(bee.position.x - cp.x, bee.position.y - cp.y, bee.position.z - cp.z);
    const speed = Math.hypot(bee.velocity.x, bee.velocity.y, bee.velocity.z);
    const dt = config.dt;

    // --- detection scans
    const scanEvery = Math.max(1, Math.round(cfg.detection.scanInterval_s / dt));
    if (c.detectionTime === null && s.step % scanEvery === 0) {
      c.scans += 1;
      const R = cfg.detection.range_m;
      const u = this.detectRng.next(); // drawn on every scan, in range or not
      if (d <= R) {
        if (c.firstInRangeTime === null) {
          c.firstInRangeTime = s.time;
          c.status = 'IN_RANGE';
          ctx.log(bee.id, 'CASUALTY_IN_RANGE', `${c.id} d=${d.toFixed(1)}m (range ${R}m)`);
        }
        const p = cfg.detection.pMax * (1 - (d / R) ** 2);
        if (u < p) {
          c.detectionTime = s.time;
          c.detectionDistance_m = d;
          c.status = 'DETECTED';
          c.detectionDelayFromRelease_s = bee.releaseTime !== null ? s.time - bee.releaseTime : null;
          c.detectionDelayFromInRange_s = s.time - c.firstInRangeTime;
          ctx.log(
            bee.id,
            'CASUALTY_DETECTED',
            `${c.id} d=${d.toFixed(1)}m scans=${c.scans} delay_from_release=${fmt(c.detectionDelayFromRelease_s)}s delay_from_in_range=${fmt(c.detectionDelayFromInRange_s)}s`,
          );
          this.addLocationFix(ctx, d);
          comms.send(ctx, 'BEE-02', 'CASUALTY_ALERT', {
            patient: c.id,
            status: 'DETECTED',
            sampleTime: s.time,
            detectedAt: s.time,
            distance: d,
            ...locPayload(c),
          });
          this.nextStatusTime = s.time + config.comms.statusInterval_s;
        }
      }
    }

    // --- timeout (also when the casualty was never detected)
    if (
      c.assessmentTime === null &&
      c.status !== 'ASSESSMENT_TIMEOUT' &&
      bee.routeCompleteTime !== null &&
      s.time - bee.routeCompleteTime > cfg.assessmentTimeout_s
    ) {
      c.status = 'ASSESSMENT_TIMEOUT';
      ctx.log(bee.id, 'ASSESSMENT_TIMEOUT', `${c.measurements.length} valid samples after ${cfg.assessmentTimeout_s}s on station`);
    }

    if (c.detectionTime === null || c.status === 'ASSESSMENT_TIMEOUT') return;

    // --- §40 body-temperature sampling (separate non-contact IR skin-temperature sensor)
    const tc = cfg.temperature;
    const tEvery = Math.max(1, Math.round(tc.sampleInterval_s / dt));
    if (tc.enabled && s.step % tEvery === 0 && d <= tc.range_m && speed <= tc.maxBeeSpeed_mps) {
      const sigma = tc.sigmaBase_c + tc.sigmaPerM_c * d + tc.motionSigmaPerMps_c * speed;
      const noise = this.tempNoiseRng.gaussian(); // drawn on every opportunity
      if (sigma <= tc.maxSigma_c) {
        const tm: TemperatureMeasurement = {
          id: c.temperatureMeasurements.length + 1,
          step: s.step,
          time: s.time,
          droneId: bee.id,
          x: bee.position.x,
          y: bee.position.y,
          z: bee.position.z,
          distance_m: d,
          beeSpeed_mps: speed,
          skin_measured_c: c.skinTempTrue_c + sigma * noise,
          sigma_c: sigma,
          _truthStep: s.step,
        };
        c.temperatureMeasurements.push(tm);
        this.pendingTemp = tm;
      } else c.temperatureRejected += 1;
    }

    // --- vital-sign sampling
    const vEvery = Math.max(1, Math.round(cfg.vitals.sampleInterval_s / dt));
    const valid = d <= cfg.vitals.range_m && speed <= cfg.vitals.maxBeeSpeed_mps;
    if (s.step % vEvery === 0 && valid) {
      const v = cfg.vitals;
      const hrSigma = v.hrSigmaBase + v.hrSigmaPerM * d + v.motionSigmaPerMps * speed;
      const rrSigma = v.rrSigmaBase + v.rrSigmaPerM * d + v.motionSigmaPerMps * 0.3 * speed;
      const m: VitalsMeasurement = {
        id: c.measurements.length + 1,
        step: s.step,
        time: s.time,
        droneId: bee.id,
        x: bee.position.x,
        y: bee.position.y,
        z: bee.position.z,
        distance_m: d,
        beeSpeed_mps: speed,
        hr_measured: Math.max(0, c.hrTrue + hrSigma * this.noiseRng.gaussian()),
        rr_measured: Math.max(0, c.rrTrue + rrSigma * this.noiseRng.gaussian()),
        hrSigma,
        rrSigma,
        _truthStep: s.step,
      };
      c.measurements.push(m);
      this.addLocationFix(ctx, d);
      if (c.firstVitalsTime === null) {
        c.firstVitalsTime = s.time;
        c.status = 'ASSESSING';
        ctx.log(bee.id, 'VITALS_ACQUISITION_START', `d=${d.toFixed(1)}m speed=${speed.toFixed(2)}m/s`);
      }

      const N = v.samplesForAssessment;
      if (c.measurements.length >= N) {
        const last = c.measurements.slice(-N);
        const est = classifyRisk(mean(last.map((x) => x.hr_measured)), mean(last.map((x) => x.rr_measured)));
        const truths = last.map((x) => this.truthByStep.get(x._truthStep)).filter((x): x is VitalsTruthSample => !!x);
        const tru = truths.length ? classifyRisk(mean(truths.map((x) => x.hr_true)), mean(truths.map((x) => x.rr_true))) : null;
        // v0.7.0 Fix B: stabilized reported class (raw class unchanged); SEM from the per-sample noise model
        const hrSem = Math.sqrt(mean(last.map((x) => x.hrSigma * x.hrSigma)) / N);
        const rrSem = Math.sqrt(mean(last.map((x) => x.rrSigma * x.rrSigma)) / N);
        const tr = updateRiskTracker(c.riskTracker, est.hr, est.rr, hrSem, rrSem, cfg.riskStabilization);
        c.riskTimeline.push({ time: s.time, raw: tr.raw, reported: tr.after, borderline: c.riskTracker.borderline, truth: tru ? tru.risk : null });
        const prevRisk = tr.before ?? undefined;
        c.estimate = est;
        c.truthAtEstimate = tru;
        if (c.assessmentTime === null) {
          c.assessmentTime = s.time;
          c.status = 'ASSESSED';
          c.assessmentDelay_s = s.time - c.detectionTime;
          c.initialAssessment = est;
          c.initialTruthAssessment = tru;
          ctx.log(
            bee.id,
            'ASSESSMENT_COMPLETE',
            `risk=${est.risk} (illustrative) HR=${est.hr.toFixed(1)} RR=${est.rr.toFixed(1)} score=${est.total} delay=${c.assessmentDelay_s.toFixed(2)}s`,
          );
          comms.send(ctx, 'BEE-02', 'CASUALTY_STATUS', statusPayload(c, s.time));
          this.nextStatusTime = s.time + config.comms.statusInterval_s;
        } else if (prevRisk && prevRisk !== tr.after) {
          const how = cfg.riskStabilization.enabled
            ? RISK_RANK[tr.after] > RISK_RANK[prevRisk]
              ? `; escalation confirmed over ${cfg.riskStabilization.escalateWindows} windows`
              : `; de-escalation confirmed over ${cfg.riskStabilization.deescalateWindows} windows beyond ${cfg.riskStabilization.marginSEM} SEM`
            : '';
          ctx.log(bee.id, 'RISK_CHANGED', `${prevRisk} → ${tr.after} (rolling mean of last ${N}${how})`);
        }
      }
      comms.send(ctx, 'BEE-02', 'VITALS', {
        patient: c.id,
        sample: m.id,
        sampleTime: m.time,
        hr: m.hr_measured,
        rr: m.rr_measured,
        status: c.status,
        risk: c.riskTracker.reported ?? 'PENDING',
        riskRaw: c.estimate?.risk ?? 'PENDING',
        riskBorderline: c.riskTracker.borderline ? 1 : 0,
        ...this.takeTempPayload(),
      });
    }

    // --- periodic status packet
    if (s.time + 1e-9 >= this.nextStatusTime) {
      comms.send(ctx, 'BEE-02', 'CASUALTY_STATUS', statusPayload(c, s.time));
      this.nextStatusTime += config.comms.statusInterval_s;
    }

  }

  /** Temperature fields piggy-backed on a VITALS packet (own sample id and own timestamp). */
  private takeTempPayload(): Record<string, number | string> {
    const t = this.pendingTemp;
    if (!t) return {};
    this.pendingTemp = null;
    return { tempSample: t.id, tempTime: t.time, skinTempC: t.skin_measured_c, tempSigmaC: t.sigma_c, tempModality: 'IR_SKIN' };
  }
}

function locPayload(c: CasualtyState): Record<string, number> {
  const L = c.locationEstimate;
  return L ? { estX: L.x, estZ: L.z, locSigma: L.sigma_m } : {};
}

function statusPayload(c: CasualtyState, t: number): Record<string, number | string> {
  const p: Record<string, number | string> = {
    patient: c.id,
    status: c.status,
    risk: c.riskTracker.reported ?? 'PENDING',
    riskRaw: c.estimate?.risk ?? 'PENDING',
    riskBorderline: c.riskTracker.borderline ? 1 : 0,
    sampleTime: t,
    ...locPayload(c),
  };
  if (c.detectionTime !== null) p.detectedAt = c.detectionTime;
  if (c.estimate) {
    p.hr = c.estimate.hr;
    p.rr = c.estimate.rr;
    p.hrScore = c.estimate.hrScore;
    p.rrScore = c.estimate.rrScore;
    p.total = c.estimate.total;
  }
  if (c.assessmentTime !== null) p.assessedAt = c.assessmentTime;
  return p;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2));
