import { randomUUID } from 'node:crypto';

/** Opaque, sortable-enough IDs with a readable prefix. Never parse them. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
