import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { FrameWindow, perfStore } from './perf';

/** Inside the Canvas: measures frame time and renderer statistics (see perf.ts). */
export function PerfProbe({ quality, shadows }: { quality: string; shadows: string }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  // debugging / screenshot / performance scripts only: renderer, scene, camera and orbit-control handles
  (globalThis as unknown as { __beeguard3d?: unknown }).__beeguard3d = { gl, scene, camera, controls };
  const win = useRef(new FrameWindow(240));
  const last = useRef<number | null>(null);
  const lastPub = useRef(0);
  useFrame(() => {
    const now = performance.now();
    if (last.current !== null) win.current.push(now - last.current);
    last.current = now;
    if (now - lastPub.current < 500) return;
    lastPub.current = now;
    const st = win.current.stats();
    const info = gl.info;
    perfStore.set({
      fps: st.fps,
      frameMs: st.mean,
      p95Ms: st.p95,
      worstMs: st.worst,
      frames: st.n,
      calls: info.render.calls,
      triangles: info.render.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      programs: info.programs?.length ?? 0,
      quality,
      dpr: gl.getPixelRatio(),
      shadows,
      live: true,
    });
  });
  return null;
}
