import { useState } from 'react';
import type { ReactNode } from 'react';
import { buildHeatmap, cumulativeDose, gsDoseSeries, gsSurveyView, onboardDoseSeries, radiationStats, recommendedRoute, surveyCoverage } from '../../sim';
import { simController } from '../../state/simController';
import { radiationGrid } from '../../state/derived';
import { useViewSettings, viewSettings } from '../../state/viewSettings';
import { AerialMap } from '../charts/AerialMap';
import { mapLayers } from '../charts/mapLayers';
import { TimeChart } from '../charts/TimeChart';
import { fmt } from './common';

const AMBER = '#f59e0b';
const CYAN = '#22d3ee';

/** Dark "mission control" panel frame used by the radiation tab. */
function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mc-panel">
      <header>
        <span className="mc-title">
          <i aria-hidden>◢</i> {title}
        </span>
        <span className="mc-right">{right}</span>
      </header>
      {children}
    </section>
  );
}

/** Mean-rate trend: last 20 s of received samples vs the 20 s before (null = not enough data). */
function trendOf(series: { t: number; rate_uSv_h: number }[], now: number): { dir: 'up' | 'down' | 'flat'; ratio: number } | null {
  const win = (a: number, b: number) => series.filter((p) => p.t > a && p.t <= b).map((p) => p.rate_uSv_h);
  const cur = win(now - 20, now);
  const prev = win(now - 40, now - 20);
  if (cur.length < 2 || prev.length < 2) return null;
  const m = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
  const ratio = m(cur) / Math.max(1e-9, m(prev));
  return { dir: ratio > 1.15 ? 'up' : ratio < 1 / 1.15 ? 'down' : 'flat', ratio };
}

/** Compact metric card (KPI strip). */
export function Kpi({ label, value, unit, sub, tone = '', icon }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: string; icon?: ReactNode }) {
  return (
    <div className={`kpi ${tone}`}>
      <label>
        {icon && <i aria-hidden>{icon}</i>}
        {label}
        {unit && <em>{unit}</em>}
      </label>
      <b>{value}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function RadiationPanel() {
  const v = useViewSettings();
  const [chart, setChart] = useState<'rate' | 'dose'>('rate');
  const [opts, setOpts] = useState(false);
  const e = simController.engine;
  const s = e.state;
  const cfg = e.config;
  const src = v.heatmapSource;
  const rx = s.comms.gs.radiationSamples;
  const st = radiationStats(rx, s, cfg);
  const grid = radiationGrid(e, src);
  const gsSeries = gsDoseSeries(rx);
  const onSeries = onboardDoseSeries(s);
  const series = src === 'gs' ? gsSeries : onSeries;
  const dose = cumulativeDose(series, cfg.radiation);
  const latest = series.length ? series.reduce((a, b) => (b.t > a.t ? b : a)) : null;
  const peakS = src === 'gs' ? st.peak : s.radiation.peakMeasured;
  const peak = peakS ? { x: peakS.x, z: peakS.z, v: peakS.measured_uSv_h } : null;
  const rec = recommendedRoute(s, cfg);
  const plan = s.evacuation.cases.map((c) => c.plans.find((p) => p.planId === c.activePlanId)).find((p) => p && p.ok) ?? null;
  const sv = gsSurveyView(s, cfg, e.world);
  // coverage of the shown data source (GS-received by default) — measurements only
  const cov = sv ? (src === 'gs' ? sv.coverage : surveyCoverage(buildHeatmap(s.radiation.samples, cfg.radiation.heatmap), cfg, e.world)) : null;
  const cs = s.corridor;
  const nCells = grid.nx * grid.nz;
  const domain: [number, number] = [0, Math.max(1, s.time)];
  const srcLabel = src === 'gs' ? 'received at GS' : 'on-board log';

  const trend = trendOf(series, s.time);
  const alertRate = cfg.alerts.doseRate_uSv_h;
  const doseTxt = dose.basis === 'NO_DATA' ? '—' : dose.dose_uSv < 0.01 ? dose.dose_uSv.toExponential(1) : fmt(dose.dose_uSv, 3);
  const routeLine = (() => {
    const ev = rec?.candidateId ? cs.evaluations.find((x) => x.candidateId === rec.candidateId) : null;
    if (ev)
      return `ROUTE ${rec!.candidateId} ${fmt(ev.length_m, 0)} m · ETA ${mmss(ev.walkTime_s)} · ${Math.round(ev.coverage * 100)}% measured · ${rec!.final ? rec!.status.replace('_', ' ') : 'SURVEY PENDING'}`;
    return plan?.metrics ? `ROUTE ${fmt(plan.metrics.length_m, 0)} m · ETA ${mmss(plan.metrics.walkTime_s)} · ${Math.round(plan.metrics.unknownFraction * 100)}% unsurveyed` : null;
  })();

  return (
    <>
      <div className="kpi-strip" role="group" aria-label="Radiation summary">
        <Kpi
          label="Current"
          icon="◉"
          value={fmt(latest?.rate_uSv_h, 3)}
          unit="µSv/h"
          sub={latest ? `t = ${latest.t.toFixed(0)} s` : 'no data'}
          tone={latest && latest.rate_uSv_h >= alertRate ? 'warn' : ''}
        />
        <Kpi label="Peak" icon="▲" value={fmt(peak?.v, 3)} unit="µSv/h" sub={peak ? `at ${peak.x.toFixed(0)}, ${peak.z.toFixed(0)} m` : '—'} tone={peak && peak.v >= alertRate ? 'crit' : ''} />
        <Kpi
          label="Coverage"
          icon="▦"
          value={cov ? `${(cov.fraction * 100).toFixed(0)}%` : '—'}
          sub={cov ? `area · flyable ${(cov.fractionReachable * 100).toFixed(0)}%` : 'survey off'}
          tone={sv && sv.areaSurvey.objective === 'MET' ? 'ok' : sv && sv.areaSurvey.objective === 'NOT_MET' ? 'warn' : ''}
        />
        <Kpi
          label="Trend"
          icon={trend?.dir === 'up' ? '↗' : trend?.dir === 'down' ? '↘' : '→'}
          value={trend ? (trend.dir === 'up' ? 'Rising' : trend.dir === 'down' ? 'Falling' : 'Stable') : '—'}
          sub={trend ? `×${trend.ratio.toFixed(2)} vs prev 20 s` : 'needs 40 s of data'}
          tone={trend?.dir === 'up' ? 'warn' : ''}
        />
        <Kpi label="Cum. dose" icon="Σ" value={doseTxt} unit="µSv" sub={dose.basis === 'NO_DATA' ? 'no samples' : `${dose.basis.toLowerCase()} · detector`} tone={dose.basis === 'PARTIAL' ? 'muted' : ''} />
      </div>

      <Panel
        title="Aerial radiation map"
        right={
          <span className="mc-right-tools">
            <span className="seg sm" role="group" aria-label="Data source">
              <button className={src === 'gs' ? 'on' : ''} onClick={() => viewSettings.set({ heatmapSource: 'gs' })} title="Samples received at the ground station (default)">
                GS
              </button>
              <button className={src === 'onboard' ? 'on' : ''} onClick={() => viewSettings.set({ heatmapSource: 'onboard' })} title="Complete on-board log — in reality available only after recovery">
                On-board
              </button>
            </span>
            <span className="opt-wrap">
              <button className={`btn xs ${opts ? 'on' : ''}`} onClick={() => setOpts((o) => !o)} aria-expanded={opts} title="Map options">
                ⚙
              </button>
              {opts && (
                <div className="opt-pop" role="dialog" aria-label="Map options">
                  <div className="seg sm">
                    <button className={v.mapSmooth ? 'on' : ''} onClick={() => viewSettings.set({ mapSmooth: true })}>
                      Smooth
                    </button>
                    <button className={!v.mapSmooth ? 'on' : ''} onClick={() => viewSettings.set({ mapSmooth: false })}>
                      Cells
                    </button>
                  </div>
                  <label className="check" title="Inverse-distance-weighted estimate up to 12 m from a measurement — stippled, never used for planning or exports">
                    <input type="checkbox" checked={v.mapEstimate} onChange={(ev) => viewSettings.set({ mapEstimate: ev.target.checked })} />
                    Estimate layer (IDW)
                  </label>
                  <label className="check" title="Source position from the scenario configuration (reference, not detected)">
                    <input type="checkbox" checked={v.mapSourceRef} onChange={(ev) => viewSettings.set({ mapSourceRef: ev.target.checked })} />
                    Scenario source
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={v.showEvacRoute} onChange={(ev) => viewSettings.set({ showEvacRoute: ev.target.checked })} />
                    Evacuation route
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={v.showHeatmap} onChange={(ev) => viewSettings.set({ showHeatmap: ev.target.checked })} />
                    Heat layer in 3D view
                  </label>
                  <button className="btn xs" onClick={() => viewSettings.set({ mainView: 'aerial', sidebarOpen: false })}>
                    ⤢ Open full aerial view
                  </button>
                </div>
              )}
            </span>
          </span>
        }
      >
        <AerialMap variant="panel" frame="facility" height={360} {...mapLayers(e, src, v.showEvacRoute)} />
        <div className="mc-strip">
          <span>
            <b>{grid.filled}</b>/{nCells} cells · {grid.cell} m · {srcLabel}
          </span>
          {routeLine ? <span className="strip-route">{routeLine}</span> : <span>latest t = {fmt(latest?.t, 1)} s</span>}
        </div>
      </Panel>

      <Panel
        title={chart === 'rate' ? 'Dose-rate trend' : 'Cumulative dose · estimate'}
        right={
          <span className="seg sm" role="tablist" aria-label="Chart">
            <button role="tab" aria-selected={chart === 'rate'} className={chart === 'rate' ? 'on' : ''} onClick={() => setChart('rate')}>
              Rate
            </button>
            <button role="tab" aria-selected={chart === 'dose'} className={chart === 'dose' ? 'on' : ''} onClick={() => setChart('dose')}>
              Cumulative
            </button>
          </span>
        }
      >
        {chart === 'rate' ? (
          <TimeChart
            ariaLabel="Measured dose rate over simulation time"
            unit="µSv/h"
            digits={3}
            height={128}
            xDomain={domain}
            reference={{ v: alertRate, label: `ALERT ${alertRate} µSv/h` }}
            series={[
              { name: 'Received at GS', color: AMBER, area: src === 'gs', dots: true, points: gsSeries.map((p) => ({ t: p.t, v: p.rate_uSv_h })) },
              ...(src === 'onboard' ? [{ name: 'On-board log', color: CYAN, area: true, points: onSeries.map((p) => ({ t: p.t, v: p.rate_uSv_h })) }] : []),
            ]}
            emptyText="No radiation sample received yet"
          />
        ) : dose.basis === 'NO_DATA' ? (
          <div className="card-empty">Not available — no samples in this data source yet.</div>
        ) : (
          <TimeChart
            ariaLabel="Estimated cumulative dose over simulation time"
            unit="µSv"
            digits={5}
            height={128}
            xDomain={domain}
            series={[
              { name: 'Received at GS', color: AMBER, area: true, points: cumulativeDose(gsSeries, cfg.radiation).curve.map((c) => ({ t: c.t, v: c.dose_uSv })) },
              ...(src === 'onboard' ? [{ name: 'On-board log', color: CYAN, points: dose.curve.map((c) => ({ t: c.t, v: c.dose_uSv })) }] : []),
            ]}
          />
        )}
        <div className="mc-strip">
          <span>
            samples {src === 'gs' ? `${st.received}/${st.sentOnboard} received` : `${onSeries.length} on board`}
          </span>
          {dose.basis !== 'NO_DATA' && (
            <span>
              dose ± {dose.sigma_uSv.toExponential(1)} µSv (1σ) · {dose.missingWindows} window{dose.missingWindows === 1 ? '' : 's'} missing
            </span>
          )}
        </div>
      </Panel>

      {sv && cov && (
        <Panel title="Full-area survey · BEE-01" right={<span className="mc-unit">{sv.reportedPhase ? sv.reportedPhase.replace('_', ' ') : '—'}</span>}>
          {sv.areaSurvey.objectiveFraction > 0 && (
            <div className={`objective-line ${sv.areaSurvey.objective === 'MET' ? 'ok' : sv.areaSurvey.objective === 'NOT_MET' ? 'warn' : ''}`}>
              <b>
                {sv.areaSurvey.objective === 'MET'
                  ? 'SURVEY COMPLETE'
                  : sv.areaSurvey.objective === 'NOT_MET'
                    ? 'SURVEY INCOMPLETE'
                    : 'SURVEY IN PROGRESS'}
              </b>
              <span>
                objective ≥ {Math.round(sv.areaSurvey.objectiveFraction * 100)}% of flyable cells measured
                {sv.areaSurvey.onboardReachable !== null ? ` · BEE-01 reported ${(sv.areaSurvey.onboardReachable * 100).toFixed(1)}% (on-board)` : ''}
              </span>
            </div>
          )}
          <div className="cov-bar" aria-label="Measured share of the survey area">
            <div className="cb-meas" style={{ width: `${cov.fraction * 100}%` }} />
            <div className="cb-blocked" style={{ width: `${((cov.cells - cov.reachableCells) / Math.max(1, cov.cells)) * 100}%`, marginLeft: 'auto' }} />
          </div>
          <div className="kv">
            <span>Reachable covered</span>
            <b>
              {(cov.fractionReachable * 100).toFixed(1)}% · {cov.measuredReachable}/{cov.reachableCells} flyable cells
            </b>
            <span>Area</span>
            <b>
              x {cfg.survey.area.x0}…{cfg.survey.area.x1}, z {cfg.survey.area.z0}…{cfg.survey.area.z1} m ({(cfg.survey.area.x1 - cfg.survey.area.x0) * (cfg.survey.area.z1 - cfg.survey.area.z0)} m²)
            </b>
            <span>Pattern</span>
            <b>
              {s.survey.laneZ.length} lanes along {s.survey.laneAxis} · {cfg.survey.laneSpacing_m} m · {cfg.survey.altitude_m} m alt · {cfg.survey.speed_mps} m/s
              {s.survey.gapFillCells ? ` · gap fill ${s.survey.gapFillCells} cells` : ''}
            </b>
            <span>Hotspots</span>
            <b>{sv.hotspots.length ? sv.hotspots.map((h) => `${h.id} ${h.peak_uSv_h.toFixed(2)} (${h.scan.toLowerCase()})`).join(' · ') : 'none'}</b>
            <span>Corridor task</span>
            <b>{sv.task ? `${sv.task.id} · ${sv.task.state.replace('_', ' ').toLowerCase()} · ${Math.round(sv.task.progress * 100)}%` : 'not tasked'}</b>
          </div>
        </Panel>
      )}

      <details className="about">
        <summary>About these values</summary>
        <p>
          Colours are cell means of measured dose rate at flight altitude (≈ 10–22 m), {srcLabel}. "Smooth" blends only inside measured cells and fades out
          before the boundary; hatched ground has no measurement. The optional estimate layer is an interpolation, shown stippled and labelled ESTIMATE.
        </p>
        <p>
          Coverage counts a cell only if at least one measurement lies in it; estimates never count. Hatched part of the bar: cells within the
          {` ${cfg.survey.legClearance_m} m`} flight clearance of structures taller than the survey altitude. Readings outside the area are kept but not counted
          {cov ? ` (${cov.measuredOutsideArea} cells)` : ''}.
        </p>
        <p>
          Trend compares the mean received rate of the last 20 s with the 20 s before (×1.15 threshold). Cumulative dose D = Σ Ḣᵢ·Tᵢ / 3600 over counting
          windows (Tᵢ = {cfg.radiation.integrationTime_s} s); windows that never reached the GS are not filled in, so the GS value is PARTIAL. Ambient dose at the
          drone — not a dose to a person.
        </p>
      </details>
    </>
  );
}
