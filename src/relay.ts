/**
 * The host-authoritative relay (tech-spec §2 "small remote" tier, used for
 * local/LAN in v0). One `ws` server per session. The host process owns truth;
 * this relay:
 *
 *   - mirrors the host's output append-log and fans it out to every participant
 *     (channel 1: ordered, seq-numbered, snapshot+tail for late joiners),
 *   - relays presence/cursor deltas lossily (channel 2),
 *   - relays chat reliably and mediates agent-write through the WriteArbiter
 *     so there is never more than one driver (channel 3 + §4 arbitration),
 *   - tracks the participant roster,
 *   - gates all session egress through the @pooriaarab/vibe-core consent ledger
 *     (scope `share:session`) — starting a host session is the explicit grant,
 *     and it is revocable, and
 *   - emits normalized lifecycle milestones (e.g. `session-end`) on the
 *     vibe-core hook bus, so other suite tools can react without vibelive
 *     binding to any one agent's hook format.
 *
 * Full 1000-participant e2e-encrypted relay fan-out is a post-v0 concern; this
 * small tier is built to be correct and genuinely usable on a LAN.
 */
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createConsentLedger,
  createHookBus,
  type ConsentLedger,
  type HookBus,
} from '@pooriaarab/vibe-core';
import { WriteArbiter } from './arbitration.js';
import { OutputLog, type OutputEntry } from './output-log.js';
import {
  decodeClient,
  encode,
  type ClientMessage,
  type ParticipantWire,
  type ServerMessage,
} from './protocol.js';
import type { HostHandle } from './host.js';

/** The consent scope that gates fanning session output out to other machines. */
export const SHARE_SESSION_SCOPE = 'share:session';

/** A connected participant. `ws` is absent for local (host-user) participants. */
export interface Participant {
  readonly id: string;
  name: string;
  /** Has completed the `hello` handshake (eligible to receive fan-out). */
  named: boolean;
  readonly ws?: WebSocket;
}

export interface RelayOptions {
  /** Bind port; 0 (default) = ephemeral, picked by the OS. */
  readonly port?: number;
  /** Bind host. Default '0.0.0.0' so LAN peers can reach it. */
  readonly host?: string;
  /** Hostname used in the printed join URL. Default 'localhost'. */
  readonly urlHost?: string;
  /** A wired host whose output is fanned out and whose stdin receives driver input. */
  readonly hostHandle?: HostHandle;
  /** Consent ledger (defaults to an in-memory one with share:session granted). */
  readonly consent?: ConsentLedger;
  /** Hook bus the relay emits session lifecycle events on (defaults to in-memory). */
  readonly hooks?: HookBus;
  /** Seed the arbiter with an initial driver (e.g. the local host user 'host'). */
  readonly initialDriver?: string | null;
  /** Display name for a local host-user participant added to the roster. */
  readonly hostParticipantName?: string;
  /** Retained output-log capacity (per relay mirror). Default 5000. */
  readonly logCap?: number;
}

export interface RelayHandle {
  /** Actual bound port (after listen). */
  readonly port: number;
  /** ws:// URL printed for `vibelive join`. */
  readonly url: string;
  readonly consent: ConsentLedger;
  /** The hook bus session lifecycle events (e.g. session-end) are emitted on. */
  readonly hooks: HookBus;
  readonly arbiter: WriteArbiter;
  /** Current roster (local + remote participants). */
  readonly participants: readonly Participant[];
  /** Push a host-authored output entry to all clients (and retain it). */
  emitOutput(entry: OutputEntry): void;
  /** Append a locally-authored chunk (no wired host) and fan it out. */
  broadcastOutput(text: string): void;
  /** Local (non-ws) participant requests the write token. */
  localRequestControl(id: string): void;
  /** Local (non-ws) participant releases the write token. */
  localReleaseControl(id: string): void;
  /** Remove a local participant from the roster (and release if driving). */
  localLeave(id: string): void;
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

interface RelayRuntime {
  consent: ConsentLedger;
  hooks: HookBus;
  arbiter: WriteArbiter;
  log: OutputLog;
  participants: Map<string, Participant>;
  hostHandle: HostHandle | undefined;
  freshId: () => string;
  unsubscribeHost?: () => void;
}

interface ConnState {
  id: string;
  named: boolean;
  participant: Participant;
  ws: WebSocket;
}

function ensureShareConsent(existing: ConsentLedger | undefined): ConsentLedger {
  const consent = existing ?? createConsentLedger();
  if (!consent.allows(SHARE_SESSION_SCOPE)) {
    // Starting a host session is the explicit act of consenting to share it.
    consent.grant(SHARE_SESSION_SCOPE, 'vibelive host session');
  }
  return consent;
}

function seedParticipants(options: RelayOptions): Map<string, Participant> {
  const participants = new Map<string, Participant>();
  // If a local host-user is the initial driver, register them in the roster so
  // remote clients see them in presence and as the current driver.
  if (options.initialDriver) {
    participants.set(options.initialDriver, {
      id: options.initialDriver,
      name: options.hostParticipantName ?? options.initialDriver,
      named: true,
    });
  }
  return participants;
}

async function listenRelay(options: RelayOptions): Promise<{ wss: WebSocketServer; actualPort: number }> {
  const bindHost = options.host ?? '0.0.0.0';
  const port = options.port ?? 0;
  const wss = new WebSocketServer({ port, host: bindHost });
  await once(wss, 'listening');
  const address = wss.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { wss, actualPort };
}

function sendTo(ws: WebSocket | undefined, msg: ServerMessage): void {
  if (ws && ws.readyState === /* OPEN */ 1) {
    ws.send(encode(msg));
  }
}

function makeRelayIO(rt: RelayRuntime) {
  const rosterWire = (): ParticipantWire[] =>
    [...rt.participants.values()].map((p) => ({ id: p.id, name: p.name }));

  const broadcast = (msg: ServerMessage): void => {
    if (!rt.consent.allows(SHARE_SESSION_SCOPE)) return; // egress gate
    const data = encode(msg);
    for (const p of rt.participants.values()) {
      // Only fan out to participants past the hello handshake, so a client never
      // receives live output/chat before its initial snapshot.
      if (p.named && p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  };

  const sendPresence = (): void => {
    broadcast({
      kind: 'presence',
      participants: rosterWire(),
      driverId: rt.arbiter.driver(),
    });
  };

  const sendControlState = (): void => {
    const snap = rt.arbiter.snapshot();
    broadcast({ kind: 'control', action: 'state', driverId: snap.driverId, queue: snap.queue });
  };

  /** Run an arbiter mutation then notify everyone of the resulting control state. */
  const applyControl = (mutate: (a: WriteArbiter) => void): void => {
    mutate(rt.arbiter);
    sendControlState();
    sendPresence(); // driverId also rides on presence
  };

  const emitOutput = (entry: OutputEntry): void => {
    // Mirror the host-authored entry (idempotent on retry/dup); broadcast the
    // entry's own seq/text faithfully — the host is the sole author of seqs.
    rt.log.ingest(entry);
    broadcast({ kind: 'output', seq: entry.seq, text: entry.text });
  };

  const broadcastOutput = (text: string): void => {
    const entry = rt.log.append(text);
    broadcast({ kind: 'output', seq: entry.seq, text: entry.text });
  };

  const forwardInput = (fromId: string, text: string): boolean => {
    if (!rt.consent.allows(SHARE_SESSION_SCOPE)) return false;
    if (!rt.arbiter.isDriver(fromId)) return false;
    rt.hostHandle?.sendInput(text);
    return true;
  };

  return { rosterWire, broadcast, sendPresence, applyControl, emitOutput, broadcastOutput, forwardInput };
}

type RelayCtx = RelayRuntime & ReturnType<typeof makeRelayIO>;

function wireHostOutput(ctx: RelayCtx): void {
  const host = ctx.hostHandle;
  if (!host) return;
  ctx.unsubscribeHost = host.onOutput((entry) => ctx.emitOutput(entry));
  host.exited.then((code) => {
    // Normalized session-end milestone on the suite hook bus (core spec §3).
    ctx.hooks.emit({
      kind: 'session-end',
      agent: host.command[0] ?? 'vibelive',
      cwd: process.cwd(),
      payload: { code },
      ts: Date.now(),
    });
  });
}

function completeHello(conn: ConnState, ctx: RelayCtx, name: string): void {
  conn.participant.name = name || conn.id;
  conn.participant.named = true;
  conn.named = true;
  const snap = ctx.arbiter.snapshot();
  const since = ctx.log.since(0);
  sendTo(conn.ws, {
    kind: 'snapshot',
    you: conn.id,
    seq: since.seq,
    entries: since.entries,
    participants: ctx.rosterWire(),
    driverId: snap.driverId,
    queue: snap.queue,
  });
  ctx.sendPresence();
}

const CLIENT_HANDLERS: Record<string, (msg: ClientMessage, conn: ConnState, ctx: RelayCtx) => void> = {
  chat: (msg, conn, ctx) => {
    if (msg.kind !== 'chat') return;
    ctx.broadcast({ kind: 'chat', id: conn.id, name: conn.participant.name, text: msg.text, ts: Date.now() });
  },
  cursor: (msg, conn, ctx) => {
    if (msg.kind !== 'cursor') return;
    // Lossy/ephemeral: forward as-is. (v0 does not coalesce.)
    ctx.broadcast({ kind: 'cursor', id: conn.id, name: conn.participant.name, x: msg.x, y: msg.y });
  },
  control: (msg, conn, ctx) => {
    if (msg.kind !== 'control') return;
    if (msg.action === 'request') ctx.applyControl((a) => a.requestControl(conn.id));
    else ctx.applyControl((a) => a.release(conn.id));
  },
  input: (msg, conn, ctx) => {
    if (msg.kind !== 'input') return;
    const ok = ctx.forwardInput(conn.id, msg.text);
    if (!ok && !ctx.arbiter.isDriver(conn.id)) {
      sendTo(conn.ws, { kind: 'error', message: 'not the current driver — request control first' });
    }
  },
};

function onClientMessage(raw: { toString(): string }, conn: ConnState, ctx: RelayCtx): void {
  let msg: ReturnType<typeof decodeClient>;
  try {
    msg = decodeClient(raw.toString());
  } catch {
    return; // ignore malformed
  }

  // First message must be hello (sets the name); afterwards it's a no-op rename.
  if (msg.kind === 'hello') {
    completeHello(conn, ctx, msg.name);
    return;
  }

  if (!conn.named) {
    sendTo(conn.ws, { kind: 'error', message: 'expected hello first' });
    return;
  }

  if (!Object.hasOwn(CLIENT_HANDLERS, msg.kind)) return; // exhaustive guard; ignore unknown
  const handler = CLIENT_HANDLERS[msg.kind];
  if (handler === undefined) return;
  handler(msg, conn, ctx);
}

function onRelayConnection(ws: WebSocket, ctx: RelayCtx): void {
  // Pre-hello: we don't yet know the name. Assign an id up front so input
  // attribution is stable, then await the hello to set the name + catch up.
  const id = ctx.freshId();
  const participant: Participant = { id, name: id, named: false, ws };
  ctx.participants.set(id, participant);
  const conn: ConnState = { id, named: false, participant, ws };

  ws.on('message', (raw) => {
    onClientMessage(raw, conn, ctx);
  });

  const remove = (): void => {
    const existed = ctx.participants.delete(id);
    if (!existed) return;
    ctx.applyControl((a) => a.leave(id));
    ctx.sendPresence();
  };

  ws.on('close', remove);
  ws.on('error', () => remove());
}

function makeRelayHandle(ctx: RelayCtx, urlHost: string, actualPort: number, wss: WebSocketServer): RelayHandle {
  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    ctx.unsubscribeHost?.();
    for (const p of ctx.participants.values()) {
      // terminate (not close) — don't block shutdown on a close handshake that a
      // stuck or half-dead client may never answer.
      if (p.ws && p.ws.readyState === 1) p.ws.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    closedResolve();
  };

  return {
    get port() {
      return actualPort;
    },
    get url() {
      return `ws://${urlHost}:${actualPort}`;
    },
    consent: ctx.consent,
    hooks: ctx.hooks,
    arbiter: ctx.arbiter,
    get participants() {
      return [...ctx.participants.values()];
    },
    emitOutput: (entry) => ctx.emitOutput(entry),
    broadcastOutput: (text) => ctx.broadcastOutput(text),
    localRequestControl: (id) => ctx.applyControl((a) => a.requestControl(id)),
    localReleaseControl: (id) => ctx.applyControl((a) => a.release(id)),
    localLeave: (id) => {
      ctx.applyControl((a) => a.leave(id));
      ctx.participants.delete(id);
      ctx.sendPresence();
    },
    close,
    get closed() {
      return closedPromise;
    },
  };
}

export async function createRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const consent = ensureShareConsent(options.consent);
  const hooks = options.hooks ?? createHookBus();
  const arbiter = new WriteArbiter(options.initialDriver ?? null);
  const log = new OutputLog(options.logCap);
  // id = local host-user participant (no socket), plus remote ws participants.
  const participants = seedParticipants(options);
  let nextId = 1;
  const rt: RelayRuntime = {
    consent, hooks, arbiter, log, participants,
    hostHandle: options.hostHandle, freshId: () => `p${nextId++}`,
  };

  const { wss, actualPort } = await listenRelay(options);
  // Assign onto rt rather than spreading it: ctx and rt must stay the SAME object,
  // or a field reassigned through one (unsubscribeHost) would go stale in the other.
  const ctx: RelayCtx = Object.assign(rt, makeRelayIO(rt));
  wireHostOutput(ctx);
  wss.on('connection', (ws: WebSocket) => onRelayConnection(ws, ctx));
  return makeRelayHandle(ctx, options.urlHost ?? 'localhost', actualPort, wss);
}
