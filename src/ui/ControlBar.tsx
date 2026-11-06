import { GRAPHICS_LEVELS, QUALITY } from '../viz/quality';
import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG, EXPERIMENT_SCENARIOS, WORLD, missionAlerts, missionMilestones } from '../sim';
import { FACTOR_LEVELS } from '../scenarios/factors';
import type { SimConfigOverrides } from '../sim';
import { simController } from '../state/simController';
import { useSimTick } from '../state/hooks';
import { useViewSettings, viewSettings } from '../state/viewSettings';
import type { ViewSettings } from '../state/viewSettings';
import { EXPORTS } from './download';
import { toggleFullscreen } from './fullscreen';
import { PhaseChip } from './panels/PhaseStepper';

const SPEEDS = [1, 2, 5, 10];

interface ScenarioField {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  def: number;
  apply: (v: number, o: SimConfigOverrides) => void;
}

const D = DEFAULT_CONFIG;
const FIELDS: ScenarioField[] = [
  { key: 'S', label: 'Source strength', unit: 'µSv/h @1 m', min: 0, max: 100000, def: D.radiation.sourceStrength_uSv_h_at_1m, apply: (v, o) => (o.radiation = { ...o.radiation, sourceStrength_uSv_h_at_1m: v }) },
  { key: 'B', label: 'Background', unit: 'µSv/h', min: 0.001, max: 100, def: D.radiation.background_uSv_h, apply: (v, o) => (o.radiation = { ...o.radiation, background_uSv_h: v }) },
  { key: 'pl0', label: 'Packet loss (near)', unit: '%', min: 0, max: 100, def: D.comms.packetLossBase * 100, apply: (v, o) => (o.comms = { ...o.comms, packetLossBase: v / 100 }) },
  { key: 'pl1', label: 'Packet loss (range edge)', unit: '%', min: 0, max: 100, def: D.comms.packetLossEdge * 100, apply: (v, o) => (o.comms = { ...o.comms, packetLossEdge: v / 100 }) },
  { key: 'lat', label: 'Latency per hop', unit: 'ms', min: 0, max: 10000, def: D.comms.latencyBase_ms, apply: (v, o) => (o.comms = { ...o.comms, latencyBase_ms: v }) },
  { key: 'jit', label: 'Jitter (mean)', unit: 'ms', min: 0, max: 10000, def: D.comms.latencyJitterMean_ms, apply: (v, o) => (o.comms = { ...o.comms, latencyJitterMean_ms: v }) },
  { key: 'rng', label: 'Link range', unit: 'm', min: 1, max: 2000, def: D.comms.linkRange_m, apply: (v, o) => (o.comms = { ...o.comms, linkRange_m: v }) },
  { key: 'kap', label: 'Evac radiation weight κ', unit: '—', min: 0, max: 100, def: D.evacuation.radiationWeight, apply: (v, o) => (o.evacuation = { ...o.evacuation, radiationWeight: v }) },
  { key: 'alr', label: 'Dose-rate alert level', unit: 'µSv/h', min: 0.001, max: 100000, def: D.alerts.doseRate_uSv_h, apply: (v, o) => (o.alerts = { ...o.alerts, doseRate_uSv_h: v }) },
];

/** 2026-10-26: scenario presets. Radiation = the validated LOW/MEDIUM/HIGH study scenarios; the
 * other three are the separate factors of Factor Study F1 (src/scenarios/factors.ts). */
type PresetKey = 'radiation' | 'clutter' | 'speed' | 'autonomy';
const PRESETS: { key: PresetKey; label: string; options: { id: string; label: string }[] }[] = [
  { key: 'radiation', label: 'Radiation / casualty', options: [{ id: '', label: 'Custom (fields below)' }, ...EXPERIMENT_SCENARIOS.map((s) => ({ id: s.id, label: `${s.id} (study)` }))] },
  { key: 'clutter', label: 'Obstacle clutter', options: FACTOR_LEVELS.filter((l) => l.factor === 'clutter').map((l) => ({ id: l.id, label: l.label })) },
  { key: 'speed', label: 'Mobility speed', options: FACTOR_LEVELS.filter((l) => l.factor === 'speed').map((l) => ({ id: l.id, label: l.label })) },
  { key: 'autonomy', label: 'Autonomy level', options: FACTOR_LEVELS.filter((l) => l.factor === 'autonomy').map((l) => ({ id: l.id, label: l.label })) },
];
const PRESET_DEFAULT: Record<PresetKey, string> = { radiation: '', clutter: 'CLUTTER-MEDIUM', speed: 'SPEED-MEDIUM', autonomy: 'AUTONOMY-L3' };
function deepMerge<T>(a: T, b: unknown): T {
  if (b === undefined) return a;
  if (typeof a !== 'object' || a === null || Array.isArray(a) || typeof b !== 'object' || b === null || Array.isArray(b)) return b as T;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out as T;
}

const closeMenus = (except?: Element | null) =>
  document.querySelectorAll('details.menu[open]').forEach((d) => {
    if (!except || !d.contains(except)) d.removeAttribute('open');
  });

export function ControlBar() {
  useSimTick(6);
  const view = useViewSettings();
  const engine = simController.engine;
  const s = engine.state;
  const status = s.status;
  const running = simController.running;
  const [seedText, setSeedText] = useState(String(engine.config.seed));
  const [scen, setScen] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, String(f.def)])));
  const [preset, setPreset] = useState<Record<PresetKey, string>>(PRESET_DEFAULT);
  const seedValid = /^\d{1,10}$/.test(seedText) && Number(seedText) <= 4294967295;
  const scenValid = FIELDS.every((f) => {
    const v = Number(scen[f.key]);
    return scen[f.key] !== '' && Number.isFinite(v) && v >= f.min && v <= f.max;
  });
  const hasData = s.samples.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'h' || k === 's') viewSettings.set({ sidebarOpen: !viewSettings.get().sidebarOpen });
      else if (k === 'f') toggleFullscreen();
      else if (k === 'o') viewSettings.set({ cameraMode: 'overview', cameraNonce: viewSettings.get().cameraNonce + 1 });
      else if (k === 't') viewSettings.set({ cameraMode: 'top', cameraNonce: viewSettings.get().cameraNonce + 1 });
      else if (k === 'v') viewSettings.set({ mainView: viewSettings.get().mainView === '3d' ? 'aerial' : '3d' });
      else if (k === 'b') viewSettings.set({ cameraMode: 'base', cameraNonce: viewSettings.get().cameraNonce + 1 });
      else if (k === 'c') viewSettings.set({ cleanView: !viewSettings.get().cleanView });
      else if (e.key === ' ') {
        e.preventDefault();
        const st = simController.engine.state.status;
        if (st === 'READY' || (st === 'ACTIVE' && !simController.running)) simController.start();
        else if (st === 'ACTIVE') simController.pause();
      }
    };
    const onDown = (e: MouseEvent) => closeMenus(e.target as Element);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, []);

  const buildScenario = (): SimConfigOverrides => {
    let o: SimConfigOverrides = {};
    for (const f of FIELDS) f.apply(Number(scen[f.key]), o);
    const rad = EXPERIMENT_SCENARIOS.find((x) => x.id === preset.radiation);
    if (rad) o = deepMerge(o, rad.overrides);
    for (const k of ['speed', 'autonomy'] as const) {
      const lv = FACTOR_LEVELS.find((l) => l.id === preset[k]);
      if (lv) o = deepMerge(o, lv.overrides);
    }
    return o;
  };
  const presetWorld = () => FACTOR_LEVELS.find((l) => l.id === preset.clutter)?.world ?? WORLD;
  const doReset = () => simController.reset(seedValid ? Number(seedText) : undefined, scenValid ? buildScenario() : undefined, scenValid ? presetWorld() : undefined);
  const choosePreset = (k: PresetKey, id: string) => {
    setPreset({ ...preset, [k]: id });
    const rad = EXPERIMENT_SCENARIOS.find((x) => x.id === id);
    if (k === 'radiation' && rad) setScen({ ...scen, S: String(rad.overrides.radiation?.sourceStrength_uSv_h_at_1m ?? D.radiation.sourceStrength_uSv_h_at_1m) });
  };

  const primary =
    status === 'READY'
      ? { label: 'Start', act: () => simController.start() }
      : status === 'ACTIVE' && running
        ? { label: 'Pause', act: () => simController.pause() }
        : status === 'ACTIVE'
          ? { label: 'Resume', act: () => simController.start() }
          : { label: 'Complete', act: () => undefined };

  const changed = FIELDS.filter((f) => Number(scen[f.key]) !== f.def).length + (Object.keys(preset) as PresetKey[]).filter((k) => preset[k] !== PRESET_DEFAULT[k]).length;
  const ms = missionMilestones(s);
  const done = ms.filter((m) => m.done).length;
  const alerts = missionAlerts(s, engine.config);
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const warn = alerts.filter((a) => a.severity === 'warning').length;
  const next = ms.find((m) => !m.done);
  const openTab = (tab: ViewSettings['sidebarTab']) => viewSettings.set({ sidebarOpen: true, sidebarTab: tab });

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div>
          <div className="brand-title">BEE-GUARD</div>
          <div className="brand-sub">Mission Control · research simulation</div>
        </div>
        <span className="sim-badge" title="Every number on screen and in exports is computed by the simulation. No real sensor data.">
          SIMULATED
        </span>
      </div>

      <div className="mission-status" aria-live="polite">
        <div className="ms-time">
          <label>Sim time</label>
          <b>{s.time.toFixed(1)} s</b>
        </div>
        <PhaseChip s={s} />
        <button className="ms-progress" onClick={() => openTab('mission')} title={ms.map((m) => `${m.done ? '✓' : '○'} ${m.label}`).join('\n')}>
          <div className="ms-bar">
            {ms.map((m) => (
              <i key={m.key} className={m.done ? 'on' : ''} />
            ))}
          </div>
          <span>
            {done}/{ms.length} · {status === 'READY' ? 'Ready — press Start' : next ? `Next: ${next.label}` : 'All milestones reached'}
          </span>
        </button>
        <button className={`ms-alerts ${crit ? 'crit' : warn ? 'warn' : 'ok'}`} onClick={() => openTab('mission')} title="Open alerts">
          {crit ? `▲ ${crit} critical` : warn ? `● ${warn} warning${warn > 1 ? 's' : ''}` : '✓ no alerts'}
          {crit > 0 && warn > 0 ? ` · ${warn} warn` : ''}
        </button>
      </div>

      <div className="controls">
        <div className="group">
          <button className={`btn primary ${status === 'COMPLETE' ? 'done' : ''}`} onClick={primary.act} disabled={status === 'COMPLETE'}>
            {primary.label}
          </button>
          <button className="btn" onClick={() => simController.stepOnce()} disabled={status === 'COMPLETE'} title="Advance one fixed 50 ms step">
            Step
          </button>
          <button className="btn" onClick={doReset} title="Reset to t = 0 with the seed and scenario shown">
            Reset
          </button>
        </div>
        <div className="group">
          <label className="field">
            <span>Seed</span>
            <input value={seedText} onChange={(e) => setSeedText(e.target.value.trim())} className={seedValid ? '' : 'invalid'} inputMode="numeric" aria-label="Random seed (applied on Reset)" />
          </label>
          <div className="seg" role="group" aria-label="Simulation speed">
            {SPEEDS.map((sp) => (
              <button key={sp} className={simController.speed === sp ? 'on' : ''} onClick={() => simController.setSpeed(sp)}>
                {sp}×
              </button>
            ))}
          </div>
        </div>
        <div className="group">
          <details className="menu">
            <summary className={`btn ${changed ? 'accent' : ''}`}>Scenario{changed ? ` (${changed})` : ''} ▾</summary>
            <div className="menu-body scenario">
              <div className="menu-note">Applied on Reset. Exported in run_metadata.json.</div>
              {PRESETS.map((p) => (
                <label key={p.key} className="scen-row">
                  <span>{p.label}</span>
                  <select value={preset[p.key]} onChange={(e) => choosePreset(p.key, e.target.value)} aria-label={p.label}>
                    {p.options.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                  <em>preset</em>
                </label>
              ))}
              {FIELDS.map((f) => {
                const v = Number(scen[f.key]);
                const bad = scen[f.key] === '' || !Number.isFinite(v) || v < f.min || v > f.max;
                return (
                  <label key={f.key} className="scen-row">
                    <span>{f.label}</span>
                    <input value={scen[f.key]} inputMode="decimal" className={bad ? 'invalid' : ''} onChange={(e) => setScen({ ...scen, [f.key]: e.target.value.trim() })} />
                    <em>{f.unit}</em>
                  </label>
                );
              })}
              <div className="menu-actions">
                <button className="btn" onClick={() => { setScen(Object.fromEntries(FIELDS.map((f) => [f.key, String(f.def)]))); setPreset(PRESET_DEFAULT); }}>
                  Defaults
                </button>
                <button
                  className="btn primary"
                  disabled={!scenValid}
                  onClick={() => {
                    doReset();
                    closeMenus();
                  }}
                >
                  Apply & Reset
                </button>
              </div>
            </div>
          </details>
          <details className="menu">
            <summary className="btn">View ▾</summary>
            <div className="menu-body">
              {(
                [
                  ['showLabels', 'Labels'],
                  ['showRoutes', 'Planned drone routes'],
                  ['showTrails', 'Flown trails'],
                  ['showLinks', 'Comms links'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={view[k]} onChange={(e) => viewSettings.set({ [k]: e.target.checked } as Partial<ViewSettings>)} />
                  {label}
                </label>
              ))}
              <div className="menu-note">Overlay style</div>
              <div className="seg" role="group" aria-label="Overlay style">
                <button className={view.overlayStyle === 'clean' ? 'on' : ''} title="Fading 30 s trails, active route legs, compact de-cluttered labels" onClick={() => viewSettings.set({ overlayStyle: 'clean' })}>
                  Clean
                </button>
                <button className={view.overlayStyle === 'full' ? 'on' : ''} title="Full trails, complete planned routes, all labels" onClick={() => viewSettings.set({ overlayStyle: 'full' })}>
                  Full
                </button>
              </div>
              <label className="check" title="Hide all overlays (trails, routes, links, labels, heat-map, markers)">
                <input type="checkbox" checked={view.cleanView} onChange={(e) => viewSettings.set({ cleanView: e.target.checked })} />
                Clean view (hide all overlays)
              </label>
              <label className="check" title="Enlarges drone models for visibility only; physics uses true size">
                <input type="checkbox" checked={view.droneScale !== 1} onChange={(e) => viewSettings.set({ droneScale: e.target.checked ? 2.5 : 1 })} />
                Drone models ×2.5
              </label>
              <div className="menu-sep" />
              <div className="menu-note">Graphics{view.gpu ? ` · ${view.gpu}` : ''}</div>
              <div className="seg" role="group" aria-label="Graphics quality">
                {GRAPHICS_LEVELS.map((g) => (
                  <button key={g} className={view.graphics === g ? 'on' : ''} title={QUALITY[g].label} onClick={() => viewSettings.set({ graphics: g, graphicsAuto: false })}>
                    {QUALITY[g].label}
                  </button>
                ))}
              </div>
              {view.graphicsAuto && view.graphics === 'performance' && <div className="menu-note">Default for integrated graphics (Intel UHD).</div>}
              <label className="check" title="Frame rate, frame time and draw calls of the 3D view">
                <input type="checkbox" checked={view.showPerf} onChange={(e) => viewSettings.set({ showPerf: e.target.checked })} />
                FPS / frame-time meter
              </label>
              <div className="menu-sep" />
              <div className="menu-note">Keys: Space start/pause · S sidebar · F full screen · O overview · T top view · C clean view</div>
            </div>
          </details>
          <details className="menu">
            <summary className="btn">Export ▾</summary>
            <div className="menu-body exports">
              {(['Dataset', 'Mission Control', 'Measurements', 'Ground truth', 'Metadata'] as const).map((g) => (
                <div key={g}>
                  <div className="menu-note">{g}</div>
                  {EXPORTS.filter((x) => x.group === g).map((x) => (
                    <button
                      key={x.label}
                      className="menu-item"
                      disabled={!hasData}
                      onClick={() => {
                        x.run(engine);
                        closeMenus();
                      }}
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
