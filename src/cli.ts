#!/usr/bin/env node
import { realpathSync } from 'node:fs';
/**
 * vibelive CLI — tiny, dependency-light arg parsing + the three subcommands.
 *
 *   vibelive host [--port <n>] [--name <s>] -- <command...>
 *   vibelive join <url> [--name <s>]
 *   vibelive mcp
 *   vibelive --version | --help
 *
 * `host`/`join` are implemented here; `mcp` is dynamically imported from
 * ./mcp.js so the (heavier) MCP SDK is kept out of the host/join bundle.
 */
import { createInterface } from 'node:readline';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHost } from './host.js';
import { createRelay } from './relay.js';
import { joinSession } from './client.js';
import { VERSION } from './version.js';

/** Participant id used for the local host user (the implicit initial driver). */
const HOST_ID = 'host';

export type ParsedCommand =
  | { readonly cmd: 'help' }
  | { readonly cmd: 'version' }
  | { readonly cmd: 'mcp' }
  | { readonly cmd: 'host'; readonly command: readonly string[]; readonly port?: number; readonly name?: string }
  | { readonly cmd: 'join'; readonly url: string; readonly name?: string }
  | { readonly cmd: 'error'; readonly message: string };

const err = (message: string): ParsedCommand => ({ cmd: 'error', message });

/**
 * Parse a vibelive argv slice (i.e. `process.argv.slice(2)`). Pure function —
 * no IO — so it is unit-tested directly in src/cli.test.ts.
 *
 * Everything after a bare `--` is opaque (the wrapped command) and is never
 * scanned for vibelive flags, so `vibelive host -- claude --version` wraps
 * `claude --version` rather than printing vibelive's version.
 */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const dd = argv.indexOf('--');
  const head = dd >= 0 ? argv.slice(0, dd) : [...argv];
  const command = dd >= 0 ? argv.slice(dd + 1) : [];

  if (head.includes('--help') || head.includes('-h')) return { cmd: 'help' };
  if (head.includes('--version') || head.includes('-v')) return { cmd: 'version' };

  const sub = head[0];
  if (sub === undefined) return { cmd: 'help' };
  if (sub === 'mcp') return { cmd: 'mcp' };

  if (sub === 'host') {
    let port: number | undefined;
    let name: string | undefined;
    const flags = head.slice(1);
    for (let i = 0; i < flags.length; i++) {
      const t = flags[i];
      if (t === undefined) break;
      const next = flags[i + 1];
      if (t === '--port') {
        if (next === undefined) return err('--port requires a value');
        const n = Number(next);
        if (!Number.isInteger(n) || n < 0 || n > 65535) return err('--port must be an integer in 0..65535');
        port = n;
        i++;
      } else if (t === '--name') {
        if (next === undefined) return err('--name requires a value');
        name = next;
        i++;
      } else {
        return err(`unknown host flag: ${t}`);
      }
    }
    if (command.length === 0) {
      return err('host needs a command after "--", e.g. `vibelive host -- claude`');
    }
    return { cmd: 'host', command, port, name };
  }

  if (sub === 'join') {
    let url: string | undefined;
    let name: string | undefined;
    const flags = head.slice(1);
    for (let i = 0; i < flags.length; i++) {
      const t = flags[i];
      if (t === undefined) break;
      const next = flags[i + 1];
      if (t === '--name') {
        if (next === undefined) return err('--name requires a value');
        name = next;
        i++;
      } else if (t === '--port') {
        if (next === undefined) return err('--port requires a value');
        i++; // accepted for compatibility, unused by join
      } else if (!t.startsWith('-') && url === undefined) {
        url = t;
      } else {
        return err(`unexpected join argument: ${t}`);
      }
    }
    if (!url) return err('join needs a session url, e.g. `vibelive join ws://localhost:4474 --name ada`');
    return { cmd: 'join', url, name };
  }

  return err(`unknown command: ${sub}`);
}

const HELP = `vibelive ${VERSION} — multiplayer for agentic coding terminals

USAGE
  vibelive host [--port <n>] [--name <s>] -- <command...>
      Start a session hosting <command> (e.g. \`vibelive host -- claude\`).
      Prints the ws:// join URL. The host user starts as the driver.

  vibelive join <url> [--name <s>]
      Join a session. Renders agent output plus a presence/chat line.
      Slash commands: /drive /release /type <text> /quit

  vibelive mcp
      Run the vibelive MCP server on stdio (tools: host_session, session_status).

  vibelive --version
  vibelive --help

v0 is host-authoritative local/LAN. E2e relay fan-out to ~1000 is on the roadmap.
`;

function printHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(HELP);
}

/** First non-internal IPv4 of this machine, for a friendlier LAN join hint. */
function lanAddress(): string | null {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const n of list) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

async function runHost(p: { readonly command: readonly string[]; readonly port?: number; readonly name?: string }): Promise<number> {
  const host = createHost({ command: p.command });
  const relay = await createRelay({
    port: p.port ?? 0,
    hostHandle: host,
    initialDriver: HOST_ID,
    hostParticipantName: p.name ?? 'host',
  });

  // The host user sees agent output locally (channel 1).
  host.onOutput((e) => process.stdout.write(e.text));

  process.stderr.write(`vibelive host ready — sharing ${p.command.join(' ')}\n`);
  process.stderr.write(`  join: ${relay.url}\n`);
  const lan = lanAddress();
  if (lan) {
    process.stderr.write(`  lan:  ws://${lan}:${relay.port}\n`);
  }
  process.stderr.write(`  you are the driver. /release to hand off, /drive to take back, /quit to end.\n`);

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (line === '/quit') {
      void shutdown(0);
      return;
    }
    if (line === '/release') {
      relay.localReleaseControl(HOST_ID);
      process.stderr.write('  control released.\n');
      return;
    }
    if (line === '/drive') {
      relay.localRequestControl(HOST_ID);
      process.stderr.write('  control requested.\n');
      return;
    }
    if (relay.arbiter.isDriver(HOST_ID)) {
      host.sendInput(`${line}\n`);
    } else {
      process.stderr.write('  (not the driver — /drive to take control)\n');
    }
  });
  rl.on('SIGINT', () => void shutdown(0));

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    host.kill();
    await relay.close();
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown(130));
  process.on('SIGTERM', () => void shutdown(143));

  const code = await host.exited;
  await shutdown(code ?? 0);
  return code ?? 0; // unreachable (process.exit above) but keeps the type honest
}

async function runJoin(p: { readonly url: string; readonly name?: string }): Promise<number> {
  const name = p.name ?? (process.env.USER || process.env.USERNAME || 'anon');
  const client = joinSession({ url: p.url, name });

  client.onOutput((text) => process.stdout.write(text));
  client.onPresence((participants, driverId) => {
    const driver = driverId ? participants.find((x) => x.id === driverId)?.name ?? driverId : '—';
    process.stderr.write(`\n[presence] ${participants.length} online · driving: ${driver}\n`);
  });
  client.onChat((m) => {
    process.stderr.write(`[${m.name}] ${m.text}\n`);
  });
  client.onControl((s) => {
    const driver = s.driverId ?? '—';
    process.stderr.write(`[control] driver: ${driver}${s.queue.length ? ` · queue: ${s.queue.join(', ')}` : ''}\n`);
  });
  client.onError((message) => {
    process.stderr.write(`[error] ${message}\n`);
  });
  client.onClose(() => {
    process.stderr.write('[vibelive] session closed.\n');
  });

  process.stderr.write(`vibelive joining ${p.url} as ${name}…\n`);
  await client.id.catch(() => 'unknown');
  process.stderr.write('connected. /drive /release /type <text> /quit\n');

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (line === '/quit') {
      client.close();
      rl.close();
      return;
    }
    if (line === '/drive') {
      client.requestControl();
      return;
    }
    if (line === '/release') {
      client.releaseControl();
      return;
    }
    if (line.startsWith('/type ')) {
      client.sendInput(`${line.slice(6)}\n`);
      return;
    }
    if (line === '/help') {
      process.stderr.write('slash: /drive /release /type <text> /quit  (other lines = chat)\n');
      return;
    }
    client.sendChat(line);
  });
  rl.on('SIGINT', () => {
    client.close();
    rl.close();
  });

  await client.closed;
  return 0;
}

/** CLI entrypoint. Returns the desired exit code (does not call exit itself). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.cmd) {
    case 'help':
      printHelp();
      return 0;
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'mcp': {
      const { runMcpStdio } = await import('./mcp.js');
      await runMcpStdio();
      return 0;
    }
    case 'host':
      return runHost(parsed);
    case 'join':
      return runJoin(parsed);
    case 'error':
      process.stderr.write(`vibelive: ${parsed.message}\n`);
      printHelp(process.stderr);
      return 2;
  }
}

// Run only when executed directly (not when imported by tests). The shebang
// above makes the bundled `dist/cli.js` directly invokable.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main().then((code) => process.exit(code));
}
