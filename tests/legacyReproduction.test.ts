import { describe, expect, it } from 'vitest';
import { LEGACY_V060 } from '../src/sim';
import { EXPERIMENT_SCENARIOS, RUN_SUMMARY_COLUMNS, rowsToCsv, runOne } from '../src/sim/experiment';

/**
 * v0.7.0 regression guard: with the three corrections switched off (LEGACY_V060), every v0.6.0 column
 * of the 30-run summary equals the archived v0.6.0 reference byte-for-byte (except sim_version and the configuration hash inside run_id).
 * Proves that the corrections are isolated and that nothing else in the engine changed.
 */
const ARCHIVE = 'archive/baseline_v0.6.0-phase3b-plus/reference_results/runs_summary.csv';

function parse(csv: string): string[][] {
  // the summary has no quoted commas in v0.6.0 columns except possibly `error` (empty in all runs)
  return csv.trim().split(/\r?\n/).map((l) => l.split(','));
}

describe('v0.6.0 reproduction with the corrections switched off', () => {
  it('all 30 runs: every v0.6.0 column identical to the archived baseline (sim_version and the config hash in run_id aside)', async () => {
    // node:fs loaded dynamically: the project has no @types/node (tests run in vitest's node environment)
    const fsName = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, enc: string) => string };
    const base = parse(fs.readFileSync(ARCHIVE, 'utf8'));
    const header = base[0];
    const rows = [];
    for (const sc of EXPERIMENT_SCENARIOS) for (let seed = 101; seed <= 110; seed++) rows.push(runOne(sc, seed, { extra: LEGACY_V060 }).row);
    const now = parse(rowsToCsv(RUN_SUMMARY_COLUMNS, rows));
    expect(now.length).toBe(base.length);
    // the archived header is a prefix of the v0.7.0 header (old columns kept, new ones appended)
    expect(now[0].slice(0, header.length)).toEqual(header);
    // run_id embeds a hash of the full configuration, which now holds the new (switched-off) settings
    const skip = new Set(['sim_version', 'run_id']);
    const diffs: string[] = [];
    for (let r = 1; r < base.length; r++)
      for (let c = 0; c < header.length; c++) if (!skip.has(header[c]) && now[r][c] !== base[r][c]) diffs.push(`${base[r][0]} ${base[r][1]} ${header[c]}: ${base[r][c]} → ${now[r][c]}`);
    expect(diffs).toEqual([]);
  });
});
