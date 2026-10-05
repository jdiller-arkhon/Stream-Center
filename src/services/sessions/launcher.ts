import path from 'node:path';
import type { GameLaunch, ValidationIssue } from '../contract/dto';
import { fail } from '../core/errors';
import { isFile } from '../core/paths';
import { launchDetached, run } from '../core/proc';

/**
 * Launcher URI schemes Drift Studio will hand to the OS. Anything else is rejected,
 * so a profile can never be used to open arbitrary protocol handlers.
 */
export const ALLOWED_URI_SCHEMES = ['steam', 'com.epicgames.launcher', 'uplay', 'origin', 'origin2', 'battlenet', 'link2ea', 'heroic', 'goggalaxy'] as const;

export function validateUri(uri: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'Not a valid URI';
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (!(ALLOWED_URI_SCHEMES as readonly string[]).includes(scheme)) {
    return `Unsupported launcher. Allowed: ${ALLOWED_URI_SCHEMES.map((s) => s + '://').join(', ')}`;
  }
  if (/[\s"'`<>|]/.test(uri)) return 'URI contains characters that are not allowed';
  return null;
}

export function validateExecutable(p: string, platform: NodeJS.Platform): string | null {
  if (!path.isAbsolute(p)) return 'Path must be absolute';
  if (!isFile(p)) return 'File not found';
  const ext = path.extname(p).toLowerCase();
  if (platform === 'win32' && ext !== '.exe' && ext !== '.lnk') return 'Choose an .exe or a .lnk shortcut (scripts such as .bat are not launched)';
  return null;
}

export function processNameFor(launch: GameLaunch): string | null {
  if (launch.kind === 'none') return null;
  if (launch.processName) return launch.processName;
  if (launch.kind === 'executable' && path.extname(launch.path).toLowerCase() !== '.lnk') return path.basename(launch.path);
  return null;
}

export function validateLaunch(launch: GameLaunch, platform: NodeJS.Platform, field = 'game'): ValidationIssue[] {
  if (launch.kind === 'none') return [];
  if (launch.kind === 'uri') {
    const e = validateUri(launch.uri);
    const issues: ValidationIssue[] = e ? [{ field: `${field}.uri`, severity: 'error', message: e }] : [];
    if (!launch.processName) issues.push({ field: `${field}.processName`, severity: 'warning', message: 'Without a process name Drift Studio cannot detect that the game is already running.' });
    return issues;
  }
  const e = validateExecutable(launch.path, platform);
  return e ? [{ field: `${field}.path`, severity: 'error', message: e }] : [];
}

/** Process detection by image name, using OS tools only (no process memory access). */
export async function isProcessRunning(name: string, platform: NodeJS.Platform): Promise<boolean | null> {
  try {
    if (platform === 'win32') {
      const r = await run('tasklist.exe', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${name}`], { timeoutMs: 8000 });
      if (r.code !== 0) return null;
      return r.stdout.toLowerCase().includes(`"${name.toLowerCase()}"`);
    }
    const r = await run('ps', ['-A', '-o', 'comm='], { timeoutMs: 8000 });
    if (r.code !== 0) return null;
    const target = name.toLowerCase();
    return r.stdout.split('\n').some((l) => path.basename(l.trim()).toLowerCase() === target);
  } catch {
    return null;
  }
}

export interface LaunchHost {
  openExternal(uri: string): Promise<void>;
  openPath(p: string): Promise<string>;
}

export async function launch(target: { kind: 'executable'; path: string; args: string[] } | { kind: 'uri'; uri: string }, host: LaunchHost, platform: NodeJS.Platform): Promise<string> {
  if (target.kind === 'uri') {
    const e = validateUri(target.uri);
    if (e) fail('VALIDATION', e);
    await host.openExternal(target.uri);
    return `Opened ${new URL(target.uri).protocol}// launcher`;
  }
  const e = validateExecutable(target.path, platform);
  if (e) fail('VALIDATION', e, { detail: target.path });
  if (path.extname(target.path).toLowerCase() === '.lnk') {
    const err = await host.openPath(target.path);
    if (err) fail('LAUNCH_FAILED', 'Windows could not open the shortcut', { detail: err });
    return 'Opened shortcut';
  }
  const pid = await launchDetached(target.path, target.args, path.dirname(target.path));
  return `Started (pid ${pid})`;
}
