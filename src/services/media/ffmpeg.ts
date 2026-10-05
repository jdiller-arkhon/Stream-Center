import fs from 'node:fs';
import path from 'node:path';
import { DriftFailure, fail } from '../core/errors';
import { run } from '../core/proc';
import { isFile } from '../core/paths';

export interface ProbeResult {
  durationMs: number;
  container: string | null;
  video: { codec: string; width: number; height: number; fps: number | null; durationMs: number | null } | null;
  audio: { codec: string; channels: number; sampleRate: number; durationMs: number | null } | null;
  bitRate: number | null;
}

export interface ToolPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
}

export type HwEncoder = 'nvenc' | 'qsv' | 'amf';

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Finds ffmpeg/ffprobe: explicit setting → bundled resources → PATH. */
export function locateTools(configured: ToolPaths, resourceDirs: string[]): ToolPaths {
  const find = (name: 'ffmpeg' | 'ffprobe'): string | null => {
    const explicit = configured[name];
    if (explicit) return isFile(explicit) ? explicit : null;
    for (const dir of resourceDirs) {
      const p = path.join(dir, exe(name));
      if (isFile(p)) return p;
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const p = path.join(dir, exe(name));
      if (isFile(p)) return p;
    }
    return null;
  };
  return { ffmpeg: find('ffmpeg'), ffprobe: find('ffprobe') };
}

function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return null;
  const v = n / d;
  return Number.isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : null;
}

const secToMs = (s: unknown): number | null => {
  const n = typeof s === 'string' ? Number(s) : typeof s === 'number' ? s : NaN;
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
};

export class MediaTools {
  private encoderCache: HwEncoder[] | null = null;
  private filterCache: Set<string> | null = null;

  constructor(private paths: ToolPaths) {}

  setPaths(paths: ToolPaths): void {
    this.paths = paths;
    this.encoderCache = null;
    this.filterCache = null;
  }

  get ffmpegPath(): string | null { return this.paths.ffmpeg; }
  get ffprobePath(): string | null { return this.paths.ffprobe; }

  requireFfmpeg(): string {
    return this.paths.ffmpeg ?? fail('FFMPEG_MISSING', 'FFmpeg was not found. Install FFmpeg or set its path in Settings → Media tools.');
  }

  requireFfprobe(): string {
    return this.paths.ffprobe ?? fail('FFMPEG_MISSING', 'ffprobe was not found. Install FFmpeg or set its path in Settings → Media tools.');
  }

  async version(): Promise<string | null> {
    if (!this.paths.ffmpeg) return null;
    try {
      const r = await run(this.paths.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
      return r.stdout.split('\n')[0]?.trim() ?? null;
    } catch {
      return null;
    }
  }

  async probe(file: string): Promise<ProbeResult> {
    const ffprobe = this.requireFfprobe();
    if (!isFile(file)) fail('MEDIA_MISSING', 'Media file not found', { detail: file });
    const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 30_000 });
    if (r.code !== 0) fail('MEDIA_INVALID', 'File is not readable media', { detail: r.stderr.trim().slice(-2000) });
    let json: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
    try {
      json = JSON.parse(r.stdout);
    } catch {
      fail('MEDIA_INVALID', 'ffprobe returned unreadable output');
    }
    const streams = json.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition as Record<string, number> | undefined)?.attached_pic);
    const a = streams.find((s) => s.codec_type === 'audio');
    const fmtDur = secToMs(json.format?.duration);
    const vDur = v ? secToMs(v.duration) : null;
    const aDur = a ? secToMs(a.duration) : null;
    const durationMs = fmtDur ?? vDur ?? aDur ?? 0;
    if (!v && !a) fail('MEDIA_INVALID', 'File contains no audio or video streams');
    const formatName = typeof json.format?.format_name === 'string' ? (json.format.format_name as string) : null;
    return {
      durationMs,
      container: formatName ? normalizeContainer(formatName, file) : null,
      video: v
        ? {
            codec: String(v.codec_name ?? 'unknown'),
            width: Number(v.width ?? 0),
            height: Number(v.height ?? 0),
            fps: parseRate(v.avg_frame_rate as string) ?? parseRate(v.r_frame_rate as string),
            durationMs: vDur,
          }
        : null,
      audio: a
        ? { codec: String(a.codec_name ?? 'unknown'), channels: Number(a.channels ?? 0), sampleRate: Number(a.sample_rate ?? 0), durationMs: aDur }
        : null,
      bitRate: json.format?.bit_rate ? Number(json.format.bit_rate) : null,
    };
  }

  /** Writes a JPEG thumbnail. Returns false if the frame could not be extracted. */
  async thumbnail(file: string, out: string, atMs: number, width = 480): Promise<boolean> {
    const ffmpeg = this.requireFfmpeg();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = await run(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (atMs / 1000).toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out],
      { timeoutMs: 60_000, lowPriority: true },
    );
    return r.code === 0 && isFile(out);
  }

  /**
   * Computes a mono peak envelope (0..255 per bucket) at `perSecond` buckets/s by
   * streaming 8 kHz PCM from ffmpeg; memory use is independent of clip length.
   */
  async peaks(file: string, perSecond = 100, signal?: AbortSignal): Promise<Uint8Array> {
    const ffmpeg = this.requireFfmpeg();
    const sampleRate = 8000;
    const bucket = Math.max(1, Math.floor(sampleRate / perSecond));
    const out: number[] = [];
    let current = 0;
    let count = 0;
    let carry: Buffer | null = null;
    const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'], {
      lowPriority: true,
      signal,
      binaryStdout: (chunk) => {
        let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
        const usable = buf.length - (buf.length % 2);
        carry = usable < buf.length ? buf.subarray(usable) : null;
        buf = buf.subarray(0, usable);
        for (let i = 0; i < buf.length; i += 2) {
          const v = Math.abs(buf.readInt16LE(i));
          if (v > current) current = v;
          if (++count === bucket) {
            out.push(Math.min(255, Math.round((current / 32768) * 255)));
            current = 0;
            count = 0;
          }
        }
      },
    });
    if (count > 0) out.push(Math.min(255, Math.round((current / 32768) * 255)));
    if (r.code !== 0 && out.length === 0) {
      // No audio stream is not an error: return an empty envelope.
      if (/does not contain any stream|Output file .* does not contain|matches no streams/i.test(r.stderr)) return new Uint8Array();
      fail('FFMPEG_FAILED', 'Could not read audio for waveform', { detail: r.stderr.slice(-2000) });
    }
    return Uint8Array.from(out);
  }

  /** Lists filters compiled into this ffmpeg build (cached). */
  async filters(): Promise<Set<string>> {
    if (this.filterCache) return this.filterCache;
    const ffmpeg = this.requireFfmpeg();
    const r = await run(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 15_000 });
    const set = new Set<string>();
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*[TSC.|]{2,3}\s+(\S+)\s+\S+->\S+/.exec(line);
      if (m) set.add(m[1]!);
    }
    this.filterCache = set;
    return set;
  }

  /**
   * Detects hardware H.264 encoders that actually work on this machine: an encoder
   * being compiled in is not enough, so each is test-encoded with a tiny clip.
   */
  async hardwareEncoders(): Promise<HwEncoder[]> {
    if (this.encoderCache) return this.encoderCache;
    const ffmpeg = this.paths.ffmpeg;
    if (!ffmpeg) return [];
    const r = await run(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15_000 }).catch(() => null);
    if (!r) return [];
    const candidates: Array<[HwEncoder, string]> = [
      ['nvenc', 'h264_nvenc'],
      ['qsv', 'h264_qsv'],
      ['amf', 'h264_amf'],
    ];
    const working: HwEncoder[] = [];
    for (const [id, enc] of candidates) {
      if (!r.stdout.includes(enc)) continue;
      const t = await run(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-frames:v', '3', '-c:v', enc, '-f', 'null', '-'],
        { timeoutMs: 15_000 },
      ).catch(() => null);
      if (t && t.code === 0) working.push(id);
    }
    this.encoderCache = working;
    return working;
  }
}

function normalizeContainer(formatName: string, file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (formatName.includes('mp4') || formatName.includes('mov')) return ext === 'mov' ? 'mov' : 'mp4';
  if (formatName.includes('matroska') || formatName.includes('webm')) return ext === 'webm' ? 'webm' : 'mkv';
  return formatName.split(',')[0]!;
}

/** Parses ffmpeg `-progress pipe:1` key=value output into microseconds of output time. */
export class ProgressParser {
  private buffer = '';
  outTimeUs = 0;
  speed: string | null = null;
  ended = false;

  push(chunk: string): boolean {
    this.buffer += chunk;
    let changed = false;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1);
      if (key === 'out_time_us' || key === 'out_time_ms') {
        // Note: ffmpeg reports out_time_ms in microseconds too (historical quirk).
        const n = Number(val);
        if (Number.isFinite(n) && n >= 0) {
          this.outTimeUs = n;
          changed = true;
        }
      } else if (key === 'speed') {
        this.speed = val;
      } else if (key === 'progress' && val === 'end') {
        this.ended = true;
        changed = true;
      }
    }
    return changed;
  }
}

/** Playback strategy for Chromium: direct, stream-copy remux, or transcode. */
export function playbackPlan(p: ProbeResult): 'direct' | 'remux' | 'transcode' {
  const okVideo = !p.video || ['h264', 'vp8', 'vp9', 'av1'].includes(p.video.codec);
  const okAudio = !p.audio || ['aac', 'opus', 'mp3', 'vorbis', 'flac'].includes(p.audio.codec);
  const okContainer = p.container === 'mp4' || p.container === 'mov' || p.container === 'webm';
  if (okVideo && okAudio && okContainer) return 'direct';
  if (okVideo && okAudio && p.video?.codec === 'h264') return 'remux';
  return 'transcode';
}

export function isDriftFailure(err: unknown): err is DriftFailure {
  return err instanceof DriftFailure;
}
