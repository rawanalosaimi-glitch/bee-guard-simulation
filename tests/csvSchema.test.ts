import { describe, expect, it } from 'vitest';
import {
  BEE_IDS,
  EVENT_COLUMNS,
  MOTHER_ID,
  POSITION_COLUMNS,
  csvEscape,
  eventsToCsv,
  parseCsv,
  positionsToCsv,
  runMetadata,
} from '../src/sim';
import { completedRun } from './helpers';

const NUMERIC_POSITION_COLUMNS = [
  'seed',
  'sim_time_s',
  'step',
  'x_m',
  'y_m',
  'z_m',
  'vx_mps',
  'vy_mps',
  'vz_mps',
  'speed_mps',
  'waypoint_index',
  'waypoint_total',
  'hatch_open_frac',
  'avoidance_active',
];

describe('CSV export schema', () => {
  const { engine, state } = completedRun();
  const posRows = parseCsv(positionsToCsv(engine));
  const evRows = parseCsv(eventsToCsv(engine));

  it('positions CSV has the documented header, in order', () => {
    expect(posRows[0]).toEqual([...POSITION_COLUMNS]);
  });

  it('events CSV has the documented header, in order', () => {
    expect(evRows[0]).toEqual([...EVENT_COLUMNS]);
  });

  it('every row has the same number of fields as the header', () => {
    for (const r of posRows) expect(r.length).toBe(POSITION_COLUMNS.length);
    for (const r of evRows) expect(r.length).toBe(EVENT_COLUMNS.length);
  });

  it('row counts match engine state exactly (no fabricated rows)', () => {
    expect(posRows.length - 1).toBe(state.samples.length);
    expect(evRows.length - 1).toBe(state.events.length);
  });

  it('numeric columns parse to finite numbers', () => {
    const idx = NUMERIC_POSITION_COLUMNS.map((c) => POSITION_COLUMNS.indexOf(c as (typeof POSITION_COLUMNS)[number]));
    for (const r of posRows.slice(1)) {
      for (const i of idx) expect(Number.isFinite(Number(r[i]))).toBe(true);
    }
  });

  it('every row is marked SIMULATED', () => {
    const pi = POSITION_COLUMNS.indexOf('data_source');
    const ei = EVENT_COLUMNS.indexOf('data_source');
    for (const r of posRows.slice(1)) expect(r[pi]).toBe('SIMULATED');
    for (const r of evRows.slice(1)) expect(r[ei]).toBe('SIMULATED');
    expect(runMetadata(engine).data_source).toBe('SIMULATED');
  });

  it('entity ids are only the mother and the three bees', () => {
    const ii = POSITION_COLUMNS.indexOf('entity_id');
    const ids = new Set(posRows.slice(1).map((r) => r[ii]));
    expect([...ids].sort()).toEqual([MOTHER_ID, ...BEE_IDS].sort());
  });

  it('sim time is non-decreasing and equals step × dt', () => {
    const ti = POSITION_COLUMNS.indexOf('sim_time_s');
    const si = POSITION_COLUMNS.indexOf('step');
    let prev = -1;
    for (const r of posRows.slice(1)) {
      const time = Number(r[ti]);
      expect(time).toBeGreaterThanOrEqual(prev);
      expect(Math.abs(time - Number(r[si]) * engine.config.dt)).toBeLessThan(1e-6);
      prev = time;
    }
  });

  it('uses CRLF line endings and escapes commas/quotes', () => {
    expect(positionsToCsv(engine).includes('\r\n')).toBe(true);
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(parseCsv('x,"a,b","q""q"\r\n')).toEqual([['x', 'a,b', 'q"q']]);
  });
});
