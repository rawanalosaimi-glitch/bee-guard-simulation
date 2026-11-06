import { Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { ControlBar } from './ui/ControlBar';
import { Dashboard } from './ui/Dashboard';
import { ViewportControls } from './ui/ViewportControls';
import { useViewSettings } from './state/viewSettings';
import { AerialMap } from './ui/charts/AerialMap';
import { mapLayers } from './ui/charts/mapLayers';
import { simController } from './state/simController';
import { useSimTick } from './state/hooks';

/** Full-viewport aerial radiation map (live, 4 Hz). */
function AerialMain() {
  useSimTick(4);
  const v = useViewSettings();
  const layers = mapLayers(simController.engine, v.heatmapSource, v.showEvacRoute);
  return <AerialMap variant="full" frame="site" {...layers} />;
}

import { PerfHud } from './ui/PerfHud';
const Scene = lazy(() => import('./viz/Scene'));

class ViewBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="view-fallback">
          <b>3D view unavailable</b>
          <span>{this.state.error}</span>
          <span>The simulation, dashboard and exports keep working. Check that WebGL / hardware acceleration is enabled.</span>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Mission Control layout: the 3D simulation fills the main area; the
 * dashboard is a collapsible sidebar BESIDE it (never on top of the scene).
 */
export default function App() {
  const { sidebarOpen, mainView } = useViewSettings();
  return (
    <div className="app">
      <ControlBar />
      <main className={`mc ${sidebarOpen ? 'with-sidebar' : 'no-sidebar'}`}>
        <section className="viewport" aria-label="3D simulation view">
          <ViewBoundary>
            <Suspense fallback={<div className="view-fallback">Loading 3D scene…</div>}>
              <Scene />
            </Suspense>
          </ViewBoundary>
          {mainView === 'aerial' && <AerialMain />}
          {mainView === '3d' && <div className="vp-sim-tag">SIMULATION · all values simulated</div>}
          <PerfHud />
          <ViewportControls />
        </section>
        {sidebarOpen && <Dashboard />}
      </main>
    </div>
  );
}
