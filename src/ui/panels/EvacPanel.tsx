import { useState } from 'react';
import { EVAC_STAGES, activePlan, recommendedRoute } from '../../sim';
import type { CorridorEvaluation, EvacuationCase, RescueSection, RouteRun } from '../../sim';
import { simController } from '../../state/simController';
import { useViewSettings, viewSettings } from '../../state/viewSettings';
import { AerialMap } from '../charts/AerialMap';
import { mapLayers } from '../charts/mapLayers';
import { DoseComparisonChart } from '../charts/DoseComparisonChart';
import { Card, fmt } from './common';
import { Kpi } from './RadiationPanel';
import { CorridorCard } from './CorridorCard';

const STAGE_LABEL: Record<string, string> = {
  DETECTED: 'Detected',
  ASSESSED: 'Assessed',
  ROUTE_PLANNED: 'Route planned',
  AWAITING_RESCUE: 'Awaiting rescue',
  EVACUATED: 'Evacuated',
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const sci = (v: number) => (v === 0 ? '0' : v < 0.01 ? v.toExponential(1) : v.toFixed(3));
/** Dose of a corridor evaluation: full estimate when SURVEYED, else a lower bound (unmeasured ground never counted as 0). */
const doseText = (x: CorridorEvaluation) => (x.doseTotal_uSv !== null ? sci(x.doseTotal_uSv) : x.measuredLength_m > 0 ? `≥ ${sci(x.doseMeasured_uSv)}` : 'unknown');

/** Route in walking order, split into measured / short-gap (partial) / unknown stretches (lengths in m). */
function routeStrip(runs: RouteRun[], maxGap: number) {
  const parts: { kind: 'meas' | 'gap' | 'unk'; len: number }[] = [];
  let meas = 0;
  let gap = 0;
  let unk = 0;
  for (const r of runs) {
    let len = 0;
    for (let i = 1; i < r.points.length; i++) len += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].z - r.points[i - 1].z);
    if (len <= 0) continue;
    const kind = r.known ? 'meas' : len <= maxGap ? 'gap' : 'unk';
    if (kind === 'meas') meas += len;
    else if (kind === 'gap') gap += len;
    else unk += len;
    parts.push({ kind, len });
  }
  return parts.length ? { parts, meas, gap, unk } : null;
}

function CaseCard({ c }: { c: EvacuationCase }) {
  const e = simController.engine;
  const { showEvacRoute } = useViewSettings();
  const [confirming, setConfirming] = useState(false);
  const plan = activePlan(c);
  const m = plan?.metrics;
  const idx = EVAC_STAGES.indexOf(c.stage);
  const cs = e.state.corridor;
  const rec = recommendedRoute(e.state, e.config, c.patientId);
  const corridorOn = cs.enabled && cs.candidates.length > 0;
  const validated = corridorOn && cs.decision.final && cs.decision.status === 'SURVEY_VALIDATED';
  const val = e.config.survey.validation;
  const selEv = rec?.candidateId ? cs.evaluations.find((x) => x.candidateId === rec.candidateId) ?? null : null;
  const layers = mapLayers(e, 'gs', true);
  const mapRoutes =
    corridorOn || !plan
      ? layers.routes
      : [...(plan.shortest ? [{ runs: [{ known: true, points: plan.shortest.waypoints }], ghost: true }] : []), { runs: plan.runs }];
  const strip = rec ? routeStrip(rec.runs, val.maxGap_m) : plan ? routeStrip(plan.runs, val.maxGap_m) : null;
  const status = corridorOn ? (selEv?.status ?? null) : null;
  const decisionTone = !corridorOn ? '' : !cs.decision.final ? 'pending' : validated ? 'ok' : 'warn';
  const alts = corridorOn ? cs.evaluations.filter((x) => x.candidateId !== rec?.candidateId) : [];
  return (
    <Card title={`Casualty evacuation · ${c.patientId} → ${e.config.evacuation.collectionPoint.id}`} right={<span className="pill plan-only">PLANNING ONLY</span>}>
      <ol className="h-stages" aria-label="Evacuation stage">
        {EVAC_STAGES.map((st, i) => {
          const done = i < idx || (i === idx && st === 'EVACUATED');
          const t = c.stageTimes[st];
          return (
            <li key={st} className={done ? 'done' : i === idx ? 'cur' : ''} title={t !== undefined ? `t = ${(t as number).toFixed(1)} s` : 'not reached'}>
              <i aria-hidden>{done ? '✓' : i + 1}</i>
              <span>{STAGE_LABEL[st]}</span>
            </li>
          );
        })}
      </ol>

      {plan && m ? (
        <>
          {!e.state.rescue.enabled && <AerialMap variant="panel" frame="evac" height={300} {...layers} routes={mapRoutes} />}
          <div className={`route-sum ${decisionTone}`}>
            <div className="rs-head">
              <b>{rec?.candidateId ? `Route ${rec.candidateId}` : 'Proposed route'}</b>
              <span>{rec?.label.replace(/^\S+ · /, '') ?? 'radiation-aware planner'}</span>
              {status && <span className={`pill cs-${status.toLowerCase()}`}>{status}</span>}
              <em>
                {!corridorOn ? 'planner estimate' : !cs.decision.final ? 'survey in progress — not final' : validated ? 'survey-validated' : 'survey incomplete'}
              </em>
            </div>
            <div className="kpi-strip k4">
              <Kpi label="Distance" value={fmt(selEv?.length_m ?? m.length_m, 0)} unit="m" sub={`${plan.start.x.toFixed(0)},${plan.start.z.toFixed(0)} → ${plan.goal.id}`} />
              <Kpi label="Walk ETA" value={mmss(selEv?.walkTime_s ?? m.walkTime_s)} unit="min" sub={`at ${e.config.evacuation.walkingSpeed_mps} m/s`} />
              <Kpi
                label="Dose"
                value={selEv ? doseText(selEv) : m.measuredLength_m > 0 ? `≥ ${m.doseMeasuredStretches_uSv.toExponential(1)}` : '—'}
                unit="µSv"
                sub={selEv?.doseTotal_uSv !== null && selEv ? `± ${(selEv.doseTotalSigma_uSv ?? 0).toExponential(1)} (1σ)` : 'lower bound — unmeasured not counted'}
              />
              <Kpi
                label="Measured"
                value={`${Math.round((selEv?.coverage ?? 1 - m.unknownFraction) * 100)}%`}
                sub={selEv ? `longest gap ${fmt(selEv.longestGap_m, 0)} m` : `${fmt(m.unknownLength_m, 0)} m unsurveyed`}
                tone={(selEv?.coverage ?? 1 - m.unknownFraction) >= val.surveyedFraction ? 'ok' : 'warn'}
              />
            </div>
            {strip && (
              <div className="route-strip" aria-label="Route from casualty to collection point: measured, short gap, unknown">
                <span className="rs-end">CAS</span>
                <div>
                  {strip.parts.map((p, i) => (
                    <i key={i} className={p.kind} style={{ flexGrow: p.len }} title={`${p.len.toFixed(0)} m · ${p.kind === 'meas' ? 'measured' : p.kind === 'gap' ? `short gap ≤ ${val.maxGap_m} m (partial)` : 'unknown — not measured'}`} />
                  ))}
                </div>
                <span className="rs-end">{plan.goal.id}</span>
              </div>
            )}
            {strip && (
              <div className="rs-legend">
                <span className="meas">measured {strip.meas.toFixed(0)} m</span>
                <span className="gap">partial (gaps ≤ {val.maxGap_m} m) {strip.gap.toFixed(0)} m</span>
                <span className="unk">unknown {strip.unk.toFixed(0)} m</span>
              </div>
            )}
          </div>

          {alts.length > 0 && (
            <div className="alts" aria-label="Alternative routes">
              <div className="alts-head">Alternatives</div>
              {alts.map((x) => (
                <div key={x.candidateId} className="alt" title={x.reasons.join('; ') || 'meets the survey thresholds'}>
                  <b>{x.candidateId}</b>
                  <span>{fmt(x.length_m, 0)} m</span>
                  <span>{mmss(x.walkTime_s)}</span>
                  <span className="mini-bar">
                    <i style={{ width: `${x.coverage * 100}%` }} />
                  </span>
                  <span>{Math.round(x.coverage * 100)}%</span>
                  <span>{doseText(x)} µSv</span>
                  <span className={`pill cs-${x.status.toLowerCase()}`}>{x.status}</span>
                </div>
              ))}
            </div>
          )}

          <details className="planner-ref">
            <summary className="sub-head">{corridorOn ? 'Planner reference & route details' : 'Route details'}</summary>
            <div className="kv">
              <span>Planner route length</span>
              <b>
                {fmt(m.length_m, 1)} m · {Math.round(m.unknownFraction * 100)}% unknown · min clearance {fmt(m.minObstacleDistance_m, 1)} m (req. {e.config.evacuation.clearance_m} m)
              </b>
              <span>Dose on measured stretches</span>
              <b>{m.measuredLength_m > 0 ? `${m.doseMeasuredStretches_uSv.toExponential(2)} µSv over ${fmt(m.measuredLength_m, 0)} m` : 'no measured stretch'}</b>
              <span>Max measured rate on route</span>
              <b>{m.maxMeasuredRate_uSv_h === null ? '—' : `${fmt(m.maxMeasuredRate_uSv_h, 3)} µSv/h`}</b>
              <span>vs shortest walkable</span>
              <b>{plan.shortest ? `${fmt(plan.shortest.metrics.length_m, 1)} m` : '—'}</b>
              <span>Start (casualty estimate)</span>
              <b>
                x {fmt(plan.start.x, 1)}, z {fmt(plan.start.z, 1)} ± {fmt(plan.startSigma_m, 2)} m
              </b>
              <span>Based on</span>
              <b>
                plan #{plan.planId} at t = {fmt(plan.time, 1)} s · {plan.basis.gsRadiationSamples} received samples · {plan.basis.measuredCells} measured cells
              </b>
            </div>
            {m.unknownFraction > 0.5 && !corridorOn && (
              <div className="warn-line">
                ⚠ Most of this route crosses ground BEE-01 has not surveyed. The dose there is unknown — the planner only assumed {e.config.evacuation.unknownMultiplier}×
                background for costing.
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={showEvacRoute} onChange={(ev) => viewSettings.set({ showEvacRoute: ev.target.checked })} />
              Show route in the 3D view
            </label>
          </details>
        </>
      ) : (
        <div className="card-empty">
          {c.stage === 'DETECTED' ? 'Waiting for the assessment to reach the ground station.' : c.plans.length ? `Planning failed: ${c.plans[c.plans.length - 1].failReason}` : 'Planning…'}
        </div>
      )}

      {corridorOn && c.stage === 'ROUTE_PLANNED' && !validated && (
        <div className="warn-line">⚠ No evacuation route is survey-validated yet — see the corridor comparison below. The decision to request rescue remains yours.</div>
      )}
      <div className="actions">
        <button className="btn primary" disabled={c.stage !== 'ROUTE_PLANNED'} onClick={() => simController.operator(c.patientId, 'REQUEST_RESCUE')}>
          Request rescue team
        </button>
        {!confirming ? (
          <button className="btn" disabled={c.stage !== 'AWAITING_RESCUE'} onClick={() => setConfirming(true)}>
            Confirm evacuated…
          </button>
        ) : (
          <span className="confirm">
            Confirm the casualty has actually been evacuated?
            <button
              className="btn primary"
              onClick={() => {
                simController.operator(c.patientId, 'CONFIRM_EVACUATED');
                setConfirming(false);
              }}
            >
              Yes, confirm
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        )}
      </div>
      <div className="note">
        No rescue team or casualty movement is simulated. "Awaiting rescue" freezes the proposed route; "Evacuated" is recorded only from your
        confirmation (logged as an operator action and exported).
      </div>
    </Card>
  );
}

const SEC_LABEL: Record<RescueSection['kind'], string> = { MEASURED: 'measured', ESTIMATED: 'estimate only (IDW)', UNKNOWN: 'unknown — no data' };

/** Phase 3B+: recommended RESCUE-TEAM route (start → casualty), thin green line on the map. Planning only. */
function RescueCard() {
  const e = simController.engine;
  const s = e.state;
  const rs = s.rescue;
  const p = rs.current;
  const v = useViewSettings();
  const layers = mapLayers(e, 'gs', v.showEvacRoute);
  if (!rs.enabled) return null;
  const rec = p?.candidates.find((c) => c.id === p.recommendedId) ?? null;
  const ev = rec?.evaluation;
  const len = (k: RescueSection['kind']) => (p ? p.sections.filter((x) => x.kind === k).reduce((m, x) => m + x.length_m, 0) : 0);
  const tone = !p ? 'pending' : p.status === 'VERIFIED' ? 'ok' : 'warn';
  return (
    <Card
      title={
        <span className="rescue-title">
          <i aria-hidden /> Recommended Rescue Route — Radiation-Minimized
        </span>
      }
      right={<span className="pill plan-only">PLANNING ONLY</span>}
      className="rescue-card"
    >
      <AerialMap variant="panel" frame="evac" height={290} {...layers} />
      {!p || !rec || !ev ? (
        <div className="card-empty">
          {p?.status === 'NO_ROUTE'
            ? `No walkable route from ${p.start.label} to the casualty estimate.`
            : 'Planned once the ground station has the casualty’s location and assessment.'}
        </div>
      ) : (
        <div className={`route-sum ${tone}`}>
          <div className="rs-head">
            <b>
              {p.start.id} → {p.goal.patientId}
            </b>
            <span>
              {rec.id} · {rec.label}
            </span>
            <span className={`pill ${p.status === 'VERIFIED' ? 'cs-surveyed' : 'cs-partial'}`}>{p.status}</span>
            <em>{p.frozen ? 'frozen — rescue requested' : `plan #${p.planId} · t = ${p.time.toFixed(0)} s`}</em>
          </div>
          <div className="kpi-strip k4">
            <Kpi label="Distance" value={fmt(ev.length_m, 0)} unit="m" sub={`from ${p.start.id}`} />
            <Kpi label="Walk ETA" value={mmss(ev.walkTime_s)} unit="min" sub={`at ${e.config.evacuation.walkingSpeed_mps} m/s`} />
            <Kpi
              label="Est. dose"
              value={ev.doseTotal_uSv !== null ? sci(ev.doseTotal_uSv) : `≥ ${sci(ev.doseMeasured_uSv)}`}
              unit="µSv"
              sub={ev.doseTotal_uSv !== null ? `± ${(ev.doseTotalSigma_uSv ?? 0).toExponential(1)} (1σ)` : 'lower bound — unknown not counted'}
              tone={p.status === 'VERIFIED' ? '' : 'warn'}
            />
            <Kpi label="Data coverage" value={`${Math.round(ev.coverage * 100)}%`} sub={`measured · longest gap ${fmt(ev.longestGap_m, 0)} m`} tone={ev.coverage >= e.config.survey.validation.surveyedFraction ? 'ok' : 'warn'} />
          </div>
          <div className="route-strip rescue" aria-label="Rescue route in walking order: measured, estimated, unknown">
            <span className="rs-end">{p.start.id}</span>
            <div>
              {p.sections.map((x, i) => (
                <i key={i} className={x.kind.toLowerCase()} style={{ flexGrow: x.length_m }} title={`${x.length_m.toFixed(1)} m · ${SEC_LABEL[x.kind]}`} />
              ))}
            </div>
            <span className="rs-end">{p.goal.patientId}</span>
          </div>
          <div className="rs-legend rescue">
            <span className="measured">measured {len('MEASURED').toFixed(0)} m</span>
            <span className="estimated">estimated {len('ESTIMATED').toFixed(0)} m</span>
            <span className="unknown">unknown {len('UNKNOWN').toFixed(0)} m</span>
            <span>max {ev.maxRate_uSv_h === null ? '—' : `${ev.maxRate_uSv_h.toFixed(2)} µSv/h`}</span>
          </div>
          {p.status !== 'VERIFIED' && <div className="warn-line">⚠ No sufficiently verified low-exposure route — do not treat this route as safe.</div>}
          {p.warnings.filter((w) => !w.startsWith('No sufficiently')).length > 0 && (
            <ul className="rescue-warn">
              {p.warnings
                .filter((w) => !w.startsWith('No sufficiently'))
                .map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
            </ul>
          )}
        </div>
      )}
      {p && p.candidates.length > 1 && (
        <div className="alts" aria-label="Alternative rescue routes">
          <div className="alts-head">Alternatives (same start → casualty)</div>
          {p.candidates
            .filter((c) => c.id !== p.recommendedId)
            .map((c) => (
              <div key={c.id} className="alt" title={c.issues.join('; ') || c.label}>
                <b>{c.id}</b>
                <span>{fmt(c.evaluation.length_m, 0)} m</span>
                <span>{mmss(c.evaluation.walkTime_s)}</span>
                <span className="mini-bar">
                  <i style={{ width: `${c.evaluation.coverage * 100}%` }} />
                </span>
                <span>{Math.round(c.evaluation.coverage * 100)}%</span>
                <span>{doseText(c.evaluation)} µSv</span>
                <span className={`pill ${c.verified ? 'cs-surveyed' : 'cs-partial'}`}>{c.verified ? 'VERIFIED' : 'UNVERIFIED'}</span>
              </div>
            ))}
        </div>
      )}
      <details className="planner-ref">
        <summary className="sub-head">How the rescue route is chosen</summary>
        <div className="note">
          {p ? p.rule : '—'}. Candidates come from the walking planner (1 m grid, {e.config.evacuation.clearance_m} m obstacle clearance — buildings,
          debris and tanks block) with radiation weights κ = {e.config.rescue.candidateWeights.join(', ')}; they are evaluated like the CCP corridors (≥{' '}
          {Math.round(e.config.survey.validation.surveyedFraction * 100)}% measured, no unmeasured stretch &gt; {e.config.survey.validation.maxGap_m} m, no measured
          rate ≥ {e.config.rescue.maxRate_uSv_h} µSv/h). Rates are measured at drone altitude. The thin green line is the rescue team’s recommended path — not a drone
          flight path and not proof that the route is safe. It stays available after the drones return.
        </div>
      </details>
    </Card>
  );
}

export function EvacPanel() {
  const e = simController.engine;
  const s = e.state;
  const cfg = e.config.evacuation;
  return (
    <>
      <div className="panel-intro" title={`The planner uses the site map, the radiation samples received at the ground station and a ${cfg.clearance_m} m clearance from obstacles.`}>
        Rescue team → casualty (green line) · casualty → {cfg.collectionPoint.id} · ground-station data · operator-controlled
      </div>
      <RescueCard />
      {s.rescue.enabled && <DoseComparisonChart plan={s.rescue.current} reference={e.config.rescue.doseReference} walkingSpeed_mps={e.config.evacuation.walkingSpeed_mps} />}
      {s.evacuation.cases.length === 0 ? (
        <Card title="No evacuation case">
          <div className="card-empty">A case opens when the ground station receives a casualty detection.</div>
        </Card>
      ) : (
        s.evacuation.cases.map((c) => <CaseCard key={c.patientId} c={c} />)
      )}
      {e.state.corridor.enabled && (
        <details className="about corridor-details">
          <summary>Corridor validation · decision rule &amp; full comparison</summary>
          <CorridorCard />
        </details>
      )}
      {s.evacuation.operatorActions.length > 0 && (
        <Card title="Operator actions" right={<span className="muted">{s.evacuation.operatorActions.length}</span>}>
          <ul className="op-log">
            {s.evacuation.operatorActions.map((a, i) => (
              <li key={i}>
                t = {a.time.toFixed(1)} s · {a.action} {a.patientId} · {a.accepted ? 'accepted' : 'rejected'} ({a.note})
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
