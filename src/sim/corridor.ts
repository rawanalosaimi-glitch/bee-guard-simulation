import type { SimConfig } from './config';
import { cellSigma } from './heatmap';
import type { HeatmapGrid } from './heatmap';
import type { CommsNetwork, PatientRecord } from './comms';
import { activePlan, gsRadiationGrid } from './evacuation';
import { trueDoseRate } from './radiation';
import { obstacleDistance, planRoute } from './routePlanner';
import type { P2, PlannerParams } from './routePlanner';
import { TASK_MSG, encodeCorridors, orderCorridors } from './survey';
import type { SubsystemContext } from './types';
import type { Obstacle, WorldDefinition } from './world';

/**
 * Evacuation-corridor survey & route validation — GROUND-STATION side
 * (docs/SIMULATION_MODEL.md §21). Uses only data delivered to the GS plus the
 * known site map. Never reads ground truth (truth comparisons live in
 * `corridorTruth`, used by metrics/exports only).
 *
 *  1. Once the GS has the casualty's assessment AND location, it generates
 *     candidate walking corridors to the collection point:
 *       C1 shortest walkable route (obstacles + clearance, radiation ignored)
 *       C2/C3 alternatives through via-points offset ±viaOffset perpendicular to
 *       the casualty→CCP line (kept if ≤ maxDetourFactor × C1 and distinct)
 *       RA the radiation-aware planner route (§14), refreshed at each evaluation
 *          (evaluated, not tasked).
 *  2. It checks BEE-01's feasibility (notional endurance = maxMissionTime) and
 *     DOWNLINKS a corridor-survey task, retrying until acknowledged.
 *  3. Every evalInterval it evaluates every candidate on the RECEIVED radiation
 *     map: coverage, unmeasured gaps, dose ± counting σ (§21 equations).
 *  4. Decision: SURVEY_VALIDATED only if ≥ 1 candidate is SURVEYED; then the
 *     lowest-dose candidate is selected (ties within 2σ → shorter walk time).
 *     Otherwise SURVEY_INCOMPLETE with reasons and a PROVISIONAL shortest route.
 *     Nothing here moves anyone — evacuation remains planning only.
 */

export type CorridorStatus = 'SURVEYED' | 'PARTIAL' | 'UNKNOWN';
export type CandidateKind = 'SHORTEST' | 'ALTERNATIVE' | 'RADIATION_AWARE';

export interface CorridorCandidate {
  id: string;
  kind: CandidateKind;
  label: string;
  waypoints: P2[];
  length_m: number;
  createdAt: number;
  /** Included in the BEE-01 corridor-survey task. */
  tasked: boolean;
  via: P2 | null;
  sourcePlanId: number | null;
}

export interface RouteGap {
  from_m: number;
  to_m: number;
  length_m: number;
}

export interface CorridorEvaluation {
  candidateId: string;
  time: number;
  length_m: number;
  /** One-way traverse time at the documented walking speed, s (= exposure duration). */
  walkTime_s: number;
  measuredLength_m: number;
  unknownLength_m: number;
  /** Measured fraction of the route length (received measurements only). */
  coverage: number;
  longestGap_m: number;
  gaps: RouteGap[];
  cellsOnRoute: number;
  cellsMeasured: number;
  /** Σ Ḣ·Δt over MEASURED stretches, µSv (a lower bound of the route dose when coverage < 1). */
  doseMeasured_uSv: number;
  /** Counting-statistics 1σ of doseMeasured, µSv. */
  doseMeasuredSigma_uSv: number;
  /** SURVEYED routes only: dose assumed for the short gaps (adjacent measured rate), σ = 100 % of it. */
  gapDose_uSv: number | null;
  /** SURVEYED routes only: measured + gap estimate, µSv, with 1σ. Null when not surveyed — never filled with zero. */
  doseTotal_uSv: number | null;
  doseTotalSigma_uSv: number | null;
  maxRate_uSv_h: number | null;
  meanMeasuredRate_uSv_h: number | null;
  minObstacleDistance_m: number;
  status: CorridorStatus;
  reasons: string[];
}

export type DecisionStatus = 'PENDING' | 'SURVEY_VALIDATED' | 'SURVEY_INCOMPLETE';

export interface CorridorDecision {
  time: number;
  status: DecisionStatus;
  selectedId: string | null;
  /** True when the selection is NOT supported by enough measurements. */
  provisional: boolean;
  rule: string;
  reasons: string[];
  final: boolean;
}

export type GsTaskState = 'PENDING_ACK' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETE' | 'REJECTED' | 'NO_LINK' | 'INFEASIBLE';

export interface GsTask {
  taskId: string;
  candidateIds: string[];
  state: GsTaskState;
  attempts: number;
  messageIds: number[];
  firstSentAt: number | null;
  lastSentAt: number | null;
  ackAt: number | null;
  completeAt: number | null;
  terminalAt: number | null;
  progress: number;
  reason: string;
  /** GS estimate of the task duration from BEE-01's last reported position, s. */
  estDuration_s: number | null;
}

export interface CorridorState {
  enabled: boolean;
  patientId: string | null;
  candidatesAt: number | null;
  candidates: CorridorCandidate[];
  task: GsTask | null;
  evaluations: CorridorEvaluation[];
  evalCount: number;
  decision: CorridorDecision;
  /** Coverage / dose of each candidate at each evaluation (for the trend). */
  history: { t: number; id: string; coverage: number; doseMeasured_uSv: number; status: CorridorStatus }[];
  /**
   * Phase 3B+: extra leg flown with the corridor task (not a CCP candidate, not part of the
   * decision): the shortest walkable route from the rescue-team start to the casualty estimate,
   * so the rescue approach (rescue.ts) gets measurements too. Null when rescue planning is off.
   */
  rescueLeg: { id: string; points: P2[] } | null;
}

export function initialCorridorState(config: SimConfig): CorridorState {
  return {
    enabled: config.survey.enabled && config.survey.corridor.enabled,
    patientId: null,
    candidatesAt: null,
    candidates: [],
    task: null,
    evaluations: [],
    evalCount: 0,
    decision: { time: 0, status: 'PENDING', selectedId: null, provisional: true, rule: 'no candidates yet', reasons: [], final: false },
    history: [],
    rescueLeg: null,
  };
}

const TERMINAL: readonly GsTaskState[] = ['COMPLETE', 'REJECTED', 'NO_LINK', 'INFEASIBLE'];
const SETTLE_S = 2;

// ------------------------------------------------------------- geometry

const d2 = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.z - b.z);

export function polylineLength(p: readonly P2[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += d2(p[i - 1], p[i]);
  return L;
}

/** Points every `step` metres along a polyline. */
export function resample(p: readonly P2[], step: number): P2[] {
  const out: P2[] = [];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const n = Math.max(1, Math.ceil(d2(a, b) / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

function distToPolyline(q: P2, p: readonly P2[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const L2 = vx * vx + vz * vz;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.z - a.z) * vz) / L2)) : 0;
    best = Math.min(best, Math.hypot(q.x - a.x - t * vx, q.z - a.z - t * vz));
  }
  return best;
}

/** Mean distance from the points of `a` (every 1 m) to polyline `b`, m. */
export function meanSeparation(a: readonly P2[], b: readonly P2[]): number {
  const pts = resample(a, 1);
  return pts.reduce((s, q) => s + distToPolyline(q, b), 0) / Math.max(1, pts.length);
}

export function walkingParams(config: SimConfig, world: WorldDefinition, start: P2, goal: P2, extra = 0): PlannerParams {
  const cfg = config.evacuation;
  const H = world.opsAreaHalfSize;
  const m = cfg.margin_m + extra;
  return {
    cell: cfg.cell_m,
    clearance: cfg.clearance_m,
    walkingSpeed_mps: cfg.walkingSpeed_mps,
    radiationWeight: 0,
    unknownMultiplier: cfg.unknownMultiplier,
    background_uSv_h: config.radiation.background_uSv_h,
    bounds: {
      x0: Math.max(-H, Math.min(start.x, goal.x) - m),
      z0: Math.max(-H, Math.min(start.z, goal.z) - m),
      x1: Math.min(H, Math.max(start.x, goal.x) + m),
      z1: Math.min(H, Math.max(start.z, goal.z) + m),
    },
  };
}

/** Deterministic candidate generation (pure). */
export function generateCandidates(config: SimConfig, world: WorldDefinition, start: P2, time: number): CorridorCandidate[] {
  const cc = config.survey.corridor;
  const gp = config.evacuation.collectionPoint.position;
  const goal = { x: gp.x, z: gp.z };
  const none = () => null;
  const prm = walkingParams(config, world, start, goal, cc.viaOffset_m);
  const c1 = planRoute(start, goal, world.obstacles, none, prm);
  if (!c1.ok) return [];
  const out: CorridorCandidate[] = [
    { id: 'C1', kind: 'SHORTEST', label: 'Shortest walkable route', waypoints: c1.waypoints, length_m: polylineLength(c1.waypoints), createdAt: time, tasked: true, via: null, sourcePlanId: null },
  ];
  const L = Math.hypot(goal.x - start.x, goal.z - start.z);
  if (L < 1e-6) return out;
  const ux = (goal.x - start.x) / L;
  const uz = (goal.z - start.z) / L;
  const mid = { x: (start.x + goal.x) / 2, z: (start.z + goal.z) / 2 };
  for (const sgn of [1, -1]) {
    const via = { x: mid.x - uz * cc.viaOffset_m * sgn, z: mid.z + ux * cc.viaOffset_m * sgn };
    if (obstacleDistance(world.obstacles, via.x, via.z) < config.evacuation.clearance_m) continue;
    const a = planRoute(start, via, world.obstacles, none, prm);
    const b = planRoute(via, goal, world.obstacles, none, prm);
    if (!a.ok || !b.ok) continue;
    const wps = [...a.waypoints, ...b.waypoints.slice(d2(a.waypoints[a.waypoints.length - 1], b.waypoints[0]) < 1e-6 ? 1 : 0)];
    const len = polylineLength(wps);
    if (len > cc.maxDetourFactor * out[0].length_m) continue;
    if (out.some((c) => meanSeparation(wps, c.waypoints) < cc.minSeparation_m)) continue;
    const id = `C${out.length + 1}`;
    out.push({ id, kind: 'ALTERNATIVE', label: `Alternative via (${via.x.toFixed(0)}, ${via.z.toFixed(0)})`, waypoints: wps, length_m: len, createdAt: time, tasked: true, via, sourcePlanId: null });
  }
  return out;
}

// ------------------------------------------------------------- evaluation

export function evaluateCorridor(
  id: string,
  pts: readonly P2[],
  grid: HeatmapGrid,
  obstacles: readonly Obstacle[],
  config: SimConfig,
  time: number,
): CorridorEvaluation {
  const v = config.evacuation.walkingSpeed_mps;
  const val = config.survey.validation;
  const piece = 0.25;
  let length = 0;
  let measured = 0;
  let dose = 0;
  let maxRate: number | null = null;
  let minD = Number.POSITIVE_INFINITY;
  const cellTime = new Map<number, number>();
  const cells = new Set<number>();
  const gaps: RouteGap[] = [];
  let gapStart: number | null = null;
  // measured rate just before each gap / just after it (for the SURVEYED gap estimate)
  let lastRate: number | null = null;
  const gapNeighbour: { before: number | null; after: number | null; len: number }[] = [];
  const cellOf = (x: number, z: number) => {
    const ix = Math.floor((x - grid.x0) / grid.cell);
    const iz = Math.floor((z - grid.z0) / grid.cell);
    return ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz ? -1 : iz * grid.nx + ix;
  };
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const L = d2(a, b);
    const n = Math.max(1, Math.ceil(L / piece));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const dl = L / n;
      const c = cellOf(x, z);
      if (c >= 0) cells.add(c);
      const known = c >= 0 && grid.counts[c] > 0;
      if (known) {
        const r = grid.values[c];
        const dt = dl / v;
        measured += dl;
        dose += (r * dt) / 3600;
        cellTime.set(c, (cellTime.get(c) ?? 0) + dt);
        if (maxRate === null || r > maxRate) maxRate = r;
        if (gapStart !== null) {
          gaps.push({ from_m: gapStart, to_m: length, length_m: length - gapStart });
          gapNeighbour[gapNeighbour.length - 1].after = r;
          gapStart = null;
        }
        lastRate = r;
      } else if (gapStart === null) {
        gapStart = length;
        gapNeighbour.push({ before: lastRate, after: null, len: 0 });
      }
      length += dl;
      minD = Math.min(minD, obstacleDistance(obstacles, x, z));
    }
  }
  if (gapStart !== null) gaps.push({ from_m: gapStart, to_m: length, length_m: length - gapStart });
  gaps.forEach((g, i) => (gapNeighbour[i].len = g.length_m));

  let var2 = 0;
  for (const [c, t] of cellTime) {
    const sg = cellSigma(grid, c, config.radiation) ?? 0;
    var2 += ((sg * t) / 3600) ** 2;
  }
  const coverage = length > 0 ? measured / length : 0;
  const longest = gaps.reduce((m, g) => Math.max(m, g.length_m), 0);
  const reasons: string[] = [];
  if (coverage < val.surveyedFraction) reasons.push(`measured coverage ${(coverage * 100).toFixed(0)}% < ${(val.surveyedFraction * 100).toFixed(0)}%`);
  if (longest > val.maxGap_m) {
    const g = gaps.reduce((m, x) => (x.length_m > m.length_m ? x : m));
    reasons.push(`unmeasured stretch ${g.length_m.toFixed(0)} m > ${val.maxGap_m} m (at ${g.from_m.toFixed(0)}–${g.to_m.toFixed(0)} m along route)`);
  }
  const status: CorridorStatus = reasons.length === 0 ? 'SURVEYED' : coverage < val.unknownBelowFraction ? 'UNKNOWN' : 'PARTIAL';

  let gapDose: number | null = null;
  let total: number | null = null;
  let totalSigma: number | null = null;
  if (status === 'SURVEYED') {
    // short gaps: assume the higher of the adjacent measured rates (σ = 100 % of that contribution)
    gapDose = 0;
    let gv = 0;
    for (const g of gapNeighbour) {
      const rr = g.before === null && g.after === null ? (maxRate ?? 0) : Math.max(g.before ?? 0, g.after ?? 0);
      const d = (rr * (g.len / v)) / 3600;
      gapDose += d;
      gv += d * d;
    }
    total = dose + gapDose;
    totalSigma = Math.sqrt(var2 + gv);
  }
  let measuredCells = 0;
  for (const c of cells) if (grid.counts[c] > 0) measuredCells++;
  return {
    candidateId: id,
    time,
    length_m: length,
    walkTime_s: length / v,
    measuredLength_m: measured,
    unknownLength_m: length - measured,
    coverage,
    longestGap_m: longest,
    gaps: gaps.slice(0, 20),
    cellsOnRoute: cells.size,
    cellsMeasured: measuredCells,
    doseMeasured_uSv: dose,
    doseMeasuredSigma_uSv: Math.sqrt(var2),
    gapDose_uSv: gapDose,
    doseTotal_uSv: total,
    doseTotalSigma_uSv: totalSigma,
    maxRate_uSv_h: maxRate,
    meanMeasuredRate_uSv_h: measured > 0 ? (dose * 3600) / (measured / v) : null,
    minObstacleDistance_m: minD,
    status,
    reasons,
  };
}

/** Selection rule (pure). */
export function decide(evals: readonly CorridorEvaluation[], candidates: readonly CorridorCandidate[], time: number, taskNote: string | null): Omit<CorridorDecision, 'final'> {
  const ok = evals.filter((e) => e.status === 'SURVEYED' && e.doseTotal_uSv !== null);
  const why = evals.filter((e) => e.status !== 'SURVEYED').map((e) => `${e.candidateId} ${e.status}: ${e.reasons.join('; ')}`);
  if (ok.length) {
    const best = ok.reduce((m, e) => ((e.doseTotal_uSv as number) < (m.doseTotal_uSv as number) ? e : m));
    const tie = ok.filter((e) => (e.doseTotal_uSv as number) - (best.doseTotal_uSv as number) <= 2 * Math.hypot(e.doseTotalSigma_uSv as number, best.doseTotalSigma_uSv as number));
    const pick = tie.reduce((m, e) => (e.walkTime_s < m.walkTime_s - 1e-9 ? e : m));
    const rule =
      tie.length > 1
        ? `lowest estimated dose among SURVEYED routes; ${tie.map((e) => e.candidateId).join(', ')} agree within 2σ → shortest walk time (${pick.candidateId})`
        : `lowest estimated dose among SURVEYED routes (${pick.candidateId}); others differ by > 2σ or are not surveyed`;
    return { time, status: 'SURVEY_VALIDATED', selectedId: pick.candidateId, provisional: false, rule, reasons: why };
  }
  const shortest = candidates.find((c) => c.kind === 'SHORTEST') ?? null;
  const reasons = [...why];
  if (taskNote) reasons.unshift(taskNote);
  if (!evals.length) reasons.unshift('no candidate evaluated');
  return {
    time,
    status: 'SURVEY_INCOMPLETE',
    selectedId: shortest ? shortest.id : null,
    provisional: true,
    rule: 'no candidate has enough measurements — showing the shortest walkable route as PROVISIONAL (not radiation-validated)',
    reasons,
  };
}

/** Ground-truth dose along a route (EVALUATION ONLY — never used by the GS logic). */
export function corridorTruth(pts: readonly P2[], config: SimConfig, height_m: number): { dose_uSv: number; maxRate_uSv_h: number } {
  const v = config.evacuation.walkingSpeed_mps;
  let dose = 0;
  let max = 0;
  for (const q of resample(pts, 0.25).map((p, i, arr) => (i === 0 ? null : { a: arr[i - 1], b: p })).filter(Boolean) as { a: P2; b: P2 }[]) {
    const m = { x: (q.a.x + q.b.x) / 2, y: height_m, z: (q.a.z + q.b.z) / 2 };
    const r = trueDoseRate(config.radiation, m);
    dose += (r * (d2(q.a, q.b) / v)) / 3600;
    max = Math.max(max, r);
  }
  return { dose_uSv: dose, maxRate_uSv_h: max };
}

/** Polylines sent to BEE-01 in the corridor task: the tasked candidates, then the rescue approach leg (Phase 3B+). */
export function taskPolylines(cs: CorridorState): { id: string; points: P2[] }[] {
  const out = cs.candidates.filter((c) => c.tasked).map((c) => ({ id: c.id, points: c.waypoints }));
  if (cs.rescueLeg) out.push({ id: cs.rescueLeg.id, points: cs.rescueLeg.points });
  return out;
}

// ------------------------------------------------------------- manager

export class CorridorManager {
  private nextEval = 0;
  private reportIdx = 0;

  step(ctx: SubsystemContext, comms: CommsNetwork): void {
    const { state: s, config } = ctx;
    const cs = s.corridor;
    if (!cs.enabled || cs.decision.final) return;
    const p = s.comms.gs.patients.find((x) => x.assessment !== null && x.location !== null);
    if (!p) return;
    if (!cs.candidates.length && cs.candidatesAt === null) this.makeCandidates(ctx, p);
    if (!cs.candidates.length) {
      // planning failed — nothing to survey; finalise as incomplete
      cs.decision = { time: s.time, status: 'SURVEY_INCOMPLETE', selectedId: null, provisional: true, rule: 'no walkable corridor found', reasons: ['corridor generation failed'], final: true };
      ctx.log('GS-1', 'ROUTE_SELECTED', `SURVEY_INCOMPLETE: no walkable corridor`);
      return;
    }
    this.handleTask(ctx, comms);
    const t = cs.task;
    const settled = t !== null && t.terminalAt !== null && s.time - t.terminalAt >= SETTLE_S - 1e-9;
    if (s.time + 1e-9 >= this.nextEval || settled) {
      this.nextEval = s.time + config.survey.validation.evalInterval_s;
      this.evaluate(ctx, settled);
    }
  }

  private makeCandidates(ctx: SubsystemContext, p: PatientRecord): void {
    const { state: s, config, world } = ctx;
    const cs = s.corridor;
    cs.patientId = p.patientId;
    cs.candidatesAt = s.time;
    cs.candidates = generateCandidates(config, world, { x: p.location!.x, z: p.location!.z }, s.time);
    if (config.rescue.enabled && cs.candidates.length) {
      const st = { x: config.rescue.start.x, z: config.rescue.start.z };
      const goal = { x: p.location!.x, z: p.location!.z };
      const leg = planRoute(st, goal, world.obstacles, () => null, walkingParams(config, world, st, goal));
      if (leg.ok) cs.rescueLeg = { id: 'RS', points: leg.waypoints };
    }
    ctx.log(
      'GS-1',
      'CORRIDOR_CANDIDATES',
      `${p.patientId}: ${cs.candidates.length} candidate corridor(s) ` + cs.candidates.map((c) => `${c.id} ${c.length_m.toFixed(0)} m`).join(', ') + ` (from location estimate ± ${p.location!.sigma_m.toFixed(1)} m)`,
    );
  }

  private handleTask(ctx: SubsystemContext, comms: CommsNetwork): void {
    const { state: s, config } = ctx;
    const cs = s.corridor;
    const cc = config.survey.corridor;
    if (!cs.task) {
      const tasked = cs.candidates.filter((c) => c.tasked);
      const hb = s.comms.gs.beeReports['BEE-01'];
      let est: number | null = null;
      if (hb) {
        const here = { x: hb.x, z: hb.z };
        const ord = orderCorridors(taskPolylines(cs), here);
        let pos = here;
        est = 0;
        for (const c of ord) {
          est += d2(pos, c.points[0]) / config.bee.maxSpeedXZ + polylineLength(c.points) / cc.speed_mps;
          pos = c.points[c.points.length - 1];
        }
        est += d2(pos, here) / config.bee.maxSpeedXZ;
      }
      const task: GsTask = {
        taskId: 'TASK-1',
        candidateIds: tasked.map((c) => c.id),
        state: 'PENDING_ACK',
        attempts: 0,
        messageIds: [],
        firstSentAt: null,
        lastSentAt: null,
        ackAt: null,
        completeAt: null,
        terminalAt: null,
        progress: 0,
        reason: '',
        estDuration_s: est,
      };
      cs.task = task;
      if (est !== null && s.time + est + cc.reserve_s > config.maxMissionTime) {
        this.terminal(ctx, 'INFEASIBLE', `estimated ${est.toFixed(0)} s + reserve ${cc.reserve_s} s exceeds the endurance budget (${config.maxMissionTime} s)`);
        ctx.log('GS-1', 'CORRIDOR_SURVEY_INFEASIBLE', `${task.taskId}: ${task.reason}`);
        return;
      }
      this.send(ctx, comms);
      return;
    }
    const t = cs.task;
    // reports from BEE-01
    const reps = s.comms.gs.taskReports;
    for (; this.reportIdx < reps.length; this.reportIdx++) {
      const r = reps[this.reportIdx];
      if (r.taskId !== t.taskId) continue;
      if (r.kind === 'ACK') {
        if (r.accepted) {
          if (t.state === 'PENDING_ACK' || t.state === 'NO_LINK') {
            t.state = 'ACCEPTED';
            t.ackAt = r.rxTime;
            t.terminalAt = null;
            t.reason = r.reason ?? '';
          }
        } else if (t.state === 'PENDING_ACK' || t.state === 'NO_LINK') {
          this.terminal(ctx, 'REJECTED', `BEE-01 rejected the task: ${r.reason ?? '?'}`);
          ctx.log('GS-1', 'CORRIDOR_SURVEY_INFEASIBLE', `${t.taskId}: ${t.reason}`);
        }
      } else {
        const st = r.state;
        if (r.progress !== null && Number.isFinite(r.progress)) t.progress = Math.max(t.progress, r.progress);
        if ((st === 'IN_PROGRESS' || st === 'ACTIVE') && !TERMINAL.includes(t.state)) {
          if (t.ackAt === null) t.ackAt = r.rxTime;
          t.state = 'IN_PROGRESS';
        } else if ((st === 'IN_PROGRESS' || st === 'ACTIVE') && t.state === 'NO_LINK') {
          t.state = 'IN_PROGRESS';
          t.terminalAt = null;
        } else if (st === 'COMPLETE' && t.state !== 'COMPLETE' && t.state !== 'REJECTED' && t.state !== 'INFEASIBLE') {
          t.completeAt = r.rxTime;
          t.progress = 1;
          this.terminal(ctx, 'COMPLETE', 'BEE-01 reported the corridor survey complete');
        } else if (st === 'REJECTED' && !TERMINAL.includes(t.state)) {
          this.terminal(ctx, 'REJECTED', 'BEE-01 reported the task rejected');
        }
      }
    }
    if (t.state === 'PENDING_ACK' && t.lastSentAt !== null && s.time - t.lastSentAt >= cc.retryInterval_s - 1e-9) {
      if (t.attempts < cc.maxAttempts) this.send(ctx, comms);
      else {
        this.terminal(ctx, 'NO_LINK', `no acknowledgement after ${t.attempts} attempts`);
        ctx.log('GS-1', 'CORRIDOR_SURVEY_INFEASIBLE', `${t.taskId}: ${t.reason}`);
      }
    }
  }

  private terminal(ctx: SubsystemContext, st: GsTaskState, reason: string): void {
    const t = ctx.state.corridor.task!;
    t.state = st;
    t.reason = reason;
    t.terminalAt = ctx.state.time;
  }

  private send(ctx: SubsystemContext, comms: CommsNetwork): void {
    const { state: s } = ctx;
    const cs = s.corridor;
    const t = cs.task!;
    const m = comms.sendDown(ctx, 'BEE-01', TASK_MSG, {
      task: t.taskId,
      attempt: t.attempts + 1,
      n: taskPolylines(cs).length,
      corridors: encodeCorridors(taskPolylines(cs)),
    });
    t.attempts += 1;
    t.messageIds.push(m.id);
    if (t.firstSentAt === null) t.firstSentAt = s.time;
    t.lastSentAt = s.time;
    ctx.log('GS-1', 'CORRIDOR_TASK_SENT', `${t.taskId} attempt ${t.attempts}: ${t.candidateIds.join(',')}${cs.rescueLeg ? ` + rescue approach ${cs.rescueLeg.id}` : ''} → BEE-01 (${m.status}${m.route.length ? ' via ' + m.route.join('>') : ''})`);
  }

  private evaluate(ctx: SubsystemContext, finalise: boolean): void {
    const { state: s, config, world } = ctx;
    const cs = s.corridor;
    // refresh the radiation-aware candidate from the latest planner route (evaluated, not tasked)
    const c = s.evacuation.cases.find((x) => x.patientId === cs.patientId);
    const plan = c ? activePlan(c) : null;
    const tasked = cs.candidates.filter((k) => k.kind !== 'RADIATION_AWARE');
    if (plan && plan.ok && plan.waypoints.length > 1 && !tasked.some((k) => meanSeparation(plan.waypoints, k.waypoints) < config.survey.corridor.minSeparation_m)) {
      const ra: CorridorCandidate = {
        id: 'RA',
        kind: 'RADIATION_AWARE',
        label: `Radiation-aware planner route (plan #${plan.planId})`,
        waypoints: plan.waypoints,
        length_m: polylineLength(plan.waypoints),
        createdAt: plan.time,
        tasked: false,
        via: null,
        sourcePlanId: plan.planId,
      };
      cs.candidates = [...tasked, ra];
    } else cs.candidates = tasked;

    const grid = gsRadiationGrid(ctx);
    cs.evaluations = cs.candidates.map((k) => evaluateCorridor(k.id, k.waypoints, grid, world.obstacles, config, s.time));
    cs.evalCount += 1;
    for (const e of cs.evaluations) cs.history.push({ t: s.time, id: e.candidateId, coverage: e.coverage, doseMeasured_uSv: e.doseMeasured_uSv, status: e.status });
    const t = cs.task;
    const note =
      t && t.state !== 'COMPLETE'
        ? `BEE-01 corridor task ${t.taskId}: ${t.state}${t.reason ? ` (${t.reason})` : ''}`
        : null;
    const d = decide(cs.evaluations, cs.candidates, s.time, note);
    const prev = cs.decision;
    cs.decision = { ...d, final: finalise };
    if (finalise) {
      ctx.log(
        'GS-1',
        'ROUTE_SELECTED',
        `${d.status}: ${d.selectedId ?? '—'}${d.provisional ? ' (PROVISIONAL)' : ''} — ${d.rule}` +
          (d.reasons.length ? ` | ${d.reasons.join(' | ')}` : '') +
          ' (planning only — no evacuation is performed)',
      );
    } else if (prev.status !== d.status || prev.selectedId !== d.selectedId) {
      // keep the log readable: only changes are recorded before the final decision
      ctx.log('GS-1', 'ROUTE_SELECTED', `provisional update: ${d.status} → ${d.selectedId ?? '—'}`);
    }
  }
}
