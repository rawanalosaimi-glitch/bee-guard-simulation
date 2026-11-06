import { buildGrid, gridLookup } from './heatmap';
import type { HeatmapGrid } from './heatmap';
import type { PatientRecord } from './comms';
import { planRoute, evaluateRoute } from './routePlanner';
import { conservativeEnvelope } from './conservative';
import type { UnknownPolicy } from './conservative';
import type { P2, PlannerParams, RouteMetrics, RouteRun } from './routePlanner';
import type { SubsystemContext } from './types';

/**
 * Casualty evacuation workflow — PLANNING ONLY (docs/SIMULATION_MODEL.md §14).
 *
 * Runs "at the ground station": it only uses data that reached the GS
 * (patient records, received radiation samples) plus the known site map
 * (obstacle footprints). It never reads ground truth.
 *
 * Stages (one case per reported patient):
 *   DETECTED        GS received a detection for this patient
 *   ASSESSED        GS received an assessment (HR/RR + illustrative risk)
 *   ROUTE_PLANNED   a walkable route to the collection point was computed
 *   AWAITING_RESCUE operator requested the rescue team (route frozen)
 *   EVACUATED       operator CONFIRMED the evacuation (manual input)
 *
 * Nothing moves the casualty: no rescue team is simulated, and EVACUATED is
 * set only by an explicit operator confirmation — never because a route exists.
 */

export type EvacStage = 'DETECTED' | 'ASSESSED' | 'ROUTE_PLANNED' | 'AWAITING_RESCUE' | 'EVACUATED';
export const EVAC_STAGES: readonly EvacStage[] = ['DETECTED', 'ASSESSED', 'ROUTE_PLANNED', 'AWAITING_RESCUE', 'EVACUATED'];

export interface EvacPlan {
  planId: number;
  patientId: string;
  time: number;
  step: number;
  start: P2;
  startSigma_m: number;
  goal: P2 & { id: string };
  /** What the plan was based on. */
  basis: {
    gsRadiationSamples: number;
    latestRadiationSampleTime: number | null;
    measuredCells: number;
    totalCells: number;
    locationSampleTime: number;
  };
  params: PlannerParams;
  /** v0.7.0: how unmeasured ground was costed (and, for CONSERVATIVE_NEIGHBOURHOOD, the radius, m). */
  unknownPolicy: UnknownPolicy;
  conservativeRadius_m: number | null;
  ok: boolean;
  failReason: string | null;
  waypoints: P2[];
  runs: RouteRun[];
  metrics: RouteMetrics | null;
  /** Radiation-agnostic shortest walkable route, evaluated on the same measured map. */
  shortest: { waypoints: P2[]; metrics: RouteMetrics } | null;
}

export interface OperatorAction {
  step: number;
  time: number;
  patientId: string;
  action: 'REQUEST_RESCUE' | 'CONFIRM_EVACUATED';
  accepted: boolean;
  note: string;
}

export interface EvacuationCase {
  patientId: string;
  stage: EvacStage;
  stageTimes: Partial<Record<EvacStage, number>>;
  plans: EvacPlan[];
  /** Plan currently proposed (latest successful) or frozen at AWAITING_RESCUE. */
  activePlanId: number | null;
  frozen: boolean;
  evacuatedBy: 'OPERATOR_CONFIRMATION' | null;
}

export interface EvacuationState {
  planningOnly: true;
  cases: EvacuationCase[];
  operatorActions: OperatorAction[];
  plansComputed: number;
}

export const initialEvacuationState = (): EvacuationState => ({
  planningOnly: true,
  cases: [],
  operatorActions: [],
  plansComputed: 0,
});

const order = (s: EvacStage) => EVAC_STAGES.indexOf(s);

/** Grid of the radiation measurements RECEIVED at the ground station. */
export function gsRadiationGrid(ctx: Pick<SubsystemContext, 'state' | 'config'>): HeatmapGrid {
  return buildGrid(
    ctx.state.comms.gs.radiationSamples.map((r) => ({ x: r.x, y: r.y, z: r.z, value: r.measured_uSv_h, time: r.sampleTime, counts: r.counts, live: r.liveTime_s })),
    ctx.config.radiation.heatmap,
  );
}

export class EvacuationManager {
  private lastPlanTime = new Map<string, number>();
  private lastBasis = new Map<string, string>();

  step(ctx: SubsystemContext): void {
    const ev = ctx.state.evacuation;
    for (const p of ctx.state.comms.gs.patients) {
      let c = ev.cases.find((x) => x.patientId === p.patientId);
      if (!c) {
        c = { patientId: p.patientId, stage: 'DETECTED', stageTimes: { DETECTED: ctx.state.time }, plans: [], activePlanId: null, frozen: false, evacuatedBy: null };
        ev.cases.push(c);
        ctx.log('GS-1', 'EVAC_STAGE', `${p.patientId} → DETECTED (GS received detection)`);
      }
      if (p.assessment && order(c.stage) < order('ASSESSED')) this.setStage(ctx, c, 'ASSESSED', 'GS received assessment');
      if (order(c.stage) >= order('ASSESSED') && !c.frozen && p.location) this.maybePlan(ctx, c, p);
    }
  }

  private setStage(ctx: SubsystemContext, c: EvacuationCase, stage: EvacStage, why: string): void {
    c.stage = stage;
    c.stageTimes[stage] = ctx.state.time;
    ctx.log('GS-1', 'EVAC_STAGE', `${c.patientId} → ${stage} (${why})`);
  }

  private maybePlan(ctx: SubsystemContext, c: EvacuationCase, p: PatientRecord): void {
    const cfg = ctx.config.evacuation;
    const t = ctx.state.time;
    const last = this.lastPlanTime.get(c.patientId);
    const gsRad = ctx.state.comms.gs.radiationSamples;
    // Re-plan only when the measurements that can affect this route changed: samples
    // inside the planning bounds (+1 cell), or a new location estimate.
    const bnd = planBounds(ctx, p);
    const pad = ctx.config.radiation.heatmap.cell;
    let inside = 0;
    for (const r of gsRad) if (r.x >= bnd.x0 - pad && r.x <= bnd.x1 + pad && r.z >= bnd.z0 - pad && r.z <= bnd.z1 + pad) inside++;
    const basis = `${inside}|${p.location!.sampleTime}`;
    if (last !== undefined && (t - last < cfg.replanInterval_s - 1e-9 || this.lastBasis.get(c.patientId) === basis)) return;
    this.lastPlanTime.set(c.patientId, t);
    this.lastBasis.set(c.patientId, basis);

    const plan = computeEvacPlan(ctx, p, ctx.state.evacuation.plansComputed + 1);
    ctx.state.evacuation.plansComputed += 1;
    c.plans.push(plan);
    if (plan.ok) {
      c.activePlanId = plan.planId;
      ctx.log(
        'GS-1',
        'EVAC_ROUTE_PLANNED',
        `${c.patientId} plan#${plan.planId} length=${plan.metrics!.length_m.toFixed(1)}m unknown=${(plan.metrics!.unknownFraction * 100).toFixed(0)}% ` +
          `measured-stretch dose=${plan.metrics!.doseMeasuredStretches_uSv.toExponential(2)}µSv` +
          (plan.metrics!.doseConservative_uSv !== null ? ` conservative est.=${plan.metrics!.doseConservative_uSv.toExponential(2)}µSv (heuristic)` : '') +
          ' (planning only)',
      );
      if (order(c.stage) < order('ROUTE_PLANNED')) this.setStage(ctx, c, 'ROUTE_PLANNED', `plan#${plan.planId}`);
    } else {
      ctx.log('GS-1', 'EVAC_PLAN_FAILED', `${c.patientId} plan#${plan.planId} reason=${plan.failReason}`);
    }
  }

  /** Operator input. Returns whether the action was accepted. Logged either way. */
  command(ctx: SubsystemContext, patientId: string, action: OperatorAction['action']): boolean {
    const ev = ctx.state.evacuation;
    const c = ev.cases.find((x) => x.patientId === patientId);
    let accepted = false;
    let note = '';
    if (!c) note = 'unknown patient';
    else if (action === 'REQUEST_RESCUE') {
      if (c.stage === 'ROUTE_PLANNED' && c.activePlanId !== null) {
        c.frozen = true;
        const cd = ctx.state.corridor;
        const sel = cd.enabled && cd.decision.selectedId ? `; corridor ${cd.decision.selectedId} ${cd.decision.final ? cd.decision.status : 'PENDING'}${cd.decision.provisional ? ' (provisional)' : ''}` : '';
        this.setStage(ctx, c, 'AWAITING_RESCUE', `operator requested rescue on plan#${c.activePlanId}${sel}`);
        accepted = true;
        note = `route plan#${c.activePlanId} frozen${sel}`;
      } else note = `not allowed in stage ${c.stage}`;
    } else if (action === 'CONFIRM_EVACUATED') {
      if (c.stage === 'AWAITING_RESCUE') {
        c.evacuatedBy = 'OPERATOR_CONFIRMATION';
        this.setStage(ctx, c, 'EVACUATED', 'operator confirmation (manual — no rescue movement is simulated)');
        accepted = true;
        note = 'manual confirmation';
      } else note = `not allowed in stage ${c.stage}`;
    }
    ev.operatorActions.push({ step: ctx.state.step, time: ctx.state.time, patientId, action, accepted, note });
    ctx.log('OPERATOR', 'OPERATOR_ACTION', `${action} ${patientId}: ${accepted ? 'accepted' : 'rejected'} (${note})`);
    return accepted;
  }
}

export function computeEvacPlan(ctx: Pick<SubsystemContext, 'state' | 'config' | 'world'>, p: PatientRecord, planId: number): EvacPlan {
  const { config, world, state } = ctx;
  const cfg = config.evacuation;
  const grid = gsRadiationGrid(ctx);
  const dose = gridLookup(grid);
  const start = { x: p.location!.x, z: p.location!.z };
  const gp = cfg.collectionPoint.position;
  const goal = { x: gp.x, z: gp.z };
  const bounds = planBounds(ctx, p);
  const params: PlannerParams = {
    cell: cfg.cell_m,
    clearance: cfg.clearance_m,
    walkingSpeed_mps: cfg.walkingSpeed_mps,
    radiationWeight: cfg.radiationWeight,
    unknownMultiplier: cfg.unknownMultiplier,
    background_uSv_h: config.radiation.background_uSv_h,
    bounds,
  };
  // v0.7.0 Fix A: unmeasured ground is costed with the conservative neighbourhood rule (conservative.ts)
  const cons = cfg.unknownPolicy === 'CONSERVATIVE_NEIGHBOURHOOD' ? conservativeEnvelope(grid, cfg.conservativeRadius_m) : null;
  const unk = cons ? cons.lookup : undefined;
  const res = planRoute(start, goal, world.obstacles, dose, params, unk);
  const short = planRoute(start, goal, world.obstacles, dose, { ...params, radiationWeight: 0 }, unk);
  const gsRad = state.comms.gs.radiationSamples;
  return {
    planId,
    patientId: p.patientId,
    time: state.time,
    step: state.step,
    start,
    startSigma_m: p.location!.sigma_m,
    goal: { ...goal, id: cfg.collectionPoint.id },
    basis: {
      gsRadiationSamples: gsRad.length,
      latestRadiationSampleTime: gsRad.length ? Math.max(...gsRad.map((r) => r.sampleTime)) : null,
      measuredCells: grid.filled,
      totalCells: grid.nx * grid.nz,
      locationSampleTime: p.location!.sampleTime,
    },
    params,
    unknownPolicy: cfg.unknownPolicy,
    conservativeRadius_m: cons ? cfg.conservativeRadius_m : null,
    ok: res.ok,
    failReason: res.ok ? null : res.reason,
    waypoints: res.ok ? res.waypoints : [],
    runs: res.ok ? res.runs : [],
    metrics: res.ok ? res.metrics : null,
    shortest: short.ok ? { waypoints: short.waypoints, metrics: evaluateRoute(short.waypoints, world.obstacles, dose, params, unk) } : null,
  };
}

/** Planner search bounds: casualty estimate and collection point plus a margin, clipped to the site. */
export function planBounds(ctx: Pick<SubsystemContext, 'config' | 'world'>, p: PatientRecord) {
  const cfg = ctx.config.evacuation;
  const H = ctx.world.opsAreaHalfSize;
  const gp = cfg.collectionPoint.position;
  const sx = p.location!.x;
  const sz = p.location!.z;
  return {
    x0: Math.max(-H, Math.min(sx, gp.x) - cfg.margin_m),
    z0: Math.max(-H, Math.min(sz, gp.z) - cfg.margin_m),
    x1: Math.min(H, Math.max(sx, gp.x) + cfg.margin_m),
    z1: Math.min(H, Math.max(sz, gp.z) + cfg.margin_m),
  };
}

/** The plan currently shown for a case (frozen or latest successful). */
export function activePlan(c: EvacuationCase): EvacPlan | null {
  return c.activePlanId === null ? null : (c.plans.find((p) => p.planId === c.activePlanId) ?? null);
}
