import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { createHost, type HostHandle } from './host.js';
import { createRelay, type RelayHandle } from './relay.js';
import { joinSession, type SessionClient, type ControlStateView } from './client.js';

/**
 * Full-stack end-to-end tests: a real wrapped child process, a real relay on an
 * ephemeral port, and real SessionClient connections over WebSocket. This is the
 * exact path `vibelive host` / `vibelive join` run, minus the terminal rendering.
 */

const NODE = process.execPath;
/** Wrapped "agent": announces itself, then echoes stdin back prefixed. */
const AGENT_SCRIPT =
  'console.log("agent-boot"); process.stdin.on("data", (d) => process.stdout.write("echo:" + d))';

let host: HostHandle | null = null;
let relay: RelayHandle | null = null;
const clients: SessionClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  if (relay) {
    await relay.close();
    relay = null;
  }
  host?.kill();
  host = null;
});

function withTimeout<T>(p: Promise<T>, ms = 5000, what = 'operation'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

async function startSession(): Promise<{ host: HostHandle; relay: RelayHandle }> {
  host = createHost({ command: [NODE, '-e', AGENT_SCRIPT] });
  relay = await createRelay({
    port: 0,
    hostHandle: host,
    initialDriver: 'host',
    hostParticipantName: 'host',
  });
  return { host, relay };
}

async function join(url: string, name: string): Promise<SessionClient> {
  const client = joinSession({ url, name });
  clients.push(client);
  await withTimeout(client.id, 5000, `join as ${name}`);
  return client;
}

/** Accumulate client output until it contains `needle`. */
function waitForOutput(client: SessionClient, needle: string, ms = 5000): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      let seen = '';
      client.onOutput((text) => {
        seen += text;
        if (seen.includes(needle)) resolve(seen);
      });
    }),
    ms,
    `client output containing ${JSON.stringify(needle)}`,
  );
}

/** Wait until the wrapped agent has printed `needle` (i.e. it is in the retained log). */
function waitForHostOutput(h: HostHandle, needle: string, ms = 5000): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      let seen = '';
      h.onOutput((e) => {
        seen += e.text;
        if (seen.includes(needle)) resolve();
      });
    }),
    ms,
    `host output containing ${JSON.stringify(needle)}`,
  );
}

function waitForControl(
  client: SessionClient,
  pred: (s: ControlStateView) => boolean,
  ms = 5000,
): Promise<ControlStateView> {
  return withTimeout(
    new Promise<ControlStateView>((resolve) => {
      client.onControl((s) => {
        if (pred(s)) resolve(s);
      });
    }),
    ms,
    'matching control state',
  );
}

function waitForError(client: SessionClient, re: RegExp, ms = 5000): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      client.onError((message) => {
        if (re.test(message)) resolve(message);
      });
    }),
    ms,
    `error matching ${re}`,
  );
}

describe('client e2e — snapshot, drive, type, chat', () => {
  it('a late joiner receives the retained output snapshot, then the live tail', async () => {
    const { host: h, relay: r } = await startSession();
    // The wrapped agent has booted and its banner is retained before anyone joins.
    await waitForHostOutput(h, 'agent-boot');

    // Register the listener BEFORE the snapshot lands (snapshot replay is
    // synchronous with the join handshake).
    const ada = joinSession({ url: r.url, name: 'ada' });
    clients.push(ada);
    const seen = waitForOutput(ada, 'agent-boot');
    await withTimeout(ada.id, 5000, 'join as ada');
    expect(await seen).toContain('agent-boot');
  });

  it('driver handoff: host releases, client takes the token and drives the agent', async () => {
    const { relay: r } = await startSession();
    const ada = await join(r.url, 'ada');
    const adaId = await ada.id;

    // Host gives up the token; ada requests it and becomes the driver.
    r.localReleaseControl('host');
    ada.requestControl();
    const state = await waitForControl(ada, (s) => s.driverId === adaId);
    expect(state.driverId).toBe(adaId);

    // The driver's bytes reach the wrapped agent's stdin; the echo comes back
    // to every connected client through the output channel.
    ada.sendInput('hello-agent\n');
    const seen = await waitForOutput(ada, 'echo:hello-agent');
    expect(seen).toContain('echo:hello-agent');
  });

  it('rejects agent input from a non-driver', async () => {
    const { relay: r } = await startSession(); // 'host' holds the token
    const ada = await join(r.url, 'ada');
    const err = waitForError(ada, /driver/i);
    ada.sendInput('rm -rf /\n');
    expect(await err).toMatch(/driver/i);
  });

  it('delivers chat between participants with attribution', async () => {
    const { relay: r } = await startSession();
    const ada = await join(r.url, 'ada');
    const bob = await join(r.url, 'bob');
    const incoming = withTimeout(
      new Promise<string>((resolve) => {
        bob.onChat((m) => {
          if (m.name === 'ada') resolve(m.text);
        });
      }),
      5000,
      'chat from ada',
    );
    ada.sendChat('hi bob');
    expect(await incoming).toBe('hi bob');
  });

  it('exposes the host participant and driver in presence', async () => {
    const { relay: r } = await startSession();
    // The initial control state rides on the snapshot, so listen before joining.
    const ada = joinSession({ url: r.url, name: 'ada' });
    clients.push(ada);
    const state = waitForControl(ada, (s) => s.driverId === 'host');
    await withTimeout(ada.id, 5000, 'join as ada');
    expect((await state).driverId).toBe('host');
  });
});

describe('client e2e — connection failures settle instead of hanging', () => {
  it('connection refused: id rejects, closed resolves', async () => {
    // Grab a port that is guaranteed closed right now (open then shut a server).
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', r));
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise<void>((r) => wss.close(() => r()));

    const client = joinSession({ url: `ws://127.0.0.1:${port}`, name: 'ghost' });
    clients.push(client);
    await expect(client.id).rejects.toThrow(/closed before/);
    await withTimeout(client.closed, 5000, 'closed');
  });

  it('handshake timeout: server that never sends a snapshot fails loudly', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', r));
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    // Never speaks — the client's handshake timer must fire.
    wss.on('connection', () => {});

    const client = joinSession({ url: `ws://127.0.0.1:${port}`, name: 'impatient', timeoutMs: 200 });
    clients.push(client);
    const err = waitForError(client, /timed out/, 5000);
    await expect(client.id).rejects.toThrow(/timed out/);
    expect(await err).toMatch(/timed out/);
    await withTimeout(client.closed, 5000, 'closed after timeout');
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
