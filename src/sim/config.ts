import type { Vec3 } from './vec3';
import type { UnknownPolicy } from './conservative';
import type { RiskStabilizationConfig } from './riskStability';

export const SIM_VERSION = '0.8.0-rc1';

export type BeeId = 'BEE-01' | 'BEE-02' | 'BEE-03';
export const BEE_IDS: readonly BeeId[] = ['BEE-01', 'BEE-02', 'BEE-03'] as const;
export const MOTHER_ID = 'MOTHER-01';

export interface BeeRouteDefinition {
  id: BeeId;
  /** Mission role (Phase 2: simulated sensing / relay payload attached to this bee). */
  plannedRole: string;
  /** Ordered waypoints (metres, world frame). The last one is the loiter point. */
  waypoints: Vec3[];
  /** Trail / route colour used by the 3D view and charts. */
  color: string;
}

export interface DroneDynamicsConfig {
  /** Max horizontal speed, m/s. */
  maxSpeedXZ: number;
  /** Max vertical speed, m/s. */
  maxSpeedY: number;
  /** Acceleration limit applied to the velocity command, m/s^2. */
  maxAccel: number;
  /** Collision radius used for clearance checks, metres. */
  bodyRadius: number;
}

export interface SimConfig {
  /** PRNG seed — the only source of randomness in a run. */
  seed: number;
  /** Fixed simulation step, seconds. */
  dt: number;
  /** Recording interval for position samples / trails, seconds. */
  sampleInterval: number;
  /** Safety cap: the run ends with MISSION_TIMEOUT after this sim time, seconds. */
  maxMissionTime: number;

  /**
   * Simplified gust disturbance applied as a random acceleration
   * (Ornstein–Uhlenbeck process). This is NOT a validated wind model; it only
   * exists so that seeded randomness measurably affects trajectories.
   */
  disturbance: { sigma: number; tau: number; verticalFactor: number };

  mother: DroneDynamicsConfig & {
    spawn: Vec3;
    hoverPoint: Vec3;
    /** Proportional gain for the approach speed (speed = min(max, k * distance)). */
    approachGain: number;
    arriveTolerance: number;
    settleTime: number;
    hatchOpenDuration: number;
    hatchCloseDuration: number;
    /** Interval between consecutive bee releases, seconds. */
    releaseInterval: number;
  };

  bee: DroneDynamicsConfig & {
    /** Vertical drop below the hatch before route following starts, metres. */
    releaseDropDistance: number;
    releaseDescentSpeed: number;
    waypointTolerance: number;
    finalWaypointTolerance: number;
    approachGain: number;
    /** Extra horizontal clearance kept from obstacle surfaces, metres. */
    obstacleSafetyMargin: number;
    /** Obstacles lower than (altitude - this margin) are flown over, metres. */
    obstacleVerticalMargin: number;
    /** Minimum separation kept between bees, metres. */
    beeSeparation: number;
    /** No progress for this long toward the active waypoint => WAYPOINT_SKIPPED, s. */
    stuckTimeout: number;
    /** Debounce for AVOIDANCE_START / AVOIDANCE_END log entries, s. */
    avoidanceLogDebounce: number;
    /**
     * Phase 3B+: per-bee speed profile overriding maxSpeedXZ / maxAccel for that bee
     * (bees without an entry use the shared values above). BEE-01 is the fast survey bee.
     */
    profiles: Partial<Record<BeeId, BeeSpeedProfile>>;
  };

  /** Bay slot offsets in the mother body frame (x right, y up, z forward), metres. */
  baySlots: Record<BeeId, Vec3>;
  routes: Record<BeeId, BeeRouteDefinition>;

  /** BEE-01 radiation source + notional detector (see docs/SIMULATION_MODEL.md §10). */
  radiation: RadiationConfig;
  /** BEE-02 casualty physiology, detection and assessment (§11). */
  casualty: CasualtyConfig;
  /** BEE-03 relay / link model (§12). */
  comms: CommsConfig;
  /** Mission Control: evacuation PLANNING (§14). No rescue movement is simulated. */
  evacuation: EvacuationConfig;
  /** Phase 3B+: rescue-team approach route (GS → casualty). */
  rescue: RescueConfig;
  /** Mission Control alert thresholds (§15) — illustrative operating values. */
  alerts: AlertConfig;
  /** Phase 3A: BEE-01 area survey, adaptive scanning and corridor survey (§20). */
  survey: SurveyConfig;
  /** Phase 3B: mission lifecycle — launch from the GS pad, recovery, return, landing (§26). */
  mission: MissionConfig;
}

export interface MissionConfig {
  /** false = Phase 3A behaviour (mother spawns airborne, mission ends with bees loitering). */
  lifecycle: boolean;
  /** Landing / launch pad centre at the ground station (x, z), m. */
  pad: { x: number; z: number };
  /** Mother body-centre height when resting on its landing gear, m. */
  padRestHeight_m: number;
  /** Takeoff climb rate and the altitude at which the climb ends (= cruise altitude), m/s, m. */
  climbRate_mps: number;
  cruiseAltitude_m: number;
  /** Horizontal position-hold gain over the pad during vertical takeoff / landing, 1/s. */
  padHoldGain: number;
  /** Landing descent rate above / below 4 m, m/s. */
  descentRate_mps: number;
  finalDescentRate_mps: number;
  /** Touchdown must be within this horizontal distance of the pad centre, m. */
  landingTolerance_m: number;
  /** Horizontal clearance for the mother's planned transit / return legs, m (≥ body radius + margin). */
  transitClearance_m: number;
  recovery: {
    /** Rendezvous ("staging") points: radius around the mother and drop below it, m. */
    stagingRadius_m: number;
    stagingDrop_m: number;
    /** Every responsive bee must reach its staging point within this time, s. */
    gatherTimeout_s: number;
    /** Approach point is this far below the bay slot (= release drop distance by default), m. */
    approachDrop_m: number;
    approachMaxSpeed_mps: number;
    /** Alignment before ascent: horizontal error, vertical error, speed, held for alignHold_s. */
    alignTolerance_m: number;
    alignVerticalTolerance_m: number;
    alignSpeed_mps: number;
    alignHold_s: number;
    ascentSpeed_mps: number;
    /** During the ascent the horizontal error must stay below this, else the attempt is aborted, m. */
    abortTolerance_m: number;
    /** Captured (docked) when fully inserted (at slot height) with horizontal error below this, m. */
    dockTolerance_m: number;
    attemptTimeout_s: number;
    maxAttempts: number;
  };
  /** Fault injection for tests / demonstrations (default: none). */
  faults: {
    /** Bees that ignore the return-to-base command (simulated malfunction). */
    unresponsiveBees: BeeId[];
    /** Every GS → drone downlink packet is lost (simulated jamming of the GS transmitter). */
    downlinkJammed: boolean;
  };
}

/** Phase 3B+: speed profile of one bee (see bee.profiles). */
export interface BeeSpeedProfile {
  /** Horizontal speed cap (cruise / transit), m/s. */
  maxSpeedXZ: number;
  /** Acceleration limit, m/s². */
  maxAccel: number;
  /**
   * Speed cap near obstacles that block at the bee's altitude: from `obstacleSlowdownRange_m`
   * (distance to the footprint) the cap falls linearly to `obstacleSlowdownMinSpeed_mps` at the
   * avoidance influence distance (bodyRadius + obstacleSafetyMargin). 0 range = off.
   */
  obstacleSlowdownRange_m: number;
  obstacleSlowdownMinSpeed_mps: number;
  /**
   * Traffic cap: within `trafficSlowdownRange_m` (3-D) of another airborne drone the speed cap
   * falls linearly to `trafficMinSpeed_mps` at bee.beeSeparation. 0 range = off.
   */
  trafficSlowdownRange_m: number;
  trafficMinSpeed_mps: number;
  /**
   * Measurement-quality cap: after an on-board reading ≥ `elevatedRate_uSv_h` the bee flies at most
   * `elevatedSpeed_mps` for `elevatedHold_s` — more counts and denser sampling where the dose rate
   * matters for decisions (near sources, hotspots, routes). 0 rate = off.
   */
  elevatedRate_uSv_h: number;
  elevatedSpeed_mps: number;
  elevatedHold_s: number;
}

export interface SurveyConfig {
  /** false = Phase 2 behaviour (BEE-01 flies `routes['BEE-01']`). */
  enabled: boolean;
  /** Designated survey area (x–z rectangle, m). Lanes run along x, stepping in z. */
  area: { x0: number; z0: number; x1: number; z1: number };
  altitude_m: number;
  /** Lane spacing, m. Equal to the heat-map cell size → every cell row gets a lane. */
  laneSpacing_m: number;
  speed_mps: number;
  /** Horizontal clearance used when planning legs around obstacles, m (≥ avoidance influence). */
  legClearance_m: number;
  /**
   * Lane direction: 'x' (lanes along x, stepping in z), 'z', or 'auto' = along the longer side of
   * the area (fewer lanes → fewer turns for the same coverage).
   */
  laneAxis: 'x' | 'z' | 'auto';
  /**
   * Coverage objective: fraction of the FLYABLE (reachable) area cells that must hold at least one
   * on-board measurement before the area survey counts as complete. 0 = no objective (Phase 3A).
   */
  coverageObjective: number;
  /** After the lanes: re-fly short segments through reachable cells that are still unmeasured. */
  gapFill: { enabled: boolean; speed_mps: number; maxCells: number };
  adaptive: {
    enabled: boolean;
    /** On-board measurement at or above this marks a hotspot, µSv/h. */
    triggerRate_uSv_h: number;
    /** Consecutive readings ≥ trigger needed before a hotspot is declared (suppresses single noisy windows). */
    confirmReadings: number;
    /** Readings closer than this to a known hotspot update it instead of adding one, m. */
    mergeRadius_m: number;
    maxHotspots: number;
    /** Local scan box half-size, lane spacing and altitude. */
    halfSize_m: number;
    spacing_m: number;
    altitude_m: number;
    speed_mps: number;
    /**
     * v0.7.0 Fix C (hotspotDetect.ts). 'SIGNIFICANCE_PROMINENCE' (default): significance vs background
     * + local-maximum/prominence peak confirmation on the on-board map. 'LEGACY_THRESHOLD': the v0.6.0
     * rule (triggerRate_uSv_h, confirmReadings, mergeRadius_m) — kept for baseline reproduction.
     */
    detection: 'SIGNIFICANCE_PROMINENCE' | 'LEGACY_THRESHOLD';
    /** Significance of the 3×3 summed counts above the background expectation, σ (default 5). */
    zTrigger: number;
    /**
     * …and smoothed rate ≥ this × background (default 3). v0.7.1 tried 2 as a post-hoc experiment; it was
     * NOT adopted (false secondary "tail" hotspots for moderate sources, docs/VALIDATION_V0.7.1.md §3) and
     * the 0.8.0 release candidate restored 3. Detection limit at 3 ×: ≈ 40–50 µSv/h at 1 m (13.7 m height).
     */
    minFactorOverBackground: number;
    /** Peak confirmation radius, m (default 28 ≈ 2 × survey height above the source). */
    confirmRadius_m: number;
    /** Measured fraction of reachable area cells within confirmRadius_m needed to confirm (default 0.8). */
    confirmCompleteness: number;
    /** Two cells are SEPARATE sources only if the dip between them exceeds dipSigma·σ AND dipFraction·value. */
    dipSigma: number;
    dipFraction: number;
    /**
     * 0.8.0-rc1 defect fix: in the shoulder test a cell of EQUAL smoothed value with a lower cell index also
     * counts as "higher", so two equal-valued maxima of one source give one hotspot, not two (v0.7.0 and
     * v0.7.1: false — the defect). Genuinely separate sources are unaffected (they are separated by a dip).
     */
    equalValueTieBreak: boolean;
    /** 'NEXT_LANE_END' (default): scan at the end of the lane on which the hotspot is confirmed, then resume; 'AFTER_AREA': v0.6.0 (after all lanes). */
    scanTiming: 'NEXT_LANE_END' | 'AFTER_AREA';
  };
  corridor: {
    enabled: boolean;
    altitude_m: number;
    speed_mps: number;
    /** Perpendicular offset of the via-points used to create alternative corridors, m. */
    viaOffset_m: number;
    /** Alternatives longer than shortest × this are discarded. */
    maxDetourFactor: number;
    /** Alternatives whose mean distance to an accepted corridor is below this are duplicates, m. */
    minSeparation_m: number;
    /** Task uplink retry interval and limit. */
    retryInterval_s: number;
    maxAttempts: number;
    /** Time that must remain before maxMissionTime after the estimated task, s. */
    reserve_s: number;
  };
  /** Where BEE-01 waits for tasking after its own survey work (good relay geometry, clear of obstacles). */
  holdPoint: Vec3;
  /** BEE-01 waits this long for tasking after its own work is done, then loiters, s. */
  holdTimeout_s: number;
  /** Route validation thresholds (§20). */
  validation: {
    /** Measured fraction of route length required for SURVEYED. */
    surveyedFraction: number;
    /** Longest continuous unmeasured stretch allowed for SURVEYED, m. */
    maxGap_m: number;
    /** Below this measured fraction a route is UNKNOWN. */
    unknownBelowFraction: number;
    /** Re-evaluate candidates at most this often, s. */
    evalInterval_s: number;
  };
}

export interface EvacuationConfig {
  /** Destination of the evacuation route (casualty collection point near the ground station). */
  collectionPoint: { id: string; label: string; position: Vec3 };
  /** Planner grid cell, m. */
  cell_m: number;
  /** Planning area = bounding box of start & goal expanded by this margin, m (clamped to the ops area). */
  margin_m: number;
  /** Minimum distance kept from every obstacle footprint by the rescue team, m. */
  clearance_m: number;
  /** Assumed stretcher-team walking speed, m/s (used for time and dose estimates). */
  walkingSpeed_mps: number;
  /** κ: cost penalty per multiple of background above background (0 = shortest route). */
  radiationWeight: number;
  /** For COST only: unknown cells are assumed to read background × this (used only when unknownPolicy = 'BACKGROUND_MULTIPLE', the v0.6.0 rule). */
  unknownMultiplier: number;
  /**
   * v0.7.0 Fix A: how UNMEASURED ground is costed by the evacuation and rescue planners and how the
   * rescue fallback ranks unverified routes (conservative.ts). 'CONSERVATIVE_NEIGHBOURHOOD' (default):
   * highest measured cell mean within conservativeRadius_m, else the highest on the map — a heuristic
   * conservative estimate, NOT a statistical upper bound. 'BACKGROUND_MULTIPLE': the v0.6.0 rule
   * (background × unknownMultiplier), kept for baseline reproduction.
   */
  unknownPolicy: UnknownPolicy;
  /** Neighbourhood radius of the conservative rule, m (12 m = 3 heat-map cells; sensitivity in docs/VALIDATION_V0.7.0.md). */
  conservativeRadius_m: number;
  /** Re-plan at most this often while new data arrives, s. */
  replanInterval_s: number;
}

/** Phase 3B+: recommended rescue-team route from the team's start point to the casualty (planning only). */
export interface RescueConfig {
  enabled: boolean;
  /** Where the ground rescue team starts (default: at the ground station base). */
  start: { id: string; label: string; x: number; z: number };
  /** Radiation weights κ of the candidate routes (0 = shortest). The lowest-dose qualifying candidate is recommended. */
  candidateWeights: number[];
  /**
   * A recommended route is VERIFIED only if no measured rate on it reaches this, µSv/h (else: warning).
   * ILLUSTRATIVE PLANNING THRESHOLD — NOT a validated emergency-rescue safety limit. Default 2.5 µSv/h,
   * kept unchanged from v0.6.0 for comparability; numerically equal to the former UK IRR85
   * supervised-area benchmark (1/10 of 50 mSv/y over 2000 working hours), an occupational
   * area-designation trigger for planned work (docs/SIMULATION_MODEL.md §41).
   */
  maxRate_uSv_h: number;
  /** Re-plan at most this often while new data arrives, s. */
  replanInterval_s: number;
  /**
   * Optional reference line on the cumulative-dose comparison chart (display only), e.g. an
   * organisation's per-mission dose constraint. null = no line: no scientifically justified threshold
   * at this scale is configured by default (cf. ICRP 103 public limit 1 mSv per YEAR — not a per-route limit).
   */
  doseReference: { value_mSv: number; label: string } | null;
}

export interface AlertConfig {
  /** Measured dose rate at or above this raises a RADIATION alert, µSv/h. */
  doseRate_uSv_h: number;
  /** Patient data older than this is shown as UNAVAILABLE, s. */
  patientStale_s: number;
  /** Swarm member shown OFFLINE when nothing was received for this long, s (same as comms.linkTimeout_s by default). */
  droneOffline_s: number;
}

export interface RadiationConfig {
  /** Point-source position, m. */
  sourcePosition: Vec3;
  /** Ambient dose rate at 1 m from the source, µSv/h (excluding background). */
  sourceStrength_uSv_h_at_1m: number;
  /** Uniform natural background, µSv/h. */
  background_uSv_h: number;
  /**
   * v0.7.0: optional ADDITIONAL point sources (same physics), used only by validation scenarios
   * (e.g. two nearby sources for the hotspot-separation tests). Default: none. Ground-truth exports,
   * map-quality metrics and the 3-D marker refer to the primary source only.
   */
  additionalSources?: { position: Vec3; strength_uSv_h_at_1m: number }[];
  /** Distance floor for the inverse-square law, m (avoids the singularity). */
  minDistance_m: number;
  /** Linear air attenuation coefficient, 1/m (0 = pure inverse square). */
  airAttenuation_per_m: number;
  /** Detector sensitivity, counts per second per µSv/h. */
  sensitivity_cps_per_uSv_h: number;
  /** Counting (integration) time per sample, s. Also the sampling interval. */
  integrationTime_s: number;
  /**
   * Phase 3B+: spatial sampling — a counting window also closes once the drone has moved this far
   * horizontally (so a fast drone still records ≥ 2 samples per heat-map cell). 0 = time only.
   */
  maxSampleSpacing_m: number;
  /** Multiplicative calibration factor applied to measurements (1 = perfectly calibrated). */
  calibrationFactor: number;
  /** Heat-map grid (x0, z0 lower corner; cell size; counts), metres. */
  heatmap: { x0: number; z0: number; cell: number; nx: number; nz: number };
}

export interface CasualtyConfig {
  /** True physiology: value(t) = base + slope·t + amp·sin(2πt/period) + OU noise. */
  hr: { base: number; slope_per_s: number; amp: number; period_s: number; ouSigma: number; ouTau_s: number };
  rr: { base: number; slope_per_s: number; amp: number; period_s: number; ouSigma: number; ouTau_s: number };
  /** Detection: scans at `scanInterval_s`; in range if 3-D distance ≤ range. */
  detection: { range_m: number; scanInterval_s: number; pMax: number };
  /** Vital-sign sensing: valid when distance ≤ range and bee speed ≤ maxSpeed. */
  vitals: {
    range_m: number;
    maxBeeSpeed_mps: number;
    sampleInterval_s: number;
    samplesForAssessment: number;
    hrSigmaBase: number;
    hrSigmaPerM: number;
    rrSigmaBase: number;
    rrSigmaPerM: number;
    motionSigmaPerMps: number;
  };
  /**
   * v0.7.0 Fix B: stabilized REPORTING of the illustrative risk class (riskStability.ts). The raw
   * v0.6.0 class is kept and exported. enabled = false reproduces v0.6.0 (reported = raw).
   */
  riskStabilization: RiskStabilizationConfig;
  /**
   * Body-temperature sensing (§40) — a SEPARATE simulated sensor on BEE-02: non-contact radiometric
   * long-wave infrared (LWIR, 8–14 µm) thermography of exposed facial skin. It measures SKIN (surface)
   * temperature, not core body temperature; no core value is inferred. Independent of HR/RR (own
   * truth model and own RNG streams). Not used by the illustrative risk rule.
   */
  temperature: {
    enabled: boolean;
    /** True skin temperature: base + slope·t + OU(σ, τ), °C. */
    skinBase_c: number;
    skinSlope_c_per_s: number;
    skinOuSigma_c: number;
    skinOuTau_s: number;
    /** True core temperature (reference only — never measured, never shown on the dashboard), °C. */
    coreBase_c: number;
    coreSlope_c_per_s: number;
    /** Valid only when 3-D distance ≤ range and bee speed ≤ maxSpeed (spot size / motion blur). */
    range_m: number;
    maxBeeSpeed_mps: number;
    sampleInterval_s: number;
    /** σ = sigmaBase + sigmaPerM·d + motionSigmaPerMps·speed, °C; readings with σ > maxSigma are rejected. */
    sigmaBase_c: number;
    sigmaPerM_c: number;
    motionSigmaPerMps_c: number;
    maxSigma_c: number;
    /** Assumed skin emissivity used by the (notional) radiometric conversion — documentation only. */
    emissivity: number;
  };
  /** Give up (ASSESSMENT_TIMEOUT) if not assessed this long after BEE-02 finished its route, s. */
  assessmentTimeout_s: number;
  /** Interval for the truth timeline export, s. */
  truthInterval_s: number;
}

export interface CommsConfig {
  groundStationId: string;
  relayId: BeeId;
  /** Ground-station antenna height above ground, m (mast top). */
  gsAntennaHeight_m: number;
  /** Maximum usable link distance (any hop), m. */
  linkRange_m: number;
  /** Per-hop loss probability = base + (edge − base)·(d / range)². */
  packetLossBase: number;
  packetLossEdge: number;
  /** Per-hop latency = base + exponential jitter (mean). Relay adds processing. */
  latencyBase_ms: number;
  latencyJitterMean_ms: number;
  relayProcessing_ms: number;
  /** Heartbeat telemetry interval per airborne bee, s. */
  heartbeatInterval_s: number;
  /** BEE-02 casualty status packet interval after detection, s. */
  statusInterval_s: number;
  /** No delivery from an airborne bee for this long → LINK_LOST warning, s. */
  linkTimeout_s: number;
  /** Rolling window (messages) and threshold for the delivery-ratio warning. */
  pdrWindow: number;
  pdrWarnBelow: number;
  /** Mean-latency warning threshold, ms. */
  latencyWarnAbove_ms: number;
  /**
   * Phase 3B+: BEE-01 keeps radiation samples it could not send because NO route existed
   * (out of range of GS and relay) and re-sends them once a route exists again, at most
   * `perStep` per step. Packets lost on an existing link are not known to the sender and are not
   * re-sent (no ACKs are modelled).
   */
  storeAndForward: { enabled: boolean; maxBacklog: number; perStep: number };
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 42,
  dt: 0.05,
  sampleInterval: 0.5,
  maxMissionTime: 1200,

  disturbance: { sigma: 0.35, tau: 2.0, verticalFactor: 0.3 },

  mother: {
    maxSpeedXZ: 9,
    maxSpeedY: 2.5,
    maxAccel: 2.0,
    bodyRadius: 3.4,
    spawn: { x: -150, y: 42, z: 105 },
    hoverPoint: { x: -18, y: 26, z: 32 },
    approachGain: 0.35,
    arriveTolerance: 1.0,
    settleTime: 1.5,
    hatchOpenDuration: 2.5,
    hatchCloseDuration: 2.5,
    releaseInterval: 4.0,
  },

  bee: {
    maxSpeedXZ: 5,
    maxSpeedY: 2,
    maxAccel: 3,
    bodyRadius: 0.5,
    releaseDropDistance: 3.5,
    releaseDescentSpeed: 1.5,
    waypointTolerance: 1.2,
    finalWaypointTolerance: 0.6,
    approachGain: 0.8,
    obstacleSafetyMargin: 3.0,
    obstacleVerticalMargin: 2.0,
    beeSeparation: 3.0,
    stuckTimeout: 25,
    avoidanceLogDebounce: 1.0,
    profiles: {
      // fast survey bee; slows near obstacles, before sharp turns (corner speed law) and on
      // hotspot / corridor legs (their own slower leg speeds)
      'BEE-01': { maxSpeedXZ: 9, maxAccel: 4, obstacleSlowdownRange_m: 8, obstacleSlowdownMinSpeed_mps: 3, trafficSlowdownRange_m: 10, trafficMinSpeed_mps: 2.5, elevatedRate_uSv_h: 0.5, elevatedSpeed_mps: 5, elevatedHold_s: 3 },
    },
  },

  baySlots: {
    'BEE-01': { x: 0, y: -0.35, z: 1.05 },
    'BEE-02': { x: 0, y: -0.35, z: 0 },
    'BEE-03': { x: 0, y: -0.35, z: -1.05 },
  },

  radiation: {
    sourcePosition: { x: 18, y: 1.3, z: 21.3 },
    sourceStrength_uSv_h_at_1m: 500,
    background_uSv_h: 0.1,
    minDistance_m: 1.0,
    airAttenuation_per_m: 0,
    sensitivity_cps_per_uSv_h: 50,
    integrationTime_s: 0.5,
    // ≤ half a heat-map cell between samples at any speed (0.25 s windows at 8 m/s)
    maxSampleSpacing_m: 2,
    calibrationFactor: 1.0,
    // Mission Control: grid covers the whole facility + evacuation corridor (unsampled cells stay unknown)
    heatmap: { x0: -84, z0: -68, cell: 4, nx: 37, nz: 33 },
  },

  casualty: {
    hr: { base: 112, slope_per_s: 0.04, amp: 3, period_s: 40, ouSigma: 1.5, ouTau_s: 20 },
    rr: { base: 24, slope_per_s: 0.01, amp: 1, period_s: 30, ouSigma: 0.8, ouTau_s: 20 },
    detection: { range_m: 15, scanInterval_s: 0.5, pMax: 0.9 },
    vitals: {
      range_m: 8,
      maxBeeSpeed_mps: 1.5,
      sampleInterval_s: 1.0,
      samplesForAssessment: 10,
      hrSigmaBase: 2,
      hrSigmaPerM: 0.6,
      rrSigmaBase: 1,
      rrSigmaPerM: 0.25,
      motionSigmaPerMps: 3,
    },
    // 0.8.0-rc1: escalate IMMEDIATELY (1 window; v0.7.x: 3), de-escalate after 10 windows beyond 1 SEM (unchanged).
    // Trade-off (docs/VALIDATION_V0.7.1.md §4): never later than the raw class and fewer under-reported HIGH
    // windows, at the cost of more over-triage and lower agreement for borderline patients.
    riskStabilization: { enabled: true, escalateWindows: 1, deescalateWindows: 10, marginSEM: 1 },
    temperature: {
      enabled: true,
      skinBase_c: 33.8,
      skinSlope_c_per_s: -0.0006,
      skinOuSigma_c: 0.15,
      skinOuTau_s: 120,
      coreBase_c: 37.0,
      coreSlope_c_per_s: 0,
      range_m: 8,
      maxBeeSpeed_mps: 1.5,
      sampleInterval_s: 2.0,
      sigmaBase_c: 0.3,
      sigmaPerM_c: 0.05,
      motionSigmaPerMps_c: 0.4,
      maxSigma_c: 1.0,
      emissivity: 0.98,
    },
    assessmentTimeout_s: 60,
    truthInterval_s: 1.0,
  },

  comms: {
    groundStationId: 'GS-1',
    relayId: 'BEE-03',
    gsAntennaHeight_m: 8,
    linkRange_m: 80,
    packetLossBase: 0.02,
    packetLossEdge: 0.25,
    latencyBase_ms: 30,
    latencyJitterMean_ms: 15,
    relayProcessing_ms: 8,
    heartbeatInterval_s: 2,
    statusInterval_s: 5,
    linkTimeout_s: 5,
    pdrWindow: 20,
    pdrWarnBelow: 0.8,
    latencyWarnAbove_ms: 150,
    storeAndForward: { enabled: true, maxBacklog: 4000, perStep: 4 },
  },

  evacuation: {
    collectionPoint: { id: 'CCP-1', label: 'Casualty collection point', position: { x: -62, y: 0, z: 48 } },
    cell_m: 1,
    margin_m: 20,
    clearance_m: 1.5,
    walkingSpeed_mps: 1.0,
    radiationWeight: 0.5,
    unknownMultiplier: 3,
    unknownPolicy: 'CONSERVATIVE_NEIGHBOURHOOD',
    conservativeRadius_m: 12,
    replanInterval_s: 10,
  },

  rescue: {
    enabled: true,
    start: { id: 'RT-START', label: 'Rescue team staging (GS-1)', x: -68, z: 56 },
    // 0 = shortest walkable; larger = trade distance for lower dose (cost = t·(1 + κ·max(0, Ḣ/B − 1)))
    candidateWeights: [0, 0.5, 4, 25],
    maxRate_uSv_h: 2.5,
    replanInterval_s: 10,
    doseReference: null,
  },

  survey: {
    enabled: true,
    // Phase 3B+: the WHOLE disaster compound (fence line, aligned to the 4 m heat-map cells):
    // x −44 … 64, z −52 … 44. Phase 3A surveyed only the tank-farm zone x −4 … 52, z 4 … 44.
    area: { x0: -44, z0: -52, x1: 64, z1: 44 },
    // 15 m: clears the warehouse roof (12 m + 2 m margin) so it is surveyed too; the tanks
    // (14 m) and the stack (38 m) still block and are flown around.
    altitude_m: 15,
    laneSpacing_m: 4,
    // BEE-01 is the fast survey bee (BEE-02/03 stay at bee.maxSpeedXZ = 5 m/s)
    speed_mps: 8,
    legClearance_m: 4.5,
    laneAxis: 'auto',
    coverageObjective: 0.95,
    gapFill: { enabled: true, speed_mps: 5, maxCells: 60 },
    adaptive: {
      enabled: true,
      triggerRate_uSv_h: 1.5,
      confirmReadings: 2,
      mergeRadius_m: 20,
      maxHotspots: 2,
      halfSize_m: 8,
      spacing_m: 2,
      altitude_m: 12,
      speed_mps: 3,
      detection: 'SIGNIFICANCE_PROMINENCE',
      zTrigger: 5,
      minFactorOverBackground: 3, // 0.8.0-rc1 (v0.7.1 experiment: 2, not adopted)
      equalValueTieBreak: true, // 0.8.0-rc1 defect fix (v0.7.0/v0.7.1: false)
      confirmRadius_m: 28,
      confirmCompleteness: 0.8,
      dipSigma: 3,
      dipFraction: 0.1,
      scanTiming: 'NEXT_LANE_END',
    },
    corridor: {
      enabled: true,
      altitude_m: 8,
      speed_mps: 3,
      viaOffset_m: 18,
      maxDetourFactor: 1.6,
      minSeparation_m: 6,
      retryInterval_s: 2,
      maxAttempts: 15,
      reserve_s: 60,
    },
    holdPoint: { x: -8, y: 12, z: 30 },
    holdTimeout_s: 120,
    validation: {
      surveyedFraction: 0.9,
      maxGap_m: 8,
      unknownBelowFraction: 0.1,
      evalInterval_s: 2,
    },
  },

  mission: {
    lifecycle: true,
    pad: { x: -58, z: 74 },
    padRestHeight_m: 1.1,
    climbRate_mps: 2.0,
    cruiseAltitude_m: 26,
    padHoldGain: 0.8,
    descentRate_mps: 1.6,
    finalDescentRate_mps: 0.5,
    landingTolerance_m: 0.6,
    transitClearance_m: 8,
    recovery: {
      stagingRadius_m: 8,
      stagingDrop_m: 6,
      gatherTimeout_s: 120,
      approachDrop_m: 3.5,
      approachMaxSpeed_mps: 1.5,
      alignTolerance_m: 0.3,
      alignVerticalTolerance_m: 0.3,
      alignSpeed_mps: 0.35,
      alignHold_s: 1.0,
      ascentSpeed_mps: 1.0,
      abortTolerance_m: 0.35,
      dockTolerance_m: 0.15,
      attemptTimeout_s: 40,
      maxAttempts: 2,
    },
    faults: { unresponsiveBees: [], downlinkJammed: false },
  },

  alerts: {
    doseRate_uSv_h: 2.5,
    patientStale_s: 10,
    droneOffline_s: 5,
  },

  routes: {
    'BEE-01': {
      id: 'BEE-01',
      plannedRole: 'Radiation area survey, hotspot scans & evacuation-corridor survey — simulated detector',
      color: '#22d3ee',
      waypoints: [
        { x: 2, y: 10, z: 40 },
        { x: 25, y: 10, z: 40 },
        { x: 25, y: 10, z: 31 },
        { x: 2, y: 10, z: 31 },
        { x: 2, y: 10, z: 22 },
        { x: 25, y: 10, z: 22 },
        { x: 25, y: 10, z: 13 },
        { x: 47, y: 10, z: 13.5 },
      ],
    },
    'BEE-02': {
      id: 'BEE-02',
      plannedRole: 'Casualty detection & HR/RR assessment — simulated',
      color: '#f472b6',
      waypoints: [
        { x: -44, y: 8, z: -6 },
        { x: -8, y: 8, z: -30 },
        { x: -10, y: 8, z: 4 },
        { x: -16, y: 4, z: 10 },
      ],
    },
    'BEE-03': {
      id: 'BEE-03',
      plannedRole: 'Communication relay to ground station — simulated links',
      color: '#a3e635',
      // Phase 2: BEE-03 goes straight to its relay station so the relay is in
      // place while BEE-01 surveys (Phase 1 used a longer patrol past the stack).
      // The station sits within link range of the ground station and the survey area.
      waypoints: [
        { x: -24, y: 19, z: 26 },
        { x: -28, y: 18, z: 20 },
      ],
    },
  },
};

/** Deep-ish merge for the handful of nested keys tests and the UI override. */
/** Nested partial used for overrides (tests, UI scenario panel). */
export type SimConfigOverrides = Partial<
  Omit<SimConfig, 'disturbance' | 'mother' | 'bee' | 'radiation' | 'casualty' | 'comms' | 'evacuation' | 'alerts' | 'survey' | 'mission' | 'rescue'>
> & {
  mission?: Partial<Omit<MissionConfig, 'pad' | 'recovery' | 'faults'>> & {
    pad?: Partial<MissionConfig['pad']>;
    recovery?: Partial<MissionConfig['recovery']>;
    faults?: Partial<MissionConfig['faults']>;
  };
  rescue?: Partial<Omit<RescueConfig, 'start'>> & { start?: Partial<RescueConfig['start']> };
  survey?: Partial<Omit<SurveyConfig, 'area' | 'adaptive' | 'corridor' | 'validation' | 'gapFill'>> & {
    gapFill?: Partial<SurveyConfig['gapFill']>;
    area?: Partial<SurveyConfig['area']>;
    adaptive?: Partial<SurveyConfig['adaptive']>;
    corridor?: Partial<SurveyConfig['corridor']>;
    validation?: Partial<SurveyConfig['validation']>;
  };
  evacuation?: Partial<EvacuationConfig>;
  alerts?: Partial<AlertConfig>;
  disturbance?: Partial<SimConfig['disturbance']>;
  mother?: Partial<SimConfig['mother']>;
  bee?: Partial<SimConfig['bee']>;
  radiation?: Partial<Omit<RadiationConfig, 'heatmap'>> & { heatmap?: Partial<RadiationConfig['heatmap']> };
  casualty?: Partial<Omit<CasualtyConfig, 'hr' | 'rr' | 'detection' | 'vitals' | 'temperature' | 'riskStabilization'>> & {
    riskStabilization?: Partial<CasualtyConfig['riskStabilization']>;
    temperature?: Partial<CasualtyConfig['temperature']>;
    hr?: Partial<CasualtyConfig['hr']>;
    rr?: Partial<CasualtyConfig['rr']>;
    detection?: Partial<CasualtyConfig['detection']>;
    vitals?: Partial<CasualtyConfig['vitals']>;
  };
  comms?: Partial<Omit<CommsConfig, 'storeAndForward'>> & { storeAndForward?: Partial<CommsConfig['storeAndForward']> };
};

/**
 * Overrides that restore the Phase 3A survey behaviour (tank-farm area at 12 m, 5 m/s, time-only
 * sampling, no per-bee profile, no store-and-forward, no coverage objective). Combined with
 * `mission.lifecycle = false` this reproduces the Phase 3A sample output byte-for-byte (tested).
 */
export const PHASE3A_SURVEY: SimConfigOverrides = {
  survey: {
    area: { x0: -4, z0: 4, x1: 52, z1: 44 },
    altitude_m: 12,
    speed_mps: 5,
    laneAxis: 'x',
    coverageObjective: 0,
    gapFill: { enabled: false },
  },
  radiation: { maxSampleSpacing_m: 0 },
  bee: { profiles: {} },
  comms: { storeAndForward: { enabled: false } },
  rescue: { enabled: false },
};

/**
 * v0.7.0: overrides that switch off the three Phase-1 scientific corrections and restore the v0.6.0
 * rules — unknown ground at 3 × background (Fix A), raw risk class reported (Fix B), fixed-threshold
 * hotspots scanned after the lanes (Fix C). With these, every v0.6.0 column of the 30-run summary is
 * reproduced exactly (tests/legacyReproduction.test.ts); only sim_version and the appended columns differ.
 */
/** Reproduces the validated v0.7.0-sci1 engine: floor 3 × B, no equal-value tie break, 3-window escalation. */
export const V070_SCI1: SimConfigOverrides = {
  survey: { adaptive: { minFactorOverBackground: 3, equalValueTieBreak: false } },
  casualty: { riskStabilization: { escalateWindows: 3 } },
};
/** Reproduces the v0.7.1-sci2 experiment (floor 2 × B, not adopted). */
export const V071_SCI2: SimConfigOverrides = {
  survey: { adaptive: { minFactorOverBackground: 2, equalValueTieBreak: false } },
  casualty: { riskStabilization: { escalateWindows: 3 } },
};

export const LEGACY_V060: SimConfigOverrides = {
  evacuation: { unknownPolicy: 'BACKGROUND_MULTIPLE' },
  casualty: { riskStabilization: { enabled: false } },
  survey: { adaptive: { detection: 'LEGACY_THRESHOLD', scanTiming: 'AFTER_AREA' } },
};

export function makeConfig(overrides: SimConfigOverrides = {}): SimConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    disturbance: { ...DEFAULT_CONFIG.disturbance, ...(overrides.disturbance ?? {}) },
    mother: { ...DEFAULT_CONFIG.mother, ...(overrides.mother ?? {}) },
    bee: { ...DEFAULT_CONFIG.bee, ...(overrides.bee ?? {}) },
    radiation: {
      ...DEFAULT_CONFIG.radiation,
      ...(overrides.radiation ?? {}),
      heatmap: { ...DEFAULT_CONFIG.radiation.heatmap, ...(overrides.radiation?.heatmap ?? {}) },
    },
    casualty: {
      ...DEFAULT_CONFIG.casualty,
      ...(overrides.casualty ?? {}),
      hr: { ...DEFAULT_CONFIG.casualty.hr, ...(overrides.casualty?.hr ?? {}) },
      rr: { ...DEFAULT_CONFIG.casualty.rr, ...(overrides.casualty?.rr ?? {}) },
      detection: { ...DEFAULT_CONFIG.casualty.detection, ...(overrides.casualty?.detection ?? {}) },
      vitals: { ...DEFAULT_CONFIG.casualty.vitals, ...(overrides.casualty?.vitals ?? {}) },
      temperature: { ...DEFAULT_CONFIG.casualty.temperature, ...(overrides.casualty?.temperature ?? {}) },
      riskStabilization: { ...DEFAULT_CONFIG.casualty.riskStabilization, ...(overrides.casualty?.riskStabilization ?? {}) },
    },
    comms: {
      ...DEFAULT_CONFIG.comms,
      ...(overrides.comms ?? {}),
      storeAndForward: { ...DEFAULT_CONFIG.comms.storeAndForward, ...(overrides.comms?.storeAndForward ?? {}) },
    },
    evacuation: { ...DEFAULT_CONFIG.evacuation, ...(overrides.evacuation ?? {}) },
    rescue: { ...DEFAULT_CONFIG.rescue, ...(overrides.rescue ?? {}), start: { ...DEFAULT_CONFIG.rescue.start, ...(overrides.rescue?.start ?? {}) } },
    alerts: { ...DEFAULT_CONFIG.alerts, ...(overrides.alerts ?? {}) },
    mission: {
      ...DEFAULT_CONFIG.mission,
      ...(overrides.mission ?? {}),
      pad: { ...DEFAULT_CONFIG.mission.pad, ...(overrides.mission?.pad ?? {}) },
      recovery: { ...DEFAULT_CONFIG.mission.recovery, ...(overrides.mission?.recovery ?? {}) },
      faults: { ...DEFAULT_CONFIG.mission.faults, ...(overrides.mission?.faults ?? {}) },
    },
    survey: {
      ...DEFAULT_CONFIG.survey,
      ...(overrides.survey ?? {}),
      area: { ...DEFAULT_CONFIG.survey.area, ...(overrides.survey?.area ?? {}) },
      adaptive: { ...DEFAULT_CONFIG.survey.adaptive, ...(overrides.survey?.adaptive ?? {}) },
      corridor: { ...DEFAULT_CONFIG.survey.corridor, ...(overrides.survey?.corridor ?? {}) },
      validation: { ...DEFAULT_CONFIG.survey.validation, ...(overrides.survey?.validation ?? {}) },
      gapFill: { ...DEFAULT_CONFIG.survey.gapFill, ...(overrides.survey?.gapFill ?? {}) },
    },
  };
}
