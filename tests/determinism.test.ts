import { describe, expect, it } from 'vitest';
import { SimEngine, eventsToCsv, positionsToCsv } from '../src/sim';

function runCsv(engine: SimEngine): string {
  engine.runToCompletion();
  return positionsToCsv(engine) + eventsToCsv(engine);
}

describe('fixed-step clock and reset determinism', () => {
  it('time is always exactly step × dt', () => {
    const e = new SimEngine();
    e.start();
    for (let i = 0; i < 500; i++) {
      e.step();
      expect(e.state.time).toBe(e.state.step * e.config.dt);
    }
  });

  it('reset restores the exact initial state', () => {
    const e = new SimEngine();
    const initial = JSON.stringify(e.state);
    e.start();
    for (let i = 0; i < 700; i++) e.step();
    expect(JSON.stringify(e.state)).not.toBe(initial);
    e.reset();
    expect(JSON.stringify(e.state)).toBe(initial);
  });

  it('a reset run reproduces the previous run byte-for-byte', () => {
    const e = new SimEngine({ seed: 42 });
    const first = runCsv(e);
    e.reset();
    const second = runCsv(e);
    expect(second).toBe(first);
  });

  it('two independent engines with the same seed are identical', () => {
    expect(runCsv(new SimEngine({ seed: 7 }))).toBe(runCsv(new SimEngine({ seed: 7 })));
  });

  it('a different seed changes the trajectory (randomness is actually used)', () => {
    const a = new SimEngine({ seed: 1 });
    const b = new SimEngine({ seed: 2 });
    a.runToCompletion();
    b.runToCompletion();
    expect(positionsToCsv(a)).not.toBe(positionsToCsv(b));
  });

  it('reset(seed) switches seed and is itself reproducible', () => {
    const e = new SimEngine({ seed: 42 });
    e.reset(99);
    expect(e.config.seed).toBe(99);
    const viaReset = runCsv(e);
    expect(runCsv(new SimEngine({ seed: 99 }))).toBe(viaReset);
  });

  it('result does not depend on how steps are batched (frame-rate independence)', () => {
    const a = new SimEngine({ seed: 5 });
    const b = new SimEngine({ seed: 5 });
    a.start();
    b.start();
    // a: one step at a time; b: irregular batches (as a variable frame rate would produce)
    const batches = [1, 7, 3, 16, 2, 9];
    let n = 0;
    while (a.state.status === 'ACTIVE' || b.state.status === 'ACTIVE') {
      a.step();
      const k = batches[n++ % batches.length];
      for (let i = 0; i < k; i++) b.step();
      if (n > 100000) break;
    }
    expect(positionsToCsv(b)).toBe(positionsToCsv(a));
  });
});
