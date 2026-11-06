import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { CELL_ESTIMATED, interpolateIdw } from '../../sim';
import type { HeatmapGrid, P2, ReportedHotspot, RouteRun } from '../../sim';
import { simController } from '../../state/simController';
import { doseScale, logNorm, logValue, rampCss, rampRGB } from '../../viz/colormap';

/**
 * Tactical radiation map (2D <canvas>, one redraw per dashboard tick — cheap on Intel GPUs).
 *
 * Layers, bottom → top:
 *   dark map, 10 m / 50 m grid · hatched UNKNOWN ground · optional ESTIMATE layer
 *   (IDW, stippled, ≤ maxDistance from a measurement) · MEASURED layer (cell means,
 *   display-smoothed only INSIDE measured cells — clipped so colour never bleeds
 *   into unmeasured ground) · obstacles · evacuation route · markers.
 *
 * Markers are drawn only when a location is available:
 *   bees  — last position the ground station received (heartbeat payload)
 *   casualty — GS location estimate ± 1σ
 *   peak reading — highest measured sample in the data source
 *   mother — simulator position (its command link is not part of the comms model)
 *   source — scenario configuration (reference), optional
 */
export interface MapRoute {
  runs: RouteRun[];
  ghost?: boolean;
}

/** Phase 3A: candidate evacuation corridor (thin line, coloured by survey status). */
export interface MapCandidate {
  id: string;
  points: P2[];
  status: 'SURVEYED' | 'PARTIAL' | 'UNKNOWN' | null;
  selected: boolean;
}

const CAND_COLOR: Record<string, string> = { SURVEYED: '#4ade80', PARTIAL: '#fbbf24', UNKNOWN: '#94a3b8' };

interface Props {
  grid: HeatmapGrid;
  routes?: MapRoute[];
  smooth?: boolean;
  showEstimate?: boolean;
  showSourceRef?: boolean;
  /** Peak measured sample (x, z, value) in the shown data source. */
  peak?: { x: number; z: number; v: number } | null;
  /** 'fit' zooms to measured ground + key sites; 'site' shows the whole grid. */
  extent?: 'fit' | 'site';
  /** Phase 3A: designated survey area outline. */
  surveyArea?: { x0: number; z0: number; x1: number; z1: number } | null;
  /** Phase 3A: hotspots reported by BEE-01 (received at the GS). */
  hotspots?: ReportedHotspot[];
  /** Phase 3A: candidate corridors. */
  candidates?: MapCandidate[];
}

const ASPECT = 0.78; // height / width of the map

const BEE_COLORS: Record<string, string> = { 'BEE-01': '#22d3ee', 'BEE-02': '#f472b6', 'BEE-03': '#a3e635' };
export const ESTIMATE_MAX_DISTANCE_M = 12;

export function TacticalMap({ grid, routes = [], smooth = true, showEstimate = false, showSourceRef = true, peak = null, extent = 'fit', surveyArea = null, hotspots = [], candidates = [] }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const [cssW, setCssW] = useState(380);
  const engine = simController.engine;
  const s = engine.state;
  const cfg = engine.config;
  const worldW = grid.nx * grid.cell;
  const worldH = grid.nz * grid.cell;
  const cssH = Math.round(cssW * ASPECT);

  // ---- view window (world metres): fit to what matters, keep a fixed aspect
  let bx0 = Infinity;
  let bz0 = Infinity;
  let bx1 = -Infinity;
  let bz1 = -Infinity;
  const inc = (x: number, z: number) => {
    bx0 = Math.min(bx0, x);
    bz0 = Math.min(bz0, z);
    bx1 = Math.max(bx1, x);
    bz1 = Math.max(bz1, z);
  };
  if (extent === 'site') {
    inc(grid.x0, grid.z0);
    inc(grid.x0 + worldW, grid.z0 + worldH);
  } else {
    for (const o of engine.world.obstacles) inc(o.cx, o.cz);
    const gsP = engine.world.groundStation.position;
    inc(gsP.x, gsP.z);
    const cp = cfg.evacuation.collectionPoint.position;
    inc(cp.x, cp.z);
    if (showSourceRef) inc(cfg.radiation.sourcePosition.x, cfg.radiation.sourcePosition.z);
    for (const p of s.comms.gs.patients) if (p.location) inc(p.location.x, p.location.z);
    if (surveyArea) {
      inc(surveyArea.x0, surveyArea.z0);
      inc(surveyArea.x1, surveyArea.z1);
    }
    for (let i = 0; i < grid.values.length; i++) {
      if (Number.isNaN(grid.values[i])) continue;
      const cx = grid.x0 + ((i % grid.nx) + 0.5) * grid.cell;
      const cz = grid.z0 + (Math.floor(i / grid.nx) + 0.5) * grid.cell;
      inc(cx, cz);
    }
  }
  const PADM = extent === 'site' ? 0 : 12;
  bx0 -= PADM;
  bz0 -= PADM;
  bx1 += PADM;
  bz1 += PADM;
  // expand to the canvas aspect ratio
  {
    const w = bx1 - bx0;
    const h = bz1 - bz0;
    if (h / w > ASPECT) {
      const nw = h / ASPECT;
      bx0 -= (nw - w) / 2;
      bx1 = bx0 + nw;
    } else {
      const nh = w * ASPECT;
      bz0 -= (nh - h) / 2;
      bz1 = bz0 + nh;
    }
  }
  const viewW = bx1 - bx0;
  const k = cssW / viewW;
  const vx0 = bx0;
  const vz0 = bz0;
  const { lo, hi } = doseScale(cfg.radiation.background_uSv_h, grid.max);
  const est = useMemo(() => (showEstimate ? interpolateIdw(grid, ESTIMATE_MAX_DISTANCE_M, 2) : null), [grid, showEstimate]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((e) => setCssW(Math.max(220, Math.floor(e[0].contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const P = (x: number, z: number) => [(x - vx0) * k, (z - vz0) * k] as const;
    const [gx0, gz0] = P(grid.x0, grid.z0);
    const cpx = grid.cell * k;

    // ---- base map
    const bg = g.createRadialGradient(cssW * 0.55, cssH * 0.45, 10, cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.75);
    bg.addColorStop(0, '#141a1f');
    bg.addColorStop(1, '#090c0f');
    g.fillStyle = bg;
    g.fillRect(0, 0, cssW, cssH);
    for (let wx = Math.ceil(vx0 / 10) * 10; wx <= vx0 + viewW; wx += 10) {
      const [px] = P(wx, 0);
      g.strokeStyle = wx % 50 === 0 ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.06)';
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, cssH);
      g.stroke();
    }
    for (let wz = Math.ceil(vz0 / 10) * 10; wz <= vz0 + viewW * ASPECT; wz += 10) {
      const [, py] = P(0, wz);
      g.strokeStyle = wz % 50 === 0 ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.06)';
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(cssW, py);
      g.stroke();
    }
    // access road (visual reference only)
    {
      const gsP = engine.world.groundStation.position;
      const [ax, ay] = P(gsP.x + 8, gsP.z - 8);
      const [bx, by] = P(-30, 24);
      g.strokeStyle = 'rgba(148,163,184,0.10)';
      g.lineWidth = 6 * k;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
      g.lineWidth = 1;
    }

    // ---- unknown ground: hatch everywhere, measured/estimated layers paint over it
    const pat = document.createElement('canvas');
    pat.width = pat.height = 8;
    const pg = pat.getContext('2d')!;
    pg.strokeStyle = 'rgba(148,163,184,0.13)';
    pg.lineWidth = 1;
    pg.beginPath();
    pg.moveTo(0, 8);
    pg.lineTo(8, 0);
    pg.stroke();
    const hatch = g.createPattern(pat, 'repeat');
    if (hatch) {
      g.fillStyle = hatch;
      g.fillRect(0, 0, cssW, cssH);
    }

    // ---- helper: paint a 1-px-per-cell image of a value field, scaled up
    const paint = (values: Float64Array, pick: (k: number) => boolean, alpha: number, blurPx: number) => {
      const off = document.createElement('canvas');
      off.width = grid.nx;
      off.height = grid.nz;
      const og = off.getContext('2d')!;
      const img = og.createImageData(grid.nx, grid.nz);
      for (let i = 0; i < values.length; i++) {
        if (!pick(i)) continue;
        const [r, gg, b] = rampRGB(logNorm(values[i], lo, hi));
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = gg;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = Math.round(alpha * 255);
      }
      og.putImageData(img, 0, 0);
      // clip to the picked cells so smoothing can never spill into other ground
      const clip = new Path2D();
      for (let i = 0; i < values.length; i++) if (pick(i)) clip.rect(gx0 + (i % grid.nx) * cpx, gz0 + Math.floor(i / grid.nx) * cpx, cpx + 0.5, cpx + 0.5);
      g.save();
      g.clip(clip);
      g.imageSmoothingEnabled = smooth;
      g.imageSmoothingQuality = 'high';
      if (smooth && blurPx > 0) g.filter = `blur(${blurPx}px)`;
      g.drawImage(off, gx0, gz0, worldW * k, worldH * k);
      g.filter = 'none';
      g.restore();
      return clip;
    };

    // ---- optional estimate layer (stippled)
    if (est && est.estimated > 0) {
      const clip = paint(est.values, (i) => est.kind[i] === CELL_ESTIMATED, 0.42, cpx * 0.35);
      const dots = document.createElement('canvas');
      dots.width = dots.height = 5;
      const dg = dots.getContext('2d')!;
      dg.fillStyle = 'rgba(15,23,42,0.75)';
      dg.fillRect(1, 1, 1.4, 1.4);
      const dp = g.createPattern(dots, 'repeat');
      if (dp) {
        g.save();
        g.clip(clip);
        g.fillStyle = dp;
        g.fillRect(0, 0, cssW, cssH);
        g.restore();
      }
    }

    // ---- measured layer
    const measuredClip = paint(grid.values, (i) => !Number.isNaN(grid.values[i]), 0.9, cpx * 0.45);
    g.strokeStyle = 'rgba(250,250,250,0.10)';
    g.lineWidth = 0.6;
    if (!smooth) g.stroke(measuredClip);

    // ---- obstacles (site plan)
    for (const o of engine.world.obstacles) {
      g.beginPath();
      if (o.shape === 'box') {
        const [x, y] = P(o.cx - o.hx, o.cz - o.hz);
        g.rect(x, y, o.hx * 2 * k, o.hz * 2 * k);
      } else {
        const [x, y] = P(o.cx, o.cz);
        g.arc(x, y, Math.max(1.5, o.radius * k), 0, Math.PI * 2);
      }
      g.fillStyle = 'rgba(30,38,48,0.92)';
      g.fill();
      g.strokeStyle = 'rgba(148,163,184,0.75)';
      g.lineWidth = 1;
      g.stroke();
    }

    // ---- survey area outline
    if (surveyArea) {
      const [x0, y0] = P(surveyArea.x0, surveyArea.z0);
      const [x1, y1] = P(surveyArea.x1, surveyArea.z1);
      g.setLineDash([5, 4]);
      g.strokeStyle = 'rgba(34,211,238,0.75)';
      g.lineWidth = 1.2;
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.setLineDash([]);
      g.font = '600 8.5px "Cascadia Mono", Consolas, monospace';
      g.fillStyle = 'rgba(103,232,249,0.9)';
      g.fillText('SURVEY AREA', x0 + 3, y1 - 4);
    }

    // ---- candidate corridors (thin), labelled at their middle
    for (const c of candidates) {
      if (c.points.length < 2 || c.selected) continue;
      const path = new Path2D();
      c.points.forEach((p, i) => {
        const [x, y] = P(p.x, p.z);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      g.setLineDash(c.status === 'SURVEYED' ? [] : [4, 4]);
      g.strokeStyle = CAND_COLOR[c.status ?? 'UNKNOWN'];
      g.globalAlpha = 0.75;
      g.lineWidth = 1.3;
      g.stroke(path);
      g.globalAlpha = 1;
    }
    g.setLineDash([]);

    // ---- routes
    for (const r of routes) {
      for (const run of r.runs) {
        if (run.points.length < 2) continue;
        const path = new Path2D();
        run.points.forEach((p: P2, i: number) => {
          const [x, y] = P(p.x, p.z);
          if (i === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        });
        if (r.ghost) {
          g.setLineDash([2, 3]);
          g.strokeStyle = 'rgba(148,163,184,0.55)';
          g.lineWidth = 1.2;
          g.stroke(path);
          continue;
        }
        g.setLineDash(run.known ? [] : [6, 5]);
        g.strokeStyle = 'rgba(34,197,94,0.25)';
        g.lineWidth = 6;
        g.stroke(path);
        g.strokeStyle = run.known ? '#22c55e' : '#86efac';
        g.lineWidth = 2;
        g.stroke(path);
      }
    }
    g.setLineDash([]);

    // ---- markers
    const label = (x: number, y: number, text: string, color: string) => {
      g.font = '600 9.5px "Cascadia Mono", Consolas, monospace';
      const w = g.measureText(text).width + 6;
      const lx = Math.min(cssW - w - 2, Math.max(2, x + 7));
      const ly = Math.max(2, y - 16);
      g.fillStyle = 'rgba(9,12,15,0.85)';
      g.fillRect(lx, ly, w, 13);
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.strokeRect(lx + 0.5, ly + 0.5, w - 1, 12);
      g.fillStyle = color;
      g.fillText(text, lx + 3, ly + 10);
    };
    const pin = (x: number, y: number, color: string) => {
      g.beginPath();
      g.moveTo(x, y);
      g.bezierCurveTo(x - 7, y - 9, x - 5, y - 15, x, y - 15);
      g.bezierCurveTo(x + 5, y - 15, x + 7, y - 9, x, y);
      g.fillStyle = color;
      g.fill();
      g.beginPath();
      g.arc(x, y - 10, 2.2, 0, Math.PI * 2);
      g.fillStyle = '#0b0e12';
      g.fill();
    };

    // scenario source reference
    if (showSourceRef) {
      const sp = cfg.radiation.sourcePosition;
      const [x, y] = P(sp.x, sp.z);
      g.setLineDash([3, 3]);
      g.strokeStyle = 'rgba(253,224,71,0.85)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        g.beginPath();
        g.moveTo(x, y);
        g.arc(x, y, 5, a - 0.5, a + 0.5);
        g.closePath();
        g.fillStyle = '#fde047';
        g.fill();
      }
      label(x - 2, y + 30, 'SRC · scenario ref', '#fde047');
    }
    // peak measured
    if (peak) {
      const [x, y] = P(peak.x, peak.z);
      g.beginPath();
      g.moveTo(x, y - 6);
      g.lineTo(x + 5, y + 4);
      g.lineTo(x - 5, y + 4);
      g.closePath();
      g.fillStyle = '#ef4444';
      g.fill();
      g.strokeStyle = '#0b0e12';
      g.stroke();
      label(x, y - 6, `PEAK ${peak.v.toFixed(2)} µSv/h`, '#fca5a5');
    }
    // reported hotspots (BEE-01 heartbeat → GS)
    for (const h of hotspots) {
      const [x, y] = P(h.x, h.z);
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.strokeStyle = '#fb923c';
      g.lineWidth = 1.5;
      g.setLineDash(h.scan === 'SCANNED' ? [] : [2, 2]);
      g.stroke();
      g.setLineDash([]);
      label(x + 4, y + 22, `${h.id} ${h.peak_uSv_h.toFixed(2)} · ${h.scan.toLowerCase()}`, '#fdba74');
    }
    // candidate labels
    for (const c of candidates) {
      if (c.points.length < 2) continue;
      const m = c.points[Math.floor(c.points.length / 2)];
      const [x, y] = P(m.x, m.z);
      label(x - 10, y + 10, c.id + (c.selected ? ' ★' : ''), c.selected ? '#86efac' : CAND_COLOR[c.status ?? 'UNKNOWN']);
    }
    // ground station + collection point
    const gsP = engine.world.groundStation.position;
    {
      const [x, y] = P(gsP.x, gsP.z);
      g.fillStyle = '#60a5fa';
      g.fillRect(x - 5, y - 5, 10, 10);
      g.strokeStyle = '#0b0e12';
      g.strokeRect(x - 5, y - 5, 10, 10);
      label(x, y, 'GS-1', '#93c5fd');
    }
    {
      const c = cfg.evacuation.collectionPoint;
      const [x, y] = P(c.position.x, c.position.z);
      g.strokeStyle = '#22c55e';
      g.lineWidth = 2;
      g.strokeRect(x - 5, y - 5, 10, 10);
      g.beginPath();
      g.moveTo(x - 2, y + 2);
      g.lineTo(x + 3, y - 3);
      g.stroke();
      label(x, y, c.id, '#86efac');
    }
    // mother (simulator position — command link not modelled)
    {
      const m = s.mother;
      if (m.mode !== 'STANDBY' || s.status !== 'READY') {
        const [x, y] = P(m.position.x, m.position.z);
        if (x >= 0 && y >= 0 && x <= cssW && y <= cssH) {
          g.save();
          g.translate(x, y);
          g.rotate(Math.PI / 4);
          g.fillStyle = '#e5e7eb';
          g.fillRect(-5, -5, 10, 10);
          g.fillStyle = '#111827';
          g.fillRect(-2.5, -2.5, 5, 5);
          g.restore();
          label(x, y, 'MOTHER-01', '#e5e7eb');
        }
      }
    }
    // bees: last position received at the GS
    const lastHb = new Map<string, { x: number; z: number; t: number }>();
    for (const msg of s.comms.messages) {
      if (msg.status === 'DELIVERED' && msg.type === 'HEARTBEAT') lastHb.set(msg.src, { x: msg.data.x as number, z: msg.data.z as number, t: msg.tSent });
    }
    for (const [id, p] of lastHb) {
      const [x, y] = P(p.x, p.z);
      const stale = s.time - p.t > cfg.alerts.droneOffline_s;
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fillStyle = 'rgba(9,12,15,0.6)';
      g.fill();
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fillStyle = stale ? '#64748b' : BEE_COLORS[id];
      g.fill();
      g.strokeStyle = '#0b0e12';
      g.lineWidth = 1.5;
      g.stroke();
      label(x, y, stale ? `${id} · ${(s.time - p.t).toFixed(0)}s old` : id, stale ? '#94a3b8' : BEE_COLORS[id]);
    }
    // casualty estimate ± 1σ
    for (const p of s.comms.gs.patients) {
      if (!p.location) continue;
      const [x, y] = P(p.location.x, p.location.z);
      g.beginPath();
      g.arc(x, y, Math.max(4, p.location.sigma_m * k), 0, Math.PI * 2);
      g.strokeStyle = 'rgba(251,146,60,0.9)';
      g.lineWidth = 1.2;
      g.stroke();
      pin(x, y, '#f97316');
      label(x, y - 14, p.patientId, '#fdba74');
    }

    // ---- north arrow (−z is north) + scale bar
    {
      const x = cssW - 18;
      const y = 20;
      g.fillStyle = 'rgba(229,231,235,0.85)';
      g.beginPath();
      g.moveTo(x, y - 10);
      g.lineTo(x + 5, y + 4);
      g.lineTo(x, y + 1);
      g.lineTo(x - 5, y + 4);
      g.closePath();
      g.fill();
      g.font = '600 9px system-ui, sans-serif';
      g.fillText('N', x - 3, y + 15);
      const len = 20 * k;
      g.strokeStyle = 'rgba(229,231,235,0.85)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(10, cssH - 12);
      g.lineTo(10 + len, cssH - 12);
      g.moveTo(10, cssH - 16);
      g.lineTo(10, cssH - 8);
      g.moveTo(10 + len, cssH - 16);
      g.lineTo(10 + len, cssH - 8);
      g.stroke();
      g.fillText('20 m', 14 + len, cssH - 8);
    }
  });

  const onMove = (e: RPointerEvent) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r) return;
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const ix = Math.floor((vx0 + mx / k - grid.x0) / grid.cell);
    const iz = Math.floor((vz0 + my / k - grid.z0) / grid.cell);
    if (ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz) return setTip(null);
    const i = iz * grid.nx + ix;
    const v = grid.values[i];
    const head = `x ${(grid.x0 + ix * grid.cell).toFixed(0)}…${(grid.x0 + (ix + 1) * grid.cell).toFixed(0)} · z ${(grid.z0 + iz * grid.cell).toFixed(0)}…${(grid.z0 + (iz + 1) * grid.cell).toFixed(0)} m`;
    let lines: string[];
    if (!Number.isNaN(v)) {
      lines = [
        head,
        `MEASURED ${v.toFixed(3)} µSv/h`,
        `${grid.counts[i]} sample${grid.counts[i] > 1 ? 's' : ''} · last t = ${grid.lastTime[i].toFixed(1)} s`,
        `at ≈ ${grid.meanAlt[i].toFixed(0)} m altitude`,
      ];
    } else if (est && est.kind[i] === CELL_ESTIMATED) {
      lines = [head, `ESTIMATE ${est.values[i].toFixed(3)} µSv/h`, `IDW interpolation — not a measurement`];
    } else {
      lines = [head, 'UNKNOWN — no measurement'];
    }
    setTip({ x: mx, y: my, lines });
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => logValue(t, lo, hi));
  return (
    <div className="tmap" ref={wrap}>
      <canvas ref={canvas} style={{ width: cssW, height: cssH }} onPointerMove={onMove} onPointerLeave={() => setTip(null)} role="img" aria-label="Tactical radiation map" />
      {tip && (
        <div className="map-tip" style={{ left: Math.min(cssW - 196, tip.x + 12), top: Math.max(0, tip.y - 12) }}>
          {tip.lines.map((t, i) => (
            <div key={i} className={i === 1 ? 'strong' : ''}>
              {t}
            </div>
          ))}
        </div>
      )}
      <div className="tmap-legend">
        <div className="tl-scale">
          <div className="tl-title">DOSE RATE (µSv/h) · MEASURED · LOG SCALE</div>
          <div className="tl-bar" style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => rampCss(t)).join(', ')})` }} />
          <div className="tl-ticks">
            {ticks.map((v, i) => (
              <span key={i}>{v < 1 ? v.toFixed(2) : v.toFixed(1)}</span>
            ))}
          </div>
        </div>
        <div className="tl-keys">
          <span>
            <i className="k-unk" /> Unknown (not measured)
          </span>
          {showEstimate && (
            <span>
              <i className="k-est" /> Estimate (IDW ≤ {ESTIMATE_MAX_DISTANCE_M} m)
            </span>
          )}
          <span>
            <i className="k-route" /> Evac route · measured
          </span>
          <span>
            <i className="k-route-unk" /> over unknown
          </span>
          <span>
            <i className="k-cas" /> Casualty est.
          </span>
          <span>
            <i className="k-peak" /> Peak reading
          </span>
          {surveyArea && (
            <span>
              <i className="k-area" /> Survey area
            </span>
          )}
          {candidates.length > 0 && (
            <span>
              <i className="k-cand" /> Candidates: green surveyed · amber partial · grey unknown
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Backwards-compatible name used by earlier panels. */
export const SiteMap = TacticalMap;
