import { commsStats, swarmStatus } from '../../sim';
import { simController } from '../../state/simController';
import { Card, Stat, age, fmt } from './common';

const COLORS: Record<string, string> = { 'BEE-01': '#22d3ee', 'BEE-02': '#f472b6', 'BEE-03': '#a3e635' };

function Bar({ v, label }: { v: number | null; label: string }) {
  const pct = v === null ? 0 : Math.round(v * 100);
  return (
    <div className="qbar" title={label}>
      <div className="qbar-track">
        <div className={`qbar-fill ${v === null ? '' : v >= 0.8 ? 'good' : v >= 0.5 ? 'mid' : 'bad'}`} style={{ width: `${pct}%` }} />
      </div>
      <span>{v === null ? '—' : `${pct}%`}</span>
    </div>
  );
}

export function SwarmPanel() {
  const e = simController.engine;
  const s = e.state;
  const sw = swarmStatus(s, e.config, e.world);
  const st = commsStats(s.comms.messages);
  return (
    <>
      {sw.map((d) => (
        <Card
          key={d.id}
          className="swarm"
          title={
            <>
              <i className="dot" style={{ background: COLORS[d.id] }} /> {d.id} <small className="muted">· {d.role}</small>
            </>
          }
          right={<span className={`pill link-${d.state.toLowerCase()}`}>{d.state === 'ONLINE' ? '● Online' : d.state === 'OFFLINE' ? '○ Offline' : '◌ Docked'}</span>}
        >
          {d.state === 'DOCKED' ? (
            <div className="card-empty">In the mother's bay — not transmitting.</div>
          ) : (
            <>
              <div className="kv">
                <span>Signal quality (est.)</span>
                <Bar v={d.signalQualityEst} label="Delivered share of this drone's last messages, from packet sequence numbers" />
                <span>Link model at position</span>
                <Bar v={d.modelLinkSuccess} label="Probability a packet sent now arrives, from the simulated link model" />
                <span>Latency</span>
                <b>
                  {fmt(d.latencyMean_ms, 0)} ms mean · {fmt(d.latencyLast_ms, 0)} ms last
                </b>
                <span>Packet delivery</span>
                <b>
                  {d.delivered}/{d.sent} ({d.deliveryRatio === null ? '—' : `${(d.deliveryRatio * 100).toFixed(1)}%`})
                </b>
                <span>Last successful comm</span>
                <b>{age(s.time, d.lastRxTime)}</b>
                <span>Route</span>
                <b>{d.route === 'relay' ? 'via BEE-03 relay' : d.route === 'direct' ? 'direct to GS' : 'no route'} · {fmt(d.distanceToGs_m, 0)} m to GS</b>
                <span>Speed limits (config)</span>
                <b>
                  {(() => {
                    const pr = e.config.bee.profiles?.[d.id];
                    if (!pr) return `${e.config.bee.maxSpeedXZ} m/s cruise`;
                    return `${pr.maxSpeedXZ} m/s cruise · survey ${e.config.survey.speed_mps} · gap fill ${e.config.survey.gapFill.speed_mps} · slows near obstacles (≥ ${pr.obstacleSlowdownMinSpeed_mps}) and drones (≥ ${pr.trafficMinSpeed_mps})`;
                  })()}
                </b>
                {d.id === 'BEE-01' && s.survey.enabled && (
                  <>
                    <span>Reported activity</span>
                    <b>
                      {String(s.comms.gs.beeReports['BEE-01']?.fields.phase ?? '—').replace('_', ' ')}
                      {s.corridor.task ? ` · task ${s.corridor.task.taskId} ${s.corridor.task.state.replace('_', ' ').toLowerCase()} (${Math.round(s.corridor.task.progress * 100)}%)` : ''}
                    </b>
                  </>
                )}
              </div>
            </>
          )}
        </Card>
      ))}
      <Card title="Network">
        <div className="stat-row">
          <Stat label="Delivered" value={`${st.delivered}/${st.sent}`} sub={st.deliveryRatio === null ? '—' : `${(st.deliveryRatio * 100).toFixed(1)}%`} />
          <Stat label="Dropped" value={`${st.droppedLink} / ${st.droppedNoRoute}`} sub="link / no route" />
          <Stat label="Latency" value={fmt(st.latencyMean_ms, 0)} unit="ms" sub={`p95 ${fmt(st.latencyP95_ms, 0)} ms`} />
        </div>
        {s.comms.warnings.length > 0 && (
          <ul className="warn-list">
            {s.comms.warnings.map((w) => (
              <li key={`${w.code}${w.nodeId}`}>⚠ {w.message}</li>
            ))}
          </ul>
        )}
        <div className="note">
          Signal quality is estimated at the ground station from gaps in each drone's packet sequence numbers (last 10 messages). "Link model" is the
          simulated success probability for the current geometry. Online = a packet arrived within {e.config.alerts.droneOffline_s} s.
        </div>
      </Card>
    </>
  );
}
