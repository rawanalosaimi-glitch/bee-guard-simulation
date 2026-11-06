import { DEFAULT_CONFIG } from '../sim';
import type { BeeState, MotherState } from '../sim';
import { simController } from '../state/simController';
import { useSimTick } from '../state/hooks';

const wpText = (b: BeeState) => {
  const w = b.route[Math.min(b.waypointIndex, b.route.length - 1)];
  if (!w) return '—';
  return `${w.x.toFixed(0)}, ${w.y.toFixed(0)}, ${w.z.toFixed(0)}`;
};

const f = (n: number, d = 2) => (Object.is(Number(n.toFixed(d)), -0) ? (0).toFixed(d) : n.toFixed(d));

function Row({ e, color }: { e: MotherState | BeeState; color: string }) {
  const speed = Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z);
  return (
    <div className={`tel-row mode-${e.mode.toLowerCase()}`}>
      <div className="tel-head">
        <span className="dot" style={{ background: color }} />
        <span className="tel-id">{e.id}</span>
        <span className="tel-mode">{e.mode}</span>
      </div>
      <div className="tel-status">{e.missionStatus}</div>
      <div className="tel-xyz">
        <span>
          <i>X</i>
          {f(e.position.x)}
        </span>
        <span>
          <i>Y</i>
          {f(e.position.y)}
        </span>
        <span>
          <i>Z</i>
          {f(e.position.z)}
        </span>
        <span>
          <i>|v|</i>
          {f(speed)}
        </span>
      </div>
      {e.type === 'mother' && (
        <div className="tel-extra">
          Hatch <b>{Math.round(e.hatchOpen * 100)}%</b> · Released <b>{e.releasedCount}/3</b>
        </div>
      )}
      {e.type === 'bee' && (
        <div className="tel-extra">
          {e.mode === 'DOCKED' ? (
            <>Awaiting release</>
          ) : (
            <>
              {e.mode === 'LOITER' || e.mode === 'HOLD' ? 'Holding' : 'Target'} WP{Math.min(e.waypointIndex + 1, e.waypointTotal)}{' '}
              <b>({wpText(e)})</b>
            </>
          )}
          {e.avoidanceActive && e.avoidanceObstacleId ? (
            <>
              {' '}
              · near <b>{e.avoidanceObstacleId}</b>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function TelemetryPanel() {
  useSimTick(10);
  const engine = simController.engine;
  const s = engine.state;
  const done = s.bees.filter((b) => b.mode === 'LOITER').length;
  const missionLabel =
    s.status === 'READY'
      ? 'Ready'
      : s.status === 'COMPLETE'
        ? s.events.some((e) => e.type === 'MISSION_TIMEOUT')
          ? 'Stopped (timeout)'
          : 'Complete'
        : simController.running
          ? 'Running'
          : 'Paused';
  return (
    <aside className="panel telemetry">
      <div className="panel-title">
        Telemetry <span className="muted">engine state · {1 / engine.config.dt} Hz fixed step</span>
      </div>
      <div className="kpis">
        <div>
          <label>Sim time</label>
          <b>{f(s.time, 2)} s</b>
        </div>
        <div>
          <label>Step</label>
          <b>{s.step}</b>
        </div>
        <div>
          <label>Mission</label>
          <b className={`st-${s.status.toLowerCase()}`}>{missionLabel}</b>
        </div>
        <div>
          <label>Routes done</label>
          <b>{done}/3</b>
        </div>
      </div>
      <div className="runline">
        run <code>{engine.runId}</code> · speed {simController.speed}× · {s.samples.length} samples · {s.events.length} events
      </div>
      <Row e={s.mother} color="#e5e7eb" />
      {s.bees.map((b) => (
        <Row key={b.id} e={b} color={DEFAULT_CONFIG.routes[b.id].color} />
      ))}
      <div className="frame-note">Frame: x east · y up · z south (m). Velocities m/s.</div>
    </aside>
  );
}
