import type { BeeId, SimConfig } from './config';
import type { RadiationState } from './radiation';
import type { CasualtyState } from './casualty';
import type { CommsState } from './comms';
import type { WorldDefinition } from './world';
import type { EvacuationState } from './evacuation';
import type { SurveyState } from './survey';
import type { CorridorState } from './corridor';
import type { RescueState } from './rescue';
import type { MissionState } from './lifecycle';
import type { Vec3 } from './vec3';

export type EngineStatus = 'READY' | 'ACTIVE' | 'COMPLETE';

export type MotherMode =
  | 'STANDBY'
  | 'TRANSIT'
  | 'HOVER'
  | 'HATCH_OPENING'
  | 'DEPLOYING'
  | 'HATCH_CLOSING'
  | 'OVERWATCH'
  // Phase 3B lifecycle
  | 'TAKEOFF'
  | 'RECOVERY'
  | 'RETURN'
  | 'LANDING'
  | 'LANDED';

export type BeeMode =
  | 'DOCKED'
  | 'RELEASING'
  | 'TRANSIT'
  | 'AVOIDING'
  | 'HOLD'
  | 'LOITER'
  // Phase 3B recovery
  | 'STAGED'
  | 'DOCK_APPROACH'
  | 'DOCKING'
  | 'DOCK_FAILED';

/** One route point. `speed` caps horizontal speed on the leg TOWARD this point; `tag` says why it exists. */
export interface RouteWaypoint extends Vec3 {
  speed?: number;
  tag?: 'ROUTE' | 'SURVEY' | 'ADAPTIVE' | 'CORRIDOR' | 'TRANSIT' | 'RTB';
  /** Work package this point belongs to, e.g. "LAWN", "ADAPT-1", "TASK-1", "TASK-1-RTN", "HOLD". */
  block?: string;
}

export type EntityType = 'mother' | 'bee';

interface KinematicState {
  position: Vec3;
  /** Position at the previous step (used only for render interpolation). */
  prevPosition: Vec3;
  velocity: Vec3;
  /** Heading about +y; forward = (sin yaw, 0, cos yaw). Radians. */
  yaw: number;
  prevYaw: number;
  /** Ornstein–Uhlenbeck gust disturbance state, m/s^2. */
  gust: Vec3;
}

export interface MotherState extends KinematicState {
  id: string;
  type: 'mother';
  mode: MotherMode;
  missionStatus: string;
  /** Hatch opening fraction 0 (closed) … 1 (fully open). */
  hatchOpen: number;
  prevHatchOpen: number;
  /** Time spent in the current mode, s. */
  modeTime: number;
  /** Number of bees released so far. */
  releasedCount: number;
}

export interface BeeState extends KinematicState {
  id: BeeId;
  type: 'bee';
  mode: BeeMode;
  missionStatus: string;
  /** Index into the route waypoint list (0-based). */
  waypointIndex: number;
  waypointTotal: number;
  /** Active route (copied from config at reset; BEE-01's is generated and may grow with tasks). */
  route: RouteWaypoint[];
  avoidanceActive: boolean;
  /** Id of the obstacle that most strongly influenced the last command, if any. */
  avoidanceObstacleId: string | null;
  releaseTime: number | null;
  routeCompleteTime: number | null;
  /** Release start altitude (for the drop-out manoeuvre). */
  releaseStartY: number;
  // bookkeeping for stuck detection and log debounce
  bestDistToWaypoint: number;
  lastProgressTime: number;
  avoidanceChangedAt: number;
  avoidanceLogged: boolean;
  /** Phase 3B: flying the return-to-base (rendezvous) leg. */
  rtb: boolean;
}

export type SimEventType =
  | 'MISSION_START'
  | 'MOTHER_TRANSIT'
  | 'MOTHER_ARRIVED'
  | 'HATCH_OPENING'
  | 'HATCH_OPENED'
  | 'BEE_RELEASED'
  | 'BEE_CLEAR_OF_BAY'
  | 'HATCH_CLOSING'
  | 'HATCH_CLOSED'
  | 'WAYPOINT_REACHED'
  | 'WAYPOINT_SKIPPED'
  | 'AVOIDANCE_START'
  | 'AVOIDANCE_END'
  | 'ROUTE_COMPLETE'
  | 'MISSION_COMPLETE'
  | 'MISSION_TIMEOUT'
  // Phase 2 — sensing & communication
  | 'RADIATION_SURVEY_START'
  | 'CASUALTY_IN_RANGE'
  | 'CASUALTY_DETECTED'
  | 'VITALS_ACQUISITION_START'
  | 'ASSESSMENT_COMPLETE'
  | 'ASSESSMENT_TIMEOUT'
  | 'RISK_CHANGED'
  | 'LINK_LOST'
  | 'LINK_RESTORED'
  | 'COMMS_WARNING'
  // Mission Control — evacuation planning (ground-station side)
  | 'EVAC_STAGE'
  | 'EVAC_ROUTE_PLANNED'
  | 'EVAC_PLAN_FAILED'
  | 'OPERATOR_ACTION'
  // Phase 3A — survey & corridor validation
  | 'SURVEY_START'
  | 'SURVEY_COMPLETE'
  | 'SURVEY_GAP_FILL'
  | 'SURVEY_INCOMPLETE'
  | 'RESCUE_ROUTE_PLANNED'
  | 'RESCUE_ROUTE_FAILED'
  | 'HOTSPOT_DETECTED'
  | 'ADAPTIVE_SCAN_START'
  | 'ADAPTIVE_SCAN_COMPLETE'
  | 'CORRIDOR_CANDIDATES'
  | 'CORRIDOR_TASK_SENT'
  | 'CORRIDOR_TASK_RECEIVED'
  | 'CORRIDOR_SURVEY_START'
  | 'CORRIDOR_SURVEY_COMPLETE'
  | 'CORRIDOR_SURVEY_INFEASIBLE'
  | 'TASK_HOLD'
  | 'TASK_COMPLETE'
  | 'ROUTE_SELECTED'
  // Phase 3B lifecycle
  | 'MISSION_PHASE'
  | 'TAKEOFF_START'
  | 'TAKEOFF_COMPLETE'
  | 'OBJECTIVES_COMPLETE'
  | 'RECOVERY_START'
  | 'BEE_RTB'
  | 'BEE_STAGED'
  | 'DOCK_APPROACH'
  | 'DOCK_ASCENT'
  | 'DOCK_ABORT'
  | 'BEE_DOCKED'
  | 'DOCK_FAILED'
  | 'RECOVERY_COMPLETE'
  | 'RECOVERY_INCOMPLETE'
  | 'RETURN_START'
  | 'LANDING_START'
  | 'TOUCHDOWN'
  | 'LANDING_OFF_PAD';

export interface SimEvent {
  step: number;
  time: number;
  entityId: string;
  type: SimEventType;
  details: string;
}

export interface PositionSample {
  step: number;
  time: number;
  entityId: string;
  entityType: EntityType;
  mode: string;
  missionStatus: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  waypointIndex: number;
  waypointTotal: number;
  hatchOpen: number;
  avoidanceActive: boolean;
}

export interface SimState {
  status: EngineStatus;
  step: number;
  /** Simulation time, s. Always equals step * dt. */
  time: number;
  mother: MotherState;
  bees: BeeState[];
  events: SimEvent[];
  samples: PositionSample[];
  /** Per-entity trail points (subset of samples), for the 3D view. */
  trails: Record<string, Vec3[]>;
  /** Minimum horizontal clearance from blocking obstacles observed per bee, m. */
  minClearance: Record<string, number>;
  /**
   * Phase 3B+: smallest 3-D distance between two airborne bees (bay operations excluded) and
   * between the mother and an airborne bee, over the whole run, m.
   */
  minSeparation: { beeBee_m: number; beeBeePair: string | null; motherBee_m: number };
  /** Phase 2: BEE-01 radiation samples (truth and measurement kept in separate fields). */
  radiation: RadiationState;
  /** Phase 2: the single casualty — truth timeline, detection, vitals measurements, risk. */
  casualty: CasualtyState;
  /** Phase 2: message log, ground-station view, link status and warnings. */
  comms: CommsState;
  /** Mission Control: evacuation planning cases (ground-station side, planning only). */
  evacuation: EvacuationState;
  /** Phase 3A: BEE-01 survey execution state (drone side). */
  survey: SurveyState;
  /** Phase 3A: evacuation-corridor candidates, tasking and validation (ground-station side). */
  corridor: CorridorState;
  /** Phase 3B+: recommended rescue-team route (GS data, planning only). */
  rescue: RescueState;
  /** Phase 3B: mission lifecycle (phases, recovery, landing). */
  mission: MissionState;
}

/** What a subsystem (radiation / casualty / comms) receives each step. */
export interface SubsystemContext {
  state: SimState;
  config: SimConfig;
  world: WorldDefinition;
  log: (entityId: string, type: SimEventType, details: string) => void;
}
