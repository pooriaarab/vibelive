/**
 * The host (tech-spec §7 build-order step 2): wraps an agent command in a child
 * process, owns the output append-log, and accepts control input. The host is
 * authoritative — its process is the source of truth for the output channel.
 *
 * v0 uses plain pipes (child_process.spawn) rather than a PTY: stdout/stderr are
 * captured into the log and fanned out, stdin accepts bytes from the current
 * driver. A real PTY (node-pty) is the post-v0 path for full TTY semantics
 * (resize, signal handling, raw-mode programs) — noted in the README roadmap.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { OutputLog, type OutputEntry } from './output-log.js';

export interface HostOptions {
  /** The agent command to wrap, e.g. ['claude'] or ['python', '-i']. Non-empty. */
  readonly command: readonly string[];
  /** Working directory for the child. Defaults to cwd(). */
  readonly cwd?: string;
  /** Environment for the child. Defaults to inheriting the host's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Retained output-log capacity. Defaults to 5000 chunks. */
  readonly logCap?: number;
}

export interface HostHandle {
  /** The wrapped command, argv-style (as passed to {@link createHost}). */
  readonly command: readonly string[];
  /** The retained output log (source of truth for snapshot+tail). */
  readonly log: OutputLog;
  /** Latest output seq (0 before any output). */
  readonly seq: number;
  /** Subscribe to every new output entry. Returns an unsubscribe fn. */
  onOutput(cb: (entry: OutputEntry) => void): () => void;
  /** Write bytes to the wrapped agent's stdin. The caller enforces arbitration. */
  sendInput(text: string): void;
  /** Reserved for the future PTY path; a no-op in v0 pipe mode. */
  resize(cols: number, rows: number): void;
  /** Terminate the wrapped agent. */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with the child's exit code (null on signal termination). */
  readonly exited: Promise<number | null>;
  /** The child PID, or null if spawn failed. */
  readonly pid: number | null;
}

function makeOutputEmitter(
  log: OutputLog,
  outputCbs: Set<(entry: OutputEntry) => void>,
): (chunk: Buffer | string) => void {
  return (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length === 0) return;
    const entry = log.append(text);
    for (const cb of outputCbs) cb(entry);
  };
}

function watchChildExit(
  child: ChildProcess,
  bin: string,
  emit: (chunk: Buffer | string) => void,
): Promise<number | null> {
  // Surface spawn failures (ENOENT etc.) in the output log so the host user and
  // every participant sees why the session ended, not a silent exit.
  let spawnFailed = false;
  child.once('error', (err) => {
    spawnFailed = true;
    emit(`[vibelive] failed to start ${bin}: ${err.message}\n`);
  });

  let exitResolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });
  // 'exit' does NOT fire when the spawn itself failed (no process ever existed),
  // only 'close' does — so settle on the first of the two, never both. A failed
  // spawn resolves 127 (shell convention for "command not found") so `vibelive
  // host -- <bogus>` errors out instead of hanging forever.
  let settled = false;
  const settle = (code: number | null): void => {
    if (settled) return;
    settled = true;
    exitResolve(code);
  };
  child.once('exit', (code, signal) => {
    settle(signal ? null : code);
  });
  child.once('close', (code) => {
    settle(spawnFailed ? 127 : code);
  });
  return exited;
}

function makeHostHandle(ctx: {
  command: readonly string[];
  log: OutputLog;
  outputCbs: Set<(entry: OutputEntry) => void>;
  child: ChildProcess;
  exited: Promise<number | null>;
}): HostHandle {
  const { command, log, outputCbs, child, exited } = ctx;
  return {
    command,
    log,
    get seq() {
      return log.seq;
    },
    onOutput(cb) {
      outputCbs.add(cb);
      return () => {
        outputCbs.delete(cb);
      };
    },
    sendInput(text) {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(text);
      }
    },
    resize() {
      /* no-op in v0 pipe mode; reserved for node-pty */
    },
    kill(signal = 'SIGTERM') {
      if (!child.killed) child.kill(signal);
    },
    get pid() {
      return child.pid ?? null;
    },
    exited,
  };
}

/**
 * Spawn the wrapped agent and maintain its output append-log. Output (stdout and
 * stderr) is captured chunk-by-chunk, each chunk becoming one seq-numbered
 * {@link OutputEntry} that every `onOutput` subscriber receives.
 */
export function createHost(options: HostOptions): HostHandle {
  const { command } = options;
  const bin = command[0];
  if (!bin) throw new Error('createHost: command must be a non-empty array');
  const args = command.slice(1);

  const log = new OutputLog(options.logCap);
  const outputCbs = new Set<(entry: OutputEntry) => void>();

  const child: ChildProcess = spawn(bin, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const emit = makeOutputEmitter(log, outputCbs);
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);

  const exited = watchChildExit(child, bin, emit);
  return makeHostHandle({ command, log, outputCbs, child, exited });
}
