import { useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { DEFAULT_CONFIG, WORLD } from '../../sim';
import { desertCamoTexture, signTexture, tentCanvasTexture } from './textures';

/**
 * Field ground station / emergency-response base (VISUAL ONLY).
 *
 * - The comms antenna point of the simulation is WORLD.groundStation (+ 8 m):
 *   the command vehicle's mast stands exactly there.
 * - The mother drone's launch / landing pad is config.mission.pad — the same
 *   point the engine takes off from and lands on.
 * - Nothing here is a simulation obstacle. Everything tall is kept > 12 m
 *   from the pad centre and below the 26 m cruise altitude, so the mother's
 *   vertical takeoff / landing column is clear.
 * - Personnel are lightweight low-poly figures: generic desert camouflage
 *   (military) and responder coveralls with hi-vis vests. No flags or insignia.
 */

const camo = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 });
const camoDark = new THREE.MeshStandardMaterial({ color: '#7d6a4a', roughness: 0.9 });
const responder = new THREE.MeshStandardMaterial({ color: '#33415a', roughness: 0.85 });
const hiVis = new THREE.MeshStandardMaterial({ color: '#d8ff2a', roughness: 0.5, emissive: '#2c3600', emissiveIntensity: 0.35 });
const orangeVest = new THREE.MeshStandardMaterial({ color: '#ff7a1a', roughness: 0.5, emissive: '#3a1500', emissiveIntensity: 0.3 });
const skin = new THREE.MeshStandardMaterial({ color: '#9a6a48', roughness: 0.7 });
const boot = new THREE.MeshStandardMaterial({ color: '#4a3b2a', roughness: 0.9 });
const beret = new THREE.MeshStandardMaterial({ color: '#7b1f24', roughness: 0.8 });
const helmetMat = new THREE.MeshStandardMaterial({ color: '#9a8560', roughness: 0.8 });
const capMat = new THREE.MeshStandardMaterial({ color: '#f2f2f0', roughness: 0.6 });

const white = new THREE.MeshStandardMaterial({ color: '#eceee9', roughness: 0.45, metalness: 0.2 });
const tan = new THREE.MeshStandardMaterial({ color: '#b39d72', roughness: 0.85 });
const olive = new THREE.MeshStandardMaterial({ color: '#7b7354', roughness: 0.8 });
const dark = new THREE.MeshStandardMaterial({ color: '#23272c', roughness: 0.6 });
const steel = new THREE.MeshStandardMaterial({ color: '#8f969e', roughness: 0.35, metalness: 0.7 });
const stripe = new THREE.MeshStandardMaterial({ color: '#f2b01e', roughness: 0.5 });
const screen = new THREE.MeshStandardMaterial({ color: '#0e2236', emissive: '#2f8fd8', emissiveIntensity: 0.9, roughness: 0.3 });
const screenRed = new THREE.MeshStandardMaterial({ color: '#2a0d0d', emissive: '#e0582c', emissiveIntensity: 0.9, roughness: 0.3 });
const lamp = new THREE.MeshBasicMaterial({ color: '#fff4c9' });
const sandbag = new THREE.MeshStandardMaterial({ color: '#c4ab7c', roughness: 1 });
const hesco = new THREE.MeshStandardMaterial({ color: '#b59c70', roughness: 0.95 });
const chair = new THREE.MeshStandardMaterial({ color: '#3d4148', roughness: 0.7 });
const sockMat = new THREE.MeshStandardMaterial({ color: '#ff5a1f', roughness: 0.7, side: THREE.DoubleSide });

let camoReady = false;
function ensureCamo() {
  if (camoReady || typeof document === 'undefined') return;
  const t = desertCamoTexture().clone();
  t.repeat.set(2, 2);
  t.needsUpdate = true;
  camo.map = t;
  camo.needsUpdate = true;
  camoReady = true;
}

type Uniform = 'camo' | 'responder' | 'crew';
type Pose = 'stand' | 'sit' | 'walk' | 'point';

/** One low-poly person (≈ 1.75 m). Facing +z. */
function Person({ uniform, pose = 'stand', head = 'beret', phase = 0 }: { uniform: Uniform; pose?: Pose; head?: 'beret' | 'helmet' | 'cap' | 'none'; phase?: number }) {
  ensureCamo();
  const body = uniform === 'camo' ? camo : responder;
  const vest = uniform === 'responder' ? hiVis : uniform === 'crew' ? orangeVest : null;
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase; // decorative motion only
    if (pose === 'walk') {
      const a = Math.sin(t * 3.2) * 0.5;
      if (legL.current) legL.current.rotation.x = a;
      if (legR.current) legR.current.rotation.x = -a;
      if (armL.current) armL.current.rotation.x = -a * 0.7;
    } else if (headRef.current) headRef.current.rotation.y = Math.sin(t * 0.35) * 0.5;
  });
  const sit = pose === 'sit';
  const hip = sit ? 0.5 : 0.92;
  return (
    <group>
      {/* legs */}
      {[
        [-0.11, legL],
        [0.11, legR],
      ].map(([x, ref]) => (
        <group key={x as number} ref={ref as RefObject<THREE.Group>} position={[x as number, hip, 0]} rotation={[sit ? -Math.PI / 2 : 0, 0, 0]}>
          <mesh material={uniform === 'camo' ? camoDark : body} position={[0, -0.42, 0]} castShadow>
            <capsuleGeometry args={[0.075, 0.68, 3, 8]} />
          </mesh>
          <mesh material={boot} position={[0, -0.86, 0.05]}>
            <boxGeometry args={[0.13, 0.1, 0.26]} />
          </mesh>
        </group>
      ))}
      {/* torso */}
      <mesh material={body} position={[0, hip + 0.33, 0]} castShadow>
        <capsuleGeometry args={[0.17, 0.36, 3, 10]} />
      </mesh>
      {vest && (
        <mesh material={vest} position={[0, hip + 0.36, 0]}>
          <cylinderGeometry args={[0.185, 0.18, 0.42, 10]} />
        </mesh>
      )}
      {/* arms */}
      <group ref={armL} position={[-0.23, hip + 0.55, 0]} rotation={[sit ? -0.9 : 0, 0, 0.08]}>
        <mesh material={body} position={[0, -0.27, 0]} castShadow>
          <capsuleGeometry args={[0.055, 0.46, 3, 8]} />
        </mesh>
      </group>
      <group position={[0.23, hip + 0.55, 0]} rotation={[pose === 'point' ? -1.45 : sit ? -0.9 : 0, 0, pose === 'point' ? -0.25 : -0.08]}>
        <mesh material={body} position={[0, -0.27, 0]} castShadow>
          <capsuleGeometry args={[0.055, 0.46, 3, 8]} />
        </mesh>
      </group>
      {/* head + headgear */}
      <group ref={headRef} position={[0, hip + 0.78, 0]}>
        <mesh material={skin} castShadow>
          <sphereGeometry args={[0.11, 12, 10]} />
        </mesh>
        {head === 'beret' && (
          <mesh material={beret} position={[0.02, 0.08, -0.01]} rotation={[0, 0, -0.25]} scale={[1, 0.35, 1]}>
            <sphereGeometry args={[0.13, 12, 8]} />
          </mesh>
        )}
        {head === 'helmet' && (
          <mesh material={helmetMat} position={[0, 0.03, 0]}>
            <sphereGeometry args={[0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
          </mesh>
        )}
        {head === 'cap' && (
          <mesh material={capMat} position={[0, 0.06, 0]} scale={[1, 0.5, 1]}>
            <sphereGeometry args={[0.12, 12, 8]} />
          </mesh>
        )}
      </group>
    </group>
  );
}

/** A person walking back and forth along a straight path (decorative). */
function Patrol({ from, to, uniform, period = 26, phase = 0 }: { from: [number, number]; to: [number, number]; uniform: Uniform; period?: number; phase?: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!g.current) return;
    const t = ((clock.elapsedTime + phase) % period) / period;
    const f = t < 0.5 ? t * 2 : 2 - t * 2;
    g.current.position.set(from[0] + (to[0] - from[0]) * f, 0, from[1] + (to[1] - from[1]) * f);
    const dir = t < 0.5 ? 1 : -1;
    g.current.rotation.y = Math.atan2((to[0] - from[0]) * dir, (to[1] - from[1]) * dir);
  });
  return (
    <group ref={g} userData={{ dynamic: true }}>
      <Person uniform={uniform} pose="walk" head="helmet" phase={phase} />
    </group>
  );
}

function CommandTent() {
  const cloth = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, side: THREE.DoubleSide });
    if (typeof document !== 'undefined') {
      const t = tentCanvasTexture().clone();
      t.repeat.set(3, 1);
      t.needsUpdate = true;
      m.map = t;
    }
    return m;
  }, []);
  const W = 9;
  const D = 6;
  const wallH = 2.2;
  const rise = 1.3;
  const slope = Math.atan2(rise, D / 2);
  const panel = Math.hypot(D / 2, rise);
  return (
    <group>
      {/* roof (two slopes) */}
      {[-1, 1].map((s) => (
        <mesh key={s} material={cloth} position={[0, wallH + rise / 2, (s * D) / 4]} rotation={[s * slope, 0, 0]} castShadow receiveShadow>
          <boxGeometry args={[W + 0.4, 0.05, panel + 0.2]} />
        </mesh>
      ))}
      {/* back + side walls; front (+z) open toward the pad */}
      <mesh material={cloth} position={[0, wallH / 2, -D / 2]} castShadow>
        <boxGeometry args={[W, wallH, 0.05]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} material={cloth} position={[(s * W) / 2, wallH / 2, 0]} castShadow>
          <boxGeometry args={[0.05, wallH, D]} />
        </mesh>
      ))}
      {/* front awning poles */}
      {[-W / 2, 0, W / 2].map((x) => (
        <mesh key={x} material={dark} position={[x, wallH / 2, D / 2]}>
          <cylinderGeometry args={[0.04, 0.04, wallH, 6]} />
        </mesh>
      ))}
      {/* floor mat */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial color="#5f5a4e" roughness={1} />
      </mesh>
      {/* operator consoles along the back wall */}
      {[-2.8, 0, 2.8].map((x, i) => (
        <group key={x} position={[x, 0, -1.9]}>
          <mesh material={olive} position={[0, 0.74, 0]} castShadow>
            <boxGeometry args={[2.2, 0.06, 0.9]} />
          </mesh>
          {[-0.95, 0.95].map((lx) => (
            <mesh key={lx} material={dark} position={[lx, 0.37, 0]}>
              <boxGeometry args={[0.05, 0.74, 0.8]} />
            </mesh>
          ))}
          {[-0.5, 0.5].map((sx, k) => (
            <mesh key={sx} material={i === 1 && k === 0 ? screenRed : screen} position={[sx, 1.08, -0.25]} rotation={[-0.12, 0, 0]}>
              <boxGeometry args={[0.85, 0.5, 0.04]} />
            </mesh>
          ))}
          <mesh material={dark} position={[0, 0.79, 0.2]}>
            <boxGeometry args={[0.5, 0.03, 0.2]} />
          </mesh>
          <mesh material={chair} position={[0, 0.45, 0.85]}>
            <boxGeometry args={[0.5, 0.06, 0.5]} />
          </mesh>
          <group position={[0, 0, 0.82]} rotation={[0, Math.PI, 0]}>
            <Person uniform={i === 2 ? 'responder' : 'camo'} pose="sit" head={i === 2 ? 'cap' : 'none'} phase={i * 3.1} />
          </group>
        </group>
      ))}
      {/* large wall display */}
      <mesh material={screen} position={[0, 1.75, -2.95]}>
        <boxGeometry args={[3.2, 0.9, 0.04]} />
      </mesh>
      {/* map table in the middle */}
      <mesh material={olive} position={[0, 0.85, 0.8]} castShadow>
        <boxGeometry args={[2.0, 0.06, 1.2]} />
      </mesh>
      <mesh position={[0, 0.89, 0.8]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.8, 1.0]} />
        <meshStandardMaterial color="#d8c99d" emissive="#3a3018" emissiveIntensity={0.2} />
      </mesh>
      <group position={[1.4, 0, 1.0]} rotation={[0, -1.9, 0]}>
        <Person uniform="camo" pose="point" head="beret" phase={1.7} />
      </group>
      <mesh position={[0, wallH - 0.3, D / 2 + 0.03]}>
        <planeGeometry args={[2.8, 0.55]} />
        <meshStandardMaterial map={signTexture('COMMAND', '#2b3a24', '#e8e4d0')} />
      </mesh>
    </group>
  );
}

function CommandVehicle() {
  return (
    <group>
      <mesh material={white} position={[0, 1.55, -0.6]} castShadow receiveShadow>
        <boxGeometry args={[2.3, 2.2, 4.2]} />
      </mesh>
      <mesh material={white} position={[0, 1.2, 2.2]} castShadow>
        <boxGeometry args={[2.2, 1.6, 1.5]} />
      </mesh>
      <mesh material={dark} position={[0, 1.55, 2.96]}>
        <boxGeometry args={[1.9, 0.6, 0.02]} />
      </mesh>
      <mesh material={stripe} position={[0, 1.2, -0.6]}>
        <boxGeometry args={[2.32, 0.18, 4.22]} />
      </mesh>
      <mesh material={dark} position={[0, 2.68, -0.6]} castShadow>
        <boxGeometry args={[1.6, 0.06, 3.2]} />
      </mesh>
      {[
        [1.05, 2.2],
        [-1.05, 2.2],
        [1.05, -1.5],
        [-1.05, -1.5],
      ].map(([x, z], i) => (
        <mesh key={i} material={dark} position={[x, 0.42, z]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.42, 0.42, 0.3, 16]} />
        </mesh>
      ))}
    </group>
  );
}

function MilitaryTruck() {
  return (
    <group>
      <mesh material={tan} position={[0, 1.35, -0.9]} castShadow receiveShadow>
        <boxGeometry args={[2.4, 1.9, 4.6]} />
      </mesh>
      <mesh material={tan} position={[0, 1.15, 2.2]} castShadow>
        <boxGeometry args={[2.3, 1.5, 1.8]} />
      </mesh>
      <mesh material={dark} position={[0, 1.45, 3.11]}>
        <boxGeometry args={[2.0, 0.55, 0.02]} />
      </mesh>
      {[2.3, 0.2, -2.2].map((z) =>
        [1.1, -1.1].map((x) => (
          <mesh key={`${x}${z}`} material={dark} position={[x, 0.5, z]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.5, 0.5, 0.35, 16]} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Lattice-style mast with dish + whips (on the command vehicle position = comms antenna point). */
function Mast({ h = 8 }: { h?: number }) {
  return (
    <group>
      <mesh material={steel} position={[0, h / 2, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.14, h, 8]} />
      </mesh>
      {[0.25, 0.5, 0.75].map((f) => (
        <mesh key={f} material={steel} position={[0, h * f, 0]}>
          <torusGeometry args={[0.22, 0.02, 4, 12]} />
        </mesh>
      ))}
      <mesh material={white} position={[0, h + 0.4, 0.25]} rotation={[-1.1, 0, 0]} castShadow>
        <sphereGeometry args={[0.65, 20, 10, 0, Math.PI * 2, 0, 0.9]} />
      </mesh>
      {[-0.35, 0.35].map((x) => (
        <mesh key={x} material={dark} position={[x, h + 1.1, -0.1]}>
          <cylinderGeometry args={[0.012, 0.012, 2.0, 5]} />
        </mesh>
      ))}
      <mesh material={lamp} position={[0, h + 2.15, -0.1]}>
        <sphereGeometry args={[0.07, 8, 8]} />
      </mesh>
    </group>
  );
}

function SatDish() {
  return (
    <group>
      {[0, 2.1, 4.2].map((a) => (
        <mesh key={a} material={dark} position={[Math.sin(a) * 0.5, 0.55, Math.cos(a) * 0.5]} rotation={[Math.cos(a) * 0.4, 0, -Math.sin(a) * 0.4]}>
          <cylinderGeometry args={[0.03, 0.03, 1.2, 5]} />
        </mesh>
      ))}
      <mesh material={white} position={[0, 1.4, 0]} rotation={[-0.9, 0, 0]} castShadow>
        <sphereGeometry args={[1.1, 24, 10, 0, Math.PI * 2, 0, 0.75]} />
      </mesh>
    </group>
  );
}

function Windsock() {
  const sock = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (sock.current) sock.current.rotation.y = -0.9 + Math.sin(clock.elapsedTime * 0.7) * 0.15; // decorative
  });
  return (
    <group userData={{ dynamic: true }}>
      <mesh material={steel} position={[0, 2.5, 0]}>
        <cylinderGeometry args={[0.04, 0.05, 5, 6]} />
      </mesh>
      <mesh ref={sock} material={sockMat} position={[0, 4.8, 0]} rotation={[0, 0, Math.PI / 2]}>
        <coneGeometry args={[0.28, 1.4, 10, 1, true]} />
      </mesh>
    </group>
  );
}

function FloodLight() {
  return (
    <group>
      <mesh material={dark} position={[0, 2.6, 0]}>
        <cylinderGeometry args={[0.06, 0.09, 5.2, 6]} />
      </mesh>
      <mesh material={dark} position={[0, 5.2, 0]}>
        <boxGeometry args={[1.0, 0.5, 0.25]} />
      </mesh>
      {[-0.25, 0.25].map((x) => (
        <mesh key={x} material={lamp} position={[x, 5.2, 0.13]}>
          <boxGeometry args={[0.36, 0.3, 0.02]} />
        </mesh>
      ))}
      <mesh material={olive} position={[0, 0.4, 0]} castShadow>
        <boxGeometry args={[1.2, 0.8, 0.9]} />
      </mesh>
    </group>
  );
}

/** A curved row of sandbags (half-capsules). */
function SandbagWall({ r, a0, a1, n }: { r: number; a0: number; a1: number; n: number }) {
  const items = useMemo(() => Array.from({ length: n }, (_, i) => a0 + ((a1 - a0) * i) / (n - 1)), [a0, a1, n]);
  return (
    <group>
      {items.map((a, i) =>
        [0, 1].map((row) => (
          <mesh key={`${i}${row}`} material={sandbag} position={[Math.cos(a) * r, 0.18 + row * 0.3, Math.sin(a) * r]} rotation={[0, -a, Math.PI / 2]} castShadow>
            <capsuleGeometry args={[0.16, 0.5, 3, 8]} />
          </mesh>
        )),
      )}
    </group>
  );
}

function Hesco({ n }: { n: number }) {
  return (
    <group>
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} material={hesco} position={[i * 1.12, 0.55, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.05, 1.1, 1.05]} />
        </mesh>
      ))}
    </group>
  );
}

function SupplyStack() {
  return (
    <group>
      {[
        [0, 0, 0],
        [1.1, 0, 0.1],
        [0.5, 0.62, 0.05],
      ].map(([x, y, z], i) => (
        <mesh key={i} material={olive} position={[x, 0.3 + y, z]} castShadow>
          <boxGeometry args={[1.0, 0.6, 0.7]} />
        </mesh>
      ))}
      {[0, 0.45, 0.9].map((x) => (
        <mesh key={x} material={i0} position={[2.2 + x, 0.4, 0]} castShadow>
          <cylinderGeometry args={[0.2, 0.2, 0.8, 10]} />
        </mesh>
      ))}
    </group>
  );
}
const i0 = new THREE.MeshStandardMaterial({ color: '#5b6b3a', roughness: 0.7 });

function Generator() {
  return (
    <group>
      <mesh material={olive} position={[0, 0.7, 0]} castShadow>
        <boxGeometry args={[2.2, 1.4, 1.2]} />
      </mesh>
      <mesh material={dark} position={[0.8, 1.6, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 0.5, 8]} />
      </mesh>
      <mesh material={dark} position={[-1.1, 0.7, 0]}>
        <boxGeometry args={[0.04, 0.9, 0.8]} />
      </mesh>
    </group>
  );
}

export function GroundBase({ detail = 'balanced' }: { detail?: 'balanced' | 'performance' }) {
  // (Stage 4: Patrol / Windsock groups are tagged userData.dynamic — excluded from the static shadow map)
  const gs = WORLD.groundStation.position;
  const pad = DEFAULT_CONFIG.mission.pad;
  const many = detail === 'balanced';
  return (
    <group>
      {/* landing / launch position of the mother drone (pad surface removed in the deployment copy at the team's request — visual only) */}
      <group position={[pad.x, 0, pad.z]}>
        {/* ground crew at the pad edge */}
        <group position={[-9.5, 0, 2]} rotation={[0, Math.PI / 2, 0]}>
          <Person uniform="crew" pose="point" head="helmet" phase={0.4} />
        </group>
        <group position={[-9.2, 0, -2.2]} rotation={[0, Math.PI / 2 + 0.3, 0]}>
          <Person uniform="crew" head="helmet" phase={2.2} />
        </group>
        <group position={[10.5, 0, -6]} rotation={[0, -2.2, 0]}>
          <Windsock />
        </group>
      </group>

      {/* command vehicle with the comms mast exactly at the GS antenna point */}
      <group position={[gs.x, 0, gs.z]} rotation={[0, -0.72, 0]}>
        <group position={[0, 0, 1.2]}>
          <CommandVehicle />
        </group>
        <Mast h={8} />
        <group position={[2.6, 0, 3.4]} rotation={[0, 2.4, 0]}>
          <Person uniform="responder" head="cap" phase={4.2} />
        </group>
      </group>

      {/* command tent, open toward the pad */}
      <group position={[gs.x - 10, 0, gs.z + 9]} rotation={[0, 0.85, 0]}>
        <CommandTent />
      </group>

      {/* satellite terminal, generator, supplies */}
      <group position={[gs.x - 3, 0, gs.z - 7]}>
        <SatDish />
      </group>
      <group position={[gs.x - 17, 0, gs.z + 1]} rotation={[0, 0.85, 0]}>
        <Generator />
      </group>
      <group position={[gs.x - 6, 0, gs.z + 18]} rotation={[0, 0.3, 0]}>
        <SupplyStack />
      </group>
      <group position={[gs.x - 18, 0, gs.z - 6]} rotation={[0, 0.6, 0]}>
        <MilitaryTruck />
      </group>
      {many && (
        <group position={[gs.x - 24, 0, gs.z + 14]} rotation={[0, 1.4, 0]}>
          <MilitaryTruck />
        </group>
      )}

      {/* perimeter: HESCO line + sandbag position + floodlights */}
      <group position={[gs.x - 26, 0, gs.z - 12]} rotation={[0, 0.85, 0]}>
        <Hesco n={many ? 14 : 8} />
      </group>
      <group position={[gs.x - 22, 0, gs.z + 26]}>
        <SandbagWall r={3} a0={-2.6} a1={-0.4} n={9} />
        <group position={[0, 0, -1.4]} rotation={[0, Math.PI, 0]}>
          <Person uniform="camo" head="helmet" phase={5.5} />
        </group>
      </group>
      <group position={[gs.x - 4, 0, gs.z + 28]} rotation={[0, 0.3, 0]}>
        <FloodLight />
      </group>
      <group position={[pad.x + 12, 0, pad.z + 6]} rotation={[0, -0.8, 0]}>
        <FloodLight />
      </group>

      {/* guards / responders on foot */}
      <Patrol from={[gs.x - 22, gs.z - 4]} to={[gs.x - 8, gs.z - 16]} uniform="camo" phase={0} />
      {many && <Patrol from={[gs.x - 2, gs.z + 24]} to={[pad.x - 12, pad.z + 8]} uniform="responder" period={34} phase={7} />}
      <group position={[gs.x - 1, 0, gs.z + 6]} rotation={[0, 0.9, 0]}>
        <Person uniform="camo" head="beret" phase={3.3} />
      </group>
    </group>
  );
}
