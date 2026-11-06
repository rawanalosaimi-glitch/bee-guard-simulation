import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { comparisonRoutes, doseAt, uSvToMSv } from '../../sim';
import type { ComparisonRole, ComparisonRoute, DosePieceKind, RescuePlan } from '../../sim';

/**
 * Phase 3B+ — CUMULATIVE RADIATION DOSE · COMPARISON (Evacuation tab, addition only).
 *
 * Curves = the dose profiles computed by the engine with the rescue plan (sim/doseProfile.ts):
 * D(t) = ∫ Ḣ dt along each route at the walking speed, from GS-received cell means — the same data and
 * rules as the route metrics, so each curve ends at the dose shown in the route panel. Nothing is drawn
 * that the plan does not contain: fewer than three distinct candidates → fewer curves.
 * Styling follows the reference: dark rounded panel, thin grid, shaded areas, legend below.
 */
export const ROLE_COLOR: Record<ComparisonRole, string> = { HIGHEST: '#ef4444', ALTERNATIVE: '#f59e0b', RECOMMENDED: '#22c55e' };
const ROLE_NAME: Record<ComparisonRole, string> = {
  HIGHEST: 'Highest-exposure route',
  ALTERNATIVE: 'Alternative route',
  RECOMMENDED: 'Recommended radiation-minimized route',
};
const ROLE_SHORT: Record<ComparisonRole, string> = { HIGHEST: 'highest exposure', ALTERNATIVE: 'alternative', RECOMMENDED: 'recommended' };
const KIND_LABEL: Record<DosePieceKind, string> = { MEASURED: 'measured', GAP_FILL: 'gap · adjacent rate', UNKNOWN: 'no data · lower bound' };
const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const sup = (n: number) => String(n).split('').map((c) => SUP[c] ?? c).join('');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Axis scale for mSv values: mantissa ticks × 10^e (nice steps). */
function niceScale(max_mSv: number): { exp: number; step: number; top: number } {
  if (!(max_mSv > 0)) return { exp: 0, step: 1, top: 1 };
  const exp = Math.floor(Math.log10(max_mSv));
  const m = (max_mSv / 10 ** exp) * 1.12;
  const raw = m / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= raw) ?? raw;
  return { exp, step, top: Math.ceil(m / step) * step };
}

export function fmtMSv(v_mSv: number): string {
  if (v_mSv === 0) return '0 mSv';
  const e = Math.floor(Math.log10(Math.abs(v_mSv)));
  return `${(v_mSv / 10 ** e).toFixed(2)}×10${sup(e)} mSv`;
}

export function DoseComparisonChart({ plan, reference, walkingSpeed_mps }: { plan: RescuePlan | null; reference: { value_mSv: number; label: string } | null; walkingSpeed_mps: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(480);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(280, Math.floor(e[0].contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const routes = useMemo<ComparisonRoute[]>(() => (plan ? comparisonRoutes(plan.candidates, plan.recommendedId) : []), [plan]);

  const H = 172;
  const m = { l: 34, r: 12, t: 16, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const tMax = Math.max(1, ...routes.map((r) => r.profile.duration_s)) * 1.03;
  const refShown = reference && reference.value_mSv > 0 ? reference : null;
  const maxMSv = Math.max(1e-30, ...routes.map((r) => uSvToMSv(r.profile.total_uSv)), refShown ? refShown.value_mSv : 0);
  const sc = niceScale(maxMSv);
  const yTop = sc.top * 10 ** sc.exp;
  const X = (t: number) => m.l + (t / tMax) * pw;
  const Y = (mSv: number) => m.t + ph - (mSv / yTop) * ph;
  // x ticks: nice seconds step
  const xStep = [5, 10, 15, 20, 30, 60, 120, 300].find((s) => tMax / s <= 7) ?? 600;
  const xTicks: number[] = [];
  for (let t = 0; t <= tMax + 1e-9; t += xStep) xTicks.push(t);
  const yTicks: number[] = [];
  for (let v = 0; v <= sc.top + 1e-9; v += sc.step) yTicks.push(v);

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const t = ((e.clientX - r.left - m.l) / pw) * tMax;
    setHover(t >= 0 && t <= tMax ? t : null);
  };

  const rec = routes.find((r) => r.role === 'RECOMMENDED') ?? null;
  const lowest = routes.length ? routes.reduce((a, b) => (b.dose_uSv < a.dose_uSv ? b : a)) : null;
  const notes: string[] = [];
  if (!plan) notes.push('Available once the ground station has the casualty location and a rescue route plan.');
  else if (!routes.length) notes.push('No walkable rescue route — nothing to compare.');
  else {
    if (routes.length < 3) notes.push(`Only ${routes.length} distinct route option${routes.length > 1 ? 's' : ''} in the current plan — no route is invented.`);
    if (plan.status === 'UNVERIFIED') notes.push('⚠ No sufficiently verified low-exposure route: radiation data along the routes is incomplete or above the limit.');
    for (const r of routes) {
      if (r.profile.lowerBound) notes.push(`⚠ ${r.candidateId}: ${Math.round(r.profile.unknown_s)} s on ground without measurements — its curve is a LOWER BOUND (unknown dose is not counted as zero).`);
      else if (r.profile.gapFill_s > 0.5) notes.push(`${r.candidateId}: ${Math.round(r.profile.gapFill_s)} s of short unmeasured gaps use the adjacent measured rate (dashed).`);
    }
    if (rec && lowest && lowest !== rec && lowest.dose_uSv < rec.dose_uSv)
      notes.push(`${rec.candidateId} is recommended although ${lowest.candidateId}'s estimate is lower: the difference is within the dose uncertainty, so the shorter route is kept (see the rule above).`);
  }

  // curve paths split by kind
  const segs = (r: ComparisonRoute) => {
    const out: { kind: DosePieceKind; d: string }[] = [];
    const pts = r.profile.points;
    for (let i = 1; i < pts.length; i++) {
      const k = pts[i].kind;
      const a = `${X(pts[i - 1].t_s).toFixed(1)},${Y(uSvToMSv(pts[i - 1].dose_uSv)).toFixed(1)}`;
      const b = `${X(pts[i].t_s).toFixed(1)},${Y(uSvToMSv(pts[i].dose_uSv)).toFixed(1)}`;
      const last = out[out.length - 1];
      if (last && last.kind === k) last.d += ` L${b}`;
      else out.push({ kind: k, d: `M${a} L${b}` });
    }
    return out;
  };
  const area = (r: ComparisonRoute) => {
    const pts = r.profile.points;
    const line = pts.map((p) => `${X(p.t_s).toFixed(1)},${Y(uSvToMSv(p.dose_uSv)).toFixed(1)}`).join(' L');
    return `M${X(0)},${Y(0)} L${line} L${X(pts[pts.length - 1].t_s).toFixed(1)},${Y(0)} Z`;
  };

  return (
    <section className="dose-cmp" aria-label="Cumulative radiation dose comparison">
      <header>
        <span className="dc-title">
          <svg width="13" height="11" viewBox="0 0 13 11" aria-hidden>
            <path d="M1 10 L4.5 6 L7.5 8 L12 1.5" fill="none" stroke="#f2b01e" strokeWidth="1.5" />
            <path d="M1 1 V10 H12" fill="none" stroke="#f2b01e" strokeWidth="1" opacity="0.6" />
          </svg>
          CUMULATIVE RADIATION DOSE · COMPARISON
        </span>
        <span className="dc-unit" title="Simulated ambient dose equivalent from the drone's dose-rate readings, integrated over walking time. Sievert is a dose-equivalent unit (absorbed dose would be gray).">
          mSv · dose estimate
        </span>
      </header>
      <div className="dc-plot" ref={wrap}>
        <svg width={W} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Cumulative dose versus walking time for each rescue route">
          <defs>
            {routes.map((r) => (
              <linearGradient key={r.role} id={`dcg-${r.role}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={ROLE_COLOR[r.role]} stopOpacity="0.26" />
                <stop offset="1" stopColor={ROLE_COLOR[r.role]} stopOpacity="0.02" />
              </linearGradient>
            ))}
          </defs>
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={m.l} x2={W - m.r} y1={Y(v * 10 ** sc.exp)} y2={Y(v * 10 ** sc.exp)} className="dc-grid" />
              <text x={m.l - 6} y={Y(v * 10 ** sc.exp) + 3} className="dc-tick" textAnchor="end">
                {Number(v.toFixed(3))}
              </text>
            </g>
          ))}
          <text x={4} y={m.t - 6} className="dc-tick dc-exp">
            ×10
            <tspan dy={-3.5} fontSize={7}>
              {sc.exp < 0 ? '−' : ''}
              {Math.abs(sc.exp)}
            </tspan>
            <tspan dy={3.5}> mSv</tspan>
          </text>
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={X(t)} x2={X(t)} y1={m.t} y2={m.t + ph} className="dc-grid v" />
              <text x={X(t)} y={H - 8} className="dc-tick" textAnchor="middle">
                T+{mmss(t)}
              </text>
            </g>
          ))}
          {refShown && (
            <g>
              <line x1={m.l} x2={W - m.r} y1={Y(refShown.value_mSv)} y2={Y(refShown.value_mSv)} className="dc-ref" />
              <text x={W - m.r - 4} y={Y(refShown.value_mSv) - 4} className="dc-ref-label" textAnchor="end">
                {refShown.label} {refShown.value_mSv} mSv
              </text>
            </g>
          )}
          {routes.map((r) => (
            <path key={`a${r.role}`} d={area(r)} fill={`url(#dcg-${r.role})`} stroke="none" />
          ))}
          {routes.map((r) =>
            segs(r).map((sg, i) => (
              <path
                key={`l${r.role}${i}`}
                d={sg.d}
                fill="none"
                stroke={ROLE_COLOR[r.role]}
                strokeWidth={r.role === 'RECOMMENDED' ? 2.2 : 1.8}
                strokeDasharray={sg.kind === 'MEASURED' ? undefined : sg.kind === 'GAP_FILL' ? '5 3' : '1.5 3'}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )),
          )}
          {routes.map((r) => {
            const last = r.profile.points[r.profile.points.length - 1];
            return <circle key={`e${r.role}`} cx={X(last.t_s)} cy={Y(uSvToMSv(last.dose_uSv))} r={2.6} fill={ROLE_COLOR[r.role]} />;
          })}
          {hover !== null && (
            <g>
              <line x1={X(hover)} x2={X(hover)} y1={m.t} y2={m.t + ph} className="dc-cross" />
              {routes.map((r) => (
                <circle key={`h${r.role}`} cx={X(Math.min(hover, r.profile.duration_s))} cy={Y(uSvToMSv(doseAt(r.profile, hover)))} r={3.2} fill="#0d0f12" stroke={ROLE_COLOR[r.role]} strokeWidth={1.6} />
              ))}
            </g>
          )}
          {!routes.length && (
            <text x={W / 2} y={H / 2} className="dc-empty" textAnchor="middle">
              No route data yet
            </text>
          )}
        </svg>
        {hover !== null && routes.length > 0 && (
          <div className="dc-tip" style={X(hover) > m.l + pw / 2 ? { left: Math.max(0, X(hover) - 196) } : { left: Math.min(W - 186, X(hover) + 12) }}>
            <b>T+{mmss(hover)}</b>
            {routes.map((r) => {
              const arrived = hover >= r.profile.duration_s;
              const pt = r.profile.points.find((p) => p.t_s >= Math.min(hover, r.profile.duration_s)) ?? r.profile.points[r.profile.points.length - 1];
              return (
                <div key={r.role}>
                  <i style={{ background: ROLE_COLOR[r.role] }} />
                  <span>
                    {r.candidateId} · {ROLE_SHORT[r.role]}
                  </span>
                  <em>
                    {fmtMSv(uSvToMSv(doseAt(r.profile, hover)))}
                    {r.profile.lowerBound ? ' (≥)' : ''}
                  </em>
                  <small>{arrived ? `arrived at T+${mmss(r.profile.duration_s)}` : `${KIND_LABEL[pt.kind]}${pt.rate_uSv_h !== null ? ` · ${pt.rate_uSv_h.toFixed(2)} µSv/h` : ''}`}</small>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="dc-legend">
        {routes.map((r) => (
          <span key={r.role} title={`${r.label} · ${Math.round(r.measuredFraction * 100)}% measured · 1σ (counting) ${fmtMSv(uSvToMSv(r.sigma_uSv))}${r.verified ? '' : ' · not verified'}`}>
            <i style={{ background: ROLE_COLOR[r.role] }} />
            {ROLE_NAME[r.role]} <b>{r.candidateId}</b>
            <em>
              {r.profile.lowerBound ? '≥ ' : ''}
              {fmtMSv(uSvToMSv(r.dose_uSv))} · {mmss(r.profile.duration_s)} min
            </em>
          </span>
        ))}
      </div>
      <div className="dc-keys">
        <span>
          <i className="solid" /> measured
        </span>
        <span>
          <i className="dash" /> short gap (adjacent rate)
        </span>
        <span>
          <i className="dot" /> no data (not counted)
        </span>
        {!refShown && <span className="muted">no dose reference line configured</span>}
      </div>
      {notes.length > 0 && (
        <ul className="dc-notes">
          {notes.map((n, i) => (
            <li key={i} className={n.startsWith('⚠') ? 'warn' : ''}>
              {n}
            </li>
          ))}
        </ul>
      )}
      <div className="dc-foot">
        D(t) = ∫ Ḣ dt along each route at the assumed team walking speed ({walkingSpeed_mps} m/s), from dose rates measured by BEE-01 at 8–15 m altitude and received at the
        ground station. Ground-level exposure is model-based and uncertain — there is no altitude correction, and near a source the ground-level dose can be
        much higher. Planning aid only; no route is guaranteed safe.
      </div>
    </section>
  );
}
