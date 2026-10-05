/**
 * StudioBridge contract tests: every operation the renderer can call, against real
 * services (fake obs-websocket server + real ffmpeg). Every snapshot and response is
 * checked with the renderer's own validators, exactly as the DesktopAdapter does.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClipAsset, EditProject, ExportPreset, Operation, SessionProfile, StudioSnapshot } from '../src/shared/contracts';
import { validateResponse, validateSnapshot } from '../src/shared/validation';
import { makeProject } from '../src/services/fixtures';
import { BridgeError, StudioBridge } from '../src/services/bridge/StudioBridge';
import type { DriftCore } from '../src/services/DriftCore';
import { FakeObs } from './helpers/fakeObs';
import { makeFakeSdCli, pngOf, startFakeWebUi } from './helpers/fakeImageEngines';
import { generateClip, makeCore, ok, tempDir, waitFor, type TestPlatform } from './helpers/env';

const posixOnly = process.platform === 'win32' ? it.skip : it;

function probe(file: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as {
    format: { duration: string };
    streams: Array<{ codec_type: string; width?: number; height?: number; duration?: string }>;
  };
}

describe('StudioBridge (renderer protocol v1 over desktop services)', () => {
  let dir: string;
  let obs: FakeObs;
  let core: DriftCore;
  let platform: TestPlatform;
  let bridge: StudioBridge;
  let published: StudioSnapshot[];
  let n = 0;

  /** Calls an operation exactly like DesktopAdapter: then validates the reply with the renderer's validator. */
  async function call<T = unknown>(op: Operation, input?: unknown): Promise<T> {
    const r = await bridge.request(op, input, `req-${++n}`);
    validateResponse(op, r);
    return r as T;
  }
  const state = async () => validateSnapshot(await bridge.readState());

  beforeEach(async () => {
    dir = tempDir();
    let i = 0;
    obs = new FakeObs({ password: 'hunter2', onSaveReplay: () => generateClip(path.join(dir, 'obs', `Replay ${++i}.mp4`), 6, { size: '1280x720' }) });
    const port = await obs.start();
    ({ core, platform } = makeCore(dir));
    ok(await core.invoke('settings.update', { obs: { port, autoConnect: false }, media: { libraryDirectory: path.join(dir, 'lib') } }));
    await core.start();
    published = [];
    bridge = new StudioBridge(core, { publish: (s) => published.push(s), throttleMs: 20 });
    await bridge.start();
  });

  afterEach(async () => {
    try {
      execFileSync('pkill', ['-f', path.join(dir, 'games')]);
    } catch {
      /* nothing running */
    }
    bridge.dispose();
    await core.dispose();
    await obs.stop();
  });

  it('initial snapshot is valid desktop data with honest capabilities and no fixtures', async () => {
    const s = await state();
    expect(s.mode).toBe('desktop');
    expect(s.clips).toEqual([]);
    expect(s.profiles).toEqual([]);
    expect(s.selectedProfileId).toBe('unconfigured');
    expect(s.obs.connection).toBe('disconnected');
    expect(s.capabilities.recording.available).toBe(false);
    expect(s.capabilities.recording.reason).toBeTruthy();
    expect(s.capabilities.windowsAudio.available).toBe(false);
    expect(s.telemetry.gameFps).toBeNull();
    expect(s.capabilities.export.available).toBe(true);
  });

  it('rejects demo-only operations, unknown operations and malformed input in main', async () => {
    await expect(bridge.request('reset', undefined, 'a')).rejects.toBeInstanceOf(BridgeError);
    await expect(bridge.request('scenario', { name: 'empty' }, 'b')).rejects.toThrow(/desktop mode/);
    await expect(bridge.request('rm -rf', {}, 'c')).rejects.toThrow(/allowlisted/);
    await expect(bridge.request('audio', { id: 'microphone', gain: 5, muted: false }, 'd')).rejects.toThrow(/between/);
    await expect(bridge.request('importClips', { files: [{ name: 'x.mp4', durationMs: 10, mediaHandle: 'blob:abc' }] }, 'e')).rejects.toThrow(/Import media/);
  });

  it('connects with the stored password and reflects real OBS state, sources, audio and preview', async () => {
    await call('setObsPassword', { password: 'hunter2' });
    await call('connect', { host: '127.0.0.1', port: obs.port });
    const s = await waitFor(async () => {
      const x = await state();
      return x.obs.connection === 'connected' && x.audio.length ? x : null;
    });
    expect(s.obs.scenes).toEqual(['Gameplay', 'BRB', 'Starting Soon']);
    expect(s.obs.scene).toBe('Gameplay');
    expect(s.obs.sources).toEqual(['Game Capture']);
    expect(s.obs.outputFps).toBe(60);
    expect(s.obs.encoderSkippedFrames).toBe(2);
    expect(s.obs.previewUrl).toMatch(/^drift-media:\/\/preview\/program/);
    const mic = s.audio.find((a) => a.id === 'microphone')!;
    expect(mic.deviceName).toBe('Microphone (Shure MV7)');
    expect(s.capabilities.recording.available).toBe(true);
    expect(s.capabilities.replay.available).toBe(true);
  });

  it('wrong password surfaces a clear, recoverable error', async () => {
    await call('setObsPassword', { password: 'nope' });
    await expect(call('connect', { host: '127.0.0.1', port: obs.port })).rejects.toThrow(/password|OBS/i);
    expect((await state()).obs.connection).toBe('failed');
  });

  posixOnly('full journey: profile → preflight → session → save replay → edit → export with audio → open output', async () => {
    await call('setObsPassword', { password: 'hunter2' });
    await call('connect', { host: '127.0.0.1', port: obs.port });

    // A real executable stands in for the game so launch + duplicate detection are exercised.
    const game = path.join(dir, 'games', `bg${process.pid % 100000}`);
    fs.mkdirSync(path.dirname(game), { recursive: true });
    fs.writeFileSync(game, '#!/bin/sh\nsleep 30\n');
    fs.chmodSync(game, 0o755);
    const profile: SessionProfile = {
      id: 'p-siege', name: 'Siege Night', game: 'Rainbow Six Siege', gamePath: game, scene: 'BRB',
      destination: path.join(dir, 'lib'), replayDurationMs: 30000, audioPreset: 'Balanced', companionApps: [], hotkey: 'Ctrl+Shift+F8',
    };
    await call('saveProfile', profile);
    let s = await state();
    // Profiles were removed: whatever id the renderer sends, there is one game setup.
    expect(s.profiles.map((p) => p.id)).toEqual(['setup']);
    expect(s.selectedProfileId).toBe('setup');
    expect(s.profiles[0]!.game).toBe('Rainbow Six Siege');
    expect(platform.shortcutsRegistered.has('Ctrl+Shift+F8')).toBe(true); // profile hotkey drives Save Replay

    const prep = await call<{ steps: Array<{ label: string; ok: boolean; detail: string }> }>('prepareSession', { profileId: 'p-siege' });
    expect(prep.steps.find((x) => x.label === 'OBS connection')!.ok).toBe(true);
    expect(prep.steps.find((x) => x.label === 'Capture source')!.detail).toContain('Game Capture');

    const session = await call<{ id: string }>('startSession', { profileId: 'p-siege' });
    s = await waitFor(async () => {
      const x = await state();
      return x.activeSessionId === session.id && x.obs.replayBuffer && x.obs.scene === 'BRB' ? x : null;
    });
    expect(s.obs.recording).toBe(false); // Start Session never records…
    expect(s.obs.streaming).toBe(false); // …and never broadcasts
    await expect(call('startSession', { profileId: 'p-siege' })).rejects.toThrow(/already/);

    // Save Replay resolves with the real, indexed clip (after OBS reported the file).
    const clip = await call<ClipAsset>('saveReplay');
    expect(clip.fixture).toBe(false);
    expect(clip.sessionId).toBe(session.id);
    expect(clip.game).toBe('Rainbow Six Siege');
    expect(clip.durationMs).toBeGreaterThan(5500);
    expect(clip.mediaHandle).toMatch(/^drift-media:\/\/clip\//);
    expect(clip.thumbnailUrl).toMatch(/^drift-media:\/\/thumb\//);
    s = await state();
    expect(s.sessions[0]!.clipIds).toContain(clip.id);

    await call('updateClip', { ...clip, tags: ['Clutch', 'Ranked'], favorite: true });
    expect((await state()).clips[0]).toMatchObject({ tags: ['Clutch', 'Ranked'], favorite: true });

    // Edit with the renderer's own model: trim 1.0–4.5 s, vertical, crop right, caption, faded segment.
    const draft: EditProject = makeProject(clip);
    draft.tracks[0]!.segments[0] = { ...draft.tracks[0]!.segments[0]!, inMs: 1000, outMs: 4500, gain: 0.8, fadeInMs: 200, fadeOutMs: 300 };
    draft.aspect = '9:16';
    draft.cropX = 75;
    draft.captions = [{ id: 'c1', text: 'nice', startMs: 200, endMs: 1500 }];
    draft.captionStyle = { ...draft.captionStyle, size: 42 };
    await call('saveProject', draft);
    expect((await state()).projects[0]!.id).toBe(draft.id);
    const conv = bridge.toCoreProject(draft);
    expect(conv.crop!.x).toBeCloseTo((1 - 0.31640625) * 0.75, 3);
    expect(conv.captionStyle.sizePx).toBe(24); // 42 px on a 1920-high canvas → 24 px at 1080

    const preset: ExportPreset = { destination: path.join(dir, 'exports'), aspect: '9:16', resolution: 720, fps: 30, quality: 'balanced', codec: 'h264' };
    await expect(call('export', { project: draft, preset, simulateFailure: true })).rejects.toThrow(/browser demo/);
    const job = await call<{ id: string; status: string; simulated: boolean }>('export', { project: draft, preset, simulateFailure: false });
    expect(job.simulated).toBe(false);
    const done = await waitFor(async () => {
      const j = (await state()).jobs.find((x) => x.id === job.id)!;
      return j.status === 'completed' || j.status === 'failed' ? j : null;
    }, { timeoutMs: 90_000 });
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(done.progress).toBe(100);
    expect(done.outputHandle).toBe(job.id);
    const out = core.jobs.get(job.id).outputPath!;
    const p = probe(out);
    const v = p.streams.find((x) => x.codec_type === 'video')!;
    const a = p.streams.find((x) => x.codec_type === 'audio')!;
    expect([v.width, v.height]).toEqual([720, 1280]);
    expect(Math.abs(Number(p.format.duration) - 3.5)).toBeLessThan(0.12);
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.1);

    await call('openOutput', { id: job.id });
    expect(platform.opened).toEqual([out]);

    await call('sessionNotes', { id: session.id, notes: 'Clutch in round 3' });
    expect((await state()).sessions[0]!.notes).toBe('Clutch in round 3');
    await call('endSession');
    s = await state();
    expect(s.activeSessionId).toBeNull();
    expect(s.sessions[0]!.endedAt).not.toBeNull();
  });

  it('capture controls, scenes, audio and Go Live map onto OBS; profile changes never stop a stream', async () => {
    await call('setObsPassword', { password: 'hunter2' });
    await call('connect', { host: '127.0.0.1', port: obs.port });
    await waitFor(async () => ((await state()).audio.length ? true : null));
    await call('recording', { enabled: true });
    expect(obs.recording).toBe(true);
    await call('recording', { enabled: false });
    expect(obs.recording).toBe(false);
    await call('replay', { enabled: true });
    expect(obs.replay).toBe(true);
    await call('scene', { name: 'Starting Soon' });
    expect(obs.currentScene).toBe('Starting Soon');
    await expect(call('scene', { name: 'Nope' })).rejects.toThrow(/does not exist/);

    await call('audio', { id: 'microphone', gain: 0.5, muted: true });
    expect(obs.inputs['Mic/Aux']!.muted).toBe(true);
    expect(obs.inputs['Mic/Aux']!.volumeDb).toBeCloseTo(-6, 0);
    const mic = (await state()).audio.find((x) => x.id === 'microphone')!;
    expect(mic.muted).toBe(true);
    expect(mic.gain).toBeCloseTo(0.5, 1);

    await call('streaming', { enabled: true, destination: 'Twitch · drift' });
    expect(obs.streaming).toBe(true);
    await waitFor(async () => ((await state()).obs.streamDestination === 'Twitch · drift' ? true : null));
    await call('saveProfile', { id: 'a', name: 'A', game: 'G', gamePath: 'steam://rungameid/1', scene: 'Gameplay', destination: dir, replayDurationMs: 30000, audioPreset: 'Balanced', companionApps: [], hotkey: '' });
    await call('saveProfile', { id: 'b', name: 'B', game: 'G', gamePath: 'steam://rungameid/2', scene: 'Gameplay', destination: dir, replayDurationMs: 30000, audioPreset: 'Balanced', companionApps: [], hotkey: '' });
    await call('selectProfile', { id: 'b' });
    expect(obs.streaming).toBe(true);
    await call('streaming', { enabled: false, destination: '' });
    expect(obs.streaming).toBe(false);
  });

  it('launches a launcher-URI game and refuses arbitrary schemes', async () => {
    await call('saveProfile', { id: 'u', name: 'Orbit', game: 'Destiny 2', gamePath: 'steam://rungameid/1085660', scene: '', destination: dir, replayDurationMs: 30000, audioPreset: 'Balanced', companionApps: [], hotkey: '' });
    await call('launchGame', { profileId: 'u' });
    expect(platform.externals).toEqual(['steam://rungameid/1085660']);
    await expect(call('saveProfile', { id: 'x', name: 'Bad', game: 'X', gamePath: 'file:///C:/Windows/System32/cmd.exe', scene: '', destination: dir, replayDurationMs: 30000, audioPreset: 'Balanced', companionApps: [], hotkey: '' })).rejects.toThrow(/Unsupported launcher/);
    // A second save replaces the single setup instead of creating another profile.
    await call('saveProfile', { id: 'y', name: 'Other', game: 'Valorant', gamePath: 'steam://rungameid/3', scene: '', destination: dir, replayDurationMs: 30000, audioPreset: 'Balanced', companionApps: [], hotkey: 'Ctrl+1' });
    const s = await state();
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0]).toMatchObject({ id: 'setup', game: 'Valorant', gamePath: 'steam://rungameid/3' });
  });

  it('native import, relink after a move, user music in export, and settings round-trip', async () => {
    const a = generateClip(path.join(dir, 'media', 'a.mp4'), 4);
    const mkv = generateClip(path.join(dir, 'media', 'b.mkv'), 3, { container: 'mkv' });
    platform.pickResult = [a, mkv];
    const clips = await call<ClipAsset[]>('importNative');
    expect(clips.map((c) => c.name)).toEqual(['a.mp4', 'b.mkv']);
    expect(clips[1]!.status).toBe('processing'); // MKV gets a playable proxy first
    await waitFor(async () => ((await state()).clips.find((c) => c.name === 'b.mkv')?.status === 'ready' ? true : null));
    platform.pickResult = [];
    expect(await call('importNative')).toEqual([]); // cancelled dialog

    const moved = path.join(dir, 'moved', 'a.mp4');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(a, moved);
    ok(await core.invoke('clips.verify', {}));
    expect((await state()).clips.find((c) => c.id === clips[0]!.id)!.status).toBe('missing');
    platform.pickResult = [moved];
    const relinked = await call<ClipAsset>('relinkNative', { id: clips[0]!.id });
    expect(relinked.status).toBe('ready');

    const music = path.join(dir, 'media', 'song.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10', music]);
    platform.pickResult = [music];
    const m = await call<{ handle: string; name: string }>('pickMusic');
    expect(m.name).toBe('song.wav');
    expect(bridge.resolveMusic(m.handle.split('/').pop()!)).toBe(music);
    const draft = makeProject(relinked);
    draft.musicHandle = m.handle;
    draft.musicGain = 0.25;
    await call('saveProject', draft);
    const job = await call<{ id: string }>('export', { project: draft, preset: { destination: 'Exports', aspect: '16:9', resolution: 720, fps: 30, quality: 'balanced', codec: 'h264' }, simulateFailure: false });
    const done = await waitFor(() => {
      const j = core.jobs.get(job.id);
      return ['succeeded', 'failed'].includes(j.state) ? j : null;
    }, { timeoutMs: 90_000 });
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.outputPath!.startsWith(path.join(dir, 'lib', 'Exports'))).toBe(true);

    await call('saveSettings', { mediaFolder: path.join(dir, 'lib2'), obsHost: '127.0.0.1', obsPort: 4456, appearance: 'contrast', transcription: false, workerLimit: 2, shortcuts: false });
    const s = await state();
    expect(s.settings).toMatchObject({ mediaFolder: path.join(dir, 'lib2'), obsPort: 4456, appearance: 'contrast', workerLimit: 2, shortcuts: false });
    expect(fs.existsSync(path.join(dir, 'lib2'))).toBe(true);
    expect(platform.shortcutsRegistered.size).toBe(0);
    await expect(call('saveSettings', { ...s.settings, mediaFolder: 'relative/folder' })).rejects.toThrow(/full folder path/);
  });

  it('migrates older multi-profile data to the single setup (selected profile wins)', async () => {
    const kv = (await import('../src/services/core/database')).kvSet;
    const old = (id: string, game: string) => ({ id, name: game, game, gamePath: `steam://rungameid/${id.length}`, scene: 'Gameplay', destination: dir, replayDurationMs: 30000, audioPreset: 'Balanced', companionApps: [], hotkey: '' });
    kv(core.db, 'ui.profiles', { a: old('a', 'Old A'), bb: old('bb', 'Old B') });
    kv(core.db, 'ui.selectedProfileId', 'bb');
    const s = await state();
    expect(s.profiles).toEqual([{ ...old('bb', 'Old B'), id: 'setup' }]);
    const prep = await call<{ steps: unknown[] }>('prepareSession', { profileId: 'bb' });
    expect(prep.steps.length).toBeGreaterThan(0);
  });

  it('a failed export reports the error and can be retried after the cause is fixed', async () => {
    const src = generateClip(path.join(dir, 'media', 'gone.mp4'), 3);
    platform.pickResult = [src];
    const [clip] = await call<ClipAsset[]>('importNative');
    const draft = makeProject(clip!);
    const hidden = `${src}.hidden`;
    fs.renameSync(src, hidden);
    const job = await call<{ id: string }>('export', { project: draft, preset: { destination: path.join(dir, 'out'), aspect: '16:9', resolution: 720, fps: 30, quality: 'balanced', codec: 'h264' }, simulateFailure: false });
    const failed = await waitFor(async () => {
      const j = (await state()).jobs.find((x) => x.id === job.id)!;
      return j.status === 'failed' ? j : null;
    });
    expect(failed.error?.message).toMatch(/missing/i);
    expect(failed.outputHandle).toBeNull();
    await expect(call('openOutput', { id: job.id })).rejects.toThrow(/not completed/);
    fs.renameSync(hidden, src);
    await call('retryJob', { id: job.id });
    const ok2 = await waitFor(async () => {
      const j = (await state()).jobs.find((x) => x.id === job.id)!;
      return j.status === 'completed' ? j : null;
    }, { timeoutMs: 60_000 });
    expect(ok2.outputHandle).toBe(job.id);
  });

  it('same requestId is idempotent (a retried click does not export twice)', async () => {
    const src = generateClip(path.join(dir, 'media', 'idem.mp4'), 3);
    platform.pickResult = [src];
    const [clip] = await call<ClipAsset[]>('importNative');
    const input = { project: makeProject(clip!), preset: { destination: path.join(dir, 'out'), aspect: '16:9', resolution: 720, fps: 30, quality: 'balanced', codec: 'h264' }, simulateFailure: false };
    const [j1, j2] = await Promise.all([bridge.request('export', input, 'same-id'), bridge.request('export', input, 'same-id')]);
    expect((j1 as { id: string }).id).toBe((j2 as { id: string }).id);
    expect(core.jobs.list().filter((j) => j.kind === 'export')).toHaveLength(1);
    await call('cancelJob', { id: (j1 as { id: string }).id });
  });

  it('pushes snapshots on change, each one valid', async () => {
    await call('setObsPassword', { password: 'hunter2' });
    await call('connect', { host: '127.0.0.1', port: obs.port });
    obs.startRecordingFromObs(); // action performed directly in OBS
    await waitFor(() => published.some((s) => s.obs.recording));
    for (const s of published) validateSnapshot(s);
    const revs = published.map((s) => (s as StudioSnapshot & { revision: number }).revision);
    expect([...revs].sort((a, b) => a - b)).toEqual(revs);
  });
  it('YouTube: loud-moment detection, Short export at -14 LUFS, upload kit, thumbnail and Studio hand-off', async () => {
    // 20 s clip: quiet tone, with a loud burst at 12–14 s.
    const src = path.join(dir, 'media', 'burst.mp4');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
      '-filter_complex', "[1:a]volume='if(between(t,12,14),1.0,0.03)':eval=frame[a]", '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    platform.pickResult = [src];
    const [clip] = await call<ClipAsset[]>('importNative');
    await waitFor(async () => ((await state()).clips.find((c) => c.id === clip!.id)?.status === 'ready' ? true : null));

    const moments = await call<Array<{ atMs: number; excessLu: number }>>('suggestMoments', { clipId: clip!.id });
    expect(moments.length).toBeGreaterThan(0);
    expect(moments[0]!.atMs).toBeGreaterThan(10_000);
    expect(moments[0]!.atMs).toBeLessThan(15_000);
    expect(moments[0]!.excessLu).toBeGreaterThan(10);

    // Vertical Short around the moment, loudness normalised for YouTube.
    const draft = makeProject(clip!);
    draft.name = 'Clutch moment';
    draft.aspect = '9:16';
    draft.tracks[0]!.segments = [{ ...draft.tracks[0]!.segments[0]!, inMs: 6_000, outMs: 16_000, offsetMs: 0 }];
    await call('saveProject', draft);
    const job = await call<{ id: string }>('export', { project: draft, preset: { destination: 'Exports', aspect: '9:16', resolution: 720, fps: 30, quality: 'balanced', codec: 'h264', loudness: true }, simulateFailure: false });
    const done = await waitFor(() => {
      const j = core.jobs.get(job.id);
      return ['succeeded', 'failed'].includes(j.state) ? j : null;
    }, { timeoutMs: 90_000 });
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    const out = probe(done.outputPath!);
    expect(Math.abs(Number(out.format.duration) - 10)).toBeLessThan(0.15);

    const kit = await call<import('../src/shared/contracts').YouTubeKit>('youtubeKit', { jobId: job.id });
    expect(kit.isShort).toBe(true);
    expect([kit.width, kit.height]).toEqual([720, 1280]);
    expect(Math.abs(kit.loudnessLufs! - -14)).toBeLessThan(1.5);
    expect(kit.checks.find((c) => c.id === 'loudness')!.status).toBe('pass');
    expect(kit.checks.find((c) => c.id === 'length')!.status).toBe('pass');
    expect(kit.checks.find((c) => c.id === 'resolution')!.status).toBe('warn'); // 720p: suggests 1080p
    expect(kit.title).toBe('Clutch moment #Shorts');
    expect(kit.chapters).toEqual([]);
    expect(kit.frames.length).toBeGreaterThanOrEqual(2);

    // Thumbnail: only a 1280×720 JPEG is accepted; it is written next to the video and revealed.
    const jpg = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=1280x720', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    const saved = await call<{ fileName: string }>('saveThumbnail', { jobId: job.id, dataUrl: 'data:image/jpeg;base64,' + jpg.toString('base64') });
    expect(saved.fileName).toBe('Clutch moment thumbnail.jpg');
    expect(fs.existsSync(path.join(path.dirname(done.outputPath!), saved.fileName))).toBe(true);
    expect(platform.revealed.at(-1)).toBe(path.join(path.dirname(done.outputPath!), saved.fileName));
    const small = kit.frames[0]!.replace(/^data:image\/jpeg;base64,/, '');
    expect(Buffer.from(small, 'base64').length).toBeGreaterThan(1000);
    const wrong = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    await expect(call('saveThumbnail', { jobId: job.id, dataUrl: 'data:image/jpeg;base64,' + wrong.toString('base64') })).rejects.toThrow(/1280×720/);
    await expect(call('saveThumbnail', { jobId: job.id, dataUrl: 'data:image/png;base64,AAAA' })).rejects.toThrow(/JPEG/);

    await call('revealOutput', { id: job.id });
    expect(platform.revealed.at(-1)).toBe(done.outputPath);
    // No browser hook in this bridge: reported as unavailable, never silently ignored.
    await expect(call('openYouTubeStudio')).rejects.toThrow(/not available/);
  });

  it('voice "Mark that" adds a timestamped marker to the active session', async () => {
    await bridge.voiceHeard('mark that', 0.9);
    expect(core.recentNotices()[0]!.message).toMatch(/Start a session first/);

    await call('setObsPassword', { password: 'hunter2' });
    await call('connect', { host: '127.0.0.1', port: obs.port });
    await call('saveProfile', { id: 'x', name: 'Night', game: 'Halo', gamePath: 'steam://rungameid/1', scene: 'Gameplay', destination: dir, replayDurationMs: 30000, audioPreset: 'Balanced', companionApps: [], hotkey: '' });
    const session = await call<{ id: string }>('startSession', { profileId: 'setup' });
    await new Promise((r) => setTimeout(r, 4100)); // past the one-action-per-utterance cooldown
    await bridge.voiceHeard('mark that', 0.9);
    const s = await state();
    const events = s.sessions.find((x) => x.id === session.id)!.events.map((e) => e.message);
    expect(events.some((m) => /^Marker · 0:00:0\d into the session \(voice\)$/.test(m))).toBe(true);
    expect(s.voice?.lastCommand).toBe('mark');
    await call('endSession');
  });
  posixOnly('local AI thumbnails: setup, WebUI and stable-diffusion.cpp generation, cancel, no generation while live', async () => {
    type St = import('../src/shared/contracts').ThumbAiStatus;
    type Gen = { images: string[]; engine: string; seed: number; ms: number };
    let st = await call<St>('thumbAiStatus');
    expect(st).toMatchObject({ engine: 'off', ready: false, busy: false });
    await expect(call('generateThumbnail', { description: 'x', initImage: null, strength: 0.5, count: 1 })).rejects.toThrow(/Settings/);

    // WebUI on this PC; a LAN address is refused.
    const ui = await startFakeWebUi();
    try {
      await expect(call('thumbAiConfigure', { engine: 'webui', serverUrl: 'http://192.168.0.9:7860' })).rejects.toThrow(/this PC/);
      st = await call<St>('thumbAiConfigure', { engine: 'webui', serverUrl: ui.url });
      expect(st.ready).toBe(true);
      expect(st.detail).toMatch(/Connected · sd_xl_turbo/);
      const g = await call<Gen>('generateThumbnail', { description: 'storm over a castle', initImage: null, strength: 0.6, count: 2 });
      expect(g.images).toHaveLength(2);
      expect(g.engine).toBe('Stable Diffusion WebUI');
      const start = 'data:image/png;base64,' + pngOf(1280, 720).toString('base64');
      await call<Gen>('generateThumbnail', { description: 'same, but at dawn', initImage: start, strength: 0.4, count: 1 });
      expect(ui.requests.at(-1)!.path).toBe('/sdapi/v1/img2img');
      // Style, things to avoid, quality and a fixed seed ("More like this") reach the engine.
      const v = await call<Gen>('generateThumbnail', { description: 'rooftop duel', initImage: null, strength: 0.6, count: 1, style: 'neon', avoid: 'people', quality: 'best', seed: 4242 });
      expect(v.seed).toBe(4242);
      const body = ui.requests.at(-1)!.body;
      expect(String(body.prompt)).toMatch(/^rooftop duel, synthwave/);
      expect(String(body.negative_prompt)).toMatch(/people$/);
      expect(body).toMatchObject({ seed: 4242, steps: 6 });
      await expect(call('generateThumbnail', { description: 'x', initImage: null, strength: 0.6, count: 1, style: 'vaporwave' })).rejects.toThrow(/style/);
    } finally {
      await ui.close();
    }

    // Built-in engine: choosing the program and model switches to it.
    const exe = makeFakeSdCli(path.join(dir, 'sd'));
    const model = path.join(dir, 'sd', 'sd_turbo.gguf');
    fs.writeFileSync(model, 'm');
    platform.pickResult = [exe];
    st = await call<St>('thumbAiPick', { kind: 'engine' });
    expect(st).toMatchObject({ engine: 'sdcpp', engineFile: 'sd-cli', ready: false });
    platform.pickResult = [model];
    st = await call<St>('thumbAiPick', { kind: 'model' });
    expect(st).toMatchObject({ ready: true, modelFile: 'sd_turbo.gguf' });
    const jpg = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    const g = await call<Gen>('generateThumbnail', { description: 'arena', initImage: 'data:image/jpeg;base64,' + jpg.toString('base64'), strength: 0.5, count: 1 });
    expect(g.images[0]!.startsWith('data:image/png;base64,')).toBe(true);
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'sd', 'sd-calls.log'), 'utf8').trim().split('\n').pop()!) as string[];
    expect(args[args.indexOf('-W') + 1]).toBe('768');
    expect(args).toContain('--init-img');
    await expect(call('generateThumbnail', { description: 'x', initImage: 'data:image/gif;base64,R0lG', strength: 0.5, count: 1 })).rejects.toThrow(/PNG or JPEG/);

    // Cancel a long run.
    makeFakeSdCli(path.join(dir, 'sd'), 'slow');
    const running = bridge.request('generateThumbnail', { description: 'slow', initImage: null, strength: 0.5, count: 1 }, 'gen-slow');
    await waitFor(async () => ((await call<St>('thumbAiStatus')).busy ? true : null));
    await call('cancelThumbnail');
    await expect(running).rejects.toThrow(/Cancelled/);
    expect((await call<St>('thumbAiStatus')).busy).toBe(false);

    // Never while live: generation saturates the GPU.
    makeFakeSdCli(path.join(dir, 'sd'));
    await call('setObsPassword', { password: 'hunter2' });
    await call('connect', { host: '127.0.0.1', port: obs.port });
    await call('streaming', { enabled: true, destination: 'YouTube' });
    await waitFor(async () => ((await state()).obs.streaming ? true : null));
    await expect(call('generateThumbnail', { description: 'x', initImage: null, strength: 0.5, count: 1 })).rejects.toThrow(/live/);
    await call('streaming', { enabled: false, destination: 'YouTube' });
  });
});
