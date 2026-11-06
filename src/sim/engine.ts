import { BEE_IDS, DEFAULT_CONFIG, MOTHER_ID, SIM_VERSION, makeConfig } from './config';
import type { BeeId, BeeSpeedProfile, SimConfig, SimConfigOverrides } from './config';
import { RNG_STREAM, SeededRng, deriveSeed } from './rng';
import { RadiationSensor, initialRadiationState } from './radiation';
import { CasualtyAssessor, initialCasualtyState } from './casualty';
import { CommsNetwork, initialCommsState } from './comms';
import { EvacuationManager, initialEvacuationState } from './evacuation';
import type { OperatorAction } from './evacuation';
import { SurveyController, blockingObstacles, flightLeg, initialSurveyState } from './survey';
import { initialMissionState, padPosition } from './lifecycle';
import type { MissionPhase } from './lifecycle';
import { obstacleDistance } from './routePlanner';
import { CorridorManager, initialCorridorState } from './corridor';
import { RescueManager, initialRescueState } from './rescue';
import type {
  BeeMode,
  BeeState,
  MotherMode,
  MotherState,
  PositionSample,
  SimEvent,
  SimEventType,
  SimState,
  SubsystemContext,
} from './types';
import { add, approach, clampLen, clone, copyInto, dist, lenXZ, scale, sub, v3 } from './vec3';
import type { Vec3 } from './vec3';
import { WORLD, obstacleProximity } from './world';
import type { WorldDefinition } from './world';

/**
 * BEE-GUARD simulation engine (Phase 1 flight + Phase 2 sensing/comms).
 *
 * - Deterministic fixed-step clock: time = step * dt; one call to step()
 *   advances exactly dt seconds regardless of rendering frame rate.
 * - All randomness comes from seeded PRNG streams derived from ONE run seed
 *   (flight, radiation counting, casualty truth, detection, vitals noise, comms).
 * - This class owns the simulation state. The 3D view, telemetry panel and
 *   CSV export only READ it; nothing in the UI writes positions or numbers.
 */
/** Airborne and flying on its own (not in / entering / leaving the bay, not parked). */
function isFreeFlying(b: BeeState): boolean {
  return b.mode !== 'DOCKED' && b.mode !== 'RELEASING' && b.mode !== 'DOCK_APPROACH' && b.mode !== 'DOCKING';
}

export class SimEngine {
  readonly config: SimConfig;
  readonly world: WorldDefinition;
  private rng!: SeededRng;
  private radiationSensor!: RadiationSensor;
  private casualtyAssessor!: CasualtyAssessor;
  private comms!: CommsNetwork;
  private evacuation!: EvacuationManager;
  private survey!: SurveyController;
  private corridor!: CorridorManager;
  private rescue!: RescueManager;
  private ctx!: SubsystemContext;
  private _state!: SimState;
  private stepsPerSample!: number;

  constructor(overrides: SimConfigOverrides = {}, world: WorldDefinition = WORLD) {
    this.config = makeConfig(overrides);
    this.world = world;
    this.reset(this.config.seed);
  }

  get state(): SimState {
    return this._state;
  }

  get version(): string {
    return SIM_VERSION;
  }

  /**
   * Run identifier: scenario + seed, plus a short configuration hash when any
   * parameter differs from DEFAULT_CONFIG (so differently-configured runs with
   * the same seed never share an id).
   */
  get runId(): string {
    const base = `${this.world.scenarioId}-seed${this.config.seed}`;
    const { seed: _s, ...rest } = this.config;
    const { seed: _d, ...def } = DEFAULT_CONFIG;
    void _s;
    void _d;
    const cfg = JSON.stringify(rest);
    return cfg === JSON.stringify(def) ? base : `${base}-cfg${fnv1a(cfg)}`;
  }

  /** Restore the initial state. Optionally change the seed. */
  reset(seed: number = this.config.seed): void {
    (this.config as { seed: number }).seed = seed >>> 0;
    this.rng = new SeededRng(this.config.seed);
    this.radiationSensor = new RadiationSensor(deriveSeed(this.config.seed, RNG_STREAM.radiation));
    this.casualtyAssessor = new CasualtyAssessor(
      deriveSeed(this.config.seed, RNG_STREAM.vitalsTruth),
      deriveSeed(this.config.seed, RNG_STREAM.detection),
      deriveSeed(this.config.seed, RNG_STREAM.vitalsNoise),
      deriveSeed(this.config.seed, RNG_STREAM.casualtyLocation),
      deriveSeed(this.config.seed, RNG_STREAM.temperatureTruth),
      deriveSeed(this.config.seed, RNG_STREAM.temperatureNoise),
    );
    this.comms = new CommsNetwork(deriveSeed(this.config.seed, RNG_STREAM.comms));
    this.evacuation = new EvacuationManager();
    this.survey = new SurveyController();
    this.corridor = new CorridorManager();
    this.rescue = new RescueManager();
    this.elevatedAt = {};
    const surveyState = initialSurveyState(this.config);
    this.stepsPerSample = Math.max(1, Math.round(this.config.sampleInterval / this.config.dt));

    const m = this.config.mother;
    const lifecycle = this.config.mission.lifecycle;
    // Phase 3B: the mother starts on the ground-station pad; Phase 3A: airborne at the configured spawn
    const spawn = lifecycle ? padPosition(this.config) : m.spawn;
    const toHover = sub(m.hoverPoint, spawn);
    const yaw0 = Math.atan2(toHover.x, toHover.z);
    const mother: MotherState = {
      id: MOTHER_ID,
      type: 'mother',
      mode: 'STANDBY',
      missionStatus: lifecycle ? 'On the pad at the ground station — press Start' : 'Standing by — press Start',
      position: clone(spawn),
      prevPosition: clone(spawn),
      velocity: v3(),
      yaw: yaw0,
      prevYaw: yaw0,
      gust: v3(),
      hatchOpen: 0,
      prevHatchOpen: 0,
      modeTime: 0,
      releasedCount: 0,
    };

    const bees: BeeState[] = BEE_IDS.map((id) => {
      const p = this.slotWorldPosition(mother, id);
      // BEE-01 with the survey enabled flies a generated route; everything else flies its configured route
      const route =
        id === 'BEE-01' && this.config.survey.enabled
          ? SurveyController.initialRoute(this.config, this.world, surveyState, {
              x: m.hoverPoint.x,
              y: m.hoverPoint.y - this.config.bee.releaseDropDistance,
              z: m.hoverPoint.z,
            })
          : this.config.routes[id].waypoints.map((w) => ({ ...w, tag: 'ROUTE' as const }));
      return {
        id,
        type: 'bee',
        mode: 'DOCKED',
        missionStatus: 'In bay',
        position: p,
        prevPosition: clone(p),
        velocity: v3(),
        yaw: yaw0,
        prevYaw: yaw0,
        gust: v3(),
        waypointIndex: 0,
        waypointTotal: route.length,
        route,
        avoidanceActive: false,
        avoidanceObstacleId: null,
        releaseTime: null,
        routeCompleteTime: null,
        releaseStartY: p.y,
        bestDistToWaypoint: Number.POSITIVE_INFINITY,
        lastProgressTime: 0,
        avoidanceChangedAt: 0,
        avoidanceLogged: false,
        rtb: false,
      };
    });

    const trails: Record<string, Vec3[]> = { [MOTHER_ID]: [] };
    const minClearance: Record<string, number> = {};
    for (const id of BEE_IDS) {
      trails[id] = [];
      minClearance[id] = Number.POSITIVE_INFINITY;
    }

    this._state = {
      status: 'READY',
      step: 0,
      time: 0,
      mother,
      bees,
      events: [],
      samples: [],
      trails,
      minClearance,
      minSeparation: { beeBee_m: Number.POSITIVE_INFINITY, beeBeePair: null, motherBee_m: Number.POSITIVE_INFINITY },
      radiation: initialRadiationState(),
      casualty: initialCasualtyState(this.config.casualty, this.world.casualty.id),
      comms: initialCommsState(),
      evacuation: initialEvacuationState(),
      survey: surveyState,
      corridor: initialCorridorState(this.config),
      rescue: initialRescueState(this.config),
      mission: initialMissionState(this.config),
    };
    this.ctx = {
      state: this._state,
      config: this.config,
      world: this.world,
      log: (id, type, details) => this.log(id, type, details),
    };
  }

  /** Begin the mission (READY → ACTIVE). */
  start(): void {
    const s = this._state;
    if (s.status !== 'READY') return;
    s.status = 'ACTIVE';
    this.log(MOTHER_ID, 'MISSION_START', `run=${this.runId} seed=${this.config.seed} dt=${this.config.dt}s`);
    if (this.config.mission.lifecycle) {
      const mc = this.config.mission;
      this.setMotherMode('TAKEOFF', 'Vertical takeoff from the pad');
      s.mission.takeoff.start = s.time;
      this.setPhase('TAKEOFF', `vertical climb to ${mc.cruiseAltitude_m} m at ${mc.climbRate_mps} m/s`);
      this.log(MOTHER_ID, 'TAKEOFF_START', `pad=(${mc.pad.x}, ${mc.pad.z}) climb ${mc.climbRate_mps} m/s to ${mc.cruiseAltitude_m} m`);
    } else {
      this.setMotherMode('TRANSIT', 'Transit to deployment point');
      this.log(MOTHER_ID, 'MOTHER_TRANSIT', `target=(${fmt(this.config.mother.hoverPoint)})`);
      this.setPhase('TRANSIT', '');
    }
    this.casualtyAssessor.updateTruth(this.ctx);
    this.recordSamples();
  }

  /** Advance exactly one fixed step. No-op unless ACTIVE. */
  step(): void {
    const s = this._state;
    if (s.status !== 'ACTIVE') return;
    const dt = this.config.dt;

    s.step += 1;
    s.time = s.step * dt;

    this.updateMother(dt);
    for (const bee of s.bees) this.updateBee(bee, dt);
    this.updateClearance();

    // Phase 2: sensing and communication (each with its own RNG stream)
    this.casualtyAssessor.updateTruth(this.ctx);
    this.radiationSensor.step(this.ctx, this.comms);
    // Phase 3A: BEE-01 on-board survey logic (hotspots, received tasks, work blocks)
    this.survey.step(this.ctx, this.comms);
    this.casualtyAssessor.step(this.ctx, this.comms);
    this.comms.step(this.ctx);
    // Mission Control: ground-station evacuation planning (uses delivered data only)
    this.evacuation.step(this.ctx);
    // Phase 3A: GS corridor candidates, BEE-01 tasking, route validation & selection
    this.corridor.step(this.ctx, this.comms);
    this.rescue.step(this.ctx);

    if (s.step % this.stepsPerSample === 0) this.recordSamples();

    // Mission Control: also wait (max 30 s) until the GS has received the assessment,
    // so evacuation planning can run on delivered data before the run ends.
    const gsHasAssessment = s.comms.gs.patients.some((p) => p.assessment !== null);
    const casualtyDone =
      s.casualty.status === 'ASSESSMENT_TIMEOUT' ||
      (s.casualty.status === 'ASSESSED' && (gsHasAssessment || s.time - (s.casualty.assessmentTime as number) >= 30));
    // Phase 3A: also wait until the corridor decision is final (or cannot be made)
    const corridorDone = !s.corridor.enabled || s.corridor.decision.final || (s.corridor.candidates.length === 0 && !gsHasAssessment && casualtyDone);
    const objectivesDone =
      s.bees.every((b) => b.mode === 'LOITER') && s.mother.mode === 'OVERWATCH' && casualtyDone && corridorDone && s.comms.inFlight.length === 0;
    if (this.config.mission.lifecycle) {
      // Phase 3B: objectives complete → recovery → return → landing; COMPLETE only after touchdown
      if (objectivesDone && s.mission.phase === 'SURVEY_ASSESSMENT') this.beginRecovery();
      if (s.mother.mode === 'LANDED') {
        s.status = 'COMPLETE';
        const ok = s.mission.recovery.docked.length === s.bees.length && s.mission.landing.onPad === true;
        this.setPhase(ok ? 'COMPLETE' : 'INCOMPLETE', ok ? 'all bees recovered, landed on the pad' : 'mission ended with failures (see log)');
        this.log(
          MOTHER_ID,
          'MISSION_COMPLETE',
          `${ok ? 'COMPLETE' : 'INCOMPLETE'}: landed ${s.mission.landing.onPad ? 'on' : 'OFF'} the pad (error ${s.mission.landing.horizontalError_m?.toFixed(2)} m); ` +
            `docked ${s.mission.recovery.docked.length}/${s.bees.length}${s.mission.recovery.failed.length ? `; NOT recovered: ${s.mission.recovery.failed.map((f) => `${f.bee} (${f.reason})`).join(', ')}` : ''}; ` +
            `casualty ${s.casualty.status}; ${s.radiation.samples.length} radiation samples; ${s.comms.messages.length} messages`,
        );
        if (s.step % this.stepsPerSample !== 0) this.recordSamples();
      } else if (s.time >= this.config.maxMissionTime) {
        s.status = 'COMPLETE';
        this.setPhase('TIMEOUT', `safety cap ${this.config.maxMissionTime}s`);
        this.log(MOTHER_ID, 'MISSION_TIMEOUT', `Stopped at safety cap ${this.config.maxMissionTime}s in phase ${s.mission.phaseTimes ? s.mission.phase : '?'}`);
        if (s.step % this.stepsPerSample !== 0) this.recordSamples();
      }
      return;
    }
    if (objectivesDone) {
      s.status = 'COMPLETE';
      this.setPhase('COMPLETE', '');
      this.log(
        MOTHER_ID,
        'MISSION_COMPLETE',
        `All routes complete; casualty ${s.casualty.status}; ${s.radiation.samples.length} radiation samples; ${s.comms.messages.length} messages`,
      );
      if (s.step % this.stepsPerSample !== 0) this.recordSamples();
    } else if (s.time >= this.config.maxMissionTime) {
      s.status = 'COMPLETE';
      this.setPhase('TIMEOUT', '');
      this.log(MOTHER_ID, 'MISSION_TIMEOUT', `Stopped at safety cap ${this.config.maxMissionTime}s`);
      if (s.step % this.stepsPerSample !== 0) this.recordSamples();
    }
  }

  /**
   * Operator input from Mission Control (evacuation workflow). Applied
   * immediately at the current step and recorded in state.evacuation.operatorActions
   * and the event log, so a run can be replayed exactly.
   */
  operatorCommand(patientId: string, action: OperatorAction['action']): boolean {
    return this.evacuation.command(this.ctx, patientId, action);
  }

  /** Run steps until `predicate` is true, the mission completes, or maxSteps. */
  runUntil(predicate: (s: SimState) => boolean, maxSteps = 1_000_000): number {
    let n = 0;
    while (n < maxSteps && this._state.status === 'ACTIVE' && !predicate(this._state)) {
      this.step();
      n++;
    }
    return n;
  }

  /** Convenience: start (if needed) and run to completion. */
  runToCompletion(maxSteps = 1_000_000): SimState {
    if (this._state.status === 'READY') this.start();
    this.runUntil(() => false, maxSteps);
    return this._state;
  }

  // ------------------------------------------------------------------ mother

  private setMotherMode(mode: MotherMode, status: string): void {
    const m = this._state.mother;
    m.mode = mode;
    m.missionStatus = status;
    m.modeTime = 0;
  }

  private updateMother(dt: number): void {
    const s = this._state;
    const m = s.mother;
    const cfg = this.config.mother;
    copyInto(m.prevPosition, m.position);
    m.prevYaw = m.yaw;
    m.prevHatchOpen = m.hatchOpen;
    m.modeTime += dt;

    // Position-hold / transit controller (same law in every mode).
    // Phase 3B: with the lifecycle the target depends on the mode (pad climb, planned legs, hover, return, landing).
    const lc = this.config.mission.lifecycle;
    const target = lc ? this.motherTarget() : cfg.hoverPoint;
    const toTarget = sub(target, m.position);
    const d = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
    let vCmd = v3();
    if (lc && (m.mode === 'TAKEOFF' || m.mode === 'LANDING')) {
      vCmd = this.padVerticalCommand(m);
    } else if (d > 1e-6) {
      const speed = Math.min(cfg.maxSpeedXZ, cfg.approachGain * d);
      vCmd = scale(toTarget, speed / d);
      vCmd.y = clampAbs(vCmd.y, cfg.maxSpeedY);
    }
    if (!(lc && m.mode === 'LANDED')) {
      this.integrate(m, vCmd, cfg.maxAccel, cfg.maxSpeedXZ, cfg.maxSpeedY, dt, m.mode !== 'STANDBY');
    } else {
      m.velocity = v3();
    }
    if (lc) this.motherBookkeeping(m);

    // Heading follows horizontal velocity during transit, then holds.
    if (m.mode === 'TRANSIT' && lenXZ(m.velocity) > 1.0) {
      m.yaw = turnToward(m.yaw, Math.atan2(m.velocity.x, m.velocity.z), 0.8 * dt);
    }

    switch (m.mode) {
      case 'TAKEOFF': {
        const mc = this.config.mission;
        m.missionStatus = `Vertical takeoff — ${m.position.y.toFixed(1)} / ${mc.cruiseAltitude_m} m`;
        if (m.position.y >= mc.cruiseAltitude_m - 0.3) {
          s.mission.takeoff.end = s.time;
          this.log(m.id, 'TAKEOFF_COMPLETE', `alt=${m.position.y.toFixed(2)}m in ${(s.time - (s.mission.takeoff.start ?? 0)).toFixed(1)}s, max horizontal drift ${s.mission.takeoff.maxDrift_m.toFixed(2)}m`);
          s.mission.outboundRoute = this.planMotherLegs(m.position, cfg.hoverPoint);
          s.mission.routeIndex = 0;
          this.setMotherMode('TRANSIT', 'Transit to deployment point');
          this.setPhase('TRANSIT', `${s.mission.outboundRoute.length} leg(s) to the deployment point`);
          this.log(MOTHER_ID, 'MOTHER_TRANSIT', `target=(${fmt(cfg.hoverPoint)}) legs=${s.mission.outboundRoute.length}`);
        }
        break;
      }
      case 'TRANSIT': {
        if (lc) this.advanceMotherLeg(m, s.mission.outboundRoute);
        const dFinal = lc ? dist(cfg.hoverPoint, m.position) : d;
        m.missionStatus = `Transit to deployment point — ${dFinal.toFixed(1)} m`;
        if (dFinal < cfg.arriveTolerance && Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z) < 0.8) {
          this.setMotherMode('HOVER', 'Hovering — stabilising before hatch');
          this.log(m.id, 'MOTHER_ARRIVED', `pos=(${fmt(m.position)}) err=${dFinal.toFixed(2)}m`);
          if (lc) this.setPhase('DEPLOYMENT', 'hover, open hatch, release BEE-01 → BEE-03');
        }
        break;
      }
      case 'RECOVERY': {
        this.updateRecovery(dt);
        break;
      }
      case 'RETURN': {
        this.advanceMotherLeg(m, s.mission.returnRoute);
        const above = s.mission.returnRoute[s.mission.returnRoute.length - 1];
        const dr = dist(above, m.position);
        m.missionStatus = `Returning to base — ${dr.toFixed(1)} m`;
        if (dr < cfg.arriveTolerance && Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z) < 0.8) {
          this.setMotherMode('LANDING', 'Landing on the pad');
          s.mission.landing.start = s.time;
          this.setPhase('LANDING', 'vertical descent onto the pad');
          this.log(m.id, 'LANDING_START', `over pad err=${Math.hypot(m.position.x - this.config.mission.pad.x, m.position.z - this.config.mission.pad.z).toFixed(2)}m alt=${m.position.y.toFixed(1)}m`);
        }
        break;
      }
      case 'LANDING': {
        const mc = this.config.mission;
        m.missionStatus = `Landing — ${(m.position.y - mc.padRestHeight_m).toFixed(1)} m above the pad`;
        if (m.position.y <= mc.padRestHeight_m + 0.03) {
          const vy = Math.abs(m.velocity.y);
          const err = Math.hypot(m.position.x - mc.pad.x, m.position.z - mc.pad.z);
          m.position.y = mc.padRestHeight_m;
          m.velocity = v3();
          m.gust = v3();
          const onPad = err <= mc.landingTolerance_m;
          s.mission.landing.touchdown = s.time;
          s.mission.landing.horizontalError_m = err;
          s.mission.landing.verticalSpeed_mps = vy;
          s.mission.landing.onPad = onPad;
          this.setMotherMode('LANDED', onPad ? 'Landed on the pad' : 'Landed OFF the pad');
          this.log(m.id, 'TOUCHDOWN', `pad error ${err.toFixed(2)}m (tolerance ${mc.landingTolerance_m}m), vertical speed ${vy.toFixed(2)}m/s`);
          if (!onPad) this.log(m.id, 'LANDING_OFF_PAD', `touchdown ${err.toFixed(2)}m from the pad centre > ${mc.landingTolerance_m}m`);
        }
        break;
      }
      case 'HOVER': {
        if (m.modeTime >= cfg.settleTime) {
          this.setMotherMode('HATCH_OPENING', 'Opening bottom hatch');
          this.log(m.id, 'HATCH_OPENING', `duration=${cfg.hatchOpenDuration}s`);
        }
        break;
      }
      case 'HATCH_OPENING': {
        m.hatchOpen = Math.min(1, m.hatchOpen + dt / cfg.hatchOpenDuration);
        if (m.hatchOpen >= 1) {
          m.hatchOpen = 1;
          this.setMotherMode('DEPLOYING', 'Deploying bees 0/3');
          this.log(m.id, 'HATCH_OPENED', 'Bay open');
          this.releaseNextBee();
        }
        break;
      }
      case 'DEPLOYING': {
        if (m.releasedCount < s.bees.length && m.modeTime >= m.releasedCount * cfg.releaseInterval) {
          this.releaseNextBee();
        }
        m.missionStatus = `Deploying bees ${m.releasedCount}/${s.bees.length}`;
        const allClear = s.bees.every((b) => b.mode !== 'DOCKED' && b.mode !== 'RELEASING');
        if (m.releasedCount === s.bees.length && allClear) {
          this.setMotherMode('HATCH_CLOSING', 'Closing hatch');
          this.log(m.id, 'HATCH_CLOSING', `duration=${cfg.hatchCloseDuration}s`);
        }
        break;
      }
      case 'HATCH_CLOSING': {
        m.hatchOpen = Math.max(0, m.hatchOpen - dt / cfg.hatchCloseDuration);
        if (m.hatchOpen <= 0) {
          m.hatchOpen = 0;
          this.setMotherMode('OVERWATCH', 'Overwatch — station keeping');
          this.log(m.id, 'HATCH_CLOSED', 'Bay closed');
          if (lc) this.setPhase('SURVEY_ASSESSMENT', 'BEE-01 survey, BEE-02 assessment, BEE-03 relay');
        }
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------- Phase 3B lifecycle

  private setPhase(phase: MissionPhase, why: string): void {
    const ms = this._state.mission;
    if (ms.phase === phase) return;
    ms.phase = phase;
    ms.phaseTimes[phase] = this._state.time;
    // phase events only with the lifecycle (keeps Phase 3A event logs unchanged)
    if (this.config.mission.lifecycle) this.log(MOTHER_ID, 'MISSION_PHASE', `${phase}${why ? ` — ${why}` : ''}`);
  }

  /** Where the mother is steering to in the current mode (lifecycle only). */
  private motherTarget(): Vec3 {
    const s = this._state;
    const m = s.mother;
    const cfg = this.config.mother;
    const mc = this.config.mission;
    switch (m.mode) {
      case 'STANDBY':
      case 'LANDED':
        return clone(m.position);
      case 'TAKEOFF':
        return { x: mc.pad.x, y: mc.cruiseAltitude_m, z: mc.pad.z };
      case 'TRANSIT':
        return s.mission.outboundRoute[Math.min(s.mission.routeIndex, s.mission.outboundRoute.length - 1)] ?? cfg.hoverPoint;
      case 'RETURN':
        return s.mission.returnRoute[Math.min(s.mission.routeIndex, s.mission.returnRoute.length - 1)] ?? cfg.hoverPoint;
      case 'LANDING':
        return { x: mc.pad.x, y: mc.padRestHeight_m, z: mc.pad.z };
      default:
        return cfg.hoverPoint;
    }
  }

  /** Vertical takeoff / landing: hold over the pad horizontally, climb or descend at the configured rate. */
  private padVerticalCommand(m: MotherState): Vec3 {
    const mc = this.config.mission;
    const ex = mc.pad.x - m.position.x;
    const ez = mc.pad.z - m.position.z;
    const eh = Math.hypot(ex, ez);
    const k = mc.padHoldGain;
    const cap = 1.5;
    const hs = Math.min(cap, k * eh);
    const v: Vec3 = { x: eh > 1e-9 ? (ex / eh) * hs : 0, y: 0, z: eh > 1e-9 ? (ez / eh) * hs : 0 };
    if (m.mode === 'TAKEOFF') {
      v.y = Math.min(mc.climbRate_mps, 0.8 * (mc.cruiseAltitude_m - m.position.y) + 0.25);
    } else {
      const h = m.position.y - mc.padRestHeight_m;
      // descend only while centred over the pad; slow final descent below 4 m
      v.y = eh > 1.5 ? 0 : -(h > 4 ? mc.descentRate_mps : mc.finalDescentRate_mps);
    }
    return v;
  }

  /** Mother leg following: pass an intermediate waypoint within 3 m. */
  private advanceMotherLeg(m: MotherState, route: Vec3[]): void {
    const ms = this._state.mission;
    if (ms.routeIndex < route.length - 1 && dist(route[ms.routeIndex], m.position) < 3) ms.routeIndex += 1;
  }

  /** Obstacle-aware legs for the mother at its current altitude (planned, then followed). */
  private planMotherLegs(from: Vec3, to: Vec3): Vec3[] {
    const mc = this.config.mission;
    const alt = Math.min(from.y, to.y);
    const obs = blockingObstacles(this.world, this.config, alt);
    const leg = flightLeg({ x: from.x, z: from.z }, { x: to.x, z: to.z }, obs, mc.transitClearance_m, this.world.opsAreaHalfSize);
    if (!leg.ok) this.log(MOTHER_ID, 'COMMS_WARNING', `no obstacle-free leg found — flying direct (check the site plan)`);
    const pts = leg.points.length ? leg.points : [{ x: to.x, z: to.z }];
    return pts.map((p, i) => (i === pts.length - 1 ? clone(to) : { x: p.x, y: from.y, z: p.z }));
  }

  private motherBookkeeping(m: MotherState): void {
    const s = this._state;
    const mc = this.config.mission;
    // never below the pad / ground
    if (m.position.y < mc.padRestHeight_m) {
      m.position.y = mc.padRestHeight_m;
      if (m.velocity.y < 0) m.velocity.y = 0;
    }
    if (m.mode === 'TAKEOFF') {
      s.mission.takeoff.maxDrift_m = Math.max(s.mission.takeoff.maxDrift_m, Math.hypot(m.position.x - mc.pad.x, m.position.z - mc.pad.z));
    }
    if (m.mode !== 'STANDBY' && m.mode !== 'LANDED' && m.position.y > mc.padRestHeight_m + 0.5) {
      const obs = blockingObstacles(this.world, this.config, m.position.y);
      const c = obstacleDistance(obs, m.position.x, m.position.z) - this.config.mother.bodyRadius;
      if (c < s.mission.motherMinClearance_m) s.mission.motherMinClearance_m = c;
    }
  }

  /** Objectives complete → recall every bee to its rendezvous (staging) point. */
  private beginRecovery(): void {
    const s = this._state;
    const rc = this.config.mission.recovery;
    const r = s.mission.recovery;
    s.mission.objectivesCompleteAt = s.time;
    this.log(
      MOTHER_ID,
      'OBJECTIVES_COMPLETE',
      `All routes complete; casualty ${s.casualty.status}; ${s.radiation.samples.length} radiation samples; ${s.comms.messages.length} messages`,
    );
    this.setPhase('RECOVERY', 'recall bees to rendezvous points, dock sequentially');
    this.setMotherMode('RECOVERY', 'Recovery — recalling bees');
    r.stage = 'GATHERING';
    r.startedAt = s.time;
    r.order = s.bees.map((b) => b.id);
    this.log(MOTHER_ID, 'RECOVERY_START', `order ${r.order.join(' → ')}; staging radius ${rc.stagingRadius_m} m, ${rc.stagingDrop_m} m below the mother`);
    const hp = this.config.mother.hoverPoint;
    s.bees.forEach((bee, i) => {
      // staging points 120° apart; rotated in 10° steps until clear of obstacles
      const alt = hp.y - rc.stagingDrop_m;
      const obs = blockingObstacles(this.world, this.config, alt);
      let st: Vec3 = { x: hp.x, y: alt, z: hp.z };
      for (let k = 0; k < 36; k++) {
        const a = (i * 2 * Math.PI) / s.bees.length + (k * Math.PI) / 18;
        const c = { x: hp.x + rc.stagingRadius_m * Math.sin(a), y: alt, z: hp.z + rc.stagingRadius_m * Math.cos(a) };
        if (obstacleDistance(obs, c.x, c.z) >= this.config.survey.legClearance_m) {
          st = c;
          break;
        }
      }
      r.staging[bee.id] = st;
      if (this.config.mission.faults.unresponsiveBees.includes(bee.id)) {
        this.log(bee.id, 'BEE_RTB', `NO RESPONSE to the return command (fault injected) — stays at (${fmt(bee.position)})`);
        return;
      }
      const legObs = blockingObstacles(this.world, this.config, Math.min(bee.position.y, st.y));
      const leg = flightLeg({ x: bee.position.x, z: bee.position.z }, { x: st.x, z: st.z }, legObs, this.config.survey.legClearance_m, this.world.opsAreaHalfSize);
      const pts = leg.points.length ? leg.points : [{ x: st.x, z: st.z }];
      const wps = pts.map((p, j) => ({
        x: p.x,
        y: j === pts.length - 1 ? st.y : Math.max(bee.position.y, 2),
        z: p.z,
        speed: this.beeLimits(bee).vmax,
        tag: 'RTB' as const,
        block: 'RTB',
      }));
      bee.route.push(...wps);
      bee.waypointIndex = bee.route.length - wps.length;
      bee.waypointTotal = bee.route.length;
      bee.rtb = true;
      bee.mode = 'TRANSIT';
      bee.routeCompleteTime = null;
      bee.bestDistToWaypoint = Number.POSITIVE_INFINITY;
      bee.lastProgressTime = s.time;
      this.log(bee.id, 'BEE_RTB', `return to rendezvous (${fmt(st)}) via ${wps.length} leg(s)`);
    });
  }

  /** Recovery state machine (runs while the mother is in RECOVERY). */
  private updateRecovery(dt: number): void {
    const s = this._state;
    const m = s.mother;
    const r = s.mission.recovery;
    const rc = this.config.mission.recovery;
    const cfgM = this.config.mother;
    const pending = s.bees.filter((b) => !r.docked.includes(b.id) && !r.failed.some((f) => f.bee === b.id));
    switch (r.stage) {
      case 'GATHERING': {
        m.missionStatus = `Recovery — waiting at rendezvous ${pending.filter((b) => b.mode === 'STAGED').length}/${pending.length}`;
        const allStaged = pending.every((b) => b.mode === 'STAGED');
        const timedOut = s.time - (r.startedAt as number) >= rc.gatherTimeout_s;
        if (allStaged || timedOut) {
          for (const b of pending) {
            if (b.mode === 'STAGED') continue;
            const reason = this.config.mission.faults.unresponsiveBees.includes(b.id) ? 'NO_RESPONSE' : 'DID_NOT_REACH_RENDEZVOUS';
            this.failBee(b, reason);
          }
          r.stage = s.bees.some((b) => b.mode === 'STAGED') ? 'HATCH_OPENING' : 'HATCH_CLOSING';
          if (r.stage === 'HATCH_OPENING') this.log(m.id, 'HATCH_OPENING', `recovery: duration=${cfgM.hatchOpenDuration}s`);
        }
        break;
      }
      case 'HATCH_OPENING': {
        m.hatchOpen = Math.min(1, m.hatchOpen + dt / cfgM.hatchOpenDuration);
        m.missionStatus = 'Recovery — opening bay';
        if (m.hatchOpen >= 1) {
          m.hatchOpen = 1;
          this.log(m.id, 'HATCH_OPENED', 'Bay open for recovery');
          r.stage = 'DOCKING';
        }
        break;
      }
      case 'DOCKING': {
        if (r.current === null) {
          const next = r.order.map((id) => s.bees.find((b) => b.id === id)!).find((b) => b.mode === 'STAGED');
          if (!next) {
            r.stage = 'HATCH_CLOSING';
            break;
          }
          this.startDockAttempt(next, 1);
        }
        const bee = s.bees.find((b) => b.id === r.current)!;
        const att = r.attempts[r.attempts.length - 1];
        const slot = this.slotWorldPosition(m, bee.id);
        const eh = Math.hypot(bee.position.x - slot.x, bee.position.z - slot.z);
        m.missionStatus = `Recovery — docking ${bee.id} (attempt ${att.attempt}/${rc.maxAttempts}) · docked ${r.docked.length}/${s.bees.length}`;
        if (bee.mode === 'DOCK_APPROACH') {
          const ev = bee.position.y - (slot.y - rc.approachDrop_m);
          const sp = Math.hypot(bee.velocity.x - m.velocity.x, bee.velocity.y - m.velocity.y, bee.velocity.z - m.velocity.z);
          if (eh < rc.alignTolerance_m && Math.abs(ev) < rc.alignVerticalTolerance_m && sp < rc.alignSpeed_mps) {
            if (r.alignSince === null) r.alignSince = s.time;
            if (s.time - r.alignSince >= rc.alignHold_s - 1e-9) {
              bee.mode = 'DOCKING';
              att.alignError_m = eh;
              att.maxAscentError_m = eh;
              this.log(bee.id, 'DOCK_ASCENT', `aligned below slot: horizontal error ${eh.toFixed(3)}m, vertical ${ev.toFixed(3)}m, relative speed ${sp.toFixed(2)}m/s held ${rc.alignHold_s}s`);
            }
          } else r.alignSince = null;
        } else if (bee.mode === 'DOCKING') {
          att.maxAscentError_m = Math.max(att.maxAscentError_m ?? 0, eh);
          const e3 = dist(bee.position, slot);
          const inserted = slot.y - bee.position.y < 0.02;
          if (eh > rc.abortTolerance_m) {
            att.result = 'ABORTED';
            att.end = s.time;
            this.log(bee.id, 'DOCK_ABORT', `horizontal error ${eh.toFixed(3)}m > ${rc.abortTolerance_m}m during ascent — backing out`);
            this.retryOrFail(bee, att.attempt, 'ALIGNMENT_LOST');
          } else if (inserted && eh < rc.dockTolerance_m) {
            att.result = 'DOCKED';
            att.end = s.time;
            att.captureError_m = eh;
            copyInto(bee.position, slot);
            copyInto(bee.velocity, m.velocity);
            bee.mode = 'DOCKED';
            bee.rtb = false;
            bee.missionStatus = 'Docked in bay';
            r.docked.push(bee.id);
            r.current = null;
            this.log(bee.id, 'BEE_DOCKED', `captured at slot height: horizontal error ${eh.toFixed(3)}m < ${rc.dockTolerance_m}m, 3-D ${e3.toFixed(3)}m (align ${att.alignError_m?.toFixed(3)}m, max during ascent ${att.maxAscentError_m?.toFixed(3)}m) · docked ${r.docked.length}/${s.bees.length}`);
          }
        }
        if (r.current !== null && att.result === null && s.time - att.start >= rc.attemptTimeout_s) {
          att.result = 'TIMEOUT';
          att.end = s.time;
          this.log(bee.id, 'DOCK_ABORT', `attempt ${att.attempt} timed out after ${rc.attemptTimeout_s}s (no stable alignment)`);
          this.retryOrFail(bee, att.attempt, 'ALIGNMENT_TIMEOUT');
        }
        break;
      }
      case 'HATCH_CLOSING': {
        m.hatchOpen = Math.max(0, m.hatchOpen - dt / cfgM.hatchCloseDuration);
        m.missionStatus = 'Recovery — closing bay';
        if (m.hatchOpen <= 0) {
          m.hatchOpen = 0;
          r.stage = 'DONE';
          r.completedAt = s.time;
          const ok = r.docked.length === s.bees.length;
          this.log(m.id, 'HATCH_CLOSED', `Bay closed — ${r.docked.length}/${s.bees.length} bees docked`);
          if (ok) this.log(m.id, 'RECOVERY_COMPLETE', `all ${s.bees.length} bees docked in ${(s.time - (r.startedAt as number)).toFixed(1)}s`);
          else this.log(m.id, 'RECOVERY_INCOMPLETE', `${r.docked.length}/${s.bees.length} docked; NOT recovered: ${r.failed.map((f) => `${f.bee} (${f.reason})`).join(', ')}`);
          s.mission.returnRoute = this.planMotherLegs(m.position, { x: this.config.mission.pad.x, y: m.position.y, z: this.config.mission.pad.z });
          s.mission.routeIndex = 0;
          this.setMotherMode('RETURN', 'Returning to base');
          this.setPhase('RETURN', `${s.mission.returnRoute.length} leg(s) to the pad`);
          this.log(m.id, 'RETURN_START', `to pad (${this.config.mission.pad.x}, ${this.config.mission.pad.z}) via ${s.mission.returnRoute.length} leg(s)`);
        }
        break;
      }
      default:
        break;
    }
  }

  private startDockAttempt(bee: BeeState, attempt: number): void {
    const s = this._state;
    const r = s.mission.recovery;
    r.current = bee.id;
    r.alignSince = null;
    bee.mode = 'DOCK_APPROACH';
    bee.missionStatus = `Docking approach (attempt ${attempt})`;
    r.attempts.push({ bee: bee.id, attempt, start: s.time, end: null, result: null, alignError_m: null, maxAscentError_m: null, captureError_m: null });
    this.log(bee.id, 'DOCK_APPROACH', `attempt ${attempt}/${this.config.mission.recovery.maxAttempts}: move ${this.config.mission.recovery.approachDrop_m} m below the bay slot`);
  }

  private retryOrFail(bee: BeeState, attempt: number, reason: string): void {
    if (attempt < this.config.mission.recovery.maxAttempts) this.startDockAttempt(bee, attempt + 1);
    else {
      this.failBee(bee, reason);
      this._state.mission.recovery.current = null;
    }
  }

  private failBee(bee: BeeState, reason: string): void {
    const s = this._state;
    s.mission.recovery.failed.push({ bee: bee.id, reason, time: s.time });
    if (!this.config.mission.faults.unresponsiveBees.includes(bee.id)) bee.mode = 'DOCK_FAILED';
    bee.missionStatus = `NOT RECOVERED — ${reason}`;
    this.log(bee.id, 'DOCK_FAILED', `${reason}: ${bee.id} is NOT docked (left at (${fmt(bee.position)}))`);
  }

  /** Bee control during docking (approach / ascent) and after a failed recovery (hold at rendezvous). */
  private updateDockingBee(bee: BeeState, dt: number): void {
    const s = this._state;
    const m = s.mother;
    const cfg = this.config.bee;
    const rc = this.config.mission.recovery;
    const slot = this.slotWorldPosition(m, bee.id);
    let desired = v3();
    if (bee.mode === 'DOCK_APPROACH') {
      const tgt = { x: slot.x, y: slot.y - rc.approachDrop_m, z: slot.z };
      const e = sub(tgt, bee.position);
      const eh = Math.hypot(e.x, e.z);
      const hs = Math.min(rc.approachMaxSpeed_mps, 1.5 * eh);
      desired = { x: m.velocity.x + (eh > 1e-9 ? (e.x / eh) * hs : 0), y: clampAbs(0.8 * e.y, cfg.maxSpeedY), z: m.velocity.z + (eh > 1e-9 ? (e.z / eh) * hs : 0) };
      bee.missionStatus = `Docking approach — ${eh.toFixed(2)} m from alignment`;
    } else if (bee.mode === 'DOCKING') {
      const e = sub(slot, bee.position);
      const eh = Math.hypot(e.x, e.z);
      const hs = Math.min(0.8, 3 * eh);
      const vy = e.y > 0.02 ? Math.min(rc.ascentSpeed_mps, 1.2 * e.y + 0.1) : 1.2 * e.y;
      desired = { x: m.velocity.x + (eh > 1e-9 ? (e.x / eh) * hs : 0), y: m.velocity.y + vy, z: m.velocity.z + (eh > 1e-9 ? (e.z / eh) * hs : 0) };
      bee.missionStatus = `Docking — ascending into bay, ${Math.max(0, e.y).toFixed(2)} m to go`;
    } else {
      const st = s.mission.recovery.staging[bee.id] ?? bee.position;
      const e = sub(st, bee.position);
      const eh = Math.hypot(e.x, e.z);
      const hs = Math.min(cfg.maxSpeedXZ, cfg.approachGain * eh);
      desired = { x: eh > 1e-9 ? (e.x / eh) * hs : 0, y: clampAbs(cfg.approachGain * e.y, cfg.maxSpeedY), z: eh > 1e-9 ? (e.z / eh) * hs : 0 };
    }
    this.integrate(bee, desired, cfg.maxAccel, cfg.maxSpeedXZ, cfg.maxSpeedY, dt, true);
    if (bee.mode === 'DOCKING' && bee.position.y > slot.y) {
      bee.position.y = slot.y; // bay ceiling
      if (bee.velocity.y > m.velocity.y) bee.velocity.y = m.velocity.y;
    }
    if (bee.mode !== 'DOCK_FAILED') bee.yaw = turnToward(bee.yaw, m.yaw, 1.5 * dt);
  }

  private releaseNextBee(): void {
    const s = this._state;
    const m = s.mother;
    const bee = s.bees[m.releasedCount];
    if (!bee) return;
    bee.mode = 'RELEASING';
    bee.missionStatus = 'Releasing — dropping clear of bay';
    bee.releaseTime = s.time;
    bee.releaseStartY = bee.position.y;
    bee.lastProgressTime = s.time;
    m.releasedCount += 1;
    this.log(
      bee.id,
      'BEE_RELEASED',
      `order=${m.releasedCount}/3 hatch=${m.hatchOpen.toFixed(2)} motherSpeed=${Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z).toFixed(2)}m/s`,
    );
  }

  /** World position of a bay slot given the mother pose. */
  private slotWorldPosition(m: { position: Vec3; yaw: number }, id: BeeId): Vec3 {
    const o = this.config.baySlots[id];
    const c = Math.cos(m.yaw);
    const sn = Math.sin(m.yaw);
    // body frame: x right, z forward → world rotation about +y by yaw
    return {
      x: m.position.x + o.x * c + o.z * sn,
      y: m.position.y + o.y,
      z: m.position.z - o.x * sn + o.z * c,
    };
  }

  // -------------------------------------------------------------------- bees

  private setBeeMode(bee: BeeState, mode: BeeMode): void {
    bee.mode = mode;
  }

  private updateBee(bee: BeeState, dt: number): void {
    const s = this._state;
    const cfg = this.config.bee;
    copyInto(bee.prevPosition, bee.position);
    bee.prevYaw = bee.yaw;

    if (bee.mode === 'DOCKED') {
      const p = this.slotWorldPosition(s.mother, bee.id);
      copyInto(bee.position, p);
      copyInto(bee.velocity, s.mother.velocity);
      bee.yaw = s.mother.yaw;
      return;
    }

    if (bee.mode === 'RELEASING') {
      // Kinematic drop straight down out of the bay, following the mother horizontally.
      const slot = this.slotWorldPosition(s.mother, bee.id);
      const targetY = bee.releaseStartY - cfg.releaseDropDistance;
      const newY = Math.max(targetY, bee.position.y - cfg.releaseDescentSpeed * dt);
      const vy = (newY - bee.position.y) / dt;
      bee.position.x = slot.x;
      bee.position.z = slot.z;
      bee.position.y = newY;
      bee.velocity = { x: s.mother.velocity.x, y: vy, z: s.mother.velocity.z };
      if (newY <= targetY + 1e-9) {
        this.setBeeMode(bee, 'TRANSIT');
        bee.lastProgressTime = s.time;
        bee.bestDistToWaypoint = Number.POSITIVE_INFINITY;
        this.log(bee.id, 'BEE_CLEAR_OF_BAY', `dropped ${cfg.releaseDropDistance}m, starting route`);
      }
      bee.missionStatus = 'Releasing — dropping clear of bay';
      return;
    }

    // Phase 3B: docking / failed-recovery control bypasses route following
    if (bee.mode === 'DOCK_APPROACH' || bee.mode === 'DOCKING' || bee.mode === 'DOCK_FAILED') {
      this.updateDockingBee(bee, dt);
      return;
    }

    const route = bee.route;
    bee.waypointTotal = route.length;
    const isFinal = bee.waypointIndex >= route.length - 1;
    const wp = route[Math.min(bee.waypointIndex, route.length - 1)];
    const holding = bee.mode === 'LOITER' || bee.mode === 'HOLD' || bee.mode === 'STAGED';
    // per-bee profile (Phase 3B+: BEE-01 is faster) and per-leg speed cap (survey lanes /
    // corridor / hotspot legs fly slower than transit), then the near-obstacle cap
    const lim = this.beeLimits(bee);
    // safety caps (obstacles / traffic) also bound the FINAL command after avoidance & separation
    const safetyCap = Math.min(this.obstacleSpeedCap(bee, lim), this.trafficSpeedCap(bee, lim));
    const vmax = Math.min(lim.vmax, wp.speed ?? lim.vmax, safetyCap, this.elevatedSpeedCap(bee, lim));

    // 1) Desired velocity toward active waypoint (speed tapers near the final one).
    const toWp = sub(wp, bee.position);
    const dWp = Math.hypot(toWp.x, toWp.y, toWp.z);
    const dXZ = Math.hypot(toWp.x, toWp.z);
    let desired = v3();
    if (dXZ > 1e-6) {
      let hs: number;
      if (isFinal || holding) {
        hs = Math.min(vmax, cfg.approachGain * dXZ);
      } else {
        // Corner speed: slow down before sharp turns so momentum does not
        // carry the bee wide of the route (v^2 = vc^2 + 2·a·d braking profile).
        const next = route[bee.waypointIndex + 1];
        const ax = toWp.x / dXZ;
        const az = toWp.z / dXZ;
        const bx = next.x - wp.x;
        const bz = next.z - wp.z;
        const bl = Math.hypot(bx, bz);
        const cosTurn = bl > 1e-6 ? (ax * bx + az * bz) / bl : 1;
        const vNext = Math.min(lim.vmax, next.speed ?? lim.vmax);
        const vCorner = Math.min(vNext, Math.max(1.2, (lim.vmax * (1 + cosTurn)) / 2));
        const dBrake = Math.max(0, dXZ - cfg.waypointTolerance);
        hs = Math.min(vmax, Math.sqrt(vCorner * vCorner + 2 * lim.accel * 0.6 * dBrake));
      }
      desired.x = (toWp.x / dXZ) * hs;
      desired.z = (toWp.z / dXZ) * hs;
    }
    desired.y = clampAbs(cfg.approachGain * toWp.y, cfg.maxSpeedY);

    // 2) Reactive obstacle avoidance (horizontal repulsion + tangential slide).
    const avoid = this.applyAvoidance(bee, desired);
    desired = avoid.command;

    // 3) Bee–bee separation (simple pairwise repulsion).
    desired = this.applySeparation(bee, desired);

    this.integrate(bee, desired, lim.accel, Math.min(lim.vmax, Math.max(safetyCap, 0.5)), cfg.maxSpeedY, dt, true);
    if (bee.position.y < 0.5) {
      bee.position.y = 0.5;
      if (bee.velocity.y < 0) bee.velocity.y = 0;
    }
    if (lenXZ(bee.velocity) > 0.4) {
      bee.yaw = turnToward(bee.yaw, Math.atan2(bee.velocity.x, bee.velocity.z), 2.5 * dt);
    }

    // 4) Avoidance state + debounced logging.
    if (avoid.active !== bee.avoidanceActive) {
      bee.avoidanceActive = avoid.active;
      bee.avoidanceChangedAt = s.time;
    }
    bee.avoidanceObstacleId = avoid.obstacleId;
    const sinceChange = s.time - bee.avoidanceChangedAt;
    if (bee.avoidanceActive && !bee.avoidanceLogged && sinceChange >= cfg.avoidanceLogDebounce) {
      bee.avoidanceLogged = true;
      this.log(bee.id, 'AVOIDANCE_START', `obstacle=${avoid.obstacleId ?? '?'} pos=(${fmt(bee.position)})`);
    } else if (!bee.avoidanceActive && bee.avoidanceLogged && sinceChange >= cfg.avoidanceLogDebounce) {
      bee.avoidanceLogged = false;
      this.log(bee.id, 'AVOIDANCE_END', `pos=(${fmt(bee.position)})`);
    }

    // 5) Waypoint logic.
    if (bee.mode === 'LOITER') {
      bee.missionStatus = 'Route complete — loitering';
      return;
    }
    if (bee.mode === 'HOLD') {
      bee.missionStatus = 'Holding — awaiting corridor tasking';
      return;
    }
    if (bee.mode === 'STAGED') {
      bee.missionStatus = 'At rendezvous — waiting for recovery';
      return;
    }
    this.setBeeMode(bee, bee.avoidanceActive ? 'AVOIDING' : 'TRANSIT');

    const newDist = dist(wp, bee.position);
    // "Progress" = closing at least 0.5 m (or 25 % of the remaining gap when close).
    if (newDist < bee.bestDistToWaypoint - Math.min(0.5, 0.25 * bee.bestDistToWaypoint)) {
      bee.bestDistToWaypoint = newDist;
      bee.lastProgressTime = s.time;
    }

    const tol = isFinal ? cfg.finalWaypointTolerance : cfg.waypointTolerance;
    // Intermediate waypoints also count as reached when the bee has crossed the
    // plane through the waypoint perpendicular to the next leg while close to it
    // (prevents orbiting a waypoint under disturbance).
    let passed = false;
    if (!isFinal && dWp <= 3 * tol) {
      const next = route[bee.waypointIndex + 1];
      const lx = next.x - wp.x;
      const lz = next.z - wp.z;
      passed = (bee.position.x - wp.x) * lx + (bee.position.z - wp.z) * lz > 0;
    }
    if (dWp <= tol || passed) {
      this.log(bee.id, 'WAYPOINT_REACHED', `wp=${bee.waypointIndex + 1}/${route.length} err=${dWp.toFixed(2)}m`);
      this.advanceWaypoint(bee, route.length);
    } else if (s.time - bee.lastProgressTime > cfg.stuckTimeout) {
      this.log(bee.id, 'WAYPOINT_SKIPPED', `wp=${bee.waypointIndex + 1}/${route.length} no progress for ${cfg.stuckTimeout}s`);
      this.advanceWaypoint(bee, route.length);
    }

    if ((bee.mode as BeeMode) !== 'LOITER' && (bee.mode as BeeMode) !== 'HOLD' && (bee.mode as BeeMode) !== 'STAGED') {
      bee.missionStatus = `${bee.mode === 'AVOIDING' ? 'Avoiding obstacle — ' : ''}WP ${bee.waypointIndex + 1}/${route.length}`;
    }
  }

  /** Speed / acceleration limits of a bee: its profile (bee.profiles) or the shared bee values. */
  beeLimits(bee: { id: BeeId }): { vmax: number; accel: number; profile: BeeSpeedProfile | null } {
    const cfg = this.config.bee;
    const p = cfg.profiles?.[bee.id] ?? null;
    return p ? { vmax: p.maxSpeedXZ, accel: p.maxAccel, profile: p } : { vmax: cfg.maxSpeedXZ, accel: cfg.maxAccel, profile: null };
  }

  /** Last time each bee's own on-board reading was ≥ its profile's elevatedRate (measurement-quality cap). */
  private elevatedAt: Partial<Record<BeeId, number>> = {};

  /**
   * Measurement-quality speed cap (profiled bees only): within `elevatedHold_s` of an ON-BOARD
   * reading ≥ `elevatedRate_uSv_h`, fly at most `elevatedSpeed_mps` (the bee's own data — no truth).
   */
  private elevatedSpeedCap(bee: BeeState, lim: { profile: BeeSpeedProfile | null }): number {
    const p = lim.profile;
    if (!p || !(p.elevatedRate_uSv_h > 0)) return Number.POSITIVE_INFINITY;
    const s = this._state;
    const last = s.radiation.latest;
    if (last && last.droneId === bee.id && last.measured_uSv_h >= p.elevatedRate_uSv_h) this.elevatedAt[bee.id] = last.time;
    const t = this.elevatedAt[bee.id];
    return t !== undefined && s.time - t <= p.elevatedHold_s ? p.elevatedSpeed_mps : Number.POSITIVE_INFINITY;
  }

  /**
   * Traffic speed cap (profiled bees only): slow down near another airborne drone (other bees and
   * the mother), linear from the profile's full speed at `trafficSlowdownRange_m` to
   * `trafficMinSpeed_mps` at bee.beeSeparation. The pairwise repulsion stays the hard layer.
   */
  private trafficSpeedCap(bee: BeeState, lim: { vmax: number; profile: BeeSpeedProfile | null }): number {
    const p = lim.profile;
    if (!p || !(p.trafficSlowdownRange_m > 0)) return Number.POSITIVE_INFINITY;
    const s = this._state;
    let d = s.mother.mode === 'STANDBY' || s.mother.mode === 'LANDED' ? Number.POSITIVE_INFINITY : dist(bee.position, s.mother.position);
    for (const o of s.bees) if (o !== bee && isFreeFlying(o)) d = Math.min(d, dist(bee.position, o.position));
    if (d >= p.trafficSlowdownRange_m) return Number.POSITIVE_INFINITY;
    const d0 = this.config.bee.beeSeparation;
    const t = Math.max(0, Math.min(1, (d - d0) / Math.max(1e-6, p.trafficSlowdownRange_m - d0)));
    return p.trafficMinSpeed_mps + (lim.vmax - p.trafficMinSpeed_mps) * t;
  }

  /**
   * Near-obstacle speed cap (profiled bees only): linear from the profile's full speed at
   * `obstacleSlowdownRange_m` down to `obstacleSlowdownMinSpeed_mps` at the avoidance influence
   * distance, for obstacles that block at the bee's altitude. Infinity when not applicable.
   */
  private obstacleSpeedCap(bee: BeeState, lim: { vmax: number; profile: BeeSpeedProfile | null }): number {
    const p = lim.profile;
    if (!p || p.obstacleSlowdownRange_m <= 0) return Number.POSITIVE_INFINITY;
    const cfg = this.config.bee;
    const infl = cfg.bodyRadius + cfg.obstacleSafetyMargin;
    let d = Number.POSITIVE_INFINITY;
    for (const o of this.world.obstacles) {
      if (o.height + cfg.obstacleVerticalMargin < bee.position.y) continue;
      const q = obstacleProximity(o, bee.position.x, bee.position.z);
      d = Math.min(d, q.inside ? 0 : q.distance);
    }
    if (d >= p.obstacleSlowdownRange_m) return Number.POSITIVE_INFINITY;
    const t = Math.max(0, Math.min(1, (d - infl) / Math.max(1e-6, p.obstacleSlowdownRange_m - infl)));
    return p.obstacleSlowdownMinSpeed_mps + (lim.vmax - p.obstacleSlowdownMinSpeed_mps) * t;
  }

  private advanceWaypoint(bee: BeeState, total: number): void {
    const s = this._state;
    if (bee.waypointIndex >= total - 1) {
      if (bee.rtb) {
        this.setBeeMode(bee, 'STAGED');
        bee.missionStatus = 'At rendezvous — waiting for recovery';
        this._state.mission.recovery.staged.push(bee.id);
        this.log(bee.id, 'BEE_STAGED', `at rendezvous (${fmt(bee.position)})`);
        return;
      }
      if (bee.id === 'BEE-01' && this.config.survey.enabled) {
        // survey controller decides: wait for corridor tasking, or finish
        if (this.survey.onRouteEnd(this.ctx, bee) === 'HOLD') {
          this.setBeeMode(bee, 'HOLD');
          bee.missionStatus = 'Holding — awaiting corridor tasking';
          return;
        }
      }
      this.setBeeMode(bee, 'LOITER');
      bee.routeCompleteTime = s.time;
      bee.missionStatus = 'Route complete — loitering';
      this.log(bee.id, 'ROUTE_COMPLETE', `t=${s.time.toFixed(2)}s pos=(${fmt(bee.position)})`);
      return;
    }
    bee.waypointIndex += 1;
    bee.bestDistToWaypoint = Number.POSITIVE_INFINITY;
    bee.lastProgressTime = s.time;
  }

  private applyAvoidance(
    bee: BeeState,
    desiredIn: Vec3,
  ): { command: Vec3; active: boolean; obstacleId: string | null } {
    const cfg = this.config.bee;
    const influence = cfg.bodyRadius + cfg.obstacleSafetyMargin;
    const v = clone(desiredIn);
    const desiredSpeed = Math.max(Math.hypot(desiredIn.x, desiredIn.z), 0.5);
    let active = false;
    let strongest = 0;
    let obstacleId: string | null = null;

    for (const o of this.world.obstacles) {
      // Obstacles comfortably below the bee are flown over.
      if (o.height + cfg.obstacleVerticalMargin < bee.position.y) continue;
      const p = obstacleProximity(o, bee.position.x, bee.position.z);
      // Look further ahead when the bee is already moving toward the surface:
      // add the braking distance for its current inward speed.
      const vIn = -(bee.velocity.x * p.nx + bee.velocity.z * p.nz);
      const brake = vIn > 0 ? (vIn * vIn) / (2 * cfg.maxAccel * 0.7) : 0;
      const reach = influence + brake;
      if (p.distance >= reach) continue;
      const w = p.inside ? 1 : 1 - p.distance / reach; // 0 … 1
      active = true;
      if (w > strongest) {
        strongest = w;
        obstacleId = o.id;
      }
      const dn = v.x * p.nx + v.z * p.nz; // >0 moving away
      if (dn < 0) {
        // cancel the inward component, slide along the surface (tangent)
        const k = Math.min(1, 3 * w);
        v.x -= p.nx * dn * k;
        v.z -= p.nz * dn * k;
        let tx = -p.nz;
        let tz = p.nx;
        // pick the tangent direction that agrees with the desired motion
        // (exact head-on ties keep the default, so behaviour stays deterministic)
        const along = desiredIn.x * tx + desiredIn.z * tz;
        if (along < 0) {
          tx = -tx;
          tz = -tz;
        }
        v.x += tx * 0.8 * w * desiredSpeed;
        v.z += tz * 0.8 * w * desiredSpeed;
      }
      // outward push grows quadratically as the gap closes
      v.x += p.nx * 2.5 * w * w * desiredSpeed;
      v.z += p.nz * 2.5 * w * w * desiredSpeed;
    }
    return { command: v, active, obstacleId };
  }

  private applySeparation(bee: BeeState, desired: Vec3): Vec3 {
    const cfg = this.config.bee;
    const v = clone(desired);
    for (const other of this._state.bees) {
      if (other === bee || other.mode === 'DOCKED' || other.mode === 'RELEASING') continue;
      const dx = bee.position.x - other.position.x;
      const dy = bee.position.y - other.position.y;
      const dz = bee.position.z - other.position.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < cfg.beeSeparation && d > 1e-6) {
        const w = 1 - d / cfg.beeSeparation;
        v.x += (dx / d) * 2 * w;
        v.y += (dy / d) * 2 * w;
        v.z += (dz / d) * 2 * w;
      }
    }
    return v;
  }

  // ---------------------------------------------------------------- dynamics

  /**
   * First-order velocity tracking with an acceleration limit, plus a seeded
   * Ornstein–Uhlenbeck gust disturbance, then explicit Euler position update.
   */
  private integrate(
    e: { position: Vec3; velocity: Vec3; gust: Vec3 },
    vCmdIn: Vec3,
    maxAccel: number,
    maxXZ: number,
    maxY: number,
    dt: number,
    disturbed: boolean,
  ): void {
    const vCmd = clone(vCmdIn);
    const h = Math.hypot(vCmd.x, vCmd.z);
    if (h > maxXZ) {
      vCmd.x *= maxXZ / h;
      vCmd.z *= maxXZ / h;
    }
    vCmd.y = clampAbs(vCmd.y, maxY);

    let v = approach(e.velocity, vCmd, maxAccel * dt);

    if (disturbed) {
      const d = this.config.disturbance;
      const a = dt / d.tau;
      const sq = d.sigma * Math.sqrt(2 * a); // stationary std = sigma
      e.gust.x += -a * e.gust.x + sq * this.rng.gaussian();
      e.gust.y += -a * e.gust.y + sq * this.rng.gaussian() * d.verticalFactor;
      e.gust.z += -a * e.gust.z + sq * this.rng.gaussian();
      v = add(v, scale(e.gust, dt));
    }
    v = clampLen(v, Math.hypot(maxXZ, maxY) * 1.05);
    copyInto(e.velocity, v);
    e.position.x += v.x * dt;
    e.position.y += v.y * dt;
    e.position.z += v.z * dt;
  }

  // ------------------------------------------------------------- recording

  private updateClearance(): void {
    const s = this._state;
    const r = this.config.bee.bodyRadius;
    // Phase 3B+: drone–drone separation (airborne bees only; bay operations are excluded)
    const air = s.bees.filter((b) => isFreeFlying(b));
    const sep = s.minSeparation;
    for (let i = 0; i < air.length; i++) {
      const dm = dist(air[i].position, s.mother.position);
      if (dm < sep.motherBee_m) sep.motherBee_m = dm;
      for (let j = i + 1; j < air.length; j++) {
        const d = dist(air[i].position, air[j].position);
        if (d < sep.beeBee_m) {
          sep.beeBee_m = d;
          sep.beeBeePair = `${air[i].id}–${air[j].id}`;
        }
      }
    }
    for (const bee of s.bees) {
      if (bee.mode === 'DOCKED' || bee.mode === 'RELEASING') continue;
      for (const o of this.world.obstacles) {
        if (o.height < bee.position.y - r) continue; // physically below the bee
        const p = obstacleProximity(o, bee.position.x, bee.position.z);
        if (p.distance < s.minClearance[bee.id]) s.minClearance[bee.id] = p.distance;
      }
    }
  }

  private recordSamples(): void {
    const s = this._state;
    const m = s.mother;
    s.samples.push(this.sampleOf(m, 'mother', -1, 0, m.hatchOpen, false));
    s.trails[m.id].push(clone(m.position));
    for (const b of s.bees) {
      s.samples.push(this.sampleOf(b, 'bee', b.waypointIndex, b.waypointTotal, m.hatchOpen, b.avoidanceActive));
      if (b.mode !== 'DOCKED') s.trails[b.id].push(clone(b.position));
    }
  }

  private sampleOf(
    e: MotherState | BeeState,
    entityType: 'mother' | 'bee',
    waypointIndex: number,
    waypointTotal: number,
    hatchOpen: number,
    avoidanceActive: boolean,
  ): PositionSample {
    const s = this._state;
    return {
      step: s.step,
      time: s.time,
      entityId: e.id,
      entityType,
      mode: e.mode,
      missionStatus: e.missionStatus,
      x: e.position.x,
      y: e.position.y,
      z: e.position.z,
      vx: e.velocity.x,
      vy: e.velocity.y,
      vz: e.velocity.z,
      speed: Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z),
      waypointIndex,
      waypointTotal,
      hatchOpen,
      avoidanceActive,
    };
  }

  private log(entityId: string, type: SimEventType, details: string): void {
    const s = this._state;
    const ev: SimEvent = { step: s.step, time: s.time, entityId, type, details };
    s.events.push(ev);
  }
}

// ------------------------------------------------------------------ helpers

function clampAbs(v: number, max: number): number {
  return v > max ? max : v < -max ? -max : v;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function turnToward(current: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxStep) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxStep);
}

/** 32-bit FNV-1a hash as 6 hex chars (run-id suffix). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

function fmt(p: Vec3): string {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`;
}
