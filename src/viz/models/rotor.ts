import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Stage 4 rotor presentation (visual only — the simulation has no rotor model).
 *  - spin-up / spin-down: the drawn rotor rate ramps toward the target (on = the drone is not docked /
 *    the mission has started) with a first-order time constant instead of switching instantly;
 *  - at speed, the individual blades fade out and a translucent "motion-blur" disc fades in, as fast
 *    propellers look on camera. The disc is a flat, depth-write-free circle inside the rotor's own radius,
 *    so the drone's silhouette and dimensions are unchanged.
 */
export const rotorSettings = { discs: true };

export function useRotor(spinning: boolean, maxRate: number, dir: number, radius: number, tint = '#2b2e33') {
  const blades = useRef<THREE.Group>(null);
  const rate = useRef(spinning ? 1 : 0);
  const disc = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const geo = new THREE.RingGeometry(radius * 0.18, radius, 40);
    geo.rotateX(-Math.PI / 2);
    return { mat, geo };
  }, [radius, tint]);
  const discRef = useRef<THREE.Mesh>(null);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const target = spinning ? 1 : 0;
    // τ ≈ 0.6 s spin-up, ≈ 1.2 s spin-down
    const tau = target > rate.current ? 0.6 : 1.2;
    rate.current += (target - rate.current) * (1 - Math.exp(-dt / tau));
    if (rate.current < 1e-3) rate.current = 0;
    if (blades.current) blades.current.rotation.y += dir * dt * maxRate * rate.current;
    const blur = rotorSettings.discs ? Math.max(0, Math.min(1, (rate.current - 0.45) / 0.4)) : 0;
    disc.mat.opacity = 0.28 * blur;
    if (discRef.current) discRef.current.visible = blur > 0.01;
    if (blades.current) blades.current.visible = blur < 0.98;
  });
  return { blades, discRef, disc };
}
