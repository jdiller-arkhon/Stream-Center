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
});
