# vibelive — technical spec: scale, transport, tests

Status: DRAFT (Opus-authored) · 2026-07-25 · depends on `@vibe/core`
Reference prior art: Happy (slopus/happy, MIT) — CLI wraps agent → dumb relay
forwards **e2e-encrypted** blobs → clients decrypt. Relay can't read code.

## 0. The question this spec answers
"Can vibelive handle 10 / 100 / 1,000 concurrent people in one session, stay
fast, not be buggy — with proper tests?" And: how does that survive the suite's
"local-first, no data out" promise?

## 1. Reconciling scale with "no data out" (the honest version)
Full peer-to-peer mesh is O(n²) connections — it dies well before 100, and
NAT-traversal makes it flaky. So we cannot promise "literally zero bytes leave
your machine" AND "1,000 people." We promise the thing that actually matters:

> **No _readable_ data leaves your machine.** Session I/O is end-to-end
> encrypted; any relay only forwards opaque blobs and cannot read your code,
> prompts, or output. And the relay is **self-hostable** — run your own and
> there is no third party at all.

This is Happy's model, and it's the right one. The `@vibe/core` consent ledger
gates the `share:session` grant; the badge language becomes
**"● e2e encrypted · relay can't read · self-hostable"** rather than the strict
"no data out" (which stays literally true only for solo/LAN sessions, see §2).

## 2. Transport tiers (auto-selected by session size)
Core picks the transport from participant count; the product code is identical
across tiers.

- **Solo / LAN (1–~8, same network):** direct WebRTC data channels or a
  LAN socket. Truly zero egress — nothing leaves the local network. This is the
  only tier that earns the strict "no data out" badge.
- **Small remote (2–~30):** **host-authoritative.** The host's machine is the
  server; participants connect to it (via WebRTC, relayed only for NAT punch).
  Host fans out to everyone. Bounded by host upload bandwidth — fine to ~30.
- **Large (30–1,000):** **relay fan-out.** A dumb, e2e-encrypted relay
  (self-hostable) receives the host's single encrypted stream and fans it out to
  N subscribers (pub/sub, one publisher → N readers). Cursors/presence go through
  the same relay as a separate high-frequency lossy channel. This is where 1,000
  lives. Relay does zero decryption — pure blob fan-out, horizontally scalable.

Transport is a `@vibe/core` concern (§2 of core spec) so vibeshare/others reuse it.

## 3. Data model — three channels, three different guarantees
Getting this split right is what keeps it fast and non-buggy. Don't send
everything the same way.

1. **Agent output stream** — append-only, host is sole author. NOT a CRDT (no
   concurrent writers), just an ordered log with sequence numbers; late joiners
   get a snapshot + tail. Cheap, reliable, ordered. This is the bulk of bytes;
   compress + batch.
2. **Presence / cursors** — ephemeral, high-frequency (~30 Hz raw), **lossy is
   fine**. Never queue/retry these — a dropped cursor frame is invisible; a
   queued one causes rubber-banding. Send position deltas on an unreliable
   channel; **interpolate client-side** (the prototype already eases between
   points — same idea). Coalesce to ≤20–30 msg/s/participant, and the relay
   sends each client only an aggregated presence snapshot, not n² cursor streams.
3. **Chat + control (shared prompts to the agent)** — ordered, reliable,
   **needs arbitration** (§4). Low volume, correctness-critical.

## 4. The one real correctness hazard: who writes to the shared agent
Multiple people can send prompts to one agent. Concurrent writes to a single
Claude Code stdin = interleaved garbage. This is the bug that will bite. Model it
explicitly:
- **Control token / turn-taking.** One "driver" at a time holds write access;
  others request it; host (or a queue) grants. Prompts from non-drivers queue and
  are shown as pending, not injected raw.
- Everyone always has **read** + **chat** + **cursor**; only **agent-write** is
  arbitrated. (Matches the prototype's "manual mode" framing.)
- This is a state machine with clear invariants → property-tested (§6).

## 5. Performance budget (targets to test against)
- Cursor/presence end-to-end latency: **p50 < 80ms, p99 < 200ms** within region.
- Agent-output added latency over raw terminal: **< 150ms** at 1,000 spectators.
- Host CPU overhead: **< 5%** of one core at 100 participants (fan-out offloaded
  to relay beyond ~30).
- Client: steady **60fps** cursor rendering with 50 visible cursors (interpolation
  + culling off-screen cursors).
- Memory: bounded output-log ring buffer; snapshot + evict, never unbounded.

## 6. Test strategy (this is a "needs proper tests" product — take it seriously)
- **Unit / property:** the write-arbitration state machine (§4) — property tests
  asserting "never two concurrent agent writers", "every granted request
  eventually releases", "queue preserves order". Ordering/sequence of the output
  log under reorder+drop.
- **Simulation harness (the key one):** spin up **N virtual participants**
  (headless, scripted cursor motion + chat + join/leave churn) against a real
  host+relay. Run at **N = 10, 100, 1,000.** Assert the §5 budgets: measure
  latency p50/p99, dropped-frame %, host CPU/bandwidth, relay fan-out cost. Fail
  CI if budgets regress (perf gates, like a production monorepo's CI perf approach).
- **Chaos:** inject packet drop/reorder/latency + mid-session relay restart +
  host reconnect; assert session heals (late-joiner snapshot works, no
  desync/duplicate output).
- **Soak:** 1,000 participants × churn for 1h; assert no memory growth, no fd
  leak, stable latency.
- **E2E:** 3 real browser clients (Playwright) join, cursors visible to each
  other, chat delivered, driver handoff works, spectator can't write.
- Encryption tests: relay only ever sees ciphertext (assert relay logs contain no
  plaintext tokens); key rotation on participant leave.

## 7. Build order
1. `@vibe/core` transport primitive (tiers §2) + presence/output/control channels.
2. Host CLI wraps the agent (Happy-style PTY wrap), emits output log + accepts
   control.
3. Relay (dumb e2e fan-out, self-hostable, one small service).
4. Client render (terminal view + interpolated cursors + chat) — the prototype is
   the visual target.
5. Write-arbitration state machine + tests (§6) BEFORE opening it to >2 writers.
6. Simulation harness + CI perf gates at 10/100/1,000.

## 8. Open questions
- Relay: build our own tiny pub/sub fan-out, or lean on an existing e2e-friendly
  one? Default: tiny self-hostable service, since "self-hostable = no third party"
  is core to the pitch. (Cloudflare Durable Objects / Workers is a strong host —
  one DO per session as the fan-out coordinator; noted, not committed.)
- 1,000 as spectators (read-only) is easy (pub/sub); 1,000 as *active cursors* is
  the hard case — likely cap active-cursor participants (e.g. 50) and treat the
  rest as spectators with aggregated presence ("+950 watching"). Confirm product
  intent: is 1,000 mostly spectate, or 1,000 all cursoring?
- Voice/"Claudes talk to each other" (from the Dorsa ref) — multi-agent cross-talk
  is a v2 layer on top of the transport; out of scope for v0.
