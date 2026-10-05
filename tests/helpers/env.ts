import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PickPathRequest } from '../../src/services/contract/dto';
import { DriftCore, type CoreOptions } from '../../src/services/DriftCore';
import { MemorySecretStore, type Platform } from '../../src/services/core/platform';

export function tempDir(prefix = 'drift-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestPlatform extends Platform {
  opened: string[];
  externals: string[];
  revealed: string[];
  shortcutsRegistered: Map<string, () => void>;
  pickResult: string[];
}

export function testPlatform(dir: string, overrides: Partial<Platform> = {}): TestPlatform {
  const shortcutsRegistered = new Map<string, () => void>();
  const p: TestPlatform = {
    os: process.platform,
    appVersion: '0.0.0-test',
    dataDir: path.join(dir, 'data'),
    logsDir: path.join(dir, 'logs'),
    opened: [],
    externals: [],
    revealed: [],
    pickResult: [],
    shortcutsRegistered,
    secrets: new MemorySecretStore(true),
    async openExternal(uri) {
      p.externals.push(uri);
    },
    async openPath(f) {
      p.opened.push(f);
      return '';
    },
    showItemInFolder(f) {
      p.revealed.push(f);
    },
    async pickPath(_req: PickPathRequest) {
      return p.pickResult;
    },
    shortcuts: {
      register(acc, cb) {
        if (acc === 'CommandOrControl+Alt+Taken') return false;
        shortcutsRegistered.set(acc, cb);
        return true;
      },
      unregister(acc) {
        shortcutsRegistered.delete(acc);
      },
      unregisterAll() {
        shortcutsRegistered.clear();
      },
    },
    ...overrides,
  };
  return p;
}

export function makeCore(dir: string, opts: Partial<CoreOptions> = {}): { core: DriftCore; platform: TestPlatform } {
  const platform = (opts.platform as TestPlatform) ?? testPlatform(dir);
  const core = new DriftCore({ databaseFile: path.join(dir, 'data', 'test.db'), ...opts, platform });
  return { core, platform };
}

/**
 * Generates a test clip with ffmpeg: a moving test pattern with a burnt-in timer and
 * a 440 Hz tone with a 1 kHz blip every second (for sync/duration checks).
 */
export function generateClip(file: string, seconds = 6, opts: { container?: 'mp4' | 'mkv'; audio?: boolean; size?: string; fps?: number } = {}): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const size = opts.size ?? '640x360';
  const fps = opts.fps ?? 30;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`];
  if (opts.audio !== false) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(fps));
  if (opts.audio !== false) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest');
  args.push(file);
  execFileSync('ffmpeg', args);
  return file;
}

export async function waitFor<T>(fn: () => T | Promise<T>, { timeoutMs = 20_000, intervalMs = 50 } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ''}`);
}

export function ok<T>(r: { ok: true; data: T } | { ok: false; error: { code: string; message: string; detail: string | null } }): T {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.message}${r.error.detail ? ` (${r.error.detail})` : ''}`);
  return r.data;
}
