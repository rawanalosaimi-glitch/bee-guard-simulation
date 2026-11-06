import { useSyncExternalStore } from 'react';

/**
 * Aerial (orthographic top-down) image of the static 3D scene, captured by the
 * main renderer (src/viz/AerialCapture.tsx). The radiation map draws it as its
 * base layer with the SAME world coordinates: pixel (u, v) ↔ world
 * x = x0 + u·(x1−x0)/width, z = z0 + v·(z1−z0)/height  (north = −z is up).
 */
export interface AerialImage {
  canvas: HTMLCanvasElement;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Shadows came from the renderer (balanced) or were approximated in 2-D (performance). */
  shadows: 'rendered' | 'approximated';
  /** Mean colour of the image border — used to fill the map beyond the captured area seamlessly. */
  edge: string;
  capturedAt: number;
}

/** World rectangle photographed: facility, corridors, ground-station base. */
export const AERIAL_BOUNDS = { x0: -104, z0: -84, x1: 80, z1: 100 };

let image: AerialImage | null = null;
let nonce = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const aerialStore = {
  get: () => image,
  set: (img: AerialImage) => {
    image = img;
    emit();
  },
  /** Ask the 3D view to re-capture (e.g. after a graphics-mode change). */
  request: () => {
    nonce++;
    emit();
  },
  nonce: () => nonce,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useAerialImage(): AerialImage | null {
  return useSyncExternalStore(aerialStore.subscribe, aerialStore.get, aerialStore.get);
}
export function useAerialNonce(): number {
  return useSyncExternalStore(aerialStore.subscribe, aerialStore.nonce, aerialStore.nonce);
}
