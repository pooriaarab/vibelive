/**
 * vibelive MCP server (stdio). Exposes two tools an agent can call:
 *
 *   - host_session    — start a vibelive host+relay wrapping a command; returns
 *                       the ws:// join URL. Lives for the MCP process lifetime
 *                       (or until the wrapped agent exits).
 *   - session_status  — list active sessions (id, url, participants, driver).
 *
 * When the MCP client disconnects (stdin closes), every hosted agent is killed
 * and every relay closed — sessions never outlive the MCP server as orphans.
 *
 * Uses the high-level McpServer API from @modelcontextprotocol/sdk. Input
 * schemas are Zod raw shapes (the SDK's expected form); zod is a transitive
 * dependency of the SDK and gets bundled into dist/mcp.js.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHost, type HostHandle } from './host.js';
import { createRelay, type RelayHandle } from './relay.js';
import { VERSION } from './version.js';

interface ManagedSession {
  readonly id: string;
  readonly host: HostHandle;
  readonly relay: RelayHandle;
  readonly command: readonly string[];
  readonly name: string;
}

/** The MCP server plus the lifecycle hook for everything it started. */
export interface McpServerBundle {
  readonly server: McpServer;
  /** Kill every hosted agent and close every relay started via host_session. */
  closeAllSessions(): Promise<void>;
}

/** Build the vibelive MCP server (tools registered, not yet connected). */
export function createMcpServer(): McpServerBundle {
  const server = new McpServer(
    { name: 'vibelive', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'vibelive gives an agent multiplayer terminals. Use host_session to share a wrapped agent command and get a join URL; use session_status to inspect active sessions.',
    },
  );

  const sessions = new Map<string, ManagedSession>();

  server.registerTool(
    'host_session',
    {
      title: 'Host a vibelive session',
      description:
        'Start a vibelive host session wrapping an agent command (e.g. ["claude"] or ["python","-i"]). Returns the ws:// join URL that other participants can connect to with `vibelive join`. The host process is authoritative.',
      inputSchema: {
        command: z
          .array(z.string())
          .min(1)
          .describe('The agent command to wrap, argv-style, e.g. ["claude"] or ["python","-i"].'),
        name: z.string().optional().describe('Optional display name for the host participant.'),
        port: z
          .number()
          .int()
          .optional()
          .describe('Optional port to bind (default: ephemeral).'),
      },
    },
    async ({ command, name, port }) => {
      const host = createHost({ command });
      const relay = await createRelay({
        port: port ?? 0,
        hostHandle: host,
        initialDriver: 'host',
        hostParticipantName: name ?? 'host',
      });
      const id = `session-${relay.port}`;
      sessions.set(id, { id, host, relay, command, name: name ?? 'host' });
      // When the wrapped agent exits, tear the session down.
      void host.exited.then(async () => {
        sessions.delete(id);
        await relay.close();
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `vibelive session ready.\nid: ${id}\nurl: ${relay.url}\nname: ${name ?? 'host'}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'session_status',
    {
      title: 'List vibelive sessions',
      description:
        'List active vibelive sessions started via host_session. Each entry includes id, join url, participant count, and the current driver id (null when idle).',
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe('Optional: return only the session matching this join URL.'),
      },
    },
    async ({ url }) => {
      const rows = [];
      for (const s of sessions.values()) {
        if (url && s.relay.url !== url) continue;
        rows.push({
          id: s.id,
          url: s.relay.url,
          command: s.command,
          participants: s.relay.participants.length,
          driver: s.relay.arbiter.driver(),
        });
      }
      const text =
        rows.length === 0
          ? 'no active vibelive sessions'
          : JSON.stringify(rows, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  const closeAllSessions = async (): Promise<void> => {
    const all = [...sessions.values()];
    sessions.clear();
    for (const s of all) {
      s.host.kill();
      await s.relay.close();
    }
  };

  return { server, closeAllSessions };
}

/** Create the server, wire it to stdio, and run until the client disconnects. */
export async function runMcpStdio(): Promise<void> {
  const { server, closeAllSessions } = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until the MCP client closes stdin.
  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  // Don't orphan wrapped agents when the MCP host (Claude Code etc.) goes away.
  await closeAllSessions();
  await server.close();
}
