import { describe, it, expect, afterEach } from 'vitest';
import { createHost, type HostHandle } from './host.js';

/**
 * Host tests spawn REAL child processes (the node binary running -e scripts) —
 * no mocks. The wrapped-agent path is the product's core, so it is exercised
 * end-to-end: spawn → output capture → stdin forwarding → exit.
 */

const NODE = process.execPath;

let host: HostHandle | null = null;

afterEach(() => {
  host?.kill();
  host = null;
});

/** Reject if `p` doesn't settle in time, so a hang fails loudly instead of stalling CI. */
function withTimeout<T>(p: Promise<T>, ms = 5000, what = 'operation'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

/** Resolve once the retained log contains `needle` (checking existing entries too). */
function waitForOutput(h: HostHandle, needle: string, ms = 5000): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      let seen = h.log
        .snapshot()
        .map((e) => e.text)
        .join('');
      if (seen.includes(needle)) {
        resolve(seen);
        return;
      }
      h.onOutput((e) => {
        seen += e.text;
        if (seen.includes(needle)) resolve(seen);
      });
    }),
    ms,
    `output containing ${JSON.stringify(needle)}`,
  );
}

describe('host — real child process wrapping', () => {
  it('captures stdout and stderr as seq-numbered log entries, exit code 0', async () => {
    host = createHost({
      command: [NODE, '-e', 'console.log("hello-out"); console.error("hello-err")'],
    });
    const text = await waitForOutput(host, 'hello-err');
    expect(text).toContain('hello-out');
    // Entries are ordered and seq-numbered from 1.
    const seqs = host.log.snapshot().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    await expect(withTimeout(host.exited, 5000, 'host.exited')).resolves.toBe(0);
  });

  it('propagates a non-zero exit code', async () => {
    host = createHost({ command: [NODE, '-e', 'process.exit(3)'] });
    await expect(withTimeout(host.exited, 5000, 'host.exited')).resolves.toBe(3);
  });

  it('sendInput reaches the wrapped agent stdin and its response comes back as output', async () => {
    host = createHost({
      command: [NODE, '-e', 'process.stdin.on("data", (d) => process.stdout.write("echo:" + d))'],
    });
    host.sendInput('ping\n');
    const text = await waitForOutput(host, 'echo:ping');
    expect(text).toContain('echo:ping');
    host.kill();
    // SIGTERM → null exit code (signal termination).
    await expect(withTimeout(host.exited, 5000, 'host.exited')).resolves.toBeNull();
  });

  it('a bogus command settles exited (127) instead of hanging forever', async () => {
    host = createHost({ command: ['vibelive-definitely-not-a-real-binary-xyz'] });
    // Regression: 'exit' does not fire when spawn itself fails, only 'close' does.
    await expect(withTimeout(host.exited, 5000, 'host.exited')).resolves.toBe(127);
    const text = host.log
      .snapshot()
      .map((e) => e.text)
      .join('');
    expect(text).toMatch(/failed to start/);
  });

  it('kill() terminates a long-running child', async () => {
    host = createHost({ command: [NODE, '-e', 'setInterval(() => {}, 1000)'] });
    host.kill('SIGTERM');
    await expect(withTimeout(host.exited, 5000, 'host.exited')).resolves.toBeNull();
  });
});
