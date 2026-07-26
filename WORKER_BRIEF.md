[WORKER] Implement `src/` for @pooriaarab/vibelive — a working v0. Read README.md + docs/spec.md + docs/tech-spec.md first (tech-spec defines transport tiers, the 3-channel model, and the write-arbitration hazard — follow it). Scaffold is DONE — do NOT modify package.json/tsconfig/workflow/LICENSE. Implement ONLY under src/ + polish README.md.

## Build on @pooriaarab/vibe-core (already a dependency). Run `npm install` first.
Import from '@pooriaarab/vibe-core': types (VibeEvent), createConsentLedger (share:session gate). Inspect dist/index.d.ts. Use `ws` for websocket transport.

## v0 scope — a genuinely working LOCAL/LAN multiplayer session (host-authoritative tier). Full 1000-scale relay is post-v0; build the small tier well.

### The 3 channels (from tech-spec) — keep them separate:
1. output = ordered append-log (host is sole author), seq-numbered, late-joiners get snapshot+tail.
2. presence/cursors = ephemeral, lossy OK.
3. chat + control = reliable, ordered.

### THE correctness-critical piece — src/arbitration.ts (build this carefully, test hard):
A `WriteArbiter` state machine enforcing the invariant **never two concurrent agent-writers**. One driver holds the write token; others `requestControl()` → queue; `release()`/`grant()` hand off; non-drivers can always read/chat/cursor. Properties to test: never 2 drivers; every granted request eventually releasable; queue preserves FIFO order; releasing when not driver is a no-op. This is PURE logic — no IO — so it's fully unit-testable. Put real vitest property-ish tests here.

### src/index.ts — library
- `createHost({ command })` — spawns the wrapped agent command via child_process (pipe stdout/stdin; NOT node-pty for v0), maintains the output append-log, accepts control input from the current driver only (via the WriteArbiter).
- `createRelay({ port })` — a `ws` server: fans out the host output-log to all participants, relays presence/cursor/chat, tracks the participant roster, mediates control requests through the WriteArbiter. Host-authoritative: the host process owns truth.
- `joinSession({ url, name })` — a client that connects, receives snapshot+tail, sends cursor/chat, can requestControl.

### src/cli.ts — CLI (shebang, tiny arg parse)
- `vibelive host -- <command...>` — start a session hosting <command> (e.g. `vibelive host -- claude`), print the join URL (ws://localhost:PORT).
- `vibelive join <url> --name <name>` — join a session (renders output + a simple presence/chat line in the terminal).
- `vibelive mcp`, `--version`, `--help`.

### src/mcp.ts — MCP server (`@modelcontextprotocol/sdk`, stdio) exposing `host_session` + `session_status`. Check installed SDK API.

### tests — src/*.test.ts (vitest): **arbitration.test.ts is the priority** (all the invariants above). Plus: output-log ordering/snapshot+tail, presence roster add/remove, CLI parser. A light integration test (spin a relay on an ephemeral port, connect a ws client, assert it receives output) is a strong plus but keep it fast + not flaky.

### README.md — polish for npm: keep existing, add install + quick start (`vibelive host -- <cmd>`, `vibelive join <url>`) + note v0 = local/LAN host-authoritative; e2e relay fan-out to 1000 is on the roadmap.

## Definition of done (run, all green): `npm install` → `npm run build` (dist/cli.js, index.js, mcp.js) → `npm run typecheck` → `npm run test`. Strict tsconfig (`import type`, `.js` on relative imports). Commit "feat: vibelive v0 — host + relay + arbitration + CLI + MCP" on branch build-v0. Do NOT push. Report build + test count + how you tested arbitration + judgment calls.
