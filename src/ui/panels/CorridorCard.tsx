import type { CorridorEvaluation } from '../../sim';
import { simController } from '../../state/simController';
import { Card, fmt } from './common';

/**
 * Phase 3A: evacuation-corridor survey & validation (ground-station data only).
 * Shows the BEE-01 tasking state, a side-by-side comparison of every candidate
 * (distance, walk time, measured coverage, longest gap, dose ± 1σ, status) and
 * the decision with its reasons. Nothing here moves anyone (planning only).
 */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const sci = (v: number) => (v === 0 ? '0' : v < 0.01 ? v.toExponential(2) : v.toFixed(4));

function doseCell(e: CorridorEvaluation) {
  if (e.doseTotal_uSv !== null) {
    return (
      <>
        {sci(e.doseTotal_uSv)}
        <small> ± {sci(e.doseTotalSigma_uSv ?? 0)}</small>
      </>
    );
  }
  if (e.measuredLength_m <= 0) return <span className="muted">unknown</span>;
  return (
    <span title="Measured stretches only. The unmeasured part is NOT assumed to be zero — the true dose is higher by an unknown amount.">
      ≥ {sci(e.doseMeasured_uSv)}
      <small> lower bound</small>
    </span>
  );
}

const TASK_LABEL: Record<string, string> = {
  PENDING_ACK: 'Sent — awaiting acknowledgement',
  ACCEPTED: 'Accepted by BEE-01',
  IN_PROGRESS: 'BEE-01 surveying corridors',
  COMPLETE: 'Corridor survey complete',
  REJECTED: 'Rejected by BEE-01',
  NO_LINK: 'No acknowledgement (link)',
  INFEASIBLE: 'Not feasible (endurance)',
};

export function CorridorCard() {
  const e = simController.engine;
  const s = e.state;
  const cs = s.corridor;
  const val = e.config.survey.validation;
  if (!cs.enabled) return null;
  if (!cs.candidates.length) {
    return (
      <Card title="Corridor survey & validation">
        <div className="card-empty">Candidates are generated once the ground station has the casualty's assessment and location.</div>
      </Card>
    );
  }
  const d = cs.decision;
  const t = cs.task;
  const tone = !d.final ? 'pending' : d.status === 'SURVEY_VALIDATED' ? 'ok' : 'warn';
  const head = !d.final
    ? 'SURVEY IN PROGRESS — route not yet validated'
    : d.status === 'SURVEY_VALIDATED'
      ? 'SURVEY-VALIDATED ROUTE (simulated data)'
      : 'SURVEY INCOMPLETE — no route has enough measurements';
  return (
    <Card title="Corridor survey & validation" right={<span className="pill plan-only">PLANNING ONLY</span>}>
      <div className={`decision ${tone}`}>
        <div className="d-head">{head}</div>
        <div className="d-sel">
          {d.selectedId ? (
            <>
              {!d.final ? 'Current best (not final)' : d.provisional ? 'Provisional' : 'Selected'}: <b>{d.selectedId}</b> · {cs.candidates.find((c) => c.id === d.selectedId)?.label}
            </>
          ) : (
            'No route selected'
          )}
        </div>
        <div className="d-rule">{d.rule}</div>
        {d.reasons.length > 0 && (
          <ul className="d-reasons">
            {d.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </div>

      {t && (
        <div className="task-line">
          <span>
            BEE-01 task {t.taskId}: <b>{TASK_LABEL[t.state] ?? t.state}</b>
            {t.reason && t.state !== 'IN_PROGRESS' && t.state !== 'ACCEPTED' ? ` — ${t.reason}` : ''}
          </span>
          <span className="muted">
            {t.attempts} uplink attempt{t.attempts === 1 ? '' : 's'}
            {t.estDuration_s !== null ? ` · est. ${mmss(t.estDuration_s)}` : ''}
          </span>
          <div className="qbar-track" aria-label="Corridor survey progress reported by BEE-01">
            <div className="qbar-fill good" style={{ width: `${Math.round(t.progress * 100)}%` }} />
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="cand-table">
          <thead>
            <tr>
              <th>ROUTE</th>
              <th>LENGTH</th>
              <th>WALK</th>
              <th>MEASURED</th>
              <th>LONGEST GAP</th>
              <th>DOSE (µSv)</th>
              <th>STATUS</th>
            </tr>
          </thead>
          <tbody>
            {cs.evaluations.map((ev) => {
              const c = cs.candidates.find((k) => k.id === ev.candidateId)!;
              return (
                <tr key={ev.candidateId} className={d.selectedId === ev.candidateId ? 'sel' : ''} title={c.label}>
                  <td>
                    <b>{ev.candidateId}</b>
                    {d.selectedId === ev.candidateId && ' ★'}
                    <div className="muted small">{c.kind === 'SHORTEST' ? 'shortest' : c.kind === 'RADIATION_AWARE' ? 'planner (not tasked)' : 'alternative'}</div>
                  </td>
                  <td>{fmt(ev.length_m, 0)} m</td>
                  <td>{mmss(ev.walkTime_s)}</td>
                  <td>
                    {Math.round(ev.coverage * 100)}%
                    <div className="mini-bar">
                      <i style={{ width: `${ev.coverage * 100}%` }} />
                    </div>
                  </td>
                  <td>{fmt(ev.longestGap_m, 0)} m</td>
                  <td>{doseCell(ev)}</td>
                  <td>
                    <span className={`pill cs-${ev.status.toLowerCase()}`} title={ev.reasons.join('; ') || 'meets the survey thresholds'}>
                      {ev.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="note">
        Measured = share of the route length lying in heat-map cells with ≥ 1 received measurement. SURVEYED needs ≥ {Math.round(val.surveyedFraction * 100)}%
        measured and no unmeasured stretch longer than {val.maxGap_m} m; below {Math.round(val.unknownBelowFraction * 100)}% it is UNKNOWN. Dose D = Σ Ḣ·Δt / 3600
        (Ḣ in µSv/h, Δt in s) for a one-way traverse at {e.config.evacuation.walkingSpeed_mps} m/s; ±1σ is counting statistics only. Short gaps on a SURVEYED route
        use the adjacent measured rate (σ = 100 %); on other routes only a lower bound is shown — unmeasured ground is never counted as zero. Rates are
        measured at drone altitude, not at ground level. Selection: lowest dose among SURVEYED routes; doses within 2σ → shorter walk.
      </div>
    </Card>
  );
}
