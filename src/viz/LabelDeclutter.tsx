import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { viewSettings } from '../state/viewSettings';
import { declutter } from './overlayStyle';
import type { LabelBox } from './overlayStyle';

/**
 * Stage 5 — screen-space label de-cluttering for the 3D view (presentation only).
 * Labels drawn with <DeclutterHtml> register here; with the 'clean' overlay style a label that
 * overlaps a higher-priority one is hidden (re-evaluated ~8× per second). 'full' shows them all.
 */
interface Entry {
  group: { current: THREE.Group | null };
  el: { current: HTMLDivElement | null };
  priority: { current: number };
}
const registry = new Map<string, Entry>();

export function DeclutterHtml({
  id,
  priority,
  position,
  zIndex = 10,
  children,
}: {
  id: string;
  priority: number;
  position?: [number, number, number];
  zIndex?: number;
  children: ReactNode;
}) {
  const group = useRef<THREE.Group>(null);
  const el = useRef<HTMLDivElement>(null);
  const prio = useRef(priority);
  prio.current = priority;
  useEffect(() => {
    registry.set(id, { group, el, priority: prio });
    return () => {
      registry.delete(id);
    };
  }, [id]);
  return (
    <group ref={group} position={position}>
      <Html center zIndexRange={[zIndex, 0]} style={{ pointerEvents: 'none' }}>
        <div ref={el}>{children}</div>
      </Html>
    </group>
  );
}

const tmp = new THREE.Vector3();

export function LabelDeclutter() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.12) return;
    acc.current = 0;
    const clean = viewSettings.get().overlayStyle === 'clean';
    if (!clean) {
      for (const e of registry.values()) if (e.el.current) e.el.current.style.visibility = '';
      return;
    }
    const boxes: LabelBox[] = [];
    for (const [id, e] of registry) {
      const g = e.group.current;
      const div = e.el.current;
      if (!g || !div) continue;
      g.getWorldPosition(tmp).project(camera);
      const onScreen = tmp.z < 1 && Math.abs(tmp.x) <= 1.05 && Math.abs(tmp.y) <= 1.05;
      boxes.push({
        id,
        x: ((tmp.x + 1) / 2) * size.width,
        y: ((1 - tmp.y) / 2) * size.height,
        w: div.offsetWidth || 60,
        h: div.offsetHeight || 16,
        priority: e.priority.current,
        onScreen,
      });
    }
    const show = declutter(boxes);
    for (const [id, e] of registry) if (e.el.current) e.el.current.style.visibility = show.has(id) ? '' : 'hidden';
  });
  return null;
}
