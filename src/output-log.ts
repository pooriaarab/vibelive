/**
 * The host output channel (tech-spec §3, channel 1): an ordered, sequence-
 * numbered append-log of which the host is the sole author. NOT a CRDT — there
 * are no concurrent writers, just a monotonic log. Late joiners receive a
 * snapshot of retained history plus a live tail.
 *
 * Pure data structure — no IO — so ordering / snapshot+tail / cap behaviour is
 * fully unit-testable (see src/output-log.test.ts).
 *
 * The log is a rolling buffer: beyond `cap` entries the oldest are evicted, but
 * `seq` keeps climbing so a late joiner's snapshot+tail never goes backwards.
 */
export interface OutputEntry {
  /** Monotonic sequence number assigned by the author (the host). */
  readonly seq: number;
  /** A chunk of agent output (stdout/stderr bytes, UTF-8). */
  readonly text: string;
}

/** A retained-history slice plus the latest seq, for late-joiner catch-up. */
export interface OutputSnapshot {
  /** Latest seq the log knows about (0 when nothing has been appended). */
  readonly seq: number;
  readonly entries: readonly OutputEntry[];
}

export class OutputLog {
  readonly #cap: number;
  #seq = 0;
  #entries: OutputEntry[] = [];

  constructor(cap = 5000) {
    this.#cap = Math.max(1, cap);
  }

  /** Latest seq (0 when empty). */
  get seq(): number {
    return this.#seq;
  }

  /** Number of entries currently retained (≤ cap). */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Append a new chunk authored locally, auto-assigning the next seq.
   * Used when the log owner is the source of truth (the host, or a relay with
   * no wired host in tests).
   */
  append(text: string): OutputEntry {
    this.#seq += 1;
    const entry: OutputEntry = { seq: this.#seq, text };
    this.#push(entry);
    return entry;
  }

  /**
   * Ingest an entry that already carries an author-assigned seq (the host's).
   * Updates the high-water `seq` and stores the entry iff it is newer than
   * anything seen — so retries / duplicates are idempotent and out-of-order
   * delivery cannot move the log backwards.
   */
  ingest(entry: OutputEntry): OutputEntry | null {
    if (entry.seq <= this.#seq) {
      return null; // stale or duplicate — ignore, keep monotonic
    }
    this.#seq = entry.seq;
    this.#push(entry);
    return entry;
  }

  /** All retained entries (oldest → newest). */
  snapshot(): readonly OutputEntry[] {
    return [...this.#entries];
  }

  /** Retained entries whose seq is strictly greater than `afterSeq`. */
  tail(afterSeq: number): readonly OutputEntry[] {
    const out: OutputEntry[] = [];
    for (const e of this.#entries) {
      if (e.seq > afterSeq) out.push(e);
    }
    return out;
  }

  /**
   * Late-joiner catch-up bundle: everything retained at/after `afterSeq`
   * together with the latest seq. `since(0)` returns the whole retained log.
   */
  since(afterSeq: number): OutputSnapshot {
    const entries = afterSeq <= 0 ? this.snapshot() : this.tail(afterSeq);
    return { seq: this.#seq, entries };
  }

  /** Drop retained history; `seq` keeps climbing to preserve global ordering. */
  clear(): void {
    this.#entries = [];
  }

  #push(entry: OutputEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#cap) {
      this.#entries.splice(0, this.#entries.length - this.#cap);
    }
  }
}
