# vibelive

Multiplayer for agentic coding terminals — shared Claude Code/Codex/Gemini sessions with live Figma-style cursors, presence, and in-terminal chat.

Part of the **Vibe Suite** — companion tools for agentic coding CLIs (Claude Code, Codex, Gemini, Grok/pi, Kimi). Ships as **CLI + npm package + MCP server**.

**Local-first: runs on your own machine.** v0 is a **host-authoritative local/LAN** session: one machine hosts a wrapped agent and owns the truth; peers join over a local WebSocket. Full end-to-end-encrypted relay fan-out to ~1,000 participants is on the roadmap (see [`docs/tech-spec.md`](docs/tech-spec.md)). Session sharing is gated by the consent ledger in [`@pooriaarab/vibe-core`](https://www.npmjs.com/package/@pooriaarab/vibe-core) (scope `share:session`), and is revocable.

## Install

```bash
npm install -g vibelive-cli
# or use it as a library / MCP server without the global install:
npm install vibelive-cli
```

Requires Node ≥ 18.

## Quick start

Share a wrapped agent (anything you'd run in a terminal) and print a join URL:

```bash
vibelive host -- claude          # share a Claude Code session
vibelive host -- python -i       # share a REPL
vibelive host --port 4474 --name ada -- claude
```

The host prints something like:

```
vibelive host ready — sharing claude
  join: ws://localhost:54157
  lan:  ws://10.0.0.179:54157
  you are the driver. /release to hand off, /drive to take back, /quit to end.
```

From another terminal (or another machine on the LAN):

```bash
vibelive join ws://localhost:54157 --name ada
```

The joiner sees the live agent output plus a presence/chat line. Slash commands while joined:

- `/drive` — request the write token (queued FIFO behind other drivers)
- `/release` — relinquish the token
- `/type <text>` — send input to the wrapped agent (**driver only**)
- `/quit` — leave the session

Everything else you type is sent as chat.

### Who can write to the agent?

Exactly one participant — the **driver** — holds the write token at any time (see `src/arbitration.ts`). Everyone else always has **read + chat + cursor**; only agent-write is arbitrated, so two people never interleave garbage into one stdin. The host user starts as the driver.

## MCP server

Run vibelive as a Model Context Protocol server over stdio:

```bash
vibelive mcp
```

It exposes two tools an agent can call:

| tool | description |
| --- | --- |
| `host_session` | Start a host+relay wrapping a command; returns the `ws://` join URL. |
| `session_status` | List active sessions (id, url, participants, current driver). |

Example (Claude Code / any MCP client config):

```jsonc
{
  "mcpServers": {
    "vibelive": { "command": "vibelive", "args": ["mcp"] }
  }
}
```

## Library

```bash
npm install vibelive-cli
```

```ts
import { createHost, createRelay, joinSession, WriteArbiter } from 'vibelive-cli';

// Host-authoritative session on an ephemeral port.
const host = createHost({ command: ['claude'] });
const relay = await createRelay({ port: 0, hostHandle: host, initialDriver: 'host' });
console.log(relay.url); // ws://localhost:<port>

const client = joinSession({ url: relay.url, name: 'ada' });
client.onOutput((text) => process.stdout.write(text));
client.requestControl(); // ask to drive
```

## How it works (v0)

Three channels over one WebSocket, each with the guarantees its data needs (details in [`docs/tech-spec.md`](docs/tech-spec.md)):

1. **Agent output** — ordered, sequence-numbered append-log; the host is the sole author; late joiners get snapshot + tail.
2. **Presence / cursors** — ephemeral, high-frequency, lossy is fine (coalesced/interpolated client-side; the relay forwards for v0).
3. **Chat + control** — reliable, ordered; agent-write is mediated by the `WriteArbiter` so there is never more than one driver.

The correctness-critical piece is `src/arbitration.ts` — a pure, fully unit-tested state machine enforcing *"never two concurrent agent-writers,"* FIFO turn-taking, and *"release when not driver is a no-op."*

## Prototype
Interactive, self-contained UX prototype (no build, no network): open [`docs/prototype.html`](docs/prototype.html) in a browser.

## Specs
- [`docs/tech-spec.md`](docs/tech-spec.md) — scale (10/100/1000), transport tiers, tests.
- [`docs/vibe-core-spec.md`](docs/vibe-core-spec.md) — shared suite spine (cascade, hooks, consent).

## Roadmap

- **v0 (this release):** host-authoritative local/LAN multiplayer — host + relay + arbitration + CLI + MCP, all over plain pipes/WebSocket.
- **Next:** real PTY wrapping (`node-pty`) for full TTY semantics (resize, raw-mode programs, signals), cursor interpolation, and a richer terminal renderer.
- **Scale:** the dumb, e2e-encrypted, self-hostable relay (pub/sub fan-out to ~1,000, relay reads only ciphertext) — see tech-spec §2 "Large" tier.

## License

MIT
