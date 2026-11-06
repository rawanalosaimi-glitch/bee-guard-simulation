import { useEffect, useRef } from 'react';
import { DEFAULT_CONFIG } from '../sim';
import type { BeeId } from '../sim';
import { simController } from '../state/simController';
import { useSimTick } from '../state/hooks';

const colorOf = (id: string) => (id.startsWith('BEE-') ? DEFAULT_CONFIG.routes[id as BeeId].color : '#e5e7eb');

export function EventLog() {
  useSimTick(6);
  const events = simController.engine.state.events;
  const list = useRef<HTMLDivElement>(null);
  const shown = events.slice(-200);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [events.length]);
  return (
    <section className="panel eventlog">
      <div className="panel-title">
        Event log <span className="muted">{events.length} events</span>
      </div>
      <div className="log" ref={list}>
        {shown.length === 0 && <div className="log-empty">Press Start to begin the mission.</div>}
        {shown.map((e, i) => (
          <div key={events.length - shown.length + i} className={`log-row ev-${e.type.toLowerCase()}`}>
            <span className="log-t">{e.time.toFixed(2)}</span>
            <span className="log-id" style={{ color: colorOf(e.entityId) }}>
              {e.entityId}
            </span>
            <span className="log-type">{e.type}</span>
            <span className="log-d">{e.details}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
