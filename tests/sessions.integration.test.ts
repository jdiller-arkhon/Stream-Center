import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionProfileInput } from '../src/services/contract/dto';
import type { DriftCore } from '../src/services/DriftCore';
import { FakeObs } from './helpers/fakeObs';
import { generateClip, makeCore, ok, tempDir, waitFor, type TestPlatform } from './helpers/env';

const posixOnly = process.platform === 'win32' ? it.skip : it;

function fakeGame(dir: string, name: string): string {
  const file = path.join(dir, 'games', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho started > "${file}.marker"\nsleep 30\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function profile(over: Partial<SessionProfileInput> = {}): SessionProfileInput {
  return {
    id: null,
    name: 'Siege Night',
    gameTitle: 'Rainbow Six Siege',
    game: { kind: 'uri', uri: 'steam://rungameid/359550', processName: null },
    artworkPath: null,
    obs: { sceneName: 'Gameplay', startReplayBuffer: true, startRecording: false },
    replayDurationSec: 30,
    recordingDirectory: null,
    audioPreset: { mute: [], unmute: ['Mic/Aux'], volumes: [{ inputName: 'Desktop Audio', volumeDb: -8 }] },
    companionApps: [],
    tags: ['ranked'],
    ...over,
  };
}

describe('profiles and sessions', () => {
  let dir: string;
  let obs: FakeObs;
  let core: DriftCore;
  let platform: TestPlatform;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = tempDir();
    obs = new FakeObs({ onSaveReplay: () => generateClip(path.join(dir, 'obs', `r${Date.now()}.mp4`), 3) });
    const port = await obs.start();
    ({ core, platform } = makeCore(dir));
    ok(await core.invoke('settings.update', { obs: { port, autoConnect: false }, media: { libraryDirectory: path.join(dir, 'lib') } }));
    await core.start();
  });

  afterEach(async () => {
    for (const c of children) c.kill();
    try {
      execFileSync('pkill', ['-f', path.join(dir, 'games')]);
    } catch {
      /* none running */
    }
    await core.dispose();
    await obs.stop();
  });

  it('validates profiles: rejects arbitrary URI schemes and missing executables', async () => {
    const bad = ok(await core.invoke('profiles.validate', { profile: profile({ game: { kind: 'uri', uri: 'file:///C:/Windows/System32/cmd.exe', processName: null } }) }));
    expect(bad.some((i) => i.severity === 'error' && /Unsupported launcher/.test(i.message))).toBe(true);
    const missing = await core.invoke('profiles.save', { profile: profile({ game: { kind: 'executable', path: path.join(dir, 'nope.exe'), args: [], processName: null } }) });
    expect(missing.ok).toBe(false);
    const conflict = ok(await core.invoke('profiles.validate', { profile: profile({ audioPreset: { mute: ['Mic/Aux'], unmute: ['Mic/Aux'], volumes: [] } }) }));
    expect(conflict.some((i) => i.severity === 'error')).toBe(true);
    const saved = ok(await core.invoke('profiles.save', { profile: profile() }));
    const dup = ok(await core.invoke('profiles.duplicate', { id: saved.id }));
    expect(dup.name).toBe('Siege Night copy');
    expect(ok(await core.invoke('profiles.list', {}))).toHaveLength(2);
  });

  it('previews the exact plan and never includes going live', async () => {
    const saved = ok(await core.invoke('profiles.save', { profile: profile({ obs: { sceneName: 'Gameplay', startReplayBuffer: true, startRecording: true } }) }));
    const plan = ok(await core.invoke('sessions.plan', { profileId: saved.id }));
    expect(plan.map((s) => s.kind)).toEqual(['obs.connect', 'obs.scene', 'audio.preset', 'obs.replayBuffer', 'obs.recording', 'game.launch']);
    expect(plan.find((s) => s.kind === 'audio.preset')!.detail).toContain('Desktop Audio to -8 dB');
    expect(plan.find((s) => s.kind === 'game.launch')!.detail).toContain('steam://rungameid/359550');
    expect(JSON.stringify(plan)).not.toMatch(/stream/i);
  });

  it('preflight reports OBS, scene, capture, replay length mismatch, microphone identity and storage', async () => {
    const saved = ok(await core.invoke('profiles.save', { profile: profile({ replayDurationSec: 60 }) }));
    const offline = ok(await core.invoke('sessions.preflight', { profileId: saved.id }));
    expect(offline.find((c) => c.id === 'obs')!.status).toBe('fail');
    ok(await core.invoke('obs.connect', {}));
    const checks = ok(await core.invoke('sessions.preflight', { profileId: saved.id }));
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(by.obs!.status).toBe('pass');
    expect(by.scene!.status).toBe('pass');
    expect(by.capture!.detail).toContain('Game Capture');
    expect(by.replayBuffer!.status).toBe('warn'); // OBS keeps 30 s, profile expects 60 s
    expect(by.microphone!.detail).toContain('Microphone (Shure MV7)');
    expect(['pass', 'warn']).toContain(by.storage!.status);
  });

  it('runs a session: scene, audio, replay buffer, launcher URI; saved replays link to the session; no streaming', async () => {
    const saved = ok(await core.invoke('profiles.save', { profile: profile({ obs: { sceneName: 'BRB', startReplayBuffer: true, startRecording: false } }) }));
    const started = ok(await core.invoke('sessions.start', { profileId: saved.id }));
    expect(started.state).toBe('preparing');
    const second = await core.invoke('sessions.start', { profileId: saved.id });
    expect(second.ok).toBe(false); // only one session at a time
    const active = await waitFor(async () => {
      const s = ok(await core.invoke('sessions.get', { id: started.id }));
      return s.state === 'active' ? s : null;
    });
    expect(active.steps.every((s) => s.status === 'done' || s.status === 'skipped')).toBe(true);
    expect(obs.currentScene).toBe('BRB');
    expect(obs.replay).toBe(true);
    expect(obs.inputs['Desktop Audio']!.volumeDb).toBe(-8);
    expect(platform.externals).toEqual(['steam://rungameid/359550']);
    expect(obs.streaming).toBe(false);

    ok(await core.invoke('obs.saveReplay', {}));
    const withClip = await waitFor(async () => {
      const s = ok(await core.invoke('sessions.get', { id: started.id }));
      return s.clipIds.length === 1 ? s : null;
    });
    const clip = ok(await core.invoke('clips.get', { id: withClip.clipIds[0]! }));
    expect(clip.sessionId).toBe(started.id);
    expect(clip.gameTitle).toBe('Rainbow Six Siege');
    expect(withClip.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['session.preparing', 'step', 'session.started', 'replay.saved', 'clip.added']));

    const ended = ok(await core.invoke('sessions.end', { id: started.id }));
    expect(ended.state).toBe('ended');
    expect(ended.recovery).toContain('replay buffer');
    expect(obs.replay).toBe(true); // ending a session does not silently stop OBS outputs
  });

  posixOnly('launches an executable game once and skips it when already running', async () => {
    const procName = `dg${process.pid % 100000}${Date.now() % 1000}`; // unique: Linux truncates comm to 15 chars
    const game = fakeGame(dir, procName);
    const saved = ok(await core.invoke('profiles.save', { profile: profile({ obs: { sceneName: null, startReplayBuffer: false, startRecording: false }, audioPreset: null, game: { kind: 'executable', path: game, args: [], processName: procName } }) }));
    const s1 = ok(await core.invoke('sessions.start', { profileId: saved.id }));
    const a1 = await waitFor(async () => {
      const s = ok(await core.invoke('sessions.get', { id: s1.id }));
      return s.state !== 'preparing' ? s : null;
    });
    expect(a1.state).toBe('active');
    expect(a1.steps.find((s) => s.kind === 'game.launch')!.message).toMatch(/Started \(pid/);
    await waitFor(() => fs.existsSync(`${game}.marker`));
    ok(await core.invoke('sessions.end', { id: s1.id }));

    const s2 = ok(await core.invoke('sessions.start', { profileId: saved.id }));
    const a2 = await waitFor(async () => {
      const s = ok(await core.invoke('sessions.get', { id: s2.id }));
      return s.state !== 'preparing' ? s : null;
    });
    expect(a2.steps.find((s) => s.kind === 'game.launch')!.message).toMatch(/already running/);
  });

  it('a failed required step stops preparation and explains what was left running', async () => {
    ok(await core.invoke('obs.connect', {}));
    const saved = ok(await core.invoke('profiles.save', { profile: profile({ game: { kind: 'executable', path: process.execPath, args: [], processName: null } }) }));
    // Make the executable disappear after validation by pointing at a deleted copy.
    const tmpExe = path.join(dir, 'gone-game');
    fs.copyFileSync(process.execPath, tmpExe);
    const p2 = ok(await core.invoke('profiles.save', { profile: { ...profile(), id: saved.id, game: { kind: 'executable', path: tmpExe, args: [], processName: null } } }));
    const started = ok(await core.invoke('sessions.start', { profileId: p2.id }));
    fs.rmSync(tmpExe);
    const s = await waitFor(async () => {
      const x = ok(await core.invoke('sessions.get', { id: started.id }));
      return x.state !== 'preparing' ? x : null;
    });
    expect(s.state).toBe('failed');
    expect(s.steps.find((x) => x.kind === 'game.launch')!.status).toBe('failed');
    expect(s.recovery).toMatch(/replay buffer started \(still running\)/);
  });

  it('cancel stops remaining steps without claiming rollback', async () => {
    const saved = ok(await core.invoke('profiles.save', { profile: profile() }));
    const started = ok(await core.invoke('sessions.start', { profileId: saved.id }));
    ok(await core.invoke('sessions.cancel', { id: started.id }));
    const s = await waitFor(async () => {
      const x = ok(await core.invoke('sessions.get', { id: started.id }));
      return x.state !== 'preparing' ? x : null;
    });
    expect(s.state).toBe('cancelled');
    expect(s.steps.some((x) => x.status === 'cancelled')).toBe(true);
    expect(s.recovery).toMatch(/not undone|No actions had completed/);
  });
});
