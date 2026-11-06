import {
  commsToCsv,
  datasetJson,
  datasetZip,
  evacuationPlansToCsv,
  eventsToCsv,
  gsRadiationToCsv,
  missionControlSnapshot,
  positionsToCsv,
  radiationMeasurementsToCsv,
  radiationTruthToCsv,
  routeCandidatesToCsv,
  routePlanToCsv,
  routeTruthToCsv,
  runMetadata,
  vitalsMeasurementsToCsv,
  vitalsTruthToCsv,
} from '../sim';
import type { SimEngine } from '../sim';

function save(filename: string, content: BlobPart, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = (e: SimEngine) => `${e.runId}_t${e.state.time.toFixed(1)}s`;
const CSV = 'text/csv;charset=utf-8';

export interface ExportItem {
  label: string;
  group: 'Dataset' | 'Mission Control' | 'Measurements' | 'Ground truth' | 'Metadata';
  run: (e: SimEngine) => void;
}

export const EXPORTS: ExportItem[] = [
  {
    label: 'Complete dataset (.zip)',
    group: 'Dataset',
    run: (e) => save(`beeguard_dataset_${stamp(e)}.zip`, datasetZip(e) as Uint8Array<ArrayBuffer>, 'application/zip'),
  },
  {
    label: 'Mission Control snapshot JSON',
    group: 'Mission Control',
    run: (e) => save(`beeguard_mission_control_${stamp(e)}.json`, JSON.stringify(missionControlSnapshot(e), null, 2), 'application/json'),
  },
  {
    label: 'GS-received radiation CSV',
    group: 'Mission Control',
    run: (e) => save(`beeguard_gs_radiation_${stamp(e)}.csv`, gsRadiationToCsv(e), CSV),
  },
  {
    label: 'Evacuation plans CSV',
    group: 'Mission Control',
    run: (e) => save(`beeguard_evacuation_plans_${stamp(e)}.csv`, evacuationPlansToCsv(e), CSV),
  },
  {
    label: 'Route candidates CSV (corridor validation)',
    group: 'Mission Control',
    run: (e) => save(`beeguard_route_candidates_${stamp(e)}.csv`, routeCandidatesToCsv(e), CSV),
  },
  {
    label: 'BEE-01 route plan CSV',
    group: 'Measurements',
    run: (e) => save(`beeguard_bee01_route_plan_${stamp(e)}.csv`, routePlanToCsv(e), CSV),
  },
  {
    label: 'Route candidates truth CSV',
    group: 'Ground truth',
    run: (e) => save(`beeguard_route_candidates_truth_${stamp(e)}.csv`, routeTruthToCsv(e), CSV),
  },
  { label: 'Positions CSV', group: 'Measurements', run: (e) => save(`beeguard_positions_${stamp(e)}.csv`, positionsToCsv(e), CSV) },
  { label: 'Events CSV', group: 'Measurements', run: (e) => save(`beeguard_events_${stamp(e)}.csv`, eventsToCsv(e), CSV) },
  {
    label: 'Radiation measurements CSV',
    group: 'Measurements',
    run: (e) => save(`beeguard_radiation_measurements_${stamp(e)}.csv`, radiationMeasurementsToCsv(e), CSV),
  },
  {
    label: 'Vitals measurements CSV',
    group: 'Measurements',
    run: (e) => save(`beeguard_vitals_measurements_${stamp(e)}.csv`, vitalsMeasurementsToCsv(e), CSV),
  },
  { label: 'Comms log CSV', group: 'Measurements', run: (e) => save(`beeguard_comms_${stamp(e)}.csv`, commsToCsv(e), CSV) },
  {
    label: 'Radiation truth CSV',
    group: 'Ground truth',
    run: (e) => save(`beeguard_radiation_truth_${stamp(e)}.csv`, radiationTruthToCsv(e), CSV),
  },
  { label: 'Vitals truth CSV', group: 'Ground truth', run: (e) => save(`beeguard_vitals_truth_${stamp(e)}.csv`, vitalsTruthToCsv(e), CSV) },
  {
    label: 'Run metadata + summary JSON',
    group: 'Metadata',
    run: (e) => save(`beeguard_run_${stamp(e)}.json`, JSON.stringify(runMetadata(e), null, 2), 'application/json'),
  },
  {
    label: 'Full dataset JSON',
    group: 'Metadata',
    run: (e) => save(`beeguard_full_${stamp(e)}.json`, JSON.stringify(datasetJson(e)), 'application/json'),
  },
];
