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
  /** Handshake timeout in ms — fail if no snapshot arrives in time (default 10s). */
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
  /**
   * Resolves to this client's server-assigned id (once the snapshot lands).
   * Rejects if the connection closes or the handshake times out first.
   */
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

function sub<T>(set: Set<Cb<T>>, cb: Cb<T>): () => void {
  set.add(cb);
  return () => set.delete(cb);
}

function createJoinState(options: SessionClientOptions, ws: WebSocket) {
  const snapshotCbs = new Set<Cb<number>>();
  const outputCbs = new Set<Cb<{ text: string; seq: number }>>();
  const presenceCbs = new Set<Cb<{ participants: readonly ParticipantWire[]; driverId: string | null }>>();
  const chatCbs = new Set<Cb<ChatMessage>>();
  const controlCbs = new Set<Cb<ControlStateView>>();
  const cursorCbs = new Set<Cb<CursorUpdate>>();
  const errorCbs = new Set<Cb<string>>();
  const closeCbs = new Set<Cb<void>>();

  let idResolve!: (id: string) => void;
  let idReject!: (err: Error) => void;
  const idPromise = new Promise<string>((resolve, reject) => {
    idResolve = resolve;
    idReject = reject;
  });
  // Consumers that never await `id` must not trip Node's unhandled-rejection
  // warnings when a connection fails; awaiting consumers still see the rejection.
  idPromise.catch(() => {});

  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const state = {
    snapshotCbs,
    outputCbs,
    presenceCbs,
    chatCbs,
    controlCbs,
    cursorCbs,
    errorCbs,
    closeCbs,
    idResolve,
    idReject,
    idPromise,
    idResolved: false,
    closedResolve,
    closedPromise,
  };

  // Handshake timeout: the session is usable once the relay's snapshot assigns
  // our id. If that hasn't happened within timeoutMs, fail loudly and hang up.
  const timeoutMs = options.timeoutMs ?? 10_000;
  const handshakeTimer = setTimeout(() => {
    if (state.idResolved) return;
    errorCbs.forEach((cb) => cb(`timed out connecting to ${options.url} after ${timeoutMs}ms`));
    idReject(new Error(`vibelive: handshake timed out after ${timeoutMs}ms`));
    ws.terminate();
  }, timeoutMs);

  return Object.assign(state, { handshakeTimer });
}

type JoinState = ReturnType<typeof createJoinState>;

function handleSnapshot(msg: Extract<ServerMessage, { kind: 'snapshot' }>, state: JoinState): void {
  if (!state.idResolved) {
    state.idResolved = true;
    clearTimeout(state.handshakeTimer);
    state.idResolve(msg.you);
  }
  for (const e of msg.entries) state.outputCbs.forEach((cb) => cb({ text: e.text, seq: e.seq }));
  state.snapshotCbs.forEach((cb) => cb(msg.seq));
  state.presenceCbs.forEach((cb) => cb({ participants: msg.participants, driverId: msg.driverId }));
  state.controlCbs.forEach((cb) => cb({ driverId: msg.driverId, queue: msg.queue }));
}

const SERVER_HANDLERS: Record<string, (msg: ServerMessage, state: JoinState) => void> = {
  snapshot: (msg, state) => {
    if (msg.kind !== 'snapshot') return;
    handleSnapshot(msg, state);
  },
  output: (msg, state) => {
    if (msg.kind !== 'output') return;
    state.outputCbs.forEach((cb) => cb({ text: msg.text, seq: msg.seq }));
  },
  presence: (msg, state) => {
    if (msg.kind !== 'presence') return;
    state.presenceCbs.forEach((cb) => cb({ participants: msg.participants, driverId: msg.driverId }));
  },
  chat: (msg, state) => {
    if (msg.kind !== 'chat') return;
    state.chatCbs.forEach((cb) => cb({ id: msg.id, name: msg.name, text: msg.text, ts: msg.ts }));
  },
  control: (msg, state) => {
    if (msg.kind !== 'control') return;
    state.controlCbs.forEach((cb) => cb({ driverId: msg.driverId, queue: msg.queue }));
  },
  cursor: (msg, state) => {
    if (msg.kind !== 'cursor') return;
    state.cursorCbs.forEach((cb) => cb({ id: msg.id, name: msg.name, x: msg.x, y: msg.y }));
  },
  error: (msg, state) => {
    if (msg.kind !== 'error') return;
    state.errorCbs.forEach((cb) => cb(msg.message));
  },
};

function handleServerFrame(raw: { toString(): string }, state: JoinState): void {
  let msg: ServerMessage;
  try {
    msg = decodeServer(raw.toString());
  } catch {
    return; // ignore malformed frames
  }
  if (!Object.hasOwn(SERVER_HANDLERS, msg.kind)) return;
  const handler = SERVER_HANDLERS[msg.kind];
  if (handler === undefined) return;
  handler(msg, state);
}

function handleJoinClose(state: JoinState, url: string): void {
  clearTimeout(state.handshakeTimer);
  if (!state.idResolved) {
    state.idResolved = true;
    state.idReject(new Error(`vibelive: connection to ${url} closed before the session snapshot arrived`));
  }
  state.closeCbs.forEach((cb) => cb());
  state.closedResolve();
}

function attachJoinSocket(
  ws: WebSocket,
  options: SessionClientOptions,
  state: JoinState,
  send: (msg: ClientMessage) => void,
): void {
  ws.on('open', () => {
    send({ kind: 'hello', name: options.name });
  });

  ws.on('message', (raw) => {
    handleServerFrame(raw, state);
  });

  ws.on('error', (err) => {
    state.errorCbs.forEach((cb) => cb(err.message));
  });

  ws.on('close', () => {
    handleJoinClose(state, options.url);
  });
}

function makeSessionClient(
  options: SessionClientOptions,
  ws: WebSocket,
  state: JoinState,
  send: (msg: ClientMessage) => void,
): SessionClient {
  return {
    url: options.url,
    name: options.name,
    id: state.idPromise,
    onSnapshot: (cb) => sub(state.snapshotCbs, cb),
    onOutput: (cb) => sub(state.outputCbs, (v) => cb(v.text, v.seq)),
    onPresence: (cb) => sub(state.presenceCbs, (v) => cb(v.participants, v.driverId)),
    onChat: (cb) => sub(state.chatCbs, cb),
    onControl: (cb) => sub(state.controlCbs, cb),
    onCursor: (cb) => sub(state.cursorCbs, cb),
    onError: (cb) => sub(state.errorCbs, cb),
    onClose: (cb) => sub(state.closeCbs, cb),
    sendChat: (text) => send({ kind: 'chat', text }),
    sendCursor: (x, y) => send({ kind: 'cursor', x, y }),
    requestControl: () => send({ kind: 'control', action: 'request' }),
    releaseControl: () => send({ kind: 'control', action: 'release' }),
    sendInput: (text) => send({ kind: 'input', text }),
    close: (code, reason) => ws.close(code, reason),
    closed: state.closedPromise,
  };
}

export function joinSession(options: SessionClientOptions): SessionClient {
  const ws = new WebSocket(options.url);
  const state = createJoinState(options, ws);

  const send = (msg: ClientMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encode(msg));
    }
  };

  attachJoinSocket(ws, options, state, send);
  return makeSessionClient(options, ws, state, send);
}
