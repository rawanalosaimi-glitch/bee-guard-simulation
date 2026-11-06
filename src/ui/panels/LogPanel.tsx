import { TelemetryPanel } from '../TelemetryPanel';
import { EventLog } from '../EventLog';

/** Engine-level telemetry (true simulated positions) and the full event log. */
export function LogPanel() {
  return (
    <>
      <div className="panel-intro">Simulator telemetry: the engine's own drone state (not limited to what the ground station received).</div>
      <TelemetryPanel />
      <EventLog />
    </>
  );
}
