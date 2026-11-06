import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';

/**
 * Lightweight SVG time-series chart (no chart library — cheap on integrated GPUs).
 * Dark "mission control" styling: 2 px lines with optional soft area fill,
 * recessive grid, dashed reference line, crosshair + tooltip listing every
 * series at the hovered time, legend whenever there are ≥ 2 series.
 * Only the points passed in are drawn — nothing is extrapolated.
 */
export interface TimeSeries {
  name: string;
  color: string;
  points: { t: number; v: number }[];
  dashed?: boolean;
  /** Soft gradient fill under the line. */
  area?: boolean;
  /** Draw dots (for sparse, irregular samples such as received packets). */
  dots?: boolean;
}

interface Props {
  series: TimeSeries[];
  unit: string;
  height?: number;
  reference?: { v: number; label: string; color?: string };
  /** Fixed x-range, e.g. [0, current sim time] so the chart advances with the simulation. */
  xDomain?: [number, number];
  digits?: number;
  emptyText?: string;
  ariaLabel: string;
}

const PAD = { l: 42, r: 10, t: 14, b: 22 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function thin(pts: { t: number; v: number }[], max = 320) {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}

const fmtTick = (v: number) => (v === 0 ? '0' : v < 1 ? Number(v.toPrecision(2)).toString() : v < 10 ? v.toFixed(1) : v.toFixed(0));

export function TimeChart({ series, unit, height = 130, reference, xDomain, digits = 2, emptyText = 'No data yet', ariaLabel }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const gid = useId().replace(/:/g, '');
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [W, setW] = useState(380);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(240, Math.floor(e[0].contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const all = series.flatMap((s) => s.points);
  const H = height;

  if (!all.length) {
    return (
      <div className="chart" ref={wrap}>
        <div className="chart-empty" style={{ height: H }}>
          {emptyText}
        </div>
      </div>
    );
  }

  let t0 = Infinity;
  let t1 = -Infinity;
  let vmax = reference?.v ?? 0;
  for (const p of all) {
    if (p.t < t0) t0 = p.t;
    if (p.t > t1) t1 = p.t;
    if (p.v > vmax) vmax = p.v;
  }
  if (xDomain) [t0, t1] = xDomain;
  if (t1 <= t0) t1 = t0 + 1;
  vmax = niceMax(vmax * 1.08);

  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / vmax) * (H - PAD.t - PAD.b);
  const ticksY = [0, vmax / 4, vmax / 2, (3 * vmax) / 4, vmax];
  const ticksX = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0));

  const nearest = (s: TimeSeries, t: number) => {
    let best: { t: number; v: number } | null = null;
    for (const p of s.points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best;
  };
  const onMove = (e: RPointerEvent) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    setHoverT(Math.min(t1, Math.max(t0, t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0))));
  };
  const hover = hoverT === null ? null : series.map((s) => ({ s, p: nearest(s, hoverT) })).filter((h) => h.p);
  const hx = hover && hover[0]?.p ? x(hover[0].p.t) : null;
  const refColor = reference?.color ?? '#ef4444';

  return (
    <div className="chart" ref={wrap}>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHoverT(null)}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`${gid}-g${i}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.38} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        {ticksY.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.l - 5} y={y(v) + 3} textAnchor="end" className="tick">
              {fmtTick(v)}
            </text>
          </g>
        ))}
        {ticksX.map((t, i) => (
          <g key={i}>
            <line x1={x(t)} x2={x(t)} y1={PAD.t} y2={H - PAD.b} className="grid v" />
            <text x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} className="tick">
              T+{t.toFixed(0)}s
            </text>
          </g>
        ))}
        {reference && reference.v <= vmax && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(reference.v)} y2={y(reference.v)} stroke={refColor} strokeDasharray="5 4" strokeWidth={1.2} opacity={0.85} />
            <text x={W - PAD.r - 2} y={y(reference.v) - 4} textAnchor="end" className="tick ref-label" fill={refColor}>
              {reference.label}
            </text>
          </g>
        )}
        {series.map((s, i) => {
          const pts = thin(s.points).filter((p) => p.t >= t0 - 1e-9 && p.t <= t1 + 1e-9);
          if (!pts.length) return null;
          const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
          return (
            <g key={s.name}>
              {s.area && pts.length > 1 && (
                <polygon points={`${x(pts[0].t).toFixed(1)},${y(0)} ${line} ${x(pts[pts.length - 1].t).toFixed(1)},${y(0)}`} fill={`url(#${gid}-g${i})`} />
              )}
              <polyline points={line} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '4 3' : undefined} />
              {s.dots && pts.length < 160 && pts.map((p, k) => <circle key={k} cx={x(p.t)} cy={y(p.v)} r={1.6} fill={s.color} />)}
            </g>
          );
        })}
        {hx !== null && (
          <g>
            <line x1={hx} x2={hx} y1={PAD.t} y2={H - PAD.b} className="crosshair" />
            {hover!.map((h) => (
              <circle key={h.s.name} cx={x(h.p!.t)} cy={y(h.p!.v)} r={4} fill={h.s.color} stroke="#0b0e12" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ borderTopColor: s.color, borderTopStyle: s.dashed ? 'dashed' : 'solid' }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {hover && hover.length > 0 && (
        <div className="chart-tip" style={{ left: `${Math.min(72, Math.max(8, ((hx ?? 0) / W) * 100))}%` }}>
          <div className="tip-t">t = {hover[0].p!.t.toFixed(1)} s</div>
          {hover.map((h) => (
            <div key={h.s.name}>
              <i style={{ borderTopColor: h.s.color }} />
              <b>
                {h.p!.v < 0.01 && h.p!.v > 0 ? h.p!.v.toExponential(2) : h.p!.v.toFixed(digits)} {unit}
              </b>{' '}
              <span>{h.s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
