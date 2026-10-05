import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const SECRET_KEYS = /pass(word)?|secret|token|auth|key|credential|cookie/i;
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

/** Removes secrets from structured log fields. Message text must never contain secrets. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactPaths(text: string): string {
  const home = os.homedir();
  return home ? text.split(home).join('~') : text;
}

/** JSON-lines logger with size based rotation. Local only; never uploaded. */
export class Logger {
  private stream: fs.WriteStream | null = null;
  private bytes = 0;

  constructor(
    private readonly dir: string | null,
    private readonly scope = 'app',
    private readonly echo = false,
  ) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.open();
    }
  }

  get file(): string | null {
    return this.dir ? path.join(this.dir, 'drift-studio.log') : null;
  }

  child(scope: string): Logger {
    const child = Object.create(this) as Logger;
    (child as unknown as { scope: string }).scope = scope;
    return child;
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.write('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.write('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.write('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.write('error', msg, fields); }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }

  private open(): void {
    const file = this.file!;
    this.bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  private rotate(): void {
    this.stream?.end();
    const file = this.file!;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
    this.open();
  }

  private write(level: Level, msg: string, fields?: Record<string, unknown>): void {
    const line = JSON.stringify({ t: new Date().toISOString(), level, scope: this.scope, msg, ...(fields ? { f: redact(fields) } : {}) }) + '\n';
    if (this.echo) (level === 'error' ? console.error : console.log)(line.trimEnd());
    if (!this.stream) return;
    if (this.bytes + line.length > MAX_BYTES) this.rotate();
    this.stream.write(line);
    this.bytes += line.length;
  }
}
