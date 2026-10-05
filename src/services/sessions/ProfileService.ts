import { SessionProfile, type SessionProfileInput, type ValidationIssue } from '../contract/dto';
import type { Db } from '../core/database';
import { fail } from '../core/errors';
import { newId, nowIso } from '../core/ids';
import { isFile } from '../core/paths';
import { validateLaunch } from './launcher';

export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly platform: NodeJS.Platform,
  ) {}

  list(): SessionProfile[] {
    return (this.db.prepare('SELECT doc FROM profiles ORDER BY updated_at DESC').all() as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as SessionProfile);
  }

  get(id: string): SessionProfile {
    const row = this.db.prepare('SELECT doc FROM profiles WHERE id = ?').get(id) as { doc: string } | undefined;
    if (!row) fail('NOT_FOUND', 'Profile not found', { detail: id });
    return JSON.parse(row.doc) as SessionProfile;
  }

  validate(p: SessionProfileInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!p.name.trim()) issues.push({ field: 'name', severity: 'error', message: 'Name is required' });
    const dupName = this.list().find((x) => x.name.toLowerCase() === p.name.trim().toLowerCase() && x.id !== p.id);
    if (dupName) issues.push({ field: 'name', severity: 'warning', message: 'Another profile has the same name' });
    issues.push(...validateLaunch(p.game, this.platform));
    p.companionApps.forEach((c, i) => {
      issues.push(...validateLaunch({ kind: 'executable', path: c.path, args: c.args, processName: c.processName }, this.platform, `companionApps.${i}`));
    });
    if (p.artworkPath && !isFile(p.artworkPath)) issues.push({ field: 'artworkPath', severity: 'warning', message: 'Artwork image not found' });
    if (p.audioPreset) {
      const both = p.audioPreset.mute.filter((n) => p.audioPreset!.unmute.includes(n));
      if (both.length) issues.push({ field: 'audioPreset', severity: 'error', message: `Inputs both muted and unmuted: ${both.join(', ')}` });
    }
    if (p.game.kind === 'none' && !p.obs.startRecording && !p.obs.startReplayBuffer && !p.obs.sceneName) {
      issues.push({ field: 'game', severity: 'warning', message: 'This profile does not launch a game or change OBS.' });
    }
    return issues;
  }

  save(input: SessionProfileInput): SessionProfile {
    const errors = this.validate(input).filter((i) => i.severity === 'error');
    if (errors.length) fail('VALIDATION', errors[0]!.message, { detail: errors.map((e) => `${e.field}: ${e.message}`).join('\n') });
    const now = nowIso();
    const existing = input.id ? this.tryGet(input.id) : null;
    const profile = SessionProfile.parse({
      ...input,
      name: input.name.trim(),
      // Keep a caller-supplied id (the renderer creates its own) so both sides agree.
      id: existing?.id ?? input.id ?? newId('prof'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.db
      .prepare('INSERT INTO profiles(id, doc, updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc, updated_at=excluded.updated_at')
      .run(profile.id, JSON.stringify(profile), profile.updatedAt);
    return profile;
  }

  duplicate(id: string): SessionProfile {
    const p = this.get(id);
    return this.save({ ...p, id: null, name: `${p.name} copy`.slice(0, 80), companionApps: p.companionApps.map((c) => ({ ...c, id: newId('app') })) });
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  private tryGet(id: string): SessionProfile | null {
    try {
      return this.get(id);
    } catch {
      return null;
    }
  }
}
