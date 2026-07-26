/**
 * The client side of a vibelive session: opens a WebSocket to a relay, receives
 * snapshot+tail of the output channel, sends chat/cursor, and can request the
 * write token to drive the shared agent. Non-drivers can always read/chat/cursor.
 *
 * This is the library client; the `vibelive join` CLI (src/cli.ts) renders it.
 */
import { WebSocket } from 'ws';
import {
  encode,
  decodeServer,
  type ClientMessage,
  type ServerMessage,
  type ParticipantWire,
} from './protocol.js';

export interface SessionClientOptions {
  /** ws:// or wss:// URL of the relay (printed by `vibelive host`). */
  readonly url: string;
  /** Display name for this participant. */
  readonly name: string;
  /** Open timeout in ms (default 10s). */
  readonly timeoutMs?: number;
}

export interface ControlStateView {
  readonly driverId: string | null;
  readonly queue: readonly string[];
}

export interface ChatMessage {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly ts: number;
}

export interface CursorUpdate {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export interface SessionClient {
  readonly url: string;
  readonly name: string;
  /** Resolves to this client's server-assigned id (once the snapshot lands). */
  readonly id: Promise<string>;
  onSnapshot(cb: (seq: number) => void): () => void;
  onOutput(cb: (text: string, seq: number) => void): () => void;
  onPresence(cb: (participants: readonly ParticipantWire[], driverId: string | null) => void): () => void;
  onChat(cb: (msg: ChatMessage) => void): () => void;
  onControl(cb: (state: ControlStateView) => void): () => void;
  onCursor(cb: (c: CursorUpdate) => void): () => void;
  onError(cb: (message: string) => void): () => void;
  onClose(cb: () => void): () => void;
  /** Send a chat line (channel 3, reliable/ordered — always allowed). */
  sendChat(text: string): void;
  /** Send a cursor delta (channel 2, ephemeral/lossy). */
  sendCursor(x: number, y: number): void;
  /** Ask the arbiter for the write token (queued FIFO). */
  requestControl(): void;
  /** Relinquish the token if held. */
  releaseControl(): void;
  /**
   * Send agent input. Only the current driver's bytes reach the wrapped agent;
   * the relay rejects input from non-drivers with an `error` message.
   */
  sendInput(text: string): void;
  close(code?: number, reason?: string): void;
  readonly closed: Promise<void>;
}

type Cb<T> = (value: T) => void;

export function joinSession(options: SessionClientOptions): SessionClient {
  const ws = new WebSocket(options.url);
  const snapshotCbs = new Set<Cb<number>>();
  const outputCbs = new Set<Cb<{ text: string; seq: number }>>();
  const presenceCbs = new Set<Cb<{ participants: readonly ParticipantWire[]; driverId: string | null }>>();
  const chatCbs = new Set<Cb<ChatMessage>>();
  const controlCbs = new Set<Cb<ControlStateView>>();
  const cursorCbs = new Set<Cb<CursorUpdate>>();
  const errorCbs = new Set<Cb<string>>();
  const closeCbs = new Set<Cb<void>>();

  let idResolve!: (id: string) => void;
  const idPromise = new Promise<string>((resolve) => {
    idResolve = resolve;
  });
  let idResolved = false;

  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const send = (msg: ClientMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encode(msg));
    }
  };

  ws.on('open', () => {
    send({ kind: 'hello', name: options.name });
  });

  ws.on('message', (raw) => {
    let msg: ServerMessage;
    try {
      msg = decodeServer(raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    switch (msg.kind) {
      case 'snapshot': {
        if (!idResolved) {
          idResolved = true;
          idResolve(msg.you);
        }
        for (const e of msg.entries) outputCbs.forEach((cb) => cb({ text: e.text, seq: e.seq }));
        snapshotCbs.forEach((cb) => cb(msg.seq));
        presenceCbs.forEach((cb) => cb({ participants: msg.participants, driverId: msg.driverId }));
        controlCbs.forEach((cb) => cb({ driverId: msg.driverId, queue: msg.queue }));
        break;
      }
      case 'output':
        outputCbs.forEach((cb) => cb({ text: msg.text, seq: msg.seq }));
        break;
      case 'presence':
        presenceCbs.forEach((cb) => cb({ participants: msg.participants, driverId: msg.driverId }));
        break;
      case 'chat':
        chatCbs.forEach((cb) => cb({ id: msg.id, name: msg.name, text: msg.text, ts: msg.ts }));
        break;
      case 'control':
        controlCbs.forEach((cb) => cb({ driverId: msg.driverId, queue: msg.queue }));
        break;
      case 'cursor':
        cursorCbs.forEach((cb) => cb({ id: msg.id, name: msg.name, x: msg.x, y: msg.y }));
        break;
      case 'error':
        errorCbs.forEach((cb) => cb(msg.message));
        break;
    }
  });

  ws.on('error', (err) => {
    errorCbs.forEach((cb) => cb(err.message));
  });

  ws.on('close', () => {
    closeCbs.forEach((cb) => cb());
    closedResolve();
  });

  const sub = <T>(set: Set<Cb<T>>, cb: Cb<T>): (() => void) => {
    set.add(cb);
    return () => set.delete(cb);
  };

  return {
    url: options.url,
    name: options.name,
    id: idPromise,
    onSnapshot: (cb) => sub(snapshotCbs, cb),
    onOutput: (cb) => sub(outputCbs, (v) => cb(v.text, v.seq)),
    onPresence: (cb) => sub(presenceCbs, (v) => cb(v.participants, v.driverId)),
    onChat: (cb) => sub(chatCbs, cb),
    onControl: (cb) => sub(controlCbs, cb),
    onCursor: (cb) => sub(cursorCbs, cb),
    onError: (cb) => sub(errorCbs, cb),
    onClose: (cb) => sub(closeCbs, cb),
    sendChat: (text) => send({ kind: 'chat', text }),
    sendCursor: (x, y) => send({ kind: 'cursor', x, y }),
    requestControl: () => send({ kind: 'control', action: 'request' }),
    releaseControl: () => send({ kind: 'control', action: 'release' }),
    sendInput: (text) => send({ kind: 'input', text }),
    close: (code, reason) => ws.close(code, reason),
    closed: closedPromise,
  };
}
