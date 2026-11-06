import { simController } from '../state/simController';
import { effectiveDroneScale, viewSettings } from '../state/viewSettings';
import type { BeeState, MotherState } from '../sim';

/**
 * Converts engine state into render poses.
 *
 * Interpolation: the engine advances in fixed 50 ms steps; the view blends
 * prevPosition → position by the controller's accumulator fraction (alpha) so
 * motion looks smooth at any monitor refresh rate. Telemetry and CSV always
 * show the un-interpolated engine values.
 *
 * Display scale: when drone models are enlarged for visibility, bees that are
 * still inside / just leaving the mother are offset by the same factor so they
 * fit the enlarged bay; the offset fades out over 2 s after leaving the bay.
 */
export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export function motherPose(m: MotherState = simController.engine.state.mother): Pose {
  const a = simController.alpha;
  return {
    x: lerp(m.prevPosition.x, m.position.x, a),
    y: lerp(m.prevPosition.y, m.position.y, a),
    z: lerp(m.prevPosition.z, m.position.z, a),
    yaw: lerpAngle(m.prevYaw, m.yaw, a),
  };
}

/** Lowest point of the mother model (landing-gear feet) below its body centre, at scale 1, m. */
export const MOTHER_GEAR_DROP = 0.95;

/**
 * Mother pose for DRAWING. With an enlarged display scale k, the model's gear
 * would sink into the pad, so near the ground the drawn model is lifted by
 * (k − 1)·gearDrop (fading out by 10 m above the pad). Physics is unchanged.
 */
export function motherVisualPose(m: MotherState = simController.engine.state.mother): Pose {
  const p = motherPose(m);
  const k = effectiveDroneScale(viewSettings.get());
  const rest = simController.engine.config.mission.padRestHeight_m;
  if (k !== 1 && simController.engine.config.mission.lifecycle) {
    const blend = Math.max(0, Math.min(1, 1 - (p.y - rest) / 10));
    p.y += (k - 1) * MOTHER_GEAR_DROP * blend;
  }
  return p;
}

export function motherHatch(m: MotherState = simController.engine.state.mother): number {
  return lerp(m.prevHatchOpen, m.hatchOpen, simController.alpha);
}

export function beePose(b: BeeState): Pose {
  const engine = simController.engine;
  const a = simController.alpha;
  const m = engine.state.mother;
  const k = effectiveDroneScale(viewSettings.get());
  const p: Pose = {
    x: lerp(b.prevPosition.x, b.position.x, a),
    y: lerp(b.prevPosition.y, b.position.y, a),
    z: lerp(b.prevPosition.z, b.position.z, a),
    yaw: lerpAngle(b.prevYaw, b.yaw, a),
  };
  if (k !== 1) {
    let f = 1;
    if (b.mode === 'DOCKING') f = 1;
    else if (b.mode === 'DOCK_APPROACH' || b.mode === 'STAGED') {
      // fade the bay-scale offset in while approaching the slot from below
      const mp0 = motherPose(m);
      const d = Math.hypot(p.x - mp0.x, p.y - mp0.y, p.z - mp0.z);
      f = b.mode === 'STAGED' ? 0 : Math.max(0, Math.min(1, (8 - d) / 4));
    } else if (b.mode !== 'DOCKED' && b.mode !== 'RELEASING' && b.releaseTime !== null) {
      const cfg = engine.config.bee;
      const tClear = b.releaseTime + cfg.releaseDropDistance / cfg.releaseDescentSpeed;
      f = Math.max(0, Math.min(1, 1 - (engine.state.time - tClear) / 2));
    }
    if (f > 0) {
      // drawn = mother_drawn + (bee − mother)·k  (blended by f); the lift is the mother's landing-gear lift
      const mp = motherPose(m);
      const lift = motherVisualPose(m).y - mp.y;
      p.x += (p.x - mp.x) * (k - 1) * f;
      p.y += ((p.y - mp.y) * (k - 1) + lift) * f;
      p.z += (p.z - mp.z) * (k - 1) * f;
    }
  }
  return p;
}

export function entityPose(id: string): Pose {
  const s = simController.engine.state;
  if (id === s.mother.id) return motherPose(s.mother);
  const b = s.bees.find((x) => x.id === id);
  return b ? beePose(b) : { x: 0, y: 0, z: 0, yaw: 0 };
}
