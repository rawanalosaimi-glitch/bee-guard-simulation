import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SimEngine, commsStats, hopLossProbability } from '../src/sim';
import { completedRun } from './helpers';

const K = DEFAULT_CONFIG.comms;

describe('BEE-03 communication relay', () => {
  const { state } = completedRun();
  const msgs = state.comms.messages;

  it('per-hop loss probability follows base + (edge − base)·(d/range)², 1 beyond range', () => {
    expect(hopLossProbability(K, 0)).toBe(K.packetLossBase);
    expect(Math.abs(hopLossProbability(K, K.linkRange_m) - K.packetLossEdge)).toBeLessThan(1e-12);
    expect(hopLossProbability(K, K.linkRange_m + 0.01)).toBe(1);
  });

  it('every message ends DELIVERED or DROPPED, and the counts add up', () => {
    const st = commsStats(msgs);
    expect(st.sent).toBeGreaterThan(50);
    expect(st.inFlight).toBe(0);
    expect(st.delivered + st.droppedLink + st.droppedNoRoute).toBe(st.sent);
  });

  it('logs sent / received / dropped with timestamps and routes', () => {
    for (const m of msgs) {
      expect(Number.isFinite(m.tSent)).toBe(true);
      if (m.status === 'DELIVERED') {
        expect(m.tReceived as number).toBeGreaterThan(m.tSent);
        expect(Math.abs((m.latency_ms as number) - ((m.tReceived as number) - m.tSent) * 1000)).toBeLessThan(1e-6);
        expect(m.route[0]).toBe(m.src);
        expect(m.route[m.route.length - 1]).toBe(m.dst);
        // uplink ends at the GS; the only downlink is GS → BEE-01 tasking (Phase 3A)
        if (m.src === K.groundStationId) {
          expect(m.dst).toBe('BEE-01');
          expect(m.type).toBe('TASK_CORRIDOR_SURVEY');
        } else expect(m.dst).toBe(K.groundStationId);
      } else if (m.status === 'DROPPED_NO_ROUTE') {
        expect(m.route).toHaveLength(0);
        expect(m.tReceived).toBe(null);
      } else {
        expect(m.status).toBe('DROPPED_LINK');
        expect(m.dropHop as number).toBeGreaterThanOrEqual(1);
        expect(m.tReceived).toBe(null);
      }
    }
  });

  it('latency ≥ per-hop base latency (+ relay processing)', () => {
    for (const m of msgs.filter((x) => x.status === 'DELIVERED')) {
      const hops = m.route.length - 1;
      const floor = hops * K.latencyBase_ms + (hops - 1) * K.relayProcessing_ms;
      expect(m.latency_ms as number).toBeGreaterThanOrEqual(floor - 1e-6);
    }
  });

  it('uses BEE-03 as relay when the sender is out of direct range, and every hop is within range', () => {
    const relayed = msgs.filter((m) => m.route.length === 3);
    expect(relayed.length).toBeGreaterThan(0);
    for (const m of relayed) expect(m.route[1]).toBe('BEE-03');
    for (const m of msgs) for (const d of m.hopDistances_m) expect(d).toBeLessThan(K.linkRange_m + 1e-9);
  });

  it('only measurements travel over the link — never ground truth', () => {
    for (const m of msgs) {
      expect(m.payload.includes('true')).toBe(false);
      expect(m.payload.includes('truth')).toBe(false);
    }
  });

  it('zero loss → everything with a route is delivered; total loss → nothing is', () => {
    const ok = new SimEngine({ comms: { packetLossBase: 0, packetLossEdge: 0 } }).runToCompletion();
    expect(ok.comms.messages.filter((m) => m.status === 'DROPPED_LINK')).toHaveLength(0);
    const bad = new SimEngine({ comms: { packetLossBase: 1, packetLossEdge: 1 } }).runToCompletion();
    expect(bad.comms.messages.filter((m) => m.status === 'DELIVERED')).toHaveLength(0);
    expect(bad.events.filter((e) => e.type === 'LINK_LOST').length).toBeGreaterThan(0);
    expect(bad.comms.gs.radiation).toBe(null);
  });

  it('configurable latency shifts delivery times', () => {
    const slow = new SimEngine({ comms: { latencyBase_ms: 400, latencyJitterMean_ms: 0 } }).runToCompletion();
    const del = slow.comms.messages.filter((m) => m.status === 'DELIVERED');
    expect(del.length).toBeGreaterThan(0);
    for (const m of del) expect(m.latency_ms as number).toBeGreaterThanOrEqual(400 - 1e-6);
  });

  it('no route without a relay: an out-of-range sender is dropped as NO_ROUTE', () => {
    const s = new SimEngine({ comms: { linkRange_m: 10 } }).runToCompletion();
    expect(s.comms.messages.every((m) => m.status === 'DROPPED_NO_ROUTE')).toBe(true);
  });

  it('ground-station view only contains data that was actually delivered', () => {
    const gs = state.comms.gs;
    expect(gs.radiation === null).toBe(false);
    const delivered = msgs.filter((m) => m.status === 'DELIVERED' && m.type === 'RAD_SAMPLE');
    const ids = new Set(delivered.map((m) => m.data.sample));
    expect(ids.has((gs.radiation as { sampleId: number }).sampleId)).toBe(true);
  });
});
