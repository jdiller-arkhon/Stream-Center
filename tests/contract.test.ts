import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, METHOD_NAMES } from '../src/services/contract/api';
import { CONTRACT_VERSION_FOR_PRELOAD, EVENT_ALLOWLIST, METHOD_ALLOWLIST } from '../src/services/contract/channels';
import { CONTRACT_VERSION, ExportPreset, Settings } from '../src/services/contract/dto';
import { EXPORT_PRESETS, defaultSettings } from '../src/services/contract/defaults';
import { buildAss, buildExportCommand, escapeAssText } from '../src/services/media/exportBuilder';
import { ProgressParser, playbackPlan } from '../src/services/media/ffmpeg';
import { collisionSafePath, safeAbsolutePath, sanitizeFileStem } from '../src/services/core/paths';
import { redact } from '../src/services/core/logger';
import { validateUri } from '../src/services/sessions/launcher';
import { parseWhisperJson } from '../src/services/transcription/whisper';
import { durationTolerance, resolveEncoder } from '../src/services/jobs/mediaJobs';
import { toDb } from '../src/services/obs/ObsService';
import { tempDir } from './helpers/env';
import fs from 'node:fs';
import path from 'node:path';

describe('shared contract', () => {
  it('preload allowlists match the method/event registry exactly', () => {
    expect([...METHOD_ALLOWLIST].sort()).toEqual([...METHOD_NAMES].sort());
    expect([...EVENT_ALLOWLIST].sort()).toEqual([...EVENT_NAMES].sort());
    expect(CONTRACT_VERSION_FOR_PRELOAD).toBe(CONTRACT_VERSION);
  });

  it('defaults and presets satisfy their schemas', () => {
    expect(Settings.safeParse(defaultSettings()).success).toBe(true);
    for (const p of EXPORT_PRESETS) expect(ExportPreset.safeParse(p).success, p.id).toBe(true);
    expect(EXPORT_PRESETS.map((p) => p.name)).toEqual(['Clean Highlight', 'Cinematic', 'Vertical Short', 'Squad Recap']);
  });
});

describe('export command builder', () => {
  const clips = new Map([
    ['c1', { id: 'c1', path: '/m/a.mp4', durationMs: 10_000, hasVideo: true, hasAudio: true }],
    ['c2', { id: 'c2', path: '/m/b.mkv', durationMs: 5_000, hasVideo: true, hasAudio: false }],
  ]);
  const base = {
    id: 'p', name: 'P', revision: 1, aspect: '16:9' as const, crop: null, webcam: null, captions: [], music: null,
    captionStyle: { fontFamily: 'Segoe UI', sizePx: 64, color: '#FFFFFF', outlineColor: '#000000', background: false, position: 'bottom' as const, bold: true },
    originalAudioGainDb: 0, videoFadeInMs: 0, videoFadeOutMs: 0, presetId: null, createdAt: '', updatedAt: '',
    tracks: [{ id: 't', kind: 'main' as const, muted: false, items: [
      { id: 'i1', clipId: 'c1', sourceInMs: 1000, sourceOutMs: 4000, gainDb: -3, fadeInMs: 0, fadeOutMs: 0 },
      { id: 'i2', clipId: 'c2', sourceInMs: 0, sourceOutMs: 2000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 },
    ] }],
  };
  const s = { aspect: '16:9' as const, width: 1920, height: 1080, fps: 60 as const, quality: 'high' as const, codec: 'h264' as const, encoder: 'software' as const, audioBitrateKbps: 192 };

  it('trims audio and video on identical boundaries, uses silence for clips without audio, and passes args as an array', () => {
    const cmd = buildExportCommand(base, s, clips, 'software', '/out/x.mp4');
    const graph = cmd.args[cmd.args.indexOf('-filter_complex') + 1]!;
    expect(cmd.expectedDurationMs).toBe(5000);
    expect(graph).toContain('[0:v:0]trim=start=1.000:end=4.000');
    expect(graph).toContain('[0:a:0]atrim=start=1.000:end=4.000');
    expect(graph).toContain('volume=-3dB');
    expect(graph).toContain('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2.000');
    expect(graph).toContain('concat=n=2:v=1:a=1');
    expect(cmd.args).toContain('libx264');
    expect(cmd.args.at(-1)).toBe('/out/x.mp4');
    expect(cmd.args.filter((a) => a === '-i')).toHaveLength(2);
  });

  it('selects hardware encoder args and rejects empty or too-short timelines', () => {
    expect(buildExportCommand(base, s, clips, 'nvenc', '/o.mp4').args).toContain('h264_nvenc');
    expect(() => buildExportCommand({ ...base, tracks: [{ ...base.tracks[0]!, items: [] }] }, s, clips, 'software', '/o.mp4')).toThrow(/empty/);
    expect(() =>
      buildExportCommand({ ...base, tracks: [{ ...base.tracks[0]!, items: [{ ...base.tracks[0]!.items[0]!, sourceOutMs: 1050 }] }] }, s, clips, 'software', '/o.mp4'),
    ).toThrow(/shorter/);
  });

  it('escapes caption text so it cannot inject ASS override tags', () => {
    expect(escapeAssText('a{\\b1}b\nc')).toBe('a(⧵b1)b\\Nc');
    const ass = buildAss([{ id: 'x', startMs: 0, endMs: 1234, text: 'Hi' }], base.captionStyle, 1080, 1920, 5000);
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.23,Drift');
    expect(ass).toContain('PlayResY: 1920');
  });

  it('chooses encoders truthfully', async () => {
    expect(await resolveEncoder('auto', [], true)).toBe('software');
    expect(await resolveEncoder('auto', ['qsv', 'nvenc'], true)).toBe('nvenc');
    expect(await resolveEncoder('auto', ['nvenc'], false)).toBe('software');
    await expect(resolveEncoder('amf', ['nvenc'], true)).rejects.toThrow(/not available/);
    expect(durationTolerance(1000)).toBe(250);
  });
});

describe('utilities', () => {
  it('parses ffmpeg -progress output', () => {
    const p = new ProgressParser();
    expect(p.push('frame=10\nout_time_us=1500000\nspeed=2.1x\nprogress=continue\n')).toBe(true);
    expect(p.outTimeUs).toBe(1_500_000);
    expect(p.speed).toBe('2.1x');
    p.push('out_time_us=N/A\nprogress=end\n');
    expect(p.ended).toBe(true);
    expect(p.outTimeUs).toBe(1_500_000);
  });

  it('plans playback for Chromium', () => {
    const v = (codec: string) => ({ codec, width: 1, height: 1, fps: 60, durationMs: 1 });
    const a = { codec: 'aac', channels: 2, sampleRate: 48000, durationMs: 1 };
    expect(playbackPlan({ durationMs: 1, container: 'mp4', video: v('h264'), audio: a, bitRate: null })).toBe('direct');
    expect(playbackPlan({ durationMs: 1, container: 'mkv', video: v('h264'), audio: a, bitRate: null })).toBe('remux');
    expect(playbackPlan({ durationMs: 1, container: 'mp4', video: v('hevc'), audio: a, bitRate: null })).toBe('transcode');
  });

  it('sanitizes file names and paths', () => {
    expect(sanitizeFileStem('Ace: clutch/round 3?')).toBe('Ace clutch round 3');
    expect(sanitizeFileStem('CON')).toBe('CON_');
    expect(sanitizeFileStem('...')).toBe('clip');
    expect(() => safeAbsolutePath('relative/x')).toThrow();
    expect(() => safeAbsolutePath('/a\0b')).toThrow();
    const d = tempDir();
    fs.writeFileSync(path.join(d, 'x.mp4'), '');
    expect(collisionSafePath(d, 'x', '.mp4')).toBe(path.join(d, 'x (2).mp4'));
  });

  it('allows only launcher URI schemes', () => {
    expect(validateUri('steam://rungameid/359550')).toBeNull();
    expect(validateUri('com.epicgames.launcher://apps/Fortnite?action=launch')).toBeNull();
    expect(validateUri('file:///etc/passwd')).toMatch(/Unsupported/);
    expect(validateUri('https://evil.example')).toMatch(/Unsupported/);
    expect(validateUri('ms-settings:privacy')).toMatch(/Unsupported/);
    expect(validateUri('steam://run/1 --malicious')).toMatch(/not allowed/);
  });

  it('redacts secrets from structured logs', () => {
    expect(redact({ host: 'x', password: 'p', nested: { authToken: 't', ok: 1 } })).toEqual({ host: 'x', password: '[redacted]', nested: { authToken: '[redacted]', ok: 1 } });
  });

  it('parses whisper.cpp JSON into timeline captions', () => {
    const caps = parseWhisperJson(
      { transcription: [{ offsets: { from: 0, to: 1200 }, text: ' nice shot ' }, { offsets: { from: 1300, to: 1400 }, text: 'x' }, { offsets: { from: 1500, to: 3000 }, text: '[BLANK_AUDIO]' }] },
      5000,
      9000,
    );
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ startMs: 5000, endMs: 6200, text: 'nice shot' });
  });

  it('converts OBS meter multipliers to dBFS', () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.5)).toBeCloseTo(-6, 0);
    expect(toDb(0)).toBe(-100);
  });
});
