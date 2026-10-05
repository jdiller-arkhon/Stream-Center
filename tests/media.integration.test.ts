import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditProject, ExportSettings, Job } from '../src/shared/contracts';
import { EXPORT_PRESETS } from '../src/shared/defaults';
import type { DriftCore } from '../src/services/DriftCore';
import { generateClip, makeCore, ok, tempDir, waitFor } from './helpers/env';

const Q = { search: null, gameTitle: null, sessionId: null, favoritesOnly: false, tags: [] as string[], source: null, limit: 100, offset: 0 };

function probe(file: string) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString();
  return JSON.parse(out) as { format: { duration: string }; streams: Array<{ codec_type: string; width?: number; height?: number; duration?: string; r_frame_rate?: string }> };
}

const settings = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  aspect: '16:9', width: 640, height: 360, fps: 30, quality: 'draft', codec: 'h264', encoder: 'software', audioBitrateKbps: 128, ...over,
});

async function finished(core: DriftCore, id: string, timeoutMs = 60_000): Promise<Job> {
  return waitFor(() => {
    const j = core.jobs.get(id);
    return ['succeeded', 'failed', 'cancelled'].includes(j.state) ? j : null;
  }, { timeoutMs });
}

describe('media pipeline (real ffmpeg)', () => {
  let dir: string;
  let core: DriftCore;

  beforeEach(async () => {
    dir = tempDir();
    ({ core } = makeCore(dir));
    ok(await core.invoke('settings.update', { obs: { autoConnect: false }, media: { libraryDirectory: path.join(dir, 'lib'), exportDirectory: path.join(dir, 'exports') } }));
    await core.start();
  });

  afterEach(async () => {
    await core.dispose();
  });

  it('VERTICAL SLICE 2: import → waveform → trim edit saved → export with audio → validated file', async () => {
    const src = generateClip(path.join(dir, 'in', 'Siege ace.mp4'), 8);
    const before = fs.readFileSync(src);
    const [res] = ok(await core.invoke('clips.import', { paths: [src] }));
    expect(res!.outcome).toBe('imported');
    const clip = ok(await core.invoke('clips.get', { id: res!.clipId! }));
    expect(clip.durationMs).toBeGreaterThan(7900);
    expect(clip.width).toBe(640);
    expect(clip.audioCodec).toBe('aac');

    const wf = ok(await core.invoke('clips.getWaveform', { id: clip.id, resolution: 50 }));
    expect(wf.peaks.length).toBeGreaterThan(350);
    expect(Math.max(...wf.peaks)).toBeGreaterThan(0.05); // lavfi sine amplitude is 1/8

    let project = ok(await core.invoke('projects.createFromClip', { clipId: clip.id, name: 'Ace' }));
    // Trim to 2.0 s – 5.5 s and save (non-destructive).
    project.tracks[0]!.items[0] = { ...project.tracks[0]!.items[0]!, sourceInMs: 2000, sourceOutMs: 5500, fadeInMs: 100, fadeOutMs: 200 };
    project = ok(await core.invoke('projects.save', { project }));
    expect(project.revision).toBe(2);
    // Stale revision is rejected (autosave vs. manual save race).
    const stale = await core.invoke('projects.save', { project: { ...project, revision: 1 } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('CONFLICT');

    const job = ok(await core.invoke('exports.enqueue', { projectId: project.id, settings: settings(), destinationDirectory: null, fileName: 'Ace: clutch/round 3' }));
    const progress: number[] = [];
    core.bus.on('job.updated', (j) => j.id === job.id && j.progress !== null && progress.push(j.progress));
    const done = await finished(core, job.id);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.outputPath).toBe(path.join(dir, 'exports', 'Ace  clutch round 3.mp4'.replace(/\s+/g, ' ')));
    expect(fs.existsSync(done.outputPath!)).toBe(true);
    // No partial files left behind.
    expect(fs.readdirSync(path.join(dir, 'exports')).filter((f) => f.includes('partial'))).toEqual([]);

    const p = probe(done.outputPath!);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    const a = p.streams.find((s) => s.codec_type === 'audio')!;
    expect(v.width).toBe(640);
    expect(Math.abs(Number(p.format.duration) - 3.5)).toBeLessThan(0.1);
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.1);
    expect(progress.at(-1)).toBe(1);
    // Original untouched.
    expect(fs.readFileSync(src).equals(before)).toBe(true);
    // Export is indexed back into the library.
    expect(done.outputClipId).toBeTruthy();
    expect(ok(await core.invoke('clips.get', { id: done.outputClipId! })).source).toBe('export');
  });

  it('multi-segment vertical export with crop, webcam overlay, captions, fades and music', async () => {
    const a = generateClip(path.join(dir, 'in', 'a.mp4'), 5, { size: '1280x720' });
    const b = generateClip(path.join(dir, 'in', 'b.mp4'), 5, { size: '1280x720', audio: false });
    const music = path.join(dir, 'in', 'music.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', music]);
    const [ra, rb] = ok(await core.invoke('clips.import', { paths: [a, b] }));
    let project = ok(await core.invoke('projects.createFromClip', { clipId: ra!.clipId!, name: 'Squad' }));
    project = ok(await core.invoke('projects.applyPreset', { id: project.id, presetId: 'vertical-short' }));
    expect(project.aspect).toBe('9:16');
    const item0 = project.tracks[0]!.items[0]!;
    const next: EditProject = {
      ...project,
      tracks: [{ ...project.tracks[0]!, items: [{ ...item0, sourceInMs: 500, sourceOutMs: 2500 }, { ...item0, id: 'itm_b', clipId: rb!.clipId!, sourceInMs: 1000, sourceOutMs: 3000 }] }],
      crop: { x: 0.2, y: 0, w: 0.3164, h: 1 },
      webcam: { enabled: true, sourceRect: { x: 0.75, y: 0.7, w: 0.25, h: 0.3 }, placement: { x: 0.05, y: 0.05, w: 0.4, h: 0.2 } },
      captions: [
        { id: 'c1', startMs: 200, endMs: 1500, text: 'drift {clutch} \\ 1v3' },
        { id: 'c2', startMs: 2100, endMs: 3800, text: 'GG' },
      ],
      music: { path: music, userSupplied: true, gainDb: -12, startMs: 500, fadeInMs: 300, fadeOutMs: 500 },
    };
    project = ok(await core.invoke('projects.save', { project: next }));
    const caps = ok(await core.invoke('system.getCapabilities', {}));
    if (!caps.media.captionsBurnIn.available) project = ok(await core.invoke('projects.save', { project: { ...project, captions: [] } }));
    const preset = EXPORT_PRESETS.find((p) => p.id === 'vertical-short')!;
    const job = ok(await core.invoke('exports.enqueue', { projectId: project.id, settings: { ...preset.settings, width: 360, height: 640, fps: 30, quality: 'draft', encoder: 'software' }, destinationDirectory: null, fileName: 'squad' }));
    const done = await finished(core, job.id, 120_000);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    const p = probe(done.outputPath!);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    expect([v.width, v.height]).toEqual([360, 640]);
    expect(Math.abs(Number(p.format.duration) - 4)).toBeLessThan(0.15);
    expect(p.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  });

  it('vertical export without a manual crop center-crops to fill 9:16', async () => {
    const src = generateClip(path.join(dir, 'in', 'wide.mp4'), 3, { size: '1280x720' });
    const [r] = ok(await core.invoke('clips.import', { paths: [src] }));
    const project = ok(await core.invoke('projects.createFromClip', { clipId: r!.clipId!, name: 'Wide' }));
    const job = ok(await core.invoke('exports.enqueue', { projectId: project.id, settings: settings({ aspect: '9:16', width: 360, height: 640 }), destinationDirectory: null, fileName: 'tall' }));
    const done = await finished(core, job.id);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    const v = probe(done.outputPath!).streams.find((s) => s.codec_type === 'video')!;
    expect([v.width, v.height]).toEqual([360, 640]);
  });

  it('rejects tool paths that are not ffmpeg/ffprobe binaries', async () => {
    const r = await core.invoke('settings.update', { tools: { ffmpegPath: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION');
  });

  it('cancels a running export and cleans up partial output', async () => {
    const src = generateClip(path.join(dir, 'in', 'long.mp4'), 30, { size: '1280x720' });
    const [r] = ok(await core.invoke('clips.import', { paths: [src] }));
    const project = ok(await core.invoke('projects.createFromClip', { clipId: r!.clipId!, name: 'Long' }));
    const job = ok(await core.invoke('exports.enqueue', { projectId: project.id, settings: settings({ width: 1920, height: 1080, quality: 'high', fps: 60 }), destinationDirectory: null, fileName: 'long' }));
    // Repeated click returns the same job instead of a duplicate export.
    const again = ok(await core.invoke('exports.enqueue', { projectId: project.id, settings: settings({ width: 1920, height: 1080, quality: 'high', fps: 60 }), destinationDirectory: null, fileName: 'long' }));
    expect(again.id).toBe(job.id);
    await waitFor(() => core.jobs.get(job.id).state === 'running');
    await waitFor(() => (core.jobs.get(job.id).progress ?? 0) > 0, { timeoutMs: 30_000 }).catch(() => null);
    ok(await core.invoke('jobs.cancel', { id: job.id }));
    const done = await finished(core, job.id);
    expect(done.state).toBe('cancelled');
    expect(done.outputPath).toBeNull();
    await waitFor(() => !fs.existsSync(path.join(dir, 'exports')) || fs.readdirSync(path.join(dir, 'exports')).length === 0);
    // Retry is available after cancellation.
    const retried = ok(await core.invoke('jobs.retry', { id: job.id }));
    expect(retried.state).toBe('queued');
    ok(await core.invoke('jobs.cancel', { id: job.id }));
    await finished(core, job.id);
  });

  it('fails clearly when source media is missing, then succeeds after relink + retry', async () => {
    const src = generateClip(path.join(dir, 'in', 'moveme.mp4'), 4);
    const [r] = ok(await core.invoke('clips.import', { paths: [src] }));
    const project = ok(await core.invoke('projects.createFromClip', { clipId: r!.clipId!, name: 'Moved' }));
    const moved = path.join(dir, 'elsewhere', 'moveme.mp4');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(src, moved);

    const verify = ok(await core.invoke('clips.verify', {}));
    expect(verify.missing).toBe(1);
    expect(ok(await core.invoke('clips.get', { id: r!.clipId! })).status).toBe('missing');

    const job = ok(await core.invoke('exports.enqueue', { projectId: project.id, settings: settings(), destinationDirectory: null, fileName: 'moved' }));
    const failed = await finished(core, job.id);
    expect(failed.state).toBe('failed');
    expect(failed.error?.code).toBe('MEDIA_MISSING');

    const relinked = ok(await core.invoke('clips.relink', { id: r!.clipId!, path: moved }));
    expect(relinked.status).toBe('ok');
    ok(await core.invoke('jobs.retry', { id: job.id }));
    const done = await finished(core, job.id);
    expect(done.state).toBe('succeeded');
    expect(done.attempts).toBe(2);
  });

  it('detects duplicates by content and never deletes originals on remove', async () => {
    const src = generateClip(path.join(dir, 'in', 'dup.mp4'), 3);
    const copy = path.join(dir, 'in', 'dup copy.mp4');
    fs.copyFileSync(src, copy);
    const res = ok(await core.invoke('clips.import', { paths: [src, copy, src] }));
    expect(res.map((r) => r.outcome)).toEqual(['imported', 'duplicate', 'duplicate']);
    const bad = ok(await core.invoke('clips.import', { paths: [path.join(dir, 'nope.mp4'), path.join(dir, 'in')] }));
    expect(bad.every((r) => r.outcome === 'failed')).toBe(true);
    ok(await core.invoke('clips.update', { id: res[0]!.clipId!, tags: ['ace', 'ace', ' clutch '], favorite: true, gameTitle: 'Rainbow Six Siege' }));
    const favs = ok(await core.invoke('clips.list', { ...Q, favoritesOnly: true, tags: ['clutch'] }));
    expect(favs.items[0]!.tags).toEqual(['ace', 'clutch']);
    expect(ok(await core.invoke('clips.list', { ...Q, search: 'siege' })).total).toBe(1);
    expect(ok(await core.invoke('clips.listGames', {}))).toEqual(['Rainbow Six Siege']);
    ok(await core.invoke('clips.remove', { id: res[0]!.clipId! }));
    expect(fs.existsSync(src)).toBe(true);
  });

  it('creates a browser-playable proxy for MKV recordings', async () => {
    const mkv = generateClip(path.join(dir, 'in', 'obs-recording.mkv'), 4, { container: 'mkv' });
    const [r] = ok(await core.invoke('clips.import', { paths: [mkv] }));
    expect(ok(await core.invoke('clips.get', { id: r!.clipId! })).playback).toBe('proxy-pending');
    const clip = await waitFor(async () => {
      const c = ok(await core.invoke('clips.get', { id: r!.clipId! }));
      return c.playback === 'proxy' ? c : null;
    });
    expect(clip.playbackUrl).toMatch(/^drift-media:\/\/proxy\//);
    expect(core.library.resolveMedia('proxy', clip.id)).toMatch(/\.mp4$/);
  });

  it('marks jobs interrupted by an app exit as retryable on restart', async () => {
    const src = generateClip(path.join(dir, 'in', 'x.mp4'), 3);
    const [r] = ok(await core.invoke('clips.import', { paths: [src] }));
    const project = ok(await core.invoke('projects.createFromClip', { clipId: r!.clipId!, name: 'X' }));
    const job = ok(await core.invoke('exports.enqueue', { projectId: project.id, settings: settings(), destinationDirectory: null, fileName: 'x' }));
    // Simulate a crash mid-job.
    core.db.prepare("UPDATE jobs SET state = ?, doc = json_set(doc, '$.state', ?) WHERE id = ?").run('running', 'running', job.id);
    await core.dispose();
    ({ core } = makeCore(dir));
    await core.start();
    const j = core.jobs.get(job.id);
    expect(j.state).toBe('failed');
    expect(j.error).toMatchObject({ code: 'INTERRUPTED', retryable: true });
  });

  it('rejects invalid and unknown requests at the boundary', async () => {
    const unknown = await core.invokeRaw('fs.deleteEverything', {});
    expect(unknown.ok).toBe(false);
    const bad = await core.invokeRaw('clips.import', { paths: ['relative/path.mp4'] });
    expect(bad.ok).toBe(true); // schema-valid, but each path is rejected individually
    if (bad.ok) expect((bad.data as Array<{ outcome: string }>)[0]!.outcome).toBe('failed');
    const wrong = await core.invokeRaw('exports.enqueue', { projectId: 'p', extra: 1 });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('VALIDATION');
  });
});
