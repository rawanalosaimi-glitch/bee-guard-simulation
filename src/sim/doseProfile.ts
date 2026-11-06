import type { CorridorStatus } from './corridor';
import type { HeatmapGrid } from './heatmap';
import type { P2 } from './routePlanner';

/**
 * Phase 3B+ — cumulative dose PROFILE along a walking route (pure; unit-tested).
 *
 * Same rules as the Phase 3A corridor evaluation (corridor.ts `evaluateCorridor`), so the end value of
 * the profile equals the route dose shown in the Evacuation tab:
 *   - the route is walked in 0.25 m pieces at the documented walking speed v (t = s / v);
 *   - each piece takes the dose rate Ḣ of the heat-map cell under its midpoint (GS-received cell mean);
 *   - D(t) = Σ Ḣ_i · Δt_i / 3600            [µSv, Ḣ in µSv/h, Δt in s] — i.e. ∫ Ḣ dt;
 *   - piece kinds:
 *       MEASURED  — the cell has ≥ 1 received measurement;
 *       GAP_FILL  — unmeasured piece on a SURVEYED route: the evaluation assumes the higher adjacent
 *                   measured rate for these short gaps (σ = 100 % of their contribution);
 *       UNKNOWN   — unmeasured piece on a route that is not SURVEYED: NOT counted (the dose there is
 *                   unknown, never assumed zero), so the curve is a LOWER BOUND from there on.
 * Rates are measured at drone altitude (8–15 m); ground-level exposure is model-based (no correction).
 */
export type DosePieceKind = 'MEASURED' | 'GAP_FILL' | 'UNKNOWN';

export interface DoseProfilePoint {
  /** Walking time from the route start, s. */
  t_s: number;
  /** Cumulative estimated dose at t, µSv. */
  dose_uSv: number;
  /** Kind of the stretch ENDING at this point. */
  kind: DosePieceKind;
  /** Dose rate used on that stretch, µSv/h (null = unknown). */
  rate_uSv_h: number | null;
}

export interface DoseProfile {
  points: DoseProfilePoint[];
  duration_s: number;
  total_uSv: number;
  /** True when some stretch is UNKNOWN (total is then a lower bound). */
  lowerBound: boolean;
  measured_s: number;
  gapFill_s: number;
  unknown_s: number;
}

/** µSv → mSv (1 mSv = 1000 µSv). */
export const uSvToMSv = (uSv: number): number => uSv / 1000;
/** Dose (µSv) from a constant rate (µSv/h) over a time (s). */
export const doseFromRate = (rate_uSv_h: number, dt_s: number): number => (rate_uSv_h * dt_s) / 3600;

const PIECE = 0.25;

/**
 * Integrate the dose along `pts`. `status` is the corridor evaluation status of the same route (only a
 * SURVEYED route fills its short gaps). Output is thinned to ≤ ~1 point per `every_s` seconds plus every
 * change of kind, always keeping the first and last point.
 */
export function doseProfile(pts: readonly P2[], grid: Pick<HeatmapGrid, 'x0' | 'z0' | 'cell' | 'nx' | 'nz' | 'values' | 'counts'>, walkingSpeed_mps: number, status: CorridorStatus, every_s = 1): DoseProfile {
  const v = walkingSpeed_mps;
  const cellOf = (x: number, z: number) => {
    const ix = Math.floor((x - grid.x0) / grid.cell);
    const iz = Math.floor((z - grid.z0) / grid.cell);
    return ix < 0 || iz < 0 || ix >= grid.nx || iz >= grid.nz ? -1 : iz * grid.nx + ix;
  };
  // 1) pieces with their measured rate (null = unmeasured)
  const pieces: { dt: number; rate: number | null }[] = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / PIECE));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const c = cellOf(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      const known = c >= 0 && grid.counts[c] > 0;
      pieces.push({ dt: L / n / v, rate: known ? grid.values[c] : null });
    }
  }
  // 2) gap fill (SURVEYED only): higher of the adjacent measured rates, or the route max if none
  const fill: (number | null)[] = pieces.map(() => null);
  if (status === 'SURVEYED') {
    let maxRate = 0;
    for (const p of pieces) if (p.rate !== null) maxRate = Math.max(maxRate, p.rate);
    for (let i = 0; i < pieces.length; ) {
      if (pieces[i].rate !== null) {
        i++;
        continue;
      }
      let j = i;
      while (j < pieces.length && pieces[j].rate === null) j++;
      const before = i > 0 ? pieces[i - 1].rate : null;
      const after = j < pieces.length ? pieces[j].rate : null;
      const rr = before === null && after === null ? maxRate : Math.max(before ?? 0, after ?? 0);
      for (let k = i; k < j; k++) fill[k] = rr;
      i = j;
    }
  }
  // 3) integrate and thin
  const points: DoseProfilePoint[] = [{ t_s: 0, dose_uSv: 0, kind: pieces[0]?.rate !== null ? 'MEASURED' : status === 'SURVEYED' ? 'GAP_FILL' : 'UNKNOWN', rate_uSv_h: pieces[0]?.rate ?? fill[0] ?? null }];
  let t = 0;
  let d = 0;
  let measured = 0;
  let gap = 0;
  let unknown = 0;
  let lastKept = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const kind: DosePieceKind = p.rate !== null ? 'MEASURED' : fill[i] !== null ? 'GAP_FILL' : 'UNKNOWN';
    const rate = p.rate ?? fill[i];
    t += p.dt;
    if (rate !== null) d += doseFromRate(rate, p.dt);
    if (kind === 'MEASURED') measured += p.dt;
    else if (kind === 'GAP_FILL') gap += p.dt;
    else unknown += p.dt;
    const nextKind = i + 1 < pieces.length ? (pieces[i + 1].rate !== null ? 'MEASURED' : fill[i + 1] !== null ? 'GAP_FILL' : 'UNKNOWN') : null;
    if (nextKind !== kind || t - lastKept >= every_s - 1e-9 || i === pieces.length - 1) {
      points.push({ t_s: t, dose_uSv: d, kind, rate_uSv_h: rate });
      lastKept = t;
    }
  }
  return { points, duration_s: t, total_uSv: d, lowerBound: unknown > 1e-9, measured_s: measured, gapFill_s: gap, unknown_s: unknown };
}

/** Cumulative dose at time t (linear between profile points; held at the total after the end), µSv. */
export function doseAt(p: DoseProfile, t_s: number): number {
  const pts = p.points;
  if (!pts.length || t_s <= 0) return 0;
  if (t_s >= p.duration_s) return p.total_uSv;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t_s <= t_s) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const f = b.t_s > a.t_s ? (t_s - a.t_s) / (b.t_s - a.t_s) : 1;
  return a.dose_uSv + (b.dose_uSv - a.dose_uSv) * f;
}

export type ComparisonRole = 'RECOMMENDED' | 'ALTERNATIVE' | 'HIGHEST';

export interface ComparisonRoute {
  role: ComparisonRole;
  candidateId: string;
  label: string;
  profile: DoseProfile;
  /** Route dose (µSv): the evaluation's total when SURVEYED, else the measured-stretch lower bound. */
  dose_uSv: number;
  sigma_uSv: number;
  verified: boolean;
  measuredFraction: number;
}

/**
 * Choose up to three routes for the comparison chart from a rescue plan: GREEN = the recommended route,
 * then the other candidates by estimated dose: RED = the highest, ORANGE = the next (intermediate).
 * Fewer than three distinct candidates → fewer routes (never invented).
 */
export function comparisonRoutes<C extends { id: string; label: string; verified: boolean; evaluation: { doseTotal_uSv: number | null; doseMeasured_uSv: number; doseTotalSigma_uSv: number | null; doseMeasuredSigma_uSv: number; coverage: number }; profile?: DoseProfile }>(
  candidates: readonly C[],
  recommendedId: string | null,
): ComparisonRoute[] {
  const withProfile = candidates.filter((c) => !!c.profile && c.profile.points.length > 1);
  const rec = withProfile.find((c) => c.id === recommendedId) ?? null;
  const doseOf = (c: C) => c.evaluation.doseTotal_uSv ?? c.evaluation.doseMeasured_uSv;
  const others = withProfile.filter((c) => c !== rec).sort((a, b) => doseOf(b) - doseOf(a) || a.id.localeCompare(b.id));
  const mk = (c: C, role: ComparisonRole): ComparisonRoute => ({
    role,
    candidateId: c.id,
    label: c.label,
    profile: c.profile!,
    dose_uSv: doseOf(c),
    sigma_uSv: c.evaluation.doseTotalSigma_uSv ?? c.evaluation.doseMeasuredSigma_uSv,
    verified: c.verified,
    measuredFraction: c.evaluation.coverage,
  });
  const out: ComparisonRoute[] = [];
  if (others[0]) out.push(mk(others[0], 'HIGHEST'));
  if (others[1]) out.push(mk(others[1], 'ALTERNATIVE'));
  if (rec) out.push(mk(rec, 'RECOMMENDED'));
  return out;
}
