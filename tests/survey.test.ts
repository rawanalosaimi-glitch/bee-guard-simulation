import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  SimEngine,
  WORLD,
  areaCells,
  blockingObstacles,
  buildGrid,
  buildHeatmap,
  cellSigma,
  decide,
  evaluateCorridor,
  gsRadiationGrid,
  interpolateIdw,
  lawnmowerLanes,
  makeConfig,
  missionControlSnapshot,
  obstacleDistance,
  obstacleDistanceRef,
  segmentClear,
  surveyCoverage,
  datasetFiles,
  parseCsv,
} from '../src/sim';
import type { CorridorCandidate, CorridorEvaluation, GridPoint, HeatmapGrid } from '../src/sim';
import { completedRun, eventsOf } from './helpers';

const S = DEFAULT_CONFIG.survey;
const HM = DEFAULT_CONFIG.radiation.heatmap;

/** Synthetic received-measurement grid: uniform rate on every cell for which `keep` is true. */
function syntheticGrid(rate: number, keep: (x: number, z: number) => boolean, live = 0.5): HeatmapGrid {
  const pts: GridPoint[] = [];
  for (let iz = 0; iz < HM.nz; iz++)
    for (let ix = 0; ix < HM.nx; ix++) {
      const x = HM.x0 + (ix + 0.5) * HM.cell;
      const z = HM.z0 + (iz + 0.5) * HM.cell;
      if (!keep(x, z)) continue;
      const counts = Math.round(rate * DEFAULT_CONFIG.radiation.sensitivity_cps_per_uSv_h * live);
      pts.push({ x, y: 10, z, value: rate, time: 0, counts, live });
    }
  return buildGrid(pts, HM);
}

describe('Phase 3A — BEE-01 lawnmower survey plan', () => {
  const e = new SimEngine();
  const bee = e.state.bees.find((b) => b.id === 'BEE-01')!;
  const lawn = bee.route.filter((w) => w.block === 'LAWN');

  it('lanes lie on heat-map cell-row centres inside the designated area', () => {
    const { laneZ } = lawnmowerLanes(S, { x: 0, z: 0 });
    expect(laneZ.length).toBe(Math.round((S.area.z1 - S.area.z0) / S.laneSpacing_m));
    for (const z of laneZ) {
      expect(z).toBeGreaterThan(S.area.z0);
      expect(z).toBeLessThan(S.area.z1);
      const r = (z - HM.z0) / HM.cell - 0.5; // cell-centre test
      expect(Math.abs(r - Math.round(r))).toBeLessThan(1e-9);
    }
    expect(e.state.survey.laneZ).toEqual([...laneZ].sort((a, b) => a - b));
  });

  it('every planned leg keeps the flight clearance from obstacles that block at that altitude', () => {
    const obs = blockingObstacles(WORLD, e.config, S.altitude_m);
    expect(obs.length).toBeGreaterThan(0); // the tanks block at 12 m — avoidance is exercised
    for (let i = 1; i < lawn.length; i++) {
      expect(segmentClear(obs, lawn[i - 1], lawn[i], S.legClearance_m - 1e-6)).toBe(true);
    }
    for (const w of lawn) expect(w.y).toBe(S.altitude_m);
  });

  it('the plan is deterministic and independent of the seed (planned before flight)', () => {
    const a = new SimEngine({ seed: 1 }).state.bees[0].route;
    const b = new SimEngine({ seed: 999 }).state.bees[0].route;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(bee.route));
  });

  it('fast obstacle distance equals the reference implementation exactly', () => {
    for (let x = -90; x <= 90; x += 3.7) for (let z = -90; z <= 90; z += 4.1) expect(obstacleDistance(WORLD.obstacles, x, z)).toBe(obstacleDistanceRef(WORLD.obstacles, x, z));
  });
});

describe('Phase 3A — measured coverage (default run)', () => {
  const { engine, state } = completedRun();
  const cfg = engine.config;
  const onboard = buildHeatmap(state.radiation.samples, cfg.radiation.heatmap);
  const gs = gsRadiationGrid({ state, config: cfg });

  it('coverage counts area cells holding ≥ 1 measurement — recomputed by hand from the samples', () => {
    const cells = new Set(areaCells(onboard, cfg.survey.area));
    const hit = new Set<number>();
    for (const r of state.radiation.samples) {
      const k = Math.floor((r.z - HM.z0) / HM.cell) * HM.nx + Math.floor((r.x - HM.x0) / HM.cell);
      if (cells.has(k)) hit.add(k);
    }
    const c = surveyCoverage(onboard, cfg, engine.world);
    expect(c.measured).toBe(hit.size);
    expect(c.cells).toBe(cells.size);
    expect(Math.abs(c.fraction - hit.size / cells.size)).toBeLessThan(1e-12);
  });

  it('interpolated estimates never count as coverage', () => {
    const before = surveyCoverage(gs, cfg, engine.world);
    const idw = interpolateIdw(gs, 12, 2);
    expect(idw.estimated).toBeGreaterThan(0);
    // coverage only reads measurement counts; the estimate layer has no counts
    const after = surveyCoverage(gs, cfg, engine.world);
    expect(after).toEqual(before);
  });

  it('the lawnmower covers the reachable area; GS coverage ≤ on-board coverage (packet loss)', () => {
    const on = surveyCoverage(onboard, cfg, engine.world);
    const rx = surveyCoverage(gs, cfg, engine.world);
    expect(on.fractionReachable).toBeGreaterThanOrEqual(0.97);
    expect(rx.measured).toBeLessThanOrEqual(on.measured);
    expect(rx.fractionReachable).toBeGreaterThan(0.85);
    // cells close to the tall tanks cannot be flown at survey altitude and stay unmeasured
    expect(on.reachableCells).toBeLessThan(on.cells);
  });

  it('every GS-measured cell was physically overflown (coverage expands only through flight)', () => {
    for (let k = 0; k < gs.counts.length; k++) if (gs.counts[k] > 0) expect(onboard.counts[k]).toBeGreaterThan(0);
  });

  it('BEE-01 keeps clear of obstacles and never skips a waypoint', () => {
    expect(state.minClearance['BEE-01']).toBeGreaterThan(cfg.bee.bodyRadius);
    expect(eventsOf(state, 'WAYPOINT_SKIPPED', 'BEE-01')).toHaveLength(0);
    expect(eventsOf(state, 'SURVEY_START', 'BEE-01')).toHaveLength(1);
    expect(eventsOf(state, 'SURVEY_COMPLETE', 'BEE-01')).toHaveLength(1);
  });

  it('readings keep coordinates, timestamps, altitude and units', () => {
    for (const r of state.comms.gs.radiationSamples) {
      expect(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)).toBe(true);
      expect(r.rxTime).toBeGreaterThan(r.sampleTime);
      expect(r.y).toBeGreaterThan(1);
    }
    const csv = parseCsv(datasetFiles(engine)[`${engine.runId}/mission_control/gs_radiation_received.csv`]);
    expect(csv[0].includes('measured_dose_rate_uSv_h')).toBe(true);
    expect(csv[0].includes('y_m')).toBe(true);
    expect(csv[0].includes('sim_time_sample_s')).toBe(true);
  });
});

describe('Phase 3A — adaptive hotspot scanning', () => {
  const { engine, state } = completedRun();
  const src = engine.config.radiation.sourcePosition;

  it('a reading above the trigger creates a hotspot near the source and a denser scan is flown', () => {
    const hs = state.survey.hotspots;
    expect(hs.length).toBeGreaterThanOrEqual(1);
    const h = hs[0];
    expect(h.peak_uSv_h).toBeGreaterThanOrEqual(S.adaptive.triggerRate_uSv_h);
    expect(Math.hypot(h.x - src.x, h.z - src.z)).toBeLessThan(10);
    expect(h.scanEnd).not.toBe(null);
    expect(eventsOf(state, 'ADAPTIVE_SCAN_COMPLETE', 'BEE-01').length).toBe(hs.length);
    // the scan adds measurements inside its box after it started
    const inBox = (r: { x: number; z: number }) => Math.abs(r.x - h.x) <= S.adaptive.halfSize_m && Math.abs(r.z - h.z) <= S.adaptive.halfSize_m;
    const before = state.radiation.samples.filter((r) => r.time < (h.scanStart as number) && inBox(r)).length;
    const during = state.radiation.samples.filter((r) => r.time >= (h.scanStart as number) && r.time <= (h.scanEnd as number) && inBox(r)).length;
    expect(during).toBeGreaterThan(before);
  });

  it('no hotspot (and no adaptive scan) when no reading reaches the trigger — nothing is hard-coded', () => {
    const max = Math.max(...state.radiation.samples.map((r) => r.measured_uSv_h));
    // v0.7.0: triggerRate_uSv_h belongs to the v0.6.0 rule (LEGACY_THRESHOLD); the default significance rule
    // has its own "no source → no hotspot" tests (fixC_hotspots.test.ts)
    const e = new SimEngine({ survey: { adaptive: { detection: 'LEGACY_THRESHOLD', scanTiming: 'AFTER_AREA', triggerRate_uSv_h: max * 10 } } });
    e.runToCompletion();
    expect(e.state.survey.hotspots).toHaveLength(0);
    expect(e.state.bees[0].route.some((w) => w.tag === 'ADAPTIVE')).toBe(false);
    expect(eventsOf(e.state, 'HOTSPOT_DETECTED')).toHaveLength(0);
  });
});

describe('Phase 3A — corridor tasking and survey (default run)', () => {
  const { engine, state } = completedRun();
  const cs = state.corridor;
  const at = (type: string, id?: string) => eventsOf(state, type, id)[0]?.time ?? null;

  it('candidates are generated only after the GS has the assessment and the location', () => {
    expect(cs.candidates.length).toBeGreaterThanOrEqual(2);
    // the GS marked the case ASSESSED when the assessment arrived; candidates cannot come earlier
    expect(cs.candidatesAt as number).toBeGreaterThanOrEqual(state.evacuation.cases[0].stageTimes.ASSESSED as number);
    expect(state.comms.gs.patients[0].location).not.toBe(null);
    expect(at('CORRIDOR_CANDIDATES', 'GS-1') as number).toBeGreaterThanOrEqual(at('ASSESSMENT_COMPLETE', 'BEE-02') as number);
    // every candidate keeps the walking clearance and ends at the collection point
    const cp = engine.config.evacuation.collectionPoint.position;
    for (const c of cs.candidates) {
      const last = c.waypoints[c.waypoints.length - 1];
      expect(Math.hypot(last.x - cp.x, last.z - cp.z)).toBeLessThan(1.5);
      for (let i = 1; i < c.waypoints.length; i++) expect(segmentClear(WORLD.obstacles, c.waypoints[i - 1], c.waypoints[i], engine.config.evacuation.clearance_m - 1e-6)).toBe(true);
    }
  });

  it('the task travels over the simulated downlink and BEE-01 flies the corridors', () => {
    const down = state.comms.messages.filter((m) => m.type === 'TASK_CORRIDOR_SURVEY');
    expect(down.length).toBe(cs.task!.attempts);
    const first = down.find((m) => m.status === 'DELIVERED')!;
    const task = state.survey.tasks[0];
    expect(task.receivedAt).toBeGreaterThanOrEqual(first.tReceived as number);
    expect(task.state).toBe('COMPLETE');
    expect(cs.task!.state).toBe('COMPLETE');
    // BEE-01 positions during the task lie on the tasked corridors (horizontal distance)
    const pos = state.samples.filter((s) => s.entityId === 'BEE-01' && s.time >= (task.startedAt as number) && s.time <= (task.completedAt as number));
    const near = (x: number, z: number) =>
      cs.candidates.filter((c) => c.tasked).some((c) => c.waypoints.some((w, i) => {
        if (i === 0) return false;
        const a = c.waypoints[i - 1];
        const vx = w.x - a.x, vz = w.z - a.z, L2 = vx * vx + vz * vz;
        const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / L2));
        return Math.hypot(x - a.x - t * vx, z - a.z - t * vz) < 3;
      }));
    const on = pos.filter((p) => near(p.x, p.z)).length;
    expect(on / pos.length).toBeGreaterThan(0.6);
  });

  it('corridor coverage grows through the corridor flight', () => {
    const c1 = cs.history.filter((h) => h.id === 'C1');
    expect(c1[0].coverage).toBeLessThan(0.5);
    expect(c1[c1.length - 1].coverage).toBeGreaterThan(c1[0].coverage);
  });

  it('final decision is made, BEE-01 resumes its survey, and nothing is auto-evacuated', () => {
    expect(cs.decision.final).toBe(true);
    expect(['SURVEY_VALIDATED', 'SURVEY_INCOMPLETE']).toContain(cs.decision.status);
    expect(eventsOf(state, 'ROUTE_SELECTED', 'GS-1').length).toBeGreaterThanOrEqual(1);
    expect(state.survey.surveyCompleteTime as number).toBeGreaterThan(state.survey.tasks[0].completedAt as number);
    expect(state.evacuation.cases[0].stage).not.toBe('EVACUATED');
    expect(eventsOf(state, 'OPERATOR_ACTION')).toHaveLength(0);
  });

  it('a SURVEY_VALIDATED decision only ever selects a SURVEYED candidate', () => {
    if (cs.decision.status === 'SURVEY_VALIDATED') {
      const e = cs.evaluations.find((x) => x.candidateId === cs.decision.selectedId)!;
      expect(e.status).toBe('SURVEYED');
      expect(e.coverage).toBeGreaterThanOrEqual(S.validation.surveyedFraction);
      expect(e.longestGap_m).toBeLessThanOrEqual(S.validation.maxGap_m);
    } else expect(cs.decision.provisional).toBe(true);
  });

  it('snapshot and GS-side exports contain no ground truth; the truth file is separate', () => {
    const snap = JSON.stringify(missionControlSnapshot(engine).corridor);
    expect(snap.includes('truth')).toBe(false);
    const files = datasetFiles(engine);
    const rc = files[`${engine.runId}/mission_control/route_candidates.csv`];
    expect(rc.includes('truth')).toBe(false);
    const rows = parseCsv(rc);
    expect(rows.length - 1).toBe(cs.candidates.length);
    const tr = parseCsv(files[`${engine.runId}/ground_truth/route_candidates_truth.csv`]);
    expect(tr[1][tr[0].indexOf('data_source')]).toBe('SIMULATED_GROUND_TRUTH');
  });
});

describe('Phase 3A — infeasible or failed corridor tasking', () => {
  it('endurance budget too short → INFEASIBLE, SURVEY_INCOMPLETE, provisional route only', () => {
    const e = new SimEngine({ maxMissionTime: 200 });
    e.runToCompletion();
    const cs = e.state.corridor;
    expect(cs.task!.state).toBe('INFEASIBLE');
    expect(cs.decision.final).toBe(true);
    expect(cs.decision.status).toBe('SURVEY_INCOMPLETE');
    expect(cs.decision.provisional).toBe(true);
    expect(cs.decision.reasons.join(' ')).toContain('INFEASIBLE');
    expect(e.state.comms.messages.filter((m) => m.type === 'TASK_CORRIDOR_SURVEY')).toHaveLength(0);
  });

  it('no acknowledgement after the retry limit → NO_LINK and no validated route claim', () => {
    // explicit fault injection: every GS → BEE-01 downlink packet is lost (jammed GS transmitter)
    const e = new SimEngine({ seed: 42, survey: { corridor: { maxAttempts: 3 } }, mission: { faults: { downlinkJammed: true } } });
    e.runToCompletion();
    const cs = e.state.corridor;
    expect(cs.task!.attempts).toBe(3);
    expect(e.state.comms.messages.filter((m) => m.type === 'TASK_CORRIDOR_SURVEY').every((m) => m.status !== 'DELIVERED')).toBe(true);
    expect(cs.task!.state).toBe('NO_LINK');
    expect(e.state.survey.tasks).toHaveLength(0);
    expect(cs.decision.status).toBe('SURVEY_INCOMPLETE');
  });

  it('survey disabled → BEE-01 flies its configured route and no tasking happens', () => {
    const e = new SimEngine({ survey: { enabled: false } });
    e.runToCompletion();
    // the configured route, followed only by the Phase 3B return-to-rendezvous legs
    const r = e.state.bees[0].route;
    const n = DEFAULT_CONFIG.routes['BEE-01'].waypoints.length;
    expect(r.slice(0, n).map(({ x, y, z }) => ({ x, y, z }))).toEqual(DEFAULT_CONFIG.routes['BEE-01'].waypoints);
    expect(r.slice(n).every((w) => w.tag === 'RTB')).toBe(true);
    expect(e.state.comms.messages.some((m) => m.src === 'GS-1')).toBe(false);
    expect(e.state.corridor.enabled).toBe(false);
    expect(eventsOf(e.state, 'SURVEY_START')).toHaveLength(0);
  });
});

describe('Phase 3A — route dose & validation (pure functions)', () => {
  const cfg = makeConfig({});
  const v = cfg.evacuation.walkingSpeed_mps;
  const route = [
    { x: -60, z: 10 },
    { x: -20, z: 10 },
  ]; // 40 m along a cell row (z = 10 is a cell centre)
  const R = 0.6;

  it('fully measured route: coverage 1, D = Ḣ·t/3600 (µSv from µSv/h), σ from counting statistics', () => {
    const g = syntheticGrid(R, () => true);
    const e = evaluateCorridor('T', route, g, [], cfg, 0);
    expect(e.status).toBe('SURVEYED');
    expect(Math.abs(e.coverage - 1)).toBeLessThan(1e-12);
    expect(Math.abs(e.walkTime_s - 40 / v)).toBeLessThan(1e-9);
    expect(Math.abs(e.doseMeasured_uSv - (R * 40) / v / 3600)).toBeLessThan(1e-12);
    expect(e.doseTotal_uSv).toBe(e.doseMeasured_uSv);
    // σ: Σ over 10 cells of (σ_cell · t_cell / 3600)², σ_cell = √N/(k·T)
    const sc = cellSigma(g, Math.floor((10 - HM.z0) / HM.cell) * HM.nx + Math.floor((-50 - HM.x0) / HM.cell), cfg.radiation)!;
    expect(Math.abs(e.doseMeasuredSigma_uSv - Math.sqrt(10 * ((sc * (4 / v)) / 3600) ** 2))).toBeLessThan(1e-12);
  });

  it('dose scales with exposure duration (walking speed), dose rate does not', () => {
    const g = syntheticGrid(R, () => true);
    const slow = evaluateCorridor('T', route, g, [], makeConfig({ evacuation: { walkingSpeed_mps: 0.5 } }), 0);
    const fast = evaluateCorridor('T', route, g, [], makeConfig({ evacuation: { walkingSpeed_mps: 1.0 } }), 0);
    expect(Math.abs(slow.doseMeasured_uSv / fast.doseMeasured_uSv - 2)).toBeLessThan(1e-9);
    expect(slow.maxRate_uSv_h).toBe(fast.maxRate_uSv_h);
  });

  it('a long unmeasured section → PARTIAL with reasons; the unknown part is not assumed zero', () => {
    const g = syntheticGrid(R, (x) => !(x > -48 && x < -28)); // 20 m gap
    const e = evaluateCorridor('T', route, g, [], cfg, 0);
    expect(e.status).toBe('PARTIAL');
    expect(e.doseTotal_uSv).toBe(null);
    expect(e.longestGap_m).toBeGreaterThan(S.validation.maxGap_m);
    expect(e.reasons.join(' ')).toContain('unmeasured stretch');
    expect(Math.abs(e.unknownLength_m - 20)).toBeLessThan(0.3);
  });

  it('no measurement at all → UNKNOWN, measured dose 0 but no total', () => {
    const e = evaluateCorridor('T', route, syntheticGrid(R, () => false), [], cfg, 0);
    expect(e.status).toBe('UNKNOWN');
    expect(e.coverage).toBe(0);
    expect(e.doseTotal_uSv).toBe(null);
  });

  it('a short gap on an otherwise surveyed route is filled at the adjacent measured rate, σ = 100 %', () => {
    const g = syntheticGrid(R, (x) => !(x > -40 && x < -36)); // one 4 m cell missing
    const e = evaluateCorridor('T', route, g, [], cfg, 0);
    expect(e.status).toBe('SURVEYED');
    expect(Math.abs((e.gapDose_uSv as number) - (R * 4) / v / 3600)).toBeLessThan(1e-9);
    expect(Math.abs((e.doseTotal_uSv as number) - (R * 40) / v / 3600)).toBeLessThan(1e-9);
    expect(e.doseTotalSigma_uSv as number).toBeGreaterThan(e.doseMeasuredSigma_uSv);
  });

  const cand = (id: string, kind: CorridorCandidate['kind'] = 'ALTERNATIVE'): CorridorCandidate => ({ id, kind, label: id, waypoints: [], length_m: 0, createdAt: 0, tasked: true, via: null, sourcePlanId: null });
  const ev = (id: string, status: CorridorEvaluation['status'], dose: number | null, sigma: number, walk: number): CorridorEvaluation => ({
    candidateId: id, time: 0, length_m: walk, walkTime_s: walk, measuredLength_m: walk, unknownLength_m: 0, coverage: status === 'SURVEYED' ? 1 : 0.5, longestGap_m: 0, gaps: [],
    cellsOnRoute: 1, cellsMeasured: 1, doseMeasured_uSv: dose ?? 0, doseMeasuredSigma_uSv: sigma, gapDose_uSv: 0, doseTotal_uSv: dose, doseTotalSigma_uSv: sigma,
    maxRate_uSv_h: 1, meanMeasuredRate_uSv_h: 1, minObstacleDistance_m: 5, status, reasons: status === 'SURVEYED' ? [] : ['x'],
  });

  it('selection prefers the lower dose, not automatically the shortest route', () => {
    const d = decide([ev('C1', 'SURVEYED', 0.010, 0.0005, 60), ev('C2', 'SURVEYED', 0.004, 0.0005, 75)], [cand('C1', 'SHORTEST'), cand('C2')], 0, null);
    expect(d.status).toBe('SURVEY_VALIDATED');
    expect(d.selectedId).toBe('C2');
  });

  it('doses within 2σ → the shorter walk wins; partial routes are never selected as validated', () => {
    const d = decide([ev('C1', 'SURVEYED', 0.0050, 0.0005, 60), ev('C2', 'SURVEYED', 0.0046, 0.0005, 75), ev('C3', 'PARTIAL', 0.0001, 0.0001, 50)], [cand('C1', 'SHORTEST'), cand('C2'), cand('C3')], 0, null);
    expect(d.selectedId).toBe('C1');
    expect(d.reasons.join(' ')).toContain('C3 PARTIAL');
  });

  it('nothing surveyed → SURVEY_INCOMPLETE with a provisional shortest route and reasons', () => {
    const d = decide([ev('C1', 'PARTIAL', null, 0, 60), ev('C2', 'UNKNOWN', null, 0, 75)], [cand('C1', 'SHORTEST'), cand('C2')], 0, 'BEE-01 corridor task TASK-1: NO_LINK');
    expect(d.status).toBe('SURVEY_INCOMPLETE');
    expect(d.provisional).toBe(true);
    expect(d.selectedId).toBe('C1');
    expect(d.reasons[0]).toContain('NO_LINK');
  });
});

describe('Phase 3A — determinism', () => {
  it('same seed → identical survey, corridor evaluations and decision', () => {
    const a = new SimEngine({ seed: 7 });
    const b = new SimEngine({ seed: 7 });
    a.runToCompletion();
    b.runToCompletion();
    expect(JSON.stringify(a.state.corridor)).toBe(JSON.stringify(b.state.corridor));
    expect(JSON.stringify(a.state.survey)).toBe(JSON.stringify(b.state.survey));
    expect(JSON.stringify(a.state.bees[0].route)).toBe(JSON.stringify(b.state.bees[0].route));
  });
});
