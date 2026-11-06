import { obstacleProximity } from './world';
import type { Obstacle } from './world';

/**
 * Ground-level evacuation route planner — PLANNING ONLY (docs/SIMULATION_MODEL.md §14).
 *
 * Pure function (no engine state, no randomness): same inputs → same route.
 *
 *  - Grid: square cells of `cell` metres over `bounds` (x–z plane).
 *  - Blocked cells: centre closer than `clearance` to any obstacle footprint
 *    (all obstacles block a walking rescue team, whatever their height).
 *  - Search: A* with 8-neighbour moves, no corner cutting.
 *  - Edge cost (seconds-equivalent):
 *        cost = t · (1 + κ · max(0, Ḣ / B − 1)),   t = length / v
 *    Ḣ is the dose-rate value of the cell under the move's midpoint:
 *      known cell   → the cell's measured mean
 *      unknown cell → `unknownRate(x, z)` when given (v0.7.0 conservative neighbourhood rule,
 *                     conservative.ts), otherwise B · unknownMultiplier (v0.6.0 rule)
 *                     — an ASSUMPTION either way, reported separately
 *    κ = 0 gives the plain shortest walkable route.
 *  - Post-processing: line-of-sight shortcuts, accepted only if the straight
 *    segment is clear AND not more costly than the grid path it replaces.
 *  - Evaluation splits the final route into measured and unknown stretches;
 *    the dose estimate uses MEASURED cells only (unknown stretches are not
 *    filled in), so it is a partial estimate whenever unknown length > 0.
 */

export interface P2 {
  x: number;
  z: number;
}

export interface DoseLookup {
  /** Measured dose rate at (x, z), µSv/h, or null if no measurement covers that point. */
  (x: number, z: number): number | null;
}

export interface PlannerParams {
  cell: number;
  clearance: number;
  walkingSpeed_mps: number;
  /** κ — dimensionless radiation penalty per multiple of background above background. */
  radiationWeight: number;
  /** Dose-rate assumption for unknown cells = background × this, for COST only. */
  unknownMultiplier: number;
  background_uSv_h: number;
  bounds: { x0: number; z0: number; x1: number; z1: number };
}

export interface RouteRun {
  known: boolean;
  points: P2[];
}

export interface RouteMetrics {
  length_m: number;
  walkTime_s: number;
  /** Σ Ḣ·Δt over MEASURED stretches only, µSv. */
  doseMeasuredStretches_uSv: number;
  measuredLength_m: number;
  unknownLength_m: number;
  unknownFraction: number;
  maxMeasuredRate_uSv_h: number | null;
  /**
   * v0.7.0: dose ASSUMED on the unknown stretches with the conservative neighbourhood rule, µSv
   * (heuristic conservative estimate, NOT a statistical bound; null when the rule is not in use or there is no data).
   */
  doseUnknownConservative_uSv: number | null;
  /** v0.7.0: measured-stretch dose + doseUnknownConservative, µSv (null as above). */
  doseConservative_uSv: number | null;
  /** Smallest distance from the route to any obstacle footprint, m. */
  minObstacleDistance_m: number;
  cost: number;
}

export interface PlannedRoute {
  ok: true;
  waypoints: P2[];
  runs: RouteRun[];
  metrics: RouteMetrics;
  expandedNodes: number;
  /** Start/goal after snapping to the nearest walkable cell. */
  snappedStart: P2;
  snappedGoal: P2;
}

export interface FailedRoute {
  ok: false;
  reason: 'START_BLOCKED' | 'GOAL_BLOCKED' | 'OUT_OF_BOUNDS' | 'NO_PATH';
  expandedNodes: number;
}

export type RouteResult = PlannedRoute | FailedRoute;

const SQRT2 = Math.SQRT2;

/** Distance from (x, z) to the nearest obstacle footprint (0 inside). */
export function obstacleDistance(obstacles: readonly Obstacle[], x: number, z: number): number {
  // allocation-free version of obstacleProximity(o, x, z).distance (same arithmetic)
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < obstacles.length; k++) {
    const o = obstacles[k];
    let d: number;
    if (o.shape === 'cylinder') {
      d = Math.hypot(x - o.cx, z - o.cz) - o.radius;
      if (d < 0) d = 0;
    } else {
      const qx = Math.abs(x - o.cx) - o.hx;
      const qz = Math.abs(z - o.cz) - o.hz;
      d = qx <= 0 && qz <= 0 ? 0 : Math.hypot(qx > 0 ? qx : 0, qz > 0 ? qz : 0);
    }
    if (d < best) best = d;
  }
  return best;
}

/** Reference implementation kept for tests: must equal obstacleDistance exactly. */
export function obstacleDistanceRef(obstacles: readonly Obstacle[], x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const o of obstacles) {
    const p = obstacleProximity(o, x, z);
    const d = p.inside ? 0 : p.distance;
    if (d < best) best = d;
  }
  return best;
}

/** True if every point sampled along a→b (step ≤ 0.25 m) keeps `clearance` from obstacles. */
export function segmentClear(obstacles: readonly Obstacle[], a: P2, b: P2, clearance: number): boolean {
  const L = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(L / 0.25));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (obstacleDistance(obstacles, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) < clearance - 1e-9) return false;
  }
  return true;
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      // tie-break on value keeps the search deterministic
      if (k[p] < key || (k[p] === key && v[p] <= val)) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop() as number;
    const lv = v.pop() as number;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mk = lk;
        let mv = lv;
        if (l < k.length && (k[l] < mk || (k[l] === mk && v[l] < mv))) {
          m = l;
          mk = k[l];
          mv = v[l];
        }
        if (r < k.length && (k[r] < mk || (k[r] === mk && v[r] < mv))) {
          m = r;
        }
        if (m === i) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

/**
 * Blocked-cell mask (cell centre closer than `clearance` to an obstacle). Pure
 * geometry, so it is memoised per obstacle list + grid (a cache hit returns the
 * same array; callers never modify it). Purely a speed-up — results are identical.
 */
const maskCache = new WeakMap<readonly Obstacle[], Map<string, Uint8Array>>();
function blockedMask(obstacles: readonly Obstacle[], b: PlannerParams['bounds'], cell: number, nx: number, nz: number, clearance: number): Uint8Array {
  let m = maskCache.get(obstacles);
  if (!m) {
    m = new Map();
    maskCache.set(obstacles, m);
  }
  const key = `${b.x0},${b.z0},${cell},${nx},${nz},${clearance}`;
  const hit = m.get(key);
  if (hit) return hit;
  const out = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = b.z0 + (j + 0.5) * cell;
    for (let i = 0; i < nx; i++) out[j * nx + i] = obstacleDistance(obstacles, b.x0 + (i + 0.5) * cell, z) < clearance ? 1 : 0;
  }
  if (m.size > 64) m.clear();
  m.set(key, out);
  return out;
}

export function planRoute(
  start: P2,
  goal: P2,
  obstacles: readonly Obstacle[],
  dose: DoseLookup,
  prm: PlannerParams,
  /** v0.7.0: assumed rate for unknown cells (conservative.ts); omitted → B · unknownMultiplier. */
  unknownRate?: DoseLookup,
): RouteResult {
  const { cell, bounds } = prm;
  const nx = Math.max(1, Math.floor((bounds.x1 - bounds.x0) / cell));
  const nz = Math.max(1, Math.floor((bounds.z1 - bounds.z0) / cell));
  const inB = (p: P2) => p.x >= bounds.x0 && p.x <= bounds.x1 && p.z >= bounds.z0 && p.z <= bounds.z1;
  if (!inB(start) || !inB(goal)) return { ok: false, reason: 'OUT_OF_BOUNDS', expandedNodes: 0 };

  const cx = (i: number) => bounds.x0 + (i + 0.5) * cell;
  const cz = (j: number) => bounds.z0 + (j + 0.5) * cell;
  const N = nx * nz;
  const blocked = blockedMask(obstacles, bounds, cell, nx, nz, prm.clearance);
  const assumeUnknown = (x: number, z: number) => (unknownRate ? unknownRate(x, z) : null) ?? prm.background_uSv_h * prm.unknownMultiplier;
  const rate = new Float64Array(N); // cost-rate assumption per cell
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const id = j * nx + i;
      const r = dose(cx(i), cz(j));
      rate[id] = r === null ? assumeUnknown(cx(i), cz(j)) : r;
    }
  }
  const factor = (id: number) => 1 + prm.radiationWeight * Math.max(0, rate[id] / prm.background_uSv_h - 1);
  const v = prm.walkingSpeed_mps;

  const toCell = (p: P2) => ({
    i: Math.min(nx - 1, Math.max(0, Math.floor((p.x - bounds.x0) / cell))),
    j: Math.min(nz - 1, Math.max(0, Math.floor((p.z - bounds.z0) / cell))),
  });
  /** Nearest walkable cell within 3·clearance (casualty / goal may lie close to a wall). */
  const snap = (p: P2): number | null => {
    const c = toCell(p);
    const R = Math.ceil((3 * prm.clearance) / cell) + 1;
    let best: number | null = null;
    let bd = Number.POSITIVE_INFINITY;
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const i = c.i + di;
        const j = c.j + dj;
        if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
        const id = j * nx + i;
        if (blocked[id]) continue;
        const d = Math.hypot(cx(i) - p.x, cz(j) - p.z);
        if (d < bd - 1e-12) {
          bd = d;
          best = id;
        }
      }
    }
    return best;
  };
  const s = snap(start);
  if (s === null) return { ok: false, reason: 'START_BLOCKED', expandedNodes: 0 };
  const g = snap(goal);
  if (g === null) return { ok: false, reason: 'GOAL_BLOCKED', expandedNodes: 0 };

  const gi = g % nx;
  const gj = (g / nx) | 0;
  const h = (id: number) => (Math.hypot((id % nx) - gi, ((id / nx) | 0) - gj) * cell) / v;
  const gCost = new Float64Array(N).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open = new MinHeap();
  gCost[s] = 0;
  open.push(h(s), s);
  let expanded = 0;
  const DI = [1, -1, 0, 0, 1, 1, -1, -1];
  const DJ = [0, 0, 1, -1, 1, -1, 1, -1];

  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === g) break;
    const ci = cur % nx;
    const cj = (cur / nx) | 0;
    for (let k = 0; k < 8; k++) {
      const i = ci + DI[k];
      const j = cj + DJ[k];
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      const nb = j * nx + i;
      if (blocked[nb] || closed[nb]) continue;
      const diag = k >= 4;
      if (diag && (blocked[cj * nx + i] || blocked[j * nx + ci])) continue; // no corner cutting
      const len = diag ? cell * SQRT2 : cell;
      const step = (len / v) * 0.5 * (factor(cur) + factor(nb));
      const ng = gCost[cur] + step;
      if (ng < gCost[nb] - 1e-12) {
        gCost[nb] = ng;
        parent[nb] = cur;
        open.push(ng + h(nb), nb);
      }
    }
  }
  if (!closed[g]) return { ok: false, reason: 'NO_PATH', expandedNodes: expanded };

  // reconstruct grid path (cell centres), then attach exact start / goal
  const ids: number[] = [];
  for (let c = g; c !== -1; c = parent[c]) ids.push(c);
  ids.reverse();
  const grid: P2[] = ids.map((id) => ({ x: cx(id % nx), z: cz((id / nx) | 0) }));
  const snappedStart = grid[0];
  const snappedGoal = grid[grid.length - 1];

  const costRate = (x: number, z: number) => {
    const r = dose(x, z);
    const H = r === null ? assumeUnknown(x, z) : r;
    return 1 + prm.radiationWeight * Math.max(0, H / prm.background_uSv_h - 1);
  };
  const segCost = (a: P2, b: P2) => {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / 0.5));
    let c = 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      c += (L / n / v) * costRate(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    }
    return c;
  };

  // line-of-sight shortcutting that never increases cost
  const out: P2[] = [grid[0]];
  let i = 0;
  while (i < grid.length - 1) {
    let best = i + 1;
    let along = 0;
    const cum: number[] = [0];
    for (let j = i + 1; j < grid.length; j++) {
      along += segCost(grid[j - 1], grid[j]);
      cum.push(along);
    }
    for (let j = grid.length - 1; j > i + 1; j--) {
      if (!segmentClear(obstacles, grid[i], grid[j], prm.clearance)) continue;
      if (segCost(grid[i], grid[j]) <= cum[j - i] + 1e-9) {
        best = j;
        break;
      }
    }
    out.push(grid[best]);
    i = best;
  }

  // attach the exact start / goal when they are themselves walkable and in clear line of sight
  if (obstacleDistance(obstacles, start.x, start.z) >= prm.clearance && segmentClear(obstacles, start, out[0], prm.clearance)) {
    if (Math.hypot(start.x - out[0].x, start.z - out[0].z) > 1e-9) out.unshift({ x: start.x, z: start.z });
  }
  const last = out[out.length - 1];
  if (obstacleDistance(obstacles, goal.x, goal.z) >= prm.clearance && segmentClear(obstacles, last, goal, prm.clearance)) {
    if (Math.hypot(goal.x - last.x, goal.z - last.z) > 1e-9) out.push({ x: goal.x, z: goal.z });
  }

  // final pass: drop any interior point whose removal keeps the route clear and not costlier
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = 1; k < out.length - 1; k++) {
      const a = out[k - 1];
      const b = out[k];
      const c = out[k + 1];
      if (segmentClear(obstacles, a, c, prm.clearance) && segCost(a, c) <= segCost(a, b) + segCost(b, c) + 1e-9) {
        out.splice(k, 1);
        changed = true;
        break;
      }
    }
  }

  const metrics = evaluateRoute(out, obstacles, dose, prm, unknownRate);
  return { ok: true, waypoints: out, runs: splitRuns(out, dose), metrics, expandedNodes: expanded, snappedStart, snappedGoal };
}

/** Walk the polyline in ≤ 0.5 m pieces and split it into measured / unknown runs. */
export function splitRuns(pts: readonly P2[], dose: DoseLookup): RouteRun[] {
  const runs: RouteRun[] = [];
  const push = (p: P2, known: boolean) => {
    const last = runs[runs.length - 1];
    if (!last || last.known !== known) {
      const prev = last ? last.points[last.points.length - 1] : p;
      runs.push({ known, points: last ? [prev, p] : [p] });
    } else last.points.push(p);
  };
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / 0.5));
    if (k === 1) push(a, dose(a.x, a.z) !== null);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const tm = (i - 0.5) / n;
      const known = dose(a.x + (b.x - a.x) * tm, a.z + (b.z - a.z) * tm) !== null;
      push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, known);
    }
  }
  // drop interior collinear points to keep runs light
  for (const r of runs) r.points = simplifyCollinear(r.points);
  return runs;
}

function simplifyCollinear(p: P2[]): P2[] {
  if (p.length <= 2) return p;
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = out[out.length - 1];
    const b = p[i];
    const c = p[i + 1];
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(p[p.length - 1]);
  return out;
}

export function evaluateRoute(pts: readonly P2[], obstacles: readonly Obstacle[], dose: DoseLookup, prm: PlannerParams, unknownRate?: DoseLookup): RouteMetrics {
  let length = 0;
  let unkCons: number | null = unknownRate ? 0 : null;
  let measured = 0;
  let unknown = 0;
  let doseKnown = 0;
  let maxRate: number | null = null;
  let minD = Number.POSITIVE_INFINITY;
  let cost = 0;
  const v = prm.walkingSpeed_mps;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    length += L;
    const n = Math.max(1, Math.ceil(L / 0.25));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const piece = L / n;
      const r = dose(x, z);
      const ur = r === null && unknownRate ? unknownRate(x, z) : null;
      if (r === null && unkCons !== null) unkCons = ur === null ? null : unkCons + (ur * (piece / v)) / 3600;
      const H = r === null ? (ur ?? prm.background_uSv_h * prm.unknownMultiplier) : r;
      cost += (piece / v) * (1 + prm.radiationWeight * Math.max(0, H / prm.background_uSv_h - 1));
      if (r === null) unknown += piece;
      else {
        measured += piece;
        doseKnown += (r * (piece / v)) / 3600;
        if (maxRate === null || r > maxRate) maxRate = r;
      }
    }
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const d = obstacleDistance(obstacles, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (d < minD) minD = d;
    }
  }
  return {
    length_m: length,
    walkTime_s: length / v,
    doseMeasuredStretches_uSv: doseKnown,
    measuredLength_m: measured,
    unknownLength_m: unknown,
    unknownFraction: length > 0 ? unknown / length : 0,
    maxMeasuredRate_uSv_h: maxRate,
    doseUnknownConservative_uSv: unkCons,
    doseConservative_uSv: unkCons === null ? null : doseKnown + unkCons,
    minObstacleDistance_m: minD,
    cost,
  };
}
