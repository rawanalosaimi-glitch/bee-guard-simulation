import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { pushOutOfObstacles, pushOutOfSphere } from './cameraCollision';
import { simController } from '../state/simController';
import { cameraSubject, effectiveDroneScale, useViewSettings, viewSettings } from '../state/viewSettings';
import { DEFAULT_CONFIG } from '../sim';
import { terrainHeight } from './environment/Terrain';
import { entityPose, motherPose } from './visualState';

interface OrbitLike {
  target: THREE.Vector3;
  minDistance: number;
  update: () => void;
}

export const OVERVIEW_CAMERA = new THREE.Vector3(-105, 78, 125);
export const OVERVIEW_TARGET = new THREE.Vector3(0, 6, 2);
/** Top-down map view over the facility + evacuation corridor (small z offset keeps orbit controls stable). */
export const TOP_TARGET = new THREE.Vector3(-14, 0, 2);
export const TOP_CAMERA = new THREE.Vector3(-14, 230, 2.5);
/** Ground-station base view (launch pad, command tent, vehicles). */
export const BASE_TARGET = new THREE.Vector3(-67, 2, 66);
export const BASE_CAMERA = new THREE.Vector3(-36, 19, 101);
/** Stage 5 take-off tripod: eye height beside the launch pad, looking at the mother drone. */
const PAD = DEFAULT_CONFIG.mission.pad;
export const TAKEOFF_CAMERA = new THREE.Vector3(PAD.x + 15, 2.0, PAD.z + 17);
const PRESETS: Record<string, [THREE.Vector3, THREE.Vector3]> = {
  overview: [OVERVIEW_CAMERA, OVERVIEW_TARGET],
  top: [TOP_CAMERA, TOP_TARGET],
  base: [BASE_CAMERA, BASE_TARGET],
};

/** Clearances used by the camera collision step, metres (scaled by drone display scale where relevant). */
const BUILDING_MARGIN = 1.5;
const MOTHER_RADIUS = 4.0; // ≈ half the prop span (6.9 m / 2) + margin, × display scale
const BEE_RADIUS = 0.75;
const GROUND_CLEARANCE = 1.5;

/**
 * Camera presets + collision handling.
 *
 * - Follow modes keep the orbit target on the selected drone; the user can still orbit/zoom.
 * - Orbit min-distance is set per mode so the camera cannot zoom inside a drone.
 * - Every frame the camera is pushed out of: building footprints (or lifted over
 *   their roofs, whichever is the smaller move), the mother drone's bounding
 *   sphere, the bees' spheres, and the terrain.
 */
export function CameraRig() {
  const v = useViewSettings();
  const { cameraMode, cameraNonce } = v;
  // close-up cameras draw drones at true size (effectiveDroneScale = 1)
  const droneScale = effectiveDroneScale(v);
  const subject = cameraSubject(cameraMode);
  const closeUp = cameraMode.startsWith('CLOSE-');
  const takeoff = cameraMode === 'TAKEOFF';
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const flying = useRef(true);
  const tmp = useRef(new THREE.Vector3());

  useEffect(() => {
    flying.current = true;
  }, [cameraMode, cameraNonce]);

  useEffect(() => {
    if (!controls) return;
    controls.minDistance =
      cameraMode in PRESETS || takeoff
        ? 3
        : closeUp
          ? subject === 'MOTHER-01'
            ? MOTHER_RADIUS * 1.1
            : BEE_RADIUS * 1.6
          : cameraMode === 'MOTHER-01'
            ? MOTHER_RADIUS * 1.4 * droneScale
            : BEE_RADIUS * 2.2 * droneScale;
  }, [controls, cameraMode, droneScale, closeUp, takeoff, subject]);

  useFrame((_, delta) => {
    if (!controls) return;
    const k = 1 - Math.exp(-delta * 3);
    if (cameraMode in PRESETS) {
      const [cam, tgt] = PRESETS[cameraMode];
      if (flying.current) {
        camera.position.lerp(cam, k);
        controls.target.lerp(tgt, k);
        if (camera.position.distanceTo(cam) < 0.5) flying.current = false;
      }
    } else if (takeoff) {
      // fixed tripod; the aim follows the mother through take-off and climb
      const p = entityPose('MOTHER-01');
      controls.target.lerp(tmp.current.set(p.x, p.y, p.z), flying.current ? k : 1 - Math.exp(-delta * 6));
      if (flying.current) {
        camera.position.lerp(TAKEOFF_CAMERA, k);
        if (camera.position.distanceTo(TAKEOFF_CAMERA) < 0.3) flying.current = false;
      }
    } else {
      const p = entityPose(subject ?? cameraMode);
      const target = tmp.current.set(p.x, p.y, p.z);
      const before = controls.target.clone();
      controls.target.lerp(target, flying.current ? k : 1 - Math.exp(-delta * 10));
      camera.position.add(controls.target.clone().sub(before));
      if (flying.current) {
        // Mother view sits slightly BELOW the drone so the hatch and bay are visible.
        const isMother = subject === 'MOTHER-01';
        // close-ups: true-size drones, a near three-quarter view slightly from above
        const dist = closeUp ? (isMother ? 9 : 1.8) : (isMother ? 14 : 6) * Math.max(1, droneScale * 0.8);
        // bee close-up: a three-quarter PROFILE of the drone's right flank from just below body height, in the
        // drone's own frame, so the flank emblem (under the rotor ducts) is in view; the user can still orbit
        const beeDir = () => {
          const lx = 0.93;
          const lz = 0.36;
          const c = Math.cos(p.yaw);
          const s = Math.sin(p.yaw);
          return new THREE.Vector3(lx * c + lz * s, -0.08, -lx * s + lz * c);
        };
        const dir = closeUp
          ? isMother
            ? new THREE.Vector3(0.8, 0.3, 0.6)
            : beeDir()
          : isMother
            ? new THREE.Vector3(-0.75, -0.32, 0.6)
            : new THREE.Vector3(-0.7, 0.45, 0.7);
        const desired = target.clone().add(dir.normalize().multiplyScalar(dist));
        camera.position.lerp(desired, k);
        if (camera.position.distanceTo(desired) < 0.4) flying.current = false;
      }
    }
    controls.update();
    resolveCollisions(camera.position, droneScale);
  });
  return null;
}

/** Push `cam` out of solid things (buildings, drones, terrain). */
export function resolveCollisions(cam: THREE.Vector3, droneScale = effectiveDroneScale(viewSettings.get())): void {
  const engine = simController.engine;
  pushOutOfObstacles(cam, engine.world.obstacles, BUILDING_MARGIN);
  pushOutOfSphere(cam, motherPose(), MOTHER_RADIUS * droneScale);
  for (const b of engine.state.bees) {
    if (b.mode === 'DOCKED') continue;
    pushOutOfSphere(cam, b.position, BEE_RADIUS * droneScale);
  }
  const floor = terrainHeight(cam.x, cam.z) + GROUND_CLEARANCE;
  if (cam.y < floor) cam.y = floor;
}
