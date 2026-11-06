import type { BeeId, SimConfig } from './config';
import type { Vec3 } from './vec3';

/**
 * Phase 3B mission lifecycle — state model (docs/SIMULATION_MODEL.md §26).
 * The transitions are executed by the engine (engine.ts) from simulation state:
 *
 *   READY → TAKEOFF → TRANSIT → DEPLOYMENT → SURVEY_ASSESSMENT → RECOVERY → RETURN → LANDING → COMPLETE
 *                                                                      ↘ (bee not recovered) … → INCOMPLETE
 *
 * COMPLETE is set only after a verified touchdown on the pad with all three
 * bees docked. Any failed recovery, off-pad touchdown or timeout ends the run
 * as INCOMPLETE / TIMEOUT instead — never as COMPLETE.
 */
export type MissionPhase =
  | 'READY'
  | 'TAKEOFF'
  | 'TRANSIT'
  | 'DEPLOYMENT'
  | 'SURVEY_ASSESSMENT'
  | 'RECOVERY'
  | 'RETURN'
  | 'LANDING'
  | 'COMPLETE'
  | 'INCOMPLETE'
  | 'TIMEOUT';

export const MISSION_PHASES: readonly MissionPhase[] = ['READY', 'TAKEOFF', 'TRANSIT', 'DEPLOYMENT', 'SURVEY_ASSESSMENT', 'RECOVERY', 'RETURN', 'LANDING', 'COMPLETE'];

export const PHASE_LABEL: Record<MissionPhase, string> = {
  READY: 'Ready',
  TAKEOFF: 'Takeoff',
  TRANSIT: 'Transit',
  DEPLOYMENT: 'Deployment',
  SURVEY_ASSESSMENT: 'Survey & assessment',
  RECOVERY: 'Recovery',
  RETURN: 'Return to base',
  LANDING: 'Landing',
  COMPLETE: 'Complete',
  INCOMPLETE: 'Ended — incomplete',
  TIMEOUT: 'Stopped — time cap',
};

export type RecoveryStage = 'IDLE' | 'GATHERING' | 'HATCH_OPENING' | 'DOCKING' | 'HATCH_CLOSING' | 'DONE';

export interface DockAttempt {
  bee: BeeId;
  attempt: number;
  start: number;
  end: number | null;
  result: 'DOCKED' | 'ABORTED' | 'TIMEOUT' | null;
  /** Horizontal error at the start of the ascent / max during the ascent / at capture, m. */
  alignError_m: number | null;
  maxAscentError_m: number | null;
  captureError_m: number | null;
}

export interface MissionState {
  lifecycle: boolean;
  phase: MissionPhase;
  phaseTimes: Partial<Record<MissionPhase, number>>;
  /** Mother's planned transit / return waypoints (x, y, z). */
  outboundRoute: Vec3[];
  returnRoute: Vec3[];
  routeIndex: number;
  takeoff: { start: number | null; end: number | null; maxDrift_m: number };
  objectivesCompleteAt: number | null;
  recovery: {
    stage: RecoveryStage;
    startedAt: number | null;
    order: BeeId[];
    current: BeeId | null;
    staging: Partial<Record<BeeId, Vec3>>;
    staged: BeeId[];
    docked: BeeId[];
    failed: { bee: BeeId; reason: string; time: number }[];
    attempts: DockAttempt[];
    alignSince: number | null;
    completedAt: number | null;
  };
  landing: { start: number | null; touchdown: number | null; horizontalError_m: number | null; verticalSpeed_mps: number | null; onPad: boolean | null };
  /** Smallest horizontal clearance of the mother body to any obstacle that blocks at its altitude, m (lifecycle only). */
  motherMinClearance_m: number;
}

export function initialMissionState(config: SimConfig): MissionState {
  return {
    lifecycle: config.mission.lifecycle,
    phase: 'READY',
    phaseTimes: { READY: 0 },
    outboundRoute: [],
    returnRoute: [],
    routeIndex: 0,
    takeoff: { start: null, end: null, maxDrift_m: 0 },
    objectivesCompleteAt: null,
    recovery: {
      stage: 'IDLE',
      startedAt: null,
      order: [],
      current: null,
      staging: {},
      staged: [],
      docked: [],
      failed: [],
      attempts: [],
      alignSince: null,
      completedAt: null,
    },
    landing: { start: null, touchdown: null, horizontalError_m: null, verticalSpeed_mps: null, onPad: null },
    motherMinClearance_m: Number.POSITIVE_INFINITY,
  };
}

/** Pad-rest pose of the mother (centre height above the pad). */
export function padPosition(config: SimConfig): Vec3 {
  return { x: config.mission.pad.x, y: config.mission.padRestHeight_m, z: config.mission.pad.z };
}
