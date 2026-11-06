import type { SimConfig } from './config';
import { corridorTruth, evaluateCorridor, meanSeparation } from './corridor';
import { doseProfile } from './doseProfile';
import type { DoseProfile } from './doseProfile';
import type { CorridorEvaluation } from './corridor';
import { gsRadiationGrid } from './evacuation';
import { CELL_ESTIMATED, gridLookup, interpolateIdw } from './heatmap';
import type { HeatmapGrid } from './heatmap';
import { planRoute } from './routePlanner';
import { conservativeEnvelope } from './conservative';
import type { ConservativeEnvelope, UnknownPolicy } from './conservative';
import type { P2, PlannerParams } from './routePlanner';
import type { SubsystemContext } from './types';
import type { WorldDefinition } from './world';

/**
 * Phase 3B+: recommended GROUND RESCUE-TEAM route from the team's start point (at the ground
 * station base) to the casualty — PLANNING ONLY, ground-station data only (docs/SIMULATION_MODEL.md §32).
 *
 *  1. Candidates: the deterministic A* walking planner (routePlanner.ts, 1 m cells, 1.5 m obstacle
 *     clearance — every obstacle blocks a walking team) is run with several radiation weights κ
 *     (cost = t·(1 + κ·max(0, Ḣ/B − 1)); κ = 0 is the plain shortest walkable route; unknown cells
 *     are costed at B × unknownMultiplier, an assumption only).
 *  2. Each distinct candidate is evaluated with the SAME rules as the Phase 3A corridors
 *     (evaluateCorridor): measured coverage, longest unmeasured gap, dose on measured stretches ± 1σ,
 *     total dose only when SURVEYED (unknown ground is never counted as zero).
 *  3. Recommendation: among VERIFIED candidates (SURVEYED and no measured rate ≥ maxRate) the
 *     lowest estimated total dose; a longer route is chosen over a shorter one only for a
 *     significant saving (> max(2σ, 10 %)), otherwise the doses are indistinguishable and the
 *     shorter route is the lowest feasible exposure. If none is verified, the route is shown as
 *     UNVERIFIED with the reasons — never as safe. v0.7.0 (Fix A, unknownPolicy =
 *     CONSERVATIVE_NEIGHBOURHOOD): the unverified fallback is the candidate with the lowest
 *     CONSERVATIVE estimate (measured stretches + unmeasured stretches at the conservative
 *     neighbourhood rate, conservative.ts), ties → better measured, then shorter. v0.6.0 rule
 *     (BACKGROUND_MULTIPLE): lowest ASSUMED dose with unknown stretches at B × unknownMultiplier.
 *     The two checks are reported separately (data check: SURVEYED; rate check: no measured rate ≥
 *     maxRate, an ILLUSTRATIVE PLANNING THRESHOLD, not a validated emergency-rescue limit) with the
 *     reason, and whether the casualty location itself is above the threshold.
 *  4. Sections of the recommended route are labelled MEASURED / ESTIMATED (IDW ≤ 12 m, display
 *     only) / UNKNOWN for the map.
 * The plan is recomputed when new GS data arrives (at most every replanInterval_s) and frozen when
 * the operator requests rescue. It stays in state after the drones return and the mission ends.
 */

export type RescueSectionKind = 'MEASURED' | 'ESTIMATED' | 'UNKNOWN';

export interface RescueSection {
  kind: RescueSectionKind;
  points: P2[];
  length_m: number;
}

export interface RescueCandidate {
  id: string;
  /** Radiation weight κ used to generate it (the lowest κ when several gave the same route). */
  kappa: number;
  label: string;
  waypoints: P2[];
  evaluation: CorridorEvaluation;
  /** Length on cells that only have an IDW estimate (no measurement), m, and the estimate's dose there, µSv (display only). */
  estimatedLength_m: number;
  estimatedDose_uSv: number;
  /** Dose ASSUMED for unknown stretches at B × unknownMultiplier (ranking of unverified routes only), µSv. */
  assumedUnknownDose_uSv: number;
  /**
   * v0.7.0: dose ASSUMED on the unmeasured stretches with the conservative neighbourhood rule, µSv, and
   * measured + that. A HEURISTIC CONSERVATIVE ESTIMATE — not a statistical upper bound. Null when the
   * v0.6.0 policy is in use or nothing has been measured at all.
   */
  unmeasuredConservativeDose_uSv: number | null;
  doseConservative_uSv: number | null;
  /** v0.7.0: data check (SURVEYED: ≥ surveyedFraction measured, no gap > maxGap) and rate check (no measured rate ≥ maxRate), reported separately. */
  dataCheck: 'PASS' | 'FAIL';
  rateCheck: 'PASS' | 'FAIL' | 'NO_DATA';
  /** Why it is not verified (null when verified). */
  unverifiedReason: UnverifiedReason | null;
  /** Dose ± 1σ of the same route on the 3×3 smoothed field — used to COMPARE candidates (selection), µSv. */
  selectionDose_uSv: number;
  selectionSigma_uSv: number;
  verified: boolean;
  /** Why it is not verified (empty when verified). */
  issues: string[];
  /** Cumulative dose along the route vs walking time (same data and rules as `evaluation`; chart only). */
  profile: DoseProfile;
}

export type RescueStatus = 'VERIFIED' | 'UNVERIFIED' | 'NO_ROUTE';
export type UnverifiedReason = 'NO_DATA' | 'INSUFFICIENT_DATA' | 'ABOVE_LIMIT' | 'INSUFFICIENT_DATA_AND_ABOVE_LIMIT';

/** Label shown with the rate threshold wherever it is reported (it is not a safety limit). */
export const RATE_LIMIT_LABEL = 'illustrative planning threshold — not a validated emergency-rescue safety limit';

export interface RescuePlan {
  planId: number;
  time: number;
  start: { id: string; label: string; x: number; z: number };
  goal: { patientId: string; x: number; z: number; sigma_m: number };
  basis: { gsRadiationSamples: number; measuredCells: number; locationSampleTime: number };
  candidates: RescueCandidate[];
  recommendedId: string | null;
  status: RescueStatus;
  /** v0.7.0: reason of the recommended route when UNVERIFIED (null otherwise). */
  unverifiedReason: UnverifiedReason | null;
  /** v0.7.0: rate threshold used, µSv/h (illustrative planning threshold), and the unknown-ground policy. */
  rateLimit_uSv_h: number;
  unknownPolicy: UnknownPolicy;
  /**
   * v0.7.0: measured rate of the heat-map cell containing the casualty location estimate (null =
   * unmeasured) and whether it is at or above the threshold (null = unknown). When true, EVERY
   * approach ends in an area above the threshold.
   */
  destination: { measuredRate_uSv_h: number | null; aboveLimit: boolean | null };
  rule: string;
  warnings: string[];
  /** Sections of the recommended route (measured / estimated / unknown), in walking order. */
  sections: RescueSection[];
  frozen: boolean;
}

export interface RescueState {
  enabled: boolean;
  plansComputed: number;
  current: RescuePlan | null;
  /** One row per (re)plan: time, recommended id, status, length, total / measured dose, coverage. */
  history: { planId: number; time: number; recommendedId: string | null; status: RescueStatus; length_m: number | null; dose_uSv: number | null; coverage: number | null }[];
}

/** Systematic dose uncertainty assumed when comparing routes (altitude, within-cell variation). */
export const SYSTEMATIC = 0.1;

/** Smoothed-field dose on the measured stretches (ranking of unverified routes). */
const smoothMeasured = (c: RescueCandidate) => c.selectionDose_uSv;

export function initialRescueState(config: SimConfig): RescueState {
  return { enabled: config.rescue.enabled, plansComputed: 0, current: null, history: [] };
}

/** Planner parameters for the start → casualty search (bounds: both points + evacuation margin, clipped to the site). */
export function rescueParams(config: SimConfig, world: WorldDefinition, a: P2, b: P2, kappa: number): PlannerParams {
  const cfg = config.evacuation;
  const H = world.opsAreaHalfSize;
  const m = cfg.margin_m;
  return {
    cell: cfg.cell_m,
    clearance: cfg.clearance_m,
    walkingSpeed_mps: cfg.walkingSpeed_mps,
    radiationWeight: kappa,
    unknownMultiplier: cfg.unknownMultiplier,
    background_uSv_h: config.radiation.background_uSv_h,
    bounds: {
      x0: Math.max(-H, Math.min(a.x, b.x) - m),
      z0: Math.max(-H, Math.min(a.z, b.z) - m),
      x1: Math.min(H, Math.max(a.x, b.x) + m),
      z1: Math.min(H, Math.max(a.z, b.z) + m),
    },
  };
}

/** Split a polyline into measured / estimated / unknown sections (0.5 m pieces, cell under the piece midpoint). */
export function rescueSections(pts: readonly P2[], grid: HeatmapGrid, estKind: Uint8Array | null): RescueSection[] {
  const out: RescueSection[] = [];
  const kindAt = (x: number, z: number): RescueSectionKind => {
    const ix = Math.floor((x - grid.x0) / grid.cell);
    const iz = Math.floor((z - grid.z0) / grid.cell);
    if (ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz) return 'UNKNOWN';
    const k = iz * grid.nx + ix;
    if (grid.counts[k] > 0) return 'MEASURED';
    return estKind && estKind[k] === CELL_ESTIMATED ? 'ESTIMATED' : 'UNKNOWN';
  };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / 0.5));
    for (let j = 0; j < n; j++) {
      const t0 = j / n;
      const t1 = (j + 1) / n;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const kind = kindAt((p0.x + p1.x) / 2, (p0.z + p1.z) / 2);
      const last = out[out.length - 1];
      if (last && last.kind === kind) {
        last.points.push(p1);
        last.length_m += L / n;
      } else out.push({ kind, points: [p0, p1], length_m: L / n });
    }
  }
  return out;
}

/**
 * Live-time-weighted 3×3-cell mean of the MEASURED cells (12 m with 4 m cells). Measured flags (counts)
 * are unchanged — no coverage is created. Used to PLAN and COMPARE rescue candidates: with ≈ 45 % counting
 * noise per background cell, a radiation-weighted planner on raw cells steers into cells that read low by
 * chance and then under-estimates its own route (selection bias; 200-seed sweep). Real gradients (a source
 * affects tens of metres) survive the smoothing.
 */
export function smoothedGrid(g: HeatmapGrid): HeatmapGrid {
  const values = new Float64Array(g.values.length).fill(Number.NaN);
  const countSum = new Float64Array(g.countSum.length);
  const liveSum = new Float64Array(g.liveSum.length);
  for (let iz = 0; iz < g.nz; iz++) {
    for (let ix = 0; ix < g.nx; ix++) {
      const k = iz * g.nx + ix;
      if (!(g.counts[k] > 0)) continue;
      let sv = 0;
      let sw = 0;
      let sc = 0;
      let sl = 0;
      for (let dz = -1; dz <= 1; dz++) {
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
      }
      values[k] = sv / sw;
      countSum[k] = sc;
      liveSum[k] = sl;
    }
  }
  return { ...g, values, countSum, liveSum };
}

/**
 * Dose assumed on the UNMEASURED stretches of a route (0.25 m pieces, the same pieces and the same
 * measured/unmeasured test as evaluateCorridor), at the conservative neighbourhood rate, µSv.
 * Null when there is no measurement at all.
 */
export function unmeasuredConservativeDose(pts: readonly P2[], grid: HeatmapGrid, env: ConservativeEnvelope, walkingSpeed_mps: number): number | null {
  if (env.globalMax === null) return null;
  let dose = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / 0.25));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const ix = Math.floor((x - grid.x0) / grid.cell);
      const iz = Math.floor((z - grid.z0) / grid.cell);
      const known = ix >= 0 && iz >= 0 && ix < grid.nx && iz < grid.nz && grid.counts[iz * grid.nx + ix] > 0;
      if (known) continue;
      dose += ((env.lookup(x, z) as number) * (L / n / walkingSpeed_mps)) / 3600;
    }
  }
  return dose;
}

export function unverifiedReasonOf(dataCheck: 'PASS' | 'FAIL', rateCheck: 'PASS' | 'FAIL' | 'NO_DATA'): UnverifiedReason | null {
  if (rateCheck === 'NO_DATA') return 'NO_DATA';
  if (dataCheck === 'FAIL' && rateCheck === 'FAIL') return 'INSUFFICIENT_DATA_AND_ABOVE_LIMIT';
  if (dataCheck === 'FAIL') return 'INSUFFICIENT_DATA';
  if (rateCheck === 'FAIL') return 'ABOVE_LIMIT';
  return null;
}

/** Plan the rescue route (pure: same inputs → same plan). */
export function computeRescuePlan(
  ctx: Pick<SubsystemContext, 'state' | 'config' | 'world'>,
  goal: RescuePlan['goal'],
  locationSampleTime: number,
  planId: number,
  /** Waypoints of the previously recommended route (hysteresis: kept unless another is lower by > 2σ). */
  previous: readonly P2[] | null = null,
): RescuePlan {
  const { config, world, state } = ctx;
  const rc = config.rescue;
  const grid = gsRadiationGrid(ctx);
  const smooth = smoothedGrid(grid);
  // plan on the smoothed field (no steering into single-cell noise); report on the measured cells
  const dose = gridLookup(smooth);
  const est = grid.filled ? interpolateIdw(grid, 12, 2) : null;
  const start = rc.start;
  const a = { x: start.x, z: start.z };
  const b = { x: goal.x, z: goal.z };
  const v = config.evacuation.walkingSpeed_mps;
  const B = config.radiation.background_uSv_h;
  const assumedUnknownRate = B * config.evacuation.unknownMultiplier;
  const policy = config.evacuation.unknownPolicy;
  // v0.7.0 Fix A: conservative rate for unmeasured ground, from the RAW received cells
  const env = policy === 'CONSERVATIVE_NEIGHBOURHOOD' ? conservativeEnvelope(grid, config.evacuation.conservativeRadius_m) : null;

  const candidates: RescueCandidate[] = [];
  for (let ki = 0; ki < rc.candidateWeights.length; ki++) {
    const kappa = rc.candidateWeights[ki];
    const res = planRoute(a, b, world.obstacles, dose, rescueParams(config, world, a, b, kappa), env ? env.lookup : undefined);
    if (!res.ok) continue;
    const wps = res.waypoints;
    const same = candidates.find((c) => c.waypoints.length === wps.length && c.waypoints.every((p, i) => Math.abs(p.x - wps[i].x) < 1e-6 && Math.abs(p.z - wps[i].z) < 1e-6));
    if (same) continue;
    const id = `R${ki + 1}`; // stable: one id per radiation weight (duplicates keep the lowest κ)
    const ev = evaluateCorridor(id, wps, grid, world.obstacles, config, state.time);
    const evS = evaluateCorridor(id, wps, smooth, world.obstacles, config, state.time);
    // estimated (IDW) stretches and their display-only dose
    let estLen = 0;
    let estDose = 0;
    if (est) {
      for (const s of rescueSections(wps, grid, est.kind)) {
        if (s.kind !== 'ESTIMATED') continue;
        estLen += s.length_m;
        for (let i = 1; i < s.points.length; i++) {
          const p = s.points[i - 1];
          const q = s.points[i];
          const mx = (p.x + q.x) / 2;
          const mz = (p.z + q.z) / 2;
          const ix = Math.floor((mx - grid.x0) / grid.cell);
          const iz = Math.floor((mz - grid.z0) / grid.cell);
          const r = est.values[iz * grid.nx + ix];
          if (Number.isFinite(r)) estDose += (r * (Math.hypot(q.x - p.x, q.z - p.z) / v)) / 3600;
        }
      }
    }
    const issues: string[] = [...ev.reasons];
    if (ev.maxRate_uSv_h !== null && ev.maxRate_uSv_h >= rc.maxRate_uSv_h) issues.push(`measured rate ${ev.maxRate_uSv_h.toFixed(2)} µSv/h ≥ ${rc.maxRate_uSv_h} µSv/h on the route`);
    const dataCheck: 'PASS' | 'FAIL' = ev.status === 'SURVEYED' ? 'PASS' : 'FAIL';
    const rateCheck: 'PASS' | 'FAIL' | 'NO_DATA' = ev.maxRate_uSv_h === null ? 'NO_DATA' : ev.maxRate_uSv_h >= rc.maxRate_uSv_h ? 'FAIL' : 'PASS';
    const unmeasCons = env ? unmeasuredConservativeDose(wps, grid, env, v) : null;
    candidates.push({
      id,
      kappa,
      label: kappa === 0 ? 'Shortest walkable' : `Radiation-weighted (κ = ${kappa})`,
      waypoints: wps,
      evaluation: ev,
      estimatedLength_m: estLen,
      estimatedDose_uSv: estDose,
      assumedUnknownDose_uSv: (assumedUnknownRate * (ev.unknownLength_m / v)) / 3600,
      unmeasuredConservativeDose_uSv: unmeasCons,
      doseConservative_uSv: unmeasCons === null ? null : ev.doseMeasured_uSv + unmeasCons,
      dataCheck,
      rateCheck,
      unverifiedReason: unverifiedReasonOf(dataCheck, rateCheck),
      selectionDose_uSv: evS.doseTotal_uSv ?? evS.doseMeasured_uSv,
      selectionSigma_uSv: evS.doseTotalSigma_uSv ?? evS.doseMeasuredSigma_uSv,
      verified: issues.length === 0,
      issues,
      profile: doseProfile(wps, grid, v, ev.status),
    });
  }

  let recommendedId: string | null = null;
  let status: RescueStatus = 'NO_ROUTE';
  let rule = 'no walkable route from the rescue-team start to the casualty estimate';
  const warnings: string[] = [];
  const verified = candidates.filter((c) => c.verified);
  if (verified.length) {
    // compare on the smoothed-field doses (see smoothedGrid) — the reported doses stay the measured-cell ones
    const byDose = [...verified].sort((p, q) => p.selectionDose_uSv - q.selectionDose_uSv || p.evaluation.length_m - q.evaluation.length_m);
    const best = byDose[0];
    // A longer route is preferred only for a SIGNIFICANT dose saving: more than max(2σ counting, 10 %
    // systematic — altitude, within-cell variation). Within that margin the doses are indistinguishable
    // and the shorter route (less exposure time, less uncertainty) is the lowest feasible exposure.
    const margin = (c: RescueCandidate) => Math.max(2 * Math.hypot(c.selectionSigma_uSv, best.selectionSigma_uSv), SYSTEMATIC * best.selectionDose_uSv);
    const equivalent = verified.filter((c) => c.selectionDose_uSv - best.selectionDose_uSv <= margin(c));
    const shortest = [...equivalent].sort((p, q) => p.evaluation.length_m - q.evaluation.length_m)[0];
    let pick = shortest;
    // hysteresis: keep the previously recommended route while it is still verified and equivalent
    if (previous && previous.length > 1) {
      const keep = equivalent.find((c) => meanSeparation(c.waypoints, previous) < 1 && meanSeparation(previous, c.waypoints) < 1);
      if (keep) pick = keep;
    }
    recommendedId = pick.id;
    status = 'VERIFIED';
    rule =
      pick === best
        ? 'lowest estimated cumulative dose among verified routes (enough measured coverage, no measured rate at or above the limit; candidates compared on a 12 m smoothed dose field)'
        : `${pick.id} is within the dose uncertainty of the lowest estimate (${best.id}; margin max(2σ, ${Math.round(SYSTEMATIC * 100)} %), 12 m smoothed field) — the doses are indistinguishable, so the ${pick === shortest ? 'shorter' : 'previously recommended'} route is kept`;
  } else if (candidates.length) {
    const cons = (c: RescueCandidate) => c.doseConservative_uSv ?? Number.POSITIVE_INFINITY;
    const pick =
      policy === 'CONSERVATIVE_NEIGHBOURHOOD'
        ? [...candidates].sort((p, q) => cons(p) - cons(q) || q.evaluation.coverage - p.evaluation.coverage || p.evaluation.length_m - q.evaluation.length_m)[0]
        : [...candidates].sort((p, q) => (smoothMeasured(p) + p.assumedUnknownDose_uSv) - (smoothMeasured(q) + q.assumedUnknownDose_uSv) || p.evaluation.length_m - q.evaluation.length_m)[0];
    recommendedId = pick.id;
    status = 'UNVERIFIED';
    rule =
      policy === 'CONSERVATIVE_NEIGHBOURHOOD'
        ? `no candidate is verified — showing the lowest CONSERVATIVE estimate (unmeasured ground at the highest measured rate within ${config.evacuation.conservativeRadius_m} m, else the map maximum; heuristic, not a statistical bound)`
        : `no candidate is verified — showing the lowest ASSUMED dose (unknown ground costed at ${config.evacuation.unknownMultiplier}× background)`;
    warnings.push('No sufficiently verified low-exposure route: radiation data along every candidate is incomplete or above the limit. Do not treat this route as safe.');
    warnings.push(...pick.issues);
  }
  const rec = candidates.find((c) => c.id === recommendedId) ?? null;
  // v0.7.0: the casualty location itself (cell containing the estimate) against the threshold
  const gi = Math.floor((b.x - grid.x0) / grid.cell);
  const gj = Math.floor((b.z - grid.z0) / grid.cell);
  const gk = gi >= 0 && gj >= 0 && gi < grid.nx && gj < grid.nz && grid.counts[gj * grid.nx + gi] > 0 ? gj * grid.nx + gi : -1;
  const destRate = gk >= 0 ? grid.values[gk] : null;
  const destination = { measuredRate_uSv_h: destRate, aboveLimit: destRate === null ? null : destRate >= rc.maxRate_uSv_h };
  if (rec && rec.rateCheck === 'FAIL') warnings.push(`${rc.maxRate_uSv_h} µSv/h is an ${RATE_LIMIT_LABEL}.`);
  if (destination.aboveLimit) warnings.push(`The casualty location itself reads ${(destRate as number).toFixed(2)} µSv/h ≥ ${rc.maxRate_uSv_h} µSv/h (measured at survey altitude): every approach ends in an area above the planning threshold.`);
  if (rec && rec.doseConservative_uSv !== null && rec.evaluation.unknownLength_m > 0.5)
    warnings.push(`Conservative estimate ${rec.doseConservative_uSv.toExponential(2)} µSv assumes the unmeasured stretches at the highest nearby measured rate — a heuristic, not a guaranteed upper bound.`);
  const sections = rec ? rescueSections(rec.waypoints, grid, est ? est.kind : null) : [];
  if (rec) {
    const unk = sections.filter((s) => s.kind === 'UNKNOWN').reduce((m, s) => m + s.length_m, 0);
    const estL = sections.filter((s) => s.kind === 'ESTIMATED').reduce((m, s) => m + s.length_m, 0);
    if (unk > 0.5) warnings.push(`${unk.toFixed(0)} m of the route has NO radiation data (unknown — dose not counted).`);
    if (estL > 0.5) warnings.push(`${estL.toFixed(0)} m crosses ground with an interpolated ESTIMATE only (not measured).`);
  }
  return {
    planId,
    time: state.time,
    start: { ...start },
    goal: { ...goal },
    basis: { gsRadiationSamples: state.comms.gs.radiationSamples.length, measuredCells: grid.filled, locationSampleTime },
    candidates,
    recommendedId,
    status,
    unverifiedReason: status === 'UNVERIFIED' && rec ? rec.unverifiedReason : null,
    rateLimit_uSv_h: rc.maxRate_uSv_h,
    unknownPolicy: policy,
    destination,
    rule,
    warnings,
    sections,
    frozen: false,
  };
}

/** Reference dose of a rescue candidate from the TRUE field at 1 m and at survey altitude (ground-truth export only). */
export function rescueTruth(c: RescueCandidate, config: SimConfig): { at1m: { dose_uSv: number; maxRate_uSv_h: number }; atSurvey: { dose_uSv: number; maxRate_uSv_h: number } } {
  return { at1m: corridorTruth(c.waypoints, config, 1), atSurvey: corridorTruth(c.waypoints, config, config.survey.altitude_m) };
}

export class RescueManager {
  private lastPlanTime = -Infinity;
  private lastBasis = '';

  step(ctx: SubsystemContext): void {
    const { state: s, config } = ctx;
    const rs = s.rescue;
    if (!rs.enabled) return;
    const p = s.comms.gs.patients.find((x) => x.location !== null && x.assessment !== null);
    if (!p || !p.location) return;
    if (rs.current?.frozen) return;
    // freeze with the evacuation case when the operator requests rescue
    const c = s.evacuation.cases.find((x) => x.patientId === p.patientId);
    if (rs.current && c && c.frozen) {
      rs.current.frozen = true;
      ctx.log('GS-1', 'RESCUE_ROUTE_PLANNED', `rescue route plan#${rs.current.planId} frozen (operator requested rescue)`);
      return;
    }
    const basis = `${s.comms.gs.radiationSamples.length}|${p.location.sampleTime}`;
    if (rs.current && (basis === this.lastBasis || s.time - this.lastPlanTime < config.rescue.replanInterval_s - 1e-9)) return;
    this.lastBasis = basis;
    this.lastPlanTime = s.time;
    const prev = rs.current;
    const prevRec = prev?.candidates.find((k) => k.id === prev.recommendedId)?.waypoints ?? null;
    const plan = computeRescuePlan(ctx, { patientId: p.patientId, x: p.location.x, z: p.location.z, sigma_m: p.location.sigma_m }, p.location.sampleTime, ++rs.plansComputed, prev?.status === 'VERIFIED' ? prevRec : null);
    rs.current = plan;
    const rec = plan.candidates.find((k) => k.id === plan.recommendedId) ?? null;
    rs.history.push({
      planId: plan.planId,
      time: plan.time,
      recommendedId: plan.recommendedId,
      status: plan.status,
      length_m: rec ? rec.evaluation.length_m : null,
      dose_uSv: rec ? (rec.evaluation.doseTotal_uSv ?? rec.evaluation.doseMeasured_uSv) : null,
      coverage: rec ? rec.evaluation.coverage : null,
    });
    const changed = !prev || prev.status !== plan.status || prev.recommendedId !== plan.recommendedId || (prevRec !== null && rec !== null && meanSeparation(rec.waypoints, prevRec) > 1);
    if (!rec) {
      if (changed) ctx.log('GS-1', 'RESCUE_ROUTE_FAILED', `plan#${plan.planId}: ${plan.rule}`);
      return;
    }
    if (changed) {
      const ev = rec.evaluation;
      ctx.log(
        'GS-1',
        'RESCUE_ROUTE_PLANNED',
        `plan#${plan.planId} ${plan.status}: ${rec.id} (${rec.label}) ${ev.length_m.toFixed(0)} m, ${(ev.walkTime_s / 60).toFixed(1)} min, ` +
          `${Math.round(ev.coverage * 100)}% measured, dose ${ev.doseTotal_uSv !== null ? ev.doseTotal_uSv.toExponential(2) : `≥ ${ev.doseMeasured_uSv.toExponential(2)}`} µSv; ` +
          `${plan.candidates.length} candidate(s), from ${plan.start.id} to ${plan.goal.patientId}`,
      );
    }
  }
}

