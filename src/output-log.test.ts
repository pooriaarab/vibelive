import { describe, it, expect } from 'vitest';
import { OutputLog } from './output-log.js';

/**
 * The output channel is an ordered append-log (tech-spec §3 channel 1). These
 * tests pin ordering, monotonic seq, snapshot+tail for late joiners, the rolling
 * cap, and idempotent ingest of host-authored entries.
 */
describe('OutputLog — append + ordering', () => {
  it('assigns monotonically increasing seqs starting at 1', () => {
    const log = new OutputLog();
    expect(log.seq).toBe(0);
    expect(log.size).toBe(0);

    const e1 = log.append('hello');
    const e2 = log.append('world');
    expect(e1).toEqual({ seq: 1, text: 'hello' });
    expect(e2).toEqual({ seq: 2, text: 'world' });
    expect(log.seq).toBe(2);
  });

  it('snapshot preserves insertion order', () => {
    const log = new OutputLog();
    log.append('a');
    log.append('b');
    log.append('c');
    expect(log.snapshot().map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(log.snapshot().map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('OutputLog — tail + since (late-joiner catch-up)', () => {
  it('tail(afterSeq) returns only newer entries', () => {
    const log = new OutputLog();
    for (const t of ['a', 'b', 'c', 'd']) log.append(t);
    expect(log.tail(2).map((e) => e.text)).toEqual(['c', 'd']);
    expect(log.tail(0).map((e) => e.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(log.tail(4)).toEqual([]);
  });

  it('since(0) returns the whole retained log with the latest seq', () => {
    const log = new OutputLog();
    log.append('x');
    log.append('y');
    const snap = log.since(0);
    expect(snap.seq).toBe(2);
    expect(snap.entries.map((e) => e.text)).toEqual(['x', 'y']);
  });

  it('since(afterSeq) returns the tail slice', () => {
    const log = new OutputLog();
    for (const t of ['a', 'b', 'c']) log.append(t);
    const snap = log.since(1);
    expect(snap.seq).toBe(3);
    expect(snap.entries.map((e) => e.text)).toEqual(['b', 'c']);
  });
});

describe('OutputLog — rolling cap keeps seq climbing', () => {
  it('evicts oldest beyond cap but seq never goes backwards', () => {
    const log = new OutputLog(3);
    log.append('a'); // seq 1
    log.append('b'); // seq 2
    log.append('c'); // seq 3
    log.append('d'); // seq 4 — evicts 'a'
    log.append('e'); // seq 5 — evicts 'b'

    expect(log.size).toBe(3);
    expect(log.seq).toBe(5);
    expect(log.snapshot().map((e) => e.text)).toEqual(['c', 'd', 'e']);
    expect(log.snapshot().map((e) => e.seq)).toEqual([3, 4, 5]);

    // a late joiner still gets a consistent tail relative to seq.
    const snap = log.since(0);
    expect(snap.seq).toBe(5);
    expect(snap.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('cap is at least 1', () => {
    const log = new OutputLog(0);
    log.append('a');
    log.append('b');
    expect(log.size).toBe(1);
    expect(log.snapshot().map((e) => e.text)).toEqual(['b']);
    expect(log.seq).toBe(2);
  });
});

describe('OutputLog — ingest (host-authored entries)', () => {
  it('stores a newer entry and advances seq', () => {
    const log = new OutputLog();
    const stored = log.ingest({ seq: 7, text: 'host' });
    expect(stored).not.toBeNull();
    expect(log.seq).toBe(7);
    expect(log.snapshot().map((e) => e.text)).toEqual(['host']);
  });

  it('ignores stale or duplicate seqs (idempotent, monotonic)', () => {
    const log = new OutputLog();
    log.ingest({ seq: 5, text: 'a' });
    expect(log.ingest({ seq: 5, text: 'a' })).toBeNull(); // dup
    expect(log.ingest({ seq: 4, text: 'old' })).toBeNull(); // stale
    expect(log.seq).toBe(5);
    expect(log.snapshot().map((e) => e.text)).toEqual(['a']);
  });

  it('stores strictly-increasing seqs in order', () => {
    const log = new OutputLog();
    log.ingest({ seq: 10, text: 'x' });
    log.ingest({ seq: 11, text: 'y' });
    expect(log.snapshot().map((e) => e.seq)).toEqual([10, 11]);
    expect(log.since(10).entries.map((e) => e.text)).toEqual(['y']);
  });
});

describe('OutputLog — clear', () => {
  it('drops retained history but keeps seq climbing', () => {
    const log = new OutputLog();
    log.append('a');
    log.append('b');
    log.clear();
    expect(log.size).toBe(0);
    expect(log.seq).toBe(2);
    expect(log.snapshot()).toEqual([]);
    log.append('c');
    expect(log.snapshot().map((e) => e.seq)).toEqual([3]);
  });
});
