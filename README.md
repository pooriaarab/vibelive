# vibelive

[![npm version](https://img.shields.io/npm/v/vibelive)](https://www.npmjs.com/package/vibelive) [![Downloads/month](https://img.shields.io/npm/dm/vibelive)](https://www.npmjs.com/package/vibelive) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/vibelive) · [Setup](#install) · [API](#library-example) · [Compare](#compare)

vibelive is an open-source terminal collaboration tool for developers who share agentic coding sessions.
It wraps a process, shares output over local/LAN WebSockets, and lets one driver send input at a time.
It ships as a CLI, Node.js library, and agent server in the Vibe Suite.

## Install

```bash
npm install -g vibelive
```

Requires Node.js 18 or later. Includes TypeScript declarations and three direct runtime dependencies.

## Share your first process

In one terminal, start a process that echoes each input line:

```bash
vibelive host --port 4474 --name ada -- node -e "process.stdin.on('data', b => process.stdout.write(b))"
```

In another terminal, join it:

```bash
vibelive join ws://localhost:4474 --name bee
```

Type `hello` in the host terminal. Both terminals print `hello`; the joiner also shows presence and control state.
No credentials or environment variables are required. vibelive does not load `.env` files; wrapped agents inherit the host environment.
For LAN peers, use the host's printed LAN address. Transport is plain WebSocket with no built-in authentication or encryption.

In the joiner, type `/drive`. On the host, type `/release` to hand over control.
The joiner can then send `/type ping` and see `ping` in both terminals. Use `/quit` on the host to end the session.

## How it works

```text
Host terminal -> wrapped child process -> ordered output log
                       ^                         |
                       |                         v
                 one driver <- host WebSocket relay -> participants
                                  |                    |
                              control queue        chat + presence
```

The host owns process output and control state. Late joiners receive retained output followed by live updates.
The relay binds to `0.0.0.0` by default, so reachable LAN clients can connect.

## Why it exists

Pairing on a coding agent needs a clear answer to who can type next.
vibelive adds a cooperative driver queue and chat around a wrapped command.
Tools such as tmux and tmate serve broader terminal workflows; vibelive focuses on process sharing with agent-accessible session management.

## Compare

Checked 2026-10-14 against [tmux](https://github.com/tmux/tmux) and [tmate](https://github.com/tmate-io/tmate).

| Property | vibelive | tmux | tmate |
| --- | --- | --- | --- |
| Scope | Shared process with driver arbitration | Terminal multiplexer | Terminal sharing |
| Transport here | Plain local/LAN WebSocket | Local sessions; remote access arranged separately | SSH-based sharing |
| Interface | CLI, Node.js library, agent tools | Terminal commands | Terminal commands |
| Process handling | Child-process pipes | Terminal sessions | tmux-derived terminal sessions |

## Coverage

| Surface or integration | Status | Scope |
| --- | --- | --- |
| WebSocket / ws | Implemented | Host relay, client, output, chat, presence, control |
| Claude Code | Generic command wrapper | Requires separately installed `claude`; no dedicated adapter |
| OpenAI Codex | Generic command wrapper | Requires separately installed CLI; no dedicated adapter |
| Google Gemini CLI | Generic command wrapper | Requires separately installed CLI; no dedicated adapter |
| Pi / Grok workflows | Generic command wrapper | Pipes-compatible commands; no dedicated adapter |
| Kimi | Generic command wrapper | Requires separately installed CLI; no dedicated adapter |
| MCP | Implemented | Two stdio tools |
| Cursor updates | Protocol only | Library send/receive; no rich CLI cursor renderer |
| Encrypted remote relay | Roadmap | Not shipped |
| Full terminal emulation | Roadmap | No pseudoterminal support |

There is no harness adapter registry: the host executes an arbitrary command through Node.js child-process pipes.
Local tests cover host, relay, client, arbitration, protocol-facing behavior, and MCP. Specific agent CLIs are not certified here.

## Common use cases

1. Claude Code pairs: share process output and hand off the driver role on a trusted LAN.
2. Codex reviewers: observe a wrapped command while the host controls input.
3. Gemini CLI mentors: keep discussion in chat and send agent input through `/type`.
4. Node.js teams: wrap a line-based script to test collaboration without AI credentials.
5. Agent builders: start sessions through the Model Context Protocol (MCP) and inspect participants and driver state.

## Features

- **Single driver:** first-in, first-out control queue; non-driver input is rejected.
- **Output replay:** sequence-numbered retained history plus live output.
- **Chat:** separate participant messages and process input.
- **Presence:** participant names and the current driver.
- **Consent:** relay output sharing checks vibe-core's `share:session` scope.
- **Lifecycle:** host exit closes sessions; MCP disconnect cleans up its hosted processes.

## Runtime surfaces

```text
vibelive host [--port N] [--name name] -- command [args...]
vibelive join ws://host:port [--name name]
vibelive mcp
vibelive --help / -h
vibelive --version / -v
```

All wrapped-command flags go after `--`. `--port 0` selects an available port.
The join parser also accepts `--port`, but does not use it; the URL controls the destination.
Join names default to `USER`, then `USERNAME`, then `anon`.

| Interactive command | Host | Joiner |
| --- | --- | --- |
| `/drive` | Request control | Request control |
| `/release` | Release control | Release control |
| `/quit` | End session | Leave session |
| `/type text` | Treated as process input if driver | Send process input if driver |
| `/help` | Treated as process input if driver | Print slash-command help |
| Other text | Process input if driver | Chat |

`vibelive mcp` starts stdio MCP with exactly two tools:

| Tool | Input | Result |
| --- | --- | --- |
| `host_session` | Command array; optional name and port | Session ID and WebSocket join URL |
| `session_status` | Optional URL filter | Active sessions, participants, and driver |

### Library example

Install locally with `npm install vibelive`, then save this as `demo.mjs` and run `node demo.mjs`:

```js
import { createHost, createRelay, joinSession } from 'vibelive';
const host = createHost({ command: ['node', '-e', "setInterval(() => console.log('hello'), 200)"] });
const relay = await createRelay({ host: '127.0.0.1', port: 0, hostHandle: host });
const client = joinSession({ url: relay.url, name: 'ada' });
client.onOutput(text => process.stdout.write(text));
await client.id;
await new Promise(resolve => setTimeout(resolve, 600));
client.close();
host.kill();
await relay.close();
```

The script prints `hello` and closes its process and relay.

## Delivery and behavior limits

The shipped transport is local/LAN, plain WebSocket. There is no built-in participant authentication, TLS, or end-to-end encryption.
Use it only where session access and network exposure match your intended participants. Output can include anything the wrapped command prints.
The host uses pipes, not a pseudoterminal (PTY). Resize is a no-op; raw-mode and full-screen agent interfaces may not work.
Output history defaults to 5,000 chunks in memory. Older entries are evicted; sessions do not persist after host exit.
Cursor messages exist in the protocol, but the CLI renders presence rather than animated cursors.
The package provides no managed relay, remote fan-out scale guarantee, or durable chat service.

## Integration guides

- Claude Code process sharing: `vibelive host -- claude`; install and authenticate Claude Code separately.
- Other coding agents: pass the installed command after `--`; check that it can operate through pipes.
- LAN participation: use the printed `ws://<LAN-address>:<port>` URL with `vibelive join`.
- MCP host configuration:

```json
{"mcpServers":{"vibelive":{"command":"vibelive","args":["mcp"]}}}
```

## Status

Package version 0.2.3 is pre-1.0; interfaces can change. The CLI's source version still reports `0.2.2`.
Planned work includes PTY wrapping, richer cursors, and an encrypted self-hosted remote relay.
Public case studies are not yet published. No public documentation site is configured; setup guidance is self-contained here.
Use [GitHub issues](https://github.com/pooriaarab/vibelive/issues) for support; repository access may be required.
For contributions, run `npm ci`, `npm run typecheck`, `npm run build`, and `npm test`.

## FAQ

### Which integrations are verified?

vibelive tests its local process and WebSocket behavior. Named coding agents use a generic wrapper rather than dedicated, credential-verified adapters.

### Does vibelive provide a managed relay?

vibelive runs its relay on the host machine. The package does not provide a managed remote relay service.

### How is vibelive different from tmux?

vibelive shares one wrapped process with a driver queue and chat. tmux manages terminal sessions, windows, and panes.

### How is vibelive different from tmate?

vibelive uses a local/LAN WebSocket and explicit driver arbitration. tmate provides SSH-based terminal sharing.

### Is vibelive end-to-end encrypted?

vibelive ships plain WebSocket transport. An encrypted remote relay is roadmap work.

### Can two people type into the agent at once?

vibelive allows one driver to send input. Other participants can chat and queue for control.

### Does vibelive work with full-screen terminal apps?

vibelive uses child-process pipes without PTY semantics. Raw-mode, resize, and full-screen terminal behavior are limited.

### Do late joiners see earlier output?

vibelive sends retained output history before live updates. The default rolling buffer keeps up to 5,000 chunks.

## License

MIT.
