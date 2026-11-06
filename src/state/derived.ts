import { buildGrid, buildHeatmap, gsRadiationGrid } from '../sim';
import type { HeatmapGrid, SimEngine } from '../sim';

/**
 * Small memo layer so the 3D view and the dashboard share ONE grid per
 * (engine, source, sample count) instead of rebuilding it per component.
 */
const caches = new Map<string, { engine: SimEngine; n: number; grid: HeatmapGrid }>();

export function radiationGrid(engine: SimEngine, source: 'gs' | 'onboard'): HeatmapGrid {
  const n = source === 'gs' ? engine.state.comms.gs.radiationSamples.length : engine.state.radiation.samples.length;
  const cache = caches.get(source);
  if (cache && cache.engine === engine && cache.n === n) return cache.grid;
  const grid =
    source === 'gs'
      ? gsRadiationGrid({ state: engine.state, config: engine.config })
      : buildHeatmap(engine.state.radiation.samples, engine.config.radiation.heatmap, 'measured');
  caches.set(source, { engine, n, grid });
  return grid;
}

export { buildGrid };
