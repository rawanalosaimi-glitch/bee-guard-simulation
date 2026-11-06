import { useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import type { Group, Mesh } from 'three';
import { MAT } from './materials';
import { useRotor } from './rotor';

// Stage 5: curved parts use finer tessellation (more radial segments / rounded-box smoothness) for the
// close-up cameras. Shapes, dimensions, colours and materials are unchanged.

/**
 * Procedural low-poly placeholder of the mother drone, following the
 * silhouette of mother_drone_reference.webp (black foldable quadcopter:
 * flat bevelled body, slate top strip with round button, front camera,
 * four angled arms with two-blade props and fold-down legs), ENLARGED and
 * extended with an underside bay (internal cradles for three bees) and a
 * two-door bottom hatch.
 *
 * The hatch angle is driven by the simulation's hatchOpen value (0…1) via
 * `hatchRef`; it is not an independent animation.
 *
 * Forward = +z. Body ≈ 1.7 m × 3.8 m; span over props ≈ 6.9 m.
 */

export const BAY = {
  halfWidth: 0.63,
  halfLength: 1.58,
  ceilingY: -0.08,
  floorY: -0.85,
};

const ARMS: { from: [number, number]; to: [number, number] }[] = [
  { from: [0.72, 1.25], to: [2.5, 2.35] },
  { from: [-0.72, 1.25], to: [-2.5, 2.35] },
  { from: [0.72, -1.25], to: [2.5, -2.35] },
  { from: [-0.72, -1.25], to: [-2.5, -2.35] },
];

function Arm({ from, to, index, spinning }: { from: [number, number]; to: [number, number]; index: number; spinning: boolean }) {
  const { blades: prop, discRef, disc } = useRotor(spinning, 32, index % 3 === 0 ? 1 : -1, 0.95, '#1a1c20');
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const L = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  const isFront = to[1] > 0;
  const nav = isFront ? (to[0] > 0 ? MAT.navGreen : MAT.navRed) : MAT.navWhite;
  return (
    <group>
      <group position={[(from[0] + to[0]) / 2, 0.08, (from[1] + to[1]) / 2]} rotation={[0, yaw, 0]}>
        <mesh material={MAT.motherBody} castShadow>
          <boxGeometry args={[0.24, 0.13, L]} />
        </mesh>
        {/* vent holes, as on the reference arms */}
        {[-0.3, 0, 0.3].map((o) => (
          <mesh key={o} material={MAT.motherInterior} position={[0.122, 0, o * L * 0.6]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.03, 0.03, 0.01, 16]} />
          </mesh>
        ))}
      </group>
      <group position={[to[0], 0.1, to[1]]}>
        <mesh material={MAT.motherBody} castShadow>
          <cylinderGeometry args={[0.17, 0.19, 0.26, 32]} />
        </mesh>
        <mesh material={MAT.motherMetal} position={[0, 0.14, 0]}>
          <cylinderGeometry args={[0.12, 0.15, 0.04, 32]} />
        </mesh>
        <mesh ref={discRef} geometry={disc.geo} material={disc.mat} position={[0, 0.205, 0]} renderOrder={3} />
        <group ref={prop} position={[0, 0.2, 0]}>
          <mesh material={MAT.motherBlade} rotation={[0.08, 0, 0]} castShadow>
            <boxGeometry args={[1.9, 0.02, 0.13]} />
          </mesh>
          <mesh material={MAT.motherMetal}>
            <cylinderGeometry args={[0.06, 0.06, 0.06, 16]} />
          </mesh>
        </group>
        {/* fold-down leg */}
        <mesh material={MAT.motherBody} position={[0, -0.55, 0]} rotation={[0, 0, Math.sign(to[0]) * 0.15]} castShadow>
          <boxGeometry args={[0.08, 0.9, 0.12]} />
        </mesh>
        <mesh material={MAT.motherBody} position={[Math.sign(to[0]) * 0.07, -1.0, 0]}>
          <boxGeometry args={[0.16, 0.05, 0.3]} />
        </mesh>
        <mesh material={nav} position={[Math.sign(to[0]) * 0.2, 0, 0]}>
          <sphereGeometry args={[0.05, 12, 12]} />
        </mesh>
      </group>
    </group>
  );
}

function HatchDoor({ side, hatchRef }: { side: 1 | -1; hatchRef: MutableRefObject<number> }) {
  const g = useRef<Group>(null);
  useFrame(() => {
    // side = -1: hinge on the left (−x) edge, door swings down with a negative
    // z-rotation; side = +1 mirrors it. 1.75 rad ≈ 100° fully open.
    if (g.current) g.current.rotation.z = side * hatchRef.current * 1.75;
  });
  const w = BAY.halfWidth;
  return (
    <group ref={g} position={[side * w, BAY.floorY, 0]}>
      <mesh material={MAT.motherHull} position={[-side * (w / 2), 0, 0]} castShadow>
        <boxGeometry args={[w, 0.045, BAY.halfLength * 2]} />
      </mesh>
      <mesh material={MAT.motherInterior} position={[-side * (w / 2), 0.03, 0]}>
        <boxGeometry args={[w * 0.9, 0.01, BAY.halfLength * 1.9]} />
      </mesh>
    </group>
  );
}

export function MotherModel({ hatchRef, spinning = true }: { hatchRef: MutableRefObject<number>; spinning?: boolean }) {
  const strobe = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (strobe.current) strobe.current.visible = clock.elapsedTime % 1.2 < 0.08; // decorative beacon
  });
  const wallH = BAY.ceilingY - BAY.floorY;
  const wallY = (BAY.ceilingY + BAY.floorY) / 2;
  return (
    <group>
      {/* upper shell */}
      <RoundedBox args={[1.7, 0.42, 3.8]} radius={0.16} smoothness={5} position={[0, 0.12, 0]} material={MAT.motherBody} castShadow />
      {/* top strip + round button (reference detail) */}
      <RoundedBox args={[0.46, 0.06, 1.25]} radius={0.025} smoothness={4} position={[0, 0.35, 0.35]} material={MAT.motherStrip} />
      <mesh material={MAT.motherStrip} position={[0, 0.345, -0.65]}>
        <cylinderGeometry args={[0.15, 0.15, 0.04, 36]} />
      </mesh>
      <mesh material={MAT.motherMetal} position={[0, 0.37, -0.65]}>
        <torusGeometry args={[0.1, 0.012, 8, 36]} />
      </mesh>

      {/* bay walls (outer hull) */}
      {[1, -1].map((s) => (
        <mesh key={`side${s}`} material={MAT.motherHull} position={[s * (BAY.halfWidth + 0.04), wallY, 0]} castShadow>
          <boxGeometry args={[0.08, wallH, BAY.halfLength * 2 + 0.16]} />
        </mesh>
      ))}
      {[1, -1].map((s) => (
        <mesh key={`end${s}`} material={MAT.motherHull} position={[0, wallY, s * (BAY.halfLength + 0.04)]} castShadow>
          <boxGeometry args={[BAY.halfWidth * 2 + 0.16, wallH, 0.08]} />
        </mesh>
      ))}
      {/* bay interior: ceiling, liners, LED strips, cradles */}
      <mesh material={MAT.motherInterior} position={[0, BAY.ceilingY - 0.005, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BAY.halfWidth * 2, BAY.halfLength * 2]} />
      </mesh>
      {[1, -1].map((s) => (
        <mesh key={`liner${s}`} material={MAT.motherInterior} position={[s * (BAY.halfWidth - 0.002), wallY, 0]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[BAY.halfLength * 2, wallH]} />
        </mesh>
      ))}
      {[1, -1].map((s) => (
        <mesh key={`led${s}`} material={MAT.bayLight} position={[s * (BAY.halfWidth - 0.05), BAY.ceilingY - 0.02, 0]}>
          <boxGeometry args={[0.025, 0.012, BAY.halfLength * 1.8]} />
        </mesh>
      ))}
      {[1.05, 0, -1.05].map((z) => (
        <group key={`cradle${z}`} position={[0, BAY.ceilingY - 0.03, z]}>
          <mesh material={MAT.motherMetal}>
            <boxGeometry args={[0.34, 0.04, 0.08]} />
          </mesh>
          {[-0.12, 0.12].map((x) => (
            <mesh key={x} material={MAT.motherMetal} position={[x, -0.05, 0]}>
              <boxGeometry args={[0.03, 0.08, 0.06]} />
            </mesh>
          ))}
        </group>
      ))}
      <HatchDoor side={-1} hatchRef={hatchRef} />
      <HatchDoor side={1} hatchRef={hatchRef} />

      {/* front camera gimbal */}
      <group position={[0, -0.28, 1.72]}>
        <mesh material={MAT.motherBody}>
          <sphereGeometry args={[0.17, 16, 12]} />
        </mesh>
        <mesh material={MAT.lens} position={[0, -0.02, 0.15]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.075, 0.075, 0.05, 18]} />
        </mesh>
      </group>
      {/* rear battery vents */}
      {[-0.4, -0.2, 0, 0.2, 0.4].map((x) => (
        <mesh key={x} material={MAT.motherInterior} position={[x, 0.12, -1.905]}>
          <boxGeometry args={[0.1, 0.2, 0.02]} />
        </mesh>
      ))}
      <mesh ref={strobe} material={MAT.navWhite} position={[0, 0.42, -1.4]}>
        <sphereGeometry args={[0.06, 8, 8]} />
      </mesh>

      {ARMS.map((a, i) => (
        <Arm key={i} index={i} from={a.from} to={a.to} spinning={spinning} />
      ))}
    </group>
  );
}
