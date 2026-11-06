import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { interpolateIdw, recommendedRoute, smoothedGrid } from '../sim';
import { buildEstimateField, buildHeatField } from './heatField';
import { radiationGrid } from '../state/derived';
import type { BeeId } from '../sim';
import { simController } from '../state/simController';
import { useSimTick } from '../state/hooks';
import { useViewSettings } from '../state/viewSettings';
import { doseScale, logNorm, rampRGB } from './colormap';

/**
 * Phase 2 overlays (read-only views of engine state):
 *  - radiation heat-map from MEASURED BEE-01 samples (never ground truth),
 *    unsampled cells drawn as hatched UNKNOWN
 *  - proposed evacuation route (planning only) + collection point
 *  - communication links as last used by each sender
 *  - casualty status ring
 */

const PX = 8; // texture pixels per grid cell

/**
 * 3D heat-map on the ground — built from the SAME display field as the aerial
 * map (viz/heatField.ts), so 2D and 3D show identical data:
 *  - MEASURED cells: smooth colour inside the measured region, soft inner edge,
 *    exactly transparent over unmeasured cells
 *  - optional ESTIMATE cells (IDW): faded + stippled
 *  - UNKNOWN cells inside the designated survey area: faint cool tint (no hatch —
 *    a fine hatch aliased into moiré stripes at viewing distance)
 */
export function RadiationHeatmap() {
  const version = useSimTick(2);
  const { showHeatmap, heatmapSource, mapEstimate, mapUnknown, mapSmooth, heatOpacity } = useViewSettings();
  const engine = simController.engine;
  const spec = engine.config.radiation.heatmap;
  const W = spec.nx * PX;
  const H = spec.nz * PX;
  const { texture, data } = useMemo(() => {
    const buf = new Uint8Array(W * H * 4);
    const t = new THREE.DataTexture(buf, W, H, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return { texture: t, data: buf };
  }, [W, H]);

  useEffect(() => () => texture.dispose(), [texture]);

  const grid = radiationGrid(engine, heatmapSource);
  useEffect(() => {
    const { lo, hi } = doseScale(engine.config.radiation.background_uSv_h, grid.max);
    // same display smoothing as the aerial map (measured cells only)
    const f = buildHeatField(mapSmooth ? smoothedGrid(grid) : grid, PX);
    const est = mapEstimate ? interpolateIdw(grid, 12, 2) : null;
    const ef = est && est.estimated ? buildEstimateField(grid, est, PX) : null;
    const area = engine.config.survey.enabled ? engine.config.survey.area : null;
    data.fill(0);
    for (let py = 0; py < H; py++) {
      // plane is rotated −90° about x: texture row 0 lies at the +z edge, so flip rows
      const row = H - 1 - py;
      const z = spec.z0 + ((py + 0.5) / PX) * spec.cell;
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        const o = (row * W + px) * 4;
        if (f.alpha[i] > 0) {
          const [r, g, b] = rampRGB(logNorm(f.value[i], lo, hi));
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          // semi-transparent like the aerial map; ×1.5 because an unlit overlay on sunlit 3D sand washes out (0.30 → 0.45, was a fixed 0.84)
          data[o + 3] = Math.round(255 * Math.min(1, 1.5 * heatOpacity) * f.alpha[i]);
        } else if (ef && ef.alpha[i] > 0) {
          const [r, g, b] = rampRGB(logNorm(ef.value[i], lo, hi));
          const dot = px % 3 === 1 && py % 3 === 1;
          data[o] = dot ? 15 : r;
          data[o + 1] = dot ? 23 : g;
          data[o + 2] = dot ? 42 : b;
          data[o + 3] = dot ? 150 : Math.round(95 * ef.alpha[i]);
        } else if (mapUnknown && area) {
          const x = spec.x0 + ((px + 0.5) / PX) * spec.cell;
          if (x >= area.x0 && x <= area.x1 && z >= area.z0 && z <= area.z1) {
            data[o] = 70;
            data[o + 1] = 90;
            data[o + 2] = 120;
            data[o + 3] = 34;
          }
        }
      }
    }
    texture.needsUpdate = true;
  }, [version, grid, spec, texture, data, engine, W, H, mapEstimate, mapUnknown, mapSmooth, heatOpacity]);

  if (!showHeatmap) return null;
  const w = spec.nx * spec.cell;
  const h = spec.nz * spec.cell;
  return (
    <mesh position={[spec.x0 + w / 2, 0.12, spec.z0 + h / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/** Proposed evacuation route (planning only): solid over measured ground, dashed over unknown ground. */
export function EvacRouteOverlay() {
  useSimTick(2);
  const { showEvacRoute, showRescueRoute } = useViewSettings();
  const engine = simController.engine;
  const rp = engine.state.rescue.current;
  const rescue = engine.state.rescue.enabled && rp && rp.recommendedId ? { sections: rp.sections, start: rp.start } : null;
  const ccp = engine.config.evacuation.collectionPoint.position;
  // the shown route: the corridor selection (Phase 3A) or the planner route
  const recs = engine.state.evacuation.cases.map((c) => recommendedRoute(engine.state, engine.config, c.patientId)).filter((p): p is NonNullable<typeof p> => !!p);
  const cs = engine.state.corridor;
  const area = engine.config.survey.area;
  const statusColor: Record<string, string> = { SURVEYED: '#4ade80', PARTIAL: '#fbbf24', UNKNOWN: '#94a3b8' };
  return (
    <group>
      {/* collection point marker (always shown) */}
      <mesh position={[ccp.x, 0.08, ccp.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.2, 2.7, 4, 1]} />
        <meshBasicMaterial color="#e5e7eb" transparent opacity={0.85} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[ccp.x, 2, ccp.z]}>
        <cylinderGeometry args={[0.06, 0.06, 4, 6]} />
        <meshBasicMaterial color="#e5e7eb" />
      </mesh>
      <mesh position={[ccp.x + 0.5, 3.6, ccp.z]}>
        <boxGeometry args={[1, 0.6, 0.03]} />
        <meshBasicMaterial color="#22c55e" />
      </mesh>
      {/* designated survey area (Phase 3A) */}
      {engine.config.survey.enabled && (
        <Line
          points={[
            [area.x0, 0.25, area.z0],
            [area.x1, 0.25, area.z0],
            [area.x1, 0.25, area.z1],
            [area.x0, 0.25, area.z1],
            [area.x0, 0.25, area.z0],
          ]}
          color="#22d3ee"
          lineWidth={1.5}
          dashed
          dashSize={2}
          gapSize={1.5}
          transparent
          opacity={0.7}
        />
      )}
      {/* other candidate corridors (thin, coloured by survey status) */}
      {showEvacRoute &&
        cs.enabled &&
        cs.candidates
          .filter((k) => k.id !== cs.decision.selectedId && k.waypoints.length >= 2)
          .map((k) => (
            <Line
              key={`cand-${k.id}`}
              points={k.waypoints.map((q) => [q.x, 0.3, q.z] as [number, number, number])}
              color={statusColor[cs.evaluations.find((x) => x.candidateId === k.id)?.status ?? 'UNKNOWN']}
              lineWidth={1.5}
              transparent
              opacity={0.6}
            />
          ))}
      {showEvacRoute &&
        recs.map((p, pi) =>
          p.runs.map((r, i) => (
            <Line
              key={`${pi}-${p.candidateId ?? 'plan'}-${i}`}
              points={r.points.map((q) => [q.x, 0.35, q.z] as [number, number, number])}
              color={r.known ? '#22c55e' : '#f8fafc'}
              lineWidth={r.known ? 4 : 3}
              dashed={!r.known}
              dashSize={1.6}
              gapSize={1.1}
              transparent
              opacity={0.95}
            />
          )),
        )}
      {/* Phase 3B+: recommended RESCUE-TEAM route — thin green screen-space line (2 px; dashed = estimate only, dotted = no data) */}
      {showRescueRoute &&
        rescue &&
        rescue.sections.map((sec, i) =>
          sec.points.length >= 2 ? (
            <Line
              key={`rescue-${i}`}
              points={sec.points.map((q) => [q.x, 0.42, q.z] as [number, number, number])}
              color="#28C76F"
              lineWidth={2}
              transparent
              opacity={0.95}
              dashed={sec.kind !== 'MEASURED'}
              dashSize={sec.kind === 'ESTIMATED' ? 1.6 : 0.35}
              gapSize={0.9}
            />
          ) : null,
        )}
      {showRescueRoute && rescue && (
        <group position={[rescue.start.x, 0, rescue.start.z]}>
          <mesh position={[0, 1.4, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 2.8, 6]} />
            <meshBasicMaterial color="#e5e7eb" />
          </mesh>
          <mesh position={[0.5, 2.5, 0]}>
            <boxGeometry args={[1, 0.6, 0.03]} />
            <meshBasicMaterial color="#28C76F" />
          </mesh>
        </group>
      )}
    </group>
  );
}

const LINK_OK = '#4ade80';
const LINK_LOST = '#f87171';

export function CommLinks() {
  useSimTick(4);
  const { showLinks, overlayStyle } = useViewSettings();
  if (!showLinks) return null;
  const clean = overlayStyle === 'clean';
  const engine = simController.engine;
  const s = engine.state;
  const cfg = engine.config.comms;
  const g = engine.world.groundStation.position;
  const gs: [number, number, number] = [g.x, g.y + cfg.gsAntennaHeight_m, g.z];
  const pos = (id: string): [number, number, number] => {
    const b = s.bees.find((x) => x.id === id)!;
    return [b.position.x, b.position.y, b.position.z];
  };
  const lines: { key: string; pts: [number, number, number][]; color: string; dashed: boolean }[] = [];
  for (const id of ['BEE-01', 'BEE-02', 'BEE-03'] as BeeId[]) {
    const b = s.bees.find((x) => x.id === id)!;
    if (b.mode === 'DOCKED' || b.mode === 'RELEASING') continue;
    const route = s.comms.lastRoute[id];
    const up = s.comms.linkUp[id];
    if (route === 'direct') lines.push({ key: id, pts: [pos(id), gs], color: up ? LINK_OK : LINK_LOST, dashed: !up });
    else if (route === 'relay') lines.push({ key: id, pts: [pos(id), pos(cfg.relayId), gs], color: up ? LINK_OK : LINK_LOST, dashed: !up });
  }
  return (
    <group>
      {lines.map((l) => (
        // Stage 5 clean style: healthy links thin and faint; a LOST link (dashed) keeps full emphasis
        <Line key={l.key} points={l.pts} color={l.color} lineWidth={clean && !l.dashed ? 0.8 : 1.2} transparent opacity={clean && !l.dashed ? 0.3 : 0.65} dashed={l.dashed} dashSize={2} gapSize={1.5} />
      ))}
    </group>
  );
}

const RING_COLORS: Record<string, string> = {
  NOT_DETECTED: '#9ca3af',
  IN_RANGE: '#9ca3af',
  DETECTED: '#fbbf24',
  ASSESSING: '#fbbf24',
  ASSESSMENT_TIMEOUT: '#9ca3af',
  LOW: '#4ade80',
  MODERATE: '#fb923c',
  HIGH: '#ef4444',
};

/** Casualty ring coloured by what the GROUND STATION knows (grey = not reported). */
export function CasualtyStatusRing() {
  useSimTick(3);
  const ring = useRef<THREE.Mesh>(null);
  const engine = simController.engine;
  const p = engine.world.casualty.position;
  const rec = engine.state.comms.gs.patients.find((x) => x.patientId === engine.world.casualty.id);
  const key = !rec ? 'NOT_DETECTED' : rec.assessment ? rec.assessment.risk : 'DETECTED';
  useFrame(({ clock }) => {
    if (ring.current) ring.current.scale.setScalar(1 + 0.08 * Math.sin(clock.elapsedTime * 3)); // decorative pulse
  });
  return (
    <mesh ref={ring} position={[p.x, 0.07, p.z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.6, 1.9, 40]} />
      <meshBasicMaterial color={RING_COLORS[key] ?? '#9ca3af'} transparent opacity={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}
