import type { BeeId, CommsConfig } from './config';
import { SeededRng, exponential } from './rng';
import type { BeeState, SubsystemContext } from './types';
import type { Vec3 } from './vec3';

/**
 * BEE-03 communication relay — SIMULATED link model (docs/SIMULATION_MODEL.md §12).
 *
 * Nodes: BEE-01, BEE-02 (sensing), BEE-03 (relay), GS-1 (ground station).
 * Routing is decided when a message is sent:
 *   1. direct to GS if the sender–GS distance ≤ linkRange
 *   2. otherwise via BEE-03 if sender–relay AND relay–GS distances ≤ linkRange
 *   3. otherwise the message is dropped as NO_ROUTE
 * Each hop is lost independently with p = base + (edge − base)·(d/range)².
 * Each hop adds latency = base + Exp(jitterMean); the relay adds processing time.
 * Arrivals are processed at the first fixed step at or after the arrival time,
 * but the exact computed arrival time is recorded.
 *
 * Not modelled: line-of-sight blocking by buildings, interference, bandwidth or
 * queueing limits, retransmission/ACKs, link-layer handshakes.
 */

export type MsgType =
  | 'HEARTBEAT'
  | 'RAD_SAMPLE'
  | 'CASUALTY_ALERT'
  | 'VITALS'
  | 'CASUALTY_STATUS'
  // Phase 3A: tasking
  | 'TASK_CORRIDOR_SURVEY' // GS → BEE-01 (downlink)
  | 'TASK_ACK' // BEE-01 → GS
  | 'TASK_STATUS'; // BEE-01 → GS
export type MsgStatus = 'IN_FLIGHT' | 'DELIVERED' | 'DROPPED_LINK' | 'DROPPED_NO_ROUTE';

export interface CommMessage {
  id: number;
  type: MsgType;
  src: string;
  dst: string;
  /** Node ids from source to destination, e.g. ["BEE-01","BEE-03","GS-1"]. Empty when NO_ROUTE. */
  route: string[];
  hopDistances_m: number[];
  stepSent: number;
  tSent: number;
  /** Planned arrival time (also set for dropped messages: null). */
  tArrive: number | null;
  tReceived: number | null;
  stepReceived: number | null;
  latency_ms: number | null;
  status: MsgStatus;
  /** 1-based hop index where the message was lost (DROPPED_LINK). */
  dropHop: number | null;
  /** Compact machine-readable payload, e.g. "sample=12;measured=2.314". */
  payload: string;
  /** Structured payload for the ground-station view. */
  data: Record<string, number | string>;
}

export interface CommsWarning {
  code: 'LINK_LOST' | 'PDR_LOW' | 'LATENCY_HIGH' | 'NO_RELAY';
  nodeId: string;
  message: string;
  since: number;
}

/** A radiation sample as RECEIVED at the ground station (measurement only — never truth). */
export interface ReceivedRadiationSample {
  sampleId: number;
  droneId: string;
  /** Time the measurement window ended on board, s. */
  sampleTime: number;
  /** Time the packet reached the ground station, s. */
  rxTime: number;
  x: number;
  y: number;
  z: number;
  liveTime_s: number;
  counts: number;
  measured_uSv_h: number;
}

/** Ground-station record of one casualty, built only from delivered packets. */
export interface PatientRecord {
  patientId: string;
  reportedBy: string;
  /** On-board detection time reported in the alert, s. */
  detectedAt: number | null;
  /** When the first packet about this patient reached the GS, s. */
  firstRxTime: number;
  lastRxTime: number;
  /** Most recent on-board status string (DETECTED / ASSESSING / ASSESSED / ...). */
  onboardStatus: string;
  /** On-board time of the packet that set `onboardStatus`. */
  statusTime: number;
  /** Estimated casualty position reported by the drone (not ground truth). */
  location: { x: number; z: number; sigma_m: number; sampleTime: number } | null;
  /** Every vital-sign sample RECEIVED at the GS for this patient, ordered by sample time (for live trends). */
  vitalsHistory: { sampleId: number; t: number; hr: number; rr: number; rxTime: number }[];
  /** Most recent single vital-sign sample received. */
  latestVitals: { hr: number; rr: number; sampleTime: number; rxTime: number } | null;
  /**
   * §40: every body-temperature reading RECEIVED at the GS (BEE-02 non-contact IR → SKIN temperature,
   * °C, 1σ), ordered by sample time. Not core body temperature.
   */
  temperatureHistory: { sampleId: number; t: number; skin_c: number; sigma_c: number; rxTime: number }[];
  /** Most recent body-temperature reading received (skin temperature, °C). */
  latestTemperature: { sampleId: number; skin_c: number; sigma_c: number; sampleTime: number; rxTime: number; modality: string } | null;
  /** Most recent assessment (rolling mean of N samples) received. */
  assessment: {
    hr: number;
    rr: number;
    hrScore: number;
    rrScore: number;
    total: number;
    /** Reported (v0.7.0: stabilized) illustrative risk class. */
    risk: string;
    /** v0.7.0: raw class of the latest window and the borderline flag (riskStability.ts); null when not sent. */
    riskRaw: string | null;
    riskBorderline: boolean | null;
    assessedAt: number;
    sampleTime: number;
    rxTime: number;
  } | null;
}

export interface GroundStationView {
  lastRxTime: Record<string, number | null>;
  radiation: { sampleId: number; measured_uSv_h: number; sampleTime: number; rxTime: number } | null;
  /** Phase 2 compatibility summary of the (single) casualty. */
  casualty: {
    status: string;
    risk: string;
    hr: number | null;
    rr: number | null;
    sampleTime: number;
    rxTime: number;
  } | null;
  delivered: number;
  /** Mission Control: every radiation sample that reached the GS, in arrival order. */
  radiationSamples: ReceivedRadiationSample[];
  /** Mission Control: one record per casualty reported to the GS (list supports several). */
  patients: PatientRecord[];
  /** Phase 3A: latest heartbeat content per drone as received (position, mode, task fields). */
  beeReports: Record<string, { x: number; y: number; z: number; mode: string; sampleTime: number; rxTime: number; fields: Record<string, number | string> }>;
  /** Phase 3A: task acknowledgements / status reports received from drones, in arrival order. */
  taskReports: TaskReport[];
}

export interface TaskReport {
  taskId: string;
  from: string;
  kind: 'ACK' | 'STATUS' | 'HEARTBEAT';
  accepted: boolean | null;
  state: string | null;
  progress: number | null;
  reason: string | null;
  sampleTime: number;
  rxTime: number;
}

export interface CommsState {
  messages: CommMessage[];
  inFlight: number[];
  linkUp: Record<string, boolean>;
  gs: GroundStationView;
  warnings: CommsWarning[];
  /** Route used by the most recent message from each sender ("direct", "relay", "none"). */
  lastRoute: Record<string, 'direct' | 'relay' | 'none'>;
  /** Phase 3A: ids of downlink messages delivered to each drone, not yet processed on board. */
  inbox: Record<string, number[]>;
  /**
   * Phase 3B+ store-and-forward (BEE-01 radiation samples): payloads that could not be sent
   * because no route existed, waiting for a route; how many were re-sent; how many were
   * discarded because the backlog was full.
   */
  radBacklog: Record<string, number | string>[];
  radResent: number;
  radBacklogOverflow: number;
}

export const SENDERS: readonly BeeId[] = ['BEE-01', 'BEE-02', 'BEE-03'];

export function initialCommsState(): CommsState {
  const lastRx: Record<string, number | null> = {};
  const linkUp: Record<string, boolean> = {};
  const lastRoute: Record<string, 'direct' | 'relay' | 'none'> = {};
  const inbox: Record<string, number[]> = {};
  for (const id of SENDERS) {
    lastRx[id] = null;
    linkUp[id] = true;
    lastRoute[id] = 'none';
    inbox[id] = [];
  }
  return {
    messages: [],
    inFlight: [],
    linkUp,
    gs: { lastRxTime: lastRx, radiation: null, casualty: null, delivered: 0, radiationSamples: [], patients: [], beeReports: {}, taskReports: [] },
    radBacklog: [],
    radResent: 0,
    radBacklogOverflow: 0,
    warnings: [],
    lastRoute,
    inbox,
  };
}

/** Per-hop loss probability for a hop of length d. */
export function hopLossProbability(cfg: CommsConfig, d: number): number {
  if (d > cfg.linkRange_m) return 1;
  const r = d / cfg.linkRange_m;
  return Math.min(1, Math.max(0, cfg.packetLossBase + (cfg.packetLossEdge - cfg.packetLossBase) * r * r));
}

export const isAirborne = (b: BeeState) => b.mode !== 'DOCKED' && b.mode !== 'RELEASING';

const d3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class CommsNetwork {
  private rng: SeededRng;
  private airborneSince: Record<string, number | null> = {};
  private nextHeartbeat: Record<string, number> = {};
  /** Last time each warning key was written to the event log (10 s cooldown). */
  private warnLogged = new Map<string, number>();

  constructor(seed: number) {
    this.rng = new SeededRng(seed);
    for (const id of SENDERS) {
      this.airborneSince[id] = null;
      this.nextHeartbeat[id] = 0;
    }
  }

  private gsPosition(ctx: SubsystemContext): Vec3 {
    const g = ctx.world.groundStation.position;
    return { x: g.x, y: g.y + ctx.config.comms.gsAntennaHeight_m, z: g.z };
  }

  /** True if a direct or relayed route from `b` to the GS exists right now (same geometry rule as send()). */
  private routeExists(ctx: SubsystemContext, b: BeeState): boolean {
    const cfg = ctx.config.comms;
    const gs = this.gsPosition(ctx);
    if (d3(b.position, gs) <= cfg.linkRange_m) return true;
    const relay = ctx.state.bees.find((x) => x.id === cfg.relayId)!;
    if (b.id === cfg.relayId || !isAirborne(relay)) return false;
    return d3(b.position, relay.position) <= cfg.linkRange_m && d3(relay.position, gs) <= cfg.linkRange_m;
  }

  /** Send one message from a bee to the ground station. Returns the message. */
  send(ctx: SubsystemContext, src: BeeId, type: MsgType, data: Record<string, number | string>): CommMessage {
    const { state: s, config } = ctx;
    const cfg = config.comms;
    const gs = this.gsPosition(ctx);
    const sender = s.bees.find((b) => b.id === src)!;
    const relay = s.bees.find((b) => b.id === cfg.relayId)!;
    const payload = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toFixed(4)) : v}`)
      .join(';');

    const msg: CommMessage = {
      id: s.comms.messages.length + 1,
      type,
      src,
      dst: cfg.groundStationId,
      route: [],
      hopDistances_m: [],
      stepSent: s.step,
      tSent: s.time,
      tArrive: null,
      tReceived: null,
      stepReceived: null,
      latency_ms: null,
      status: 'IN_FLIGHT',
      dropHop: null,
      payload,
      data,
    };

    // --- route selection
    const dDirect = d3(sender.position, gs);
    if (dDirect <= cfg.linkRange_m) {
      msg.route = [src, cfg.groundStationId];
      msg.hopDistances_m = [dDirect];
      s.comms.lastRoute[src] = 'direct';
    } else if (src !== cfg.relayId && isAirborne(relay)) {
      const d1 = d3(sender.position, relay.position);
      const d2 = d3(relay.position, gs);
      if (d1 <= cfg.linkRange_m && d2 <= cfg.linkRange_m) {
        msg.route = [src, cfg.relayId, cfg.groundStationId];
        msg.hopDistances_m = [d1, d2];
        s.comms.lastRoute[src] = 'relay';
      }
    }

    if (msg.route.length === 0) {
      msg.status = 'DROPPED_NO_ROUTE';
      s.comms.lastRoute[src] = 'none';
      s.comms.messages.push(msg);
      // Phase 3B+: the sender knows it has no neighbour in range → keep the sample for later
      const saf = cfg.storeAndForward;
      if (saf?.enabled && type === 'RAD_SAMPLE' && src === 'BEE-01') {
        if (s.comms.radBacklog.length < saf.maxBacklog) s.comms.radBacklog.push({ ...data, resent: 1 });
        else s.comms.radBacklogOverflow += 1;
      }
      return msg;
    }

    // --- per-hop loss and latency (always draw the same number of randoms per hop)
    let latency = 0;
    for (let h = 0; h < msg.hopDistances_m.length; h++) {
      const pLoss = hopLossProbability(cfg, msg.hopDistances_m[h]);
      const lost = this.rng.next() < pLoss;
      latency += cfg.latencyBase_ms + exponential(this.rng, cfg.latencyJitterMean_ms);
      if (h > 0) latency += cfg.relayProcessing_ms;
      if (lost && msg.dropHop === null) msg.dropHop = h + 1;
    }
    if (msg.dropHop !== null) {
      msg.status = 'DROPPED_LINK';
    } else {
      msg.tArrive = s.time + latency / 1000;
      s.comms.inFlight.push(msg.id);
    }
    s.comms.messages.push(msg);
    return msg;
  }

  /**
   * Phase 3A: send one message from the ground station to a drone (DOWNLINK).
   * Same link model as the uplink, mirrored: direct if GS–drone ≤ range, else via
   * the relay, else NO_ROUTE. The receiving drone must be airborne. Not
   * acknowledged at link level — the task protocol retries at application level.
   */
  sendDown(ctx: SubsystemContext, dst: BeeId, type: MsgType, data: Record<string, number | string>): CommMessage {
    const { state: s, config } = ctx;
    const cfg = config.comms;
    const gs = this.gsPosition(ctx);
    const target = s.bees.find((b) => b.id === dst)!;
    const relay = s.bees.find((b) => b.id === cfg.relayId)!;
    const payload = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toFixed(4)) : v}`)
      .join(';');
    const msg: CommMessage = {
      id: s.comms.messages.length + 1,
      type,
      src: cfg.groundStationId,
      dst,
      route: [],
      hopDistances_m: [],
      stepSent: s.step,
      tSent: s.time,
      tArrive: null,
      tReceived: null,
      stepReceived: null,
      latency_ms: null,
      status: 'IN_FLIGHT',
      dropHop: null,
      payload,
      data,
    };
    if (isAirborne(target)) {
      const dDirect = d3(target.position, gs);
      if (dDirect <= cfg.linkRange_m) {
        msg.route = [cfg.groundStationId, dst];
        msg.hopDistances_m = [dDirect];
      } else if (dst !== cfg.relayId && isAirborne(relay)) {
        const d1 = d3(gs, relay.position);
        const d2 = d3(relay.position, target.position);
        if (d1 <= cfg.linkRange_m && d2 <= cfg.linkRange_m) {
          msg.route = [cfg.groundStationId, cfg.relayId, dst];
          msg.hopDistances_m = [d1, d2];
        }
      }
    }
    if (msg.route.length === 0) {
      msg.status = 'DROPPED_NO_ROUTE';
      s.comms.messages.push(msg);
      return msg;
    }
    let latency = 0;
    for (let h = 0; h < msg.hopDistances_m.length; h++) {
      const lost = this.rng.next() < hopLossProbability(cfg, msg.hopDistances_m[h]);
      latency += cfg.latencyBase_ms + exponential(this.rng, cfg.latencyJitterMean_ms);
      if (h > 0) latency += cfg.relayProcessing_ms;
      if (lost && msg.dropHop === null) msg.dropHop = h + 1;
    }
    if (config.mission.faults.downlinkJammed && msg.dropHop === null) msg.dropHop = 1; // fault injection
    if (msg.dropHop !== null) msg.status = 'DROPPED_LINK';
    else {
      msg.tArrive = s.time + latency / 1000;
      s.comms.inFlight.push(msg.id);
    }
    s.comms.messages.push(msg);
    return msg;
  }

  /** Per-step: heartbeats, deliveries, link status, warnings. */
  step(ctx: SubsystemContext): void {
    const { state: s, config } = ctx;
    const cfg = config.comms;

    // airborne bookkeeping + heartbeats
    for (const b of s.bees) {
      if (isAirborne(b)) {
        if (this.airborneSince[b.id] === null) {
          this.airborneSince[b.id] = s.time;
          this.nextHeartbeat[b.id] = s.time;
        }
        if (s.time + 1e-9 >= this.nextHeartbeat[b.id]) {
          this.send(ctx, b.id, 'HEARTBEAT', {
            x: b.position.x,
            y: b.position.y,
            z: b.position.z,
            mode: b.mode,
            // Phase 3A: BEE-01 also reports its survey phase and task progress
            ...(b.id === 'BEE-01' && s.survey.enabled ? s.survey.heartbeat : {}),
          });
          this.nextHeartbeat[b.id] += cfg.heartbeatInterval_s;
        }
      }
    }

    // Phase 3B+ store-and-forward: re-send backlogged BEE-01 samples once a route exists again
    const saf = cfg.storeAndForward;
    if (saf?.enabled && s.comms.radBacklog.length) {
      const b1 = s.bees.find((b) => b.id === 'BEE-01')!;
      if (isAirborne(b1) && this.routeExists(ctx, b1)) {
        for (let i = 0; i < saf.perStep && s.comms.radBacklog.length; i++) {
          const d = s.comms.radBacklog.shift()!;
          s.comms.radResent += 1;
          this.send(ctx, 'BEE-01', 'RAD_SAMPLE', d);
        }
      }
    }

    // deliveries
    if (s.comms.inFlight.length) {
      const still: number[] = [];
      for (const id of s.comms.inFlight) {
        const m = s.comms.messages[id - 1];
        if (m.tArrive !== null && m.tArrive <= s.time + 1e-9) this.deliver(ctx, m);
        else still.push(id);
      }
      s.comms.inFlight = still;
    }

    // link status per sender
    for (const id of SENDERS) {
      const since = this.airborneSince[id];
      if (since === null) continue;
      // Phase 3B: a bee docked again after recovery is not expected to transmit
      if (!isAirborne(s.bees.find((b) => b.id === id)!)) continue;
      const last = s.comms.gs.lastRxTime[id];
      const ref = last ?? since;
      const silent = s.time - ref;
      if (s.comms.linkUp[id] && silent > cfg.linkTimeout_s) {
        s.comms.linkUp[id] = false;
        ctx.log(id, 'LINK_LOST', `no delivery at ${cfg.groundStationId} for ${silent.toFixed(1)}s (route=${s.comms.lastRoute[id]})`);
      }
    }

    this.updateWarnings(ctx);
  }

  private deliver(ctx: SubsystemContext, m: CommMessage): void {
    const s = ctx.state;
    m.status = 'DELIVERED';
    m.tReceived = m.tArrive;
    m.stepReceived = s.step;
    m.latency_ms = ((m.tArrive as number) - m.tSent) * 1000;
    if (m.dst !== ctx.config.comms.groundStationId) {
      // downlink: hand to the drone's inbox (processed on board next step)
      (s.comms.inbox[m.dst] ??= []).push(m.id);
      return;
    }
    const gs = s.comms.gs;
    gs.delivered += 1;
    gs.lastRxTime[m.src] = m.tReceived;
    if (!s.comms.linkUp[m.src]) {
      s.comms.linkUp[m.src] = true;
      ctx.log(m.src, 'LINK_RESTORED', `delivery via ${m.route.join('>')} latency=${m.latency_ms.toFixed(0)}ms`);
    }
    const d = m.data;
    if (m.type === 'HEARTBEAT') {
      const prev = gs.beeReports[m.src];
      if (!prev || m.tSent >= prev.sampleTime) {
        const { x, y, z, mode, ...fields } = d;
        gs.beeReports[m.src] = { x: x as number, y: y as number, z: z as number, mode: String(mode), sampleTime: m.tSent, rxTime: m.tReceived as number, fields };
      }
      if (typeof d.task === 'string' && d.task !== '-') {
        gs.taskReports.push({ taskId: d.task, from: m.src, kind: 'HEARTBEAT', accepted: null, state: String(d.taskState), progress: Number(d.taskProgress), reason: null, sampleTime: m.tSent, rxTime: m.tReceived as number });
      }
    } else if (m.type === 'TASK_ACK' || m.type === 'TASK_STATUS') {
      gs.taskReports.push({
        taskId: String(d.task),
        from: m.src,
        kind: m.type === 'TASK_ACK' ? 'ACK' : 'STATUS',
        accepted: m.type === 'TASK_ACK' ? d.accepted === 1 : null,
        state: typeof d.state === 'string' ? d.state : null,
        progress: typeof d.progress === 'number' ? d.progress : null,
        reason: typeof d.reason === 'string' ? d.reason : null,
        sampleTime: m.tSent,
        rxTime: m.tReceived as number,
      });
    } else if (m.type === 'RAD_SAMPLE') {
      gs.radiationSamples.push({
        sampleId: d.sample as number,
        droneId: m.src,
        sampleTime: d.sampleTime as number,
        rxTime: m.tReceived as number,
        x: d.x as number,
        y: d.y as number,
        z: d.z as number,
        liveTime_s: d.liveTime as number,
        counts: d.counts as number,
        measured_uSv_h: d.measured as number,
      });
      if (!gs.radiation || (d.sampleTime as number) >= gs.radiation.sampleTime) {
        gs.radiation = {
          sampleId: d.sample as number,
          measured_uSv_h: d.measured as number,
          sampleTime: d.sampleTime as number,
          rxTime: m.tReceived as number,
        };
      }
    } else if (m.type === 'CASUALTY_ALERT' || m.type === 'CASUALTY_STATUS' || m.type === 'VITALS') {
      const prev = gs.casualty;
      const sampleTime = (d.sampleTime as number) ?? m.tSent;
      if (!prev || sampleTime >= prev.sampleTime) {
        gs.casualty = {
          status: (d.status as string) ?? prev?.status ?? 'DETECTED',
          risk: (d.risk as string) ?? prev?.risk ?? 'UNKNOWN',
          hr: typeof d.hr === 'number' ? d.hr : (prev?.hr ?? null),
          rr: typeof d.rr === 'number' ? d.rr : (prev?.rr ?? null),
          sampleTime,
          rxTime: m.tReceived as number,
        };
      }
      updatePatient(gs, m);
    }
  }

  private updateWarnings(ctx: SubsystemContext): void {
    const { state: s, config } = ctx;
    const cfg = config.comms;
    const prev = new Map(s.comms.warnings.map((w) => [`${w.code}|${w.nodeId}`, w]));
    const next: CommsWarning[] = [];
    const add = (code: CommsWarning['code'], nodeId: string, message: string) => {
      const key = `${code}|${nodeId}`;
      const old = prev.get(key);
      next.push({ code, nodeId, message, since: old ? old.since : s.time });
      const lastLog = this.warnLogged.get(key);
      if (!old && code !== 'LINK_LOST' && (lastLog === undefined || s.time - lastLog >= 10)) {
        this.warnLogged.set(key, s.time);
        ctx.log(nodeId, 'COMMS_WARNING', `${code}: ${message}`);
      }
    };

    for (const id of SENDERS) {
      if (this.airborneSince[id] !== null && !s.comms.linkUp[id] && isAirborne(s.bees.find((b) => b.id === id)!)) {
        const last = s.comms.gs.lastRxTime[id];
        add('LINK_LOST', id, `${id}: no packet at ground station for ${(s.time - (last ?? (this.airborneSince[id] as number))).toFixed(1)} s`);
      }
    }

    // rolling delivery ratio and latency over the last N decided messages
    const decided: CommMessage[] = [];
    for (let i = s.comms.messages.length - 1; i >= 0 && decided.length < cfg.pdrWindow; i--) {
      const m = s.comms.messages[i];
      if (m.status !== 'IN_FLIGHT') decided.push(m);
    }
    if (decided.length >= Math.min(10, cfg.pdrWindow)) {
      const ok = decided.filter((m) => m.status === 'DELIVERED');
      const pdr = ok.length / decided.length;
      if (pdr < cfg.pdrWarnBelow) add('PDR_LOW', 'NET', `delivery ratio ${(pdr * 100).toFixed(0)}% over last ${decided.length} messages`);
      if (ok.length) {
        const meanLat = ok.reduce((a, m) => a + (m.latency_ms as number), 0) / ok.length;
        if (meanLat > cfg.latencyWarnAbove_ms) add('LATENCY_HIGH', 'NET', `mean latency ${meanLat.toFixed(0)} ms`);
      }
    }

    // sensing drone out of direct range while the relay is not airborne
    const relay = s.bees.find((b) => b.id === cfg.relayId)!;
    for (const id of ['BEE-01', 'BEE-02'] as const) {
      if (this.airborneSince[id] !== null && s.comms.lastRoute[id] === 'none' && !isAirborne(relay)) {
        add('NO_RELAY', id, `${id} out of direct range and relay ${cfg.relayId} not airborne`);
      }
    }
    s.comms.warnings = next;
  }
}

/** Merge a delivered casualty packet into the GS patient list (out-of-order safe). */
function updatePatient(gs: GroundStationView, m: CommMessage): void {
  const d = m.data;
  const id = (d.patient as string) ?? 'UNKNOWN';
  const rx = m.tReceived as number;
  const sampleTime = (d.sampleTime as number) ?? m.tSent;
  let p = gs.patients.find((x) => x.patientId === id);
  if (!p) {
    p = {
      patientId: id,
      reportedBy: m.src,
      detectedAt: null,
      firstRxTime: rx,
      lastRxTime: rx,
      onboardStatus: 'DETECTED',
      statusTime: -1,
      location: null,
      vitalsHistory: [],
      latestVitals: null,
      temperatureHistory: [],
      latestTemperature: null,
      assessment: null,
    };
    gs.patients.push(p);
  }
  p.lastRxTime = Math.max(p.lastRxTime, rx);
  if (typeof d.detectedAt === 'number' && p.detectedAt === null) p.detectedAt = d.detectedAt;
  if (typeof d.status === 'string' && sampleTime >= p.statusTime) {
    p.onboardStatus = d.status;
    p.statusTime = sampleTime;
  }
  if (typeof d.estX === 'number' && typeof d.estZ === 'number' && (!p.location || sampleTime >= p.location.sampleTime)) {
    p.location = { x: d.estX, z: d.estZ, sigma_m: d.locSigma as number, sampleTime };
  }
  if (m.type === 'VITALS' && typeof d.hr === 'number' && typeof d.rr === 'number') {
    const h = p.vitalsHistory;
    const rec = { sampleId: d.sample as number, t: sampleTime, hr: d.hr, rr: d.rr, rxTime: rx };
    let i = h.length;
    while (i > 0 && h[i - 1].t > sampleTime) i--; // keep sample-time order even if packets arrive out of order
    h.splice(i, 0, rec);
    if (!p.latestVitals || sampleTime >= p.latestVitals.sampleTime) p.latestVitals = { hr: d.hr, rr: d.rr, sampleTime, rxTime: rx };
  }
  if (m.type === 'VITALS' && typeof d.skinTempC === 'number' && typeof d.tempTime === 'number') {
    const h = p.temperatureHistory;
    const tt = d.tempTime;
    const rec = { sampleId: d.tempSample as number, t: tt, skin_c: d.skinTempC, sigma_c: d.tempSigmaC as number, rxTime: rx };
    let i = h.length;
    while (i > 0 && h[i - 1].t > tt) i--;
    h.splice(i, 0, rec);
    if (!p.latestTemperature || tt >= p.latestTemperature.sampleTime)
      p.latestTemperature = { sampleId: rec.sampleId, skin_c: rec.skin_c, sigma_c: rec.sigma_c, sampleTime: tt, rxTime: rx, modality: String(d.tempModality ?? 'IR_SKIN') };
  }
  if (m.type === 'CASUALTY_STATUS' && typeof d.assessedAt === 'number' && typeof d.hr === 'number' && typeof d.rr === 'number') {
    if (!p.assessment || sampleTime >= p.assessment.sampleTime) {
      p.assessment = {
        hr: d.hr,
        rr: d.rr,
        hrScore: d.hrScore as number,
        rrScore: d.rrScore as number,
        total: d.total as number,
        risk: d.risk as string,
        riskRaw: typeof d.riskRaw === 'string' ? d.riskRaw : null,
        riskBorderline: typeof d.riskBorderline === 'number' ? d.riskBorderline === 1 : null,
        assessedAt: d.assessedAt,
        sampleTime,
        rxTime: rx,
      };
    }
  }
}

/** Summary statistics over a message log (used by run JSON, dashboard and tests). */
export function commsStats(messages: CommMessage[]) {
  const by = (st: MsgStatus) => messages.filter((m) => m.status === st).length;
  const delivered = messages.filter((m) => m.status === 'DELIVERED');
  const lat = delivered.map((m) => m.latency_ms as number).sort((a, b) => a - b);
  const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
  const decided = messages.length - by('IN_FLIGHT');
  return {
    sent: messages.length,
    delivered: delivered.length,
    droppedLink: by('DROPPED_LINK'),
    droppedNoRoute: by('DROPPED_NO_ROUTE'),
    inFlight: by('IN_FLIGHT'),
    deliveryRatio: decided ? delivered.length / decided : null,
    latencyMean_ms: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
    latencyP95_ms: q(0.95),
    latencyMax_ms: lat.length ? lat[lat.length - 1] : null,
    viaRelay: delivered.filter((m) => m.route.length === 3).length,
  };
}
