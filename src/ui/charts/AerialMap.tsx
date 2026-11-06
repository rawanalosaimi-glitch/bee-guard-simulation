import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, WheelEvent as RWheelEvent } from 'react';
import { CELL_ESTIMATED, PHASE_LABEL, interpolateIdw, patientViews, smoothedGrid } from '../../sim';
import type { HeatmapGrid, P2, ReportedHotspot, RescueSection, RescueStatus } from '../../sim';
import { simController } from '../../state/simController';
import { useAerialImage } from '../../state/aerial';
import { useViewSettings, viewSettings } from '../../state/viewSettings';
import { doseScale, logNorm, logValue, rampCss, rampRGB } from '../../viz/colormap';
import { buildEstimateField, buildHeatField, contourSegments } from '../../viz/heatField';
import type { HeatField } from '../../viz/heatField';
import type { MapCandidate, MapRoute } from './SiteMap';

/**
 * Aerial radiation map (Phase 3B).
 *
 * Base layer: an orthographic top-down capture of the ACTUAL 3D scene
 * (src/viz/AerialCapture.tsx) — same geometry and world coordinates.
 * Overlay: the measured dose-rate field received at the ground station:
 *   MEASURED   smooth colour, fading inward at the edge of the measured region,
 *              exactly transparent over unmeasured cells (heatField.ts, tested);
 *   ESTIMATED  optional IDW layer, stippled and dashed-outlined, labelled ESTIMATE;
 *   UNKNOWN    no colour; optional faint hatch.
 * Live markers (drones from received heartbeats, casualty estimate, GS, CCP,
 * source reference, peak, hotspots) and routes are drawn on top in the same
 * frame of reference. Zoom (wheel / buttons), pan (drag), rotate (buttons),
 * click a marker or cell to inspect.
 */

export interface AerialMapProps {
  grid: HeatmapGrid;
  variant: 'panel' | 'full';
  height?: number;
  routes?: MapRoute[];
  candidates?: MapCandidate[];
  peak?: { x: number; z: number; v: number } | null;
  hotspots?: ReportedHotspot[];
  surveyArea?: { x0: number; z0: number; x1: number; z1: number } | null;
  /** Initial framing. */
  frame?: 'site' | 'facility' | 'evac';
  /** Phase 3B+: recommended rescue-team route (red), sections in walking order. */
  rescue?: { sections: RescueSection[]; start: { id: string; label: string; x: number; z: number }; status: RescueStatus; id: string | null } | null;
}

/** Rescue-route red (also used by the Evacuation tab legend). */
/** Recommended rescue route: thin (~2 screen px) green line — colour only; it is NOT a safety claim (status/warnings stay). */
export const RESCUE_COLOR = '#28C76F';

interface View {
  cx: number;
  cz: number;
  s: number; // px per metre
  rot: number; // radians, positive = map rotated clockwise on screen
}

const BEE_COLORS: Record<string, string> = { 'BEE-01': '#22d3ee', 'BEE-02': '#f472b6', 'BEE-03': '#a3e635' };
const CAND_COLOR: Record<string, string> = { SURVEYED: '#4ade80', PARTIAL: '#fbbf24', UNKNOWN: '#cbd5e1' };
const FRAMES = {
  site: { x0: -100, z0: -66, x1: 70, z1: 96 },
  facility: { x0: -60, z0: -58, x1: 66, z1: 80 },
  evac: { x0: -80, z0: -8, x1: 4, z1: 60 },
};

interface Hit {
  kind: 'bee' | 'mother' | 'casualty' | 'gs' | 'ccp' | 'source' | 'peak' | 'hotspot' | 'pad' | 'rescue';
  id: string;
  sx: number;
  sy: number;
}

function fieldCanvas(f: HeatField, lo: number, hi: number, alphaScale = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = f.w;
  c.height = f.h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(f.w, f.h);
  for (let i = 0; i < f.value.length; i++) {
    const a = f.alpha[i];
    if (a <= 0) continue;
    const [r, gg, b] = rampRGB(logNorm(f.value[i], lo, hi));
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = Math.round(255 * Math.min(1, a * alphaScale));
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function AerialMap({ grid, variant, height, routes = [], candidates = [], peak = null, hotspots = [], surveyArea = null, frame = 'facility', rescue = null }: AerialMapProps) {
  const v = useViewSettings();
  const aerial = useAerialImage();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: height ?? 360 });
  const view = useRef<View | null>(null);
  const [, force] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const [sel, setSel] = useState<{ kind: Hit['kind']; id: string } | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const hits = useRef<Hit[]>([]);
  const engine = simController.engine;
  const s = engine.state;
  const cfg = engine.config;
  const { lo, hi } = doseScale(cfg.radiation.background_uSv_h, grid.max);

  const fitTo = (f: keyof typeof FRAMES, w: number, h: number) => {
    const b = FRAMES[f];
    const sc = Math.min(w / (b.x1 - b.x0), h / (b.z1 - b.z0));
    view.current = { cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, s: sc, rot: view.current?.rot ?? 0 };
  };
  const measured = useRef(false);
  /** true once the operator panned / zoomed: from then on resizes keep their view */
  const userView = useRef(false);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((e) => {
      const r = e[0].contentRect;
      const w = Math.max(240, Math.floor(r.width));
      const h = variant === 'full' ? Math.max(240, Math.floor(r.height)) : (height ?? Math.round(r.width * 0.78));
      // frame the site on the first real measurement (not the placeholder size)
      // and re-frame on later resizes (sidebar toggle, window) until the operator moves the map
      if (!measured.current || !userView.current) {
        measured.current = true;
        fitTo(frame, w, h);
      }
      setSize({ w, h });
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, height]);

  const fit = (f: keyof typeof FRAMES = frame) => {
    userView.current = false;
    fitTo(f, size.w, size.h);
    force((n) => n + 1);
  };
  if (!view.current) fitTo(frame, size.w, size.h);

  // --- overlay rasters (rebuilt only when the grid / mode changes)
  const smoothMode = v.mapSmooth;
  const heat = useMemo(() => {
    if (typeof document === 'undefined' || !grid.filled) return null;
    // Smooth: 12 m (3×3-cell) live-time-weighted mean of MEASURED cells — no colour on unmeasured cells
    const f = buildHeatField(smoothMode ? smoothedGrid(grid) : grid, smoothMode ? 12 : 1);
    return fieldCanvas(f, lo, hi);
  }, [grid, smoothMode, lo, hi]);
  const estimate = useMemo(() => {
    if (typeof document === 'undefined' || !v.mapEstimate || !grid.filled) return null;
    const est = interpolateIdw(grid, 12, 2);
    if (!est.estimated) return null;
    const f = buildEstimateField(grid, est, smoothMode ? 8 : 1);
    return { canvas: fieldCanvas(f, lo, hi, 0.55), est };
  }, [grid, v.mapEstimate, smoothMode, lo, hi]);
  const contours = useMemo(() => {
    if (!v.mapContours || grid.filled < 4) return [] as { level: number; segs: number[][] }[];
    // iso-lines only from 5× background up: below that they would trace counting noise, not structure
    const floor = 5 * cfg.radiation.background_uSv_h;
    const levels = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((l) => l >= floor - 1e-9 && l > grid.min && l < grid.max);
    const cg = smoothMode ? smoothedGrid(grid) : grid; // iso-lines of the field that is shown
    return levels.map((level) => ({ level, segs: contourSegments(cg, level) }));
  }, [grid, v.mapContours, smoothMode]);

  const vw = view.current as View;
  const W = size.w;
  const H = size.h;
  const toScreen = (x: number, z: number): [number, number] => {
    const dx = (x - vw.cx) * vw.s;
    const dz = (z - vw.cz) * vw.s;
    const c = Math.cos(vw.rot);
    const sn = Math.sin(vw.rot);
    return [W / 2 + dx * c - dz * sn, H / 2 + dx * sn + dz * c];
  };
  const toWorld = (sx: number, sy: number): [number, number] => {
    const dx = sx - W / 2;
    const dy = sy - H / 2;
    const c = Math.cos(-vw.rot);
    const sn = Math.sin(-vw.rot);
    return [vw.cx + (dx * c - dy * sn) / vw.s, vw.cz + (dx * sn + dy * c) / vw.s];
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = aerial?.edge ?? '#d6bf96';
    g.fillRect(0, 0, W, H);

    // ---------- world space
    g.save();
    g.translate(W / 2, H / 2);
    g.rotate(vw.rot);
    g.scale(vw.s, vw.s);
    g.translate(-vw.cx, -vw.cz);
    if (aerial) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(aerial.canvas, aerial.x0, aerial.z0, aerial.x1 - aerial.x0, aerial.z1 - aerial.z0);
    } else {
      // fallback (no WebGL capture yet): plain site plan
      g.fillStyle = '#cdb68e';
      g.fillRect(-120, -120, 240, 240);
      for (const o of engine.world.obstacles) {
        g.fillStyle = '#9a9387';
        g.beginPath();
        if (o.shape === 'box') g.rect(o.cx - o.hx, o.cz - o.hz, o.hx * 2, o.hz * 2);
        else g.arc(o.cx, o.cz, o.radius, 0, Math.PI * 2);
        g.fill();
      }
    }
    // gentle grade for legibility of the overlay on bright sand
    g.fillStyle = 'rgba(20,24,28,0.07)';
    g.fillRect(-200, -200, 400, 400);

    const gx = grid.x0;
    const gz = grid.z0;
    const gw = grid.nx * grid.cell;
    const gh = grid.nz * grid.cell;

    // unknown ground (inside the survey grid): faint hatch
    if (v.mapUnknown && v.showHeatmap) {
      const p = document.createElement('canvas');
      p.width = p.height = 8;
      const pg = p.getContext('2d')!;
      pg.strokeStyle = 'rgba(15,23,42,0.22)';
      pg.lineWidth = 1;
      pg.beginPath();
      pg.moveTo(0, 8);
      pg.lineTo(8, 0);
      pg.stroke();
      const pat = g.createPattern(p, 'repeat');
      if (pat) {
        pat.setTransform(new DOMMatrix().scale(1 / vw.s, 1 / vw.s));
        const path = new Path2D();
        const area = surveyArea ?? { x0: gx, z0: gz, x1: gx + gw, z1: gz + gh };
        for (let iz = 0; iz < grid.nz; iz++)
          for (let ix = 0; ix < grid.nx; ix++) {
            const k = iz * grid.nx + ix;
            if (grid.counts[k] > 0 || (estimate && estimate.est.kind[k] === CELL_ESTIMATED)) continue;
            const x = gx + ix * grid.cell;
            const z = gz + iz * grid.cell;
            if (x + grid.cell <= area.x0 || x >= area.x1 || z + grid.cell <= area.z0 || z >= area.z1) continue;
            path.rect(x, z, grid.cell, grid.cell);
          }
        g.fillStyle = pat;
        g.fill(path);
      }
    }

    // estimate layer (stippled + dashed outline)
    if (estimate && v.showHeatmap) {
      g.save();
      g.globalAlpha = v.heatOpacity;
      g.imageSmoothingEnabled = smoothMode;
      g.drawImage(estimate.canvas, gx, gz, gw, gh);
      g.restore();
      const dots = document.createElement('canvas');
      dots.width = dots.height = 6;
      const dg = dots.getContext('2d')!;
      dg.fillStyle = 'rgba(15,23,42,0.55)';
      dg.fillRect(2, 2, 1.6, 1.6);
      const dp = g.createPattern(dots, 'repeat');
      const path = new Path2D();
      for (let k = 0; k < grid.values.length; k++) {
        if (estimate.est.kind[k] !== CELL_ESTIMATED) continue;
        path.rect(gx + (k % grid.nx) * grid.cell, gz + Math.floor(k / grid.nx) * grid.cell, grid.cell, grid.cell);
      }
      if (dp) {
        dp.setTransform(new DOMMatrix().scale(1 / vw.s, 1 / vw.s));
        g.fillStyle = dp;
        g.fill(path);
      }
    }

    // measured layer
    if (heat && v.showHeatmap) {
      g.save();
      g.globalAlpha = v.heatOpacity;
      g.imageSmoothingEnabled = smoothMode;
      g.imageSmoothingQuality = 'high';
      g.drawImage(heat, gx, gz, gw, gh);
      g.restore();
    }
    // contour lines (measured squares only)
    if (contours.length && v.showHeatmap) {
      g.save();
      g.lineWidth = 1.1 / vw.s;
      for (const c0 of contours) {
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.beginPath();
        for (const [x1, z1, x2, z2] of c0.segs) {
          g.moveTo(gx + (x1 + 0.5) * grid.cell, gz + (z1 + 0.5) * grid.cell);
          g.lineTo(gx + (x2 + 0.5) * grid.cell, gz + (z2 + 0.5) * grid.cell);
        }
        g.stroke();
      }
      g.restore();
    }

    // survey area
    if (surveyArea) {
      g.save();
      g.setLineDash([3 / vw.s, 2.5 / vw.s]);
      g.strokeStyle = 'rgba(34,211,238,0.9)';
      g.lineWidth = 1.4 / vw.s;
      g.strokeRect(surveyArea.x0, surveyArea.z0, surveyArea.x1 - surveyArea.x0, surveyArea.z1 - surveyArea.z0);
      g.restore();
    }

    // candidate corridors (thin) + selected route (glowing)
    const line = (pts: P2[]) => {
      const p = new Path2D();
      pts.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
      return p;
    };
    if (v.showEvacRoute) {
      for (const cnd of candidates) {
        if (cnd.selected || cnd.points.length < 2) continue;
        g.save();
        g.setLineDash(cnd.status === 'SURVEYED' ? [] : [4 / vw.s, 3 / vw.s]);
        g.strokeStyle = CAND_COLOR[cnd.status ?? 'UNKNOWN'];
        g.globalAlpha = 0.85;
        g.lineWidth = 1.6 / vw.s;
        g.stroke(line(cnd.points));
        g.restore();
      }
      for (const r of routes) {
        for (const run of r.runs) {
          if (run.points.length < 2) continue;
          const p = line(run.points);
          g.save();
          g.lineCap = 'round';
          g.lineJoin = 'round';
          if (r.ghost) {
            g.setLineDash([2 / vw.s, 3 / vw.s]);
            g.strokeStyle = 'rgba(241,245,249,0.7)';
            g.lineWidth = 1.2 / vw.s;
            g.stroke(p);
            g.restore();
            continue;
          }
          g.strokeStyle = 'rgba(255,255,255,0.28)';
          g.lineWidth = 9 / vw.s;
          g.stroke(p);
          g.setLineDash(run.known ? [] : [7 / vw.s, 5 / vw.s]);
          g.strokeStyle = run.known ? '#f8fafc' : 'rgba(248,250,252,0.85)';
          g.lineWidth = 3.2 / vw.s;
          g.stroke(p);
          if (run.known) {
            g.strokeStyle = '#22c55e';
            g.lineWidth = 1.3 / vw.s;
            g.stroke(p);
          }
          g.restore();
        }
      }
    }
    // Phase 3B+: recommended RESCUE route — thin green line (~2 screen px, round caps/joins, no halo/glow/fill);
    // estimated stretches dashed, unknown dotted with "?" (same coordinates and planning as before)
    if (rescue && v.showRescueRoute && rescue.sections.length) {
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.globalAlpha = 0.95;
      g.strokeStyle = RESCUE_COLOR;
      g.lineWidth = 2 / vw.s;
      for (const sc of rescue.sections) {
        if (sc.points.length < 2) continue;
        if (sc.kind === 'MEASURED') g.setLineDash([]);
        else if (sc.kind === 'ESTIMATED') g.setLineDash([6 / vw.s, 4 / vw.s]);
        else g.setLineDash([0.5 / vw.s, 4 / vw.s]);
        g.stroke(line(sc.points));
      }
      g.restore();
    }
    g.restore();

    // ---------- screen space markers
    const placed: [number, number, number, number][] = [];
    // reserve the rescue-team start icon so nearby labels (GS) move instead of hiding it
    if (rescue && v.showRescueRoute) {
      const [rx, ry] = toScreen(rescue.start.x, rescue.start.z);
      placed.push([rx - 9, ry - 8, 18, 16]);
    }
    const label = (x: number, y: number, text: string, color: string, force2 = false) => {
      g.font = '600 10px "Segoe UI", system-ui, sans-serif';
      const w = g.measureText(text).width + 8;
      const tries: [number, number][] = [
        [8, -18],
        [8, 6],
        [-w - 8, -18],
        [-w - 8, 6],
      ];
      for (const [ox, oy] of tries) {
        const r: [number, number, number, number] = [x + ox, y + oy, w, 14];
        if (r[0] < 2 || r[1] < 2 || r[0] + w > W - 2 || r[1] + 14 > H - 2) continue;
        if (!force2 && placed.some((p) => r[0] < p[0] + p[2] && r[0] + r[2] > p[0] && r[1] < p[1] + p[3] && r[1] + r[3] > p[1])) continue;
        placed.push(r);
        g.fillStyle = 'rgba(10,13,17,0.78)';
        g.beginPath();
        g.roundRect(r[0], r[1], w, 14, 3);
        g.fill();
        g.fillStyle = color;
        g.fillText(text, r[0] + 4, r[1] + 10.5);
        return;
      }
    };
    const out: Hit[] = [];
    const now = s.time;

    // building labels
    if (v.mapLabels) {
      const SHORT: Record<string, string> = { warehouse: 'WAREHOUSE A', 'control-building': 'CONTROL', stack: 'STACK', container: 'CONTAINER' };
      for (const o of engine.world.obstacles) {
        if (o.kind === 'debris') continue;
        const [x, y] = toScreen(o.cx, o.cz);
        g.font = '600 9px "Segoe UI", system-ui, sans-serif';
        const text = o.kind === 'tank' ? o.id.replace('OBS-TK-', 'TANK ') : (SHORT[o.kind] ?? o.label.toUpperCase());
        const w = g.measureText(text).width;
        if (x < 0 || y < 0 || x > W || y > H) continue;
        const r: [number, number, number, number] = [x - w / 2 - 2, y - 6, w + 4, 12];
        if (placed.some((p) => r[0] < p[0] + p[2] && r[0] + r[2] > p[0] && r[1] < p[1] + p[3] && r[1] + r[3] > p[1])) continue;
        g.fillStyle = 'rgba(255,255,255,0.88)';
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.lineWidth = 3;
        g.strokeText(text, x - w / 2, y + 3);
        g.fillText(text, x - w / 2, y + 3);
        placed.push([x - w / 2 - 2, y - 6, w + 4, 12]);
      }
    }

    // ground station + pad + CCP
    const gsP = engine.world.groundStation.position;
    {
      const [x, y] = toScreen(gsP.x, gsP.z);
      g.fillStyle = '#2563eb';
      g.strokeStyle = '#e2e8f0';
      g.lineWidth = 1.5;
      g.beginPath();
      g.roundRect(x - 7, y - 7, 14, 14, 3);
      g.fill();
      g.stroke();
      g.strokeStyle = '#e2e8f0';
      g.beginPath();
      g.moveTo(x, y + 3);
      g.lineTo(x, y - 4);
      g.arc(x, y - 4, 2.5, Math.PI, 0);
      g.stroke();
      label(x, y, 'GROUND STATION', '#93c5fd');
      out.push({ kind: 'gs', id: 'GS-1', sx: x, sy: y });
    }
    if (cfg.mission.lifecycle) {
      const [x, y] = toScreen(cfg.mission.pad.x, cfg.mission.pad.z);
      out.push({ kind: 'pad', id: 'PAD', sx: x, sy: y });
    }
    {
      const cp = cfg.evacuation.collectionPoint;
      const [x, y] = toScreen(cp.position.x, cp.position.z);
      g.fillStyle = '#16a34a';
      g.strokeStyle = '#f0fdf4';
      g.lineWidth = 1.5;
      g.beginPath();
      g.roundRect(x - 7, y - 7, 14, 14, 3);
      g.fill();
      g.stroke();
      g.fillStyle = '#f0fdf4';
      g.fillRect(x - 1.2, y - 4.5, 2.4, 9);
      g.fillRect(x - 4.5, y - 1.2, 9, 2.4);
      label(x, y, cp.id, '#86efac');
      out.push({ kind: 'ccp', id: cp.id, sx: x, sy: y });
    }
    // Phase 3B+: rescue-team start marker + "?" on unknown stretches of the rescue route
    if (rescue && v.showRescueRoute) {
      for (const sc of rescue.sections) {
        if (sc.kind !== 'UNKNOWN' || sc.length_m < 2) continue;
        const m = sc.points[Math.floor(sc.points.length / 2)];
        const [x, y] = toScreen(m.x, m.z);
        g.fillStyle = '#06200f';
        g.strokeStyle = RESCUE_COLOR;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, y, 6.5, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillStyle = '#bbf7d0';
        g.font = 'bold 9px ui-monospace, monospace';
        g.textAlign = 'center';
        g.fillText('?', x, y + 3);
        g.textAlign = 'start';
      }
      const [x, y] = toScreen(rescue.start.x, rescue.start.z);
      g.fillStyle = '#15803d';
      g.strokeStyle = RESCUE_COLOR;
      g.lineWidth = 1.5;
      g.beginPath();
      g.roundRect(x - 8, y - 7, 16, 14, 3);
      g.fill();
      g.stroke();
      g.fillStyle = '#fff';
      g.font = 'bold 8px ui-monospace, monospace';
      g.textAlign = 'center';
      g.fillText('RT', x, y + 3);
      g.textAlign = 'start';
      label(x, y, 'RESCUE TEAM START', '#86efac');
      out.push({ kind: 'rescue', id: rescue.start.id, sx: x, sy: y });
    }
    // radiation source reference
    if (v.mapSourceRef) {
      const sp = cfg.radiation.sourcePosition;
      const [x, y] = toScreen(sp.x, sp.z);
      g.save();
      g.setLineDash([3, 3]);
      g.strokeStyle = 'rgba(253,224,71,0.95)';
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.stroke();
      g.restore();
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        g.beginPath();
        g.moveTo(x, y);
        g.arc(x, y, 6, a - 0.5, a + 0.5);
        g.closePath();
        g.fillStyle = '#fde047';
        g.fill();
      }
      label(x, y + 4, 'SOURCE (scenario ref)', '#fde047');
      out.push({ kind: 'source', id: 'SRC', sx: x, sy: y });
    }
    // hotspots (reported by BEE-01)
    for (const h of hotspots) {
      const [x, y] = toScreen(h.x, h.z);
      g.save();
      g.strokeStyle = '#fb923c';
      g.lineWidth = 2;
      g.setLineDash(h.scan === 'SCANNED' ? [] : [3, 2]);
      g.beginPath();
      g.arc(x, y, 12, 0, Math.PI * 2);
      g.stroke();
      g.restore();
      out.push({ kind: 'hotspot', id: h.id, sx: x, sy: y });
    }
    // peak
    if (peak) {
      const [x, y] = toScreen(peak.x, peak.z);
      g.fillStyle = '#ef4444';
      g.strokeStyle = '#0b0e12';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x, y - 6);
      g.lineTo(x + 5.5, y + 4);
      g.lineTo(x - 5.5, y + 4);
      g.closePath();
      g.fill();
      g.stroke();
      label(x, y, `PEAK ${peak.v.toFixed(2)} µSv/h`, '#fca5a5');
      out.push({ kind: 'peak', id: 'PEAK', sx: x, sy: y });
    }
    // casualty estimate ± 1σ (GS record)
    for (const p of s.comms.gs.patients) {
      if (!p.location) continue;
      const [x, y] = toScreen(p.location.x, p.location.z);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      g.beginPath();
      g.arc(x, y, 10 + 6 * pulse, 0, Math.PI * 2);
      g.strokeStyle = `rgba(239,68,68,${0.35 + 0.3 * (1 - pulse)})`;
      g.lineWidth = 2;
      g.stroke();
      g.beginPath();
      g.arc(x, y, Math.max(4, p.location.sigma_m * vw.s), 0, Math.PI * 2);
      g.strokeStyle = 'rgba(251,146,60,0.9)';
      g.lineWidth = 1.2;
      g.stroke();
      g.beginPath();
      g.moveTo(x, y);
      g.bezierCurveTo(x - 8, y - 10, x - 6, y - 18, x, y - 18);
      g.bezierCurveTo(x + 6, y - 18, x + 8, y - 10, x, y);
      g.fillStyle = '#ef4444';
      g.fill();
      g.beginPath();
      g.arc(x, y - 12, 2.6, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      label(x, y - 16, p.patientId, '#fca5a5', true);
      out.push({ kind: 'casualty', id: p.patientId, sx: x, sy: y - 9 });
    }
    // mother (simulator position)
    {
      const m = s.mother;
      const [x, y] = toScreen(m.position.x, m.position.z);
      g.save();
      g.translate(x, y);
      g.rotate(vw.rot - m.yaw + Math.PI);
      g.fillStyle = '#111827';
      g.strokeStyle = '#e5e7eb';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(0, -9);
      g.lineTo(7, 7);
      g.lineTo(0, 3);
      g.lineTo(-7, 7);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
      label(x, y, 'MOTHER-01', '#e5e7eb');
      out.push({ kind: 'mother', id: 'MOTHER-01', sx: x, sy: y });
    }
    // bees: last position RECEIVED at the GS
    for (const b of s.bees) {
      const hb = s.comms.gs.beeReports[b.id];
      if (!hb || b.mode === 'DOCKED') continue;
      const [x, y] = toScreen(hb.x, hb.z);
      const stale = now - hb.sampleTime > cfg.alerts.droneOffline_s;
      const col = stale ? '#64748b' : BEE_COLORS[b.id];
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fillStyle = 'rgba(10,13,17,0.55)';
      g.fill();
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fillStyle = col;
      g.fill();
      g.strokeStyle = '#0b0e12';
      g.lineWidth = 1.5;
      g.stroke();
      label(x, y, stale ? `${b.id} · ${(now - hb.sampleTime).toFixed(0)}s` : b.id, col);
      out.push({ kind: 'bee', id: b.id, sx: x, sy: y });
    }
    hits.current = out;

    // north arrow (rotates with the map) + scale bar
    {
      const x = W - 22;
      const y = 26;
      g.save();
      g.translate(x, y);
      g.rotate(vw.rot);
      g.fillStyle = 'rgba(10,13,17,0.6)';
      g.beginPath();
      g.arc(0, 0, 13, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#f8fafc';
      g.beginPath();
      g.moveTo(0, -10);
      g.lineTo(4.5, 3);
      g.lineTo(0, 0.5);
      g.lineTo(-4.5, 3);
      g.closePath();
      g.fill();
      g.font = '700 8px system-ui';
      g.fillText('N', -2.6, 10.5);
      g.restore();
      const target = 60 / vw.s;
      const nice = [5, 10, 20, 25, 50, 100].find((n) => n >= target * 0.6) ?? 100;
      const len = nice * vw.s;
      const bx = variant === 'full' ? W - len - 62 : 8;
      g.fillStyle = 'rgba(10,13,17,0.6)';
      g.fillRect(bx, H - 26, len + 40, 18);
      g.strokeStyle = '#f8fafc';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(bx + 6, H - 12);
      g.lineTo(bx + 6 + len, H - 12);
      g.moveTo(bx + 6, H - 16);
      g.lineTo(bx + 6, H - 8);
      g.moveTo(bx + 6 + len, H - 16);
      g.lineTo(bx + 6 + len, H - 8);
      g.stroke();
      g.fillStyle = '#f8fafc';
      g.font = '600 9px system-ui';
      g.fillText(`${nice} m`, bx + 10 + len, H - 9);
    }
  });

  // ---------- interaction
  const hitAt = (x: number, y: number) => {
    let best: Hit | null = null;
    let bd = 13;
    for (const h of hits.current) {
      const d = Math.hypot(h.sx - x, h.sy - y);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  };
  const cellInfo = (wx: number, wz: number): string[] | null => {
    const ix = Math.floor((wx - grid.x0) / grid.cell);
    const iz = Math.floor((wz - grid.z0) / grid.cell);
    if (ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz) return null;
    const k = iz * grid.nx + ix;
    const head = `x ${(grid.x0 + ix * grid.cell).toFixed(0)}…${(grid.x0 + (ix + 1) * grid.cell).toFixed(0)} · z ${(grid.z0 + iz * grid.cell).toFixed(0)}…${(grid.z0 + (iz + 1) * grid.cell).toFixed(0)} m`;
    if (grid.counts[k] > 0)
      return [head, `MEASURED ${grid.values[k].toFixed(3)} µSv/h`, `${grid.counts[k]} sample${grid.counts[k] > 1 ? 's' : ''} · last t = ${grid.lastTime[k].toFixed(1)} s · ≈ ${grid.meanAlt[k].toFixed(0)} m alt`];
    if (estimate && estimate.est.kind[k] === CELL_ESTIMATED) return [head, `ESTIMATE ${estimate.est.values[k].toFixed(3)} µSv/h`, 'IDW interpolation — not a measurement'];
    return [head, 'UNKNOWN — no measurement'];
  };
  const onDown = (e: RPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onMove = (e: RPointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    if (drag.current && (e.buttons & 1)) {
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      const c = Math.cos(-vw.rot);
      const sn = Math.sin(-vw.rot);
      vw.cx -= (dx * c - dy * sn) / vw.s;
      vw.cz -= (dx * sn + dy * c) / vw.s;
      userView.current = true;
      setTip(null);
      force((n) => n + 1);
      return;
    }
    const h = hitAt(mx, my);
    if (h) {
      setTip({ x: mx, y: my, lines: [hitTitle(h.kind, h.id)] });
      return;
    }
    const [wx, wz] = toWorld(mx, my);
    const info = cellInfo(wx, wz);
    setTip(info ? { x: mx, y: my, lines: info } : null);
  };
  const onUp = (e: RPointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const moved = drag.current?.moved;
    drag.current = null;
    if (moved) return;
    const h = hitAt(e.clientX - r.left, e.clientY - r.top);
    setSel(h ? { kind: h.kind, id: h.id } : null);
  };
  const zoomAt = (factor: number, sx = W / 2, sy = H / 2) => {
    const [wx, wz] = toWorld(sx, sy);
    vw.s = Math.min(40, Math.max(0.6, vw.s * factor));
    const [nx, nz] = toWorld(sx, sy);
    vw.cx += wx - nx;
    vw.cz += wz - nz;
    userView.current = true;
    force((n) => n + 1);
  };
  const onWheel = (e: RWheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left, e.clientY - r.top);
  };
  useEffect(() => {
    // stop the page from scrolling while zooming the map
    const c = canvas.current;
    if (!c) return;
    const h = (e: WheelEvent) => e.preventDefault();
    c.addEventListener('wheel', h, { passive: false });
    return () => c.removeEventListener('wheel', h);
  }, []);
  const rotate = (d: number) => {
    vw.rot = d === 0 ? 0 : vw.rot + d;
    force((n) => n + 1);
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => logValue(t, lo, hi));
  const selected = sel ? inspect(sel.kind, sel.id) : null;

  return (
    <div className={`amap amap-${variant}`} ref={wrap} style={variant === 'panel' ? { height: size.h } : undefined}>
      <canvas
        ref={canvas}
        style={{ width: W, height: H }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => setTip(null)}
        onWheel={onWheel}
        role="img"
        aria-label="Aerial radiation map of the simulated site"
      />
      {tip && !drag.current && (
        <div className="map-tip" style={{ left: Math.min(W - 200, tip.x + 14), top: Math.max(0, tip.y - 10) }}>
          {tip.lines.map((t, i) => (
            <div key={i} className={i === 1 ? 'strong' : ''}>
              {t}
            </div>
          ))}
        </div>
      )}
      {selected && (
        <div className="amap-pop" role="dialog" aria-label={selected.title}>
          <header>
            <b>{selected.title}</b>
            <button onClick={() => setSel(null)} aria-label="Close">
              ×
            </button>
          </header>
          <dl>
            {selected.rows.map(([k, val]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{val}</dd>
              </div>
            ))}
          </dl>
          {selected.note && <p>{selected.note}</p>}
        </div>
      )}
      <div className="amap-tools" role="group" aria-label="Map controls">
        <button onClick={() => zoomAt(1.35)} title="Zoom in">
          +
        </button>
        <button onClick={() => zoomAt(1 / 1.35)} title="Zoom out">
          −
        </button>
        <button onClick={() => rotate(-Math.PI / 12)} title="Rotate left 15°">
          ⟲
        </button>
        <button onClick={() => rotate(Math.PI / 12)} title="Rotate right 15°">
          ⟳
        </button>
        <button
          onClick={() => {
            rotate(0);
            fit();
          }}
          title="Reset view (north up, fit)"
        >
          ⌖
        </button>
        <button className={layersOpen ? 'on' : ''} onClick={() => setLayersOpen((o) => !o)} title="Layers & opacity">
          ☰
        </button>
      </div>
      {layersOpen && (
        <div className="amap-layers">
          <label className="amap-range">
            Heat opacity <b>{Math.round(v.heatOpacity * 100)}%</b>
            <input type="range" min={0} max={100} value={Math.round(v.heatOpacity * 100)} onChange={(e) => viewSettings.set({ heatOpacity: Number(e.target.value) / 100 })} />
          </label>
          {(
            [
              ['showHeatmap', 'Radiation (measured)'],
              ['mapEstimate', 'Estimate layer (IDW)'],
              ['mapContours', 'Contour lines'],
              ['mapUnknown', 'Mark unmeasured ground'],
              ['mapSmooth', 'Smooth (off = raw cells)'],
              ['mapLabels', 'Building labels'],
              ['mapSourceRef', 'Radiation source (ref)'],
              ['showEvacRoute', 'Evacuation routes (to CCP)'],
              ['showRescueRoute', 'Rescue route (green)'],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={v[k] as boolean} onChange={(e) => viewSettings.set({ [k]: e.target.checked })} />
              {l}
            </label>
          ))}
        </div>
      )}
      <div className="amap-legend">
        <div className="al-bar" style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => rampCss(t)).join(', ')})` }} />
        <div className="al-ticks">
          {ticks.map((t, i) => (
            <span key={i}>{t < 1 ? t.toFixed(2) : t.toFixed(1)}</span>
          ))}
        </div>
        <div className="al-keys">
          <span>µSv/h · measured</span>
          {v.mapEstimate && (
            <span>
              <i className="k-est" />
              estimate
            </span>
          )}
          <span>
            <i className="k-unk" />
            unknown
          </span>
        </div>
        {rescue && v.showRescueRoute && rescue.sections.length > 0 && (
          <div className="al-rescue">
            <i aria-hidden />
            <span>Recommended Rescue Route — Radiation-Minimized</span>
            <em className={rescue.status === 'VERIFIED' ? 'ok' : 'warn'}>{rescue.status === 'VERIFIED' ? 'verified' : 'UNVERIFIED'}</em>
          </div>
        )}
      </div>
      {!aerial && <div className="amap-wait">Aerial image is captured from the 3D view…</div>}
      {variant === 'full' && <div className="amap-badge">AERIAL VIEW · {PHASE_LABEL[s.mission.phase].toUpperCase()} · T+{s.time.toFixed(0)} s · SIMULATED</div>}
    </div>
  );
}

function hitTitle(kind: Hit['kind'], id: string): string {
  const t: Record<Hit['kind'], string> = {
    bee: `${id} — click for details`,
    mother: 'MOTHER-01 — click for details',
    casualty: `Casualty ${id} — click for details`,
    gs: 'Ground station GS-1',
    ccp: 'Casualty collection point',
    source: 'Radiation source (scenario reference — not a detection)',
    peak: 'Peak measured reading',
    hotspot: `Hotspot ${id} (reported by BEE-01)`,
    pad: 'Launch / landing pad',
    rescue: 'Rescue team start — click for the route',
  };
  return t[kind];
}

/** Details for a clicked marker — GS-received data unless stated. */
function inspect(kind: Hit['kind'], id: string): { title: string; rows: [string, string][]; note?: string } {
  const e = simController.engine;
  const s = e.state;
  const age = (t: number | null | undefined) => (t === null || t === undefined ? '—' : `${Math.max(0, s.time - t).toFixed(1)} s ago`);
  if (kind === 'bee') {
    const hb = s.comms.gs.beeReports[id];
    const role: Record<string, string> = { 'BEE-01': 'Radiation survey', 'BEE-02': 'Casualty assessment', 'BEE-03': 'Comms relay' };
    return {
      title: id,
      rows: [
        ['Role', role[id] ?? '—'],
        ['Reported mode', hb ? String(hb.mode) : '—'],
        ['Position (reported)', hb ? `x ${hb.x.toFixed(1)}, z ${hb.z.toFixed(1)}, alt ${hb.y.toFixed(1)} m` : '—'],
        ['Last packet', age(s.comms.gs.lastRxTime[id])],
        ['Link route', s.comms.lastRoute[id]],
        ...(id === 'BEE-01' && hb ? ([['Survey phase', String(hb.fields.phase ?? '—').replace('_', ' ')]] as [string, string][]) : []),
      ],
      note: 'Last heartbeat received at the ground station.',
    };
  }
  if (kind === 'mother') {
    const m = s.mother;
    return {
      title: 'MOTHER-01',
      rows: [
        ['Mission phase', PHASE_LABEL[s.mission.phase]],
        ['Mode', m.mode],
        ['Altitude', `${m.position.y.toFixed(1)} m`],
        ['Bees docked', `${s.bees.filter((b) => b.mode === 'DOCKED').length}/3`],
        ['Status', m.missionStatus],
      ],
      note: 'Simulator state (the mother’s command link is not part of the comms model).',
    };
  }
  if (kind === 'casualty') {
    const p = patientViews(s, e.config).find((x) => x.record.patientId === id);
    const r = p?.record;
    return {
      title: `Casualty ${id}`,
      rows: [
        ['Data state', p?.dataState ?? '—'],
        ['Heart rate', r?.latestVitals ? `${r.latestVitals.hr.toFixed(0)} bpm` : 'N/A'],
        ['Respiratory rate', r?.latestVitals ? `${r.latestVitals.rr.toFixed(0)} /min` : 'N/A'],
        ['Risk (illustrative)', r?.assessment?.risk ?? 'N/A'],
        ['Location estimate', r?.location ? `x ${r.location.x.toFixed(1)}, z ${r.location.z.toFixed(1)} ± ${r.location.sigma_m.toFixed(2)} m` : '—'],
        ['Last update', age(r?.lastRxTime)],
      ],
      note: 'Illustrative thresholds — not a clinical assessment.',
    };
  }
  if (kind === 'gs') {
    return { title: 'Ground station GS-1', rows: [['Packets received', String(s.comms.gs.delivered)], ['Radiation samples', String(s.comms.gs.radiationSamples.length)], ['Antenna height', `${e.config.comms.gsAntennaHeight_m} m`]] };
  }
  if (kind === 'pad') return { title: 'Launch / landing pad', rows: [['Position', `x ${e.config.mission.pad.x}, z ${e.config.mission.pad.z}`], ['Landing tolerance', `${e.config.mission.landingTolerance_m} m`], ['Phase', PHASE_LABEL[s.mission.phase]]] };
  if (kind === 'rescue') {
    const p = s.rescue.current;
    const rec = p?.candidates.find((c) => c.id === p.recommendedId) ?? null;
    return {
      title: 'Recommended Rescue Route — Radiation-Minimized',
      rows: rec
        ? [
            ['Status', p!.status === 'VERIFIED' ? 'VERIFIED (enough measured data)' : 'UNVERIFIED — see warnings'],
            ['Route', `${rec.id} · ${rec.label}`],
            ['Distance', `${rec.evaluation.length_m.toFixed(0)} m · ${(rec.evaluation.walkTime_s / 60).toFixed(1)} min walk`],
            ['Dose', rec.evaluation.doseTotal_uSv !== null ? `${rec.evaluation.doseTotal_uSv.toExponential(2)} µSv ± ${(rec.evaluation.doseTotalSigma_uSv ?? 0).toExponential(1)}` : `≥ ${rec.evaluation.doseMeasured_uSv.toExponential(2)} µSv (lower bound)`],
            ['Measured', `${Math.round(rec.evaluation.coverage * 100)}% of the route`],
            ['Start', `${p!.start.label} (x ${p!.start.x}, z ${p!.start.z})`],
          ]
        : [['Status', p ? p.status : 'not planned yet']],
      note: 'Planning only — the red line is the rescue team’s recommended path, not a drone flight path or proof of safety.',
    };
  }
  if (kind === 'ccp') return { title: e.config.evacuation.collectionPoint.id, rows: [['Purpose', e.config.evacuation.collectionPoint.label]], note: 'Evacuation is planning only — operator-controlled.' };
  if (kind === 'source') {
    const sp = e.config.radiation.sourcePosition;
    return { title: 'Radiation source (reference)', rows: [['Configured position', `x ${sp.x}, z ${sp.z}`], ['Strength', `${e.config.radiation.sourceStrength_uSv_h_at_1m} µSv/h @ 1 m`]], note: 'Scenario configuration shown for reference — not something the drones detected.' };
  }
  if (kind === 'hotspot') {
    const h = (s.comms.gs.beeReports['BEE-01']?.fields.hotspots as string | undefined) ?? '';
    return { title: `Hotspot ${id}`, rows: [['Reported', h.split(',').find((x) => x.startsWith(id))?.replace('@', ' @ ') ?? '—']], note: 'Declared on board by BEE-01 after 2 consecutive readings ≥ trigger.' };
  }
  return { title: 'Peak reading', rows: [['Source', 'highest received measurement']] };
}
