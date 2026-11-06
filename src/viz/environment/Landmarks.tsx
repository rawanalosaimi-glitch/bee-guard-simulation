import { useMemo } from 'react';
import * as THREE from 'three';
import { WORLD } from '../../sim';
import { simController } from '../../state/simController';
import { useSimTick } from '../../state/hooks';
import { hazardStripeTexture, trefoilTexture } from './textures';

/**
 * Point features of the scenario, positioned from WORLD:
 *  - radiation source marker (position from engine.config.radiation)
 *  - one casualty
 *  - the ground station
 */

export function RadiationSourceMarker() {
  useSimTick(1);
  // position comes from the engine's radiation config — the same point the field model uses
  const p = simController.engine.config.radiation.sourcePosition;
  const ringTex = useMemo(() => {
    const t = hazardStripeTexture().clone();
    t.repeat.set(6, 1);
    t.needsUpdate = true;
    return t;
  }, []);
  return (
    <group position={[p.x, 0, p.z]}>
      {/* tipped-over shielded canister */}
      <mesh position={[0.2, 0.22, -0.1]} rotation={[0, 0.4, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.22, 0.22, 0.6, 16]} />
        <meshStandardMaterial color="#6b6f75" roughness={0.4} metalness={0.8} />
      </mesh>
      <mesh position={[-0.15, 0.22, 0.05]} rotation={[0, 0.4, Math.PI / 2]}>
        <cylinderGeometry args={[0.235, 0.235, 0.08, 16]} />
        <meshStandardMaterial color="#f5c400" roughness={0.5} />
      </mesh>
      {/* hazard boundary ring on the ground (marking only, not a dose contour) */}
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.6, 3.0, 64, 1]} />
        <meshBasicMaterial map={ringTex} side={THREE.DoubleSide} />
      </mesh>
      {/* warning sign on a post */}
      <mesh position={[-3.4, 0.9, -1.0]}>
        <cylinderGeometry args={[0.04, 0.04, 1.8, 8]} />
        <meshStandardMaterial color="#555" />
      </mesh>
      <mesh position={[-3.4, 1.7, -0.96]}>
        <planeGeometry args={[0.7, 0.7]} />
        <meshStandardMaterial map={trefoilTexture()} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

const coverall = new THREE.MeshStandardMaterial({ color: '#e8641b', roughness: 0.8 });
const reflect = new THREE.MeshStandardMaterial({ color: '#d9e021', roughness: 0.4, emissive: '#3a3c00', emissiveIntensity: 0.3 });
const skin = new THREE.MeshStandardMaterial({ color: '#a26b47', roughness: 0.7 });
const helmet = new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.35 });
const boots = new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 0.9 });

/** One casualty: a worker in an orange coverall lying on the ground (≈1.75 m). */
export function Casualty() {
  const c = WORLD.casualty;
  return (
    <group position={[c.position.x, 0, c.position.z]} rotation={[0, c.headingRad, 0]}>
      {/* body lies along local +x (head) */}
      <mesh material={coverall} position={[0.15, 0.16, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.17, 0.5, 4, 12]} />
      </mesh>
      <mesh material={reflect} position={[0.25, 0.17, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.175, 0.175, 0.06, 14]} />
      </mesh>
      <mesh material={skin} position={[0.68, 0.14, 0.02]} castShadow>
        <sphereGeometry args={[0.11, 14, 12]} />
      </mesh>
      <mesh material={helmet} position={[0.86, 0.13, 0.18]} rotation={[0.3, 0.4, 1.2]} castShadow>
        <sphereGeometry args={[0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      {/* arms */}
      <mesh material={coverall} position={[0.35, 0.1, 0.3]} rotation={[0, -0.5, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.06, 0.45, 4, 8]} />
      </mesh>
      <mesh material={coverall} position={[0.3, 0.1, -0.27]} rotation={[0, 0.3, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.06, 0.45, 4, 8]} />
      </mesh>
      {/* legs */}
      <mesh material={coverall} position={[-0.42, 0.1, 0.1]} rotation={[0, 0.12, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.08, 0.6, 4, 8]} />
      </mesh>
      <mesh material={coverall} position={[-0.4, 0.1, -0.12]} rotation={[0, -0.25, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.08, 0.6, 4, 8]} />
      </mesh>
      <mesh material={boots} position={[-0.82, 0.1, 0.16]} castShadow>
        <boxGeometry args={[0.16, 0.14, 0.12]} />
      </mesh>
      <mesh material={boots} position={[-0.8, 0.1, -0.25]} castShadow>
        <boxGeometry args={[0.16, 0.14, 0.12]} />
      </mesh>
    </group>
  );
}

const white = new THREE.MeshStandardMaterial({ color: '#eef0f2', roughness: 0.4, metalness: 0.2 });
const dark = new THREE.MeshStandardMaterial({ color: '#23272c', roughness: 0.6 });
const canvasMat = new THREE.MeshStandardMaterial({ color: '#d9cdb3', roughness: 0.95, side: THREE.DoubleSide });
const stripe = new THREE.MeshStandardMaterial({ color: '#f2b01e', roughness: 0.5 });

/** Mobile ground station: command vehicle, telescopic mast with dish, shade tent. */
export function GroundStation() {
  const g = WORLD.groundStation.position;
  return (
    <group position={[g.x, 0, g.z]} rotation={[0, -0.72, 0]}>
      {/* vehicle */}
      <group position={[0, 0, 0]}>
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
      {/* mast + dish + whip antennas */}
      <mesh material={white} position={[0.6, 2.65 + 3, -2]} castShadow>
        <cylinderGeometry args={[0.07, 0.1, 6, 10]} />
      </mesh>
      <mesh material={white} position={[0.6, 8.8, -1.8]} rotation={[-1.1, 0, 0]} castShadow>
        <sphereGeometry args={[0.6, 20, 10, 0, Math.PI * 2, 0, 0.9]} />
      </mesh>
      <mesh material={dark} position={[-0.6, 3.3, -2.3]}>
        <cylinderGeometry args={[0.015, 0.015, 1.6, 6]} />
      </mesh>
      {/* shade tent with table */}
      <group position={[-4.2, 0, 0]}>
        <mesh material={canvasMat} position={[0, 2.5, 0]} castShadow>
          <boxGeometry args={[3.2, 0.06, 3.2]} />
        </mesh>
        {[
          [1.5, 1.5],
          [-1.5, 1.5],
          [1.5, -1.5],
          [-1.5, -1.5],
        ].map(([x, z], i) => (
          <mesh key={i} material={dark} position={[x, 1.25, z]}>
            <cylinderGeometry args={[0.035, 0.035, 2.5, 6]} />
          </mesh>
        ))}
        <mesh material={white} position={[0, 0.75, 0]} castShadow>
          <boxGeometry args={[1.8, 0.05, 0.8]} />
        </mesh>
        <mesh material={dark} position={[0.3, 0.9, 0]} rotation={[-0.3, 0, 0]}>
          <boxGeometry args={[0.45, 0.3, 0.02]} />
        </mesh>
      </group>
    </group>
  );
}
