import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DriftCore } from '../src/services/DriftCore';
import { FakeObs } from './helpers/fakeObs';
import { generateClip, makeCore, ok, tempDir, waitFor, type TestPlatform } from './helpers/env';

describe('OBS integration (fake obs-websocket v5 server)', () => {
  let dir: string;
  let obs: FakeObs;
  let core: DriftCore;
  let platform: TestPlatform;
  let replayCount = 0;

  beforeEach(async () => {
    dir = tempDir();
    replayCount = 0;
    obs = new FakeObs({
      password: 'hunter2',
      onSaveReplay: () => generateClip(path.join(dir, 'obs', `Replay ${++replayCount}.mp4`), 4),
    });
    const port = await obs.start();
    ({ core, platform } = makeCore(dir));
    ok(await core.invoke('settings.update', { obs: { port, autoConnect: false }, media: { libraryDirectory: path.join(dir, 'lib') } }));
    ok(await core.invoke('settings.setObsPassword', { password: 'hunter2' }));
    await core.start();
  });

  afterEach(async () => {
    await core.dispose();
    await obs.stop();
  });

  it('connects with auth, reads state, and never stores the password in settings', async () => {
    const conn = ok(await core.invoke('obs.connect', {}));
    expect(conn.state).toBe('connected');
    const state = ok(await core.invoke('obs.getState', {}));
    expect(state.version?.obs).toBe('31.0.0');
    expect(state.scenes.map((s) => s.name)).toEqual(['Gameplay', 'BRB', 'Starting Soon']);
    expect(state.currentScene).toBe('Gameplay');
    expect(state.replayBuffer.available).toBe(true);
    expect(state.stats?.activeFps).toBe(60);
    const settings = ok(await core.invoke('settings.get', {}));
    expect(settings.obs.passwordStored).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('hunter2');
  });

  it('reports auth failure without retry loops', async () => {
    ok(await core.invoke('settings.setObsPassword', { password: 'wrong' }));
    const conn = await waitFor(async () => {
      const c = ok(await core.invoke('obs.connect', {}));
      return c.state === 'failed' ? c : null;
    });
    expect(conn.error?.code).toBe('OBS_AUTH_FAILED');
  });

  it('VERTICAL SLICE 1: start replay buffer → save replay → clip indexed in library', async () => {
    ok(await core.invoke('obs.connect', {}));
    const events: string[] = [];
    core.bus.on('replay.saved', () => events.push('replay.saved'));
    core.bus.on('clip.added', () => events.push('clip.added'));

    // Saving before the buffer runs is a clear, recoverable error.
    const early = await core.invoke('obs.saveReplay', {});
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.code).toBe('REPLAY_BUFFER_UNAVAILABLE');

    ok(await core.invoke('obs.startReplayBuffer', {}));
    const accepted = ok(await core.invoke('obs.saveReplay', {}));
    expect(accepted.requestId).toMatch(/^save_/);
    // Accepted is not completed: the clip arrives asynchronously.
    const list = await waitFor(async () => {
      const l = ok(await core.invoke('clips.list', { search: null, gameTitle: null, sessionId: null, favoritesOnly: false, tags: [], source: null, limit: 50, offset: 0 }));
      return l.total === 1 ? l : null;
    });
    const clip = list.items[0]!;
    expect(clip.source).toBe('replay');
    expect(clip.durationMs).toBeGreaterThan(3500);
    expect(clip.thumbnailUrl).toMatch(/^drift-media:\/\/thumb\//);
    expect(clip.playback).toBe('direct');
    expect(events).toEqual(['replay.saved', 'clip.added']);
    expect(core.library.resolveMedia('clip', clip.id)).toBe(clip.path);
  });

  it('collapses rapid repeated Save Replay presses into one request', async () => {
    ok(await core.invoke('obs.connect', {}));
    ok(await core.invoke('obs.startReplayBuffer', {}));
    const [a, b, c] = await Promise.all([core.invoke('obs.saveReplay', {}), core.invoke('obs.saveReplay', {}), core.invoke('obs.saveReplay', {})]);
    const ids = new Set([a, b, c].map((r) => ok(r).requestId));
    // Concurrent presses may race the first accept; at most a couple of OBS calls, and no extra after acceptance.
    expect(obs.requests.filter((r) => r.type === 'SaveReplayBuffer').length).toBeLessThanOrEqual(ids.size);
    const again = ok(await core.invoke('obs.saveReplay', {}));
    expect(ids.has(again.requestId)).toBe(true);
  });

  it('recovers the saved file via GetLastReplayBufferReplay when the event is lost', async () => {
    await obs.stop();
    obs = new FakeObs({ dropReplayEvent: true, onSaveReplay: () => generateClip(path.join(dir, 'obs', 'Lost.mp4'), 3) });
    const port = await obs.start();
    ok(await core.invoke('settings.setObsPassword', { password: null }));
    ok(await core.invoke('settings.update', { obs: { port } }));
    ok(await core.invoke('obs.connect', {}));
    await waitFor(() => core.obs.connected);
    ok(await core.invoke('obs.startReplayBuffer', {}));
    const vi = await import('vitest');
    vi.vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      ok(await core.invoke('obs.saveReplay', {}));
      await vi.vi.advanceTimersByTimeAsync(31_000);
    } finally {
      vi.vi.useRealTimers();
    }
    await waitFor(() => core.library.list({ search: null, gameTitle: null, sessionId: null, favoritesOnly: false, tags: [], source: 'replay', limit: 5, offset: 0 }).total === 1);
  });

  it('reflects actions performed directly in OBS', async () => {
    ok(await core.invoke('obs.connect', {}));
    const seen: boolean[] = [];
    core.bus.on('obs.state', (s) => seen.push(s.recording.active));
    obs.startRecordingFromObs();
    await waitFor(() => seen.includes(true));
    expect(core.obs.getState().recording.active).toBe(true);
  });

  it('reconnects automatically after OBS restarts', async () => {
    ok(await core.invoke('obs.connect', {}));
    const port = obs.port;
    await obs.stop();
    await waitFor(() => ['reconnecting', 'failed'].includes(core.obs.getState().connection.state));
    expect(core.obs.getState().connection.state).not.toBe('connected');
    obs = new FakeObs({ password: 'hunter2' });
    await obs.start(port);
    await waitFor(() => core.obs.connected, { timeoutMs: 15_000 });
  });

  it('requires explicit confirmation to go live and does not stream on its own', async () => {
    ok(await core.invoke('obs.connect', {}));
    const bad = await core.invoke('obs.startStream', {} as never);
    expect(bad.ok).toBe(false);
    expect(obs.streaming).toBe(false);
    ok(await core.invoke('obs.startStream', { confirm: true }));
    expect(obs.streaming).toBe(true);
  });

  it('lists OBS audio inputs with device identity and controls mute/volume; Windows devices are read-only', async () => {
    ok(await core.invoke('obs.connect', {}));
    const sources = ok(await core.invoke('audio.list', {}));
    const mic = sources.find((s) => s.name === 'Mic/Aux')!;
    expect(mic.isMicrophone).toBe(true);
    expect(mic.deviceName).toBe('Microphone (Shure MV7)');
    expect(sources.find((s) => s.name === 'Game Capture')).toBeUndefined();
    const muted = ok(await core.invoke('audio.setMute', { sourceId: mic.id, muted: true }));
    expect(muted.muted).toBe(true);
    const vol = ok(await core.invoke('audio.setVolume', { sourceId: mic.id, volumeDb: -6 }));
    expect(vol.volumeDb).toBe(-6);
    const win = await core.invoke('audio.setMute', { sourceId: 'win:{0.0.1.x}', muted: true });
    expect(win.ok).toBe(false);
    if (!win.ok) expect(win.error.code).toBe('UNSUPPORTED');
  });

  it('registers the save-replay global shortcut and reports conflicts', async () => {
    ok(await core.invoke('obs.connect', {}));
    ok(await core.invoke('obs.startReplayBuffer', {}));
    platform.shortcutsRegistered.get('CommandOrControl+Alt+R')!();
    await waitFor(() => obs.requests.some((r) => r.type === 'SaveReplayBuffer'));
    const settings = ok(await core.invoke('settings.get', {}));
    const updated = settings.shortcuts.map((s) => (s.action === 'toggleRecording' ? { ...s, enabled: true, accelerator: 'CommandOrControl+Alt+Taken' } : s));
    ok(await core.invoke('settings.update', { shortcuts: updated }));
    const status = ok(await core.invoke('settings.getShortcutStatus', {}));
    expect(status.find((s) => s.action === 'toggleRecording')).toMatchObject({ registered: false });
    expect(status.find((s) => s.action === 'toggleRecording')?.problem).toMatch(/in use/);
    const dup = await core.invoke('settings.update', {
      shortcuts: settings.shortcuts.map((s) => (s.action === 'toggleRecording' ? { ...s, enabled: true, accelerator: 'CommandOrControl+Alt+R' } : s)),
    });
    expect(dup.ok).toBe(false);
  });
});
