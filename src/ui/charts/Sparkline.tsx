/**
 * Tiny SVG trend of RECEIVED samples only. With fewer than two samples it
 * draws nothing (no artificial history). Optional dashed band marks a
 * score-0 range for context.
 */
interface Props {
  points: { t: number; v: number }[];
  color: string;
  /** Fixed y-range so the trend does not rescale every update. */
  yMin: number;
  yMax: number;
  band?: [number, number];
  dim?: boolean;
  height?: number;
  ariaLabel: string;
}

export function Sparkline({ points, color, yMin, yMax, band, dim = false, height = 38, ariaLabel }: Props) {
  const W = 160;
  const H = height;
  if (points.length < 2) {
    return (
      <div className="spark-empty" style={{ height: H }}>
        {points.length === 0 ? 'no samples received' : '1 sample received'}
      </div>
    );
  }
  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, t0 + 1);
  const x = (t: number) => 2 + ((t - t0) / (t1 - t0)) * (W - 4);
  const y = (v: number) => H - 3 - ((Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin)) * (H - 6);
  const line = points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={ariaLabel} opacity={dim ? 0.45 : 1}>
      {band && <rect x={0} width={W} y={y(band[1])} height={Math.max(0, y(band[0]) - y(band[1]))} fill="rgba(148,163,184,0.08)" />}
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.t)} cy={y(last.v)} r={2.6} fill={color} />
    </svg>
  );
}
