import { Line } from '@react-three/drei';
import { BEE_IDS, DEFAULT_CONFIG, MOTHER_ID, WORLD } from '../sim';
import { simController } from '../state/simController';
import { useSimTick } from '../state/hooks';
import { cameraSubject, useViewSettings } from '../state/viewSettings';
import { DeclutterHtml } from './LabelDeclutter';
import { LABEL_PRIORITY, activeLeg, fadingTrail } from './overlayStyle';

/** Flown trails — built from engine.state.trails (recorded samples) + live position. */
export function Trails() {
  useSimTick(4);
  const { showTrails, overlayStyle, cameraMode } = useViewSettings();
  if (!showTrails) return null;
  const clean = overlayStyle === 'clean';
  const followed = cameraSubject(cameraMode);
  const s = simController.engine.state;
  const items: { id: string; color: string; pts: [number, number, number][] }[] = [];
  const m = s.trails[MOTHER_ID];
  items.push({
    id: MOTHER_ID,
    color: '#f8fafc',
    pts: [...m.map((p) => [p.x, p.y, p.z] as [number, number, number]), [s.mother.position.x, s.mother.position.y, s.mother.position.z]],
  });
  for (const b of s.bees) {
    if (b.mode === 'DOCKED') continue;
    const t = s.trails[b.id];
    items.push({
      id: b.id,
      color: DEFAULT_CONFIG.routes[b.id].color,
      pts: [...t.map((p) => [p.x, p.y, p.z] as [number, number, number]), [b.position.x, b.position.y, b.position.z]],
    });
  }
  return (
    <group>
      {items
        .filter((i) => i.pts.length >= 2)
        .map((i) =>
          !clean || i.id === followed ? (
            <Line key={i.id} points={i.pts} color={i.color} lineWidth={i.id === MOTHER_ID ? 1.5 : 2.5} transparent opacity={0.9} />
          ) : (
            // Stage 5 clean style: only the last ~30 s, thin, fading toward the oldest end
            fadingTrail(i.pts).map((piece, k) => (
              <Line key={`${i.id}-${k}`} points={piece.pts} color={i.color} lineWidth={i.id === MOTHER_ID ? 1 : 1.3} transparent opacity={0.1 + 0.4 * piece.age} />
            ))
          ),
        )}
    </group>
  );
}

/**
 * Planned waypoint routes — the exact waypoint lists the engine follows (bee.route).
 * BEE-01's generated survey route is long, so only its active waypoint gets a marker
 * and the line shows the part still to be flown (plus a faint full plan).
 */
export function Routes() {
  useSimTick(2);
  const { showRoutes, showLabels: labels3d, mainView, overlayStyle, cameraMode } = useViewSettings();
  const showLabels = labels3d && mainView === '3d';
  if (!showRoutes) return null;
  const s = simController.engine.state;
  const followed = cameraSubject(cameraMode);
  return (
    <group>
      {BEE_IDS.map((id) => {
        if (overlayStyle === 'clean' && id !== followed) return <CleanRoute key={id} id={id} />;
        const color = DEFAULT_CONFIG.routes[id].color;
        const bee = s.bees.find((b) => b.id === id)!;
        const route = bee.route;
        if (!route.length) return null;
        const long = route.length > 12;
        const finished = bee.mode === 'LOITER' || bee.mode === 'HOLD';
        const pts = route.map((w) => [w.x, w.y, w.z] as [number, number, number]);
        const ahead = route.slice(Math.min(bee.waypointIndex, route.length - 1)).map((w) => [w.x, w.y, w.z] as [number, number, number]);
        return (
          <group key={id}>
            <Line points={pts.length >= 2 ? pts : [pts[0], pts[0]]} color={color} lineWidth={1} dashed dashSize={1.5} gapSize={1.2} transparent opacity={long ? 0.22 : 0.55} />
            {long && !finished && ahead.length >= 2 && <Line points={ahead} color={color} lineWidth={1.4} dashed dashSize={1.5} gapSize={1.2} transparent opacity={0.6} />}
            {route.map((w, i) => {
              const done = i < bee.waypointIndex || finished;
              const active = i === bee.waypointIndex && !finished && bee.mode !== 'DOCKED';
              if (long && !active) return null;
              return (
                <group key={i} position={[w.x, w.y, w.z]}>
                  <mesh>
                    <octahedronGeometry args={[active ? 0.7 : 0.45, 0]} />
                    <meshBasicMaterial color={color} transparent opacity={done ? 0.35 : active ? 1 : 0.7} wireframe={!active} />
                  </mesh>
                  {active && showLabels && (
                    <DeclutterHtml id={`wp-${id}`} priority={id === followed ? LABEL_PRIORITY.followed - 1 : LABEL_PRIORITY.waypoint} position={[0, 1.4, 0]} zIndex={10}>
                      <div className="wp-tag" style={{ color }}>
                        {id.slice(-2)}·WP{i + 1}
                        {w.tag && w.tag !== 'ROUTE' ? ` ${w.tag}` : ''}
                      </div>
                    </DeclutterHtml>
                  )}
                </group>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

/**
 * Stage 5 clean style for a drone that is not being followed: no full plan and no labels — only the
 * active leg (drone → next two waypoints), thin and faint, with a small marker on the next waypoint.
 */
function CleanRoute({ id }: { id: (typeof BEE_IDS)[number] }) {
  const s = simController.engine.state;
  const bee = s.bees.find((b) => b.id === id)!;
  if (!bee.route.length || bee.mode === 'LOITER' || bee.mode === 'HOLD' || bee.mode === 'DOCKED') return null;
  const color = DEFAULT_CONFIG.routes[id].color;
  const leg = activeLeg(
    [bee.position.x, bee.position.y, bee.position.z],
    bee.route.map((w) => [w.x, w.y, w.z] as [number, number, number]),
    bee.waypointIndex,
  );
  if (leg.length < 2) return null;
  const next = leg[1];
  return (
    <group>
      <Line points={leg} color={color} lineWidth={1} dashed dashSize={1.5} gapSize={1.2} transparent opacity={0.45} />
      <mesh position={next}>
        <octahedronGeometry args={[0.45, 0]} />
        <meshBasicMaterial color={color} transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

/** Static labels for scenario features. */
export function FeatureLabels() {
  useSimTick(1);
  const { showLabels, mainView } = useViewSettings();
  if (!showLabels || mainView !== '3d') return null;
  const rad = simController.engine.config.radiation;
  const f = [
    { id: 'feat-rad', p: rad.sourcePosition, text: `RAD SOURCE · ${rad.sourceStrength_uSv_h_at_1m} µSv/h @1 m (sim)`, cls: 'feat-rad', dy: 4, prio: LABEL_PRIORITY.radSource },
    { id: 'feat-cas', p: WORLD.casualty.position, text: 'CASUALTY ×1', cls: 'feat-cas', dy: 3, prio: LABEL_PRIORITY.casualty },
    { id: 'feat-gs', p: WORLD.groundStation.position, text: 'GROUND STATION', cls: 'feat-gs', dy: 11, prio: LABEL_PRIORITY.groundStation },
    { id: 'feat-ccp', p: simController.engine.config.evacuation.collectionPoint.position, text: 'CCP-1 · collection point', cls: 'feat-ccp', dy: 6, prio: LABEL_PRIORITY.ccp },
  ];
  return (
    <group>
      {f.map((x) => (
        <DeclutterHtml key={x.id} id={x.id} priority={x.prio} position={[x.p.x, x.p.y + x.dy, x.p.z]} zIndex={5}>
          <div className={`feat ${x.cls}`}>{x.text}</div>
        </DeclutterHtml>
      ))}
    </group>
  );
}
