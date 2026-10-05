import fs from 'node:fs';
import path from 'node:path';
import { fail } from './errors';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Ensures a renderer-supplied path is absolute, normalized and free of NUL bytes. */
export function safeAbsolutePath(p: string, label = 'Path'): string {
  if (p.includes('\0')) fail('VALIDATION', `${label} contains invalid characters`);
  if (!path.isAbsolute(p)) fail('VALIDATION', `${label} must be an absolute path`, { detail: p });
  if (/^\\\\[?.]\\/.test(p)) fail('VALIDATION', `${label} uses an unsupported device path`);
  return path.normalize(p);
}

/** Turns a user-provided title into a safe file name stem (no extension). */
export function sanitizeFileStem(name: string): string {
  let s = name
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!s) s = 'clip';
  if (WINDOWS_RESERVED.test(s)) s = `${s}_`;
  return s.slice(0, 100);
}

/** Returns `dir/stem.ext`, or `dir/stem (2).ext`... if taken. */
export function collisionSafePath(dir: string, stem: string, ext: string): string {
  let candidate = path.join(dir, `${stem}${ext}`);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (i > 9999) fail('CONFLICT', 'Could not find a free file name');
  }
  return candidate;
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function diskStatus(p: string): Promise<{ path: string; freeBytes: number; totalBytes: number } | null> {
  let probe = p;
  // statfs requires an existing path; walk up to the nearest existing ancestor.
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const s = await fs.promises.statfs(probe);
    return { path: p, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}
