import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpServerBundle } from './mcp.js';
import { joinSession, type SessionClient } from './client.js';

/**
 * MCP tests run the real server against the SDK's in-memory transport — the same
 * code path as `vibelive mcp` over stdio — and then prove the session it starts
 * is genuinely joinable over a real WebSocket. No fake tool returns.
 */

const NODE = process.execPath;
const LONG_RUNNING = [NODE, '-e', 'setInterval(() => {}, 1000)'];

let bundle: McpServerBundle | null = null;
let client: Client | null = null;
const sessionClients: SessionClient[] = [];

afterEach(async () => {
  for (const c of sessionClients.splice(0)) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  await client?.close();
  client = null;
  await bundle?.closeAllSessions();
  bundle = null;
});

async function makePair(): Promise<Client> {
  bundle = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bundle.server.connect(serverTransport);
  client = new Client({ name: 'vibelive-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Concatenate the text blocks of a tool result. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return (content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
}

function withTimeout<T>(p: Promise<T>, ms = 5000, what = 'operation'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

describe('mcp server', () => {
  it('lists exactly the documented tools', async () => {
    const c = await makePair();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['host_session', 'session_status']);
  });

  it('host_session starts a real, joinable session; session_status reports it', async () => {
    const c = await makePair();

    const hosted = await c.callTool({
      name: 'host_session',
      arguments: { command: LONG_RUNNING, name: 'mcp-host' },
    });
    const hostedText = textOf(hosted);
    expect(hostedText).toContain('ws://');
    const url = /ws:\/\/[^\s]+/.exec(hostedText)?.[0];
    expect(url).toBeDefined();

    const status = await c.callTool({ name: 'session_status', arguments: {} });
    const rows = JSON.parse(textOf(status)) as Array<{
      url: string;
      participants: number;
      driver: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url, participants: 1, driver: 'host' });

    // Not a fake return: a real participant can join the advertised URL.
    const joiner = joinSession({ url: url as string, name: 'mcp-joiner' });
    sessionClients.push(joiner);
    await withTimeout(joiner.id, 5000, 'join MCP-hosted session');

    // And the roster reflects the new arrival.
    const status2 = await c.callTool({ name: 'session_status', arguments: {} });
    const rows2 = JSON.parse(textOf(status2)) as Array<{ participants: number }>;
    expect(rows2[0]?.participants).toBe(2);
  });

  it('session_status with no sessions says so', async () => {
    const c = await makePair();
    const status = await c.callTool({ name: 'session_status', arguments: {} });
    expect(textOf(status)).toMatch(/no active vibelive sessions/);
  });

  it('closeAllSessions tears down hosted agents and relays (no orphans)', async () => {
    const c = await makePair();
    const hosted = await c.callTool({
      name: 'host_session',
      arguments: { command: LONG_RUNNING },
    });
    const url = /ws:\/\/[^\s]+/.exec(textOf(hosted))?.[0] as string;

    const joiner = joinSession({ url, name: 'doomed' });
    sessionClients.push(joiner);
    await withTimeout(joiner.id, 5000, 'join before teardown');

    await bundle?.closeAllSessions();

    // Status is empty and the relay is gone — joining again is refused.
    const status = await c.callTool({ name: 'session_status', arguments: {} });
    expect(textOf(status)).toMatch(/no active vibelive sessions/);

    const late = joinSession({ url, name: 'late' });
    sessionClients.push(late);
    await expect(late.id).rejects.toThrow();
  });
});
