import { describe, expect, it } from 'vitest';
import { BEE_IDS, MOTHER_ID, SimEngine, WORLD } from '../src/sim';

describe('fleet composition', () => {
  it('has exactly three bee drones named BEE-01, BEE-02, BEE-03', () => {
    const engine = new SimEngine();
    const ids = engine.state.bees.map((b) => b.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(['BEE-01', 'BEE-02', 'BEE-03']);
    expect([...BEE_IDS]).toEqual(ids);
  });

  it('has exactly one mother drone', () => {
    const engine = new SimEngine();
    expect(engine.state.mother.id).toBe(MOTHER_ID);
    expect(engine.state.mother.type).toBe('mother');
  });

  it('bee count stays three for the whole mission', () => {
    const engine = new SimEngine();
    engine.start();
    let checked = 0;
    while (engine.state.status === 'ACTIVE') {
      engine.step();
      if (engine.state.step % 100 === 0) {
        expect(engine.state.bees).toHaveLength(3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
    const sampledBees = new Set(engine.state.samples.filter((s) => s.entityType === 'bee').map((s) => s.entityId));
    expect(sampledBees.size).toBe(3);
  });

  it('scenario has one casualty and one radiation source', () => {
    expect(WORLD.casualty.id).toBe('CAS-1');
    expect(WORLD.radiationSource.id).toBe('RAD-SRC-1');
  });

  it('all bees start docked inside the mother bay', () => {
    const engine = new SimEngine();
    for (const b of engine.state.bees) {
      expect(b.mode).toBe('DOCKED');
      const d = Math.hypot(
        b.position.x - engine.state.mother.position.x,
        b.position.y - engine.state.mother.position.y,
        b.position.z - engine.state.mother.position.z,
      );
      expect(d).toBeLessThan(1.5);
    }
  });
});
