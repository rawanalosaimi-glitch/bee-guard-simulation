import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  PHASE3A_SURVEY,
  SimEngine,
  areaCells,
  blockingObstacles,
  buildHeatmap,
  datasetFiles,
  evaluateCorridor,
  gsRadiationGrid,
  missionAlerts,
  missionControlSnapshot,
  missionMilestones,
  obstacleDistance,
  patientViews,
  rescueTruth,
  SYSTEMATIC,
  surveyCoverage,
} from '../src/sim';
import type { SimConfigOverrides, SimState } from '../src/sim';
import { completedRun, eventsOf } from './helpers';

/**
 * Phase 3B+ field upgrade: full-area survey with a coverage objective, faster BEE-01 with
 * speed governors and spatial sampling, persistent casualty records, the radiation-minimized
 * rescue-team route, and the Phase 3A compatibility switch.
 */

const SC = DEFAULT_CONFIG.survey;
const P1 = DEFAULT_CONFIG.bee.profiles['BEE-01']!;
const hspeed = (p: { vx: number; vz: number }) => Math.hypot(p.vx, p.vz);
const flying = (st: SimState, id: string) => st.samples.filter((p) => p.entityId === id && !['DOCKED', 'RELEASING', 'DOCK_APPROACH', 'DOCKING'].includes(p.mode));
const SLOW_BEE01: SimConfigOverrides = { survey: { speed_mps: 5 }, bee: { profiles: {} }, radiation: { maxSampleSpacing_m: 0 } };

/** Mean |cell mean − truth| / truth over measured area cells (all, and cells with truth ≥ 0.5 µSv/h). */
function cellError(st: SimState, cfg: typeof DEFAULT_CONFIG) {
  const g = buildHeatmap(st.radiation.samples, cfg.radiation.heatmap);
  const tsum = new Map<number, [number, number]>();
  for (const r of st.radiation.samples) {
    const ix = Math.floor((r.x - g.x0) / g.cell);
    const iz = Math.floor((r.z - g.z0) / g.cell);
    if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) continue;
    const k = iz * g.nx + ix;
    const t = tsum.get(k) ?? [0, 0];
    t[0] += r.trueWindowMean_uSv_h * r.liveTime_s;
    t[1] += r.liveTime_s;
    tsum.set(k, t);
  }
  const inArea = new Set(areaCells(g, cfg.survey.area));
  let a = 0;
  let na = 0;
  let h = 0;
  let nh = 0;
  for (const [k, [ts, tl]] of tsum) {
    if (!inArea.has(k)) continue;
    const truth = ts / tl;
    const re = Math.abs(g.values[k] - truth) / truth;
    a += re;
    na++;
    if (truth >= 0.5) {
      h += re;
      nh++;
    }
  }
  return { all: a / na, elevated: h / nh, elevatedCells: nh };
}

describe('Phase 3B+ — full-area radiation survey', () => {
  const { engine, state } = completedRun();
  const cfg = engine.config;
  const g = buildHeatmap(state.radiation.samples, cfg.radiation.heatmap);

  it('surveys the whole designated disaster area (compound), not only the source vicinity', () => {
    const a = SC.area;
    expect(a.x1 - a.x0).toBeGreaterThanOrEqual(100);
    expect(a.z1 - a.z0).toBeGreaterThanOrEqual(90);
    // one lane per 4 m cell row, first and last lanes on the outermost cell rows
    const lanes = state.survey.laneZ;
    const [o0, o1] = state.survey.laneAxis === 'x' ? [a.z0, a.z1] : [a.x0, a.x1];
    expect(lanes.length).toBe(Math.round((o1 - o0) / SC.laneSpacing_m));
    expect(Math.abs((Math.min(...lanes)) - (o0 + SC.laneSpacing_m / 2))).toBeLessThan(1e-6);
    expect(Math.abs((Math.max(...lanes)) - (o1 - SC.laneSpacing_m / 2))).toBeLessThan(1e-6);
    // lanes along the longer side of the area (fewer turns)
    expect(state.survey.laneAxis).toBe(a.x1 - a.x0 >= a.z1 - a.z0 ? 'x' : 'z');
  });

  it('fills every quadrant of the area, far from the source as well', () => {
    const a = SC.area;
    const cx = (a.x0 + a.x1) / 2;
    const cz = (a.z0 + a.z1) / 2;
    const quad = [0, 0, 0, 0];
    const meas = [0, 0, 0, 0];
    const obs = blockingObstacles(engine.world, cfg, SC.altitude_m);
    for (const k of areaCells(g, a)) {
      const x = g.x0 + ((k % g.nx) + 0.5) * g.cell;
      const z = g.z0 + (Math.floor(k / g.nx) + 0.5) * g.cell;
      if (obstacleDistance(obs, x, z) < SC.legClearance_m) continue; // not flyable at survey altitude
      const q = (x >= cx ? 1 : 0) + (z >= cz ? 2 : 0);
      quad[q]++;
      if (g.counts[k] > 0) meas[q]++;
    }
    for (let q = 0; q < 4; q++) expect(meas[q] / quad[q]).toBeGreaterThanOrEqual(0.95);
    // most measured cells are well away from the source (the survey is not source-centred)
    const src = cfg.radiation.sourcePosition;
    const cells = areaCells(g, a).filter((k) => g.counts[k] > 0);
    const far = cells.filter((k) => Math.hypot(g.x0 + ((k % g.nx) + 0.5) * g.cell - src.x, g.z0 + (Math.floor(k / g.nx) + 0.5) * g.cell - src.z) > 30);
    expect(far.length / cells.length).toBeGreaterThan(0.6);
  });

  it('reports completion only with the coverage objective met (on-board data), after any gap fill', () => {
    const sc = eventsOf(state, 'SURVEY_COMPLETE', 'BEE-01');
    expect(sc).toHaveLength(1);
    expect(state.survey.coverageObjectiveMet).toBe(true);
    expect(state.survey.coverageAtComplete!.fractionReachable).toBeGreaterThanOrEqual(SC.coverageObjective);
    expect(eventsOf(state, 'SURVEY_INCOMPLETE')).toHaveLength(0);
    const gf = eventsOf(state, 'SURVEY_GAP_FILL', 'BEE-01');
    if (gf.length) expect(sc[0].time).toBeGreaterThan(gf[0].time);
    expect(missionMilestones(state).find((m) => m.key === 'survey')!.done).toBe(true);
  });

  it('reports INCOMPLETE (never complete) when the objective is not reached', () => {
    const r = completedRun({ survey: { coverageObjective: 1, gapFill: { enabled: false } } });
    expect(r.state.survey.coverageObjectiveMet).toBe(false);
    expect(eventsOf(r.state, 'SURVEY_INCOMPLETE', 'BEE-01')).toHaveLength(1);
    expect(missionMilestones(r.state).find((m) => m.key === 'survey')!.done).toBe(false);
    expect(missionAlerts(r.state, r.engine.config).some((x) => x.code === 'SURVEY_INCOMPLETE')).toBe(true);
  });

  it('coverage counts only cells that contain a measurement (no estimate, no smoothing)', () => {
    const cov = surveyCoverage(g, cfg, engine.world);
    const inArea = new Set(areaCells(g, SC.area));
    const withSample = new Set<number>();
    for (const r of state.radiation.samples) {
      const ix = Math.floor((r.x - g.x0) / g.cell);
      const iz = Math.floor((r.z - g.z0) / g.cell);
      const k = iz * g.nx + ix;
      if (inArea.has(k)) withSample.add(k);
    }
    expect(cov.measured).toBe(withSample.size);
  });
});

describe('Phase 3B+ — faster BEE-01 with governors', () => {
  const { engine, state } = completedRun();
  const cfg = engine.config;
  const b1 = flying(state, 'BEE-01');

  it('BEE-01 is the fastest bee; BEE-02 and BEE-03 keep their speed', () => {
    const m1 = Math.max(...b1.map(hspeed));
    const m2 = Math.max(...flying(state, 'BEE-02').map(hspeed));
    const m3 = Math.max(...flying(state, 'BEE-03').map(hspeed));
    expect(m1).toBeGreaterThan(SC.speed_mps - 0.2);
    expect(m1).toBeLessThanOrEqual(P1.maxSpeedXZ * 1.05 + 1e-9);
    expect(m1).toBeGreaterThan(Math.max(m2, m3) + 2);
    expect(m2).toBeLessThanOrEqual(cfg.bee.maxSpeedXZ * 1.05 + 1e-9);
    expect(m3).toBeLessThanOrEqual(cfg.bee.maxSpeedXZ * 1.05 + 1e-9);
    expect(cfg.bee.maxSpeedXZ).toBe(5);
  });

  it('the speed is configurable', () => {
    const r = completedRun({ bee: { profiles: { 'BEE-01': { ...P1, maxSpeedXZ: 7 } } }, survey: { speed_mps: 6.5 } });
    const m = Math.max(...flying(r.state, 'BEE-01').map(hspeed));
    expect(m).toBeLessThanOrEqual(7 * 1.05);
    expect(m).toBeGreaterThan(6);
  });

  it('slows down close to obstacles', () => {
    const infl = cfg.bee.bodyRadius + cfg.bee.obstacleSafetyMargin;
    const near = b1.filter((p) => obstacleDistance(engine.world.obstacles.filter((o) => o.height + cfg.bee.obstacleVerticalMargin >= p.y), p.x, p.z) < infl + 0.5);
    expect(near.length).toBeGreaterThan(0);
    for (const p of near) expect(hspeed(p)).toBeLessThan(P1.obstacleSlowdownMinSpeed_mps + 1.5);
  });

  it('slows down on hotspot investigations', () => {
    const route = state.bees[0].route;
    const adapt = b1.filter((p) => {
      const w = route[Math.min(p.waypointIndex, route.length - 1)];
      return w && (w.block ?? '').startsWith('ADAPT-') && w.tag === 'ADAPTIVE';
    });
    expect(adapt.length).toBeGreaterThan(5);
    const v = adapt.map(hspeed).sort((a, b) => a - b);
    expect(v[Math.floor(v.length / 2)]).toBeLessThanOrEqual(SC.adaptive.speed_mps + 0.3);
  });

  it('slows down after an elevated on-board reading (measurement quality first)', () => {
    let checked = 0;
    for (const r of state.radiation.samples) {
      if (r.measured_uSv_h < P1.elevatedRate_uSv_h) continue;
      for (const p of b1) {
        if (p.time > r.time + 1.3 && p.time < r.time + P1.elevatedHold_s - 0.1) { // ≥ 1 s to brake from 9 to 5 m/s
          expect(hspeed(p)).toBeLessThan(P1.elevatedSpeed_mps * 1.05 + 0.3);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('slows down before sharp lane turns', () => {
    const route = state.bees[0].route;
    let n = 0;
    for (let i = 1; i < route.length - 1; i++) {
      const w = route[i];
      if (w.block !== 'LAWN') continue;
      const a = route[i - 1];
      const b = route[i + 1];
      const ux = w.x - a.x;
      const uz = w.z - a.z;
      const vx = b.x - w.x;
      const vz = b.z - w.z;
      const cos = (ux * vx + uz * vz) / Math.max(1e-9, Math.hypot(ux, uz) * Math.hypot(vx, vz));
      if (cos > 0) continue; // ≥ 90° turn
      const close = b1.filter((p) => Math.hypot(p.x - w.x, p.z - w.z) < 0.8 && Math.abs(p.y - w.y) < 2);
      for (const p of close) expect(hspeed(p)).toBeLessThan(0.75 * SC.speed_mps);
      n += close.length;
    }
    expect(n).toBeGreaterThan(5);
  });

  it('samples at least every maxSampleSpacing (no artificial gaps along the track)', () => {
    const R = cfg.radiation;
    const rad = state.radiation.samples;
    for (const s of rad) expect(s.liveTime_s).toBeLessThanOrEqual(R.integrationTime_s + 1e-9);
    let maxSpacing = 0;
    for (let i = 1; i < rad.length; i++) {
      if (rad[i].time - rad[i - 1].time > R.integrationTime_s + 1e-6) continue; // detector paused (docked) — not a track gap
      maxSpacing = Math.max(maxSpacing, Math.hypot(rad[i].x - rad[i - 1].x, rad[i].z - rad[i - 1].z));
    }
    // window-mean positions of consecutive windows ≤ spacing + one step of travel
    expect(maxSpacing).toBeLessThanOrEqual(R.maxSampleSpacing_m + P1.maxSpeedXZ * 1.05 * cfg.dt + 0.5);
  });

  it('keeps drones separated', () => {
    expect(state.minSeparation.beeBee_m).toBeGreaterThanOrEqual(cfg.bee.beeSeparation);
    expect(state.minSeparation.motherBee_m).toBeGreaterThanOrEqual(cfg.bee.beeSeparation);
    expect(Number.isFinite(state.minSeparation.beeBee_m)).toBe(true);
  });

  it('completes the full-area scan faster than at 5 m/s with the same coverage and elevated-area accuracy', () => {
    const slow = completedRun(SLOW_BEE01);
    const dur = (st: SimState) => (st.survey.surveyCompleteTime as number) - (st.survey.surveyStartTime as number);
    expect(dur(state)).toBeLessThan(0.92 * dur(slow.state));
    const cf = surveyCoverage(buildHeatmap(state.radiation.samples, cfg.radiation.heatmap), cfg, engine.world);
    const cs = surveyCoverage(buildHeatmap(slow.state.radiation.samples, cfg.radiation.heatmap), slow.engine.config, slow.engine.world);
    expect(cf.fractionReachable).toBeGreaterThanOrEqual(cs.fractionReachable - 0.01);
    const ef = cellError(state, cfg);
    const es = cellError(slow.state, slow.engine.config);
    expect(ef.elevatedCells).toBeGreaterThan(50);
    expect(ef.elevated).toBeLessThanOrEqual(es.elevated * 1.15);
    // background cells are counting-limited (5 cps): slightly noisier, but bounded
    expect(ef.all).toBeLessThanOrEqual(es.all * 1.25);
  });
});

describe('Phase 3B+ — casualty record survives recovery, return, landing and completion', () => {
  it('keeps the last recorded assessment at every late phase', () => {
    const e = new SimEngine();
    e.start();
    // before recovery (the recall happens in the same step as OBJECTIVES_COMPLETE) the feed is live
    e.runUntil((s) => s.survey.surveyCompleteTime !== null);
    const at = patientViews(e.state, e.config)[0];
    expect(at.dataState).toBe('ASSESSED');
    const ref = JSON.stringify(at.record.assessment);
    for (const ph of ['RECOVERY', 'RETURN', 'LANDING', 'COMPLETE'] as const) {
      e.runUntil((s) => s.mission.phase === ph);
      e.step();
      const v = patientViews(e.state, e.config)[0];
      expect(v.record.assessment === null).toBe(false);
      expect(v.record.latestVitals === null).toBe(false);
      expect(v.record.location === null).toBe(false);
      expect(v.dataState).toBe('RECORDED');
      // the assessment is the last one received before the feed ended — it is not reset
      expect(v.record.assessment!.assessedAt).toBeGreaterThanOrEqual(JSON.parse(ref).assessedAt);
    }
    expect(e.state.status).toBe('COMPLETE');
    expect(missionAlerts(e.state, e.config).some((a) => a.code === 'PATIENT_DATA_UNAVAILABLE')).toBe(false);
  });

  it('exports the record (CSV + snapshot) and clears it only on reset', () => {
    const { engine, state } = completedRun();
    const files = datasetFiles(engine);
    const csv = Object.entries(files).find(([k]) => k.endsWith('mission_control/patient_records.csv'))![1] as string;
    const [head, row] = csv.trim().split(/\r?\n/);
    const cols = head.split(',');
    const vals = row.split(',');
    const get = (c: string) => vals[cols.indexOf(c)];
    const p = state.comms.gs.patients[0];
    expect(get('patient_id')).toBe(p.patientId);
    expect(get('data_state_at_export')).toBe('RECORDED');
    expect(get('assessment_risk')).toBe(p.assessment!.risk);
    expect(Math.abs((Number(get('assessed_at_s'))) - (p.assessment!.assessedAt))).toBeLessThan(1e-2);
    expect(Math.abs((Number(get('location_x_m'))) - (p.location!.x))).toBeLessThan(1e-2);
    const snap = missionControlSnapshot(engine) as { patients: { data_state: string; assessment: unknown }[] };
    expect(snap.patients[0].data_state).toBe('RECORDED');
    engine.reset();
    expect(engine.state.comms.gs.patients).toHaveLength(0);
  });
});

describe('Phase 3B+ — radiation-minimized rescue-team route', () => {
  const { engine, state } = completedRun();
  const cfg = engine.config;
  const p = state.rescue.current!;
  const rec = p.candidates.find((c) => c.id === p.recommendedId)!;

  it('is planned from GS data, from the rescue-team start to the casualty, and kept after COMPLETE', () => {
    expect(state.status).toBe('COMPLETE');
    expect(state.mission.phase).toBe('COMPLETE');
    expect(!!p).toBe(true);
    expect(p.status).toBe('VERIFIED');
    expect(!!rec).toBe(true);
    const w = rec.waypoints;
    expect(Math.hypot(w[0].x - cfg.rescue.start.x, w[0].z - cfg.rescue.start.z)).toBeLessThan(1.5);
    const loc = state.comms.gs.patients[0].location!;
    expect(Math.hypot(w[w.length - 1].x - loc.x, w[w.length - 1].z - loc.z)).toBeLessThan(1.5);
    // evaluation reproduces from the ground-station grid (no truth)
    const ev = evaluateCorridor(rec.id, w, gsRadiationGrid({ state, config: cfg }), engine.world.obstacles, cfg, state.time);
    expect(Math.abs((ev.doseMeasured_uSv) - (rec.evaluation.doseMeasured_uSv))).toBeLessThan(1e-12);
    expect(p.sections.length).toBeGreaterThan(0);
    expect(eventsOf(state, 'RESCUE_ROUTE_PLANNED').length).toBeGreaterThan(0);
  });

  it('never passes through buildings, tanks or debris', () => {
    for (const c of p.candidates) expect(c.evaluation.minObstacleDistance_m).toBeGreaterThanOrEqual(cfg.evacuation.clearance_m - 0.05);
  });

  it('prefers the lowest estimated exposure among verified routes (not simply the shortest)', () => {
    const verified = p.candidates.filter((c) => c.verified);
    expect(verified.length).toBeGreaterThan(0);
    const minDose = Math.min(...verified.map((c) => c.evaluation.doseTotal_uSv as number));
    const sg = Math.max(...verified.map((c) => c.evaluation.doseTotalSigma_uSv as number));
    expect(rec.verified).toBe(true);
    // within the comparison margin max(2σ, 10 %) of the lowest estimate (indistinguishable doses → shorter route)
    expect(rec.evaluation.doseTotal_uSv as number).toBeLessThanOrEqual(minDose + Math.max(2 * Math.SQRT2 * sg, SYSTEMATIC * minDose) + 1e-12);
    // any longer verified route is not significantly lower in dose than the recommendation
    for (const c of verified)
      if (c.evaluation.length_m > rec.evaluation.length_m + 0.5)
        expect((rec.evaluation.doseTotal_uSv as number) - (c.evaluation.doseTotal_uSv as number)).toBeLessThanOrEqual(Math.max(2 * Math.SQRT2 * sg, SYSTEMATIC * minDose) + 1e-12);
    expect(rec.evaluation.maxRate_uSv_h as number).toBeLessThan(cfg.rescue.maxRate_uSv_h);
    expect(rec.evaluation.coverage).toBeGreaterThanOrEqual(cfg.survey.validation.surveyedFraction);
    // candidates use increasing radiation weights; κ = 0 is the plain shortest route
    expect(p.candidates[0].kappa).toBe(0);
    expect(p.rule.length).toBeGreaterThan(10);
  });

  it('flags unknown / estimated ground and warns instead of claiming a safe route', () => {
    const r = completedRun({ survey: { corridor: { enabled: false } } });
    const q = r.state.rescue.current!;
    expect(q.status).toBe('UNVERIFIED');
    expect(q.warnings.some((w) => w.startsWith('No sufficiently verified'))).toBe(true);
    expect(q.sections.some((s) => s.kind !== 'MEASURED')).toBe(true);
    const recq = q.candidates.find((c) => c.id === q.recommendedId)!;
    expect(recq.evaluation.doseTotal_uSv).toBe(null); // lower bound only — unknown is not counted as zero
  });

  it('v0.7.0 default rule: detours around a source near the direct path over MEASURED ground (verified on data, not claimed safe)', () => {
    const r = completedRun({ radiation: { sourcePosition: { x: -36, y: 0.5, z: 30 } } });
    const q = r.state.rescue.current!;
    const short = q.candidates.find((c) => c.kappa === 0)!;
    const recq = q.candidates.find((c) => c.id === q.recommendedId)!;
    expect(short.verified).toBe(false);
    expect(short.rateCheck).toBe('FAIL');
    expect(recq.id === short.id).toBe(false);
    expect(rescueTruth(recq, r.engine.config).at1m.dose_uSv).toBeLessThan(0.2 * rescueTruth(short, r.engine.config).at1m.dose_uSv);
    expect(q.status).toBe('VERIFIED');
    expect(recq.dataCheck).toBe('PASS');
    expect(recq.rateCheck).toBe('PASS');
  });

  it('detours around a source near the direct path — and warns when the detour is not surveyed (v0.6.0 unknown-ground rule)', () => {
    // v0.7.0: with the v0.6.0 rule (unknown ground at 3 × background) the detour leaves the surveyed area
    const r = completedRun({ radiation: { sourcePosition: { x: -36, y: 0.5, z: 30 } }, evacuation: { unknownPolicy: 'BACKGROUND_MULTIPLE' } });
    const q = r.state.rescue.current!;
    const short = q.candidates.find((c) => c.kappa === 0)!;
    const recq = q.candidates.find((c) => c.id === q.recommendedId)!;
    // the shortest route crosses a measured rate above the limit → not verified, not recommended
    expect(short.verified).toBe(false);
    expect(short.issues.some((x) => x.includes('µSv/h on the route'))).toBe(true);
    expect(recq.id === short.id).toBe(false);
    // the recommended detour really is far lower in TRUE dose (evaluation only)
    expect(rescueTruth(recq, r.engine.config).at1m.dose_uSv).toBeLessThan(0.2 * rescueTruth(short, r.engine.config).at1m.dose_uSv);
    // it leaves the surveyed area, so it is shown as UNVERIFIED with a warning — never as safe
    expect(q.status).toBe('UNVERIFIED');
    expect(q.warnings.some((w) => w.startsWith('No sufficiently verified'))).toBe(true);
  });

  it('freezes when the operator requests rescue', () => {
    const e = new SimEngine();
    e.start();
    e.runUntil((s) => s.rescue.current !== null && s.evacuation.cases[0]?.stage === 'ROUTE_PLANNED' && s.time > 200);
    expect(e.operatorCommand(e.state.evacuation.cases[0].patientId, 'REQUEST_RESCUE')).toBe(true);
    e.runUntil((s) => s.rescue.current!.frozen);
    const id = e.state.rescue.current!.planId;
    e.runToCompletion();
    expect(e.state.rescue.current!.planId).toBe(id);
    expect(e.state.rescue.current!.frozen).toBe(true);
  });

  it('exports the candidates, the sections and a separate ground-truth file', () => {
    const files = datasetFiles(engine);
    const key = (s: string) => Object.keys(files).find((k) => k.endsWith(s));
    const routes = files[key('mission_control/rescue_routes.csv')!] as string;
    expect(routes.split(/\r?\n/)[0].includes('true_')).toBe(false);
    expect(routes.includes(',true,')).toBe(true);
    expect((files[key('mission_control/rescue_route_sections.csv')!] as string).trim().split(/\r?\n/).length).toBe(p.sections.length + 1);
    expect(files[key('ground_truth/rescue_route_truth.csv')!] as string).toContain('SIMULATED_GROUND_TRUTH');
    const snap = missionControlSnapshot(engine) as { rescue_route: { legend: string; status: string } };
    expect(snap.rescue_route.legend).toContain('Recommended Rescue Route — Radiation-Minimized');
    expect(snap.rescue_route.status).toBe('VERIFIED');
  });
});

describe('Phase 3B+ — compatibility and determinism', () => {
  it('PHASE3A_SURVEY restores the Phase 3A survey (area, 5 m/s, time-only windows, no rescue route)', () => {
    const { engine, state } = completedRun({ ...PHASE3A_SURVEY, mission: { lifecycle: false } });
    expect(engine.config.survey.area).toEqual({ x0: -4, z0: 4, x1: 52, z1: 44 });
    expect(state.rescue.enabled).toBe(false);
    expect(state.rescue.current).toBe(null);
    expect(state.corridor.rescueLeg).toBe(null);
    for (const s of state.radiation.samples) expect(s.liveTime_s).toBe(engine.config.radiation.integrationTime_s);
    expect(Math.max(...flying(state, 'BEE-01').map(hspeed))).toBeLessThanOrEqual(engine.config.bee.maxSpeedXZ * 1.05);
    expect(eventsOf(state, 'SURVEY_GAP_FILL')).toHaveLength(0);
    expect(eventsOf(state, 'RESCUE_ROUTE_PLANNED')).toHaveLength(0);
    expect(Object.keys(datasetFiles(engine)).some((k) => k.includes('rescue_'))).toBe(false);
  });

  it('is deterministic (same seed → same survey, rescue plan and separation)', () => {
    const a = completedRun({ seed: 7 }).state;
    const b = completedRun({ seed: 7 }).state;
    expect(a.time).toBe(b.time);
    expect(a.events.length).toBe(b.events.length);
    expect(JSON.stringify(a.rescue.current)).toBe(JSON.stringify(b.rescue.current));
    expect(a.minSeparation).toEqual(b.minSeparation);
    expect(a.survey.coverageAtComplete).toEqual(b.survey.coverageAtComplete);
  });
});
