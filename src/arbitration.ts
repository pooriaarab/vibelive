/**
 * The one correctness-critical piece of vibelive: who is allowed to write to the
 * shared agent's stdin.
 *
 * Background (see docs/tech-spec.md §4): multiple participants can send prompts
 * to one wrapped agent. Concurrent writes to a single stdin produce interleaved
 * garbage. So exactly one participant — the **driver** — holds the write token at
 * any time. Everyone else always has read + chat + cursor; only agent-write is
 * arbitrated. Turns are cooperative: a driver `release()`s (or the host `grant()`s
 * the next waiter), and requests are served strictly FIFO.
 *
 * This module is **pure logic — no IO**. That makes every invariant below fully
 * unit-testable, which is why src/arbitration.test.ts is the heaviest test file.
 *
 * Invariants (asserted in tests, held by construction here):
 *   I1. At most one driver at any time (`driverId` is a single id or null).
 *   I2. The current driver is never present in the queue.
 *   I3. The queue never contains duplicates.
 *   I4. The queue is served FIFO: the head is granted next.
 *   I5. `release(id)` by a non-driver is a true no-op.
 *   I6. Every granted request is eventually releasable (`release(driver)` always
 *       clears them, handing off to the next waiter or going idle).
 */

/** An immutable view of who controls the shared agent right now. */
export interface ControlState {
  /** The participant id currently holding the write token, or null when idle. */
  readonly driverId: string | null;
  /**
   * Participant ids waiting for the token, in request order (FIFO).
   * Never contains the current driver; never contains duplicates.
   */
  readonly queue: readonly string[];
}

/**
 * State machine enforcing "never two concurrent agent-writers".
 *
 * Transitions are deterministic and side-effect free; each mutator returns a
 * fresh {@link ControlState} snapshot of the resulting state.
 */
export class WriteArbiter {
  #driverId: string | null;
  #queue: string[] = [];

  constructor(initialDriver: string | null = null) {
    this.#driverId = initialDriver;
  }

  /** Current snapshot (defensive copy — callers cannot mutate internal state). */
  snapshot(): ControlState {
    return { driverId: this.#driverId, queue: [...this.#queue] };
  }

  /** The participant id currently holding the write token, or null when idle. */
  driver(): string | null {
    return this.#driverId;
  }

  /** A defensive copy of the pending queue. */
  queue(): readonly string[] {
    return [...this.#queue];
  }

  /** True iff `id` currently holds the write token. */
  isDriver(id: string): boolean {
    return this.#driverId === id;
  }

  /** The shared agent is writable right now (some driver holds the token). */
  isBusy(): boolean {
    return this.#driverId !== null;
  }

  /**
   * Request the write token.
   *
   * - Idle and `id` is not already the driver → grant immediately.
   * - Busy (or `id` already driving) → enqueue `id` unless already queued.
   *
   * Idempotent: requesting when already driving or already queued changes nothing.
   */
  requestControl(id: string): ControlState {
    if (this.#driverId === id) {
      return this.snapshot(); // already driving — no-op
    }
    if (this.#driverId === null) {
      this.#driverId = id; // idle — grant immediately
      return this.snapshot();
    }
    if (!this.#queue.includes(id)) {
      this.#queue.push(id); // busy — FIFO enqueue, no dupes
    }
    return this.snapshot();
  }

  /**
   * Release the write token.
   *
   * - If `id` is the current driver: relinquish, then auto-grant the head of the
   *   queue (FIFO hand-off). Going idle if the queue is empty.
   * - Otherwise: a true no-op (per spec — a queued requester must wait to be
   *   granted before they can release; use {@link cancelRequest} to leave the
   *   queue, or {@link leave} for a full disconnect).
   */
  release(id: string): ControlState {
    if (this.#driverId !== id) {
      return this.snapshot();
    }
    this.#driverId = null;
    this.#grantNext();
    return this.snapshot();
  }

  /**
   * Explicitly grant the token to the head of the queue. Only effective when
   * idle — cooperative turns mean a busy token must be `release()`d first, so
   * `grant()` while busy is a no-op. Returns the resulting snapshot.
   */
  grant(): ControlState {
    if (this.#driverId !== null) return this.snapshot();
    this.#grantNext();
    return this.snapshot();
  }

  /**
   * Remove a participant entirely (e.g. on disconnect).
   * - If they're the driver: release (which hands off to the next waiter).
   * - Else if queued: drop them, preserving the order of everyone else.
   * - Else: no-op.
   */
  leave(id: string): ControlState {
    if (this.#driverId === id) {
      return this.release(id);
    }
    this.#removeFromQueue(id);
    return this.snapshot();
  }

  /**
   * Cancel a pending request without disturbing the current driver.
   * If `id` happens to be driving, this is a no-op (use {@link release}).
   */
  cancelRequest(id: string): ControlState {
    if (this.#driverId === id) return this.snapshot();
    this.#removeFromQueue(id);
    return this.snapshot();
  }

  /** Hand the token to the queue head, if idle and a waiter exists. */
  #grantNext(): void {
    if (this.#driverId !== null) return;
    const next = this.#queue.shift();
    if (next !== undefined) {
      this.#driverId = next;
    }
  }

  #removeFromQueue(id: string): void {
    const i = this.#queue.indexOf(id);
    if (i >= 0) {
      this.#queue.splice(i, 1);
    }
  }
}

/** Construct a {@link WriteArbiter}, optionally seeding an initial driver. */
export function createWriteArbiter(initialDriver: string | null = null): WriteArbiter {
  return new WriteArbiter(initialDriver);
}
