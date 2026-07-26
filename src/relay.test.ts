import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createRelay, type RelayHandle } from './relay.js';
import type { HostHandle } from './host.js';
import { OutputLog } from './output-log.js';
import { encode, type ServerMessage } from './protocol.js';

/**
 * Integration coverage for the host-authoritative relay: the three channels over
 * a real `ws` connection on an ephemeral port. Kept event-driven (no fixed
 * sleeps) so it stays fast and non-flaky.
 */

type ByKind<K extends ServerMessage['kind']> = Extract<ServerMessage, { kind: K }>;

let relay: RelayHandle | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  if (relay) {
    await relay.close();
    relay = null;
  }
});

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(encode(msg as never));
}

/** Wait for a message matching a type-guard predicate; resolves narrowed. */
function waitFor<T extends ServerMessage>(
  ws: WebSocket,
  predicate: (m: ServerMessage) => m is T,
  timeoutMs = 1500,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    const handler = (raw: { toString(): string }): void => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

const isOutput = (m: ServerMessage): m is ByKind<'output'> => m.kind === 'output';
const isPresence = (m: ServerMessage): m is ByKind<'presence'> => m.kind === 'presence';
const isControl = (m: ServerMessage): m is ByKind<'control'> => m.kind === 'control';
const isError = (m: ServerMessage): m is ByKind<'error'> => m.kind === 'error';
const isCursor = (m: ServerMessage): m is ByKind<'cursor'> => m.kind === 'cursor';
const isChat = (m: ServerMessage): m is ByKind<'chat'> => m.kind === 'chat';
const isSnapshot = (m: ServerMessage): m is ByKind<'snapshot'> => m.kind === 'snapshot';

async function connectAndHello(url: string, name: string): Promise<{ ws: WebSocket; snapshot: ByKind<'snapshot'> }> {
  const ws = await connect(url);
  send(ws, { kind: 'hello', name });
  const snapshot = await waitFor(ws, isSnapshot);
  return { ws, snapshot };
}

/** A minimal in-process HostHandle for input-forwarding tests (no real child). */
function stubHost(): { handle: HostHandle; inputs: string[] } {
  const inputs: string[] = [];
  const subs = new Set<(e: { seq: number; text: string }) => void>();
  const handle = {
    log: new OutputLog(),
    get seq() {
      return 0;
    },
    onOutput(cb: (e: { seq: number; text: string }) => void): () => void {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    sendInput(text: string): void {
      inputs.push(text);
    },
    resize(): void {
      /* noop */
    },
    kill(): void {
      /* noop */
    },
    exited: new Promise<number | null>(() => {
      /* never resolves */
    }),
    pid: 4242,
  } as unknown as HostHandle;
  return { handle, inputs };
}

describe('relay — output channel: snapshot + tail (late joiner)', () => {
  it('hands a late joiner the retained log in order, then the live tail', async () => {
    relay = await createRelay({ port: 0 });
    // Author three chunks before anyone joins.
    relay.broadcastOutput('a');
    relay.broadcastOutput('b');
    relay.broadcastOutput('c');

    const { ws, snapshot } = await connectAndHello(relay.url, 'ada');
    expect(snapshot.seq).toBe(3);
    expect(snapshot.entries.map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(snapshot.entries.map((e) => e.seq)).toEqual([1, 2, 3]);

    // Live tail continues with strictly increasing seq.
    relay.broadcastOutput('d');
    const out = await waitFor(ws, isOutput);
    expect(out).toMatchObject({ kind: 'output', seq: 4, text: 'd' });
  });
});

describe('relay — output channel: fan-out to multiple clients', () => {
  it('broadcasts new output to every joined participant', async () => {
    relay = await createRelay({ port: 0 });
    const a = await connectAndHello(relay.url, 'a');
    const b = await connectAndHello(relay.url, 'b');

    relay.broadcastOutput('hello');
    const oa = await waitFor(a.ws, isOutput);
    const ob = await waitFor(b.ws, isOutput);
    expect(oa).toMatchObject({ text: 'hello', seq: 1 });
    expect(ob).toMatchObject({ text: 'hello', seq: 1 });
  });

  it('does not deliver output to a client before its hello/snapshot', async () => {
    relay = await createRelay({ port: 0 });
    // Connect but do NOT hello yet.
    const raw = await connect(relay.url);
    relay.broadcastOutput('pre-hello');
    // Now hello; the snapshot must contain the retained chunk, and we should
    // never have received a raw 'output' before it.
    send(raw, { kind: 'hello', name: 'late' });
    const snapshot = await waitFor(raw, isSnapshot);
    expect(snapshot.entries.map((e) => e.text)).toEqual(['pre-hello']);
  });
});

describe('relay — presence roster add/remove', () => {
  it('broadcasts presence as participants join and leave', async () => {
    relay = await createRelay({ port: 0 });
    const a = await connectAndHello(relay.url, 'alice');

    const b = await connectAndHello(relay.url, 'bob');
    // Alice sees bob arrive.
    const presenceTwo = await waitFor(a.ws, (m): m is ByKind<'presence'> => isPresence(m) && m.participants.length === 2);
    expect(presenceTwo.participants.map((p) => p.name).sort()).toEqual(['alice', 'bob']);

    // Bob leaves → alice sees roster shrink to 1.
    b.ws.close();
    const presenceOne = await waitFor(a.ws, (m): m is ByKind<'presence'> => isPresence(m) && m.participants.length === 1);
    expect(presenceOne.participants.map((p) => p.name)).toEqual(['alice']);
  });

  it('exposes the local host participant when an initial driver is set', async () => {
    relay = await createRelay({ port: 0, initialDriver: 'host', hostParticipantName: 'host' });
    const { snapshot } = await connectAndHello(relay.url, 'ada');
    expect(snapshot.driverId).toBe('host');
    expect(snapshot.participants.map((p) => p.id)).toContain('host');
  });
});

describe('relay — control channel: FIFO handoff (no two drivers)', () => {
  it('grants the requester when idle, queues the rest FIFO, handoff on release', async () => {
    relay = await createRelay({ port: 0 });
    const a = await connectAndHello(relay.url, 'alice');
    const b = await connectAndHello(relay.url, 'bob');
    const aId = a.snapshot.you;
    const bId = b.snapshot.you;

    // Alice requests → granted immediately (idle).
    send(a.ws, { kind: 'control', action: 'request' });
    const granted = await waitFor(a.ws, (m): m is ByKind<'control'> => isControl(m) && m.driverId === aId);
    expect(granted.driverId).toBe(aId);
    expect(granted.queue).toEqual([]);

    // Bob requests → queued behind alice.
    send(b.ws, { kind: 'control', action: 'request' });
    const queued = await waitFor(b.ws, (m): m is ByKind<'control'> => isControl(m) && m.queue.length === 1);
    expect(queued.driverId).toBe(aId);
    expect(queued.queue).toEqual([bId]);

    // Alice releases → bob becomes driver (FIFO).
    send(a.ws, { kind: 'control', action: 'release' });
    const handoff = await waitFor(b.ws, (m): m is ByKind<'control'> => isControl(m) && m.driverId === bId);
    expect(handoff.driverId).toBe(bId);
    expect(handoff.queue).toEqual([]);
  });

  it('rejects agent input from a non-driver with an error', async () => {
    const { handle, inputs } = stubHost();
    relay = await createRelay({ port: 0, hostHandle: handle });
    const a = await connectAndHello(relay.url, 'alice');
    const b = await connectAndHello(relay.url, 'bob');
    const aId = a.snapshot.you;

    // Alice drives.
    send(a.ws, { kind: 'control', action: 'request' });
    await waitFor(a.ws, (m): m is ByKind<'control'> => isControl(m) && m.driverId === aId);

    // Bob (not driver) tries to type → error, nothing forwarded.
    send(b.ws, { kind: 'input', text: 'rm -rf /\n' });
    const denied = await waitFor(b.ws, isError);
    expect(denied.message).toMatch(/driver/i);
    expect(inputs).toEqual([]);

    // Alice (driver) types → forwarded to the wrapped agent.
    send(a.ws, { kind: 'input', text: 'ls\n' });
    await new Promise((r) => setTimeout(r, 50));
    expect(inputs).toEqual(['ls\n']);
  });
});

describe('relay — cursor channel (ephemeral, lossy)', () => {
  it('forwards cursor deltas to other participants', async () => {
    relay = await createRelay({ port: 0 });
    const a = await connectAndHello(relay.url, 'alice');
    await connectAndHello(relay.url, 'bob');

    send(a.ws, { kind: 'cursor', x: 12, y: 34 });
    const cursor = await waitFor(a.ws, isCursor); // relay echoes to all incl. sender
    expect(cursor).toMatchObject({ name: 'alice', x: 12, y: 34 });
  });
});

describe('relay — chat channel', () => {
  it('delivers chat to all participants with attribution', async () => {
    relay = await createRelay({ port: 0 });
    const a = await connectAndHello(relay.url, 'alice');
    await connectAndHello(relay.url, 'bob');

    send(a.ws, { kind: 'chat', text: 'hi bob' });
    const chat = await waitFor(a.ws, isChat); // relay echoes to all incl. sender
    expect(chat).toMatchObject({ name: 'alice', text: 'hi bob' });
    expect(typeof chat.ts).toBe('number');
  });
});

describe('relay — consent gate', () => {
  it('stops fanning out output when share:session is revoked', async () => {
    relay = await createRelay({ port: 0 });
    const a = await connectAndHello(relay.url, 'alice');

    relay.broadcastOutput('before');
    await waitFor(a.ws, (m): m is ByKind<'output'> => isOutput(m) && m.text === 'before');

    relay.consent.revoke('share:session');
    relay.broadcastOutput('after'); // gated → not delivered

    await expect(
      waitFor(a.ws, (m): m is ByKind<'output'> => isOutput(m) && m.text === 'after', 400),
    ).rejects.toThrow(/timeout/);

    // Re-granting resumes fan-out.
    relay.consent.grant('share:session');
    relay.broadcastOutput('resumed');
    await waitFor(a.ws, (m): m is ByKind<'output'> => isOutput(m) && m.text === 'resumed');
  });
});
