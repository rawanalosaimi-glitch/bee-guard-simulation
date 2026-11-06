import { usePerf } from '../viz/perf';
import { useViewSettings, viewSettings } from '../state/viewSettings';

/** Small FPS / frame-time indicator over the 3D view (Stage 4). Click to hide. */
export function PerfHud() {
  const p = usePerf();
  const { showPerf, mainView } = useViewSettings();
  if (!showPerf) return null;
  const paused = mainView !== '3d';
  const cls = !p || paused ? 'idle' : p.fps >= 50 ? 'ok' : p.fps >= 28 ? 'warn' : 'bad';
  return (
    <button className={`perf-hud ${cls}`} onClick={() => viewSettings.set({ showPerf: false })} title="Rendering performance (wall-clock frame interval, last 240 frames; draw calls and triangles of the last frame). Click to hide — re-enable in View.">
      {!p ? (
        'measuring…'
      ) : paused ? (
        <>3D paused · {p.quality}</>
      ) : (
        <>
          <b>{p.fps.toFixed(0)}</b> fps · {p.frameMs.toFixed(1)} ms <span>p95 {p.p95Ms.toFixed(1)}</span>
          <br />
          {p.calls} calls · {(p.triangles / 1000).toFixed(0)}k tris · {p.quality} · DPR {p.dpr.toFixed(2)} · shadows {p.shadows}
        </>
      )}
    </button>
  );
}
