import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  EVAC_STAGES,
  SimEngine,
  WORLD,
  activePlan,
  obstacleDistance,
  planRoute,
  segmentClear,
} from '../src/sim';
import type { Obstacle, P2, PlannerParams } from '../src/sim';
import { completedRun, eventsOf } from './helpers';

const BG = 0.1;
const params = (over: Partial<PlannerParams> = {}): PlannerParams => ({
  cell: 1,
  clearance: 1.5,
  walkingSpeed_mps: 1,
  radiationWeight: 0.5,
  unknownMultiplier: 3,
  background_uSv_h: BG,
  bounds: { x0: -40, z0: -40, x1: 40, z1: 40 },
  ...over,
});
const none = () => null;
const known = (v: number) => () => v;

/** A route is valid if it starts/ends near the requested points and every segment keeps clearance. */
function assertValid(wp: P2[], start: P2, goal: P2, obstacles: Obstacle[], clearance: number, cell: number) {
  expect(wp.length).toBeGreaterThanOrEqual(2);
  expect(Math.hypot(wp[0].x - start.x, wp[0].z - start.z)).toBeLessThan(cell * 1.5);
  const g = wp[wp.length - 1];
  expect(Math.hypot(g.x - goal.x, g.z - goal.z)).toBeLessThan(cell * 1.5);
  for (let i = 1; i < wp.length; i++) expect(segmentClear(obstacles, wp[i - 1], wp[i], clearance - 1e-6)).toBe(true);
}

describe('evacuation route planner (pure)', () => {
  const wall: Obstacle = { id: 'W', kind: 'warehouse', label: 'wall', shape: 'box', cx: 0, cz: 0, hx: 2, hz: 20, height: 5 };

  it('open ground: straight route of the straight-line length', () => {
    const r = planRoute({ x: -20, z: 0 }, { x: 20, z: 0 }, [], none, params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.metrics.length_m - 40)).toBeLessThan(0.01);
    assertValid(r.waypoints, { x: -20, z: 0 }, { x: 20, z: 0 }, [], 1.5, 1);
  });

  it('detours around an obstacle that blocks the straight line, keeping clearance', () => {
    const start = { x: -20, z: 0 };
    const goal = { x: 20, z: 0 };
    expect(segmentClear([wall], start, goal, 1.5)).toBe(false);
    const r = planRoute(start, goal, [wall], none, params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertValid(r.waypoints, start, goal, [wall], 1.5, 1);
    expect(r.metrics.minObstacleDistance_m).toBeGreaterThanOrEqual(1.5 - 1e-6);
    expect(r.metrics.length_m).toBeGreaterThan(40);
    // must go round an end of the 40 m wall
    expect(Math.max(...r.waypoints.map((w) => Math.abs(w.z)))).toBeGreaterThan(20);
  });

  it('never cuts corners between two diagonal obstacles', () => {
    const a: Obstacle = { id: 'A', kind: 'container', label: '', shape: 'box', cx: -3, cz: -3, hx: 3, hz: 3, height: 3 };
    const b: Obstacle = { id: 'B', kind: 'container', label: '', shape: 'box', cx: 3, cz: 3, hx: 3, hz: 3, height: 3 };
    const r = planRoute({ x: -15, z: 15 }, { x: 15, z: -15 }, [a, b], none, params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    assertValid(r.waypoints, { x: -15, z: 15 }, { x: 15, z: -15 }, [a, b], 1.5, 1);
  });

  it('reports NO_PATH when the goal is enclosed', () => {
    const box = (cx: number, cz: number, hx: number, hz: number): Obstacle => ({ id: `${cx},${cz}`, kind: 'warehouse', label: '', shape: 'box', cx, cz, hx, hz, height: 5 });
    const ring = [box(10, 0, 0.5, 8), box(30, 0, 0.5, 8), box(20, 8, 10.5, 0.5), box(20, -8, 10.5, 0.5)];
    const r = planRoute({ x: -20, z: 0 }, { x: 20, z: 0 }, ring, none, params());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('NO_PATH');
  });

  it('reports START_BLOCKED / OUT_OF_BOUNDS', () => {
    const big: Obstacle = { id: 'BIG', kind: 'warehouse', label: '', shape: 'box', cx: -20, cz: 0, hx: 10, hz: 10, height: 5 };
    const r1 = planRoute({ x: -20, z: 0 }, { x: 20, z: 0 }, [big], none, params());
    expect(r1.ok ? 'ok' : r1.reason).toBe('START_BLOCKED');
    const r2 = planRoute({ x: -90, z: 0 }, { x: 20, z: 0 }, [], none, params());
    expect(r2.ok ? 'ok' : r2.reason).toBe('OUT_OF_BOUNDS');
  });

  it('avoids a MEASURED radiation hot-spot on the straight line; shortest route does not', () => {
    const hot = (x: number, z: number) => (Math.hypot(x, z) < 8 ? 5.0 : BG); // whole map measured
    const start = { x: -25, z: 0 };
    const goal = { x: 25, z: 0 };
    const safe = planRoute(start, goal, [], hot, params());
    const short = planRoute(start, goal, [], hot, params({ radiationWeight: 0 }));
    expect(safe.ok && short.ok).toBe(true);
    if (!safe.ok || !short.ok) return;
    expect(safe.metrics.doseMeasuredStretches_uSv).toBeLessThan(short.metrics.doseMeasuredStretches_uSv * 0.5);
    expect(safe.metrics.length_m).toBeGreaterThan(short.metrics.length_m);
    expect(safe.metrics.unknownLength_m).toBe(0);
  });

  it('unknown ground is reported, never counted as measured, and adds no dose', () => {
    const half = (x: number) => (x < 0 ? 0.2 : null); // west half measured, east unknown
    const r = planRoute({ x: -20, z: 0 }, { x: 20, z: 0 }, [], half, params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.metrics.measuredLength_m - 20)).toBeLessThan(0.5);
    expect(Math.abs(r.metrics.unknownLength_m - 20)).toBeLessThan(0.5);
    expect(Math.abs(r.metrics.doseMeasuredStretches_uSv - (0.2 * 20) / 3600)).toBeLessThan(1e-4);
    expect(r.runs.some((x) => x.known)).toBe(true);
    expect(r.runs.some((x) => !x.known)).toBe(true);
  });

  it('is deterministic', () => {
    const a = planRoute({ x: -20, z: 3 }, { x: 20, z: -3 }, [wall], known(0.3), params());
    const b = planRoute({ x: -20, z: 3 }, { x: 20, z: -3 }, [wall], known(0.3), params());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('evacuation workflow in the simulation (planning only)', () => {
  const { engine, state } = completedRun();
  const c = state.evacuation.cases[0];

  it('creates one case for the single casualty and reaches ROUTE_PLANNED from GS data', () => {
    expect(state.evacuation.cases).toHaveLength(1);
    expect(c.patientId).toBe(WORLD.casualty.id);
    expect(c.stage).toBe('ROUTE_PLANNED');
    expect((c.stageTimes.DETECTED as number) <= (c.stageTimes.ASSESSED as number)).toBe(true);
    expect((c.stageTimes.ASSESSED as number) <= (c.stageTimes.ROUTE_PLANNED as number)).toBe(true);
    expect(state.evacuation.planningOnly).toBe(true);
  });

  it('the planned route is valid on the real site map and ends at the collection point', () => {
    const p = activePlan(c)!;
    expect(p.ok).toBe(true);
    const goal = DEFAULT_CONFIG.evacuation.collectionPoint.position;
    assertValid(p.waypoints, p.start, { x: goal.x, z: goal.z }, WORLD.obstacles, DEFAULT_CONFIG.evacuation.clearance_m, 1);
    for (const w of p.waypoints) expect(obstacleDistance(WORLD.obstacles, w.x, w.z)).toBeGreaterThanOrEqual(DEFAULT_CONFIG.evacuation.clearance_m - 1e-6);
  });

  it('starts from the GS-reported location estimate, not the true position', () => {
    const p = activePlan(c)!;
    // the plan starts at the location estimate the GS had RECEIVED at planning time
    const pkt = state.comms.messages.find(
      (m) => m.status === 'DELIVERED' && typeof m.data.estX === 'number' && m.data.sampleTime === p.basis.locationSampleTime && (m.tReceived as number) <= p.time + 1e-9,
    )!;
    expect(p.start.x).toBe(pkt.data.estX as number);
    expect(p.start.z).toBe(pkt.data.estZ as number);
    const t = WORLD.casualty.position;
    expect(p.start.x === t.x && p.start.z === t.z).toBe(false);
  });

  it('a route existing never marks the casualty EVACUATED', () => {
    expect(c.stage === 'EVACUATED').toBe(false);
    expect(c.evacuatedBy).toBe(null);
    expect(eventsOf(state, 'EVAC_STAGE').some((e) => e.details.includes('EVACUATED'))).toBe(false);
  });

  it('stage changes follow the order and only operator actions advance past ROUTE_PLANNED', () => {
    const e = new SimEngine();
    e.runToCompletion();
    expect(e.operatorCommand('CAS-1', 'CONFIRM_EVACUATED')).toBe(false); // not allowed yet
    expect(e.operatorCommand('CAS-1', 'REQUEST_RESCUE')).toBe(true);
    expect(e.state.evacuation.cases[0].stage).toBe('AWAITING_RESCUE');
    expect(e.state.evacuation.cases[0].frozen).toBe(true);
    expect(e.operatorCommand('CAS-1', 'CONFIRM_EVACUATED')).toBe(true);
    const k = e.state.evacuation.cases[0];
    expect(k.stage).toBe('EVACUATED');
    expect(k.evacuatedBy).toBe('OPERATOR_CONFIRMATION');
    expect(e.state.evacuation.operatorActions.map((a) => a.accepted)).toEqual([false, true, true]);
    const times = EVAC_STAGES.map((s) => k.stageTimes[s] as number);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
  });

  it('no plan without a GS assessment (all casualty packets lost)', () => {
    const s = new SimEngine({ comms: { packetLossBase: 1, packetLossEdge: 1 } }).runToCompletion();
    expect(s.comms.gs.patients).toHaveLength(0);
    expect(s.evacuation.cases).toHaveLength(0);
    void engine;
  });
});
