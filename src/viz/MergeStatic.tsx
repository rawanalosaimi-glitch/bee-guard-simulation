import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Stage 4 draw-call reduction (presentation only): after its children mount, merges every STATIC mesh
 * under it that shares a material (and shadow flags) into one mesh, then hides the originals. Meshes
 * inside a group with `userData.dynamic = true` (animated people, beacons, windsock), instanced meshes
 * and multi-material meshes are left untouched. Undone on unmount. Geometry is baked in the group's
 * local frame, so positions are identical to the unmerged scene.
 */
export function MergeStatic({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map<string, { mat: THREE.Material; cast: boolean; recv: boolean; meshes: THREE.Mesh[] }>();
    const visit = (o: THREE.Object3D) => {
      if (o.userData?.dynamic || o.userData?.merged) return;
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as unknown as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(m.material) && m.visible && m.geometry?.attributes?.position) {
        const g = m.geometry;
        const sig = Object.keys(g.attributes).sort().join(',') + (g.index ? ':i' : ':n');
        const key = `${m.material.uuid}|${m.castShadow}|${m.receiveShadow}|${sig}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { mat: m.material, cast: m.castShadow, recv: m.receiveShadow, meshes: [] }));
        b.meshes.push(m);
      }
      for (const c of o.children) visit(c);
    };
    for (const c of root.children) visit(c);
    const created: THREE.Mesh[] = [];
    const hidden: THREE.Mesh[] = [];
    const tmp = new THREE.Matrix4();
    for (const b of buckets.values()) {
      if (b.meshes.length < 2) continue;
      const geos = b.meshes.map((m) => {
        const c = m.geometry.clone();
        c.clearGroups();
        c.applyMatrix4(tmp.multiplyMatrices(inv, m.matrixWorld));
        return c;
      });
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mm = new THREE.Mesh(merged, b.mat);
      mm.castShadow = b.cast;
      mm.receiveShadow = b.recv;
      mm.userData.merged = true;
      root.add(mm);
      created.push(mm);
      for (const m of b.meshes) {
        m.visible = false;
        hidden.push(m);
      }
    }
    return () => {
      for (const m of created) {
        root.remove(m);
        m.geometry.dispose();
      }
      for (const m of hidden) m.visible = true;
    };
  }, [enabled]);
  return <group ref={ref}>{children}</group>;
}
