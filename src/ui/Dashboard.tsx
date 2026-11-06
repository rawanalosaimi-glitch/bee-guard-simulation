import { simController } from '../state/simController';
import { useSimTick } from '../state/hooks';
import { useViewSettings, viewSettings } from '../state/viewSettings';
import type { SidebarTab } from '../state/viewSettings';
import { missionAlerts, patientViews, swarmStatus } from '../sim';
import { MissionPanel } from './panels/MissionPanel';
import { RadiationPanel } from './panels/RadiationPanel';
import { PatientsPanel } from './panels/PatientsPanel';
import { SwarmPanel } from './panels/SwarmPanel';
import { EvacPanel } from './panels/EvacPanel';
import { LogPanel } from './panels/LogPanel';

/**
 * Mission Control sidebar. It sits BESIDE the 3D view (the viewport shrinks),
 * so telemetry never covers the scene. Only the active tab is rendered, which
 * keeps the update cost low on integrated graphics.
 */
const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'mission', label: 'Mission' },
  { id: 'radiation', label: 'Radiation' },
  { id: 'patients', label: 'Patients' },
  { id: 'swarm', label: 'Swarm' },
  { id: 'evac', label: 'Evacuation' },
  { id: 'log', label: 'Log' },
];

export function Dashboard() {
  useSimTick(4);
  const { sidebarTab } = useViewSettings();
  const e = simController.engine;
  const s = e.state;
  const alerts = missionAlerts(s, e.config);
  const badge: Partial<Record<SidebarTab, { n: number; cls: string }>> = {};
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  if (alerts.length) badge.mission = { n: alerts.length, cls: crit ? 'crit' : 'warn' };
  const pv = patientViews(s, e.config);
  if (pv.length) badge.patients = { n: pv.length, cls: pv.some((p) => p.record.assessment?.risk === 'HIGH') ? 'crit' : 'info' };
  const off = swarmStatus(s, e.config, e.world).filter((x) => x.state === 'OFFLINE').length;
  if (off) badge.swarm = { n: off, cls: 'crit' };

  return (
    <aside className="sidebar" aria-label="Mission Control dashboard">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={sidebarTab === t.id} className={sidebarTab === t.id ? 'on' : ''} onClick={() => viewSettings.set({ sidebarTab: t.id })}>
            {t.label}
            {badge[t.id] && <span className={`tab-badge ${badge[t.id]!.cls}`}>{badge[t.id]!.n}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-body" role="tabpanel">
        {sidebarTab === 'mission' && <MissionPanel />}
        {sidebarTab === 'radiation' && <RadiationPanel />}
        {sidebarTab === 'patients' && <PatientsPanel />}
        {sidebarTab === 'swarm' && <SwarmPanel />}
        {sidebarTab === 'evac' && <EvacPanel />}
        {sidebarTab === 'log' && <LogPanel />}
      </div>
      <div className="sidebar-foot">All readings SIMULATED · dashboard shows ground-station data unless marked otherwise</div>
    </aside>
  );
}
