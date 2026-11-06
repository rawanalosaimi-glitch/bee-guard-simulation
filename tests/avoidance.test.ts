import { describe, expect, it } from 'vitest';
import { BEE_IDS, DEFAULT_CONFIG, SimEngine, WORLD, obstacleProximity } from '../src/sim';
import { completedRun, eventsOf } from './helpers';

describe('waypoint routes and basic obstacle avoidance', () => {
  it('route waypoints are outside the avoidance influence zone of blocking obstacles', () => {
    const influence = DEFAULT_CONFIG.bee.bodyRadius + DEFAULT_CONFIG.bee.obstacleSafetyMargin;
    for (const id of BEE_IDS) {
      for (const wp of DEFAULT_CONFIG.routes[id].waypoints) {
        for (const o of WORLD.obstacles) {
          if (o.height + DEFAULT_CONFIG.bee.obstacleVerticalMargin < wp.y) continue;
          expect(obstacleProximity(o, wp.x, wp.z).distance).toBeGreaterThan(influence);
        }
      }
    }
  });

  it('routes are distinct per bee', () => {
    const keys = BEE_IDS.map((id) => JSON.stringify(DEFAULT_CONFIG.routes[id].waypoints));
    expect(new Set(keys).size).toBe(3);
  });

  it('straight-line routes would intersect obstacles (so avoidance is exercised)', () => {
    // at least one leg of BEE-01 and BEE-02 passes through a blocking footprint
    // (Phase 2: BEE-03 flies a short direct leg to its relay station)
    const crosses = (id: (typeof BEE_IDS)[number]) => {
      const wps = DEFAULT_CONFIG.routes[id].waypoints;
      for (let i = 1; i < wps.length; i++) {
        for (let t = 0; t <= 1; t += 0.01) {
          const x = wps[i - 1].x + (wps[i].x - wps[i - 1].x) * t;
          const z = wps[i - 1].z + (wps[i].z - wps[i - 1].z) * t;
          const y = wps[i - 1].y + (wps[i].y - wps[i - 1].y) * t;
          for (const o of WORLD.obstacles) {
            if (o.height < y) continue;
            if (obstacleProximity(o, x, z).inside) return true;
          }
        }
      }
      return false;
    };
    expect(crosses('BEE-01')).toBe(true);
    expect(crosses('BEE-02')).toBe(true);
  });

  it('no bee ever comes closer than its body radius to an obstacle (default seed)', () => {
    const { state } = completedRun();
    for (const id of BEE_IDS) expect(state.minClearance[id]).toBeGreaterThan(DEFAULT_CONFIG.bee.bodyRadius);
  });

  it('the sensing bees (BEE-01, BEE-02) trigger avoidance and log it', () => {
    const { state } = completedRun();
    for (const id of ['BEE-01', 'BEE-02']) expect(eventsOf(state, 'AVOIDANCE_START', id).length).toBeGreaterThan(0);
  });

  it('clearance and completion hold across 25 seeds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const e = new SimEngine({ seed });
      const s = e.runToCompletion();
      expect(s.status).toBe('COMPLETE');
      expect(eventsOf(s, 'MISSION_COMPLETE')).toHaveLength(1);
      expect(eventsOf(s, 'WAYPOINT_SKIPPED')).toHaveLength(0);
      for (const id of BEE_IDS) expect(s.minClearance[id]).toBeGreaterThan(DEFAULT_CONFIG.bee.bodyRadius);
    }
  });
});
