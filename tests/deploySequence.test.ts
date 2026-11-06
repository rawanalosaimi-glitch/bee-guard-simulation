import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SimEngine } from '../src/sim';
import { completedRun, eventsOf } from './helpers';

describe('mother arrival and deployment sequence', () => {
  const { state } = completedRun();
  // Phase 3B: the hatch cycles twice (deployment, then recovery) — the deployment cycle is the first one
  const t = (type: string, id?: string) => {
    const ev = eventsOf(state, type, id);
    expect(ev.length).toBeGreaterThanOrEqual(1);
    return ev[0].time;
  };

  it('follows arrive → hatch open → release 01,02,03 → hatch close', () => {
    const order = [
      t('MISSION_START'),
      t('MOTHER_ARRIVED'),
      t('HATCH_OPENING'),
      t('HATCH_OPENED'),
      t('BEE_RELEASED', 'BEE-01'),
      t('BEE_RELEASED', 'BEE-02'),
      t('BEE_RELEASED', 'BEE-03'),
      t('HATCH_CLOSING'),
      t('HATCH_CLOSED'),
      t('OBJECTIVES_COMPLETE'),
      t('MISSION_COMPLETE'),
    ];
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    expect(eventsOf(state, 'MISSION_COMPLETE')).toHaveLength(1);
    // the second hatch cycle belongs to the recovery, after the objectives were complete
    expect(eventsOf(state, 'HATCH_OPENED')).toHaveLength(2);
    expect(eventsOf(state, 'HATCH_OPENED')[1].time).toBeGreaterThan(t('OBJECTIVES_COMPLETE'));
  });

  it('releases bees one by one at the configured interval', () => {
    const released = eventsOf(state, 'BEE_RELEASED');
    expect(released.map((e) => e.entityId)).toEqual(['BEE-01', 'BEE-02', 'BEE-03']);
    for (let i = 1; i < released.length; i++) {
      const gap = released[i].time - released[i - 1].time;
      expect(gap).toBeGreaterThanOrEqual(DEFAULT_CONFIG.mother.releaseInterval - 1e-9);
    }
  });

  it('only releases bees while hovering with the hatch fully open', () => {
    const engine = new SimEngine();
    engine.start();
    const seen = new Set<string>();
    while (engine.state.status === 'ACTIVE') {
      engine.step();
      for (const b of engine.state.bees) {
        if (b.mode !== 'DOCKED' && !seen.has(b.id)) {
          seen.add(b.id);
          const m = engine.state.mother;
          expect(m.hatchOpen).toBe(1);
          expect(m.mode).toBe('DEPLOYING');
          expect(Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z)).toBeLessThan(1.0);
        }
      }
    }
    expect(seen.size).toBe(3);
  });

  it('keeps undeployed bees docked (moving with the mother) until their release', () => {
    const engine = new SimEngine();
    engine.start();
    engine.runUntil((s) => s.mother.mode === 'DEPLOYING');
    const [b1, b2, b3] = engine.state.bees;
    expect(b1.mode).toBe('RELEASING');
    expect(b2.mode).toBe('DOCKED');
    expect(b3.mode).toBe('DOCKED');
  });

  it('every bee reaches its final waypoint without skipping any', () => {
    expect(eventsOf(state, 'WAYPOINT_SKIPPED')).toHaveLength(0);
    expect(eventsOf(state, 'MISSION_TIMEOUT')).toHaveLength(0);
    for (const b of state.bees) {
      // Phase 3B: every bee finished its route (ROUTE_COMPLETE) and was then recovered into the bay
      expect(b.mode).toBe('DOCKED');
      expect(eventsOf(state, 'ROUTE_COMPLETE', b.id)).toHaveLength(1);
      expect(eventsOf(state, 'ROUTE_COMPLETE', b.id)[0].time).toBeLessThanOrEqual(state.mission.objectivesCompleteAt as number);
      // BEE-01 flies a generated survey route (Phase 3A); BEE-02/03 fly their configured routes
      // waypoints of the mission route (+ the return-to-rendezvous legs added at recovery)
      expect(eventsOf(state, 'WAYPOINT_REACHED', b.id)).toHaveLength(b.route.length);
      if (b.id !== 'BEE-01') expect(b.route.filter((w) => w.tag !== 'RTB').length).toBe(DEFAULT_CONFIG.routes[b.id].waypoints.length);
    }
  });
});
