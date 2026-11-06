import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { QualityProfile } from '../quality';
import type { ModelSlot } from '../pbr/classify';
import { assetUrl, getManifest, pbrMaterial, tileOf } from '../pbr/library';
import { boxGeo, cylGeo } from '../pbr/uv';
import { PROPS } from '../propLayout';
import type { PropPlacement } from '../propLayout';

/**
 * Stage 4 — emergency-response scene dressing (PRESENTATION ONLY; none of this is a simulation obstacle).
 *
 * Placement rules (checked against the simulation geometry):
 *  - outside every obstacle footprint and ≥ 15 m from the casualty (BEE-02 hovers ≈ 6 m above it);
 *  - every prop ≤ 5.2 m tall, below the lowest flight altitude in the model (8 m corridor scans;
 *    survey 15 m, mother cruise 26 m); nothing on the landing pad or its approach;
 *  - off the rescue-team route (RT-START → casualty) and the casualty → CCP corridor.
 * Vehicles carry generic markings only (FIRE / EMS / CBRN), no real organisation's branding.
 *
 * Optional CC0 GLB models (public/assets/models/<slot>.glb, see pbr/classify.ts → MODEL_SLOTS) replace the
 * procedural fallback of a slot; they are scaled to the slot's footprint and placed on the ground. Loaded
 * from the local server only.
 */

// ------------------------------------------------------------------ optional GLB models

const loader = new GLTFLoader();
const modelCache = new Map<string, Promise<THREE.Group | null>>();
function loadModel(slot: ModelSlot): Promise<THREE.Group | null> | null {
  const path = getManifest().models[slot];
  if (!path) return null;
  const hit = modelCache.get(path);
  if (hit) return hit;
  const p: Promise<THREE.Group | null> = loader
    .loadAsync(assetUrl(path))
    .then((g: { scene: THREE.Group }) => g.scene)
    .catch(() => {
      console.warn(`[assets] could not load model "${slot}" — using the procedural fallback`);
      return null;
    });
  modelCache.set(path, p);
  return p;
}

/** A GLB for `slot` fitted to `length` (longest horizontal side, m) and stood on y = 0, or the fallback. */
function ModelOr({ slot, length, children }: { slot: ModelSlot; length: number; children: ReactNode }) {
  const [obj, setObj] = useState<THREE.Object3D | null>(null);
  useEffect(() => {
    let live = true;
    const p = loadModel(slot);
    p?.then((g) => {
      if (!live || !g) return;
      const o = g.clone(true);
      const box = new THREE.Box3().setFromObject(o);
      const size = box.getSize(new THREE.Vector3());
      const k = length / Math.max(size.x, size.z, 1e-6);
      o.scale.setScalar(k);
      const b2 = new THREE.Box3().setFromObject(o);
      const c = b2.getCenter(new THREE.Vector3());
      o.position.set(-c.x, -b2.min.y, -c.z);
      o.traverse((m: THREE.Object3D) => {
        const mesh = m as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      setObj(o);
    });
    return () => {
      live = false;
    };
  }, [slot, length]);
  // a fallback that WILL be replaced by a model is kept out of static-mesh merging (MergeStatic)
  const replaceable = !!getManifest().models[slot];
  return obj ? <primitive object={obj} /> : <group userData={{ dynamic: replaceable }}>{children}</group>;
}

// ------------------------------------------------------------------ materials (shared)

let M: ReturnType<typeof makeMats> | null = null;
function makeMats() {
  return {
    fireRed: pbrMaterial('painted_steel', { color: '#b3191a', roughness: 0.9, metalness: 0.35 }),
    white: pbrMaterial('painted_steel', { color: '#f4f4f0', roughness: 0.9, metalness: 0.3 }),
    cbrnYellow: pbrMaterial('painted_steel', { color: '#e3b51c', roughness: 0.9, metalness: 0.3 }),
    chrome: pbrMaterial('painted_steel', { color: '#c7ccd1', roughness: 0.35, metalness: 0.9 }),
    tyre: new THREE.MeshStandardMaterial({ color: '#1c1c1c', roughness: 0.95 }),
    glass: new THREE.MeshStandardMaterial({ color: '#1d2f40', roughness: 0.1, metalness: 0.8, envMapIntensity: 1.4 }),
    stripeRed: new THREE.MeshStandardMaterial({ color: '#c8102e', roughness: 0.6 }),
    stripeGreen: new THREE.MeshStandardMaterial({ color: '#0f7a3c', roughness: 0.6 }),
    emsBlue: new THREE.MeshStandardMaterial({ color: '#1f5fbf', roughness: 0.6 }),
    reflective: new THREE.MeshStandardMaterial({ color: '#e9e6c8', roughness: 0.4, emissive: '#3a3a20', emissiveIntensity: 0.25 }),
    lightRed: new THREE.MeshStandardMaterial({ color: '#ff2a2a', emissive: '#ff1010', emissiveIntensity: 1.6 }),
    lightBlue: new THREE.MeshStandardMaterial({ color: '#2a6bff', emissive: '#1040ff', emissiveIntensity: 1.6 }),
    lightOff: new THREE.MeshStandardMaterial({ color: '#552222', roughness: 0.4 }),
    tent: pbrMaterial('ground', { color: '#e9edf0', roughness: 1, side: THREE.DoubleSide }),
    tentBlue: new THREE.MeshStandardMaterial({ color: '#2f63a8', roughness: 0.9, side: THREE.DoubleSide }),
    pool: new THREE.MeshStandardMaterial({ color: '#f2c200', roughness: 0.6 }),
    water: new THREE.MeshStandardMaterial({ color: '#5d7f8f', roughness: 0.08, metalness: 0.2 }),
    barrier: pbrMaterial('concrete', { color: '#d9d3c6', roughness: 1 }),
    cone: new THREE.MeshStandardMaterial({ color: '#ff6a00', roughness: 0.6 }),
    tape: new THREE.MeshStandardMaterial({ color: '#f4d000', roughness: 0.6, side: THREE.DoubleSide }),
    container: [
      pbrMaterial('corrugated_metal', { color: '#2f5d8a', roughness: 1, metalness: 0.15 }),
      pbrMaterial('corrugated_metal', { color: '#3f6b3a', roughness: 1, metalness: 0.15 }),
      pbrMaterial('corrugated_metal', { color: '#b58a3a', roughness: 1, metalness: 0.15 }),
      pbrMaterial('rust', { roughness: 1, metalness: 0.35 }),
    ],
    pipe: pbrMaterial('painted_steel', { color: '#9aa1a8', roughness: 0.8, metalness: 0.6 }),
    pipeYellow: pbrMaterial('painted_steel', { color: '#d9a81e', roughness: 0.8, metalness: 0.4 }),
    steel: pbrMaterial('painted_steel', { color: '#5a6067', roughness: 0.9, metalness: 0.6 }),
  };
}
const mats = () => (M ??= makeMats());

// ------------------------------------------------------------------ vehicles

function Wheels({ xs, track, r = 0.5 }: { xs: number[]; track: number; r?: number }) {
  const { tyre, chrome } = mats();
  return (
    <>
      {xs.map((z) =>
        [1, -1].map((s) => (
          <group key={`${z}${s}`} position={[(s * track) / 2, r, z]} rotation={[0, 0, Math.PI / 2]}>
            <mesh material={tyre} geometry={cylGeo(r, r, 0.38, 18, 1)} castShadow />
            <mesh material={chrome} geometry={cylGeo(r * 0.55, r * 0.55, 0.4, 12, 1)} />
          </group>
        )),
      )}
    </>
  );
}

/** Alternating red/blue light bar (decorative flash, presentation only). */
function LightBar({ y, z, w = 1.6 }: { y: number; z: number; w?: number }) {
  const { lightRed, lightBlue, lightOff } = mats();
  const a = useRef<THREE.Mesh>(null);
  const b = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const on = Math.floor(clock.elapsedTime * 3) % 2 === 0;
    if (a.current) a.current.material = on ? lightRed : lightOff;
    if (b.current) b.current.material = on ? lightOff : lightBlue;
  });
  return (
    <group position={[0, y, z]} userData={{ dynamic: true }}>
      <mesh ref={a} material={lightRed} position={[-w / 4, 0, 0]}>
        <boxGeometry args={[w / 2 - 0.04, 0.14, 0.26]} />
      </mesh>
      <mesh ref={b} material={lightBlue} position={[w / 4, 0, 0]}>
        <boxGeometry args={[w / 2 - 0.04, 0.14, 0.26]} />
      </mesh>
    </group>
  );
}

/** Fire engine ≈ 8.5 × 2.5 × 3.2 m (+z = front). */
function FireEngine() {
  const { fireRed, white, chrome, glass, reflective, steel } = mats();
  const t = tileOf('painted_steel');
  return (
    <ModelOr slot="fire_truck" length={8.5}>
      <group>
        <mesh material={fireRed} geometry={boxGeo(2.5, 2.3, 6.0, t)} position={[0, 2.0, -1.1]} castShadow receiveShadow />
        <mesh material={fireRed} geometry={boxGeo(2.5, 2.1, 2.2, t)} position={[0, 1.9, 3.1]} castShadow receiveShadow />
        <mesh material={glass} position={[0, 2.35, 4.21]}>
          <boxGeometry args={[2.2, 0.85, 0.02]} />
        </mesh>
        {[1, -1].map((s) => (
          <mesh key={s} material={glass} position={[s * 1.26, 2.35, 3.3]}>
            <boxGeometry args={[0.02, 0.75, 1.2]} />
          </mesh>
        ))}
        <mesh material={white} position={[0, 1.1, -1.1]}>
          <boxGeometry args={[2.52, 0.22, 6.02]} />
        </mesh>
        <mesh material={reflective} position={[0, 1.45, -1.1]}>
          <boxGeometry args={[2.53, 0.08, 6.03]} />
        </mesh>
        {/* roll-up locker doors */}
        {[-3.2, -1.6, 0].map((z) =>
          [1, -1].map((s) => (
            <mesh key={`${z}${s}`} material={chrome} position={[s * 1.255, 2.1, z]}>
              <boxGeometry args={[0.02, 1.5, 1.4]} />
            </mesh>
          )),
        )}
        {/* ladder on the roof */}
        {[0.45, -0.45].map((x) => (
          <mesh key={x} material={chrome} position={[x, 3.25, -1.0]}>
            <boxGeometry args={[0.07, 0.07, 6.2]} />
          </mesh>
        ))}
        {Array.from({ length: 13 }, (_, i) => -4 + i * 0.5).map((z) => (
          <mesh key={z} material={chrome} position={[0, 3.25, z]}>
            <boxGeometry args={[0.9, 0.04, 0.05]} />
          </mesh>
        ))}
        <mesh material={steel} position={[0, 0.55, 0]}>
          <boxGeometry args={[2.0, 0.4, 8.2]} />
        </mesh>
        <LightBar y={3.05} z={3.3} w={1.9} />
        <Wheels xs={[3.0, -2.2, -3.4]} track={2.1} r={0.55} />
      </group>
    </ModelOr>
  );
}

/** Ambulance ≈ 6 × 2.2 × 2.7 m (white, red/green side band, generic blue EMS mark). */
function Ambulance() {
  const { white, glass, stripeRed, stripeGreen, steel, emsBlue } = mats();
  const t = tileOf('painted_steel');
  return (
    <ModelOr slot="ambulance" length={6}>
      <group>
        <mesh material={white} geometry={boxGeo(2.2, 2.2, 3.9, t)} position={[0, 1.6, -0.9]} castShadow receiveShadow />
        <mesh material={white} geometry={boxGeo(2.1, 1.5, 1.8, t)} position={[0, 1.25, 1.95]} castShadow receiveShadow />
        <mesh material={glass} position={[0, 1.6, 2.86]} rotation={[-0.25, 0, 0]}>
          <boxGeometry args={[1.9, 0.6, 0.02]} />
        </mesh>
        {[1, -1].map((s) => (
          <group key={s}>
            <mesh material={stripeRed} position={[s * 1.105, 1.35, -0.9]}>
              <boxGeometry args={[0.01, 0.22, 3.9]} />
            </mesh>
            <mesh material={stripeGreen} position={[s * 1.105, 1.12, -0.9]}>
              <boxGeometry args={[0.01, 0.12, 3.9]} />
            </mesh>
            <mesh material={glass} position={[s * 1.06, 1.6, 1.95]}>
              <boxGeometry args={[0.02, 0.55, 1.0]} />
            </mesh>
          </group>
        ))}
        {/* generic six-armed EMS mark on the roof, readable from above (no protected emblem such as the red cross / crescent) */}
        {[0, Math.PI / 3, -Math.PI / 3].map((a) => (
          <mesh key={a} material={emsBlue} position={[0, 2.71, -0.9]} rotation={[0, a, 0]}>
            <boxGeometry args={[0.3, 0.02, 1.25]} />
          </mesh>
        ))}
        <mesh material={steel} position={[0, 0.45, 0]}>
          <boxGeometry args={[1.8, 0.3, 5.6]} />
        </mesh>
        <LightBar y={2.08} z={1.4} w={1.5} />
        <Wheels xs={[1.9, -2.0]} track={1.9} r={0.42} />
      </group>
    </ModelOr>
  );
}

/** CBRN / hazmat response van ≈ 6 × 2.2 × 2.8 m. */
function HazmatVan() {
  const { white, cbrnYellow, glass, steel, chrome } = mats();
  const t = tileOf('painted_steel');
  return (
    <ModelOr slot="hazmat_van" length={6}>
      <group>
        <mesh material={white} geometry={boxGeo(2.2, 2.3, 4.0, t)} position={[0, 1.65, -0.8]} castShadow receiveShadow />
        <mesh material={white} geometry={boxGeo(2.1, 1.5, 1.7, t)} position={[0, 1.25, 2.05]} castShadow receiveShadow />
        {[1, -1].map((s) => (
          <mesh key={s} material={cbrnYellow} position={[s * 1.105, 1.4, -0.8]}>
            <boxGeometry args={[0.01, 0.5, 4.0]} />
          </mesh>
        ))}
        <mesh material={glass} position={[0, 1.6, 2.91]} rotation={[-0.25, 0, 0]}>
          <boxGeometry args={[1.9, 0.6, 0.02]} />
        </mesh>
        {/* roof rack + mast with a weather/CBRN sensor head */}
        <mesh material={chrome} position={[0, 2.86, -0.8]}>
          <boxGeometry args={[1.9, 0.06, 3.4]} />
        </mesh>
        <mesh material={steel} position={[0.6, 3.6, -2.2]}>
          <cylinderGeometry args={[0.05, 0.06, 1.5, 6]} />
        </mesh>
        <mesh material={cbrnYellow} position={[0.6, 4.4, -2.2]}>
          <boxGeometry args={[0.35, 0.25, 0.35]} />
        </mesh>
        <mesh material={steel} position={[0, 0.45, 0]}>
          <boxGeometry args={[1.8, 0.3, 5.6]} />
        </mesh>
        <LightBar y={2.08} z={1.5} w={1.4} />
        <Wheels xs={[1.9, -2.0]} track={1.9} r={0.42} />
      </group>
    </ModelOr>
  );
}

/** Decontamination tent ≈ 6 × 4 × 3 m with a 3-pool decon line in front. */
function DeconLine() {
  const { tent, tentBlue, pool, water, steel } = mats();
  return (
    <group>
      <ModelOr slot="tent" length={6}>
        <group>
          {/* walls */}
          <mesh material={tent} geometry={boxGeo(4, 2.1, 6, 3)} position={[0, 1.05, 0]} castShadow receiveShadow />
          {/* pitched roof (two panels) */}
          {[1, -1].map((s) => (
            <mesh key={s} material={tentBlue} position={[s * 1.05, 2.5, 0]} rotation={[0, 0, s * -0.68]} castShadow>
              <boxGeometry args={[2.6, 0.05, 6.1]} />
            </mesh>
          ))}
          {[-3.05, 3.05].map((z) => (
            <mesh key={z} material={tentBlue} position={[0, 1.0, z]}>
              <boxGeometry args={[1.4, 2.0, 0.04]} />
            </mesh>
          ))}
        </group>
      </ModelOr>
      {/* wash pools leading to the tent */}
      {[5.0, 7.6, 10.2].map((z) => (
        <group key={z} position={[0, 0, z]}>
          <mesh material={pool} position={[0, 0.17, 0]} castShadow>
            <cylinderGeometry args={[1.05, 1.1, 0.34, 20, 1, true]} />
          </mesh>
          <mesh material={water} position={[0, 0.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[1.02, 20]} />
          </mesh>
        </group>
      ))}
      {/* shower frame */}
      {[1.3, -1.3].map((x) => (
        <mesh key={x} material={steel} position={[x, 1.2, 7.6]}>
          <cylinderGeometry args={[0.04, 0.04, 2.4, 6]} />
        </mesh>
      ))}
      <mesh material={steel} position={[0, 2.4, 7.6]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.04, 0.04, 2.6, 6]} />
      </mesh>
    </group>
  );
}

/** Concrete jersey barriers (≈ 3 × 0.6 × 0.8 m) along a line, tape and cones. */
function Cordon({ from, to, cones = true }: { from: [number, number]; to: [number, number]; cones?: boolean }) {
  const { barrier, cone, tape } = mats();
  const L = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const ang = Math.atan2(to[0] - from[0], to[1] - from[1]);
  const n = Math.max(1, Math.floor(L / 3.2));
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-0.3, 0);
    s.lineTo(0.3, 0);
    s.lineTo(0.16, 0.25);
    s.lineTo(0.08, 0.8);
    s.lineTo(-0.08, 0.8);
    s.lineTo(-0.16, 0.25);
    s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: 3, bevelEnabled: false });
  }, []);
  return (
    <group position={[from[0], 0, from[1]]} rotation={[0, ang, 0]}>
      {Array.from({ length: n }, (_, i) => (
        <group key={i} position={[0, 0, i * 3.2 + 1.5]}>
          <ModelOr slot="barrier" length={3}>
            <mesh material={barrier} geometry={shape} position={[0, 0, -1.5]} castShadow receiveShadow />
          </ModelOr>
        </group>
      ))}
      {/* hazard tape on stakes, 1.5 m outside the barrier line */}
      <mesh material={tape} position={[1.6, 0.95, L / 2]}>
        <boxGeometry args={[0.005, 0.07, L]} />
      </mesh>
      {cones &&
        Array.from({ length: Math.floor(L / 4) + 1 }, (_, i) => (
          <mesh key={`c${i}`} material={cone} position={[1.6, 0.35, i * 4]} castShadow>
            <coneGeometry args={[0.18, 0.7, 10]} />
          </mesh>
        ))}
    </group>
  );
}

/** Decorative container yard: single and double stacks (a 5.2 m placement = two containers). */
function ContainerYard({ items }: { items: PropPlacement[] }) {
  const { container } = mats();
  return (
    <group>
      {items.flatMap((p, i) =>
        Array.from({ length: Math.round(p.height / 2.6) }, (_, tier) => (
          <group key={`${p.id}-${tier}`} position={[p.x, tier * 2.6, p.z]} rotation={[0, p.rotY, 0]}>
            <ModelOr slot="container" length={6.06}>
              <mesh material={container[(i + tier * 2) % container.length]} geometry={boxGeo(6.06, 2.59, 2.44, tileOf('corrugated_metal') * 4)} position={[0, 1.3, 0]} castShadow receiveShadow />
            </ModelOr>
          </group>
        )),
      )}
    </group>
  );
}

/** Pipe rack between the tank farm and the warehouse (≤ 4.5 m). */
function PipeRack() {
  const { pipe, pipeYellow, steel } = mats();
  const t = tileOf('painted_steel');
  const z0 = -4;
  const z1 = 4;
  return (
    <group>
      {[z0, (z0 + z1) / 2, z1].map((z) =>
        [-0.9, 0.9].map((x) => (
          <mesh key={`${z}${x}`} material={steel} position={[x, 2.1, z]} castShadow>
            <boxGeometry args={[0.18, 4.2, 0.18]} />
          </mesh>
        )),
      )}
      {[z0, (z0 + z1) / 2, z1].map((z) => (
        <mesh key={`b${z}`} material={steel} position={[0, 4.2, z]}>
          <boxGeometry args={[2.0, 0.16, 0.16]} />
        </mesh>
      ))}
      {[-0.55, 0, 0.55].map((x, i) => (
        <mesh key={`p${x}`} material={i === 1 ? pipeYellow : pipe} geometry={cylGeo(0.16, 0.16, z1 - z0 + 2, 12, t)} position={[x, 4.45, (z0 + z1) / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow />
      ))}
    </group>
  );
}

export function EmergencyResponse({ q }: { q: QualityProfile }) {
  const rich = q.props !== 'low';
  const shown = PROPS.filter((p) => rich || !p.rich);
  return (
    <group>
      {shown
        .filter((p) => p.kind !== 'container' && p.kind !== 'barrier')
        .map((p) => (
          <group key={p.id} position={[p.x, 0, p.z]} rotation={[0, p.rotY, 0]}>
            {p.kind === 'fire_truck' && <FireEngine />}
            {p.kind === 'ambulance' && <Ambulance />}
            {p.kind === 'hazmat_van' && <HazmatVan />}
            {p.kind === 'tent' && <DeconLine />}
            {p.kind === 'pipe_rack' && <PipeRack />}
          </group>
        ))}
      {shown
        .filter((p) => p.kind === 'barrier')
        .map((p) => {
          const dx = Math.sin(p.rotY) * p.hz;
          const dz = Math.cos(p.rotY) * p.hz;
          return <Cordon key={p.id} from={[p.x - dx, p.z - dz]} to={[p.x + dx, p.z + dz]} cones={rich || p.id === 'CORDON-W'} />;
        })}
      <ContainerYard items={shown.filter((p) => p.kind === 'container')} />
    </group>
  );
}
