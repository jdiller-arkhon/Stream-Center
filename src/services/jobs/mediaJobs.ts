import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportRequest, ExportSettings } from '../../shared/contracts';
import { DriftFailure, fail } from '../core/errors';
import type { Logger } from '../core/logger';
import { collisionSafePath, diskStatus, isFile, sanitizeFileStem } from '../core/paths';
import { run } from '../core/proc';
import type { ClipLibrary } from '../library/ClipLibrary';
import { buildExportCommand, type ClipMediaInfo, type ResolvedEncoder } from '../media/exportBuilder';
import { ProgressParser, playbackPlan, type HwEncoder, type MediaTools } from '../media/ffmpeg';
import type { ProjectService } from '../projects/ProjectService';
import type { JobContext, JobHandler, JobOutcome } from './JobQueue';

export interface ExportJobPayload {
  request: ExportRequest;
  /** Project revision captured at enqueue time; the export uses exactly this edit. */
  revision: number;
  destinationDirectory: string;
}

export interface ProxyJobPayload {
  clipId: string;
}

export interface MediaJobDeps {
  tools: MediaTools;
  library: ClipLibrary;
  projects: ProjectService;
  log: Logger;
  preferHardware: () => boolean;
  onExported: (info: { jobId: string; outputPath: string; outputClipId: string | null; sourceClipIds: string[] }) => void;
}

/** Validation tolerance for output duration vs. edit duration. */
export function durationTolerance(expectedMs: number): number {
  return Math.max(250, expectedMs * 0.02);
}

export async function resolveEncoder(requested: ExportSettings['encoder'], available: HwEncoder[], preferHardware: boolean): Promise<ResolvedEncoder> {
  if (requested === 'software') return 'software';
  if (requested === 'auto') {
    if (!preferHardware) return 'software';
    return (['nvenc', 'qsv', 'amf'] as const).find((e) => available.includes(e)) ?? 'software';
  }
  if (!available.includes(requested)) {
    fail('UNSUPPORTED', `${requested.toUpperCase()} hardware encoding is not available on this PC. Choose Auto or Software.`);
  }
  return requested;
}

/** Runs ffmpeg with -progress parsing, mapping output time to job progress. */
async function runFfmpegWithProgress(
  tools: MediaTools,
  args: string[],
  expectedMs: number,
  ctx: JobContext<unknown>,
  cwd: string,
  label: string,
): Promise<void> {
  const parser = new ProgressParser();
  const r = await run(tools.requireFfmpeg(), args, {
    cwd,
    signal: ctx.signal,
    lowPriority: ctx.lowPriority(),
    onStdout: (chunk) => {
      if (parser.push(chunk) && expectedMs > 0) {
        const frac = Math.min(0.99, parser.outTimeUs / 1000 / expectedMs);
        ctx.progress(frac, `${label} ${Math.round(frac * 100)}%${parser.speed ? ` · ${parser.speed}` : ''}`);
      }
    },
  });
  if (r.code !== 0) {
    throw new DriftFailure('FFMPEG_FAILED', `${label} failed (ffmpeg exit ${r.code ?? r.signal})`, { detail: r.stderr.trim().slice(-4000), retryable: true });
  }
}

/** Confirms a rendered file exists and is valid media matching the expected duration with A/V in sync. */
export async function validateOutput(tools: MediaTools, file: string, expectedMs: number, requireAudio: boolean): Promise<void> {
  if (!isFile(file) || fs.statSync(file).size === 0) fail('MEDIA_INVALID', 'Export produced no output file');
  const p = await tools.probe(file);
  if (!p.video) fail('MEDIA_INVALID', 'Exported file has no video stream');
  if (requireAudio && !p.audio) fail('MEDIA_INVALID', 'Exported file has no audio stream');
  const tol = durationTolerance(expectedMs);
  if (Math.abs(p.durationMs - expectedMs) > tol) {
    fail('MEDIA_INVALID', 'Exported duration does not match the edit', { detail: `expected ${expectedMs} ms, got ${p.durationMs} ms` });
  }
  const vd = p.video.durationMs;
  const ad = p.audio?.durationMs ?? null;
  if (vd !== null && ad !== null && Math.abs(vd - ad) > 150) {
    fail('MEDIA_INVALID', 'Audio and video lengths differ in the exported file', { detail: `video ${vd} ms, audio ${ad} ms` });
  }
}

export function createExportHandler(deps: MediaJobDeps): JobHandler<ExportJobPayload> {
  return async (ctx): Promise<JobOutcome> => {
    const { request, revision, destinationDirectory } = ctx.payload;
    const project = deps.projects.get(request.projectId);
    if (project.revision !== revision) {
      deps.log.info('export uses newer project revision', { projectId: project.id, queued: revision, current: project.revision });
    }
    const clipInfo = new Map<string, ClipMediaInfo>();
    for (const it of project.tracks[0]!.items) {
      const rec = deps.library.getRecord(it.clipId);
      if (!isFile(rec.path)) fail('MEDIA_MISSING', `Source clip "${rec.fileName}" is missing. Relink it in ClipForge, then retry.`, { detail: rec.path });
      clipInfo.set(rec.id, { id: rec.id, path: rec.path, durationMs: rec.durationMs, hasVideo: rec.hasVideo, hasAudio: rec.hasAudio });
    }
    if (project.music && !isFile(project.music.path)) fail('MEDIA_MISSING', 'The music file for this project is missing', { detail: project.music.path });

    fs.mkdirSync(destinationDirectory, { recursive: true });
    const stem = sanitizeFileStem(request.fileName);
    const partial = path.join(destinationDirectory, `.${stem}.${ctx.job.id}.partial.mp4`);
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'drift-export-'));

    const cleanup = async () => {
      await fs.promises.rm(partial, { force: true }).catch(() => {});
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    };

    try {
      const available = await deps.tools.hardwareEncoders();
      let encoder = await resolveEncoder(request.settings.encoder, available, deps.preferHardware());
      let cmd = buildExportCommand(project, request.settings, clipInfo, encoder, partial);

      // Storage check: estimate from target bitrate with generous headroom.
      const pixels = request.settings.width * request.settings.height * request.settings.fps;
      const bitsPerSec = pixels * { draft: 0.06, standard: 0.1, high: 0.16 }[request.settings.quality] + request.settings.audioBitrateKbps * 1000;
      const estimate = (bitsPerSec / 8) * (cmd.expectedDurationMs / 1000) * 1.5 + 50 * 1024 * 1024;
      const disk = await diskStatus(destinationDirectory);
      if (disk && disk.freeBytes < estimate) {
        fail('INSUFFICIENT_STORAGE', 'Not enough free space for this export', {
          detail: `needs about ${Math.round(estimate / 1048576)} MB, ${Math.round(disk.freeBytes / 1048576)} MB free`,
        });
      }
      if (cmd.assFile) {
        const filters = await deps.tools.filters();
        if (!filters.has('subtitles')) fail('UNSUPPORTED', 'This FFmpeg build cannot burn in captions (libass missing). Install a full FFmpeg build or remove captions.');
        await fs.promises.writeFile(path.join(work, 'captions.ass'), cmd.assFile, 'utf8');
      }

      const label = encoder === 'software' ? 'Encoding' : `Encoding (${encoder.toUpperCase()})`;
      try {
        await runFfmpegWithProgress(deps.tools, cmd.args, cmd.expectedDurationMs, ctx as JobContext<unknown>, work, label);
      } catch (err) {
        if (ctx.signal.aborted || encoder === 'software' || !(err instanceof DriftFailure) || err.code !== 'FFMPEG_FAILED') throw err;
        // Hardware encoders can fail at runtime (driver/session limits). Fall back to software once.
        deps.log.warn('hardware encode failed, retrying in software', { encoder, detail: err.detail?.slice(-500) });
        encoder = 'software';
        cmd = buildExportCommand(project, request.settings, clipInfo, encoder, partial);
        ctx.progress(0, 'Hardware encoder failed — retrying with software encoding');
        await runFfmpegWithProgress(deps.tools, cmd.args, cmd.expectedDurationMs, ctx as JobContext<unknown>, work, 'Encoding (software fallback)');
      }

      ctx.setState('validating');
      ctx.progress(0.995, 'Validating output');
      await validateOutput(deps.tools, partial, cmd.expectedDurationMs, true);

      const final = collisionSafePath(destinationDirectory, stem, '.mp4');
      await fs.promises.rename(partial, final);
      const imported = await deps.library.importOne(final, { source: 'export', gameTitle: null, tags: ['export'] });
      const sourceClipIds = [...clipInfo.keys()];
      deps.onExported({ jobId: ctx.job.id, outputPath: final, outputClipId: imported.clipId, sourceClipIds });
      return { outputPath: final, outputClipId: imported.clipId };
    } finally {
      await cleanup();
    }
  };
}

/** Makes a browser-playable copy for clips Chromium cannot play directly (e.g. MKV, HEVC). */
export function createProxyHandler(deps: Pick<MediaJobDeps, 'tools' | 'library' | 'log'>): JobHandler<ProxyJobPayload> {
  return async (ctx): Promise<JobOutcome> => {
    const rec = deps.library.getRecord(ctx.payload.clipId);
    if (!isFile(rec.path)) fail('MEDIA_MISSING', 'Clip file is missing', { detail: rec.path });
    const probe = await deps.tools.probe(rec.path);
    const plan = playbackPlan(probe);
    if (plan === 'direct') {
      deps.library.setProxy(rec.id, null, 'direct');
      return {};
    }
    const out = path.join(deps.library.proxiesDir, `${rec.id}.mp4`);
    const partial = `${out}.partial.mp4`;
    const args =
      plan === 'remux'
        ? ['-hide_banner', '-nostdin', '-y', '-i', rec.path, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart']
        : [
            '-hide_banner', '-nostdin', '-y', '-i', rec.path, '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
          ];
    args.push('-progress', 'pipe:1', '-nostats', '-loglevel', 'error', '-f', 'mp4', partial);
    try {
      await runFfmpegWithProgress(deps.tools, args, rec.durationMs, ctx as JobContext<unknown>, deps.library.proxiesDir, plan === 'remux' ? 'Preparing playback' : 'Creating preview proxy');
      ctx.setState('validating');
      await validateOutput(deps.tools, partial, rec.durationMs, false);
      await fs.promises.rename(partial, out);
      deps.library.setProxy(rec.id, out, 'proxy');
      return { outputPath: out };
    } catch (err) {
      await fs.promises.rm(partial, { force: true }).catch(() => {});
      if (!(err instanceof DriftFailure && err.code === 'CANCELLED')) deps.library.setProxy(rec.id, null, 'unplayable');
      throw err;
    }
  };
}
