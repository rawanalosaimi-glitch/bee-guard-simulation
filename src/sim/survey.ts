import type { SimConfig } from './config';
import { buildHeatmap } from './heatmap';
import type { HeatmapGrid } from './heatmap';
import type { CommsNetwork } from './comms';
import { obstacleDistance, planRoute, segmentClear } from './routePlanner';
import type { P2 } from './routePlanner';
import type { BeeState, RouteWaypoint, SubsystemContext } from './types';
import type { Vec3 } from './vec3';
import type { Obstacle, WorldDefinition } from './world';
import { findPeaks, sameSource, smoothField } from './hotspotDetect';
import type { HotspotParams } from './hotspotDetect';

/**
 * BEE-01 survey controller — ON-BOARD side (docs/SIMULATION_MODEL.md §20).
 *
 *  1. AREA SURVEY  deterministic boustrophedon ("lawnmower") lanes over the designated
 *                  area at one altitude. Lanes lie on heat-map cell rows. Each lane is
 *                  clipped where it comes closer than `legClearance` to an obstacle that
 *                  is tall enough to block at that altitude; the pieces are joined by
 *                  obstacle-free legs from the grid planner. Reactive avoidance and
 *                  bee–bee separation stay active as the safety layer.
 *  2. ADAPTIVE     v0.7.0 (detection = SIGNIFICANCE_PROMINENCE, hotspotDetect.ts): at the end of
 *                  each scanning lane the on-board map is searched for peaks significant vs
 *                  background (5σ, ≥ 3 × B) that are confirmed (no higher connected cell within
 *                  28 m, ≥ 80 % of the reachable cells there measured); a confirmed hotspot is
 *                  scanned right away (scanTiming = NEXT_LANE_END) with a denser perpendicular
 *                  lane box, then BEE-01 returns to the lane end and resumes. Unconfirmed peaks
 *                  are evaluated again after the lanes (final). v0.6.0 (LEGACY_THRESHOLD /
 *                  AFTER_AREA): an on-board reading ≥ trigger marks a hotspot (readings within
 *                  the merge radius update it); scans after the area lanes.
 *  3. CORRIDOR     a task received by DOWNLINK from the ground station (corridor
 *                  polylines). BEE-01 checks endurance, pre-empts its current work,
 *                  flies the corridors, returns to the pre-emption point and resumes.
 *  4. HOLD         when its own work is done BEE-01 waits at the hold point for a task
 *                  (up to holdTimeout), then loiters (route complete).
 *
 * Coverage is NEVER computed here from the plan — only from measurements (see
 * coverage functions below). The plan only says where the drone intends to fly.
 */

export type SurveyPhase = 'NOT_STARTED' | 'AREA_SURVEY' | 'ADAPTIVE_SCAN' | 'CORRIDOR_SURVEY' | 'TRANSIT' | 'HOLD' | 'COMPLETE' | 'RECOVERY';

export interface SurveyHotspot {
  id: string;
  /** Position of the highest on-board reading in this hotspot (window-mean position). */
  x: number;
  z: number;
  peak_uSv_h: number;
  sampleId: number;
  detectedAt: number;
  scanStart: number | null;
  scanEnd: number | null;
  scanPlanned: boolean;
  /** v0.7.0: detection rule, and for SIGNIFICANCE the smoothed peak value, its z-score and completeness at confirmation. */
  detection?: 'LEGACY_THRESHOLD' | 'SIGNIFICANCE_PROMINENCE';
  cell?: number;
  smoothedPeak_uSv_h?: number;
  zScore?: number;
  completeness?: number;
  final?: boolean;
}

export interface CorridorPolyline {
  id: string;
  points: P2[];
}

export interface OnboardTask {
  taskId: string;
  receivedAt: number;
  /** Number of times the task message was received (duplicates are re-acknowledged, not re-executed). */
  receptions: number;
  accepted: boolean;
  reason: string;
  state: 'ACTIVE' | 'COMPLETE' | 'REJECTED';
  corridors: CorridorPolyline[];
  /** Planned length of the corridor block (legs flown slowly over corridors + transits between them), m. */
  plannedLength_m: number;
  estDuration_s: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Remaining survey dropped to fit the endurance budget. */
  truncatedSurvey: boolean;
  progress: number;
}

export interface SurveyState {
  enabled: boolean;
  phase: SurveyPhase;
  area: SimConfig['survey']['area'];
  laneZ: number[];
  /** Planned length of the area-survey block, m (intent, not coverage). */
  plannedSurveyLength_m: number;
  surveyStartTime: number | null;
  surveyCompleteTime: number | null;
  hotspots: SurveyHotspot[];
  tasks: OnboardTask[];
  holdSince: number | null;
  currentBlock: string | null;
  planWarnings: string[];
  /** Extra fields added to BEE-01 heartbeats (so the GS learns task progress). */
  heartbeat: Record<string, string | number>;
  /** Phase 3B+: lane direction actually used ('x' = lanes along x). */
  laneAxis: 'x' | 'z';
  /** Gap-fill pass: planned?, number of cells re-flown. */
  gapFillPlanned: boolean;
  gapFillCells: number;
  /** On-board coverage of the area when the area survey ended, and whether it met the objective (null = no objective / not ended). */
  coverageAtComplete: AreaCoverage | null;
  coverageObjectiveMet: boolean | null;
  /** Coverage objective (fraction of flyable cells) configured for this run; 0 = none. */
  objective: number;
}

export function initialSurveyState(config: SimConfig): SurveyState {
  return {
    enabled: config.survey.enabled,
    phase: 'NOT_STARTED',
    area: { ...config.survey.area },
    laneZ: [],
    plannedSurveyLength_m: 0,
    surveyStartTime: null,
    surveyCompleteTime: null,
    hotspots: [],
    tasks: [],
    holdSince: null,
    currentBlock: null,
    planWarnings: [],
    heartbeat: {},
    laneAxis: 'x',
    gapFillPlanned: false,
    gapFillCells: 0,
    coverageAtComplete: null,
    coverageObjectiveMet: null,
    objective: config.survey.coverageObjective,
  };
}

/** Horizontal speed cap of BEE-01 (its speed profile, else the shared bee value). */
export function bee01MaxSpeed(config: SimConfig): number {
  return config.bee.profiles?.['BEE-01']?.maxSpeedXZ ?? config.bee.maxSpeedXZ;
}

/** Lane direction: explicit, or along the longer side of the area (fewer lanes and turns). */
export function laneAxisOf(cfg: SimConfig['survey']): 'x' | 'z' {
  if (cfg.laneAxis === 'x' || cfg.laneAxis === 'z') return cfg.laneAxis;
  const a = cfg.area;
  return a.z1 - a.z0 > a.x1 - a.x0 ? 'z' : 'x';
}

// ------------------------------------------------------------------ geometry

/** Obstacles that block flight at `altitude` (same rule as reactive avoidance). */
export function blockingObstacles(world: WorldDefinition, config: SimConfig, altitude: number): Obstacle[] {
  return world.obstacles.filter((o) => o.height + config.bee.obstacleVerticalMargin >= altitude);
}

const d2 = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Obstacle-free flight leg from `a` to `b` (returns points after `a`, ending at `b`).
 * Straight if the segment keeps `clearance`; otherwise a grid-planner detour.
 */
export function flightLeg(a: P2, b: P2, obstacles: readonly Obstacle[], clearance: number, opsHalf: number): { points: P2[]; ok: boolean } {
  if (d2(a, b) < 1e-6) return { points: [], ok: true };
  if (segmentClear(obstacles, a, b, clearance)) return { points: [{ x: b.x, z: b.z }], ok: true };
  const m = 25;
  const bounds = {
    x0: Math.max(-opsHalf, Math.min(a.x, b.x) - m),
    z0: Math.max(-opsHalf, Math.min(a.z, b.z) - m),
    x1: Math.min(opsHalf, Math.max(a.x, b.x) + m),
    z1: Math.min(opsHalf, Math.max(a.z, b.z) + m),
  };
  const res = planRoute(a, b, obstacles, () => null, {
    cell: 1,
    clearance,
    walkingSpeed_mps: 1,
    radiationWeight: 0,
    unknownMultiplier: 1,
    background_uSv_h: 1,
    bounds,
  });
  if (!res.ok) return { points: [{ x: b.x, z: b.z }], ok: false };
  const pts = res.waypoints.filter((p, i) => !(i === 0 && d2(p, a) < 1e-6));
  const last = pts[pts.length - 1];
  if (!last || d2(last, b) > 1e-6) pts.push({ x: b.x, z: b.z });
  return { points: pts, ok: true };
}

/**
 * Split a polyline into the pieces that keep `clearance` from every obstacle
 * (sampled every 0.25 m). Pieces shorter than `minLen` are dropped.
 */
export function freeRuns(poly: readonly P2[], obstacles: readonly Obstacle[], clearance: number, minLen = 2): P2[][] {
  const runs: P2[][] = [];
  let cur: P2[] | null = null;
  const free = (p: P2) => obstacleDistance(obstacles, p.x, p.z) >= clearance;
  const close = () => {
    if (cur && cur.length >= 2) {
      let L = 0;
      for (let i = 1; i < cur.length; i++) L += d2(cur[i - 1], cur[i]);
      if (L >= minLen) runs.push(simplify(cur));
    }
    cur = null;
  };
  for (let k = 1; k < poly.length; k++) {
    const a = poly[k - 1];
    const b = poly[k];
    const L = d2(a, b);
    const n = Math.max(1, Math.ceil(L / 0.25));
    for (let i = k === 1 ? 0 : 1; i <= n; i++) {
      const t = i / n;
      const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      if (free(p)) {
        if (!cur) cur = [];
        cur.push(p);
      } else close();
    }
  }
  close();
  return runs;
}

function simplify(p: P2[]): P2[] {
  if (p.length <= 2) return p;
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = out[out.length - 1];
    const b = p[i];
    const c = p[i + 1];
    if (Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) > 1e-6) out.push(b);
  }
  out.push(p[p.length - 1]);
  return out;
}

interface PathSpec {
  altitude: number;
  scanSpeed: number;
  transitSpeed: number;
  tag: 'SURVEY' | 'ADAPTIVE' | 'CORRIDOR';
  block: string;
}

/**
 * Turn an ordered list of scan polylines into route waypoints starting from `from`:
 * transit leg → scan piece → transit leg → … All legs are obstacle-free at the altitude.
 */
export function coveragePath(
  scans: readonly P2[][],
  from: P2,
  obstacles: readonly Obstacle[],
  clearance: number,
  opsHalf: number,
  spec: PathSpec,
  warnings: string[],
): { route: RouteWaypoint[]; end: P2 } {
  const route: RouteWaypoint[] = [];
  let pos = from;
  const push = (p: P2, scanning: boolean) =>
    route.push({ x: p.x, y: spec.altitude, z: p.z, speed: scanning ? spec.scanSpeed : spec.transitSpeed, tag: scanning ? spec.tag : 'TRANSIT', block: spec.block });
  for (const poly of scans) {
    for (const run of freeRuns(poly, obstacles, clearance)) {
      const leg = flightLeg(pos, run[0], obstacles, clearance, opsHalf);
      if (!leg.ok) warnings.push(`${spec.block}: no obstacle-free leg to (${run[0].x.toFixed(1)}, ${run[0].z.toFixed(1)}) — relying on reactive avoidance`);
      for (const p of leg.points) push(p, false);
      for (let i = 1; i < run.length; i++) push(run[i], true);
      pos = run[run.length - 1];
    }
  }
  return { route, end: pos };
}

/**
 * Boustrophedon lanes on heat-map cell-row centres of the area (one lane per cell row, so lane
 * spacing = cell size), ordered from the end lane nearest `from` and alternating direction.
 * `laneZ` holds the lane offsets (z for x-lanes, x for z-lanes).
 */
export function lawnmowerLanes(cfg: SimConfig['survey'], from: P2): { lanes: P2[][]; laneZ: number[]; axis: 'x' | 'z' } {
  const a = cfg.area;
  const s = cfg.laneSpacing_m;
  const axis = laneAxisOf(cfg);
  // across-lane offsets (cell centres) and along-lane extent
  const [o0, o1, l0, l1, fo, fl] = axis === 'x' ? [a.z0, a.z1, a.x0, a.x1, from.z, from.x] : [a.x0, a.x1, a.z0, a.z1, from.x, from.z];
  const laneZ: number[] = [];
  for (let o = o0 + s / 2; o < o1 - 1e-9; o += s) laneZ.push(Number(o.toFixed(6)));
  const la = l0 + 1;
  const lb = l1 - 1;
  // start from whichever end lane is closer to the start position
  const firstFar = Math.abs(fo - laneZ[laneZ.length - 1]) < Math.abs(fo - laneZ[0]);
  const os = firstFar ? [...laneZ].reverse() : laneZ;
  const lowFirst = Math.abs(fl - la) <= Math.abs(fl - lb);
  const pt = (along: number, off: number): P2 => (axis === 'x' ? { x: along, z: off } : { x: off, z: along });
  const lanes = os.map((o, i) => {
    const forward = lowFirst ? i % 2 === 0 : i % 2 === 1;
    return forward ? [pt(la, o), pt(lb, o)] : [pt(lb, o), pt(la, o)];
  });
  return { lanes, laneZ, axis };
}

/** Perpendicular (along-z) lanes of a square box around a hotspot. */
export function hotspotLanes(h: { x: number; z: number }, cfg: SimConfig['survey']['adaptive'], from: P2): P2[][] {
  const xs: number[] = [];
  for (let x = h.x - cfg.halfSize_m; x <= h.x + cfg.halfSize_m + 1e-9; x += cfg.spacing_m) xs.push(x);
  if (Math.abs(from.x - xs[xs.length - 1]) < Math.abs(from.x - xs[0])) xs.reverse();
  const z0 = h.z - cfg.halfSize_m;
  const z1 = h.z + cfg.halfSize_m;
  const southFirst = Math.abs(from.z - z0) <= Math.abs(from.z - z1);
  return xs.map((x, i) => {
    const north = southFirst ? i % 2 === 0 : i % 2 === 1;
    return north
      ? [
          { x, z: z0 },
          { x, z: z1 },
        ]
      : [
          { x, z: z1 },
          { x, z: z0 },
        ];
  });
}

/** Greedy deterministic order of corridors: nearest free endpoint next, reversed when needed. */
export function orderCorridors(corridors: readonly CorridorPolyline[], from: P2): CorridorPolyline[] {
  const left = corridors.map((c) => ({ ...c, points: c.points.map((p) => ({ ...p })) }));
  const out: CorridorPolyline[] = [];
  let pos = from;
  while (left.length) {
    let bi = 0;
    let rev = false;
    let bd = Number.POSITIVE_INFINITY;
    left.forEach((c, i) => {
      const ds = d2(pos, c.points[0]);
      const de = d2(pos, c.points[c.points.length - 1]);
      if (ds < bd - 1e-9) {
        bd = ds;
        bi = i;
        rev = false;
      }
      if (de < bd - 1e-9) {
        bd = de;
        bi = i;
        rev = true;
      }
    });
    const c = left.splice(bi, 1)[0];
    if (rev) c.points.reverse();
    out.push(c);
    pos = c.points[c.points.length - 1];
  }
  return out;
}

export function routeLength(route: readonly RouteWaypoint[], from: Vec3): number {
  let L = 0;
  let p: Vec3 = from;
  for (const w of route) {
    L += Math.hypot(w.x - p.x, w.z - p.z);
    p = w;
  }
  return L;
}

/** Estimated flight time of a waypoint list (leg length / leg speed cap; ignores acceleration). */
export function routeDuration(route: readonly RouteWaypoint[], from: Vec3, maxSpeed: number): number {
  let T = 0;
  let p: Vec3 = from;
  for (const w of route) {
    const L = Math.hypot(w.x - p.x, w.z - p.z, w.y - p.y);
    T += L / Math.min(maxSpeed, w.speed ?? maxSpeed);
    p = w;
  }
  return T;
}

/** Build the initial BEE-01 route (area lanes only; adaptive and hold blocks are appended later). */
export function buildAreaSurveyRoute(config: SimConfig, world: WorldDefinition, start: Vec3, warnings: string[]): { route: RouteWaypoint[]; laneZ: number[]; axis: 'x' | 'z' } {
  const sc = config.survey;
  const obs = blockingObstacles(world, config, sc.altitude_m);
  const from = { x: start.x, z: start.z };
  const { lanes, laneZ, axis } = lawnmowerLanes(sc, from);
  const { route } = coveragePath(lanes, from, obs, sc.legClearance_m, world.opsAreaHalfSize, {
    altitude: sc.altitude_m,
    scanSpeed: sc.speed_mps,
    transitSpeed: bee01MaxSpeed(config),
    tag: 'SURVEY',
    block: 'LAWN',
  }, warnings);
  return { route, laneZ, axis };
}

/**
 * Phase 3B+ gap fill: reachable area cells (centre ≥ leg clearance from blocking obstacles) that hold
 * no ON-BOARD measurement, excluding cells the bee will still cross on its way along `pending` (the
 * rest of the current lane). Ordered greedily (nearest next) from `from`, capped at `maxCells`.
 */
export function gapCells(grid: HeatmapGrid, config: SimConfig, world: WorldDefinition, from: P2, pending: readonly P2[]): P2[] {
  const sc = config.survey;
  const obs = blockingObstacles(world, config, sc.altitude_m);
  const soon = new Set<number>();
  const cellOf = (x: number, z: number) => {
    const ix = Math.floor((x - grid.x0) / grid.cell);
    const iz = Math.floor((z - grid.z0) / grid.cell);
    return ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz ? -1 : iz * grid.nx + ix;
  };
  for (let k = 1; k < pending.length; k++) {
    const a = pending[k - 1];
    const b = pending[k];
    const n = Math.max(1, Math.ceil(d2(a, b) / 0.5));
    for (let i = 0; i <= n; i++) soon.add(cellOf(a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n));
  }
  const left: P2[] = [];
  for (const k of areaCells(grid, sc.area)) {
    if (grid.counts[k] > 0 || soon.has(k)) continue;
    const c = { x: grid.x0 + ((k % grid.nx) + 0.5) * grid.cell, z: grid.z0 + (Math.floor(k / grid.nx) + 0.5) * grid.cell };
    if (obstacleDistance(obs, c.x, c.z) < sc.legClearance_m) continue;
    left.push(c);
  }
  const out: P2[] = [];
  let pos = from;
  while (left.length && out.length < sc.gapFill.maxCells) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (d2(pos, left[i]) < d2(pos, left[bi]) - 1e-9) bi = i;
    pos = left.splice(bi, 1)[0];
    out.push(pos);
  }
  return out;
}

// ------------------------------------------------------------- coverage

/** Heat-map cells whose centre lies inside the survey area. */
export function areaCells(grid: Pick<HeatmapGrid, 'x0' | 'z0' | 'cell' | 'nx' | 'nz'>, area: SimConfig['survey']['area']): number[] {
  const out: number[] = [];
  for (let iz = 0; iz < grid.nz; iz++) {
    const cz = grid.z0 + (iz + 0.5) * grid.cell;
    if (cz < area.z0 || cz > area.z1) continue;
    for (let ix = 0; ix < grid.nx; ix++) {
      const cx = grid.x0 + (ix + 0.5) * grid.cell;
      if (cx < area.x0 || cx > area.x1) continue;
      out.push(iz * grid.nx + ix);
    }
  }
  return out;
}

export interface AreaCoverage {
  cells: number;
  measured: number;
  /** measured / cells — from MEASUREMENTS only (estimates excluded). */
  fraction: number;
  /** Cells whose centre lies inside an obstacle footprint that blocks at survey altitude. */
  blockedCells: number;
  /** Cells whose centre keeps the flight clearance from every blocking obstacle (where lanes can be flown). */
  reachableCells: number;
  measuredReachable: number;
  /** measuredReachable / reachableCells. */
  fractionReachable: number;
  /** Measured cells outside the designated area (transit legs, corridor survey). */
  measuredOutsideArea: number;
}

export function areaCoverage(grid: HeatmapGrid, area: SimConfig['survey']['area'], blocking: readonly Obstacle[], clearance: number): AreaCoverage {
  const cells = areaCells(grid, area);
  let measured = 0;
  let blocked = 0;
  let reach = 0;
  let measReach = 0;
  for (const k of cells) {
    const m = grid.counts[k] > 0;
    if (m) measured++;
    const cx = grid.x0 + ((k % grid.nx) + 0.5) * grid.cell;
    const cz = grid.z0 + (Math.floor(k / grid.nx) + 0.5) * grid.cell;
    const d = obstacleDistance(blocking, cx, cz);
    if (d <= 0) blocked++;
    if (d >= clearance) {
      reach++;
      if (m) measReach++;
    }
  }
  const inside = new Set(cells);
  let outside = 0;
  for (let k = 0; k < grid.counts.length; k++) if (grid.counts[k] > 0 && !inside.has(k)) outside++;
  return {
    cells: cells.length,
    measured,
    fraction: cells.length ? measured / cells.length : 0,
    blockedCells: blocked,
    reachableCells: reach,
    measuredReachable: measReach,
    fractionReachable: reach ? measReach / reach : 0,
    measuredOutsideArea: outside,
  };
}

/** Coverage of the designated area for a grid (convenience wrapper using the config). */
export function surveyCoverage(grid: HeatmapGrid, config: SimConfig, world: WorldDefinition): AreaCoverage {
  return areaCoverage(grid, config.survey.area, blockingObstacles(world, config, config.survey.altitude_m), config.survey.legClearance_m);
}

// ------------------------------------------------------------- controller

export const TASK_MSG = 'TASK_CORRIDOR_SURVEY';

/** Hotspots in heartbeats: "HS-1@x:z:peak,HS-2@…" ('-' when none). */
export function encodeHotspots(h: readonly SurveyHotspot[]): string {
  return h.length ? h.map((x) => `${x.id}@${x.x.toFixed(1)}:${x.z.toFixed(1)}:${x.peak_uSv_h.toFixed(3)}:${x.scanEnd !== null ? 'S' : x.scanStart !== null ? 's' : 'q'}`).join(',') : '-';
}

export interface ReportedHotspot {
  id: string;
  x: number;
  z: number;
  peak_uSv_h: number;
  scan: 'QUEUED' | 'SCANNING' | 'SCANNED';
}

export function decodeHotspots(s: string | number | undefined): ReportedHotspot[] {
  if (typeof s !== 'string' || s === '-' || !s) return [];
  return s.split(',').map((part) => {
    const [id, rest] = part.split('@');
    const [x, z, p, f] = rest.split(':');
    return { id, x: Number(x), z: Number(z), peak_uSv_h: Number(p), scan: f === 'S' ? 'SCANNED' : f === 's' ? 'SCANNING' : 'QUEUED' };
  });
}

/** Encode corridor polylines for the downlink payload: "C1@x:z>x:z|C2@…". */
export function encodeCorridors(c: readonly CorridorPolyline[]): string {
  return c.map((k) => `${k.id}@${k.points.map((p) => `${p.x.toFixed(2)}:${p.z.toFixed(2)}`).join('>')}`).join('|');
}

export function decodeCorridors(s: string): CorridorPolyline[] {
  if (!s) return [];
  return s.split('|').map((part) => {
    const [id, pts] = part.split('@');
    return { id, points: pts.split('>').map((q) => {
      const [x, z] = q.split(':').map(Number);
      return { x, z };
    }) };
  });
}

export class SurveyController {
  static readonly DRONE = 'BEE-01';
  /** Current run of consecutive on-board readings ≥ trigger, and its highest reading. */
  private above = 0;
  private runPeak: { id: number; x: number; z: number; time: number; measured_uSv_h: number } | null = null;
  /** v0.7.0: last waypoint index seen (lane-end detection) and the reachable-area mask (computed once). */
  private lastWpIndex = -1;
  private reachMask: Uint8Array | null = null;

  /** Called at reset: generate BEE-01's area-survey route. */
  static initialRoute(config: SimConfig, world: WorldDefinition, state: SurveyState, releasePoint: Vec3): RouteWaypoint[] {
    const { route, laneZ, axis } = buildAreaSurveyRoute(config, world, releasePoint, state.planWarnings);
    state.laneZ = laneZ;
    state.laneAxis = axis;
    state.plannedSurveyLength_m = routeLength(route, releasePoint);
    return route;
  }

  step(ctx: SubsystemContext, comms: CommsNetwork): void {
    const { state: s, config } = ctx;
    const sv = s.survey;
    if (!sv.enabled) return;
    const bee = s.bees.find((b) => b.id === SurveyController.DRONE)!;
    if (bee.mode === 'DOCKED' || bee.mode === 'RELEASING') return;
    // Phase 3B: once recalled for recovery, the survey controller no longer steers BEE-01
    if (bee.rtb || bee.mode === 'STAGED' || bee.mode === 'DOCK_APPROACH' || bee.mode === 'DOCKING' || bee.mode === 'DOCK_FAILED') {
      sv.phase = 'RECOVERY';
      sv.heartbeat = { ...sv.heartbeat, phase: sv.phase };
      return;
    }

    // 1) hotspot detection: v0.6.0 per reading, or v0.7.0 at each lane end (+ immediate scan)
    const last = s.radiation.latest;
    const adaptive = config.survey.adaptive;
    if (adaptive.enabled && adaptive.detection === 'LEGACY_THRESHOLD' && last && last.step === s.step) this.updateHotspots(ctx, last);
    if (adaptive.enabled && adaptive.detection === 'SIGNIFICANCE_PROMINENCE' && bee.waypointIndex !== this.lastWpIndex) {
      const reached = bee.waypointIndex > this.lastWpIndex && bee.waypointIndex > 0 ? bee.route[bee.waypointIndex - 1] : null;
      const next = bee.route[bee.waypointIndex];
      this.lastWpIndex = bee.waypointIndex;
      const laneEnd = !!reached && reached.tag === 'SURVEY' && reached.block === 'LAWN' && !(next && next.tag === 'SURVEY' && next.block === 'LAWN');
      if (laneEnd) {
        this.evaluateHotspots(ctx, false);
        if (adaptive.scanTiming === 'NEXT_LANE_END' && (bee.mode === 'TRANSIT' || bee.mode === 'AVOIDING')) this.insertScanHere(ctx, bee);
      }
    }

    // 2) downlink tasks delivered to BEE-01
    const inbox = s.comms.inbox[bee.id];
    while (inbox.length) {
      const m = s.comms.messages[(inbox.shift() as number) - 1];
      if (m.type === TASK_MSG) this.receiveTask(ctx, comms, bee, m.data);
    }

    // 3) append next work block when the bee targets the last waypoint
    if ((bee.mode === 'TRANSIT' || bee.mode === 'AVOIDING') && bee.waypointIndex >= bee.route.length - 1) this.extend(ctx, bee);

    // 4) block start / completion bookkeeping
    this.trackBlocks(ctx, comms, bee);

    // 5) hold timeout
    if (bee.mode === 'HOLD' && sv.holdSince !== null && s.time - sv.holdSince >= config.survey.holdTimeout_s - 1e-9) {
      ctx.log(bee.id, 'TASK_HOLD', `hold timeout ${config.survey.holdTimeout_s}s — no corridor task, loitering`);
      this.finish(ctx, bee);
    }

    // 6) heartbeat fields
    const task = sv.tasks[sv.tasks.length - 1];
    sv.heartbeat = {
      phase: sv.phase,
      task: task ? task.taskId : '-',
      taskState: task ? task.state : '-',
      taskProgress: task ? Number(task.progress.toFixed(3)) : 0,
      hotspots: encodeHotspots(sv.hotspots),
      ...(config.survey.coverageObjective > 0
        ? { areaDone: sv.surveyCompleteTime === null ? 0 : 1, areaObj: sv.coverageObjectiveMet === null ? '-' : sv.coverageObjectiveMet ? 'MET' : 'NOT_MET', areaCov: sv.coverageAtComplete ? Number(sv.coverageAtComplete.fractionReachable.toFixed(3)) : -1 }
        : {}),
    };
  }

  /** Route end reached (engine callback): HOLD for tasking, or LOITER when nothing can come. */
  onRouteEnd(ctx: SubsystemContext, bee: BeeState): 'HOLD' | 'LOITER' {
    const { state: s, config } = ctx;
    const sv = s.survey;
    const busy = sv.tasks.some((t) => t.state === 'ACTIVE');
    const done = sv.tasks.some((t) => t.state !== 'ACTIVE');
    if (busy) return 'HOLD';
    if (!config.survey.corridor.enabled || done) {
      sv.phase = 'COMPLETE';
      return 'LOITER';
    }
    sv.phase = 'HOLD';
    sv.holdSince = s.time;
    ctx.log(bee.id, 'TASK_HOLD', `survey work complete — holding at (${bee.position.x.toFixed(1)}, ${bee.position.z.toFixed(1)}) for corridor tasking (max ${config.survey.holdTimeout_s}s)`);
    return 'HOLD';
  }

  private finish(ctx: SubsystemContext, bee: BeeState): void {
    const s = ctx.state;
    bee.mode = 'LOITER';
    bee.routeCompleteTime = s.time;
    bee.missionStatus = 'Route complete — loitering';
    s.survey.phase = 'COMPLETE';
    s.survey.holdSince = null;
    ctx.log(bee.id, 'ROUTE_COMPLETE', `t=${s.time.toFixed(2)}s pos=(${bee.position.x.toFixed(1)},${bee.position.y.toFixed(1)},${bee.position.z.toFixed(1)})`);
  }

  /** v0.7.0: reachable area cells (centre keeps the flight clearance from obstacles blocking at survey altitude). */
  private reachable(ctx: SubsystemContext, g: HeatmapGrid): Uint8Array {
    if (this.reachMask && this.reachMask.length === g.nx * g.nz) return this.reachMask;
    const { config, world } = ctx;
    const m = new Uint8Array(g.nx * g.nz);
    const obs = blockingObstacles(world, config, config.survey.altitude_m);
    for (const k of areaCells(g, config.survey.area)) {
      const cx = g.x0 + ((k % g.nx) + 0.5) * g.cell;
      const cz = g.z0 + (Math.floor(k / g.nx) + 0.5) * g.cell;
      if (obstacleDistance(obs, cx, cz) >= config.survey.legClearance_m) m[k] = 1;
    }
    this.reachMask = m;
    return m;
  }

  /**
   * v0.7.0 Fix C: find confirmed peaks on the ON-BOARD map (hotspotDetect.ts) and turn new ones into
   * hotspots; a peak connected (no significant dip) to a known hotspot updates it instead.
   */
  private evaluateHotspots(ctx: SubsystemContext, final: boolean): void {
    const { state: s, config } = ctx;
    const a = config.survey.adaptive;
    const rad = config.radiation;
    const sv = s.survey;
    const p: HotspotParams = {
      background_uSv_h: rad.background_uSv_h,
      sensitivity_cps_per_uSv_h: rad.sensitivity_cps_per_uSv_h,
      calibrationFactor: rad.calibrationFactor,
      zTrigger: a.zTrigger,
      minFactorOverBackground: a.minFactorOverBackground,
      confirmRadius_m: a.confirmRadius_m,
      confirmCompleteness: a.confirmCompleteness,
      dipSigma: a.dipSigma,
      dipFraction: a.dipFraction,
      equalValueTieBreak: a.equalValueTieBreak,
    };
    const g = buildHeatmap(s.radiation.samples, rad.heatmap);
    const peaks = findPeaks(g, this.reachable(ctx, g), p, final).filter((q) => q.confirmed);
    if (!peaks.length) return;
    const f = smoothField(g);
    const cellOf = (x: number, z: number) => Math.floor((z - g.z0) / g.cell) * g.nx + Math.floor((x - g.x0) / g.cell);
    for (const q of peaks) {
      // position: the highest on-board reading in the peak cell and its 8 neighbours
      const qi = q.k % g.nx;
      const qj = Math.floor(q.k / g.nx);
      let best: (typeof s.radiation.samples)[number] | null = null;
      for (const r of s.radiation.samples) {
        const k = cellOf(r.x, r.z);
        if (Math.abs((k % g.nx) - qi) <= 1 && Math.abs(Math.floor(k / g.nx) - qj) <= 1 && (!best || r.measured_uSv_h > best.measured_uSv_h)) best = r;
      }
      if (!best) continue;
      const known = sv.hotspots.find((h) => {
        const hk = h.cell ?? cellOf(h.x, h.z);
        return hk === q.k || (hk >= 0 && hk < g.nx * g.nz && !Number.isNaN(f.values[hk]) && sameSource(g, f, hk, q.k, p));
      });
      if (known) {
        if (!known.scanPlanned && q.value_uSv_h > (known.smoothedPeak_uSv_h ?? -Infinity)) {
          known.x = best.x;
          known.z = best.z;
          known.peak_uSv_h = best.measured_uSv_h;
          known.sampleId = best.id;
          known.cell = q.k;
          known.smoothedPeak_uSv_h = q.value_uSv_h;
          known.zScore = q.zScore;
          known.completeness = q.completeness;
        }
        continue;
      }
      if (sv.hotspots.length >= a.maxHotspots) continue;
      const h: SurveyHotspot = {
        id: `HS-${sv.hotspots.length + 1}`,
        x: best.x,
        z: best.z,
        peak_uSv_h: best.measured_uSv_h,
        sampleId: best.id,
        detectedAt: s.time,
        scanStart: null,
        scanEnd: null,
        scanPlanned: false,
        detection: 'SIGNIFICANCE_PROMINENCE',
        cell: q.k,
        smoothedPeak_uSv_h: q.value_uSv_h,
        zScore: q.zScore,
        completeness: q.completeness,
        final,
      };
      sv.hotspots.push(h);
      ctx.log(
        'BEE-01',
        'HOTSPOT_DETECTED',
        `${h.id} peak ${q.value_uSv_h.toFixed(3)} µSv/h (12 m smoothed; ${q.zScore.toFixed(1)}σ above background, ≥ ${a.zTrigger}σ and ≥ ${a.minFactorOverBackground}× B), ` +
          `highest reading ${best.measured_uSv_h.toFixed(3)} at (${best.x.toFixed(1)}, ${best.z.toFixed(1)}); no higher connected cell within ${a.confirmRadius_m} m, ` +
          `${(q.completeness * 100).toFixed(0)}% of reachable cells there measured${final ? ' (final evaluation after the lanes)' : ''} — adaptive scan ${a.scanTiming === 'NEXT_LANE_END' && !final ? 'at this lane end' : 'queued'}`,
      );
    }
  }

  /** v0.7.0: insert the scan of the first unplanned hotspot here (lane end), then return to this point and resume. */
  private insertScanHere(ctx: SubsystemContext, bee: BeeState): void {
    const { state: s, config, world } = ctx;
    const sv = s.survey;
    const h = sv.hotspots.find((x) => !x.scanPlanned);
    if (!h) return;
    const a = config.survey.adaptive;
    const here = { x: bee.position.x, z: bee.position.z };
    const obs = blockingObstacles(world, config, a.altitude_m);
    const scan = coveragePath(hotspotLanes(h, a, here), here, obs, config.survey.legClearance_m, world.opsAreaHalfSize, {
      altitude: a.altitude_m,
      scanSpeed: a.speed_mps,
      transitSpeed: bee01MaxSpeed(config),
      tag: 'ADAPTIVE',
      block: `ADAPT-${h.id.slice(3)}`,
    }, sv.planWarnings);
    if (!scan.route.length) return;
    const rl = flightLeg(scan.end, here, obs, config.survey.legClearance_m, world.opsAreaHalfSize);
    if (!rl.ok) sv.planWarnings.push(`RTN-ADAPT-${h.id.slice(3)}: no obstacle-free leg — relying on reactive avoidance`);
    const pts = rl.points.length ? rl.points : [here];
    const ret: RouteWaypoint[] = pts.map((p, i, arr) => ({
      x: p.x,
      y: i === arr.length - 1 ? bee.position.y : a.altitude_m,
      z: p.z,
      speed: bee01MaxSpeed(config),
      tag: 'TRANSIT',
      block: `RTN-ADAPT-${h.id.slice(3)}`,
    }));
    const block = [...scan.route, ...ret];
    h.scanPlanned = true;
    this.checkBudget(ctx, bee, block, bee.position);
    const at = Math.min(bee.waypointIndex, bee.route.length);
    bee.route.splice(at, 0, ...block);
    bee.waypointIndex = at;
    this.lastWpIndex = at;
    bee.bestDistToWaypoint = Number.POSITIVE_INFINITY;
    bee.lastProgressTime = s.time;
  }

  private updateHotspots(ctx: SubsystemContext, reading: { id: number; x: number; z: number; time: number; measured_uSv_h: number }): void {
    let r = reading;
    const { state: s, config } = ctx;
    const a = config.survey.adaptive;
    if (r.measured_uSv_h < a.triggerRate_uSv_h) {
      this.above = 0;
      this.runPeak = null;
      return;
    }
    this.above += 1;
    if (!this.runPeak || r.measured_uSv_h > this.runPeak.measured_uSv_h) this.runPeak = { ...r };
    const sv = s.survey;
    // a hotspot needs `confirmReadings` consecutive readings ≥ trigger; existing hotspots keep tracking their peak
    const near0 = sv.hotspots.find((h) => Math.hypot(h.x - r.x, h.z - r.z) <= a.mergeRadius_m);
    if (!near0 && this.above < a.confirmReadings) return;
    if (!near0) r = this.runPeak;
    const near = sv.hotspots.find((h) => Math.hypot(h.x - r.x, h.z - r.z) <= a.mergeRadius_m);
    if (near) {
      if (!near.scanPlanned && r.measured_uSv_h > near.peak_uSv_h) {
        near.peak_uSv_h = r.measured_uSv_h;
        near.x = r.x;
        near.z = r.z;
        near.sampleId = r.id;
      }
      return;
    }
    if (sv.hotspots.length >= a.maxHotspots) return;
    const h: SurveyHotspot = {
      id: `HS-${sv.hotspots.length + 1}`,
      x: r.x,
      z: r.z,
      peak_uSv_h: r.measured_uSv_h,
      sampleId: r.id,
      detectedAt: s.time,
      scanStart: null,
      scanEnd: null,
      scanPlanned: false,
    };
    sv.hotspots.push(h);
    ctx.log('BEE-01', 'HOTSPOT_DETECTED', `${h.id} ${this.above} consecutive readings ≥ ${a.triggerRate_uSv_h} µSv/h, peak ${r.measured_uSv_h.toFixed(3)} at (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) sample=${r.id} — adaptive scan queued`);
  }

  /** Append the next block (adaptive scan or hold transit) to the route. */
  private extend(ctx: SubsystemContext, bee: BeeState): void {
    const { state: s, config, world } = ctx;
    const sv = s.survey;
    const lastWp = bee.route[bee.route.length - 1];
    const lastBlock = lastWp?.block ?? '';
    if (lastBlock === 'HOLD' || lastBlock.endsWith('-RTN-HOLD')) return;
    const from = lastWp ? { x: lastWp.x, z: lastWp.z } : { x: bee.position.x, z: bee.position.z };
    const fromV = lastWp ?? bee.position;
    // Phase 3B+ gap fill right after the lanes: re-fly reachable cells still without a reading
    if (lastBlock === 'LAWN' && config.survey.gapFill.enabled && !sv.gapFillPlanned) {
      sv.gapFillPlanned = true;
      const grid = buildHeatmap(s.radiation.samples, config.radiation.heatmap);
      const pending = [{ x: bee.position.x, z: bee.position.z }, from];
      const gaps = gapCells(grid, config, world, from, pending);
      if (gaps.length) {
        const sc = config.survey;
        const half = Math.min(1.5, grid.cell / 2 - 0.25);
        const segs = gaps.map((c) => (sv.laneAxis === 'x' ? [{ x: c.x - half, z: c.z }, { x: c.x + half, z: c.z }] : [{ x: c.x, z: c.z - half }, { x: c.x, z: c.z + half }]));
        const obs = blockingObstacles(world, config, sc.altitude_m);
        const { route } = coveragePath(segs, from, obs, sc.legClearance_m, world.opsAreaHalfSize, {
          altitude: sc.altitude_m,
          scanSpeed: sc.gapFill.speed_mps,
          transitSpeed: bee01MaxSpeed(config),
          tag: 'SURVEY',
          block: 'GAPFILL',
        }, sv.planWarnings);
        if (route.length) {
          sv.gapFillCells = gaps.length;
          ctx.log(bee.id, 'SURVEY_GAP_FILL', `${gaps.length} reachable cell(s) without an on-board reading after the lanes — re-flying them at ${sc.gapFill.speed_mps} m/s`);
          this.checkBudget(ctx, bee, route, fromV);
          bee.route.push(...route);
          return;
        }
      }
    }
    // queued hotspot scans (only after the area lanes, never in the middle of a task)
    if (lastBlock === 'LAWN' || lastBlock === 'GAPFILL' || lastBlock.startsWith('ADAPT-')) {
      // v0.7.0: final evaluation of peaks not yet confirmed (completeness no longer required)
      if (config.survey.adaptive.enabled && config.survey.adaptive.detection === 'SIGNIFICANCE_PROMINENCE') this.evaluateHotspots(ctx, true);
      const h = sv.hotspots.find((x) => !x.scanPlanned);
      if (h && config.survey.adaptive.enabled) {
        h.scanPlanned = true;
        const a = config.survey.adaptive;
        const obs = blockingObstacles(world, config, a.altitude_m);
        const { route } = coveragePath(hotspotLanes(h, a, from), from, obs, config.survey.legClearance_m, world.opsAreaHalfSize, {
          altitude: a.altitude_m,
          scanSpeed: a.speed_mps,
          transitSpeed: bee01MaxSpeed(config),
          tag: 'ADAPTIVE',
          block: `ADAPT-${h.id.slice(3)}`,
        }, sv.planWarnings);
        if (route.length) {
          this.checkBudget(ctx, bee, route, fromV);
          bee.route.push(...route);
          return;
        }
      }
    }
    // then the hold point
    const hp = config.survey.holdPoint;
    const obs = blockingObstacles(world, config, Math.min(hp.y, fromV.y));
    const leg = flightLeg(from, { x: hp.x, z: hp.z }, obs, config.survey.legClearance_m, world.opsAreaHalfSize);
    if (!leg.ok) sv.planWarnings.push('HOLD: no obstacle-free leg — relying on reactive avoidance');
    const pts = leg.points.length ? leg.points : [{ x: hp.x, z: hp.z }];
    for (const p of pts) bee.route.push({ x: p.x, y: hp.y, z: p.z, speed: bee01MaxSpeed(config), tag: 'TRANSIT', block: 'HOLD' });
  }

  /** Endurance check for appended work (maxMissionTime is the notional endurance budget). */
  private checkBudget(ctx: SubsystemContext, bee: BeeState, block: RouteWaypoint[], from: Vec3): void {
    const { state: s, config } = ctx;
    const remaining = routeDuration(bee.route.slice(bee.waypointIndex), bee.position, bee01MaxSpeed(config));
    const t = routeDuration(block, from, bee01MaxSpeed(config));
    if (s.time + remaining + t > config.maxMissionTime) {
      s.survey.planWarnings.push(`${block[0].block}: estimated end t=${(s.time + remaining + t).toFixed(0)}s exceeds the endurance budget`);
    }
  }

  private receiveTask(ctx: SubsystemContext, comms: CommsNetwork, bee: BeeState, data: Record<string, number | string>): void {
    const { state: s, config, world } = ctx;
    const sv = s.survey;
    const taskId = String(data.task);
    const known = sv.tasks.find((t) => t.taskId === taskId);
    if (known) {
      known.receptions += 1;
      comms.send(ctx, 'BEE-01', 'TASK_ACK', { task: taskId, accepted: known.accepted ? 1 : 0, reason: known.reason, duplicate: 1 });
      return;
    }
    const corridors = decodeCorridors(String(data.corridors ?? ''));
    const task: OnboardTask = {
      taskId,
      receivedAt: s.time,
      receptions: 1,
      accepted: false,
      reason: '',
      state: 'REJECTED',
      corridors,
      plannedLength_m: 0,
      estDuration_s: 0,
      startedAt: null,
      completedAt: null,
      truncatedSurvey: false,
      progress: 0,
    };
    sv.tasks.push(task);
    ctx.log(bee.id, 'CORRIDOR_TASK_RECEIVED', `${taskId}: ${corridors.length} corridor(s) ${corridors.map((c) => c.id).join(',')}`);
    const busy = sv.tasks.some((t) => t !== task && t.state === 'ACTIVE');

    const cc = config.survey.corridor;
    const here = { x: bee.position.x, z: bee.position.z };
    const ordered = orderCorridors(corridors, here);
    const obs = blockingObstacles(world, config, cc.altitude_m);
    const warn: string[] = [];
    const scan = coveragePath(ordered.map((c) => c.points), here, obs, config.survey.legClearance_m, world.opsAreaHalfSize, {
      altitude: cc.altitude_m,
      scanSpeed: cc.speed_mps,
      transitSpeed: bee01MaxSpeed(config),
      tag: 'CORRIDOR',
      block: taskId,
    }, warn);

    // return leg: to the pre-emption point (resume) or to the hold point (nothing left)
    const resuming = bee.mode !== 'HOLD' && bee.mode !== 'LOITER' && bee.waypointIndex < bee.route.length;
    const ret = resuming ? { x: bee.position.x, y: bee.position.y, z: bee.position.z } : config.survey.holdPoint;
    const retObs = blockingObstacles(world, config, Math.min(cc.altitude_m, ret.y));
    const rl = flightLeg(scan.end, { x: ret.x, z: ret.z }, retObs, config.survey.legClearance_m, world.opsAreaHalfSize);
    const retBlock = `${taskId}-RTN${resuming ? '' : '-HOLD'}`;
    const retRoute: RouteWaypoint[] = (rl.points.length ? rl.points : [{ x: ret.x, z: ret.z }]).map((p, i, arr) => ({
      x: p.x,
      y: i === arr.length - 1 ? ret.y : cc.altitude_m,
      z: p.z,
      speed: bee01MaxSpeed(config),
      tag: 'TRANSIT',
      block: retBlock,
    }));
    const block = [...scan.route, ...retRoute];
    const tTask = routeDuration(block, bee.position, bee01MaxSpeed(config));
    task.plannedLength_m = routeLength(scan.route, bee.position);
    task.estDuration_s = tTask;
    const remaining = resuming ? routeDuration(bee.route.slice(bee.waypointIndex), ret, bee01MaxSpeed(config)) : 0;

    let reason = '';
    if (busy) reason = 'BUSY';
    else if (!corridors.length || !scan.route.some((w) => w.tag === 'CORRIDOR')) reason = 'NO_FLYABLE_CORRIDOR';
    else if (s.time + tTask + cc.reserve_s > config.maxMissionTime) reason = 'ENDURANCE';
    if (reason) {
      task.reason = reason;
      ctx.log(bee.id, 'CORRIDOR_SURVEY_INFEASIBLE', `${taskId} rejected: ${reason} (est ${tTask.toFixed(0)}s, t=${s.time.toFixed(0)}s, budget ${config.maxMissionTime}s)`);
      comms.send(ctx, 'BEE-01', 'TASK_ACK', { task: taskId, accepted: 0, reason });
      return;
    }
    if (resuming && s.time + tTask + remaining + cc.reserve_s > config.maxMissionTime) {
      // keep the corridor task, drop the rest of the survey work
      task.truncatedSurvey = true;
      bee.route.splice(bee.waypointIndex);
      ctx.log(bee.id, 'CORRIDOR_TASK_RECEIVED', `${taskId}: remaining survey dropped to fit the endurance budget`);
    }
    sv.planWarnings.push(...warn);
    task.accepted = true;
    task.state = 'ACTIVE';
    task.reason = task.truncatedSurvey ? 'ACCEPTED_SURVEY_TRUNCATED' : 'ACCEPTED';
    // pre-empt: insert before the current target (or append if the route is finished)
    const at = Math.min(bee.waypointIndex, bee.route.length);
    if (bee.mode === 'HOLD' || bee.mode === 'LOITER') {
      bee.route.push(...block);
      bee.waypointIndex = bee.route.length - block.length;
      bee.mode = 'TRANSIT';
      bee.routeCompleteTime = null;
      sv.holdSince = null;
    } else {
      bee.route.splice(at, 0, ...block);
      bee.waypointIndex = at;
    }
    bee.bestDistToWaypoint = Number.POSITIVE_INFINITY;
    bee.lastProgressTime = s.time;
    comms.send(ctx, 'BEE-01', 'TASK_ACK', { task: taskId, accepted: 1, reason: task.reason, est: Number(tTask.toFixed(1)) });
  }

  /** End of the area survey (lanes + gap fill): on-board coverage and the coverage objective. */
  private finalizeAreaSurvey(ctx: SubsystemContext, bee: BeeState): void {
    const s = ctx.state;
    const sv = s.survey;
    sv.surveyCompleteTime = s.time;
    const g = buildHeatmap(s.radiation.samples, ctx.config.radiation.heatmap);
    const cov = surveyCoverage(g, ctx.config, ctx.world);
    sv.coverageAtComplete = cov;
    const obj = ctx.config.survey.coverageObjective;
    const base =
      `area lanes flown in ${(s.time - (sv.surveyStartTime ?? s.time)).toFixed(1)} s (incl. any corridor task); on-board coverage ${cov.measured}/${cov.cells} cells (${(cov.fraction * 100).toFixed(1)}%), ` +
      `reachable ${cov.measuredReachable}/${cov.reachableCells} (${(cov.fractionReachable * 100).toFixed(1)}%)`;
    if (obj > 0) {
      sv.coverageObjectiveMet = cov.fractionReachable >= obj - 1e-9;
      ctx.log(bee.id, 'SURVEY_COMPLETE', `${base}; objective ≥ ${(obj * 100).toFixed(0)}% of flyable cells: ${sv.coverageObjectiveMet ? 'MET' : 'NOT MET'}${sv.gapFillCells ? ` (gap fill re-flew ${sv.gapFillCells} cell(s))` : ''}`);
      if (!sv.coverageObjectiveMet) {
        ctx.log(bee.id, 'SURVEY_INCOMPLETE', `coverage objective not met: ${(cov.fractionReachable * 100).toFixed(1)}% < ${(obj * 100).toFixed(0)}% of flyable cells measured — area survey reported INCOMPLETE`);
      }
    } else {
      ctx.log(bee.id, 'SURVEY_COMPLETE', base);
    }
  }

  private trackBlocks(ctx: SubsystemContext, comms: CommsNetwork, bee: BeeState): void {
    const s = ctx.state;
    const sv = s.survey;
    const wp = bee.route[Math.min(bee.waypointIndex, bee.route.length - 1)];
    const atEnd = bee.mode === 'HOLD' || bee.mode === 'LOITER';
    const cur = atEnd ? null : (wp?.block ?? null);
    // progress of the active task
    for (const t of sv.tasks) {
      if (t.state !== 'ACTIVE') continue;
      const idx: number[] = [];
      bee.route.forEach((w, i) => w.block === t.taskId && idx.push(i));
      if (!idx.length) continue;
      const done = idx.filter((i) => i < bee.waypointIndex || atEnd).length;
      t.progress = done / idx.length;
    }
    if (cur === sv.currentBlock) return;
    const prev = sv.currentBlock;
    sv.currentBlock = cur;
    const remains = (b: string) => bee.route.some((w, i) => i >= bee.waypointIndex && w.block === b) && !atEnd;
    if (prev && !remains(prev)) this.blockEnded(ctx, comms, bee, prev);
    if (cur) this.blockStarted(ctx, comms, bee, cur);
  }

  private blockStarted(ctx: SubsystemContext, comms: CommsNetwork, bee: BeeState, b: string): void {
    const s = ctx.state;
    const sv = s.survey;
    if (b === 'LAWN' || b === 'GAPFILL') {
      sv.phase = 'AREA_SURVEY';
      if (sv.surveyStartTime === null) {
        sv.surveyStartTime = s.time;
        ctx.log(bee.id, 'SURVEY_START', `lawnmower: ${sv.laneZ.length} lanes × ${ctx.config.survey.laneSpacing_m} m spacing at ${ctx.config.survey.altitude_m} m, area x ${sv.area.x0}…${sv.area.x1}, z ${sv.area.z0}…${sv.area.z1}; planned ${sv.plannedSurveyLength_m.toFixed(0)} m`);
      }
    } else if (b.startsWith('ADAPT-')) {
      sv.phase = 'ADAPTIVE_SCAN';
      const h = sv.hotspots.find((x) => x.id === `HS-${b.slice(6)}`);
      if (h && h.scanStart === null) {
        h.scanStart = s.time;
        ctx.log(bee.id, 'ADAPTIVE_SCAN_START', `${h.id}: ±${ctx.config.survey.adaptive.halfSize_m} m box, ${ctx.config.survey.adaptive.spacing_m} m perpendicular lanes around (${h.x.toFixed(1)}, ${h.z.toFixed(1)})`);
      }
    } else if (b.startsWith('TASK-') && !b.includes('-RTN')) {
      sv.phase = 'CORRIDOR_SURVEY';
      const t = sv.tasks.find((x) => x.taskId === b);
      if (t && t.startedAt === null) {
        t.startedAt = s.time;
        ctx.log(bee.id, 'CORRIDOR_SURVEY_START', `${t.taskId}: ${t.corridors.length} corridor(s), planned ${t.plannedLength_m.toFixed(0)} m, est ${t.estDuration_s.toFixed(0)} s`);
        comms.send(ctx, 'BEE-01', 'TASK_STATUS', { task: t.taskId, state: 'IN_PROGRESS', progress: 0 });
      }
    } else {
      sv.phase = 'TRANSIT';
    }
  }

  private blockEnded(ctx: SubsystemContext, comms: CommsNetwork, bee: BeeState, b: string): void {
    const s = ctx.state;
    const sv = s.survey;
    const gapFillAhead = bee.route.some((w, i) => i >= bee.waypointIndex && w.block === 'GAPFILL');
    if ((b === 'LAWN' && !gapFillAhead) || b === 'GAPFILL') {
      if (sv.surveyCompleteTime === null) this.finalizeAreaSurvey(ctx, bee);
    } else if (b.startsWith('ADAPT-')) {
      const h = sv.hotspots.find((x) => x.id === `HS-${b.slice(6)}`);
      if (h && h.scanEnd === null) {
        h.scanEnd = s.time;
        ctx.log(bee.id, 'ADAPTIVE_SCAN_COMPLETE', `${h.id} scan done in ${(s.time - (h.scanStart ?? s.time)).toFixed(1)} s`);
      }
    } else if (b.startsWith('TASK-') && !b.includes('-RTN')) {
      const t = sv.tasks.find((x) => x.taskId === b);
      if (t && t.state === 'ACTIVE') {
        t.state = 'COMPLETE';
        t.completedAt = s.time;
        t.progress = 1;
        ctx.log(bee.id, 'CORRIDOR_SURVEY_COMPLETE', `${t.taskId} flown in ${(s.time - (t.startedAt ?? s.time)).toFixed(1)} s — returning`);
        comms.send(ctx, 'BEE-01', 'TASK_STATUS', { task: t.taskId, state: 'COMPLETE', progress: 1 });
      }
    }
  }
}
