import { describe, it, expect } from 'vitest';
import { WriteArbiter, createWriteArbiter } from './arbitration.js';

/**
 * The WriteArbiter is the correctness-critical piece (tech-spec §4). These tests
 * hold the invariants that prevent interleaved-garbage writes to the shared
 * agent: never two drivers, FIFO handoff, no-op release when not driving, and
 * every granted request eventually releasable. The randomized property-ish test
 * asserts the same invariants hold under arbitrary op sequences.
 */

/** Structural invariants that must hold in every state. */
function assertInvariants(a: WriteArbiter): void {
  const s = a.snapshot();
  // I1: at most one driver (representation gives this for free; assert shape).
  expect(s.driverId === null || typeof s.driverId === 'string').toBe(true);
  // I2: the driver is never in the queue.
  if (s.driverId !== null) expect(s.queue).not.toContain(s.driverId);
  // I3: no duplicate queue entries.
  expect(new Set(s.queue).size).toBe(s.queue.length);
}

describe('WriteArbiter — basic grant / queue', () => {
  it('starts idle by default', () => {
    const a = new WriteArbiter();
    expect(a.driver()).toBeNull();
    expect(a.queue()).toEqual([]);
    expect(a.isBusy()).toBe(false);
    assertInvariants(a);
  });

  it('seeds an initial driver', () => {
    const a = new WriteArbiter('host');
    expect(a.driver()).toBe('host');
    expect(a.isDriver('host')).toBe(true);
    expect(a.queue()).toEqual([]);
    assertInvariants(a);
  });

  it('grants immediately when idle', () => {
    const a = new WriteArbiter();
    const s = a.requestControl('alice');
    expect(s.driverId).toBe('alice');
    expect(s.queue).toEqual([]);
    assertInvariants(a);
  });

  it('queues FIFO when busy and never duplicates', () => {
    const a = new WriteArbiter();
    a.requestControl('alice'); // alice drives
    expect(a.requestControl('bob').queue).toEqual(['bob']);
    expect(a.requestControl('carol').queue).toEqual(['bob', 'carol']);
    // duplicate request is a no-op
    expect(a.requestControl('bob').queue).toEqual(['bob', 'carol']);
    // driver re-requesting is a no-op
    expect(a.requestControl('alice').driverId).toBe('alice');
    assertInvariants(a);
  });
});

describe('WriteArbiter — FIFO handoff on release', () => {
  it('releases to the head of the queue in order', () => {
    const a = new WriteArbiter();
    a.requestControl('alice');
    a.requestControl('bob');
    a.requestControl('carol');

    expect(a.release('alice').driverId).toBe('bob');
    expect(a.queue()).toEqual(['carol']);
    assertInvariants(a);

    expect(a.release('bob').driverId).toBe('carol');
    expect(a.queue()).toEqual([]);
    assertInvariants(a);

    // last driver releases → idle
    expect(a.release('carol').driverId).toBeNull();
    expect(a.queue()).toEqual([]);
    assertInvariants(a);
  });

  it('goes idle when the driver releases with an empty queue', () => {
    const a = new WriteArbiter('alice');
    const s = a.release('alice');
    expect(s.driverId).toBeNull();
    expect(s.queue).toEqual([]);
    assertInvariants(a);
  });
});

describe('WriteArbiter — release when not driver is a no-op (I5)', () => {
  it('does nothing if a queued requester releases', () => {
    const a = new WriteArbiter('alice');
    a.requestControl('bob');
    const before = a.snapshot();
    const after = a.release('bob');
    expect(after).toEqual(before); // identical state
    expect(after.driverId).toBe('alice');
    expect(after.queue).toEqual(['bob']);
    assertInvariants(a);
  });

  it('does nothing on release of an unknown id', () => {
    const a = new WriteArbiter('alice');
    expect(a.release('nobody').driverId).toBe('alice');
    assertInvariants(a);
  });

  it('release on an idle arbiter is a no-op', () => {
    const a = new WriteArbiter();
    expect(a.release('ghost').driverId).toBeNull();
    assertInvariants(a);
  });
});

describe('WriteArbiter — every granted request is eventually releasable (I6)', () => {
  it('a granted driver can always release', () => {
    // Seeded idle: alice is granted immediately and can release.
    const idle = new WriteArbiter();
    idle.requestControl('alice');
    expect(idle.isDriver('alice')).toBe(true);
    idle.release('alice');
    expect(idle.isDriver('alice')).toBe(false);
    assertInvariants(idle);

    // Seeded busy (host driving): alice queues, host releases, alice is granted
    // via FIFO handoff and can then release.
    const busy = new WriteArbiter('host');
    busy.requestControl('alice');
    expect(busy.isDriver('alice')).toBe(false); // queued, not driving
    expect(busy.queue()).toEqual(['alice']);
    busy.release('host'); // handoff → alice
    expect(busy.isDriver('alice')).toBe(true);
    busy.release('alice');
    expect(busy.isDriver('alice')).toBe(false); // releasable
    assertInvariants(busy);
  });

  it('after handoff the previous driver is no longer driving', () => {
    const a = new WriteArbiter('alice');
    a.requestControl('bob');
    a.release('alice'); // → bob
    expect(a.isDriver('alice')).toBe(false);
    expect(a.isDriver('bob')).toBe(true);
    a.release('bob');
    expect(a.isDriver('bob')).toBe(false);
    assertInvariants(a);
  });
});

describe('WriteArbiter — explicit grant()', () => {
  it('is a no-op while busy (cooperative turns: release first)', () => {
    const a = new WriteArbiter('alice');
    a.requestControl('bob');
    const s = a.grant();
    expect(s.driverId).toBe('alice'); // unchanged
    expect(s.queue).toEqual(['bob']);
    assertInvariants(a);
  });

  it('grants the queue head when idle', () => {
    const a = new WriteArbiter();
    a.requestControl('bob'); // granted immediately (idle)
    a.release('bob'); // idle again, empty queue
    a.requestControl('carol'); // granted immediately
    a.requestControl('dave'); // queued
    a.release('carol'); // → dave
    a.release('dave'); // idle, empty
    a.requestControl('eve'); // queued? no — idle grants eve
    expect(a.driver()).toBe('eve');
    assertInvariants(a);
  });
});

describe('WriteArbiter — leave / cancelRequest', () => {
  it('leave() on the driver hands off to the next waiter', () => {
    const a = new WriteArbiter('alice');
    a.requestControl('bob');
    a.requestControl('carol');
    expect(a.leave('alice').driverId).toBe('bob');
    expect(a.queue()).toEqual(['carol']);
    assertInvariants(a);
  });

  it('leave() on a queued participant drops them, preserving order', () => {
    const a = new WriteArbiter('alice');
    a.requestControl('bob');
    a.requestControl('carol');
    a.requestControl('dave');
    const s = a.leave('carol');
    expect(s.driverId).toBe('alice');
    expect(s.queue).toEqual(['bob', 'dave']);
    assertInvariants(a);
  });

  it('leave() on an unknown id is a no-op', () => {
    const a = new WriteArbiter('alice');
    expect(a.leave('ghost').driverId).toBe('alice');
    assertInvariants(a);
  });

  it('cancelRequest() drops a queued requester without touching the driver', () => {
    const a = new WriteArbiter('alice');
    a.requestControl('bob');
    const s = a.cancelRequest('bob');
    expect(s.driverId).toBe('alice');
    expect(s.queue).toEqual([]);
    assertInvariants(a);
  });

  it('cancelRequest() on the driver is a no-op', () => {
    const a = new WriteArbiter('alice');
    expect(a.cancelRequest('alice').driverId).toBe('alice');
    assertInvariants(a);
  });
});

describe('WriteArbiter — snapshots are immutable', () => {
  it('mutating a returned queue does not affect internal state', () => {
    const a = new WriteArbiter('alice');
    a.requestControl('bob');
    const s = a.snapshot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s.queue as string[]).push('tampered');
    expect(a.queue()).toEqual(['bob']); // internal untouched
  });
});

describe('WriteArbiter — factory', () => {
  it('createWriteArbiter constructs an equivalent arbiter', () => {
    const a = createWriteArbiter('host');
    expect(a).toBeInstanceOf(WriteArbiter);
    expect(a.driver()).toBe('host');
  });
});

/* ----------------------------- property-ish ----------------------------- */

/** Deterministic seeded PRNG (mulberry32) so the random walk is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ['a', 'b', 'c', 'd', 'e'] as const;

/**
 * Randomized invariant check: apply a long random sequence of requests,
 * releases, grants, leaves, and cancels over a small id pool, and assert the
 * core invariants after every single step. Also verifies the FIFO handoff
 * semantics: whenever a release changes the driver, the new driver is exactly
 * the previous queue head (or null).
 */
describe('WriteArbiter — randomized invariant walk', () => {
  for (const seed of [1, 2, 3, 7, 42, 99, 2024]) {
    it(`holds all invariants across a random op sequence (seed ${seed})`, () => {
      const rand = mulberry32(seed);
      const a = new WriteArbiter(rand() < 0.5 ? null : IDS[Math.floor(rand() * IDS.length)]!);

      for (let step = 0; step < 5000; step++) {
        const before = a.snapshot();
        const op = Math.floor(rand() * 5);
        const id = IDS[Math.floor(rand() * IDS.length)]!;

        switch (op) {
          case 0:
            a.requestControl(id);
            break;
          case 1: {
            const driver = before.driverId;
            if (driver !== null) a.release(driver); // release the (maybe) driver
            else a.release(id); // no-op on idle
            break;
          }
          case 2:
            a.grant();
            break;
          case 3:
            a.leave(id);
            break;
          case 4:
            a.cancelRequest(id);
            break;
        }

        const after = a.snapshot();
        assertInvariants(a); // I1–I3 every step

        // FIFO handoff: if a release changed the driver, the new driver must be
        // the previous queue head (or null when the queue was empty).
        // (Only meaningful when op was a driver release.)
        if (op === 1 && before.driverId !== null) {
          const prevHead = before.queue[0] ?? null;
          if (before.queue.length > 0) {
            expect(after.driverId).toBe(prevHead);
            expect(after.queue).toEqual(before.queue.slice(1));
          } else {
            expect(after.driverId).toBeNull();
            expect(after.queue).toEqual([]);
          }
        }

        // grant() while busy is a no-op (state unchanged).
        if (op === 2 && before.driverId !== null) {
          expect(after).toEqual(before);
        }
      }

      assertInvariants(a);
    });
  }
});
