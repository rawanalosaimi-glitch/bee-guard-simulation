import type { ReactNode } from 'react';

export const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
export const age = (now: number, t: number | null | undefined) => (t === null || t === undefined ? '—' : `${Math.max(0, now - t).toFixed(1)} s ago`);

export const SimChip = () => <span className="sim-chip">SIMULATED</span>;

export function Card({ title, right, children, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <header>
        <b>{title}</b>
        {right ?? <SimChip />}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, unit, sub, tone }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <label>{label}</label>
      <b>
        {value}
        {unit && <small> {unit}</small>}
      </b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

const SEV_ICON = { critical: '▲', warning: '●', info: 'ℹ' } as const;
export function SevBadge({ sev }: { sev: 'critical' | 'warning' | 'info' }) {
  return (
    <span className={`sev sev-${sev}`}>
      {SEV_ICON[sev]} {sev.toUpperCase()}
    </span>
  );
}
