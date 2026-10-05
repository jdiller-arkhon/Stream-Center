import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Caption } from '../../shared/contracts';
import { DriftFailure, fail } from '../core/errors';
import { newId } from '../core/ids';
import { isFile } from '../core/paths';
import { run } from '../core/proc';
import type { JobHandler } from '../jobs/JobQueue';
import type { ClipLibrary } from '../library/ClipLibrary';
import type { MediaTools } from '../media/ffmpeg';
import type { ProjectService } from '../projects/ProjectService';

export interface TranscriptionPayload {
  projectId: string;
}

interface WhisperJson {
  transcription?: Array<{ offsets?: { from: number; to: number }; text?: string }>;
}

/** Parses whisper.cpp `-oj` output into captions offset by `offsetMs` (timeline position). */
export function parseWhisperJson(json: WhisperJson, offsetMs: number, maxMs: number): Caption[] {
  const out: Caption[] = [];
  for (const seg of json.transcription ?? []) {
    const text = (seg.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || !seg.offsets || /^\[.*\]$/.test(text)) continue; // skip [BLANK_AUDIO], [Music] etc.
    const startMs = Math.max(0, Math.round(seg.offsets.from)) + offsetMs;
    const endMs = Math.min(maxMs, Math.round(seg.offsets.to) + offsetMs);
    if (endMs - startMs < 200) continue;
    out.push({ id: newId('cap'), startMs, endMs, text: text.slice(0, 500) });
  }
  return out;
}

/**
 * Local, optional transcription using a user-installed whisper.cpp CLI and model.
 * Nothing leaves the machine. Captions are added to the project for editing.
 */
export function createTranscriptionHandler(deps: {
  tools: MediaTools;
  library: ClipLibrary;
  projects: ProjectService;
  whisper: () => { exe: string | null; model: string | null };
}): JobHandler<TranscriptionPayload> {
  return async (ctx) => {
    const { exe, model } = deps.whisper();
    if (!exe || !isFile(exe) || !model || !isFile(model)) fail('UNSUPPORTED', 'Transcription is not set up. Choose a whisper.cpp executable and model in Settings → Transcription.');
    const project = deps.projects.get(ctx.payload.projectId);
    const items = project.tracks[0]!.items;
    const total = items.reduce((s, it) => s + (it.sourceOutMs - it.sourceInMs), 0);
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'drift-whisper-'));
    const captions: Caption[] = [];
    try {
      let offset = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        const rec = deps.library.getRecord(it.clipId);
        const dur = it.sourceOutMs - it.sourceInMs;
        ctx.progress(i / items.length, `Transcribing segment ${i + 1} of ${items.length}`);
        if (rec.hasAudio) {
          const wav = path.join(work, `seg${i}.wav`);
          const ff = await run(
            deps.tools.requireFfmpeg(),
            ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (it.sourceInMs / 1000).toFixed(3), '-t', (dur / 1000).toFixed(3), '-i', rec.path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
            { signal: ctx.signal, lowPriority: ctx.lowPriority() },
          );
          if (ff.code !== 0) throw new DriftFailure('FFMPEG_FAILED', 'Could not extract audio for transcription', { detail: ff.stderr.slice(-2000) });
          const base = path.join(work, `seg${i}`);
          const w = await run(exe, ['-m', model, '-f', wav, '-oj', '-of', base, '-l', 'auto', '-np'], { signal: ctx.signal, lowPriority: true });
          if (w.code !== 0) throw new DriftFailure('INTERNAL', 'whisper.cpp failed', { detail: w.stderr.slice(-2000) });
          const json = JSON.parse(await fs.promises.readFile(`${base}.json`, 'utf8')) as WhisperJson;
          captions.push(...parseWhisperJson(json, offset, offset + dur));
        }
        offset += dur;
      }
      const current = deps.projects.get(project.id);
      deps.projects.save({ ...current, captions: [...current.captions, ...captions].sort((a, b) => a.startMs - b.startMs).slice(0, 2000) });
      ctx.progress(1, `Added ${captions.length} captions (${Math.round(total / 1000)} s transcribed)`);
      return {};
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  };
}
