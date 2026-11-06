import { SimEngine } from '../src/sim';
import type { SimConfigOverrides, SimState } from '../src/sim';

/** Run a fresh engine to completion (default config unless overridden). */
export function completedRun(overrides: SimConfigOverrides = {}): { engine: SimEngine; state: SimState } {
  const engine = new SimEngine(overrides);
  const state = engine.runToCompletion();
  return { engine, state };
}

export function eventsOf(state: SimState, type: string, entityId?: string) {
  return state.events.filter((e) => e.type === type && (entityId === undefined || e.entityId === entityId));
}
