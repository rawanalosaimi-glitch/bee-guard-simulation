import { useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { BEE_IDS, DEFAULT_CONFIG } from '../sim';
import type { BeeId } from '../sim';
import { simController } from '../state/simController';
import { useSimTick } from '../state/hooks';
import { cameraSubject, effectiveDroneScale, isCloseUp, useViewSettings, viewSettings } from '../state/viewSettings';
import { DeclutterHtml } from './LabelDeclutter';
import { LABEL_PRIORITY } from './overlayStyle';
import { BeeModel } from './models/BeeModel';
import { MotherModel } from './models/MotherModel';
import { beePose, motherHatch, motherVisualPose } from './visualState';
import type { QualityProfile } from './quality';
import { rotorSettings } from './models/rotor';
import type { Vec3 } from '../sim';

/**
 * Stage 4 flight presentation: attitude (pitch / roll) drawn from the SIMULATED velocity — a multirotor
 * tilts into its direction of travel. Visual only: position and yaw are still copied from engine state;
 * the tilt is a low-passed function of the engine's velocity (τ = 0.35 s), ≤ maxTilt, and is zero while
 * docked / inside the bay / on the pad.
 */
/** Soft ground "blob" shadow for drones when the shadow map is static (Performance). Visual only. */
const blobState = { on: false };
const blobTex = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(0,0,0,0.85)');
  r.addColorStop(0.55, 'rgba(0,0,0,0.45)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
function Blob({ follow, size }: { follow: RefObject<Group | null>; size: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.3 }), []);
  useFrame(() => {
    const m = ref.current;
    const f = follow.current;
    if (!m || !f) return;
    // close-up cameras draw real (live) drone shadows instead of the blob
    const on = blobState.on && !isCloseUp(viewSettings.get().cameraMode);
    m.visible = on;
    if (!on) return;
    const k = effectiveDroneScale(viewSettings.get());
    const h = f.position.y;
    m.position.set(f.position.x, 0.14, f.position.z); // above the pad deck (0.06 m) and site decal
    m.scale.setScalar(size * k * (0.8 + h * 0.015));
    mat.opacity = 0.6 * Math.max(0, 1 - h / 45);
  });
  return (
    <mesh ref={ref} material={mat} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

function updateTilt(g: Group, v: Vec3, yaw: number, k: number, maxTilt: number, enabled: boolean, dt: number) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // velocity in the body frame (+z forward, +x right)
  const vzL = c * v.z + s * v.x;
  const vxL = c * v.x - s * v.z;
  const clamp = (a: number) => Math.max(-maxTilt, Math.min(maxTilt, a));
  const tx = enabled ? clamp(k * vzL) : 0;
  const tz = enabled ? clamp(-k * vxL) : 0;
  const a = 1 - Math.exp(-Math.min(dt, 0.1) / 0.35);
  g.rotation.x += (tx - g.rotation.x) * a;
  g.rotation.z += (tz - g.rotation.z) * a;
}

/**
 * Drone entities. Each frame they copy their pose from engine state
 * (interpolated for smoothness). They never compute or alter positions.
 */

function Tag({ id, color }: { id: string; color: string }) {
  useSimTick(5);
  const { showLabels, mainView, overlayStyle, cameraMode, cleanView } = useViewSettings();
  if (!showLabels || cleanView || mainView !== '3d') return null;
  const s = simController.engine.state;
  const e = id === s.mother.id ? s.mother : s.bees.find((b) => b.id === id);
  if (!e || (e.type === 'bee' && e.mode === 'DOCKED')) return null;
  const followed = cameraSubject(cameraMode) === id;
  // Stage 5 clean style: compact tag (ID only) unless this drone is followed; overlapping tags are de-cluttered
  const compact = overlayStyle === 'clean' && !followed;
  const prio = followed ? LABEL_PRIORITY.followed : id === s.mother.id ? LABEL_PRIORITY.mother : LABEL_PRIORITY.bee;
  return (
    <DeclutterHtml id={`tag-${id}`} priority={prio} zIndex={20}>
      <div className={`tag${compact ? ' compact' : ''}`} style={{ borderColor: color }}>
        <span className="tag-id" style={{ color }}>
          {id}
        </span>
        {!compact && <span className="tag-mode">{e.mode}</span>}
      </div>
    </DeclutterHtml>
  );
}

export function MotherEntity() {
  const root = useRef<Group>(null);
  const tilt = useRef<Group>(null);
  const model = useRef<Group>(null);
  const tag = useRef<Group>(null);
  const hatch = useRef(0);
  useFrame((_, dt) => {
    const p = motherVisualPose();
    const k = effectiveDroneScale(viewSettings.get());
    hatch.current = motherHatch();
    if (root.current) {
      root.current.position.set(p.x, p.y, p.z);
      root.current.rotation.y = p.yaw;
    }
    const m = simController.engine.state.mother;
    const airborne = m.position.y > simController.engine.config.mission.padRestHeight_m + 1;
    if (tilt.current) updateTilt(tilt.current, m.velocity, p.yaw, 0.022, 0.14, airborne, dt);
    if (model.current) model.current.scale.setScalar(k);
    if (tag.current) tag.current.position.set(0, 1.4 * k, 0);
  });
  const spinning = simController.engine.state.status !== 'READY';
  return (
    <>
    <Blob follow={root} size={4.2} />
    <group ref={root}>
      <group ref={tilt}>
        <group ref={model}>
          <MotherModel hatchRef={hatch} spinning={spinning} />
        </group>
      </group>
      <group ref={tag}>
        <Tag id="MOTHER-01" color="#e5e7eb" />
      </group>
    </group>
    </>
  );
}

function BeeEntity({ id }: { id: BeeId }) {
  const root = useRef<Group>(null);
  const tilt = useRef<Group>(null);
  const model = useRef<Group>(null);
  const tag = useRef<Group>(null);
  useFrame((_, dt) => {
    const b = simController.engine.state.bees.find((x) => x.id === id);
    if (!b || !root.current) return;
    const p = beePose(b);
    const k = effectiveDroneScale(viewSettings.get());
    root.current.position.set(p.x, p.y, p.z);
    root.current.rotation.y = p.yaw;
    const free = !['DOCKED', 'RELEASING', 'DOCKING', 'STAGED'].includes(b.mode);
    if (tilt.current) updateTilt(tilt.current, b.velocity, p.yaw, 0.035, 0.26, free, dt);
    if (model.current) model.current.scale.setScalar(k);
    if (tag.current) tag.current.position.set(0, 0.9 * k, 0);
  });
  useSimTick(4);
  const b = simController.engine.state.bees.find((x) => x.id === id);
  const spinning = !!b && b.mode !== 'DOCKED';
  return (
    <>
    {b && b.mode !== 'DOCKED' && <Blob follow={root} size={1.1} />}
    <group ref={root}>
      <group ref={tilt}>
        <group ref={model}>
          <BeeModel spinning={spinning} />
        </group>
      </group>
      <group ref={tag}>
        <Tag id={id} color={DEFAULT_CONFIG.routes[id].color} />
      </group>
    </group>
    </>
  );
}

export function Drones({ q }: { q: QualityProfile }) {
  useSimTick(2);
  rotorSettings.discs = q.rotorDiscs;
  blobState.on = q.droneShadow === 'blob';
  return (
    <group>
      <MotherEntity />
      {BEE_IDS.map((id) => (
        <BeeEntity key={id} id={id} />
      ))}
    </group>
  );
}
