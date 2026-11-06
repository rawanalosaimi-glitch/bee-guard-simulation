import { useEffect, useState, useSyncExternalStore } from 'react';
import { simController } from './simController';

/**
 * Re-render a React component at most `hz` times per second while the
 * simulation changes. Panels read engine state directly during render, so
 * every displayed number comes from the same object the CSV export reads.
 */
/** Id of the site (world) of the current engine; changes only when a Reset selects another site variant. */
export function useWorldId(): string {
  return useSyncExternalStore(
    (fn) => simController.subscribe(fn),
    () => simController.engine.world.scenarioId,
  );
}

export function useSimTick(hz = 10): number {
  const [version, setVersion] = useState(simController.version);
  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = simController.subscribe(() => {
      if (pending) return;
      pending = true;
      timer = setTimeout(() => {
        pending = false;
        setVersion(simController.version);
      }, 1000 / hz);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [hz]);
  return version;
}
