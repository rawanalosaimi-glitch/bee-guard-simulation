import { DEFAULT_GRAPHICS, GRAPHICS_LEVELS } from '../viz/quality';
import type { GraphicsQuality } from '../viz/quality';
import { useSyncExternalStore } from 'react';
import { isCloseUp } from './cameraModes';
import type { CameraMode } from './cameraModes';
export { CLOSE_UP_MODES, cameraSubject, isCloseUp } from './cameraModes';
export type { CameraMode } from './cameraModes';

/**
 * Presentation-only settings (camera, overlays, layout, visual scale).
 * Nothing here feeds back into the simulation.
 */
export type SidebarTab = 'mission' | 'radiation' | 'patients' | 'swarm' | 'evac' | 'log';

export interface ViewSettings {
  cameraMode: CameraMode;
  /** Bumped to re-run the camera fly-to even when the mode is unchanged. */
  cameraNonce: number;
  showTrails: boolean;
  showRoutes: boolean;
  showLabels: boolean;
  /** Visual enlargement of drone models only. Physics always uses true size. */
  droneScale: number;
  showHeatmap: boolean;
  showLinks: boolean;
  showEvacRoute: boolean;
  /** Which measurements the heat-map shows: what the GS received, or the complete on-board log. */
  heatmapSource: 'gs' | 'onboard';
  /** Tactical map display: smoothed inside measured cells, or crisp cells. */
  mapSmooth: boolean;
  mapExtent: 'fit' | 'site';
  /** Optional IDW estimate layer (clearly labelled, never used for planning). */
  mapEstimate: boolean;
  /** Show the scenario's configured source location as a reference marker. */
  mapSourceRef: boolean;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  /** Main viewport: live 3D scene or the aerial radiation map (Phase 3B). */
  mainView: '3d' | 'aerial';
  /** Aerial map: heat overlay opacity 0…1, building labels, contour lines, unknown-ground marking. */
  heatOpacity: number;
  mapLabels: boolean;
  mapContours: boolean;
  mapUnknown: boolean;
  /** Phase 3B+: red recommended rescue-team route on the aerial map. */
  showRescueRoute: boolean;
  /**
   * 'balanced': shadows (2048 map), DPR ≤ 1.5.
   * 'performance': no shadows, DPR 1, fewer decorative rocks — for integrated GPUs.
   */
  /** Stage 4: Performance (default, Intel UHD) · Balanced · High — see viz/quality.ts. */
  graphics: GraphicsQuality;
  /** True until the user picks a graphics mode; lets the app auto-select on Intel GPUs. */
  graphicsAuto: boolean;
  /** GPU renderer string reported by the browser (if available). */
  gpu: string | null;
  /** Stage 4: FPS / frame-time indicator over the 3D view. */
  showPerf: boolean;
  /**
   * Stage 5: overlay drawing style. 'clean' (default): fading 30 s trails (full trail for the followed drone),
   * only the active leg of planned routes, faint comms links, de-cluttered compact labels.
   * 'full': the previous complete overlays. Data, exports and the simulation are identical in both.
   */
  overlayStyle: 'clean' | 'full';
  /** Stage 5: hide every overlay (trails, routes, links, labels, heat-map, markers) — for screenshots. Not persisted. */
  cleanView: boolean;
}

const KEY = 'beeguard.view.v5';
const PERSIST: (keyof ViewSettings)[] = [
  'sidebarOpen',
  'sidebarTab',
  'graphics',
  'graphicsAuto',
  'heatmapSource',
  'showHeatmap',
  'showEvacRoute',
  'mapSmooth',
  'mapExtent',
  'mapEstimate',
  'mapSourceRef',
  'mainView',
  'heatOpacity',
  'mapLabels',
  'mapContours',
  'mapUnknown',
  'showRescueRoute',
  'showPerf',
  'overlayStyle',
];

let settings: ViewSettings = {
  cameraMode: 'overview',
  cameraNonce: 0,
  showTrails: true,
  showRoutes: true,
  showLabels: true,
  droneScale: 2.5,
  showHeatmap: true,
  showLinks: true,
  showEvacRoute: true,
  heatmapSource: 'gs',
  mapSmooth: true,
  mapExtent: 'fit',
  mapEstimate: false,
  mapSourceRef: true,
  sidebarOpen: true,
  sidebarTab: 'mission',
  mainView: '3d',
  heatOpacity: 0.3,
  mapLabels: true,
  mapContours: true,
  mapUnknown: true,
  showRescueRoute: true,
  graphics: DEFAULT_GRAPHICS,
  graphicsAuto: true,
  gpu: null,
  showPerf: true,
  overlayStyle: 'clean',
  cleanView: false,
};

/** Drone display scale actually drawn: close-up cameras always show true size. */
export function effectiveDroneScale(v: ViewSettings = settings): number {
  return isCloseUp(v.cameraMode) ? 1 : v.droneScale;
}

// per-viewer conveniences only; the app works without storage
try {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  if (raw) {
    const saved = JSON.parse(raw) as Partial<ViewSettings>;
    for (const k of PERSIST) if (k in saved) (settings as unknown as Record<string, unknown>)[k] = saved[k];
    // the soft heat-map default changed 0.62 → 0.30: a stored OLD default is migrated, a user choice is kept
    if (saved.heatOpacity === 0.62) settings.heatOpacity = 0.3;
    // Stage 4: three quality levels, Performance default — an AUTO (never user-chosen) older value becomes Performance
    if (!(GRAPHICS_LEVELS as readonly string[]).includes(settings.graphics) || settings.graphicsAuto) settings.graphics = DEFAULT_GRAPHICS;
  }
} catch {
  /* ignore */
}

const listeners = new Set<() => void>();

export const viewSettings = {
  get: (): ViewSettings => settings,
  set: (patch: Partial<ViewSettings>): void => {
    settings = { ...settings, ...patch };
    try {
      const out: Record<string, unknown> = {};
      for (const k of PERSIST) out[k] = settings[k];
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useViewSettings(): ViewSettings {
  return useSyncExternalStore(viewSettings.subscribe, viewSettings.get, viewSettings.get);
}
