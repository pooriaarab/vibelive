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

export async function createRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const bindHost = options.host ?? '0.0.0.0';
  const urlHost = options.urlHost ?? 'localhost';
  const port = options.port ?? 0;

  const consent = options.consent ?? createConsentLedger();
  if (!consent.allows(SHARE_SESSION_SCOPE)) {
    // Starting a host session is the explicit act of consenting to share it.
    consent.grant(SHARE_SESSION_SCOPE, 'vibelive host session');
  }
  const hooks = options.hooks ?? createHookBus();

  const arbiter = new WriteArbiter(options.initialDriver ?? null);
  const log = new OutputLog(options.logCap);

  // id = local host-user participant (no socket), plus remote ws participants.
  const participants = new Map<string, Participant>();
  let nextId = 1;
  const freshId = (): string => `p${nextId++}`;

  // If a local host-user is the initial driver, register them in the roster so
  // remote clients see them in presence and as the current driver.
  if (options.initialDriver) {
    participants.set(options.initialDriver, {
      id: options.initialDriver,
      name: options.hostParticipantName ?? options.initialDriver,
      named: true,
    });
  }

  const wss = new WebSocketServer({ port, host: bindHost });
  await once(wss, 'listening');
  const address = wss.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  const rosterWire = (): ParticipantWire[] =>
    [...participants.values()].map((p) => ({ id: p.id, name: p.name }));

  const sendTo = (ws: WebSocket | undefined, msg: ServerMessage): void => {
    if (ws && ws.readyState === /* OPEN */ 1) {
      ws.send(encode(msg));
    }
  };

  const broadcast = (msg: ServerMessage): void => {
    if (!consent.allows(SHARE_SESSION_SCOPE)) return; // egress gate
    const data = encode(msg);
    for (const p of participants.values()) {
      // Only fan out to participants past the hello handshake, so a client never
      // receives live output/chat before its initial snapshot.
      if (p.named && p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  };

  const sendPresence = (): void => {
    broadcast({
      kind: 'presence',
      participants: rosterWire(),
      driverId: arbiter.driver(),
    });
  };

  const sendControlState = (): void => {
    const snap = arbiter.snapshot();
    broadcast({ kind: 'control', action: 'state', driverId: snap.driverId, queue: snap.queue });
  };

  /** Run an arbiter mutation then notify everyone of the resulting control state. */
  const applyControl = (mutate: (a: WriteArbiter) => void): void => {
    mutate(arbiter);
    sendControlState();
    sendPresence(); // driverId also rides on presence
  };

  // ---- output fan-in ----
  const emitOutput = (entry: OutputEntry): void => {
    // Mirror the host-authored entry (idempotent on retry/dup); broadcast the
    // entry's own seq/text faithfully — the host is the sole author of seqs.
    log.ingest(entry);
    broadcast({ kind: 'output', seq: entry.seq, text: entry.text });
  };

  const broadcastOutput = (text: string): void => {
    const entry = log.append(text);
    broadcast({ kind: 'output', seq: entry.seq, text: entry.text });
  };

  // ---- wire host if provided ----
  let unsubscribeHost: (() => void) | undefined;
  if (options.hostHandle) {
    const host = options.hostHandle;
    unsubscribeHost = host.onOutput((entry) => emitOutput(entry));
    host.exited.then((code) => {
      // Normalized session-end milestone on the suite hook bus (core spec §3).
      hooks.emit({
        kind: 'session-end',
        agent: host.command[0] ?? 'vibelive',
        cwd: process.cwd(),
        payload: { code },
        ts: Date.now(),
      });
    });
  }

  /** Forward driver input to the wrapped agent (consent- and driver-gated). */
  const forwardInput = (fromId: string, text: string): boolean => {
    if (!consent.allows(SHARE_SESSION_SCOPE)) return false;
    if (!arbiter.isDriver(fromId)) return false;
    options.hostHandle?.sendInput(text);
    return true;
  };

  // ---- connection lifecycle ----
  wss.on('connection', (ws: WebSocket) => {
    // Pre-hello: we don't yet know the name. Assign an id up front so input
    // attribution is stable, then await the hello to set the name + catch up.
    const id = freshId();
    let named = false;
    const participant: Participant = { id, name: id, named: false, ws };
    participants.set(id, participant);

    const handshakeError = (message: string): void => {
      sendTo(ws, { kind: 'error', message });
    };

    ws.on('message', (raw) => {
      let msg: ReturnType<typeof decodeClient>;
      try {
        msg = decodeClient(raw.toString());
      } catch {
        return; // ignore malformed
      }

      // First message must be hello (sets the name); afterwards it's a no-op rename.
      if (msg.kind === 'hello') {
        participant.name = msg.name || id;
        participant.named = true;
        named = true;
        const snap = arbiter.snapshot();
        const since = log.since(0);
        sendTo(ws, {
          kind: 'snapshot',
          you: id,
          seq: since.seq,
          entries: since.entries,
          participants: rosterWire(),
          driverId: snap.driverId,
          queue: snap.queue,
        });
        sendPresence();
        return;
      }

      if (!named) {
        handshakeError('expected hello first');
        return;
      }

      switch (msg.kind) {
        case 'chat':
          broadcast({
            kind: 'chat',
            id,
            name: participant.name,
            text: msg.text,
            ts: Date.now(),
          });
          break;
        case 'cursor':
          // Lossy/ephemeral: forward as-is. (v0 does not coalesce.)
          broadcast({ kind: 'cursor', id, name: participant.name, x: msg.x, y: msg.y });
          break;
        case 'control':
          if (msg.action === 'request') applyControl((a) => a.requestControl(id));
          else applyControl((a) => a.release(id));
          break;
        case 'input': {
          const ok = forwardInput(id, msg.text);
          if (!ok && !arbiter.isDriver(id)) {
            handshakeError('not the current driver — request control first');
          }
          break;
        }
        default:
          // exhaustive guard; ignore unknown
          break;
      }
    });

    const remove = (): void => {
      const existed = participants.delete(id);
      if (!existed) return;
      applyControl((a) => a.leave(id));
      sendPresence();
    };

    ws.on('close', remove);
    ws.on('error', () => remove());
  });

  // ---- local (non-ws) participant API ----
  const localRequestControl = (id: string): void => applyControl((a) => a.requestControl(id));
  const localReleaseControl = (id: string): void => applyControl((a) => a.release(id));
  const localLeave = (id: string): void => {
    applyControl((a) => a.leave(id));
    participants.delete(id);
    sendPresence();
  };

  // ---- shutdown ----
  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    unsubscribeHost?.();
    for (const p of participants.values()) {
      // terminate (not close) — don't block shutdown on a close handshake that a
      // stuck or half-dead client may never answer.
      if (p.ws && p.ws.readyState === 1) p.ws.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    closedResolve();
  };

  const handle: RelayHandle = {
    get port() {
      return actualPort;
    },
    get url() {
      return `ws://${urlHost}:${actualPort}`;
    },
    consent,
    hooks,
    arbiter,
    get participants() {
      return [...participants.values()];
    },
    emitOutput,
    broadcastOutput,
    localRequestControl,
    localReleaseControl,
    localLeave,
    close,
    get closed() {
      return closedPromise;
    },
  };
  return handle;
}
