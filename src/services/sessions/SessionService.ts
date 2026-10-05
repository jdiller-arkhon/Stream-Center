import path from 'node:path';
import type { PreflightCheck, Session, SessionEvent, SessionProfile, SessionStep } from '../contract/dto';
import type { AudioService } from '../audio/AudioService';
import type { Db } from '../core/database';
import { DriftFailure, fail, toDriftError } from '../core/errors';
import type { EventBus } from '../core/events';
import { newId, nowIso } from '../core/ids';
import type { Logger } from '../core/logger';
import { diskStatus } from '../core/paths';
import type { ObsService } from '../obs/ObsService';
import { isProcessRunning, launch, processNameFor, type LaunchHost } from './launcher';
import type { ProfileService } from './ProfileService';

export interface SessionDeps {
  db: Db;
  bus: EventBus;
  log: Logger;
  obs: ObsService;
  audio: AudioService;
  profiles: ProfileService;
  host: LaunchHost;
  platform: NodeJS.Platform;
  /** Connects OBS with stored settings; resolves with whether it is connected. */
  connectObs: () => Promise<boolean>;
  libraryDirectory: () => string | null;
}

const CAPTURE_KINDS = /game_capture|monitor_capture|window_capture|display_capture|screen_capture|xcomposite|pipewire/;
const GB = 1024 ** 3;

export class SessionService {
  private readonly cancelRequested = new Set<string>();

  constructor(private readonly d: SessionDeps) {
    // Sessions left "preparing" by a crash/exit cannot be resumed safely.
    const rows = d.db.prepare("SELECT doc FROM sessions WHERE state = 'preparing'").all() as Array<{ doc: string }>;
    for (const r of rows) {
      const s = JSON.parse(r.doc) as Session;
      s.state = 'failed';
      s.endedAt = nowIso();
      s.recovery = 'Drift Studio closed while this session was being prepared. Check OBS and running apps; some steps may have completed.';
      for (const st of s.steps) if (st.status === 'pending' || st.status === 'running') st.status = 'cancelled';
      this.persist(s);
    }
  }

  // ---- queries ------------------------------------------------------------

  list(limit: number): Session[] {
    return (this.d.db.prepare('SELECT doc FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit) as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as Session);
  }

  get(id: string): Session {
    const row = this.d.db.prepare('SELECT doc FROM sessions WHERE id = ?').get(id) as { doc: string } | undefined;
    if (!row) fail('NOT_FOUND', 'Session not found', { detail: id });
    return JSON.parse(row.doc) as Session;
  }

  getActive(): Session | null {
    const row = this.d.db.prepare("SELECT doc FROM sessions WHERE state IN ('preparing','active') ORDER BY started_at DESC LIMIT 1").get() as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Session) : null;
  }

  isGaming(): boolean {
    return this.getActive() !== null;
  }

  // ---- preflight + plan ---------------------------------------------------

  async preflight(profileId: string): Promise<PreflightCheck[]> {
    const p = this.d.profiles.get(profileId);
    const { obs } = this.d;
    const checks: PreflightCheck[] = [];
    const state = obs.getState();
    const needsObs = p.obs.startRecording || p.obs.startReplayBuffer || p.obs.sceneName !== null;

    checks.push(
      obs.connected
        ? { id: 'obs', label: 'OBS connection', status: 'pass', detail: `Connected to OBS ${state.version?.obs ?? ''} (WebSocket ${state.version?.websocket ?? '?'})` }
        : { id: 'obs', label: 'OBS connection', status: needsObs ? 'fail' : 'warn', detail: state.connection.detail ?? 'Not connected' },
    );

    if (p.obs.sceneName) {
      if (!obs.connected) checks.push({ id: 'scene', label: 'Scene', status: 'unknown', detail: 'Connect to OBS to verify the scene' });
      else if (state.scenes.some((s) => s.name === p.obs.sceneName)) checks.push({ id: 'scene', label: 'Scene', status: 'pass', detail: `"${p.obs.sceneName}" exists` });
      else checks.push({ id: 'scene', label: 'Scene', status: 'fail', detail: `"${p.obs.sceneName}" was not found in OBS` });
    } else {
      checks.push({ id: 'scene', label: 'Scene', status: 'skipped', detail: 'Profile keeps the current OBS scene' });
    }

    checks.push(await this.captureCheck(p.obs.sceneName ?? state.currentScene));

    if (p.obs.startReplayBuffer) {
      if (!obs.connected) checks.push({ id: 'replayBuffer', label: 'Replay buffer', status: 'unknown', detail: 'Connect to OBS to verify' });
      else if (!state.replayBuffer.available) checks.push({ id: 'replayBuffer', label: 'Replay buffer', status: 'fail', detail: state.replayBuffer.unavailableReason ?? 'Unavailable' });
      else {
        const secs = await obs.replayBufferSeconds();
        const mismatch = secs !== null && p.replayDurationSec !== null && secs !== p.replayDurationSec;
        checks.push({
          id: 'replayBuffer',
          label: 'Replay buffer',
          status: mismatch ? 'warn' : 'pass',
          detail: [
            state.replayBuffer.active ? 'Already running' : 'Will be started',
            secs !== null ? `OBS keeps the last ${secs} s` : 'Buffer length not readable from OBS',
            mismatch ? `profile expects ${p.replayDurationSec} s — change it in OBS → Settings → Output` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        });
      }
    } else {
      checks.push({ id: 'replayBuffer', label: 'Replay buffer', status: 'skipped', detail: 'Not started by this profile' });
    }

    if (p.obs.startRecording) {
      checks.push(
        !obs.connected
          ? { id: 'recording', label: 'Recording', status: 'unknown', detail: 'Connect to OBS to verify' }
          : state.recording.active
            ? { id: 'recording', label: 'Recording', status: 'warn', detail: 'OBS is already recording (started outside this session); it will be left running' }
            : { id: 'recording', label: 'Recording', status: 'pass', detail: `Will record to ${state.recording.directory ?? 'the OBS recording folder'}` },
      );
    } else {
      checks.push({ id: 'recording', label: 'Recording', status: 'skipped', detail: 'Not started by this profile' });
    }

    checks.push(await this.micCheck());
    checks.push(await this.storageCheck(state.recording.directory ?? p.recordingDirectory ?? this.d.libraryDirectory()));

    const gameIssue = this.d.profiles.validate(p).find((i) => i.field.startsWith('game') && i.severity === 'error');
    if (p.game.kind === 'none') checks.push({ id: 'game', label: 'Game', status: 'skipped', detail: 'No game configured' });
    else if (gameIssue) checks.push({ id: 'game', label: 'Game', status: 'fail', detail: gameIssue.message });
    else {
      const proc = processNameFor(p.game);
      const running = proc ? await isProcessRunning(proc, this.d.platform) : null;
      checks.push({
        id: 'game',
        label: 'Game',
        status: running ? 'warn' : 'pass',
        detail: running ? `${proc} is already running — it will not be launched again` : proc ? `Ready to launch (${proc})` : 'Ready to launch (duplicate detection unavailable)',
      });
    }

    if (p.companionApps.length) {
      const bad = p.companionApps.filter((c) => this.d.profiles.validate({ ...p, game: { kind: 'executable', path: c.path, args: c.args, processName: null } }).some((i) => i.field.startsWith('game') && i.severity === 'error'));
      checks.push({
        id: 'companions',
        label: 'Companion apps',
        status: bad.length ? 'fail' : 'pass',
        detail: bad.length ? `Not found: ${bad.map((b) => b.name).join(', ')}` : p.companionApps.map((c) => c.name).join(', '),
      });
    }
    return checks;
  }

  private async captureCheck(sceneName: string | null): Promise<PreflightCheck> {
    if (!this.d.obs.connected || !sceneName) return { id: 'capture', label: 'Capture source', status: 'unknown', detail: 'Connect to OBS to inspect capture sources' };
    try {
      const r = (await this.d.obs.req('GetSceneItemList', { sceneName })) as { sceneItems: Array<Record<string, unknown>> };
      const caps = (r.sceneItems ?? []).filter((i) => CAPTURE_KINDS.test(String(i.inputKind ?? '')));
      const enabled = caps.filter((i) => i.sceneItemEnabled !== false);
      if (!caps.length) return { id: 'capture', label: 'Capture source', status: 'warn', detail: `No game/window/display capture in "${sceneName}"` };
      if (!enabled.length) return { id: 'capture', label: 'Capture source', status: 'warn', detail: `Capture sources in "${sceneName}" are hidden` };
      return {
        id: 'capture',
        label: 'Capture source',
        status: 'pass',
        detail: `${enabled.map((i) => i.sourceName).join(', ')} present. Whether it captures the game is confirmed only once the game is running (check the preview).`,
      };
    } catch (err) {
      return { id: 'capture', label: 'Capture source', status: 'unknown', detail: toDriftError(err).message };
    }
  }

  private async micCheck(): Promise<PreflightCheck> {
    if (!this.d.obs.connected) return { id: 'microphone', label: 'Microphone', status: 'unknown', detail: 'Connect to OBS to check the microphone input' };
    try {
      const mic = (await this.d.audio.listObsInputs()).find((s) => s.isMicrophone);
      if (!mic) return { id: 'microphone', label: 'Microphone', status: 'warn', detail: 'No microphone input found in OBS' };
      return {
        id: 'microphone',
        label: 'Microphone',
        status: mic.muted ? 'warn' : 'pass',
        detail: `${mic.name}${mic.deviceName ? ` → ${mic.deviceName}` : ''}${mic.muted ? ' (muted)' : ''}. Confirm the device name; a meter alone does not prove the right microphone.`,
      };
    } catch (err) {
      return { id: 'microphone', label: 'Microphone', status: 'unknown', detail: toDriftError(err).message };
    }
  }

  private async storageCheck(dir: string | null): Promise<PreflightCheck> {
    if (!dir) return { id: 'storage', label: 'Storage', status: 'warn', detail: 'No recording or library folder configured' };
    const disk = await diskStatus(dir);
    if (!disk) return { id: 'storage', label: 'Storage', status: 'unknown', detail: `Could not read free space for ${dir}` };
    const free = disk.freeBytes / GB;
    return {
      id: 'storage',
      label: 'Storage',
      status: free < 5 ? 'fail' : free < 20 ? 'warn' : 'pass',
      detail: `${free.toFixed(1)} GB free on ${path.parse(dir).root || dir}`,
    };
  }

  plan(profileId: string): SessionStep[] {
    return buildPlan(this.d.profiles.get(profileId), this.d.obs.getState().connection.endpoint);
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(profileId: string): Promise<Session> {
    const p = this.d.profiles.get(profileId);
    const active = this.getActive();
    if (active) fail('CONFLICT', `Session "${active.name}" is already ${active.state === 'preparing' ? 'being prepared' : 'running'}. End it first.`);
    const errors = this.d.profiles.validate(p).filter((i) => i.severity === 'error');
    if (errors.length) fail('VALIDATION', `Profile has problems: ${errors.map((e) => e.message).join('; ')}`);
    const session: Session = {
      id: newId('sess'),
      profileId: p.id,
      name: p.name,
      gameTitle: p.gameTitle,
      state: 'preparing',
      startedAt: nowIso(),
      endedAt: null,
      steps: buildPlan(p, this.d.obs.getState().connection.endpoint),
      events: [],
      clipIds: [],
      exportJobIds: [],
      notes: '',
      recovery: null,
    };
    this.d.db.prepare('INSERT INTO sessions(id, doc, state, started_at) VALUES(?,?,?,?)').run(session.id, JSON.stringify(session), session.state, session.startedAt);
    this.addEvent(session, 'session.preparing', `Preparing ${p.name}`);
    void this.runSteps(session.id, p);
    return this.get(session.id);
  }

  cancel(id: string): Session {
    const s = this.get(id);
    if (s.state !== 'preparing') fail('CONFLICT', 'Only a session that is still being prepared can be cancelled');
    this.cancelRequested.add(id);
    return s;
  }

  end(id: string): Session {
    const s = this.get(id);
    if (s.state === 'preparing') fail('CONFLICT', 'Cancel preparation before ending the session');
    if (s.state !== 'active') return s;
    s.state = 'ended';
    s.endedAt = nowIso();
    const st = this.d.obs.getState();
    const running = [st.recording.active && 'recording', st.replayBuffer.active && 'replay buffer', st.streaming.active && 'stream'].filter(Boolean);
    s.recovery = running.length ? `Left running in OBS: ${running.join(', ')}. Stop them from Stream Controls if you are done.` : null;
    this.addEvent(s, 'session.ended', running.length ? `Session ended. Still running: ${running.join(', ')}` : 'Session ended');
    return this.get(id);
  }

  updateNotes(id: string, notes: string): Session {
    const s = this.get(id);
    s.notes = notes;
    this.persist(s);
    this.d.bus.emit('session.updated', s);
    return s;
  }

  /** Records an event on the active session (no-op when none is active). */
  recordActive(kind: SessionEvent['kind'], message: string, refId: string | null = null): void {
    const s = this.getActive();
    if (s) this.addEvent(s, kind, message, refId);
  }

  attachClip(sessionId: string, clipId: string, message: string): void {
    const s = this.get(sessionId);
    if (!s.clipIds.includes(clipId)) s.clipIds.push(clipId);
    this.addEvent(s, 'clip.added', message, clipId);
  }

  attachExport(sessionId: string, jobId: string, message: string): void {
    const s = this.get(sessionId);
    if (!s.exportJobIds.includes(jobId)) s.exportJobIds.push(jobId);
    this.addEvent(s, 'export.completed', message, jobId);
  }

  // ---- step runner --------------------------------------------------------

  private async runSteps(sessionId: string, p: SessionProfile): Promise<void> {
    let obsOk = this.d.obs.connected;
    let failedRequired: SessionStep | null = null;
    const done: string[] = [];
    for (let i = 0; ; i++) {
      const s = this.get(sessionId);
      const step = s.steps[i];
      if (!step) break;
      if (this.cancelRequested.has(sessionId)) {
        for (const rest of s.steps.slice(i)) rest.status = 'cancelled';
        this.persist(s);
        break;
      }
      step.status = 'running';
      step.startedAt = nowIso();
      this.persist(s);
      this.d.bus.emit('session.updated', s);
      try {
        if (step.kind !== 'obs.connect' && step.kind.startsWith('obs.') && !obsOk) {
          step.status = 'skipped';
          step.message = 'Skipped: OBS is not connected';
        } else if (step.kind === 'audio.preset' && !obsOk) {
          step.status = 'skipped';
          step.message = 'Skipped: OBS is not connected';
        } else {
          step.message = await this.execStep(step, p);
          step.status = step.message.startsWith('Skipped') ? 'skipped' : 'done';
          if (step.kind === 'obs.connect') obsOk = this.d.obs.connected;
          if (step.status === 'done') done.push(describeDone(step));
        }
      } catch (err) {
        const e = toDriftError(err);
        step.status = 'failed';
        step.message = e.detail ? `${e.message} (${e.detail})` : e.message;
        if (step.kind === 'obs.connect') obsOk = false;
        if (step.required) failedRequired = step;
      }
      step.finishedAt = nowIso();
      s.steps[i] = step;
      this.persist(s);
      this.addEvent(s, 'step', `${step.label}: ${step.status}${step.message ? ` — ${step.message}` : ''}`, step.id);
      if (failedRequired) {
        for (const rest of s.steps.slice(i + 1)) rest.status = 'cancelled';
        this.persist(s);
        break;
      }
    }
    const s = this.get(sessionId);
    const cancelled = this.cancelRequested.delete(sessionId);
    if (failedRequired || cancelled) {
      s.state = cancelled ? 'cancelled' : 'failed';
      s.endedAt = nowIso();
      s.recovery = done.length
        ? `These actions completed and were not undone: ${done.join('; ')}. Stop or close them manually if you no longer need them.`
        : 'No actions had completed.';
      this.persist(s);
      this.addEvent(s, cancelled ? 'session.cancelled' : 'session.failed', cancelled ? 'Preparation cancelled' : `Preparation failed at "${failedRequired!.label}"`);
    } else {
      s.state = 'active';
      this.persist(s);
      const warnings = s.steps.filter((x) => x.status === 'failed').length;
      this.addEvent(s, 'session.started', warnings ? `Session started with ${warnings} step warning(s)` : 'Session started');
    }
  }

  private async execStep(step: SessionStep, p: SessionProfile): Promise<string> {
    const { obs } = this.d;
    switch (step.kind) {
      case 'obs.connect': {
        if (obs.connected) return 'Already connected';
        const ok = await this.d.connectObs();
        if (!ok) throw new DriftFailure('OBS_NOT_CONNECTED', obs.getState().connection.detail ?? 'Could not connect to OBS');
        return 'Connected';
      }
      case 'obs.scene':
        if (obs.getState().currentScene === p.obs.sceneName) return 'Skipped: scene already active';
        await obs.setScene(p.obs.sceneName!);
        return `Switched to "${p.obs.sceneName}"`;
      case 'audio.preset': {
        const preset = p.audioPreset!;
        const results: string[] = [];
        const sources = await this.d.audio.listObsInputs();
        const idFor = (name: string) => sources.find((x) => x.name === name)?.id ?? null;
        const missing: string[] = [];
        for (const n of preset.mute) idFor(n) ? (await this.d.audio.setMute(idFor(n)!, true), results.push(`muted ${n}`)) : missing.push(n);
        for (const n of preset.unmute) idFor(n) ? (await this.d.audio.setMute(idFor(n)!, false), results.push(`unmuted ${n}`)) : missing.push(n);
        for (const v of preset.volumes) idFor(v.inputName) ? (await this.d.audio.setVolume(idFor(v.inputName)!, v.volumeDb), results.push(`${v.inputName} ${v.volumeDb} dB`)) : missing.push(v.inputName);
        if (missing.length) throw new DriftFailure('NOT_FOUND', `OBS inputs not found: ${[...new Set(missing)].join(', ')}`, { detail: results.length ? `Applied: ${results.join(', ')}` : null });
        return results.join(', ') || 'Nothing to change';
      }
      case 'obs.replayBuffer':
        if (obs.getState().replayBuffer.active) return 'Skipped: replay buffer already running';
        await obs.startReplayBuffer();
        return 'Replay buffer running';
      case 'obs.recording':
        if (obs.getState().recording.active) return 'Skipped: OBS is already recording';
        await obs.startRecording();
        return 'Recording started';
      case 'companion.launch': {
        const app = p.companionApps.find((c) => c.id === step.id.replace(/^step_companion_/, ''))!;
        const proc = app.processName ?? path.basename(app.path);
        if (await isProcessRunning(proc, this.d.platform)) return `Skipped: ${app.name} is already running`;
        return await launch({ kind: 'executable', path: app.path, args: app.args }, this.d.host, this.d.platform);
      }
      case 'game.launch': {
        if (p.game.kind === 'none') return 'Skipped: no game configured';
        const proc = processNameFor(p.game);
        if (proc && (await isProcessRunning(proc, this.d.platform))) return `Skipped: ${proc} is already running`;
        return await launch(p.game.kind === 'uri' ? { kind: 'uri', uri: p.game.uri } : { kind: 'executable', path: p.game.path, args: p.game.args }, this.d.host, this.d.platform);
      }
    }
  }

  // ---- storage ------------------------------------------------------------

  private addEvent(s: Session, kind: SessionEvent['kind'], message: string, refId: string | null = null): void {
    s.events.push({ id: newId('evt'), at: nowIso(), kind, message, refId });
    if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
    this.persist(s);
    this.d.bus.emit('session.updated', s);
  }

  private persist(s: Session): void {
    this.d.db.prepare('UPDATE sessions SET doc=?, state=? WHERE id=?').run(JSON.stringify(s), s.state, s.id);
  }
}

function describeDone(step: SessionStep): string {
  switch (step.kind) {
    case 'obs.replayBuffer':
      return 'OBS replay buffer started (still running)';
    case 'obs.recording':
      return 'OBS recording started (still recording)';
    case 'obs.scene':
      return step.label;
    case 'audio.preset':
      return `audio preset applied (${step.message})`;
    case 'companion.launch':
    case 'game.launch':
      return `${step.label} (app left open)`;
    default:
      return step.label;
  }
}

/** The exact actions a profile will perform, in order. Never includes streaming. */
export function buildPlan(p: SessionProfile, endpoint: string | null): SessionStep[] {
  const steps: SessionStep[] = [];
  const add = (id: string, kind: SessionStep['kind'], label: string, detail: string, required: boolean) =>
    steps.push({ id, kind, label, detail, required, status: 'pending', message: null, startedAt: null, finishedAt: null });
  const usesObs = p.obs.sceneName !== null || p.obs.startReplayBuffer || p.obs.startRecording || p.audioPreset !== null;
  if (usesObs) add('step_obs_connect', 'obs.connect', 'Connect to OBS', `Connect to OBS WebSocket${endpoint ? ` at ${endpoint}` : ''} (skipped if already connected)`, false);
  if (p.obs.sceneName) add('step_obs_scene', 'obs.scene', `Switch to scene "${p.obs.sceneName}"`, `Set the OBS program scene to "${p.obs.sceneName}"`, false);
  if (p.audioPreset) {
    const a = p.audioPreset;
    const parts = [
      a.mute.length ? `mute ${a.mute.join(', ')}` : null,
      a.unmute.length ? `unmute ${a.unmute.join(', ')}` : null,
      ...a.volumes.map((v) => `set ${v.inputName} to ${v.volumeDb} dB`),
    ].filter(Boolean);
    add('step_audio', 'audio.preset', 'Apply audio preset', `OBS inputs: ${parts.join('; ') || 'no changes'}`, false);
  }
  if (p.obs.startReplayBuffer) add('step_replay', 'obs.replayBuffer', 'Start replay buffer', 'Start the OBS replay buffer so highlights can be saved', false);
  if (p.obs.startRecording) add('step_record', 'obs.recording', 'Start recording', 'Start OBS recording (does not go live)', false);
  for (const c of p.companionApps) add(`step_companion_${c.id}`, 'companion.launch', `Launch ${c.name}`, `Start ${c.path}${c.args.length ? ' ' + c.args.join(' ') : ''} unless already running`, false);
  if (p.game.kind !== 'none') {
    const detail = p.game.kind === 'uri' ? `Open ${p.game.uri}` : `Start ${p.game.path}${p.game.args.length ? ' ' + p.game.args.join(' ') : ''}`;
    add('step_game', 'game.launch', `Launch ${p.gameTitle || 'game'}`, `${detail} unless it is already running`, true);
  }
  return steps;
}
