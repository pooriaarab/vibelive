/**
 * The vibelive wire protocol — three channels over one WebSocket, each with the
 * guarantees its data needs (docs/tech-spec.md §3):
 *
 *   1. Output   — ordered append-log, host is sole author, seq-numbered,
 *                 late joiners get snapshot + tail. (reliable, ordered)
 *   2. Cursor   — ephemeral presence/cursor deltas. Lossy/coalesced is fine;
 *                 the relay forwards as-is for v0.
 *   3. Chat+ctl — reliable, ordered; agent-write is arbitrated (WriteArbiter).
 *
 * Messages are JSON. `kind` discriminates. Client→server and server→client are
 * separate unions so a relay can validate the direction it received.
 */

/** A single retained output chunk on the wire (host-assigned seq). */
export interface OutputEntryWire {
  readonly seq: number;
  readonly text: string;
}

/** A roster entry broadcast as presence. */
export interface ParticipantWire {
  readonly id: string;
  readonly name: string;
}

/* ---------------------------------- client → server ---------------------------------- */

export type ClientMessage =
  | { readonly kind: 'hello'; readonly name: string }
  | { readonly kind: 'chat'; readonly text: string }
  | { readonly kind: 'cursor'; readonly x: number; readonly y: number }
  | { readonly kind: 'control'; readonly action: 'request' | 'release' }
  | { readonly kind: 'input'; readonly text: string };

/* ---------------------------------- server → client ---------------------------------- */

export type ServerMessage =
  | {
      readonly kind: 'snapshot';
      /** This client's own assigned participant id. */
      readonly you: string;
      readonly seq: number;
      readonly entries: readonly OutputEntryWire[];
      readonly participants: readonly ParticipantWire[];
      readonly driverId: string | null;
      readonly queue: readonly string[];
    }
  | { readonly kind: 'output'; readonly seq: number; readonly text: string }
  | {
      readonly kind: 'presence';
      readonly participants: readonly ParticipantWire[];
      readonly driverId: string | null;
    }
  | {
      readonly kind: 'cursor';
      readonly id: string;
      readonly name: string;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly kind: 'chat';
      readonly id: string;
      readonly name: string;
      readonly text: string;
      readonly ts: number;
    }
  | {
      readonly kind: 'control';
      readonly action: 'state';
      readonly driverId: string | null;
      readonly queue: readonly string[];
    }
  | { readonly kind: 'error'; readonly message: string };

/** Encode a message to a JSON string for the wire. */
export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Parse a JSON wire string into a message of the requested direction. */
export function decodeClient(raw: string): ClientMessage {
  return JSON.parse(raw) as ClientMessage;
}

export function decodeServer(raw: string): ServerMessage {
  return JSON.parse(raw) as ServerMessage;
}
