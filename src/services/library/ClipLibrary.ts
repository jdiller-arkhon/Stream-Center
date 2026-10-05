import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import type { ClipAsset, ClipImportResult, ClipQuery, Waveform } from '../contract/dto';
import type { Db } from '../core/database';
import { DriftFailure, fail, toDriftError } from '../core/errors';
import type { EventBus } from '../core/events';
import { newId, nowIso } from '../core/ids';
import type { Logger } from '../core/logger';
import { isFile, safeAbsolutePath } from '../core/paths';
import { playbackPlan, type MediaTools } from '../media/ffmpeg';

const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.flv', '.ts', '.m4v', '.avi']);
const HASH_CHUNK = 1024 * 1024;

/** Internal record: the public ClipAsset plus files Drift Studio owns (derived data). */
export interface ClipRecord extends Omit<ClipAsset, 'mediaUrl' | 'playbackUrl' | 'thumbnailUrl'> {
  hasVideo: boolean;
  hasAudio: boolean;
  thumbPath: string | null;
  proxyPath: string | null;
  peaksPath: string | null;
  derivedVersion: number;
}

export interface ImportOptions {
  source: ClipAsset['source'];
  gameTitle?: string | null;
  sessionId?: string | null;
  tags?: string[];
}

export type MediaKind = 'clip' | 'proxy' | 'thumb';

/** Partial content hash: size + first and last MiB. Fast on multi-GB recordings, good enough for duplicate detection. */
export async function partialHash(file: string): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const h = createHash('sha256');
    h.update(String(size));
    const head = Buffer.alloc(Math.min(HASH_CHUNK, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (size > HASH_CHUNK) {
      const tail = Buffer.alloc(Math.min(HASH_CHUNK, size - HASH_CHUNK));
      await fh.read(tail, 0, tail.length, size - tail.length);
      h.update(tail);
    }
    return h.digest('hex').slice(0, 32);
  } finally {
    await fh.close();
  }
}

/** Resolves when the file size has stopped changing (OBS may still be flushing). */
export async function waitForStableFile(file: string, { intervalMs = 400, timeoutMs = 20_000 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    let size = -1;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      /* not yet visible */
    }
    if (size > 0 && size === last) return;
    last = size;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!isFile(file)) fail('MEDIA_MISSING', 'Saved file did not appear on disk', { detail: file, retryable: true });
}

export class ClipLibrary {
  private readonly thumbsDir: string;
  private readonly peaksDir: string;
  readonly proxiesDir: string;
  /** Called when a clip needs a browser-playable proxy. */
  onNeedsProxy: ((clipId: string) => void) | null = null;
  private readonly importing = new Map<string, Promise<ClipImportResult>>();

  constructor(
    private readonly db: Db,
    private readonly tools: MediaTools,
    private readonly bus: EventBus,
    private readonly log: Logger,
    dataDir: string,
  ) {
    this.thumbsDir = path.join(dataDir, 'derived', 'thumbs');
    this.peaksDir = path.join(dataDir, 'derived', 'peaks');
    this.proxiesDir = path.join(dataDir, 'derived', 'proxies');
    for (const d of [this.thumbsDir, this.peaksDir, this.proxiesDir]) fs.mkdirSync(d, { recursive: true });
  }

  // ---- read ---------------------------------------------------------------

  getRecord(id: string): ClipRecord {
    const row = this.db.prepare('SELECT doc FROM clips WHERE id = ?').get(id) as { doc: string } | undefined;
    if (!row) fail('NOT_FOUND', 'Clip not found', { detail: id });
    return JSON.parse(row.doc) as ClipRecord;
  }

  findByPath(p: string): ClipRecord | null {
    const row = this.db.prepare('SELECT doc FROM clips WHERE path = ?').get(path.normalize(p)) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as ClipRecord) : null;
  }

  get(id: string): ClipAsset {
    return toAsset(this.getRecord(id));
  }

  list(q: ClipQuery): { items: ClipAsset[]; total: number } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.gameTitle) (where.push('game_title = ?'), params.push(q.gameTitle));
    if (q.sessionId) (where.push('session_id = ?'), params.push(q.sessionId));
    if (q.favoritesOnly) where.push('favorite = 1');
    if (q.source) (where.push('source = ?'), params.push(q.source));
    const sql = `SELECT doc FROM clips ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY imported_at DESC`;
    let recs = (this.db.prepare(sql).all(...params) as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as ClipRecord);
    if (q.tags.length) recs = recs.filter((r) => q.tags.every((t) => r.tags.includes(t)));
    if (q.search?.trim()) {
      const s = q.search.trim().toLowerCase();
      recs = recs.filter((r) => r.fileName.toLowerCase().includes(s) || (r.gameTitle ?? '').toLowerCase().includes(s) || r.tags.some((t) => t.toLowerCase().includes(s)));
    }
    return { items: recs.slice(q.offset, q.offset + q.limit).map(toAsset), total: recs.length };
  }

  listGames(): string[] {
    return (this.db.prepare('SELECT DISTINCT game_title FROM clips WHERE game_title IS NOT NULL ORDER BY game_title').all() as Array<{ game_title: string }>).map((r) => r.game_title);
  }

  /** Maps a media URL request to a file path. Only library-owned IDs resolve; arbitrary paths never do. */
  resolveMedia(kind: MediaKind, id: string): string | null {
    let rec: ClipRecord;
    try {
      rec = this.getRecord(id);
    } catch {
      return null;
    }
    const p = kind === 'clip' ? rec.path : kind === 'proxy' ? rec.proxyPath : rec.thumbPath;
    return p && isFile(p) ? p : null;
  }

  // ---- import -------------------------------------------------------------

  async importMany(paths: string[], opts: ImportOptions): Promise<ClipImportResult[]> {
    const out: ClipImportResult[] = [];
    for (const p of paths) out.push(await this.importOne(p, opts));
    return out;
  }

  /** Idempotent per path while in flight (OBS events + manual import can race). */
  importOne(rawPath: string, opts: ImportOptions): Promise<ClipImportResult> {
    let p: string;
    try {
      p = safeAbsolutePath(rawPath, 'Clip path');
    } catch (err) {
      return Promise.resolve({ path: rawPath, outcome: 'failed', clipId: null, error: toDriftError(err) });
    }
    const existing = this.importing.get(p);
    if (existing) return existing;
    const task = this.doImport(p, opts).finally(() => this.importing.delete(p));
    this.importing.set(p, task);
    return task;
  }

  private async doImport(p: string, opts: ImportOptions): Promise<ClipImportResult> {
    try {
      if (!MEDIA_EXTENSIONS.has(path.extname(p).toLowerCase())) fail('VALIDATION', 'Unsupported file type', { detail: path.extname(p) });
      if (!isFile(p)) fail('MEDIA_MISSING', 'File not found', { detail: p });
      const byPath = this.findByPath(p);
      if (byPath) return { path: p, outcome: 'duplicate', clipId: byPath.id, error: null };
      const hash = await partialHash(p);
      const dup = this.db.prepare('SELECT id FROM clips WHERE content_hash = ?').get(hash) as { id: string } | undefined;
      if (dup) {
        const dupRec = this.getRecord(dup.id);
        if (dupRec.status === 'missing') {
          // Same content reappeared at a new location: relink instead of duplicating.
          await this.relink(dup.id, p);
          return { path: p, outcome: 'duplicate', clipId: dup.id, error: null };
        }
        return { path: p, outcome: 'duplicate', clipId: dup.id, error: null };
      }
      const probe = await this.tools.probe(p);
      const st = await fs.promises.stat(p);
      const id = newId('clip');
      const plan = playbackPlan(probe);
      const rec: ClipRecord = {
        id,
        path: p,
        fileName: path.basename(p),
        sizeBytes: st.size,
        contentHash: hash,
        durationMs: probe.durationMs,
        width: probe.video?.width ?? null,
        height: probe.video?.height ?? null,
        fps: probe.video?.fps ?? null,
        videoCodec: probe.video?.codec ?? null,
        audioCodec: probe.audio?.codec ?? null,
        audioChannels: probe.audio?.channels ?? null,
        container: probe.container,
        source: opts.source,
        gameTitle: opts.gameTitle ?? null,
        sessionId: opts.sessionId ?? null,
        tags: opts.tags ?? [],
        favorite: false,
        status: 'ok',
        statusDetail: null,
        fileCreatedAt: (st.birthtimeMs ? st.birthtime : st.mtime).toISOString(),
        importedAt: nowIso(),
        playback: plan === 'direct' ? 'direct' : 'proxy-pending',
        hasVideo: probe.video !== null,
        hasAudio: probe.audio !== null,
        thumbPath: null,
        proxyPath: null,
        peaksPath: null,
        derivedVersion: 1,
      };
      if (rec.hasVideo) {
        const thumb = path.join(this.thumbsDir, `${id}.jpg`);
        const at = Math.min(Math.max(0, probe.durationMs * 0.4), Math.max(0, probe.durationMs - 100));
        if (await this.tools.thumbnail(p, thumb, at).catch(() => false)) rec.thumbPath = thumb;
      }
      this.insert(rec);
      this.log.info('clip imported', { id, source: opts.source, durationMs: rec.durationMs });
      const asset = toAsset(rec);
      this.bus.emit('clip.added', asset);
      if (rec.playback === 'proxy-pending') this.onNeedsProxy?.(id);
      return { path: p, outcome: 'imported', clipId: id, error: null };
    } catch (err) {
      this.log.warn('clip import failed', { error: toDriftError(err) });
      return { path: p, outcome: 'failed', clipId: null, error: toDriftError(err) };
    }
  }

  // ---- mutate -------------------------------------------------------------

  update(id: string, patch: { tags?: string[]; favorite?: boolean; gameTitle?: string | null }): ClipAsset {
    const rec = this.getRecord(id);
    if (patch.tags) rec.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
    if (patch.favorite !== undefined) rec.favorite = patch.favorite;
    if (patch.gameTitle !== undefined) rec.gameTitle = patch.gameTitle;
    return this.save(rec);
  }

  setSession(id: string, sessionId: string | null, gameTitle: string | null): void {
    const rec = this.getRecord(id);
    rec.sessionId = sessionId;
    if (gameTitle && !rec.gameTitle) rec.gameTitle = gameTitle;
    this.save(rec);
  }

  setProxy(id: string, proxyPath: string | null, playback: ClipAsset['playback']): ClipAsset {
    const rec = this.getRecord(id);
    rec.proxyPath = proxyPath;
    rec.playback = playback;
    rec.derivedVersion++;
    return this.save(rec);
  }

  async relink(id: string, rawPath: string): Promise<ClipAsset> {
    const p = safeAbsolutePath(rawPath, 'Clip path');
    const rec = this.getRecord(id);
    if (!isFile(p)) fail('MEDIA_MISSING', 'File not found', { detail: p });
    const other = this.findByPath(p);
    if (other && other.id !== id) fail('CONFLICT', 'That file is already in the library as another clip');
    const hash = await partialHash(p);
    const probe = await this.tools.probe(p);
    if (hash !== rec.contentHash && Math.abs(probe.durationMs - rec.durationMs) > 500) {
      fail('VALIDATION', 'That file does not look like the missing clip (different content and duration)');
    }
    rec.path = p;
    rec.fileName = path.basename(p);
    rec.status = 'ok';
    rec.statusDetail = hash === rec.contentHash ? null : 'Relinked to a file with matching duration but different content';
    rec.contentHash = hash;
    return this.save(rec);
  }

  /** Checks every clip still exists on disk and flags missing ones for recovery. */
  verifyAll(): { checked: number; missing: number } {
    const rows = this.db.prepare('SELECT doc FROM clips').all() as Array<{ doc: string }>;
    let missing = 0;
    for (const r of rows) {
      const rec = JSON.parse(r.doc) as ClipRecord;
      const exists = isFile(rec.path);
      if (!exists) missing++;
      const status = exists ? 'ok' : 'missing';
      if (rec.status !== status && rec.status !== 'error') {
        rec.status = status;
        rec.statusDetail = exists ? null : 'The original file was moved or deleted. Relink it to keep editing.';
        this.save(rec);
      }
    }
    return { checked: rows.length, missing };
  }

  /** Removes the clip from the library and deletes only Drift-owned derived files. */
  remove(id: string): void {
    const rec = this.getRecord(id);
    for (const f of [rec.thumbPath, rec.proxyPath, rec.peaksPath]) if (f) fs.promises.rm(f, { force: true }).catch(() => {});
    this.db.prepare('DELETE FROM clips WHERE id = ?').run(id);
  }

  async waveform(id: string, resolution: number): Promise<Waveform> {
    const rec = this.getRecord(id);
    if (rec.status !== 'ok') fail('MEDIA_MISSING', 'Clip file is missing', { detail: rec.path });
    const base = 100;
    let peaks: Uint8Array;
    if (rec.peaksPath && isFile(rec.peaksPath)) {
      peaks = new Uint8Array(await fs.promises.readFile(rec.peaksPath));
    } else {
      peaks = rec.hasAudio ? await this.tools.peaks(rec.path, base) : new Uint8Array();
      const file = path.join(this.peaksDir, `${id}.u8`);
      await fs.promises.writeFile(file, peaks);
      rec.peaksPath = file;
      this.save(rec, false);
    }
    const step = Math.max(1, Math.round(base / resolution));
    const out: number[] = [];
    for (let i = 0; i < peaks.length; i += step) {
      let mx = 0;
      for (let j = i; j < Math.min(i + step, peaks.length); j++) mx = Math.max(mx, peaks[j]!);
      out.push(Math.round((mx / 255) * 1000) / 1000);
    }
    return { clipId: id, resolution: Math.round(base / step), peaks: out, durationMs: rec.durationMs };
  }

  // ---- storage ------------------------------------------------------------

  private insert(rec: ClipRecord): void {
    this.db
      .prepare('INSERT INTO clips(id, path, content_hash, game_title, session_id, favorite, source, imported_at, doc) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(rec.id, rec.path, rec.contentHash, rec.gameTitle, rec.sessionId, rec.favorite ? 1 : 0, rec.source, rec.importedAt, JSON.stringify(rec));
  }

  private save(rec: ClipRecord, emit = true): ClipAsset {
    const res = this.db
      .prepare('UPDATE clips SET path=?, content_hash=?, game_title=?, session_id=?, favorite=?, doc=? WHERE id=?')
      .run(rec.path, rec.contentHash, rec.gameTitle, rec.sessionId, rec.favorite ? 1 : 0, JSON.stringify(rec), rec.id);
    if (res.changes === 0) throw new DriftFailure('NOT_FOUND', 'Clip not found');
    const asset = toAsset(rec);
    if (emit) this.bus.emit('clip.updated', asset);
    return asset;
  }
}

export function toAsset(rec: ClipRecord): ClipAsset {
  const { hasVideo: _v, hasAudio: _a, thumbPath, proxyPath, peaksPath: _p, derivedVersion, ...pub } = rec;
  const mediaUrl = `drift-media://clip/${rec.id}`;
  return {
    ...pub,
    mediaUrl,
    playbackUrl: rec.playback === 'direct' ? mediaUrl : rec.playback === 'proxy' && proxyPath ? `drift-media://proxy/${rec.id}?v=${derivedVersion}` : null,
    thumbnailUrl: thumbPath ? `drift-media://thumb/${rec.id}?v=${derivedVersion}` : null,
  };
}
