import { patientViews } from '../../sim';
import type { PatientView } from '../../sim';
import { simController } from '../../state/simController';
import { missionArchive, useMissionArchive } from '../../state/missionArchive';
import { Sparkline } from '../charts/Sparkline';
import { age, fmt } from './common';

/**
 * Patient dashboard: ONE main card per patient, containing exactly FOUR tiles
 * (Heart rate · Respiratory rate · Body temperature · Alert). Everything comes from
 * data RECEIVED at the ground station. Phase 3B+: once received, the casualty
 * record is never blanked — when the live feed stops (link lost, stale, or
 * BEE-02 recalled for recovery) the tiles keep the LAST RECORDED values,
 * clearly labelled as such with their timestamps; values never received show
 * N/A. §40: the Body Temperature tile shows BEE-02's non-contact IR reading,
 * i.e. SKIN (surface) temperature — never labelled as core temperature; with no
 * valid reading it shows "-- °C · UNAVAILABLE". The illustrative risk class still
 * drives the Alert tile (its own tile was replaced). SpO₂ is not simulated.
 */
const HR_COLOR = '#f87171';
const RR_COLOR = '#38bdf8';
const TEMP_COLOR = '#fb923c';

function ThermometerIcon() {
  return (
    <svg className="pm-thermo" width="10" height="14" viewBox="0 0 10 14" aria-hidden>
      <path d="M3.4 1.6a1.6 1.6 0 0 1 3.2 0v6.6a3 3 0 1 1-3.2 0z" fill="none" stroke={TEMP_COLOR} strokeWidth="1.2" />
      <circle cx="5" cy="10.6" r="1.5" fill={TEMP_COLOR} />
      <path d="M5 4.2v5" stroke={TEMP_COLOR} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** §40 Body temperature tile — SKIN (surface) temperature from BEE-02's non-contact IR sensor. */
function TemperatureTile({ p, stale }: { p: PatientView; stale: boolean }) {
  const t = p.temperature;
  const has = t.skin_c !== null;
  const st = t.status === 'LIVE' ? 'LIVE' : t.status === 'LAST_RECORDED' ? 'LAST RECORDED' : 'UNAVAILABLE';
  return (
    <div className={`pm-tile temp ${has ? '' : 'temp-na'}`} title={`${t.site}${t.reason ? ` · ${t.reason}` : ''}`}>
      <div className="pm-label">
        <ThermometerIcon /> Body Temperature
      </div>
      <div className="pm-value">
        {has ? (t.skin_c as number).toFixed(1) : '--'}
        <small> °C</small>
        {has && t.sigma_c !== null && <small className="pm-sigma"> ± {t.sigma_c.toFixed(1)}</small>}
      </div>
      <div className="pm-temp-meta">
        <span className={`pm-temp-status st-${t.status.toLowerCase()}`}>{st}</span>
        {has ? <span>skin · IR · not core{t.sampleTime !== null ? ` · t = ${t.sampleTime.toFixed(0)} s` : ''}</span> : <span>{t.reason}</span>}
      </div>
      <Sparkline points={p.record.temperatureHistory.map((h) => ({ t: h.t, v: h.skin_c }))} color={TEMP_COLOR} yMin={30} yMax={38} dim={stale} height={26} ariaLabel="Skin temperature trend of received readings" />
    </div>
  );
}

function alertFor(p: PatientView): { level: 'crit' | 'warn' | 'info' | 'ok'; title: string; text: string } {
  const a = p.record.assessment;
  if (!a && p.dataState === 'UNAVAILABLE') return { level: 'warn', title: 'Data unavailable', text: p.unavailableReason ?? 'no recent data' };
  if (!a) return { level: 'info', title: 'Assessing', text: 'Awaiting assessment' };
  if (a.risk === 'HIGH') return { level: 'crit', title: 'High risk', text: 'Prioritise evacuation' };
  if (a.risk === 'MODERATE') return { level: 'warn', title: 'Moderate risk', text: 'Monitor closely' };
  return { level: 'ok', title: 'No alert', text: 'Within illustrative bands' };
}

function PatientCard({ p }: { p: PatientView }) {
  const r = p.record;
  // live = feed active; otherwise the tiles show the LAST RECORDED values (never blanked)
  const live = p.dataState === 'ASSESSED' || p.dataState === 'DETECTED';
  const stale = !live;
  const v = r.latestVitals;
  const hist = r.vitalsHistory;
  const al0 = alertFor(p);
  const al = stale && r.assessment ? { ...al0, text: `${al0.text} · last recorded` } : al0;
  const hr = v ? v.hr : null;
  const rr = v ? v.rr : null;
  const now = simController.engine.state.time;
  const why = p.feedEndedReason ?? p.unavailableReason;
  return (
    <section className={`patient-main ${stale ? 'recorded' : ''}`} aria-label={`Patient ${r.patientId}`}>
      <header>
        <span className="pm-id">
          <i aria-hidden>✚</i> Patient {r.patientId}
        </span>
        <span className={`pm-feed ${live ? 'live' : 'rec'}`} title={why ?? 'receiving data from ' + r.reportedBy}>
          {live ? '● LIVE' : `■ LAST RECORDED${v ? ` · t = ${v.sampleTime.toFixed(0)} s` : ''}`}
        </span>
        <span className="sim-chip">SIMULATED</span>
      </header>
      <div className="pm-grid">
        <div className="pm-tile">
          <div className="pm-label">
            <i style={{ color: HR_COLOR }} aria-hidden>
              ♥
            </i>{' '}
            Heart Rate
          </div>
          <div className="pm-value">
            {hr === null ? 'N/A' : hr.toFixed(0)}
            {hr !== null && <small> bpm</small>}
          </div>
          <Sparkline points={hist.map((h) => ({ t: h.t, v: h.hr }))} color={HR_COLOR} yMin={40} yMax={160} band={[51, 90]} dim={stale} ariaLabel="Heart rate trend of received samples" />
        </div>
        <div className="pm-tile">
          <div className="pm-label">
            <i style={{ color: RR_COLOR }} aria-hidden>
              ≋
            </i>{' '}
            Respiratory Rate
          </div>
          <div className="pm-value">
            {rr === null ? 'N/A' : rr.toFixed(0)}
            {rr !== null && <small> breaths/min</small>}
          </div>
          <Sparkline points={hist.map((h) => ({ t: h.t, v: h.rr }))} color={RR_COLOR} yMin={6} yMax={40} band={[12, 20]} dim={stale} ariaLabel="Respiratory rate trend of received samples" />
        </div>
        <TemperatureTile p={p} stale={stale} />
        <div className={`pm-tile alert al-${al.level}`}>
          <div className="pm-label">Alert</div>
          <div className="pm-alert-icon" aria-hidden>
            {al.level === 'crit' ? '▲' : al.level === 'warn' ? '!' : al.level === 'info' ? '…' : '✓'}
          </div>
          <div className="pm-alert-title">{al.title}</div>
          <div className="pm-alert-text">{al.text}</div>
        </div>
      </div>
      {stale && why && <div className="pm-feed-note">{why} — showing the last recorded assessment{r.assessment ? ` (assessed t = ${r.assessment.assessedAt.toFixed(1)} s)` : ''}</div>}
      <footer>
        Illustrative thresholds — not a clinical assessment · {live ? `last update ${age(now, r.lastRxTime)}` : `last received t = ${r.lastRxTime.toFixed(1)} s`}
        {r.location ? ` · location x ${r.location.x.toFixed(1)}, z ${r.location.z.toFixed(1)} m ± ${r.location.sigma_m.toFixed(1)}` : ''}
      </footer>
    </section>
  );
}

function Details({ p }: { p: PatientView }) {
  const r = p.record;
  const a = r.assessment;
  return (
    <details className="card pm-details">
      <summary>Record details · {r.patientId}</summary>
      <div className="kv">
        <span>Data state</span>
        <b>{p.dataState === 'RECORDED' ? 'RECORDED (live feed ended)' : p.dataState}</b>
        <span>Last reading (HR · RR)</span>
        <b>{r.latestVitals ? `${fmt(r.latestVitals.hr, 0)} bpm · ${fmt(r.latestVitals.rr, 0)} /min at t = ${fmt(r.latestVitals.sampleTime, 1)} s` : '—'}</b>
        <span>Assessment (mean of {simController.engine.config.casualty.vitals.samplesForAssessment})</span>
        <b>{a ? `HR ${fmt(a.hr, 0)} · RR ${fmt(a.rr, 0)} · score ${a.total}` : 'pending'}</b>
        <span>Location (estimate)</span>
        <b>{r.location ? `x ${fmt(r.location.x, 1)}, z ${fmt(r.location.z, 1)} m ± ${fmt(r.location.sigma_m, 2)} m` : 'not reported'}</b>
        <span>Detected / assessed</span>
        <b>
          {r.detectedAt === null ? '—' : `t = ${fmt(r.detectedAt, 1)} s`} / {a ? `t = ${fmt(a.assessedAt, 1)} s` : '—'}
        </b>
        <span>Received vital samples</span>
        <b>{r.vitalsHistory.length}</b>
        <span>Body temperature (skin, IR)</span>
        <b>
          {p.temperature.skin_c !== null
            ? `${fmt(p.temperature.skin_c, 1)} ± ${fmt(p.temperature.sigma_c ?? 0, 1)} °C at t = ${fmt(p.temperature.sampleTime ?? 0, 1)} s · ${p.temperature.status.replace('_', ' ')} · ${r.temperatureHistory.length} readings`
            : `-- °C · UNAVAILABLE (${p.temperature.reason})`}
        </b>
        <span>Illustrative risk class</span>
        <b>{a ? `${a.risk} (HR/RR only; temperature not scored)` : 'pending'}</b>
        <span>Reported by</span>
        <b>{r.reportedBy}</b>
        <span>Evacuation stage</span>
        <b>{p.evacStage ?? '—'}</b>
      </div>
    </details>
  );
}

function PreviousMissions() {
  const list = useMissionArchive();
  if (!list.length) return null;
  return (
    <details className="card pm-archive">
      <summary>
        Previous mission records ({list.length}) <span className="muted">· kept after Reset · simulated</span>
      </summary>
      <table className="pm-arch-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Patient</th>
            <th>Assessed</th>
            <th>HR</th>
            <th>RR</th>
            <th>Risk</th>
            <th>Temp (skin)</th>
            <th>Location</th>
            <th>End</th>
          </tr>
        </thead>
        <tbody>
          {list.flatMap((m) =>
            m.patients.map((p) => (
              <tr key={`${m.runId}${m.archivedAt}${p.patientId}`} title={`archived ${m.archivedAt} · rescue route ${m.rescueStatus ?? '—'}`}>
                <td>{m.runId}</td>
                <td>{p.patientId}</td>
                <td>{p.assessedAt === null ? '—' : `t ${p.assessedAt.toFixed(0)} s`}</td>
                <td>{p.hr === null ? 'N/A' : p.hr.toFixed(0)}</td>
                <td>{p.rr === null ? 'N/A' : p.rr.toFixed(0)}</td>
                <td className={p.risk ? `risk-${p.risk.toLowerCase()}` : ''}>{p.risk ?? 'N/A'}</td>
                <td>{p.tempC === null || p.tempC === undefined ? '-- °C' : `${p.tempC.toFixed(1)} °C`}</td>
                <td>{p.location ? `${p.location.x.toFixed(0)}, ${p.location.z.toFixed(0)}` : '—'}</td>
                <td>
                  {m.phase} · {m.endTime.toFixed(0)} s
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <div className="actions">
        <button
          className="btn xs"
          onClick={() => {
            const blob = new Blob([JSON.stringify({ data_source: 'SIMULATED', missions: list }, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'beeguard_previous_missions.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}
        >
          Download records (JSON)
        </button>
        <button className="btn xs ghost" onClick={() => missionArchive.clear()}>
          Clear archive
        </button>
      </div>
    </details>
  );
}

export function PatientsPanel() {
  const e = simController.engine;
  const s = e.state;
  const list = patientViews(s, e.config);
  return (
    <>
      <div className="panel-intro">
        Ground-station view · one card per reported casualty (this scenario: exactly one, {e.world.casualty.id}). LIVE = data arriving; LAST
        RECORDED = the feed has stopped and the last received values are kept. Body temperature = skin temperature by non-contact IR (not core). SpO₂ is not simulated.
      </div>
      {list.length === 0 ? (
        <section className="patient-main empty">
          <header>
            <span className="pm-id">No casualty reported</span>
            <span className="sim-chip">SIMULATED</span>
          </header>
          <div className="pm-grid">
            {['Heart Rate', 'Respiratory Rate', 'Body Temperature', 'Alert'].map((l) => (
              <div key={l} className="pm-tile">
                <div className="pm-label">{l}</div>
                <div className="pm-value">{l === 'Body Temperature' ? <>-- <small>°C</small></> : 'N/A'}</div>
                {l === 'Body Temperature' && (
                  <div className="pm-temp-meta">
                    <span className="pm-temp-status st-unavailable">UNAVAILABLE</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <footer>
            {s.bees.find((b) => b.id === 'BEE-02')?.mode === 'DOCKED'
              ? 'BEE-02 is still in the bay.'
              : 'BEE-02 is searching — nothing received at the ground station yet.'}
          </footer>
        </section>
      ) : (
        list.map((p) => (
          <div key={p.record.patientId} className="patient-wrap">
            <PatientCard p={p} />
            <Details p={p} />
          </div>
        ))
      )}
      <PreviousMissions />
    </>
  );
}
