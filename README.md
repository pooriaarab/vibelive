# vibelive

<p align="center">Share a live Claude Code, Codex, or Gemini terminal on your LAN, one driver at a time.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vibelive"><img src="https://img.shields.io/npm/v/vibelive" alt="npm v0.2.3"/></a>
  <a href="https://github.com/pooriaarab/vibelive/actions/workflows/oxlint.yml"><img src="https://github.com/pooriaarab/vibelive/actions/workflows/oxlint.yml/badge.svg" alt="oxlint"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT"/></a>
  <a href="#mcp"><img src="https://img.shields.io/badge/MCP_tools-2-informational" alt="Two MCP tools: host_session and session_status"/></a>
</p>

```text
$ vibelive host -- node -e "console.log('hello')"
vibelive host ready — sharing node -e console.log('hello')
  join: ws://localhost:65130
  lan:  ws://10.0.0.179:65130
  you are the driver. /release to hand off, /drive to take back, /quit to end.
hello
```

<p align="center"><em><code>vibelive host</code> wrapping a command and printing the join URL.</em></p>

## Install

```bash
npm install -g vibelive
vibelive host -- node -e "console.log('hello')"
```

Needs Node 18 or newer. `vibelive --version` currently prints `0.2.2` even on npm `0.2.3`.

> [!IMPORTANT]
> v0 is host-authoritative local/LAN. Sharing uses a plain WebSocket on the host machine. End-to-end-encrypted relay fan-out is not shipped.

<details>
<summary>No global install</summary>

```bash
npx -y vibelive --help
```

</details>

## Quick start

Share any command you would run in a terminal. The host prints a `ws://` join URL and starts as the driver:

```bash
vibelive host -- node -e "console.log('hello')"
```

To wrap Claude Code: `vibelive host -- claude`. A Python one-shot: `vibelive host -- python3 -c "print('hello from python')"`. Pass `--port` and `--name` before `--`.

From another terminal, or another machine on the LAN, join with the printed URL:

```bash
vibelive join ws://localhost:45931 --name bee
```

```
vibelive joining ws://localhost:45931 as bee…

[presence] 2 online · driving: ada
[control] driver: host
connected. /drive /release /type <text> /quit
hello
```

The joiner sees the live output plus a presence and chat line.

## Why

For developers pairing on Claude Code, Codex, Gemini, Grok/pi, or Kimi, who today share a screen or a tmate session. vibelive wraps the agent, fans output over a local WebSocket, and lets exactly one **driver** write to stdin.

Not for a persistent tmux session, a full PTY (resize, raw-mode programs), or a 1,000-person encrypted relay. v0 is host-authoritative local/LAN. Session sharing is gated by the consent ledger in [`@pooriaarab/vibe-core`](https://www.npmjs.com/package/@pooriaarab/vibe-core) (scope `share:session`), and is revocable.

Part of the **Vibe Suite** — companion tools for agentic coding CLIs. Ships as CLI, npm library, and MCP server. Local-first: it runs on your machine.

## host

Start a session. Everything after `--` is the wrapped command, including that command's own flags.

```bash
vibelive host -- claude
```

```
vibelive host ready — sharing claude
  join: ws://localhost:63233
  lan:  ws://10.0.0.179:63233
  you are the driver. /release to hand off, /drive to take back, /quit to end.
```

`--port <n>` binds that port (`0` picks an ephemeral port). `--name <s>` sets the host participant name (default `host`). The host user starts as the driver.

On the host, `/release` hands off the write token, `/drive` takes it back, and `/quit` ends the session. Other lines go to the wrapped command while you are the driver.

Exactly one participant holds the write token at a time (`src/arbitration.ts`). Everyone else always has read, chat, and cursor on the wire. Only agent-write is arbitrated, so two people never interleave garbage into one stdin.

## join

```bash
vibelive join ws://localhost:45931 --name bee
```

`--name` defaults to `$USER`. Slash commands while joined:

- `/drive` — request the write token (queued FIFO)
- `/release` — relinquish the token
- `/type <text>` — send input to the wrapped agent (**driver only**)
- `/quit` — leave the session
- `/help` — print the slash list

Everything else you type is chat.

A non-driver `/type` is rejected (`not the current driver — request control first`). After the host `/release`s, a joiner `/drive` then `/type ping-from-bee` reaches the wrapped process.

## mcp

```bash
vibelive mcp
```

The process stays up and prints nothing until an MCP client talks on stdin. Closing stdin exits 0 and kills any session the server started.

Two tools:

| tool | description |
| --- | --- |
| `host_session` | Start a host+relay wrapping a command; returns the `ws://` join URL. |
| `session_status` | List active sessions (id, url, participants, current driver). |

Claude Code / MCP client config after a global install:

```json
{
  "mcpServers": {
    "vibelive": { "command": "vibelive", "args": ["mcp"] }
  }
}
```

Platform notes (Windows `npx` wrapping, Claude Desktop paths): [`docs/SETUP.md`](docs/SETUP.md).

## How it works

Three channels over one WebSocket (details in [`docs/tech-spec.md`](docs/tech-spec.md)):

1. **Agent output** — ordered, sequence-numbered append-log. The host is the sole author. Late joiners get snapshot + tail.
2. **Presence / cursors** — ephemeral, high-frequency, lossy is fine. The CLI renders presence; cursor deltas exist on the wire. The Figma-style cursor UX is the browser prototype, not the shipped CLI.
3. **Chat + control** — reliable, ordered. Agent-write goes through `WriteArbiter` so there is never more than one driver.

v0 uses plain pipes (`child_process.spawn`), not a PTY. `resize` is a no-op.

Library (`npm install vibelive`):

```ts
import { createHost, createRelay, joinSession, WriteArbiter } from 'vibelive';

const host = createHost({ command: ['node', '-e', "console.log('hello')"] });
const relay = await createRelay({ port: 0, hostHandle: host, initialDriver: 'host' });
console.log(relay.url); // ws://localhost:<port>

const client = joinSession({ url: relay.url, name: 'ada' });
client.onOutput((text) => process.stdout.write(text));
client.requestControl();
```

Interactive UX prototype (no build, no network): open [`docs/prototype.html`](docs/prototype.html) in a browser. It is a demonstration, not the CLI.

Specs: [`docs/tech-spec.md`](docs/tech-spec.md) (scale, transport tiers, tests), [`docs/vibe-core-spec.md`](docs/vibe-core-spec.md) (cascade, hooks, consent).

Planned, not shipped: real PTY wrapping (`node-pty`) for resize, raw-mode, and signals; cursor interpolation and a richer terminal renderer; the dumb, e2e-encrypted, self-hostable relay (pub/sub fan-out to ~1,000, relay reads only ciphertext).

## Contributing

See [CONTRIBUTING.md](https://github.com/pooriaarab/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE)
