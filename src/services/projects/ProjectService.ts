import { EditProject, type ProjectSummary } from '../../shared/contracts';
import { DEFAULT_CAPTION_STYLE, EXPORT_PRESETS } from '../../shared/defaults';
import type { Db } from '../core/database';
import { fail } from '../core/errors';
import { newId, nowIso } from '../core/ids';
import type { ClipLibrary } from '../library/ClipLibrary';
import { projectDurationMs } from '../media/exportBuilder';

/** Non-destructive edit projects. Media originals are never modified; edits are metadata. */
export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly library: ClipLibrary,
  ) {}

  list(): ProjectSummary[] {
    const rows = this.db.prepare('SELECT doc FROM projects ORDER BY updated_at DESC').all() as Array<{ doc: string }>;
    return rows.map((r) => {
      const p = JSON.parse(r.doc) as EditProject;
      return {
        id: p.id,
        name: p.name,
        revision: p.revision,
        durationMs: projectDurationMs(p),
        clipIds: [...new Set(p.tracks[0]!.items.map((i) => i.clipId))],
        aspect: p.aspect,
        updatedAt: p.updatedAt,
      };
    });
  }

  get(id: string): EditProject {
    const row = this.db.prepare('SELECT doc FROM projects WHERE id = ?').get(id) as { doc: string } | undefined;
    if (!row) fail('NOT_FOUND', 'Project not found', { detail: id });
    return JSON.parse(row.doc) as EditProject;
  }

  createFromClip(clipId: string, name: string | null): EditProject {
    const clip = this.library.getRecord(clipId);
    const now = nowIso();
    const project: EditProject = {
      id: newId('proj'),
      name: (name?.trim() || clip.fileName.replace(/\.[^.]+$/, '')).slice(0, 120),
      revision: 1,
      tracks: [
        {
          id: newId('trk'),
          kind: 'main',
          muted: false,
          items: [{ id: newId('itm'), clipId, sourceInMs: 0, sourceOutMs: clip.durationMs, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }],
        },
      ],
      aspect: '16:9',
      crop: null,
      webcam: null,
      captions: [],
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      music: null,
      originalAudioGainDb: 0,
      videoFadeInMs: 0,
      videoFadeOutMs: 0,
      presetId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare('INSERT INTO projects(id, revision, updated_at, doc) VALUES(?,?,?,?)').run(project.id, project.revision, project.updatedAt, JSON.stringify(project));
    return project;
  }

  /**
   * Optimistic concurrency: `project.revision` must equal the stored revision.
   * Returns the stored project with revision + 1.
   */
  save(input: EditProject): EditProject {
    const project = EditProject.parse(input);
    const stored = this.get(project.id);
    if (stored.revision !== project.revision) {
      fail('CONFLICT', 'This project was changed elsewhere. Reload it before saving.', { detail: `stored=${stored.revision} incoming=${project.revision}` });
    }
    this.validate(project);
    const next: EditProject = { ...project, createdAt: stored.createdAt, revision: stored.revision + 1, updatedAt: nowIso() };
    this.db.prepare('UPDATE projects SET revision=?, updated_at=?, doc=? WHERE id=?').run(next.revision, next.updatedAt, JSON.stringify(next), next.id);
    return next;
  }

  applyPreset(id: string, presetId: string): EditProject {
    const preset = EXPORT_PRESETS.find((p) => p.id === presetId) ?? fail('NOT_FOUND', 'Preset not found');
    const p = this.get(id);
    return this.save({
      ...p,
      presetId,
      aspect: preset.settings.aspect,
      videoFadeInMs: preset.projectDefaults.videoFadeInMs,
      videoFadeOutMs: preset.projectDefaults.videoFadeOutMs,
      originalAudioGainDb: preset.projectDefaults.originalAudioGainDb,
      captionStyle: preset.projectDefaults.captionStyle ?? p.captionStyle,
      // A crop drawn for a different aspect would letterbox; fall back to auto center crop.
      crop: p.aspect === preset.settings.aspect ? p.crop : null,
    });
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  private validate(p: EditProject): void {
    const items = p.tracks[0]!.items;
    const ids = new Set<string>();
    items.forEach((it, i) => {
      if (ids.has(it.id)) fail('VALIDATION', `Duplicate timeline item id at position ${i + 1}`);
      ids.add(it.id);
      const clip = this.library.getRecord(it.clipId);
      if (it.sourceOutMs <= it.sourceInMs) fail('VALIDATION', `Segment ${i + 1}: out point must be after in point`);
      if (it.sourceInMs >= clip.durationMs) fail('VALIDATION', `Segment ${i + 1}: in point is past the end of the clip`);
      if (it.sourceOutMs > clip.durationMs + 50) fail('VALIDATION', `Segment ${i + 1}: out point is past the end of the clip`);
    });
    for (const c of p.captions) {
      if (c.endMs <= c.startMs) fail('VALIDATION', 'Each caption must end after it starts');
    }
    if (p.webcam?.enabled) {
      const r = p.webcam.placement;
      if (r.x + r.w > 1.0001 || r.y + r.h > 1.0001) fail('VALIDATION', 'Webcam placement extends outside the frame');
    }
    if (p.crop && (p.crop.x + p.crop.w > 1.0001 || p.crop.y + p.crop.h > 1.0001)) fail('VALIDATION', 'Crop extends outside the frame');
  }
}
