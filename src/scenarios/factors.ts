/**
 * BEE-GUARD — scenario FACTORS (added 2026-10-26, Factor Study F1).
 *
 * The supervisor's brief asks for scenarios that vary (1) obstacle / clutter density, (2) mobility
 * speed and (3) level of autonomy. The validated 30-run study (LOW / MEDIUM / HIGH, v0.8.0-rc1)
 * varies ONLY radiation source strength and casualty physiology, so these three dimensions are
 * added here as SEPARATE experimental factors.
 *
 * Nothing in src/sim is changed: every level is either
 *   - a WorldDefinition passed to the existing SimEngine(config, world) constructor (clutter), or
 *   - a SimConfigOverrides object applied through the existing makeConfig() mechanism (speed, autonomy).
 * The MEDIUM / FULL level of every factor is exactly the baseline (WORLD, DEFAULT_CONFIG), so the
 * frozen v0.8.0-rc1 results are unaffected and reproduce byte-for-byte.
 *
 * All values are design choices for a simulation study, not physical claims.
 */
import { DEFAULT_CONFIG, WORLD } from '../sim';
import type { Obstacle, SimConfigOverrides, WorldDefinition } from '../sim';

export type FactorId = 'clutter' | 'speed' | 'autonomy';

export interface FactorLevel {
  factor: FactorId;
  id: string;
  label: string;
  description: string;
  /** true for the level that equals the validated baseline. */
  baseline: boolean;
  overrides: SimConfigOverrides;
  world: WorldDefinition;
}

// ------------------------------------------------------------------ clutter (obstacle density)
const REMOVED_IN_LOW = ['OBS-CTRL', 'OBS-DEB-1', 'OBS-DEB-2', 'OBS-TK-3'];

/**
 * Extra obstacles for HIGH clutter. Placed ≥ 12 m from the casualty, the source, the relay station,
 * the mother hover point, BEE-02's waypoints, the pad, the ground station and the rescue start.
 * Tall ones (tanks, masts, warehouse) block the 15 m survey altitude; low ones (containers,
 * debris) block the ground rescue route.
 */
export const EXTRA_OBSTACLES_HIGH: Obstacle[] = [
  { id: 'OBS-WH-B', kind: 'warehouse', label: 'Warehouse B', shape: 'box', cx: 45, cz: -40, hx: 8, hz: 5, height: 12 },
  { id: 'OBS-TK-4', kind: 'tank', label: 'Storage tank 4', shape: 'cylinder', cx: 55, cz: -12, radius: 5, height: 14 },
  { id: 'OBS-TK-5', kind: 'tank', label: 'Storage tank 5', shape: 'cylinder', cx: -32, cz: -42, radius: 5, height: 14 },
  { id: 'OBS-MAST-1', kind: 'stack', label: 'Lighting mast 1', shape: 'cylinder', cx: 25, cz: -35, radius: 1.5, height: 30 },
  { id: 'OBS-CONT-2', kind: 'container', label: 'Container 2', shape: 'box', cx: 28, cz: 42, hx: 3, hz: 1.25, height: 2.6 },
  { id: 'OBS-CONT-3', kind: 'container', label: 'Container 3', shape: 'box', cx: -40, cz: 30, hx: 3, hz: 1.25, height: 2.6 },
  { id: 'OBS-DEB-3', kind: 'debris', label: 'Debris pile 3', shape: 'cylinder', cx: -50, cz: 40, radius: 3, height: 3 },
  { id: 'OBS-DEB-4', kind: 'debris', label: 'Debris pile 4', shape: 'cylinder', cx: 5, cz: -35, radius: 3, height: 3 },
  { id: 'OBS-DEB-5', kind: 'debris', label: 'Debris pile 5', shape: 'cylinder', cx: 60, cz: 35, radius: 2.5, height: 3 },
];

export const WORLD_CLUTTER_LOW: WorldDefinition = {
  ...WORLD,
  scenarioId: 'P1-CLUTTER-LOW',
  obstacles: WORLD.obstacles.filter((o) => !REMOVED_IN_LOW.includes(o.id)),
};
export const WORLD_CLUTTER_HIGH: WorldDefinition = {
  ...WORLD,
  scenarioId: 'P1-CLUTTER-HIGH',
  obstacles: [...WORLD.obstacles, ...EXTRA_OBSTACLES_HIGH],
};

// ------------------------------------------------------------------ mobility speed
const B01 = DEFAULT_CONFIG.bee.profiles['BEE-01']!;
function speedOverrides(scale: number): SimConfigOverrides {
  const r = (v: number) => Math.round(v * scale * 10) / 10;
  return {
    mother: { maxSpeedXZ: r(DEFAULT_CONFIG.mother.maxSpeedXZ) },
    bee: {
      maxSpeedXZ: r(DEFAULT_CONFIG.bee.maxSpeedXZ),
      profiles: { ...DEFAULT_CONFIG.bee.profiles, 'BEE-01': { ...B01, maxSpeedXZ: r(B01.maxSpeedXZ) } },
    },
    survey: { speed_mps: r(DEFAULT_CONFIG.survey.speed_mps) },
  };
}

// ------------------------------------------------------------------ autonomy level
/** L1: pre-planned lawn-mower survey only (no on-board re-planning); no store-and-forward. */
const AUTONOMY_L1: SimConfigOverrides = {
  survey: { adaptive: { enabled: false }, gapFill: { enabled: false }, corridor: { enabled: false } },
  comms: { storeAndForward: { enabled: false } },
};
/** L2: adaptive hotspot scans and gap filling, but no autonomous corridor tasking. */
const AUTONOMY_L2: SimConfigOverrides = {
  survey: { corridor: { enabled: false } },
};

export const FACTOR_LEVELS: readonly FactorLevel[] = [
  { factor: 'clutter', id: 'CLUTTER-LOW', label: 'Clutter LOW', baseline: false, overrides: {}, world: WORLD_CLUTTER_LOW,
    description: `${WORLD_CLUTTER_LOW.obstacles.length} obstacles (control building, tank 3 and both debris piles removed).` },
  { factor: 'clutter', id: 'CLUTTER-MEDIUM', label: 'Clutter MEDIUM (baseline)', baseline: true, overrides: {}, world: WORLD,
    description: `${WORLD.obstacles.length} obstacles — the validated baseline site.` },
  { factor: 'clutter', id: 'CLUTTER-HIGH', label: 'Clutter HIGH', baseline: false, overrides: {}, world: WORLD_CLUTTER_HIGH,
    description: `${WORLD_CLUTTER_HIGH.obstacles.length} obstacles (+ warehouse, 2 tanks, mast, 2 containers, 3 debris piles).` },
  { factor: 'speed', id: 'SPEED-LOW', label: 'Speed LOW (×0.6)', baseline: false, overrides: speedOverrides(0.6), world: WORLD,
    description: 'All speed caps × 0.6 (survey 4.8 m/s, BEE-01 5.4, other bees 3.0, mother 5.4 m/s).' },
  { factor: 'speed', id: 'SPEED-MEDIUM', label: 'Speed MEDIUM (baseline)', baseline: true, overrides: {}, world: WORLD,
    description: 'Baseline speed caps (survey 8 m/s, BEE-01 9, other bees 5, mother 9 m/s).' },
  { factor: 'speed', id: 'SPEED-HIGH', label: 'Speed HIGH (×1.4)', baseline: false, overrides: speedOverrides(1.4), world: WORLD,
    description: 'All speed caps × 1.4 (survey 11.2 m/s, BEE-01 12.6, other bees 7.0, mother 12.6 m/s).' },
  { factor: 'autonomy', id: 'AUTONOMY-L1', label: 'Autonomy L1 (pre-planned)', baseline: false, overrides: AUTONOMY_L1, world: WORLD,
    description: 'Fixed lawn-mower survey; no adaptive hotspot scans, gap filling, corridor tasking or store-and-forward. Obstacle avoidance and the mission lifecycle stay on.' },
  { factor: 'autonomy', id: 'AUTONOMY-L2', label: 'Autonomy L2 (adaptive)', baseline: false, overrides: AUTONOMY_L2, world: WORLD,
    description: 'Adaptive hotspot scans, gap filling and store-and-forward; no autonomous corridor tasking.' },
  { factor: 'autonomy', id: 'AUTONOMY-L3', label: 'Autonomy L3 (full, baseline)', baseline: true, overrides: {}, world: WORLD,
    description: 'All on-board autonomy of the validated baseline.' },
];

export const factorLevel = (id: string): FactorLevel | undefined => FACTOR_LEVELS.find((l) => l.id === id);
