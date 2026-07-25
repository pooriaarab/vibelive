# `@vibe/core` — shared spine for the Vibe Suite

Status: DRAFT spec (Opus-authored) · 2026-07-25 · owner: Pooria
Consumed by: viberadio, vibemovie, vibedonate, vibelive, vibeshare, vibedating

The suite's rule: **write the hard shared parts once.** Every package is a thin
product on top of three primitives that all of them need — a model-preference
cascade, a hook/trigger system, and a config+consent layer. Those live here.

Non-negotiable across everything built on core: **local-first. The user's machine
is the default trust boundary. Nothing leaves it unless the user explicitly opts a
specific flow into sharing.** Core enforces this — a package can't accidentally
phone home, because the only egress paths core exposes are the ones the user armed.

---

## 1. Package shape (every suite package is identical here)

Each product ships three faces over one shared engine:

- **CLI** — `npx vibelive`, `npx viberadio`, etc. Interactive + scriptable.
- **npm library** — programmatic API for people wiring it into their own tools.
- **MCP server** — `vibe-<name> mcp` exposes the product as MCP tools so Claude
  Code / Codex / Gemini / any MCP host can drive it.

All three are thin. They parse intent and call into the product engine, which calls
into `@vibe/core`. DX bar borrowed from vibenotifications / vibeads / offrouter:
beautiful terminal output, zero-config first run, works with the user's own keys,
deep customization available but never required, real docs.

```
@vibe/core
├── cascade/      model-preference resolution (§2)
├── hooks/        trigger system: manual + milestone (§3)
├── config/       layered config + consent ledger (§4)
├── providers/    provider adapters (Anthropic/OpenAI/Google/Grok/local) (§2)
├── local/        on-device model runners (§2.3)
└── ui/           shared terminal UI kit (spinners, prompts, badges, the
                  "● local · no data out" badge every product shows)
```

---

## 2. The model-preference cascade (the crown jewel)

The thing users will copy us for. A product declares a **capability** it needs
(`audio`, `video`, `chat`, `embedding`, `usage-read`, …) and core resolves the
cheapest, most-private provider that satisfies it, in this fixed order:

**Tier 1 — reuse the agent's existing config.** If the user already runs Claude
Code / Codex / Gemini with a configured provider that supports the capability, use
it. No new key, no new setup. Core detects this by reading the *host agent's* own
config (see §2.1). Example: viberadio needs `audio`; user's OpenAI key (already set
for their agent) supports audio models → use it.

**Tier 2 — a capability-specific key the user brings.** If tier 1 can't satisfy the
capability (host provider lacks the modality), fall back to a key the user supplies
*for that modality*: `VIBE_AUDIO_KEY`, `VIBE_VIDEO_KEY`, etc. (Wavespeed/Replicate
for video, ElevenLabs/OpenAI for audio…). Prompted once, stored in config (§4).

**Tier 3 — local / on-device.** If no key at all, fall back to a local model so the
product *still works offline with zero setup and zero egress*. This is also the
default when the user has flipped local-first to strict. Quality degrades
gracefully; the product never hard-fails for lack of a key.

```ts
// the whole public surface a product touches:
const provider = await cascade.resolve({
  capability: 'audio',
  prefer: userConfig.audio?.preferTier,   // user can pin a tier
  allowEgress: consent.allows('audio'),   // tier 1/2 need this; tier 3 never does
});
const out = await provider.generate({ ... });
```

Rules the cascade enforces:
- **Tier 3 requires no consent** (nothing leaves the machine). Tiers 1–2 do (§4).
- A product NEVER selects a provider directly — it declares a capability and takes
  what cascade returns. This is what keeps the privacy invariant true suite-wide.
- The chosen tier is surfaced to the user ("🔊 using your OpenAI key" /
  "🔊 on-device, offline"), never silent.

### 2.1 Host-agent detection (tier 1)
Core sniffs, in order: env the host agent injects → `~/.claude*/…`,
`~/.codex*/…`, `~/.gemini*/…`, `~/.config/…` provider configs → running-process
hints. Read-only. It resolves *which provider+key the user already trusts*, and
whether that provider advertises the needed capability (a static capability matrix
per provider in `providers/`). Never copies or transmits the key — hands the
existing client to the provider adapter in-process.

### 2.2 Provider adapters
One adapter per provider (`anthropic`, `openai`, `google`, `xai`, `local`), each
declaring which capabilities it supports and a uniform `generate()` per capability.
Adding a provider = one file. (Same recipe pattern as solo-admin's provider
registry — see project memory.)

### 2.3 Local runners (tier 3)
Pluggable on-device backends detected at runtime: system TTS for audio, a bundled
tiny model, Ollama/llamafile if present, WebGPU/wasm as last resort. Each product
declares its minimum acceptable local backend; if none present, core offers a
one-line install rather than failing. Local runners are the ONLY tier that also
powers vibedonate's "contribute compute" side (§ vibedonate spec).

---

## 3. Hook / trigger system

Products generate output on **triggers**. Core owns the trigger plumbing so all six
fire consistently and share on/off UX.

**Trigger sources:**
- **Manual** — CLI command / MCP tool call / keybind.
- **Milestone** — agent lifecycle events: PR opened, prototype finished, spec
  completed, task done, build green, error. Delivered via the host agent's own hook
  system where one exists (Claude Code hooks are the reference integration), git
  hooks as a fallback, and a file/socket watcher as the universal floor.

**Per-trigger policy** (config §4): each trigger is `off | ask | auto`.
- `ask` → prompt once ("audio recap of this task? [y/N]").
- `auto` → fire silently per user prefs.
- Global master switch + per-product + per-trigger granularity.

Milestone normalization: core exposes a single `VibeEvent` shape
(`{ kind, agent, cwd, payload, ts }`) so a product writes one handler regardless of
whether the event came from a Claude Code hook, a git hook, or the watcher. **This
is the shared answer to the open question "where do hooks live" — core abstracts
over all of them; products never bind to one host's hook format.**

---

## 4. Config + consent ledger

Layered config, lowest→highest precedence: built-in defaults → `~/.vibe/config`
(global, shared across products) → per-product config → project `.vibe/` → env →
CLI flags. Shared keys (the user's brought keys, local-first strictness, default
trigger policy) live at the global layer so they're set once for the whole suite.

**Consent ledger** — because "no data out" is a promise we have to *keep*:
- Any flow that would send data off-machine (tiers 1–2, or a product's sharing
  feature like vibeshare's URL or vibedonate's mesh) must hold a matching consent
  grant. No grant → core refuses egress and routes to tier 3 or errors loudly.
- Grants are explicit, scoped (`audio`, `share:session`, `donate:compute`),
  revocable, and logged locally so the user can audit what they've allowed.
- `vibe consent` / `<product> --local-only` to inspect and lock down.

This is what makes the local-first claim enforceable rather than aspirational, and
it's the same primitive that gates the two products with real trust/safety surface
(vibedonate, vibeshare).

---

## 4b. Cross-harness support (works with EVERY agentic CLI)

Non-negotiable: the whole suite works across all agentic coding harnesses, not just
Claude Code. Core owns this via a **host adapter** per harness — one small module
that knows three things about that harness: (a) how to detect its provider/key
config (cascade tier 1), (b) its hook/event surface (triggers §3), (c) how to read
its token usage (for vibedating). Products stay harness-agnostic; they only touch
the normalized `VibeEvent` / cascade / usage APIs.

Target harnesses (v0 aims wide; adapters land incrementally, watcher-floor covers
any not-yet-adapted one):
**Claude Code · Codex · Cursor · Gemini CLI · Grok · pi (dev CLI) · Kimi / Moonshot
CLI · Hermes · OpenClaw.**
Also on the radar (same adapter shape): Aider, OpenCode, Cline, Continue, Goose
(Block), Amp, Warp, Zed agent, Qwen Code, Augment/Auggie, Charm Crush.
Adding a harness = one adapter file (detect-config + hook-map + usage-read), same
one-file-per-provider ergonomics as §2.2.

## 4c. Timing axis — sync/live vs async (per hook, user-customizable)

Every product's output can fire on either cadence; core exposes it as a per-trigger
setting so products don't reinvent it:
- **sync / live** — generate *as the agent works* (viberadio ambient narration,
  vibemovie scenes building live, vibelive is inherently live).
- **async** — generate *after* a turn/task/session completes (task-summary audio, a
  session recap movie).
Combined with §3's `off | ask | auto`, each trigger is `(timing, policy)`. Default
sensible per product; fully overridable.

## 4d. Multi-model mixing (not just one provider at a time)

The cascade resolves a provider *per capability*, but a product may use **several
providers concurrently** for different slots — e.g. viberadio rendering a two-host
podcast with each host on a different TTS voice/provider, or one style on a BYO key
and another on the on-device tier. Core supports per-slot resolution
(`cascade.resolve({capability, slot, prefer})`) and lets the user pin a specific
model per slot. Local + hosted can coexist in one output.

## 4e. Product identity
Each product is its **own brand + domain**, not a shared umbrella host. Share/link
features use the product's own domain (e.g. vibeshare's own domain, not a generic
`vibe.live`). Core provides the URL/relay plumbing; the identity is per-product.

## 5. What core does NOT do
Per ponytail: core is primitives, not products. No product-specific logic leaks in.
No abstraction with a single consumer — a thing graduates into core only when a
*second* product needs it. Start each product with its logic local; promote to core
on the second use. (First candidates already known to be shared: cascade, hooks,
config/consent, terminal UI kit, host-agent detection — those ship in core v0.)

---

## 6. Open questions for core
- **Local model floor**: bundle a tiny model (bigger install, always-works) vs
  detect-and-offer (lean, needs one setup step)? Leaning detect-and-offer with a
  system-TTS/system-primitive fallback that needs nothing.
- **Host-agent hook API stability**: Claude Code hooks are the reference; Codex /
  Gemini hook surfaces differ. Watcher floor covers the gap but is coarser. Ship
  watcher-first, upgrade to native hooks per host opportunistically.
- **Monorepo vs polyrepo for core+6**: default is polyrepo + published `@vibe/core`.
  Revisit if cross-package churn during v0 makes lockstep releases painful.
