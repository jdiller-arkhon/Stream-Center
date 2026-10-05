import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import { DriftFailure } from './errors';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each stdout chunk (used for ffmpeg -progress). */
  onStdout?: (chunk: string) => void;
  /** Keep only the tail of stderr to bound memory. */
  maxStderrBytes?: number;
  lowPriority?: boolean;
  /** Collect stdout as a Buffer instead of text. */
  binaryStdout?: (chunk: Buffer) => void;
}

/**
 * Runs an executable with an argument array (never a shell string).
 * Resolves with the exit status; rejects only on spawn failure, timeout or abort.
 */
export function run(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { cwd: opts.cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] };
    let child: ChildProcess;
    try {
      child = spawn(file, args as string[], spawnOpts);
    } catch (err) {
      reject(new DriftFailure('IO', `Could not start ${file}`, { detail: String(err), cause: err }));
      return;
    }
    if (opts.lowPriority && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* best effort */
      }
    }
    let stdout = '';
    let stderr = '';
    const maxErr = opts.maxStderrBytes ?? 64 * 1024;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(new DriftFailure('CANCELLED', 'Cancelled')));
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish(() => reject(new DriftFailure('TIMEOUT', `${file} timed out`, { retryable: true })));
        }, opts.timeoutMs)
      : null;
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout!.on('data', (d: Buffer) => {
      if (opts.binaryStdout) return opts.binaryStdout(d);
      const s = d.toString('utf8');
      if (opts.onStdout) opts.onStdout(s);
      else stdout += s;
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > maxErr) stderr = stderr.slice(-maxErr);
    });
    child.on('error', (err) => finish(() => reject(new DriftFailure('IO', `Could not start ${file}`, { detail: err.message, cause: err }))));
    child.on('close', (code, signal) => finish(() => resolve({ code, signal, stdout, stderr })));
  });
}

/** Starts a detached program (game/companion) without waiting for it. */
export function launchDetached(file: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(file, args as string[], { cwd, detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.once('error', (err) => reject(new DriftFailure('LAUNCH_FAILED', `Could not launch ${file}`, { detail: err.message })));
      child.once('spawn', () => {
        child.unref();
        resolve(child.pid ?? -1);
      });
    } catch (err) {
      reject(new DriftFailure('LAUNCH_FAILED', `Could not launch ${file}`, { detail: String(err) }));
    }
  });
}
