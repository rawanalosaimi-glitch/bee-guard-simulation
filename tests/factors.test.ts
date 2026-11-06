import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, EXPERIMENT_SCENARIOS, SimEngine, WORLD, obstacleProximity, runOne } from '../src/sim';
import { EXTRA_OBSTACLES_HIGH, FACTOR_LEVELS, WORLD_CLUTTER_HIGH, WORLD_CLUTTER_LOW } from '../src/scenarios/factors';

// Factor Study F1 (2026-10-26): clutter / speed / autonomy levels are separate from the frozen study.
const MEDIUM = EXPERIMENT_SCENARIOS.find((s) => s.id === 'MEDIUM')!;

describe('scenario factors (clutter, speed, autonomy)', () => {
  it('each factor has exactly one baseline level, equal to the validated configuration', () => {
    for (const f of ['clutter', 'speed', 'autonomy'] as const) {
      const base = FACTOR_LEVELS.filter((l) => l.factor === f && l.baseline);
      expect(base).toHaveLength(1);
      expect(Object.keys(base[0].overrides)).toHaveLength(0);
      expect(base[0].world === WORLD).toBe(true);
    }
  });

  it('clutter levels change only the obstacle list; the baseline world object is untouched', () => {
    expect(WORLD.obstacles).toHaveLength(9);
    expect(WORLD_CLUTTER_LOW.obstacles.length).toBeLessThan(WORLD.obstacles.length);
    expect(WORLD_CLUTTER_HIGH.obstacles.length).toBe(WORLD.obstacles.length + EXTRA_OBSTACLES_HIGH.length);
    for (const w of [WORLD_CLUTTER_LOW, WORLD_CLUTTER_HIGH]) {
      expect(w.casualty).toEqual(WORLD.casualty);
      expect(w.radiationSource).toEqual(WORLD.radiationSource);
      expect(w.groundStation).toEqual(WORLD.groundStation);
    }
  });

  it('extra HIGH-clutter obstacles keep ≥ 10 m from the casualty, source, relay, hold point, pad and ground station', () => {
    const keep = [
      [WORLD.casualty.position.x, WORLD.casualty.position.z], [WORLD.radiationSource.position.x, WORLD.radiationSource.position.z],
      [-26, 23], [-8, 30], [-18, 32], [DEFAULT_CONFIG.mission.pad.x, DEFAULT_CONFIG.mission.pad.z], [WORLD.groundStation.position.x, WORLD.groundStation.position.z],
    ];
    for (const o of EXTRA_OBSTACLES_HIGH) for (const [x, z] of keep) expect(obstacleProximity(o, x, z).distance).toBeGreaterThanOrEqual(10);
  });

  it('speed levels scale the speed caps and nothing else', () => {
    const lo = FACTOR_LEVELS.find((l) => l.id === 'SPEED-LOW')!.overrides;
    const hi = FACTOR_LEVELS.find((l) => l.id === 'SPEED-HIGH')!.overrides;
    expect(Math.abs(lo.survey!.speed_mps! - DEFAULT_CONFIG.survey.speed_mps * 0.6)).toBeLessThan(0.051);
    expect(Math.abs(hi.survey!.speed_mps! - DEFAULT_CONFIG.survey.speed_mps * 1.4)).toBeLessThan(0.051);
    expect(hi.bee!.profiles!['BEE-01']!.maxAccel).toBe(DEFAULT_CONFIG.bee.profiles['BEE-01']!.maxAccel);
    expect(Object.keys(hi).sort()).toEqual(['bee', 'mother', 'survey']);
  });

  it('every non-baseline level completes the MEDIUM mission headless (seed 101)', () => {
    for (const lv of FACTOR_LEVELS.filter((l) => !l.baseline)) {
      const r = runOne(MEDIUM, 101, { extra: lv.overrides, engineFactory: (cfg) => new SimEngine(cfg, lv.world) });
      expect(`${lv.id}:${r.status}:${r.row.final_phase}`).toBe(`${lv.id}:OK:COMPLETE`);
    }
  });

  it('the baseline level reproduces the frozen v0.8.0-rc1 MEDIUM seed-101 summary row', async () => {
    const fsName = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, enc: string) => string };
    const csv = fs.readFileSync('experiments/reference_results_v0.8.0-rc1/runs_summary.csv', 'utf8').trim().split('\n');
    const head = csv[0].split(',');
    const ref = csv.map((l: string) => l.split(',')).find((c: string[]) => c[0] === 'MEDIUM' && c[1] === '101')!;
    const r = runOne(MEDIUM, 101);
    for (const k of ['mission_duration_s', 'rad_samples', 'map_gs_rmse_uSv_h', 'hr_mae_bpm', 'comms_sent', 'comms_delivered', 'rescue_status']) {
      expect(String(r.row[k as keyof typeof r.row])).toBe(ref[head.indexOf(k)]);
    }
  });
});
