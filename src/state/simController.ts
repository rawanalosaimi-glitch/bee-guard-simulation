import { SimEngine } from '../sim';
import type { SimConfigOverrides, WorldDefinition } from '../sim';
import { missionArchive } from './missionArchive';

/**
 * Bridge between the pure simulation engine and the UI.
 *
 * - Owns the real-time pacing loop (requestAnimationFrame). Wall-clock time is
 *   only used to decide HOW MANY fixed steps to run; it never enters the
 *   simulation maths, so results are identical at any frame rate or speed.
 * - Exposes a subscribe/version API. A future live dashboard (WebSocket, etc.)
 *   can subscribe here exactly like the 3D view and telemetry panel do.
 */
export type Listener = () => void;

export class SimController {
  /** Replaced (not mutated) when scenario parameters change on Reset. */
  engine: SimEngine;
  /** Scenario overrides currently applied (radiation / comms parameters from the UI). */
  scenario: SimConfigOverrides = {};
  /** Real-time multiplier (1 = real time). */
  speed = 1;
  running = false;
  /** Fraction of a step accumulated since the last step (0..1), for render interpolation. */
  alpha = 0;

  private accumulator = 0;
  private lastWall: number | null = null;
  private rafId: number | null = null;
  private listeners = new Set<Listener>();
  private _version = 0;

  constructor(overrides: SimConfigOverrides = {}) {
    this.engine = new SimEngine(overrides);
  }

  get version(): number {
    return this._version;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this._version++;
    for (const fn of this.listeners) fn();
  }

  /** Start the mission (first press) or resume after a pause. */
  start(): void {
    if (this.engine.state.status === 'READY') this.engine.start();
    if (this.engine.state.status !== 'ACTIVE') return;
    this.running = true;
    this.lastWall = null;
    this.ensureLoop();
    this.notify();
  }

  pause(): void {
    this.running = false;
    this.notify();
  }

  /**
   * Reset to t = 0. With `scenario`, a fresh engine is built from the default
   * config plus those overrides (e.g. source strength, packet loss); otherwise
   * the current engine is reset in place.
   */
  reset(seed?: number, scenario?: SimConfigOverrides, world?: WorldDefinition): void {
    this.running = false;
    // Phase 3B+: an explicit reset / new mission clears the active mission's patient data —
    // archive it first so previous mission records stay accessible (Patients tab)
    missionArchive.add(this.engine);
    this.accumulator = 0;
    this.alpha = 0;
    if (scenario) {
      this.scenario = scenario;
      // world (2026-10-26, factor study): optional site variant (obstacle clutter); default = current site
      this.engine = new SimEngine({ ...scenario, seed: seed ?? this.engine.config.seed }, world ?? this.engine.world);
    } else {
      this.engine.reset(seed);
    }
    this.notify();
  }

  /** Mission Control operator input (evacuation workflow). Recorded in the engine log. */
  operator(patientId: string, action: 'REQUEST_RESCUE' | 'CONFIRM_EVACUATED'): boolean {
    const ok = this.engine.operatorCommand(patientId, action);
    this.notify();
    return ok;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.notify();
  }

  /** Advance exactly one fixed step (debug / frame-by-frame inspection). */
  stepOnce(): void {
    if (this.engine.state.status === 'READY') this.engine.start();
    this.running = false;
    this.engine.step();
    this.alpha = 1;
    this.notify();
  }

  private ensureLoop(): void {
    if (this.rafId !== null || typeof requestAnimationFrame === 'undefined') return;
    const loop = (now: number) => {
      this.rafId = null;
      this.tick(now);
      if (this.running) this.ensureLoop();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private tick(nowMs: number): void {
    if (!this.running) return;
    const dt = this.engine.config.dt;
    if (this.lastWall === null) this.lastWall = nowMs;
    // Clamp wall delta so a background tab does not trigger a huge catch-up burst.
    const wall = Math.min(0.25, (nowMs - this.lastWall) / 1000);
    this.lastWall = nowMs;
    this.accumulator += wall * this.speed;

    let steps = 0;
    const maxSteps = 2000;
    while (this.accumulator >= dt && steps < maxSteps && this.engine.state.status === 'ACTIVE') {
      this.engine.step();
      this.accumulator -= dt;
      steps++;
    }
    this.alpha = Math.min(1, this.accumulator / dt);
    if (this.engine.state.status !== 'ACTIVE') {
      this.running = false;
      this.alpha = 1;
    }
    if (steps > 0 || !this.running) this.notify();
  }
}

/** Single app-wide controller instance. */
export const simController = new SimController();
