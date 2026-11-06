import { describe, expect, it } from 'vitest';
import { BEE_IDS, DEFAULT_CONFIG, MISSION_PHASES, SimEngine, WORLD, missionMilestones, obstacleDistance } from '../src/sim';
import type { WorldDefinition } from '../src/sim';
import { completedRun, eventsOf } from './helpers';

const MC = DEFAULT_CONFIG.mission;
const RC = MC.recovery;
const motherSamples = (s: { samples: { entityId: string; time: number; x: number; y: number; z: number; mode: string }[] }) => s.samples.filter((x) => x.entityId === 'MOTHER-01');

describe('Phase 3B — mission lifecycle (default run)', () => {
  const { engine, state } = completedRun();
  const ms = state.mission;

  it('passes through every phase in order and ends COMPLETE only after touchdown', () => {
    const seq = eventsOf(state, 'MISSION_PHASE').map((e) => e.details.split(' ')[0]);
    expect(seq).toEqual(MISSION_PHASES.slice(1)); // TAKEOFF … COMPLETE
    expect(ms.phase).toBe('COMPLETE');
    const touchdown = eventsOf(state, 'TOUCHDOWN')[0].time;
    expect(ms.phaseTimes.COMPLETE as number).toBeGreaterThanOrEqual(touchdown);
    expect(eventsOf(state, 'MISSION_COMPLETE')).toHaveLength(1);
    expect(eventsOf(state, 'MISSION_COMPLETE')[0].details.startsWith('COMPLETE')).toBe(true);
    expect(state.mother.mode).toBe('LANDED');
  });

  it('the mother starts on the ground-station pad and takes off vertically', () => {
    const m = motherSamples(state);
    expect(m[0].x).toBe(MC.pad.x);
    expect(m[0].z).toBe(MC.pad.z);
    expect(m[0].y).toBe(MC.padRestHeight_m);
    const climb = m.filter((x) => x.mode === 'TAKEOFF');
    expect(climb.length).toBeGreaterThan(10);
    // vertical: tiny horizontal drift, monotone climb, never above the climb rate
    expect(ms.takeoff.maxDrift_m).toBeLessThan(0.5);
    for (let i = 1; i < climb.length; i++) {
      expect(climb[i].y).toBeGreaterThanOrEqual(climb[i - 1].y - 1e-6);
      expect((climb[i].y - climb[i - 1].y) / (climb[i].time - climb[i - 1].time)).toBeLessThanOrEqual(MC.climbRate_mps + 0.2);
    }
    expect(eventsOf(state, 'TAKEOFF_COMPLETE')[0].time).toBeLessThan(eventsOf(state, 'MOTHER_ARRIVED')[0].time);
  });

  it('deployment safety rules still hold: releases only while hovering with the hatch fully open', () => {
    for (const ev of eventsOf(state, 'BEE_RELEASED')) {
      const hatch = Number(/hatch=([\d.]+)/.exec(ev.details)![1]);
      const speed = Number(/motherSpeed=([\d.]+)/.exec(ev.details)![1]);
      expect(hatch).toBe(1);
      expect(speed).toBeLessThan(0.8);
      expect(ev.time).toBeGreaterThan(eventsOf(state, 'MOTHER_ARRIVED')[0].time);
    }
  });

  it('recovery starts only after the objectives are complete, with every bee recalled to its rendezvous', () => {
    const obj = ms.objectivesCompleteAt as number;
    expect(obj).toBeGreaterThan(state.corridor.decision.time - 1e-9);
    expect(state.corridor.decision.final).toBe(true);
    for (const id of BEE_IDS) {
      expect(eventsOf(state, 'BEE_RTB', id)[0].time).toBeGreaterThanOrEqual(obj);
      expect(eventsOf(state, 'BEE_STAGED', id)).toHaveLength(1);
    }
  });

  it('docks the three bees sequentially, each after a verified alignment, and closes the hatch only after 3/3', () => {
    const docked = eventsOf(state, 'BEE_DOCKED');
    expect(docked.map((e) => e.entityId)).toEqual(['BEE-01', 'BEE-02', 'BEE-03']);
    for (let i = 1; i < docked.length; i++) {
      // the next approach starts only after the previous bee is in the bay
      const nextApproach = eventsOf(state, 'DOCK_APPROACH', docked[i].entityId)[0].time;
      expect(nextApproach).toBeGreaterThanOrEqual(docked[i - 1].time);
    }
    for (const a of ms.recovery.attempts.filter((x) => x.result === 'DOCKED')) {
      expect(a.alignError_m as number).toBeLessThan(RC.alignTolerance_m);
      expect(a.maxAscentError_m as number).toBeLessThanOrEqual(RC.abortTolerance_m);
      expect(a.captureError_m as number).toBeLessThan(RC.dockTolerance_m);
    }
    const closed = eventsOf(state, 'HATCH_CLOSED');
    expect(closed).toHaveLength(2);
    expect(closed[1].time).toBeGreaterThanOrEqual(docked[2].time);
    expect(closed[1].details).toContain('3/3');
    expect(ms.recovery.docked).toHaveLength(3);
    expect(ms.recovery.failed).toHaveLength(0);
    expect(state.bees.every((b) => b.mode === 'DOCKED')).toBe(true);
  });

  it('docked bees ride in their bay slots during the return flight', () => {
    const ret = state.samples.filter((x) => x.time > (ms.phaseTimes.RETURN as number) + 1 && x.time < (ms.phaseTimes.LANDING as number));
    const m = new Map(ret.filter((x) => x.entityId === 'MOTHER-01').map((x) => [x.step, x]));
    let n = 0;
    for (const b of ret.filter((x) => x.entityId !== 'MOTHER-01')) {
      const mm = m.get(b.step)!;
      expect(b.mode).toBe('DOCKED');
      expect(Math.hypot(b.x - mm.x, b.y - mm.y, b.z - mm.z)).toBeLessThan(1.2);
      n++;
    }
    expect(n).toBeGreaterThan(10);
  });

  it('returns to the pad and lands within tolerance at a gentle vertical speed', () => {
    expect(ms.landing.onPad).toBe(true);
    expect(ms.landing.horizontalError_m as number).toBeLessThanOrEqual(MC.landingTolerance_m);
    expect(ms.landing.verticalSpeed_mps as number).toBeLessThanOrEqual(MC.finalDescentRate_mps + 0.1);
    const m = state.mother;
    expect(Math.hypot(m.position.x - MC.pad.x, m.position.z - MC.pad.z)).toBeLessThanOrEqual(MC.landingTolerance_m);
    expect(m.position.y).toBe(MC.padRestHeight_m);
    // descent only once centred over the pad
    const land = motherSamples(state).filter((x) => x.mode === 'LANDING');
    for (const x of land) if (x.y < MC.cruiseAltitude_m - 1) expect(Math.hypot(x.x - MC.pad.x, x.z - MC.pad.z)).toBeLessThan(1.6);
  });

  it('BEE-01 survey and corridor science are unchanged in kind (recovery adds data after objectives only)', () => {
    expect(state.corridor.decision.status).toBe('SURVEY_VALIDATED');
    expect(state.survey.surveyCompleteTime).not.toBe(null);
    expect(state.evacuation.cases[0].stage).not.toBe('EVACUATED'); // never automatic
    expect(eventsOf(state, 'LINK_LOST').every((e) => e.time < (ms.recovery.completedAt as number) || e.entityId === 'BEE-03')).toBe(true);
    void engine;
  });
});

describe('Phase 3B — failure handling', () => {
  it('an unresponsive bee is never reported docked; the mission ends INCOMPLETE after landing', () => {
    const e = new SimEngine({ mission: { faults: { unresponsiveBees: ['BEE-02'] } } });
    e.runToCompletion();
    const s = e.state;
    expect(eventsOf(s, 'BEE_DOCKED', 'BEE-02')).toHaveLength(0);
    expect(s.mission.recovery.failed.map((f) => [f.bee, f.reason])).toEqual([['BEE-02', 'NO_RESPONSE']]);
    expect(s.bees.find((b) => b.id === 'BEE-02')!.mode).not.toBe('DOCKED');
    expect(s.mission.recovery.docked.sort()).toEqual(['BEE-01', 'BEE-03']);
    expect(eventsOf(s, 'RECOVERY_INCOMPLETE')).toHaveLength(1);
    expect(eventsOf(s, 'RECOVERY_COMPLETE')).toHaveLength(0);
    expect(s.mission.phase).toBe('INCOMPLETE');
    expect(eventsOf(s, 'MISSION_COMPLETE')[0].details.startsWith('INCOMPLETE')).toBe(true);
    expect(s.mother.mode).toBe('LANDED');
  });

  it('docking that never aligns → attempts time out, retried, then DOCK_FAILED; nothing is falsely docked', () => {
    const e = new SimEngine({ mission: { recovery: { alignTolerance_m: 0.0001 } } });
    e.runToCompletion();
    const s = e.state;
    expect(eventsOf(s, 'BEE_DOCKED')).toHaveLength(0);
    expect(s.mission.recovery.attempts.filter((a) => a.result === 'TIMEOUT')).toHaveLength(3 * RC.maxAttempts);
    expect(s.mission.recovery.failed.map((f) => f.reason)).toEqual(['ALIGNMENT_TIMEOUT', 'ALIGNMENT_TIMEOUT', 'ALIGNMENT_TIMEOUT']);
    expect(s.bees.every((b) => b.mode === 'DOCK_FAILED')).toBe(true);
    expect(s.mission.phase).toBe('INCOMPLETE');
  });

  it('a mission that cannot finish in time stops as TIMEOUT, never COMPLETE', () => {
    const e = new SimEngine({ maxMissionTime: 150 });
    e.runToCompletion();
    expect(e.state.mission.phase).toBe('TIMEOUT');
    expect(eventsOf(e.state, 'MISSION_TIMEOUT')).toHaveLength(1);
    expect(eventsOf(e.state, 'MISSION_COMPLETE')).toHaveLength(0);
  });
});

describe('Phase 3B — obstacle-aware transit and return', () => {
  // a 40 m tower on the straight line between the deployment point and the pad
  const tower = { id: 'OBS-TOWER', kind: 'stack' as const, label: 'Test tower', shape: 'cylinder' as const, cx: -40, cz: 50, radius: 3, height: 40 };
  const world: WorldDefinition = { ...WORLD, obstacles: [...WORLD.obstacles, tower] };

  it('the straight line would hit the tower', () => {
    const hp = DEFAULT_CONFIG.mother.hoverPoint;
    let min = Infinity;
    for (let t = 0; t <= 1; t += 0.01) min = Math.min(min, obstacleDistance([tower], MC.pad.x + (hp.x - MC.pad.x) * t, MC.pad.z + (hp.z - MC.pad.z) * t));
    expect(min).toBeLessThan(DEFAULT_CONFIG.mother.bodyRadius);
  });

  it('outbound and return legs detour around it and the mother keeps clear; the mission still completes', () => {
    const e = new SimEngine({}, world);
    e.runToCompletion();
    const s = e.state;
    expect(s.mission.outboundRoute.length).toBeGreaterThan(1);
    expect(s.mission.returnRoute.length).toBeGreaterThan(1);
    for (const p of [...s.mission.outboundRoute, ...s.mission.returnRoute]) expect(obstacleDistance([tower], p.x, p.z)).toBeGreaterThan(DEFAULT_CONFIG.mother.bodyRadius);
    expect(s.mission.motherMinClearance_m).toBeGreaterThan(0);
    for (const x of motherSamples(s)) if (x.y < tower.height + 2) expect(obstacleDistance([tower], x.x, x.z)).toBeGreaterThan(DEFAULT_CONFIG.mother.bodyRadius);
    expect(s.mission.phase).toBe('COMPLETE');
  });
});

describe('Phase 3B — determinism and Phase 3A compatibility', () => {
  it('same seed → identical lifecycle', () => {
    const a = new SimEngine({ seed: 11 });
    const b = new SimEngine({ seed: 11 });
    a.runToCompletion();
    b.runToCompletion();
    expect(JSON.stringify(a.state.mission)).toBe(JSON.stringify(b.state.mission));
    expect(a.state.samples.length).toBe(b.state.samples.length);
  });

  it('lifecycle disabled → Phase 3A behaviour: airborne spawn, no recovery, bees loiter at the end', () => {
    const e = new SimEngine({ mission: { lifecycle: false } });
    e.runToCompletion();
    const s = e.state;
    expect(s.samples[0].x).toBe(DEFAULT_CONFIG.mother.spawn.x);
    expect(s.bees.every((b) => b.mode === 'LOITER')).toBe(true);
    expect(s.mother.mode).toBe('OVERWATCH');
    expect(eventsOf(s, 'MISSION_PHASE')).toHaveLength(0);
    expect(eventsOf(s, 'BEE_RTB')).toHaveLength(0);
  });

  it('completes on 8 seeds with all bees docked and on-pad landings', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { state } = completedRun({ seed });
      expect(state.mission.phase).toBe('COMPLETE');
      expect(state.mission.recovery.docked).toHaveLength(3);
      expect(state.mission.landing.onPad).toBe(true);
      expect(eventsOf(state, 'WAYPOINT_SKIPPED')).toHaveLength(0);
    }
  });
});

describe('Phase 3B — milestones survive the return-to-base re-route', () => {
  it('keeps "Relay on station" done after BEE-03 is re-routed to the rendezvous', () => {
    const { state } = completedRun();
    const ms = missionMilestones(state);
    const relay = ms.find((m) => m.key === 'relay')!;
    expect(relay.done).toBe(true);
    expect(relay.time).toBe(state.events.find((e) => e.type === 'ROUTE_COMPLETE' && e.entityId === 'BEE-03')!.time);
    expect(ms.find((m) => m.key === 'landed')!.done).toBe(true);
    expect(ms.find((m) => m.key === 'recovered')!.done).toBe(true);
  });
});
