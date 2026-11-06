import { missionAlerts, missionMilestones } from '../../sim';
import { simController } from '../../state/simController';
import { viewSettings } from '../../state/viewSettings';
import { Legend } from '../Legend';
import { Card, SevBadge, Stat, fmt } from './common';
import { PhaseStepper } from './PhaseStepper';

export function MissionPanel() {
  const e = simController.engine;
  const s = e.state;
  const ms = missionMilestones(s);
  const done = ms.filter((m) => m.done).length;
  const alerts = missionAlerts(s, e.config);
  const lc = s.mission.lifecycle;
  const status =
    s.status === 'READY'
      ? 'Ready'
      : s.status === 'COMPLETE'
        ? s.events.some((x) => x.type === 'MISSION_TIMEOUT')
          ? 'Timeout'
          : lc
            ? s.mission.phase === 'COMPLETE'
              ? 'Landed · complete'
              : 'Ended · incomplete'
            : 'Flight ended'
        : simController.running
          ? 'Running'
          : 'Paused';
  return (
    <>
      <Card title="Mission overview">
        <div className="stat-row">
          <Stat label="Sim time" value={fmt(s.time, 1)} unit="s" />
          <Stat label="Status" value={status} />
          <Stat label="Progress" value={`${done}/${ms.length}`} sub={`${Math.round((done / ms.length) * 100)}%`} />
        </div>
        <PhaseStepper s={s} />
        <div className="runline">
          scenario <code>{e.world.scenarioId}</code> · run <code>{e.runId}</code> · seed <code>{e.config.seed}</code>
        </div>
        <details className="ms-details" open={!lc}>
          <summary>Milestones ({done}/{ms.length})</summary>
        <ol className="milestones">
          {ms.map((m) => (
            <li key={m.key} className={m.done ? 'done' : ''}>
              <i aria-hidden>{m.done ? '✓' : '○'}</i>
              <span>{m.label}</span>
              <em>{m.time === null ? '' : `t = ${m.time.toFixed(1)} s`}</em>
            </li>
          ))}
        </ol>
        </details>
        {s.status === 'COMPLETE' && ms.some((m) => !m.done) && (
          <div className="note">The simulated flight has ended. Remaining steps (rescue request, evacuation confirmation) are operator actions in the Evacuation tab.</div>
        )}
      </Card>

      <Card title={`Alerts (${alerts.length})`}>
        {alerts.length === 0 ? (
          <div className="ok-line">✓ No active alerts</div>
        ) : (
          <ul className="alerts">
            {alerts.map((a, i) => (
              <li key={`${a.code}${a.source}${i}`} className={`al-${a.severity}`}>
                <SevBadge sev={a.severity} />
                <div>
                  <div>{a.message}</div>
                  <small>
                    {a.code} · {a.source}
                    {a.since !== null ? ` · since t = ${a.since.toFixed(1)} s` : ''}
                  </small>
                </div>
                {(a.code.startsWith('PATIENT') || a.code.startsWith('ROUTE') || a.code.startsWith('CORRIDOR')) && (
                  <button className="link-btn" onClick={() => viewSettings.set({ sidebarTab: a.code.startsWith('ROUTE') || a.code.startsWith('CORRIDOR') ? 'evac' : 'patients' })}>
                    open
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="note">Alert levels are illustrative simulation settings (Scenario menu), not operational limits.</div>
      </Card>

      <Legend />
    </>
  );
}
