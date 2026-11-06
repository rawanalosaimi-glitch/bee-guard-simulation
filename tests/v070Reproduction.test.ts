import { describe, expect, it } from 'vitest';
import { V070_SCI1, V071_SCI2 } from '../src/sim';
import { EXPERIMENT_SCENARIOS, RUN_SUMMARY_COLUMNS, rowsToCsv, runOne } from '../src/sim/experiment';

/**
 * Regression guards: with V070_SCI1 (floor 3 × B, no tie break, 3-window escalation) / V071_SCI2 (floor 2 × B,
 * no tie break, 3-window escalation) all 30 runs reproduce the preserved v0.7.0 / v0.7.1 references in every
 * column except sim_version and the configuration hash in run_id — so the 0.8.0-rc1 changes are isolated.
 */

const parse = (csv: string) => csv.trim().split(/\r?\n/).map((l) => l.split(','));

function check(name: string, REF: string, extra: object) {
  describe(name, () => {
  it('all 30 runs identical to the preserved reference (sim_version and run_id hash aside)', async () => {
    const fsName = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, enc: string) => string };
    const ref = parse(fs.readFileSync(REF, 'utf8'));
    const rows = [];
    for (const sc of EXPERIMENT_SCENARIOS) for (let seed = 101; seed <= 110; seed++) rows.push(runOne(sc, seed, { extra }).row);
    const now = parse(rowsToCsv(RUN_SUMMARY_COLUMNS, rows));
    expect(now[0]).toEqual(ref[0]);
    expect(now.length).toBe(ref.length);
    const skip = new Set(['sim_version', 'run_id']);
    const diffs: string[] = [];
    for (let r = 1; r < ref.length; r++) for (let c = 0; c < ref[0].length; c++) if (!skip.has(ref[0][c]) && now[r][c] !== ref[r][c]) diffs.push(`${ref[r][0]} ${ref[r][1]} ${ref[0][c]}: ${ref[r][c]} → ${now[r][c]}`);
    expect(diffs).toEqual([]);
  });
});
}
check('v0.7.0 reproduction (V070_SCI1)', 'experiments/reference_results_v0.7.0/runs_summary.csv', V070_SCI1);
check('v0.7.1 reproduction (V071_SCI2)', 'experiments/reference_results_v0.7.1/runs_summary.csv', V071_SCI2);
