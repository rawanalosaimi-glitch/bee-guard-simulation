import { BEE_IDS, DEFAULT_CONFIG } from '../sim';
import { effectiveDroneScale, useViewSettings } from '../state/viewSettings';

/** Scope statement: what is simulated, what is implemented, what is planned. */
export function Legend() {
  const droneScale = effectiveDroneScale(useViewSettings());
  return (
    <details className="card legend">
      <summary>Scope · implemented vs planned</summary>
      {BEE_IDS.map((id) => (
        <div key={id} className="leg-row">
          <span className="swatch" style={{ background: DEFAULT_CONFIG.routes[id].color }} />
          <b>{id}</b>
          <span>{DEFAULT_CONFIG.routes[id].plannedRole}</span>
        </div>
      ))}
      <div className="leg-note">
        <p>
          <b>Simulated:</b> flight, deployment, obstacle avoidance, dose-rate detector, casualty detection and HR/RR sensing, relay links with
          latency and loss. No real sensors or radios.
        </p>
        <p>
          <b>Dashboard data:</b> what the ground station received over the simulated links. Ground truth is kept for evaluation in the exports and
          is not shown here.
        </p>
        <p>
          <b>Evacuation:</b> route planning and workflow only — no rescue team or casualty movement is simulated. "Evacuated" is set only by
          operator confirmation.
        </p>
        <p>
          <b>Survey (Phase 3A):</b> BEE-01 flies a lawnmower survey of the marked area, denser scans around hotspots, and — when tasked by the ground
          station over the simulated downlink — the candidate evacuation corridors. Coverage counts measured cells only. A route is "survey-validated"
          only when its measured coverage and largest gap meet the thresholds; this is a planning aid on simulated data, not a safety certification.
        </p>
        <p>
          <b>Risk classes:</b> illustrative thresholds (HR/RR bands adapted from NEWS2), not a clinical assessment.
        </p>
        {droneScale !== 1 && <p>Drone models are drawn ×{droneScale} for visibility; physics uses true size.</p>}
      </div>
    </details>
  );
}
