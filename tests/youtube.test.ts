/** Pure YouTube helpers: highlight detection, upload checks, chapters, metadata, JPEG sizing. */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ProbeResult } from '../src/services/media/ffmpeg';
import { buildChapters, buildMetadata, findMoments, isShort, jpegSize, shortWindow, youtubeChecks } from '../src/services/media/youtube';

const probe = (w: number, h: number, ms: number, extra: Partial<ProbeResult> = {}): ProbeResult => ({
  durationMs: ms,
  container: 'mp4',
  video: { codec: 'h264', width: w, height: h, fps: 60, durationMs: ms },
  audio: { codec: 'aac', channels: 2, sampleRate: 48000, durationMs: ms },
  bitRate: null,
  ...extra,
});

describe('findMoments', () => {
  it('finds loud bursts, loudest first and spaced apart', () => {
    const curve = Array.from({ length: 1200 }, () => -30); // 120 s at -30 LUFS
    for (let i = 400; i < 430; i++) curve[i] = -12; // 40–43 s: big
    for (let i = 900; i < 930; i++) curve[i] = -18; // 90–93 s: smaller
    const m = findMoments(curve, 3);
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(m[0]!.atMs - 41_500)).toBeLessThan(2000);
    expect(m[0]!.excessLu).toBeGreaterThan(15);
    expect(Math.abs(m[1]!.atMs - 91_500)).toBeLessThan(2000);
    expect(m[1]!.excessLu).toBeLessThan(m[0]!.excessLu);
  });

  it('returns nothing for silence or too little audio', () => {
    expect(findMoments(Array(500).fill(-120))).toEqual([]);
    expect(findMoments([-20, -20])).toEqual([]);
  });

  it('builds a Short window that leads up to the moment and stays inside the clip', () => {
    expect(shortWindow(60_000, 120_000)).toEqual({ inMs: 39_000, outMs: 69_000 });
    expect(shortWindow(2_000, 120_000)).toEqual({ inMs: 0, outMs: 30_000 });
    expect(shortWindow(119_000, 120_000)).toEqual({ inMs: 90_000, outMs: 120_000 });
    expect(shortWindow(5_000, 12_000)).toEqual({ inMs: 0, outMs: 12_000 });
  });
});

describe('youtubeChecks', () => {
  const statusOf = (checks: ReturnType<typeof youtubeChecks>, id: string) => checks.find((c) => c.id === id)?.status;

  it('passes a good 1080p video at -14 LUFS', () => {
    const c = youtubeChecks(probe(1920, 1080, 120_000), { integratedLufs: -14.2, truePeakDb: -1.6 }, 50e6);
    expect(c.every((x) => x.status === 'pass')).toBe(true);
  });

  it('flags a vertical video that is too long to be a Short', () => {
    const p = probe(1080, 1920, 200_000);
    expect(isShort(p)).toBe(false);
    expect(statusOf(youtubeChecks(p, { integratedLufs: -14, truePeakDb: -2 }, 1e6), 'length')).toBe('warn');
    expect(isShort(probe(1080, 1920, 59_000))).toBe(true);
  });

  it('warns about loudness, peaks, low resolution, odd aspect and long videos', () => {
    const loud = youtubeChecks(probe(1280, 720, 20 * 60_000), { integratedLufs: -8, truePeakDb: 0.4 }, 1e9);
    expect(statusOf(loud, 'loudness')).toBe('warn');
    expect(statusOf(loud, 'peak')).toBe('warn');
    expect(statusOf(loud, 'resolution')).toBe('warn');
    expect(statusOf(loud, 'length')).toBe('warn'); // > 15 min needs verification
    const quiet = youtubeChecks(probe(1440, 1080, 60_000), { integratedLufs: -24, truePeakDb: -6 }, 1e6);
    expect(statusOf(quiet, 'loudness')).toBe('warn');
    expect(statusOf(quiet, 'aspect')).toBe('warn');
  });

  it('notes a missing audio track', () => {
    const c = youtubeChecks(probe(1920, 1080, 60_000, { audio: null }), { integratedLufs: null, truePeakDb: null }, 1e6);
    expect(statusOf(c, 'audio')).toBe('warn');
  });
});

describe('chapters and metadata', () => {
  it('follows YouTube chapter rules', () => {
    expect(buildChapters([{ title: 'A', durationMs: 20_000 }, { title: 'B', durationMs: 20_000 }]).chapters).toEqual([]);
    expect(buildChapters([{ title: 'A', durationMs: 20_000 }, { title: 'B', durationMs: 5_000 }, { title: 'C', durationMs: 20_000 }]).reason).toMatch(/10 seconds/);
    const { chapters } = buildChapters([{ title: 'Opening', durationMs: 15_000 }, { title: 'Fight', durationMs: 70_000 }, { title: 'Fight', durationMs: 30_000 }]);
    expect(chapters).toEqual([
      { atMs: 0, title: 'Opening' },
      { atMs: 15_000, title: 'Fight' },
      { atMs: 85_000, title: 'Fight (2)' },
    ]);
  });

  it('drafts a title, description with chapters and tags within YouTube limits', () => {
    const m = buildMetadata({ name: 'Replay 2026-10-05 21-04-11', game: 'Apex Legends', short: false, chapters: [{ atMs: 0, title: 'Drop' }, { atMs: 65_000, title: 'Final ring' }] });
    expect(m.title).toBe('Apex Legends highlights');
    expect(m.description).toContain('0:00 Drop');
    expect(m.description).toContain('1:05 Final ring');
    expect(m.description).toContain('#ApexLegends');
    expect(m.tags).toContain('Apex Legends gameplay');
    const s = buildMetadata({ name: 'Clutch 1v3', game: null, short: true, chapters: [] });
    expect(s.title).toBe('Clutch 1v3 #Shorts');
    expect(s.description).toContain('#Shorts');
    expect(buildMetadata({ name: 'x'.repeat(140), game: null, short: false, chapters: [] }).title.length).toBeLessThanOrEqual(100);
  });
});

describe('jpegSize', () => {
  it('reads the size of an ffmpeg-made JPEG and rejects other data', () => {
    const jpg = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=1280x720', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    expect(jpegSize(jpg)).toEqual({ width: 1280, height: 720 });
    expect(jpegSize(Buffer.from('not a jpeg'))).toBeNull();
  });
});
