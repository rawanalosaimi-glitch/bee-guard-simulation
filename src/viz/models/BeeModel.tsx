import { MAT } from './materials';
import { useRotor } from './rotor';
import { BeeEmblem } from './BeeEmblem';

// Stage 5: curved parts use finer tessellation (more radial segments / rounded-box smoothness) for the
// close-up cameras. Shapes, dimensions, colours and materials are unchanged.

/**
 * Procedural low-poly placeholder of the BEE-GUARD bee drone, following
 * bee_reference.jpeg:
 *   - horizontal yellow capsule body with two dark-grey bands
 *   - dark front panel; the authentic national emblem on both flanks (BeeEmblem.tsx)
 *   - yellow top plate and antenna with a yellow ball tip
 *   - four yellow ducted rotors with dark rims, light-grey hubs, two-blade props
 *   - four jointed legs (dark upper / light-grey lower / dark feet)
 * Forward = +z, up = +y, true size ≈ 0.96 m × 0.8 m (1 unit = 1 m).
 * Replace with a Blender GLB later — see docs/GLB_PIPELINE.md.
 */

const DUCT_R = 0.17;
const DUCT_H = 0.07;
const DUCTS: [number, number, number][] = [
  [0.31, 0.06, 0.2],
  [-0.31, 0.06, 0.2],
  [0.31, 0.06, -0.2],
  [-0.31, 0.06, -0.2],
];
const LEGS: [number, number][] = [
  [0.1, 0.11],
  [-0.1, 0.11],
  [0.1, -0.11],
  [-0.1, -0.11],
];

function DuctedRotor({ position, spinning, dir }: { position: [number, number, number]; spinning: boolean; dir: number }) {
  const { blades, discRef, disc } = useRotor(spinning, 55, dir, DUCT_R * 0.94);
  const [x, , z] = position;
  const armLen = Math.hypot(x, z) - DUCT_R - 0.08;
  const armAngle = Math.atan2(x, z);
  return (
    <group>
      {/* support arm from body to duct */}
      <mesh
        material={MAT.beeLight}
        position={[x * 0.45, position[1] - 0.01, z * 0.45]}
        rotation={[0, armAngle, 0]}
        castShadow
      >
        <boxGeometry args={[0.035, 0.025, armLen]} />
      </mesh>
      <group position={position}>
        <mesh material={MAT.beeYellowDuct} castShadow>
          <cylinderGeometry args={[DUCT_R, DUCT_R, DUCT_H, 48, 1, true]} />
        </mesh>
        <mesh material={MAT.beeDark} position={[0, DUCT_H / 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[DUCT_R, 0.011, 8, 48]} />
        </mesh>
        <mesh material={MAT.beeDark} position={[0, -DUCT_H / 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[DUCT_R, 0.011, 8, 48]} />
        </mesh>
        {/* stator struts */}
        {[0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((a) => (
          <mesh key={a} material={MAT.beeLight} rotation={[0, a, 0]} position={[Math.sin(a) * 0.1, -0.015, Math.cos(a) * 0.1]}>
            <boxGeometry args={[0.012, 0.012, 0.13]} />
          </mesh>
        ))}
        {/* motor hub + spinner */}
        <mesh material={MAT.beeLight} castShadow>
          <cylinderGeometry args={[0.045, 0.05, 0.07, 24]} />
        </mesh>
        <mesh material={MAT.beeYellow} position={[0, 0.06, 0]}>
          <coneGeometry args={[0.035, 0.05, 20]} />
        </mesh>
        <mesh ref={discRef} geometry={disc.geo} material={disc.mat} position={[0, 0.03, 0]} renderOrder={3} />
        <group ref={blades} position={[0, 0.03, 0]}>
          <mesh material={MAT.beeBlade} rotation={[0.18, 0, 0]}>
            <boxGeometry args={[0.31, 0.006, 0.035]} />
          </mesh>
          <mesh material={MAT.beeBlade} rotation={[-0.18, Math.PI / 2, 0]}>
            <boxGeometry args={[0.31, 0.006, 0.035]} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

function Leg({ x, z }: { x: number; z: number }) {
  const splayX = Math.sign(x) * 0.12;
  const splayZ = -Math.sign(z) * 0.08;
  return (
    <group position={[x, -0.08, z]} rotation={[splayZ, 0, splayX]}>
      <mesh material={MAT.beeDark} position={[0, -0.09, 0]} castShadow>
        <cylinderGeometry args={[0.018, 0.02, 0.17, 12]} />
      </mesh>
      <mesh material={MAT.beeDark} position={[0, -0.18, 0]}>
        <sphereGeometry args={[0.025, 12, 12]} />
      </mesh>
      <mesh material={MAT.beeLight} position={[0, -0.26, 0]} castShadow>
        <cylinderGeometry args={[0.014, 0.014, 0.15, 12]} />
      </mesh>
      <mesh material={MAT.beeDark} position={[0, -0.345, 0.01]} castShadow>
        <boxGeometry args={[0.06, 0.025, 0.085]} />
      </mesh>
      <mesh material={MAT.beeYellow} position={[0, -0.328, 0.03]}>
        <boxGeometry args={[0.045, 0.012, 0.03]} />
      </mesh>
    </group>
  );
}


export function BeeModel({ spinning = true }: { spinning?: boolean }) {
  return (
    <group>
      {/* body */}
      <mesh material={MAT.beeYellow} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <capsuleGeometry args={[0.13, 0.3, 10, 32]} />
      </mesh>
      {[-0.02, -0.14].map((z) => (
        <mesh key={z} material={MAT.beeDark} position={[0, 0, z]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.136, 0.136, 0.05, 32]} />
        </mesh>
      ))}
      {/* emblem on both flanks, on the front dark band between the front and rear rotors (local artwork file) */}
      <BeeEmblem />
      {/* front panel (the earlier hand-made emblem placeholder on it was removed: the authentic emblem is on the flanks) */}
      <mesh material={MAT.beeDark} position={[0, -0.005, 0.2]}>
        <boxGeometry args={[0.18, 0.14, 0.085]} />
      </mesh>
      {/* small side sensor box (as on the reference's flank) */}
      <mesh material={MAT.beeDark} position={[0.125, 0.02, 0.06]}>
        <boxGeometry args={[0.03, 0.06, 0.07]} />
      </mesh>
      {/* top plate + antenna */}
      <mesh material={MAT.beeYellow} position={[0, 0.135, -0.01]} castShadow>
        <boxGeometry args={[0.2, 0.04, 0.3]} />
      </mesh>
      <mesh material={MAT.beeDark} position={[0, 0.17, -0.02]}>
        <cylinderGeometry args={[0.022, 0.026, 0.035, 16]} />
      </mesh>
      <mesh material={MAT.beeDark} position={[0, 0.29, -0.02]}>
        <cylinderGeometry args={[0.008, 0.009, 0.22, 12]} />
      </mesh>
      <mesh material={MAT.beeYellow} position={[0, 0.405, -0.02]}>
        <sphereGeometry args={[0.022, 16, 16]} />
      </mesh>

      {DUCTS.map((p, i) => (
        <DuctedRotor key={i} position={p} spinning={spinning} dir={i % 3 === 0 ? 1 : -1} />
      ))}
      {LEGS.map(([x, z], i) => (
        <Leg key={i} x={x} z={z} />
      ))}
    </group>
  );
}
