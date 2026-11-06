import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simController } from '../../state/simController';
import type { BoxObstacle, CylinderObstacle, Obstacle } from '../../sim';
import { gravelRoofTexture, signTexture, tankTopTexture, trefoilTexture } from './textures';
import type { QualityProfile } from '../quality';
import { pbrMaterial, tileOf } from '../pbr/library';
import { boxGeo, cylGeo } from '../pbr/uv';

/**
 * Industrial facility. Every structure here is generated from WORLD.obstacles —
 * the same footprints and heights the simulation collides against — so what
 * you see is what the bees avoid. Details stay inside each footprint/height
 * (a few centimetres of trim excepted).
 */

/**
 * Stage 4 PBR materials (CC0 asset or procedural fallback per slot; see pbr/library.ts). Created lazily
 * (canvas textures need the DOM) and shared. Geometry uses world-scale UVs (pbr/uv.ts).
 */
let M: ReturnType<typeof makeMats> | null = null;
function makeMats() {
  return {
    wall: pbrMaterial('corrugated_metal', { color: '#f2f1ee', roughness: 1, metalness: 0.2, normalScale: 1.6, antiTile: 'v' }),
    wallGable: pbrMaterial('corrugated_metal', { color: '#f2f1ee', roughness: 1, metalness: 0.2, normalScale: 1.6, side: THREE.DoubleSide, antiTile: 'v' }),
    wallDark: pbrMaterial('painted_steel', { color: '#8d877c', roughness: 1, metalness: 0.3 }),
    roof: pbrMaterial('corrugated_metal', { color: '#dfe3e6', roughness: 0.9, metalness: 0.45, side: THREE.DoubleSide, antiTile: 'v' }),
    concreteWall: pbrMaterial('concrete', { color: '#f2ede4', roughness: 1, antiTile: 'uv' }),
    concrete: pbrMaterial('concrete', { color: '#c4bbae', roughness: 1, antiTile: 'uv' }),
    tankWhite: pbrMaterial('painted_steel', { color: '#f2f1ec', roughness: 1, metalness: 0.35 }),
    steelDark: pbrMaterial('painted_steel', { color: '#5a6067', roughness: 0.9, metalness: 0.6 }),
    red: pbrMaterial('painted_steel', { color: '#b3261e', roughness: 1, metalness: 0.2 }),
    container: pbrMaterial('corrugated_metal', { color: '#b8492f', roughness: 1, metalness: 0.15 }),
    rust: pbrMaterial('rust', { roughness: 1, metalness: 0.4 }),
    burnt: pbrMaterial('rust', { color: '#4b3f38', roughness: 1, metalness: 0.2 }),
    truckPaint: pbrMaterial('painted_steel', { color: '#ddd8cc', roughness: 1, metalness: 0.3 }),
    barrel: pbrMaterial('painted_steel', { color: '#2f5d8a', roughness: 1, metalness: 0.4 }),
    rubble: pbrMaterial('concrete', { color: '#a49a8b', roughness: 1, normalScale: 1.6 }),
  };
}
const mats = () => (M ??= makeMats());
const scorch = new THREE.MeshStandardMaterial({ color: '#1c1a18', roughness: 1 });
const glass = new THREE.MeshStandardMaterial({ color: '#28435c', roughness: 0.12, metalness: 0.8, envMapIntensity: 1.4 });

function hash(n: number): number {
  const s = Math.sin(n * 91.7) * 15731.123;
  return s - Math.floor(s);
}

function Warehouse({ o }: { o: BoxObstacle }) {
  const { wall, wallGable, wallDark, roof, steelDark } = mats();
  // industrial wall/roof cladding profile ≈ 15 cm pitch = 2 × the roofing-iron scan's 7 cm (tile 1.12 m)
  const tw = tileOf('corrugated_metal') * 2;
  const wallH = o.height - 2;
  const roofRise = 2;
  const halfW = o.hz; // roof slopes across z
  const slope = Math.atan2(roofRise, halfW);
  const panelLen = Math.hypot(halfW, roofRise);
  return (
    <group position={[o.cx, 0, o.cz]}>
      <mesh material={wall} geometry={boxGeo(o.hx * 2, wallH, o.hz * 2, tw)} position={[0, wallH / 2, 0]} castShadow receiveShadow />
      {/* gable ends */}
      {[1, -1].map((s) => (
        <mesh key={s} material={wallGable} position={[s * (o.hx - 0.05), wallH, 0]} rotation={[0, s * Math.PI / 2, 0]} castShadow>
          <shapeGeometry args={[new THREE.Shape([new THREE.Vector2(-halfW, 0), new THREE.Vector2(halfW, 0), new THREE.Vector2(0, roofRise)])]} />
        </mesh>
      ))}
      {/* roof: intact north slope, damaged south slope (one panel missing) */}
      <mesh material={roof} geometry={boxGeo(o.hx * 2, 0.15, panelLen, tw)} position={[0, wallH + roofRise / 2, -halfW / 2]} rotation={[-slope, 0, 0]} castShadow receiveShadow />
      <mesh material={roof} geometry={boxGeo(o.hx * 1.4, 0.15, panelLen, tw)} position={[-o.hx * 0.3, wallH + roofRise / 2, halfW / 2]} rotation={[slope, 0, 0]} castShadow receiveShadow />
      {/* skylights + roof vents (inside the footprint, below the obstacle height) */}
      {[-0.7, -0.35, 0, 0.35].map((f) => (
        <mesh key={`sky${f}`} material={glass} position={[o.hx * f, wallH + roofRise * 0.55, -halfW * 0.45]} rotation={[-slope, 0, 0]}>
          <boxGeometry args={[1.6, 0.18, 3.2]} />
        </mesh>
      ))}
      {[-0.55, -0.15].map((f) => (
        <mesh key={`vent${f}`} material={steelDark} position={[o.hx * f, wallH + roofRise + 0.25, 0]} castShadow>
          <cylinderGeometry args={[0.35, 0.45, 0.6, 10]} />
        </mesh>
      ))}
      {/* collapsed roof panels lying on the floor of the burnt bay */}
      {[0.55, 0.78].map((f, i) => (
        <mesh key={`fall${f}`} material={roof} geometry={boxGeo(o.hx * 0.35, 0.12, panelLen * 0.6, tw)} position={[o.hx * f, 0.6 + i * 0.5, o.hz * (0.2 - i * 0.5)]} rotation={[0.25 + i * 0.3, 0.2 * i, 0.18 - i * 0.4]} castShadow />
      ))}
      {/* exposed interior where the roof panel is gone */}
      <mesh material={scorch} position={[o.hx * 0.7, wallH - 0.05, 0]}>
        <boxGeometry args={[o.hx * 0.58, 0.1, o.hz * 1.9]} />
      </mesh>
      {/* scorched wall section + roller doors + sign */}
      <mesh material={scorch} position={[o.hx * 0.7, wallH * 0.6, o.hz + 0.02]}>
        <planeGeometry args={[o.hx * 0.55, wallH * 0.8]} />
      </mesh>
      {[-0.55, -0.1].map((f) => (
        <mesh key={f} material={wallDark} position={[o.hx * f, 2.6, o.hz + 0.03]}>
          <planeGeometry args={[4.5, 5.2]} />
        </mesh>
      ))}
      <mesh position={[o.hx * 0.25, wallH - 1.6, o.hz + 0.03]}>
        <planeGeometry args={[5, 1.9]} />
        <meshStandardMaterial map={signTexture('BLDG-A')} />
      </mesh>
    </group>
  );
}

function ControlBuilding({ o }: { o: BoxObstacle }) {
  const { concreteWall, steelDark } = mats();
  const bodyH = o.height - 0.9;
  return (
    <group position={[o.cx, 0, o.cz]}>
      <mesh material={concreteWall} geometry={boxGeo(o.hx * 2, bodyH, o.hz * 2, tileOf('concrete'))} position={[0, bodyH / 2, 0]} castShadow receiveShadow />
      {[2.2, 5.6].map((y) =>
        [1, -1].map((s) => (
          <mesh key={`${y}${s}`} material={glass} position={[0, y, s * (o.hz + 0.02)]}>
            <boxGeometry args={[o.hx * 1.7, 1.2, 0.04]} />
          </mesh>
        )),
      )}
      {/* gravel roof deck */}
      <mesh position={[0, bodyH + 0.011, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[o.hx * 2, o.hz * 2]} />
        <meshStandardMaterial map={gravelRoofTexture()} roughness={0.95} />
      </mesh>
      {/* rooftop units (inside footprint, up to obstacle height) */}
      <mesh material={steelDark} position={[-o.hx * 0.4, bodyH + 0.45, 0]} castShadow>
        <boxGeometry args={[2.6, 0.9, 2]} />
      </mesh>
      <mesh material={steelDark} position={[o.hx * 0.45, bodyH + 0.35, -o.hz * 0.3]} castShadow>
        <boxGeometry args={[1.8, 0.7, 1.6]} />
      </mesh>
      <mesh position={[0, bodyH - 0.9, o.hz + 0.04]}>
        <planeGeometry args={[4.4, 1.3]} />
        <meshStandardMaterial map={signTexture('CONTROL')} />
      </mesh>
    </group>
  );
}

/** Hemisphere with planar (top-view) UVs so the roof texture reads correctly from above. */
function domeGeometry(r: number): THREE.SphereGeometry {
  const g = new THREE.SphereGeometry(r, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) / r + 1) / 2, (p.getZ(i) / r + 1) / 2);
  uv.needsUpdate = true;
  return g;
}

function Tank({ o }: { o: CylinderObstacle }) {
  const { tankWhite, steelDark } = mats();
  const domeH = o.radius * 0.25;
  const bodyH = o.height - domeH;
  const dome = useMemo(() => domeGeometry(o.radius), [o.radius]);
  return (
    <group position={[o.cx, 0, o.cz]}>
      <mesh material={tankWhite} geometry={cylGeo(o.radius, o.radius, bodyH, 48, tileOf('painted_steel'), true)} position={[0, bodyH / 2, 0]} castShadow receiveShadow />
      <mesh geometry={dome} position={[0, bodyH, 0]} scale={[1, domeH / o.radius, 1]} castShadow>
        <meshStandardMaterial map={tankTopTexture()} roughness={0.55} metalness={0.35} />
      </mesh>
      {[0.3, 0.62].map((f) => (
        <mesh key={f} material={steelDark} position={[0, bodyH * f, 0]}>
          <cylinderGeometry args={[o.radius + 0.04, o.radius + 0.04, 0.25, 40]} />
        </mesh>
      ))}
      {/* ladder */}
      <mesh material={steelDark} position={[o.radius + 0.08, bodyH / 2, 0]}>
        <boxGeometry args={[0.08, bodyH, 0.5]} />
      </mesh>
      <mesh position={[0, bodyH * 0.45, o.radius + 0.06]}>
        <planeGeometry args={[3.2, 1.2]} />
        <meshStandardMaterial map={signTexture(o.id.replace('OBS-', ''), '#f5f5f0', '#7a1d16')} />
      </mesh>
    </group>
  );
}

function Stack({ o }: { o: CylinderObstacle }) {
  const { concrete, red } = mats();
  const beacon = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (beacon.current) beacon.current.visible = clock.elapsedTime % 1.5 < 0.75; // decorative
  });
  return (
    <group position={[o.cx, 0, o.cz]}>
      <mesh material={concrete} geometry={cylGeo(o.radius * 0.8, o.radius, o.height, 32, tileOf('concrete'))} position={[0, o.height / 2, 0]} castShadow receiveShadow />
      {[0.82, 0.92].map((f) => (
        <mesh key={f} material={red} position={[0, o.height * f, 0]}>
          <cylinderGeometry args={[o.radius * 0.83, o.radius * 0.84, o.height * 0.045, 28]} />
        </mesh>
      ))}
      <mesh ref={beacon} position={[0, o.height + 0.2, 0]}>
        <sphereGeometry args={[0.3, 10, 10]} />
        <meshBasicMaterial color="#ff2a2a" />
      </mesh>
    </group>
  );
}

function Container({ o }: { o: BoxObstacle }) {
  const { container: containerMat } = mats();
  return (
    <group position={[o.cx, 0, o.cz]}>
      <mesh material={containerMat} geometry={boxGeo(o.hx * 2, o.height, o.hz * 2, tileOf('corrugated_metal') * 4)} position={[0, o.height / 2, 0]} castShadow receiveShadow />
      {Array.from({ length: 9 }, (_, i) => -o.hx + 0.3 + (i * (o.hx * 2 - 0.6)) / 8).map((x) =>
        [1, -1].map((s) => (
          <mesh key={`${x}${s}`} material={containerMat} position={[x, o.height / 2, s * (o.hz + 0.03)]}>
            <boxGeometry args={[0.12, o.height * 0.92, 0.06]} />
          </mesh>
        )),
      )}
      {/* breach: dark gash on the source side */}
      <mesh material={scorch} position={[0.6, o.height * 0.45, -o.hz - 0.035]}>
        <planeGeometry args={[1.4, 0.9]} />
      </mesh>
      <mesh position={[-1.4, o.height * 0.55, -o.hz - 0.04]}>
        <planeGeometry args={[0.9, 0.9]} />
        <meshStandardMaterial map={trefoilTexture()} />
      </mesh>
    </group>
  );
}

function Debris({ o }: { o: Obstacle }) {
  const { concrete, rust } = mats();
  const pieces = useMemo(() => {
    const seed = o.id.length * 13 + Math.round(o.cx * 7 + o.cz * 3);
    const r = o.shape === 'cylinder' ? o.radius : Math.min(o.hx, o.hz);
    return Array.from({ length: 14 }, (_, i) => {
      const a = hash(seed + i) * Math.PI * 2;
      const d = Math.sqrt(hash(seed + i * 3.3)) * r * 0.75;
      const s = 0.5 + hash(seed + i * 7.7) * 1.2;
      const h = Math.min(o.height * (0.4 + hash(seed + i * 1.9) * 0.6), o.height);
      return { x: Math.cos(a) * d, z: Math.sin(a) * d, s, h, rot: hash(seed + i * 5.1) * 3 };
    });
  }, [o]);
  return (
    <group position={[o.cx, 0, o.cz]}>
      {pieces.map((p, i) => (
        <mesh key={i} material={i % 4 === 0 ? rust : concrete} geometry={boxGeo(p.s, p.h, p.s * 0.8, 2)} position={[p.x, p.h / 2, p.z]} rotation={[p.rot * 0.2, p.rot, p.rot * 0.15]} castShadow receiveShadow />
      ))}
    </group>
  );
}

export function Facility({ q }: { q: QualityProfile }) {
  void q;
  return (
    <group>
      {/* apron, roads, stains: painted on the SiteGround decal (flat, visual only) */}
      {simController.engine.world.obstacles.map((o) => {
        switch (o.kind) {
          case 'warehouse':
            return o.shape === 'box' ? <Warehouse key={o.id} o={o} /> : null;
          case 'control-building':
            return o.shape === 'box' ? <ControlBuilding key={o.id} o={o} /> : null;
          case 'tank':
            return o.shape === 'cylinder' ? <Tank key={o.id} o={o} /> : null;
          case 'stack':
            return o.shape === 'cylinder' ? <Stack key={o.id} o={o} /> : null;
          case 'container':
            return o.shape === 'box' ? <Container key={o.id} o={o} /> : null;
          case 'debris':
            return <Debris key={o.id} o={o} />;
          default:
            return null;
        }
      })}
      <Fence />
      <YardProps />
    </group>
  );
}


/**
 * Low decorative props in the yard (all ≤ 2 m, away from the flight lanes'
 * low passes and the evacuation corridors). NOT obstacles in the simulation.
 */
function YardProps() {
  const { burnt, truckPaint, barrel: barrelMat, rubble: rubbleMat } = mats();
  const rubble = useMemo(() => {
    const out: { x: number; z: number; s: number; r: number; h: number }[] = [];
    for (let i = 0; i < 70; i++) {
      const a = hash(i * 1.3 + 2) * Math.PI * 2;
      const d = 2 + hash(i * 2.1 + 5) * 9;
      out.push({ x: 27 + d * Math.cos(a) * 0.7, z: -10 + d * Math.sin(a), s: 0.25 + hash(i + 9) * 0.7, r: hash(i * 3.7) * 3, h: 0.15 + hash(i * 5.3) * 0.45 });
    }
    return out;
  }, []);
  return (
    <group>
      {/* burnt-out car and a service truck by the warehouse */}
      <group position={[16, 0, 4]} rotation={[0, 0.5, 0]}>
        <mesh material={burnt} position={[0, 0.55, 0]} castShadow>
          <boxGeometry args={[1.8, 0.8, 4.2]} />
        </mesh>
        <mesh material={burnt} position={[0, 1.15, -0.2]} castShadow>
          <boxGeometry args={[1.6, 0.5, 2]} />
        </mesh>
      </group>
      <group position={[-4, 0, -34]} rotation={[0, -0.2, 0]}>
        <mesh material={truckPaint} position={[0, 1.0, -1.2]} castShadow>
          <boxGeometry args={[2.3, 1.6, 4.6]} />
        </mesh>
        <mesh material={truckPaint} position={[0, 0.9, 2.1]} castShadow>
          <boxGeometry args={[2.2, 1.4, 1.8]} />
        </mesh>
        <mesh material={glass} position={[0, 1.2, 3.01]}>
          <boxGeometry args={[1.9, 0.5, 0.02]} />
        </mesh>
      </group>
      {/* drums near the breached container */}
      {[
        [22.5, 26.5],
        [23.4, 26.9],
        [22.9, 27.8],
        [14.2, 25.6],
      ].map(([x, z], i) => (
        <mesh key={i} material={i === 3 ? burnt : barrelMat} position={[x, 0.45, z]} rotation={i === 3 ? [Math.PI / 2, 0, 0.6] : [0, 0, 0]} castShadow>
          <cylinderGeometry args={[0.3, 0.3, 0.9, 12]} />
        </mesh>
      ))}
      {/* rubble field east of the damaged warehouse */}
      <instancedMesh
        ref={(m: THREE.InstancedMesh | null) => {
          if (!m) return;
          const q = new THREE.Quaternion();
          const e = new THREE.Euler();
          rubble.forEach((p, i) => {
            e.set(p.r * 0.3, p.r, p.r * 0.2);
            q.setFromEuler(e);
            m.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.h / 2, p.z), q, new THREE.Vector3(p.s, p.h, p.s * 0.8)));
          });
          m.instanceMatrix.needsUpdate = true;
        }}
        args={[undefined, undefined, rubble.length]}
        material={rubbleMat}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
    </group>
  );
}

/** Decorative perimeter fence (1.8 m — below every flight altitude). */
function Fence() {
  const { steelDark } = mats();
  const posts = useMemo(() => {
    const out: [number, number][] = [];
    const x0 = -42;
    const x1 = 62;
    const z0 = -52;
    const z1 = 44;
    for (let x = x0; x <= x1; x += 6) {
      out.push([x, z0]);
      if (x < -30 || x > -14) out.push([x, z1]); // gate on the south side
    }
    for (let z = z0 + 6; z < z1; z += 6) {
      out.push([x0, z]);
      out.push([x1, z]);
    }
    return out;
  }, []);
  return (
    <group>
      {posts.map(([x, z], i) => (
        <mesh key={i} material={steelDark} position={[x, 0.9, z]}>
          <boxGeometry args={[0.12, 1.8, 0.12]} />
        </mesh>
      ))}
    </group>
  );
}
