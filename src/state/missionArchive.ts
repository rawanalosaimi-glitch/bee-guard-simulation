import { useSyncExternalStore } from 'react';
import { patientViews } from '../sim';
import type { SimEngine } from '../sim';

/**
 * Phase 3B+: records of previous missions (casualty assessments as held at the GS), kept when the
 * operator resets / starts a new mission so they stay accessible. Held in memory for the session and,
 * where the browser allows it, in localStorage (best effort — the page works without it).
 * Contents are SIMULATED data from the run that produced them.
 */
export interface ArchivedPatient {
  patientId: string;
  reportedBy: string;
  detectedAt: number | null;
  assessedAt: number | null;
  hr: number | null;
  rr: number | null;
  score: number | null;
  risk: string | null;
  lastHr: number | null;
  lastRr: number | null;
  lastSampleTime: number | null;
  /** §40: last skin temperature (non-contact IR), °C, and its sample time — absent in older archives. */
  tempC?: number | null;
  tempSampleTime?: number | null;
  location: { x: number; z: number; sigma_m: number } | null;
  evacStage: string | null;
}

export interface ArchivedMission {
  runId: string;
  seed: number;
  /** Sim time when the record was archived (the run's last time), s. */
  endTime: number;
  phase: string;
  status: string;
  /** Wall-clock time of archiving (ISO). */
  archivedAt: string;
  rescueStatus: string | null;
  patients: ArchivedPatient[];
}

const KEY = 'beeguard.missionArchive.v1';
const MAX = 20;
let list: ArchivedMission[] = load();
const listeners = new Set<() => void>();

function load(): ArchivedMission[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const v = raw ? (JSON.parse(raw) as ArchivedMission[]) : [];
    return Array.isArray(v) ? v.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — records stay in memory for this session */
  }
}

/** Snapshot of an engine's casualty records (nothing if no casualty was reported). */
export function snapshotMission(e: SimEngine): ArchivedMission | null {
  const s = e.state;
  const views = patientViews(s, e.config);
  if (!views.length || s.time <= 0) return null;
  return {
    runId: e.runId,
    seed: e.config.seed,
    endTime: s.time,
    phase: s.mission.phase,
    status: s.status,
    archivedAt: new Date().toISOString(),
    rescueStatus: s.rescue.current?.status ?? null,
    patients: views.map((p) => {
      const r = p.record;
      const a = r.assessment;
      return {
        patientId: r.patientId,
        reportedBy: r.reportedBy,
        detectedAt: r.detectedAt,
        assessedAt: a?.assessedAt ?? null,
        hr: a?.hr ?? null,
        rr: a?.rr ?? null,
        score: a?.total ?? null,
        risk: a?.risk ?? null,
        lastHr: r.latestVitals?.hr ?? null,
        lastRr: r.latestVitals?.rr ?? null,
        lastSampleTime: r.latestVitals?.sampleTime ?? null,
        tempC: p.temperature.skin_c,
        tempSampleTime: p.temperature.sampleTime,
        location: r.location ? { x: r.location.x, z: r.location.z, sigma_m: r.location.sigma_m } : null,
        evacStage: p.evacStage,
      };
    }),
  };
}

export const missionArchive = {
  get: (): ArchivedMission[] => list,
  /** Archive the engine's mission (called before Reset / a new scenario). */
  add(e: SimEngine): void {
    const m = snapshotMission(e);
    if (!m) return;
    list = [m, ...list].slice(0, MAX);
    persist();
    listeners.forEach((f) => f());
  },
  clear(): void {
    list = [];
    persist();
    listeners.forEach((f) => f());
  },
  subscribe(f: () => void): () => void {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};

export function useMissionArchive(): ArchivedMission[] {
  return useSyncExternalStore(missionArchive.subscribe, missionArchive.get, missionArchive.get);
}
