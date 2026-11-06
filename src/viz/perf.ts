import { useSyncExternalStore } from 'react';

/**
 * Stage 4: rendering performance probe (presentation only — never touches the simulation).
 * Frame time = wall-clock interval between consecutive rendered frames, measured inside the
 * render loop over a rolling window of the last 240 frames. Draw calls / triangles are those of
 * the most recent frame (renderer.info, autoReset). Published twice per second.
 */
export interface PerfSample {
  /** Frames per second over the window (1000 / mean frame time). */
  fps: number;
  frameMs: number;
  p95Ms: number;
  worstMs: number;
  frames: number;
  calls: number;
  triangles: number;
  textures: number;
  geometries: number;
  programs: number;
  quality: string;
  dpr: number;
  shadows: string;
  /** False when the 3D view is paused (aerial map shown, demand frameloop). */
  live: boolean;
}

let sample: PerfSample | null = null;
const listeners = new Set<() => void>();

export const perfStore = {
  get: (): PerfSample | null => sample,
  set: (s: PerfSample): void => {
    sample = s;
    (globalThis as unknown as { beeguardPerf?: PerfSample }).beeguardPerf = s;
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export const usePerf = (): PerfSample | null => useSyncExternalStore(perfStore.subscribe, perfStore.get, perfStore.get);

export { FrameWindow } from './perfWindow';
