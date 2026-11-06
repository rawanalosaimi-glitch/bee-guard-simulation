import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { WORLD } from '../../sim';
import type { QualityProfile } from '../quality';
import { pbrMaterial, tileOf } from '../pbr/library';

/**
 * Desert ground. The operations area (radius ≈ 1.25 × opsAreaHalfSize) is
 * perfectly flat at y = 0, matching the simulation's flat-ground assumption.
 * Dunes rise only outside it and are purely decorative (bees never fly there).
 * Deterministic: no Math.random.
 */

function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function duneHeight(x: number, z: number): number {
  const ridges =
    7 * Math.sin(0.011 * x + 0.9 * Math.sin(0.006 * z)) +
    4 * Math.sin(0.023 * z + 0.013 * x + 1.7) +
    1.6 * Math.sin(0.06 * x - 0.045 * z) +
    0.6 * Math.sin(0.17 * x + 0.11 * z);
  return Math.max(0, ridges + 5);
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const FLAT_R = WORLD.opsAreaHalfSize * 1.25;

/** Terrain surface height at (x, z) — also used to keep the camera above the sand. */
export function terrainHeight(x: number, z: number): number {
  return duneHeight(x, z) * smoothstep(FLAT_R, FLAT_R + 140, Math.hypot(x, z));
}

export function Terrain({ q }: { q: QualityProfile }) {
  const seg = q.terrainSegments;
  const rockCount = q.rocks;
  // Stage 4: PBR sand (albedo × large-scale vertex tint, normal + roughness) at world scale
  const sand = useMemo(() => pbrMaterial('sand', { vertexColors: true, roughness: 1, normalScale: 0.5, envMapIntensity: 0.8, antiTile: 'uv' }), []);
  const rockMat = useMemo(() => pbrMaterial('sand', { color: '#b9a18a', roughness: 1, normalScale: 1.2 }), []); // rocky ground texture on the scattered rocks

  const geometry = useMemo(() => {
    const size = 1600;
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const sandA = new THREE.Color('#e0bb84');
    const sandB = new THREE.Color('#c99a5b');
    const sandC = new THREE.Color('#ecd2a2');
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const blend = smoothstep(FLAT_R, FLAT_R + 140, Math.hypot(x, z));
      const h = duneHeight(x, z) * blend;
      pos.setY(i, h);
      // (no high-frequency ripple term: at 8 m vertex spacing it aliased into visible stripes)
      const noise = hash(Math.floor(x * 0.05) * 31 + Math.floor(z * 0.05));
      const broad = 0.5 + 0.5 * Math.sin(0.013 * x + 0.008 * z) * Math.cos(0.009 * z - 0.004 * x);
      c.copy(sandA).lerp(sandB, Math.min(1, h / 22) * 0.6 + noise * 0.06 + broad * 0.1);
      c.lerp(sandC, (1 - blend) * 0.06);
      // tint RELATIVE to the base sand colour: the PBR albedo already carries the sand colour
      colors[i * 3] = Math.min(1.25, c.r / sandA.r);
      colors[i * 3 + 1] = Math.min(1.25, c.g / sandA.g);
      colors[i * 3 + 2] = Math.min(1.25, c.b / sandA.b);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // world-scale UVs: one sand tile = tileOf('sand') metres
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const tile = tileOf('sand');
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / tile, pos.getZ(i) / tile);
    uv.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, [seg]);

  // decorative rocks as ONE instanced mesh (a single draw call)
  const rocks = useMemo(() => {
    const out: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let i = 0; out.length < rockCount && i < rockCount * 3; i++) {
      const a = hash(i + 0.5) * Math.PI * 2;
      const rr = 75 + hash(i + 7.3) * 380;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (x > -50 && x < 70 && z > -60 && z < 50) continue;
      if (x > -95 && x < -45 && z > 30 && z < 85) continue; // ground-station area
      const s = 0.25 + hash(i + 3.1) * 0.9;
      const r = hash(i + 9.9) * 6;
      e.set(r, r * 1.7, 0);
      q.setFromEuler(e);
      out.push(new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.1, z), q, new THREE.Vector3(s, s * 0.6, s)));
    }
    return out;
  }, [rockCount]);

  const inst = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!inst.current) return;
    rocks.forEach((m, i) => inst.current!.setMatrixAt(i, m));
    inst.current.instanceMatrix.needsUpdate = true;
  }, [rocks]);

  return (
    <group>
      <mesh geometry={geometry} material={sand} receiveShadow />
      <instancedMesh ref={inst} args={[undefined, rockMat, rocks.length]} castShadow receiveShadow>
        <dodecahedronGeometry args={[1, 1]} />
      </instancedMesh>
    </group>
  );
}
