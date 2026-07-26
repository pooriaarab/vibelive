/**
 * @pooriaarab/vibelive — multiplayer for agentic coding terminals.
 *
 * v0 is the **host-authoritative local/LAN tier** (tech-spec §2): one machine
 * hosts a wrapped agent, participants join over WebSocket, the host process owns
 * truth. The three channels (§3) — ordered output log, ephemeral cursors,
 * reliable chat + arbitrated control — are kept separate, and agent-write goes
 * through the {@link WriteArbiter} so there is never more than one driver.
 *
 * Public surface:
 *   - {@link createHost}    — wrap an agent command, own the output log.
 *   - {@link createRelay}   — ws server: fan out output, relay presence/chat,
 *                             mediate control via the WriteArbiter, gate egress
 *                             through the vibe-core consent ledger.
 *   - {@link joinSession}   — connect a client, receive snapshot+tail, chat,
 *                             request control.
 */
export { WriteArbiter, createWriteArbiter } from './arbitration.js';
export type { ControlState } from './arbitration.js';

export { OutputLog } from './output-log.js';
export type { OutputEntry, OutputSnapshot } from './output-log.js';

export { createHost } from './host.js';
export type { HostOptions, HostHandle } from './host.js';

export { createRelay, SHARE_SESSION_SCOPE } from './relay.js';
export type { RelayOptions, RelayHandle, Participant } from './relay.js';

export { joinSession } from './client.js';
export type {
  SessionClientOptions,
  SessionClient,
  ControlStateView,
  ChatMessage,
  CursorUpdate,
} from './client.js';

export { encode, decodeClient, decodeServer } from './protocol.js';
export type {
  ClientMessage,
  ServerMessage,
  ParticipantWire,
  OutputEntryWire,
} from './protocol.js';
