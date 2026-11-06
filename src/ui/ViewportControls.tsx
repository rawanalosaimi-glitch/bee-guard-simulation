import { useViewSettings, viewSettings } from '../state/viewSettings';
import type { CameraMode, ViewSettings } from '../state/viewSettings';
import { toggleFullscreen, useFullscreen } from './fullscreen';

const CAMS: { id: CameraMode; label: string; key?: string }[] = [
  { id: 'overview', label: 'Overview', key: 'O' },
  { id: 'top', label: 'Top', key: 'T' },
  { id: 'base', label: 'Base', key: 'B' },
  { id: 'MOTHER-01', label: 'Mother' },
  { id: 'BEE-01', label: 'BEE-01' },
  { id: 'BEE-02', label: 'BEE-02' },
  { id: 'BEE-03', label: 'BEE-03' },
];

/** Stage 5 close-up cameras (true-size drones, real shadows). */
const CLOSE: { id: CameraMode; label: string; title: string }[] = [
  { id: 'CLOSE-MOTHER-01', label: 'Mother', title: 'Close-up: mother drone (true size)' },
  { id: 'CLOSE-BEE-01', label: 'B1', title: 'Close-up: BEE-01 (true size)' },
  { id: 'CLOSE-BEE-02', label: 'B2', title: 'Close-up: BEE-02 (true size)' },
  { id: 'CLOSE-BEE-03', label: 'B3', title: 'Close-up: BEE-03 (true size)' },
  { id: 'TAKEOFF', label: 'Take-off', title: 'Tripod at the launch pad, tracking the mother drone' },
];

const LAYERS: [keyof ViewSettings, string][] = [
  ['showHeatmap', 'Heat-map'],
  ['showEvacRoute', 'Evac route'],
  ['showLinks', 'Links'],
  ['showRoutes', 'Routes'],
];

/** Small control cluster floating over the 3D view (bottom-left), plus the sidebar handle. */
export function ViewportControls() {
  const v = useViewSettings();
  const fs = useFullscreen();
  return (
    <>
      <div className="vp-controls" role="toolbar" aria-label="3D view controls">
        <div className="seg view-switch" role="group" aria-label="Main view">
          <button className={v.mainView === '3d' ? 'on' : ''} onClick={() => viewSettings.set({ mainView: '3d' })} title="Live 3D simulation (V)">
            3D
          </button>
          <button className={v.mainView === 'aerial' ? 'on' : ''} onClick={() => viewSettings.set({ mainView: 'aerial' })} title="Aerial radiation map (V)">
            Aerial map
          </button>
        </div>
        {v.mainView === '3d' && (
        <div className="seg" role="group" aria-label="Camera">
          {CAMS.map((c) => (
            <button
              key={c.id}
              className={v.cameraMode === c.id ? 'on' : ''}
              title={c.key ? `${c.label} (${c.key})` : `Follow ${c.label}`}
              onClick={() => viewSettings.set({ cameraMode: c.id, cameraNonce: v.cameraNonce + 1 })}
            >
              {c.label}
            </button>
          ))}
        </div>
        )}
        {v.mainView === '3d' && (
        <div className="seg" role="group" aria-label="Close-up cameras">
          <span className="seg-label">Close-up</span>
          {CLOSE.map((c) => (
            <button
              key={c.id}
              className={v.cameraMode === c.id ? 'on' : ''}
              title={c.title}
              onClick={() => viewSettings.set({ cameraMode: c.id, cameraNonce: v.cameraNonce + 1 })}
            >
              {c.label}
            </button>
          ))}
        </div>
        )}
        <div className="seg" role="group" aria-label="Map layers">
          {LAYERS.map(([k, label]) => (
            <button key={k} className={v[k] ? 'on' : ''} aria-pressed={!!v[k]} onClick={() => viewSettings.set({ [k]: !v[k] } as Partial<ViewSettings>)}>
              {label}
            </button>
          ))}
        </div>
        {v.mainView === '3d' && (
          <button
            className={`btn icon${v.cleanView ? ' on' : ''}`}
            aria-pressed={v.cleanView}
            onClick={() => viewSettings.set({ cleanView: !v.cleanView })}
            title="Clean view: hide all overlays (C)"
          >
            {v.cleanView ? '◉ Clean view' : '○ Clean view'}
          </button>
        )}
        <button className="btn icon" onClick={toggleFullscreen} title="Full screen (F)">
          {fs ? '⤡ Exit full screen' : '⤢ Full screen'}
        </button>
      </div>
      <button
        className={`sidebar-handle ${v.sidebarOpen ? 'open' : ''}`}
        onClick={() => viewSettings.set({ sidebarOpen: !v.sidebarOpen })}
        title={v.sidebarOpen ? 'Hide dashboard (S)' : 'Show dashboard (S)'}
        aria-label={v.sidebarOpen ? 'Hide dashboard' : 'Show dashboard'}
      >
        {v.sidebarOpen ? '›' : '‹ Dashboard'}
      </button>
    </>
  );
}
