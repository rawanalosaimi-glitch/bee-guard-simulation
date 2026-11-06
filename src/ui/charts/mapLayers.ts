import { gsSurveyView, radiationStats, recommendedRoute } from '../../sim';
import type { SimEngine } from '../../sim';
import { radiationGrid } from '../../state/derived';
import type { AerialMapProps } from './AerialMap';

/** Everything the aerial map overlays, from ground-station data (or the on-board log for the heat layer). */
export function mapLayers(engine: SimEngine, source: 'gs' | 'onboard', showRoutes: boolean): Omit<AerialMapProps, 'variant'> {
  const s = engine.state;
  const cfg = engine.config;
  const grid = radiationGrid(engine, source);
  const st = radiationStats(s.comms.gs.radiationSamples, s, cfg);
  const peakS = source === 'gs' ? st.peak : s.radiation.peakMeasured;
  const rec = recommendedRoute(s, cfg);
  const sv = gsSurveyView(s, cfg, engine.world);
  const cs = s.corridor;
  return {
    grid,
    peak: peakS ? { x: peakS.x, z: peakS.z, v: peakS.measured_uSv_h } : null,
    routes: showRoutes && rec ? [{ runs: rec.runs }] : [],
    candidates:
      showRoutes && cs.enabled
        ? cs.candidates.map((k) => ({ id: k.id, points: k.waypoints, status: cs.evaluations.find((x) => x.candidateId === k.id)?.status ?? null, selected: k.id === cs.decision.selectedId }))
        : [],
    hotspots: sv && source === 'gs' ? sv.hotspots : [],
    surveyArea: sv ? cfg.survey.area : null,
    rescue: (() => {
      const p = s.rescue.current;
      if (!s.rescue.enabled || !p || !p.recommendedId) return null;
      return { sections: p.sections, start: p.start, status: p.status, id: p.recommendedId };
    })(),
  };
}
