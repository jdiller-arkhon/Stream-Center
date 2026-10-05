/**
 * YouTube helpers that need no network: highlight detection from loudness, pre-upload
 * checks against YouTube's published limits, chapter lists and a metadata starter kit.
 * Nothing here talks to YouTube; uploading stays a manual step in YouTube Studio.
 */
import type { LoudnessAnalysis, ProbeResult } from './ffmpeg';

export interface Moment {
  /** Centre of the loud passage, in ms from the start of the clip. */
  atMs: number;
  /** How far the passage sits above the clip's typical level (LU). */
  excessLu: number;
}

export interface YouTubeCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface Chapter {
  atMs: number;
  title: string;
}

/** YouTube normalises playback to roughly this level; louder uploads are turned down. */
export const YOUTUBE_LOUDNESS_LUFS = -14;
export const SHORTS_MAX_MS = 180_000;
const UNVERIFIED_MAX_MS = 15 * 60_000;
const MAX_MS = 12 * 3600_000;
const MAX_BYTES = 256 * 1024 ** 3;
const SLOT_MS = 100;

/**
 * Finds the loudest passages (cheers, explosions, shouting) using 3 s short-term loudness.
 * Returns up to `limit` moments spaced at least `minGapMs` apart, loudest first.
 */
export function findMoments(momentary: number[], limit = 5, minGapMs = 20_000): Moment[] {
  if (momentary.length < 10) return [];
  const win = 30; // 3 s of 100 ms slots
  const smooth: number[] = [];
  // Average in the energy domain, like EBU short-term loudness.
  let acc = 0;
  const energy = momentary.map((v) => (v <= -70 ? 0 : 10 ** (v / 10)));
  for (let i = 0; i < energy.length; i++) {
    acc += energy[i]!;
    if (i >= win) acc -= energy[i - win]!;
    const n = Math.min(i + 1, win);
    smooth.push(acc > 0 ? 10 * Math.log10(acc / n) : -120);
  }
  const audible = smooth.filter((v) => v > -70).sort((a, b) => a - b);
  if (!audible.length) return [];
  const typical = audible[Math.floor(audible.length / 2)]!;
  const order = smooth.map((v, i) => [v, i] as const).filter(([v]) => v > -70).sort((a, b) => b[0] - a[0]);
  const gap = Math.min(minGapMs, (momentary.length * SLOT_MS) / 4);
  const picked: Moment[] = [];
  for (const [v, i] of order) {
    // smooth[i] covers the window ending at i; centre the moment inside it.
    const atMs = Math.max(0, (i - win / 2) * SLOT_MS);
    if (picked.some((p) => Math.abs(p.atMs - atMs) < gap)) continue;
    picked.push({ atMs, excessLu: Math.round((v - typical) * 10) / 10 });
    if (picked.length >= limit) break;
  }
  return picked;
}

/** In/out points for a Short built around a moment: most of the window leads up to it. */
export function shortWindow(atMs: number, clipMs: number, lengthMs = 30_000): { inMs: number; outMs: number } {
  const len = Math.min(lengthMs, clipMs, SHORTS_MAX_MS);
  let inMs = Math.round(atMs - len * 0.7);
  inMs = Math.max(0, Math.min(inMs, clipMs - len));
  return { inMs, outMs: inMs + len };
}

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
export const chapterTime = fmt;

export function isShort(probe: ProbeResult): boolean {
  const v = probe.video;
  return !!v && v.height >= v.width && probe.durationMs <= SHORTS_MAX_MS;
}

/** Checks an exported file against YouTube's upload limits and common quality pitfalls. */
export function youtubeChecks(probe: ProbeResult, loud: Pick<LoudnessAnalysis, 'integratedLufs' | 'truePeakDb'>, bytes: number): YouTubeCheck[] {
  const checks: YouTubeCheck[] = [];
  const v = probe.video;
  const vertical = !!v && v.height > v.width;
  const d = probe.durationMs;

  const fmtOk = probe.container === 'mp4' && !!v && ['h264', 'hevc'].includes(v.codec) && (!probe.audio || probe.audio.codec === 'aac');
  checks.push({
    id: 'format',
    label: 'File format',
    status: fmtOk ? 'pass' : 'warn',
    detail: fmtOk ? `MP4 · ${v!.codec.toUpperCase()}${probe.audio ? ' + AAC' : ''} (YouTube's recommended upload format)` : 'Not an MP4 with H.264/HEVC and AAC. YouTube will probably still accept it, but MP4 is recommended.',
  });

  if (d > MAX_MS || bytes > MAX_BYTES) {
    checks.push({ id: 'size', label: 'Length and size', status: 'fail', detail: 'YouTube accepts up to 12 hours or 256 GB per video.' });
  } else if (vertical && d > SHORTS_MAX_MS) {
    checks.push({ id: 'length', label: 'Shorts length', status: 'warn', detail: `This vertical video is ${fmt(d)} long. Shorts can be up to 3:00, so it will be a regular video. Trim it to make it a Short.` });
  } else if (vertical) {
    checks.push({ id: 'length', label: 'Shorts length', status: 'pass', detail: `${fmt(d)}, within the 3:00 Shorts limit.` });
  } else if (d > UNVERIFIED_MAX_MS) {
    checks.push({ id: 'length', label: 'Length', status: 'warn', detail: `${fmt(d)} long. Videos over 15 minutes need a verified YouTube account (one-time phone verification).` });
  } else {
    checks.push({ id: 'length', label: 'Length', status: 'pass', detail: `${fmt(d)}.` });
  }

  if (v) {
    const short = Math.min(v.width, v.height);
    const ratio = Math.max(v.width, v.height) / Math.min(v.width, v.height);
    const aspectOk = Math.abs(ratio - 16 / 9) < 0.02;
    checks.push({
      id: 'aspect',
      label: 'Aspect ratio',
      status: aspectOk ? 'pass' : 'warn',
      detail: aspectOk ? (vertical ? '9:16 vertical: fills the phone screen in Shorts.' : '16:9: fills the YouTube player.') : `${v.width}×${v.height} is not 16:9 or 9:16. YouTube will add black bars.`,
    });
    checks.push({
      id: 'resolution',
      label: 'Resolution',
      status: short >= 1080 ? 'pass' : short >= 720 ? 'warn' : 'fail',
      detail: short >= 1080 ? `${v.width}×${v.height}.` : `${v.width}×${v.height}. Upload at 1080p or higher for a sharp YouTube encode.`,
    });
    if (v.fps) {
      const ok = v.fps >= 23.9 && v.fps <= 60.5;
      checks.push({ id: 'fps', label: 'Frame rate', status: ok ? 'pass' : 'warn', detail: ok ? `${Math.round(v.fps)} fps.` : `${v.fps.toFixed(1)} fps. YouTube recommends 24–60 fps.` });
    }
  } else {
    checks.push({ id: 'video', label: 'Video', status: 'fail', detail: 'The file has no video stream.' });
  }

  if (!probe.audio || loud.integratedLufs === null) {
    checks.push({ id: 'audio', label: 'Audio', status: 'warn', detail: 'No audio track. Silent videos get far less watch time.' });
  } else {
    const i = loud.integratedLufs;
    const status = i > YOUTUBE_LOUDNESS_LUFS + 1 || i < YOUTUBE_LOUDNESS_LUFS - 4 ? 'warn' : 'pass';
    const detail =
      i > YOUTUBE_LOUDNESS_LUFS + 1
        ? `${i.toFixed(1)} LUFS: louder than YouTube's ~−14 LUFS playback level, so YouTube will turn it down. Export with “Normalize loudness” for full control.`
        : i < YOUTUBE_LOUDNESS_LUFS - 4
          ? `${i.toFixed(1)} LUFS: quiet. YouTube does not turn quiet videos up, so this will sound softer than other videos. Export with “Normalize loudness”.`
          : `${i.toFixed(1)} LUFS: close to YouTube's ~−14 LUFS playback level.`;
    checks.push({ id: 'loudness', label: 'Loudness', status, detail });
    if (loud.truePeakDb !== null) {
      const ok = loud.truePeakDb <= -1;
      checks.push({ id: 'peak', label: 'Peaks', status: ok ? 'pass' : 'warn', detail: ok ? `True peak ${loud.truePeakDb.toFixed(1)} dBTP.` : `True peak ${loud.truePeakDb.toFixed(1)} dBTP. Peaks above −1 dBTP can distort after YouTube re-encodes the audio.` });
    }
  }
  return checks;
}

/**
 * YouTube shows chapters only when the list starts at 0:00, has at least three entries
 * and each chapter lasts at least 10 seconds. Returns [] when that cannot be met.
 */
export function buildChapters(parts: Array<{ title: string; durationMs: number }>): { chapters: Chapter[]; reason: string | null } {
  if (parts.length < 3) return { chapters: [], reason: 'Chapters need at least three timeline segments. Split the cut into three or more parts to add them.' };
  if (parts.some((p) => p.durationMs < 10_000)) return { chapters: [], reason: 'Every chapter must be at least 10 seconds. One or more timeline segments is shorter.' };
  let at = 0;
  const seen = new Map<string, number>();
  const chapters = parts.map((p) => {
    const base = p.title.trim().slice(0, 80) || 'Part';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const c = { atMs: at, title: n > 1 ? `${base} (${n})` : base };
    at += p.durationMs;
    return c;
  });
  return { chapters, reason: null };
}

export interface MetadataInput {
  name: string;
  game: string | null;
  short: boolean;
  chapters: Chapter[];
}

export interface Metadata {
  title: string;
  description: string;
  tags: string[];
}

const TITLE_MAX = 100;
const TAGS_MAX_CHARS = 500;

/** A starting point the creator edits: nothing is posted anywhere. */
export function buildMetadata(m: MetadataInput): Metadata {
  const game = m.game?.trim() || null;
  const name = m.name.replace(/\.(mp4|mov|mkv|webm)$/i, '').trim();
  const generic = !name || /^(clip|replay|recording|untitled|draft)\b/i.test(name) || /^\d{4}-\d{2}-\d{2}/.test(name);
  let title = generic ? (game ? `${game} ${m.short ? 'highlight' : 'highlights'}` : m.short ? 'Gaming highlight' : 'Gaming highlights') : name;
  if (m.short && !/#shorts/i.test(title) && title.length + 8 <= TITLE_MAX) title += ' #Shorts';
  title = title.slice(0, TITLE_MAX);

  const hashtag = (s: string) => '#' + s.replace(/[^\p{L}\p{N}]+/gu, '');
  const lines: string[] = [];
  lines.push(game ? `${m.short ? 'A quick' : 'A'} ${game} moment from my latest session.` : 'A moment from my latest session.');
  if (m.chapters.length) {
    lines.push('', 'Chapters', ...m.chapters.map((c) => `${fmt(c.atMs)} ${c.title}`));
  }
  const tags = [game ? hashtag(game) : null, '#gaming', m.short ? '#Shorts' : null].filter((x): x is string => !!x && x.length > 1);
  lines.push('', tags.join(' '));

  const tagList: string[] = [];
  const candidates = game ? [game, `${game} gameplay`, `${game} highlights`, 'gaming', m.short ? 'shorts' : 'gameplay'] : ['gaming', 'gameplay', m.short ? 'shorts' : 'highlights'];
  let used = 0;
  for (const t of [...new Set(candidates)]) {
    if (used + t.length + 1 > TAGS_MAX_CHARS) break;
    tagList.push(t);
    used += t.length + 1;
  }
  return { title, description: lines.join('\n'), tags: tagList };
}

/** Reads width/height from a baseline or progressive JPEG (SOF0/SOF2). */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
