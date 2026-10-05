/**
 * StudioBridge: serves the renderer's protocol v1 (src/shared/contracts.ts — StudioSnapshot +
 * OperationMap, owned by the frontend) from the desktop services (DriftCore).
 *
 * - Builds complete, honest snapshots from real service state and pushes them on change.
 * - Maps each renderer operation onto a service call, re-validating input in main.
 * - Converts the renderer's edit model into the service EditProject for FFmpeg export.
 * - Request IDs make operations idempotent across retries.
 *
 * No Electron imports: runs under plain Node in tests; main.ts wires it to IPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  Capabilities as UiCapabilities,
  ClipAsset as UiClip,
  ConnectionStatus as UiConnection,
  EditProject as UiProject,
  ExportPreset as UiExportPreset,
  Job as UiJob,
  Moment as UiMoment,
  Operation,
  OperationMap,
  Session as UiSession,
  SessionProfile as UiProfile,
  StructuredError,
  StudioSettings as UiSettings,
  StudioSnapshot,
  ThumbAiEngine,
  ThumbAiStatus,
  YouTubeKit as UiYouTubeKit,
} from '../../shared/contracts';
import { validateProfile, validateProject, validateRequest } from '../../shared/validation';
import type { DriftCore } from '../DriftCore';
import type { AudioSource, DriftError, EditProject, ExportSettings, Job, Session, SessionProfileInput } from '../contract/dto';
import { DEFAULT_CAPTION_STYLE } from '../contract/defaults';
import { kvGet, kvSet } from '../core/database';
import { DriftFailure, fail, toDriftError } from '../core/errors';
import { newId } from '../core/ids';
import { run } from '../core/proc';
import { diskStatus, isFile, safeAbsolutePath, sanitizeFileStem } from '../core/paths';
import { toAsset, type ClipRecord } from '../library/ClipLibrary';
import { isProcessRunning, launch, processNameFor } from '../sessions/launcher';
import { type ImageEngine, isJpeg, isPng, SdCppEngine, validateLocalServer, WebUiEngine } from '../media/imageGen';
import { buildChapters, buildMetadata, findMoments, isShort, jpegSize, YOUTUBE_LOUDNESS_LUFS, youtubeChecks } from '../media/youtube';

const KV_PROFILES = 'ui.profiles';
const KV_SELECTED = 'ui.selectedProfileId';
const KV_VOICE = 'ui.voiceClip';
/** Profiles were removed at the user's request: there is exactly one game setup, stored under this id. */
const SETUP_ID = 'setup';
const KV_PROJECTS = 'ui.projects';
const KV_APPEARANCE = 'ui.appearance';
const KV_MUSIC = 'ui.music';
const KV_THUMB_AI = 'ui.thumbAi';
const DEFAULT_WEBUI = 'http://127.0.0.1:7860';
const UNCONFIGURED = 'unconfigured';
const MIC_ID = 'microphone';
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const MEDIA_EXT = /\.(mp4|mkv|mov|webm|flv|ts|m4v|avi)$/i;
/** Placeholder text the renderer's setup form uses before a game is named. */
const GAME_PLACEHOLDER = 'Choose a game';
const NAME_PLACEHOLDER = 'Set up your first profile';
/** The only web page the app opens: uploads stay a manual, signed-in step in YouTube Studio. */
export const YOUTUBE_STUDIO_URL = 'https://studio.youtube.com/';
const THUMB_MAX_BYTES = 2 * 1024 * 1024; // YouTube's custom thumbnail limit

export class BridgeError extends Error {
  constructor(readonly error: StructuredError) {
    super(error.message);
  }
}

/** Maps service error codes onto the renderer protocol's smaller set. */
export function toStructured(e: DriftError): StructuredError {
  const code: StructuredError['code'] = (
    {
      VALIDATION: 'INVALID_INPUT',
      NOT_FOUND: 'NOT_FOUND',
      OBS_NOT_CONNECTED: 'DISCONNECTED',
      OBS_AUTH_FAILED: 'DISCONNECTED',
      BUSY: 'BUSY',
      CONFLICT: 'BUSY',
      ALREADY_RUNNING: 'BUSY',
      CANCELLED: 'CANCELED',
      UNSUPPORTED: 'UNAVAILABLE',
      REPLAY_BUFFER_UNAVAILABLE: 'UNAVAILABLE',
      FFMPEG_MISSING: 'UNAVAILABLE',
    } as Partial<Record<DriftError['code'], StructuredError['code']>>
  )[e.code] ?? 'IO_ERROR';
  return { code, message: e.message, recoverable: e.retryable || code === 'INVALID_INPUT' || code === 'DISCONNECTED' || code === 'UNAVAILABLE', details: e.detail };
}

const formatClock = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const dbToGain = (db: number | null) => (db === null ? 1 : Math.max(0, Math.min(1, 10 ** (db / 20))));
const gainToDb = (gain: number) => (gain <= 0.00001 ? -100 : Math.max(-100, Math.min(26, Math.round(20 * Math.log10(gain) * 10) / 10)));

export interface BridgeOptions {
  /** Called with every new snapshot (already throttled). */
  publish: (snapshot: StudioSnapshot) => void;
  throttleMs?: number;
  /** Location of the offline speech model (null when it is not installed). */
  voiceModelPath?: () => string | null;
  /** Called when the voice listener should start (true) or stop (false). */
  onVoiceWanted?: (wanted: boolean) => void;
  /** Opens YOUTUBE_STUDIO_URL in the default browser (absent in tests without a browser). */
  openYouTubeStudio?: () => Promise<void>;
}

export class StudioBridge {
  private latest: StudioSnapshot | null = null;
  private revision = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private building: Promise<void> | null = null;
  private dirtyWhileBuilding = false;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly requests = new Map<string, { at: number; promise: Promise<unknown> }>();
  private audio: AudioSource[] = [];
  private levels = new Map<string, number>();
  private sources: string[] = [];
  private sourcesScene: string | null = null;
  private disk: { freeBytes: number } | null = null;
  private streamLabel: string | null = null;
  private disposed = false;
  private voice: NonNullable<StudioSnapshot['voice']> = { state: 'off', detail: null, device: null, lastHeardAt: null, lastCommand: null };
  private lastVoiceClip = 0;

  constructor(
    private readonly core: DriftCore,
    private readonly opts: BridgeOptions,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.unsubscribers.push(
      this.core.bus.onAny((event, payload) => {
        if (event === 'audio.meters') {
          for (const l of (payload as { levels: Array<{ sourceId: string; peakDb: number[] }> }).levels) {
            this.levels.set(l.sourceId, Math.max(0, Math.min(1, 10 ** (Math.max(...l.peakDb, -100) / 20))));
          }
        }
        if (event === 'audio.changed') this.audio = payload as AudioSource[];
        if (event === 'connection.changed') void this.refreshAudio();
        this.schedule();
      }),
    );
    this.ticker = setInterval(() => {
      void this.refreshDisk();
      void this.refreshAudio();
      this.schedule();
    }, 5000);
    await Promise.all([this.refreshDisk(), this.refreshAudio()]);
    await this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    this.generation?.abort(); // never leave an image engine running after the app closes
    for (const u of this.unsubscribers) u();
    if (this.timer) clearTimeout(this.timer);
    if (this.ticker) clearInterval(this.ticker);
  }

  /** A freshly built snapshot reflecting everything that has happened so far. */
  async readState(): Promise<StudioSnapshot> {
    await this.refresh();
    return this.latest!;
  }

  /** Waits for any in-flight build, then builds again so the result is guaranteed current. */
  private async refresh(): Promise<void> {
    if (this.building) await this.building;
    await this.rebuild();
  }

  /** Enable OBS peak meters only while someone is looking (window focused/visible). */
  async setMetersWanted(wanted: boolean): Promise<void> {
    await this.core.obs.setMeters(wanted).catch(() => {});
    if (!wanted) this.levels.clear();
  }

  private schedule(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.rebuild();
    }, this.opts.throttleMs ?? 120);
  }

  private async rebuild(): Promise<void> {
    if (this.building) {
      this.dirtyWhileBuilding = true;
      return this.building;
    }
    this.building = (async () => {
      try {
        const snap = await this.buildSnapshot();
        this.latest = snap;
        if (!this.disposed) this.opts.publish(snap);
      } catch (err) {
        this.core.log.error('snapshot build failed', { error: toDriftError(err) });
      } finally {
        this.building = null;
        if (this.dirtyWhileBuilding) {
          this.dirtyWhileBuilding = false;
          this.schedule();
        }
      }
    })();
    return this.building;
  }

  private async refreshAudio(): Promise<void> {
    try {
      this.audio = await this.core.audio.list();
    } catch {
      this.audio = [];
    }
    await this.refreshSources();
  }

  private async refreshSources(): Promise<void> {
    const st = this.core.obs.getState();
    if (!this.core.obs.connected || !st.currentScene) {
      this.sources = [];
      this.sourcesScene = null;
      return;
    }
    try {
      const r = (await this.core.obs.req('GetSceneItemList', { sceneName: st.currentScene })) as { sceneItems: Array<{ sourceName: string }> };
      this.sources = (r.sceneItems ?? []).map((i) => String(i.sourceName));
      this.sourcesScene = st.currentScene;
    } catch {
      this.sources = [];
    }
  }

  private async refreshDisk(): Promise<void> {
    const s = this.core.settings.get();
    const dir = this.core.obs.getState().recording.directory ?? s.media.libraryDirectory;
    const d = dir ? await diskStatus(dir) : null;
    this.disk = d ? { freeBytes: d.freeBytes } : null;
  }

  // ---------------------------------------------------------------- snapshot

  private async buildSnapshot(): Promise<StudioSnapshot> {
    const core = this.core;
    const caps = await core.capabilities();
    const st = core.obs.getState();
    if (st.currentScene !== this.sourcesScene && core.obs.connected) await this.refreshSources();
    const settings = core.settings.get();
    const profiles = this.uiProfiles();
    const active = core.sessions.getActive();
    const recs = (core.db.prepare('SELECT doc FROM clips ORDER BY imported_at DESC LIMIT 1000').all() as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as ClipRecord);
    const connection: UiConnection = st.connection.state === 'reconnecting' ? 'connecting' : st.connection.state;

    const snapshot: StudioSnapshot & { revision: number } = {
      apiVersion: 1,
      mode: 'desktop',
      revision: ++this.revision,
      capabilities: this.mapCapabilities(caps),
      obs: {
        connection,
        scene: st.currentScene ?? '',
        scenes: st.scenes.map((s) => s.name),
        sources: core.obs.connected ? this.sources : [],
        recording: st.recording.active,
        replayBuffer: st.replayBuffer.active,
        streaming: st.streaming.active,
        streamDestination: st.streaming.active ? this.streamLabel : null,
        outputFps: st.stats?.activeFps ?? null,
        encoderSkippedFrames: st.stats?.outputSkippedFrames ?? null,
        previewUrl: core.obs.connected && st.currentScene ? `drift-media://preview/program?t=${Math.floor(Date.now() / 2000)}` : null,
      },
      audio: this.mapAudio(),
      profiles,
      selectedProfileId: profiles[0]?.id ?? UNCONFIGURED,
      sessions: core.sessions.list(50).map((s) => this.mapSession(s)),
      activeSessionId: active?.id ?? null,
      clips: recs.map((r) => this.mapClip(r)),
      projects: this.uiProjects(),
      jobs: core.jobs
        .list(100)
        .filter((j) => j.kind === 'export')
        .map((j) => this.mapJob(j)),
      settings: {
        mediaFolder: settings.media.libraryDirectory ?? '',
        obsHost: settings.obs.host,
        obsPort: settings.obs.port,
        appearance: kvGet<UiSettings['appearance']>(core.db, KV_APPEARANCE) ?? 'studio',
        transcription: settings.transcription.enabled,
        workerLimit: settings.performance.maxConcurrentJobs >= 2 ? 2 : 1,
        shortcuts: settings.shortcuts.some((s) => s.scope === 'global' && s.enabled),
        voiceClip: kvGet<boolean>(core.db, KV_VOICE) ?? false,
      },
      telemetry: { gameFps: null, diskFreeBytes: this.disk?.freeBytes ?? null },
      voice: { ...this.voice },
      warnings: [
        ...(this.voice.state === 'error' ? [`Voice command unavailable: ${this.voice.detail ?? 'unknown error'}`] : []),
        ...(st.streaming.active ? [`You are live${this.streamLabel ? ` · ${this.streamLabel}` : ''}: streaming through the service configured in OBS.`] : []),
        ...this.warnings(caps, st.connection.state === 'failed' ? st.connection.detail : null),
      ],
    };
    return snapshot;
  }

  private mapCapabilities(c: Awaited<ReturnType<DriftCore['capabilities']>>): UiCapabilities {
    const cap = (x: { available: boolean; reason: string | null }) => ({ available: x.available, reason: x.available ? null : x.reason });
    return {
      obs: { available: true, reason: null },
      recording: cap(c.obs.recording),
      replay: cap(c.obs.replayBuffer),
      preview: cap(c.obs.preview),
      launch: cap(c.launcher.executables),
      obsAudio: cap(c.audio.obsInputs),
      windowsAudio: { available: false, reason: c.audio.windowsDeviceControl.reason },
      import: cap(c.media.ffprobe),
      export: cap(c.media.ffmpeg),
      transcription: cap(c.transcription),
      telemetry: { available: true, reason: null },
      streaming: cap(c.obs.streaming),
      voice: this.opts.voiceModelPath?.()
        ? { available: true, reason: null }
        : { available: false, reason: 'The offline speech model is not installed. Run npm run fetch:voice-model (bundled automatically in the installer).' },
    };
  }

  private mapAudio(): StudioSnapshot['audio'] {
    const micIndex = this.audio.findIndex((a) => a.origin === 'obs-input' && a.isMicrophone);
    return this.audio.map((a, i) => ({
      id: i === micIndex ? MIC_ID : a.id,
      name: a.name,
      scope: a.origin === 'obs-input' ? ('obs' as const) : ('windows' as const),
      deviceName: a.deviceName ?? (a.origin === 'obs-input' ? `OBS input · ${a.kind}` : a.name),
      gain: a.origin === 'obs-input' ? dbToGain(a.volumeDb) : 0,
      muted: a.muted ?? false,
      level: this.levels.get(a.id) ?? null,
    }));
  }

  private realAudioId(id: string): string {
    if (id !== MIC_ID) return id;
    const mic = this.audio.find((a) => a.origin === 'obs-input' && a.isMicrophone);
    return mic?.id ?? fail('NOT_FOUND', 'No microphone input was found in OBS');
  }

  private mapSession(s: Session): UiSession {
    return {
      id: s.id,
      profileId: s.profileId ?? UNCONFIGURED,
      name: s.name,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      notes: s.notes,
      events: s.events.map((e) => ({ id: e.id, at: e.at, message: e.message })),
      clipIds: s.clipIds,
    };
  }

  private mapClip(r: ClipRecord): UiClip {
    const a = toAsset(r);
    const status: UiClip['status'] =
      r.status === 'missing' ? 'missing' : r.status === 'error' || r.playback === 'unplayable' ? 'failed' : r.playback === 'proxy-pending' ? 'processing' : 'ready';
    return {
      id: r.id,
      name: r.fileName,
      game: r.gameTitle ?? '',
      sessionId: r.sessionId,
      createdAt: r.fileCreatedAt,
      durationMs: Math.max(1, r.durationMs),
      tags: r.tags,
      favorite: r.favorite,
      status,
      mediaHandle: status === 'ready' ? a.playbackUrl : null,
      thumbnailUrl: a.thumbnailUrl,
      fixture: false,
    };
  }

  private mapJob(j: Job): UiJob {
    const status: UiJob['status'] =
      j.state === 'queued' ? 'accepted' : j.state === 'running' || j.state === 'validating' ? 'processing' : j.state === 'succeeded' ? 'completed' : j.state === 'failed' ? 'failed' : 'canceled';
    return {
      id: j.id,
      projectId: j.refId ?? '',
      name: j.label,
      status,
      progress: Math.round((j.progress ?? (status === 'completed' ? 1 : 0)) * 100),
      error: j.error ? toStructured(j.error) : null,
      outputHandle: j.state === 'succeeded' && j.outputPath ? j.id : null,
      simulated: false,
    };
  }

  private warnings(caps: Awaited<ReturnType<DriftCore['capabilities']>>, obsFailure: string | null): string[] {
    const w: string[] = [];
    if (!caps.media.ffmpeg.available && caps.media.ffmpeg.reason) w.push(caps.media.ffmpeg.reason);
    if (obsFailure) w.push(obsFailure);
    for (const s of this.core.shortcuts.status()) if (s.problem && s.accelerator) w.push(`Shortcut ${s.accelerator}: ${s.problem}`);
    const recent = Date.now() - 10 * 60_000;
    const last = this.core.sessions.list(1)[0];
    if (last && (last.state === 'failed' || last.state === 'cancelled') && last.recovery && Date.parse(last.endedAt ?? last.startedAt) > recent) w.push(last.recovery);
    for (const n of this.core.recentNotices()) {
      if ((n.level === 'error' || n.level === 'warning') && Date.parse(n.at) > Date.now() - 2 * 60_000) w.push(`${n.title}: ${n.message}`);
      if (w.length >= 6) break;
    }
    return [...new Set(w)];
  }

  // ---------------------------------------------------------------- stores

  /** The single game setup (older multi-profile data: the selected profile becomes the setup). */
  private uiProfiles(): UiProfile[] {
    const all = kvGet<Record<string, UiProfile>>(this.core.db, KV_PROFILES) ?? {};
    const setup = all[SETUP_ID] ?? all[kvGet<string>(this.core.db, KV_SELECTED) ?? ''] ?? Object.values(all)[0];
    return setup ? [{ ...setup, id: SETUP_ID }] : [];
  }

  private uiProjects(): UiProject[] {
    return Object.values(kvGet<Record<string, UiProject>>(this.core.db, KV_PROJECTS) ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ---------------------------------------------------------------- voice ("Clip that")

  /** True when the user enabled the voice command and the offline model is installed. */
  voiceWanted(): boolean {
    return (kvGet<boolean>(this.core.db, KV_VOICE) ?? false) && !!this.opts.voiceModelPath?.();
  }

  setVoiceStatus(s: { state: 'off' | 'loading' | 'listening' | 'error'; detail: string | null; device: string | null }): void {
    this.voice = { ...this.voice, ...s };
    this.schedule();
  }

  /**
   * The voice host heard a phrase. "Clip that" saves a replay exactly like the Save Replay
   * button; "Mark that" drops a timestamped marker in the session for editing later.
   */
  async voiceHeard(text: string, confidence: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastVoiceClip < 4000) return; // one action per utterance
    this.lastVoiceClip = now;
    this.voice = { ...this.voice, lastHeardAt: new Date(now).toISOString(), lastCommand: text.startsWith('mark') ? 'mark' : 'clip' };
    const st = this.core.obs.getState();
    if (text.startsWith('mark')) {
      const session = this.core.sessions.getActive();
      if (!session) {
        this.core.notice('warning', 'Heard “Mark that”', 'Start a session first. Markers are saved to the active session.');
      } else {
        const rec = st.recording.active && st.recording.durationMs !== null ? st.recording.durationMs : null;
        const at = rec ?? now - Date.parse(session.startedAt);
        const where = `${rec !== null ? 'into the recording' : 'into the session'}`;
        const stamp = formatClock(at);
        this.core.sessions.recordActive('note', `Marker · ${stamp} ${where} (voice)`);
        this.core.notice('success', 'Marked', `${stamp} ${where}`);
      }
      this.schedule();
      return;
    }
    if (!this.core.obs.connected || !st.replayBuffer.active) {
      this.core.notice('warning', 'Heard “Clip that”', 'The OBS replay buffer is not running, so nothing was saved.');
      this.schedule();
      return;
    }
    this.core.sessions.recordActive('note', `Voice: “${text}” (confidence ${Math.round(confidence * 100)}%)`);
    try {
      const clip = (await this.request('saveReplay', undefined, `voice-${now}`)) as UiClip;
      this.core.notice('success', 'Clipped by voice', clip.name, clip.id);
    } catch (err) {
      const e = err instanceof BridgeError ? err.error.message : String(err);
      this.core.notice('error', 'Voice clip failed', e);
    }
    this.schedule();
  }

  /** Resolves drift-media://music/<token> to the file the user picked (authorized handles only). */
  resolveMusic(token: string): string | null {
    const p = (kvGet<Record<string, string>>(this.core.db, KV_MUSIC) ?? {})[token];
    return p && isFile(p) ? p : null;
  }

  // ---------------------------------------------------------------- requests

  /** Entry point for renderer requests. Same requestId → same result (idempotent retries). */
  request(operation: string, input: unknown, requestId: string): Promise<unknown> {
    const now = Date.now();
    for (const [k, v] of this.requests) if (now - v.at > 120_000) this.requests.delete(k);
    const key = typeof requestId === 'string' && requestId.length <= 128 ? requestId : null;
    const cached = key ? this.requests.get(key) : undefined;
    if (cached) return cached.promise;
    // The snapshot is rebuilt and pushed before the reply, so the UI never shows a stale state after an action.
    const promise = this.handle(operation, input).then(
      async (r) => {
        await this.refresh();
        return r;
      },
      async (err) => {
        await this.refresh();
        throw err instanceof BridgeError ? err : new BridgeError(toStructured(toDriftError(err)));
      },
    );
    if (key) {
      this.requests.set(key, { at: now, promise });
      if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value!);
    }
    return promise;
  }

  private async handle(operation: string, input: unknown): Promise<unknown> {
    const ops: readonly string[] = [
      'connect', 'disconnect', 'selectProfile', 'saveProfile', 'prepareSession', 'startSession', 'endSession', 'launchGame',
      'recording', 'replay', 'saveReplay', 'scene', 'streaming', 'audio', 'importClips', 'updateClip', 'saveProject', 'export',
      'cancelJob', 'retryJob', 'openOutput', 'saveSettings', 'sessionNotes', 'importNative', 'relinkNative', 'pickMusic', 'setObsPassword', 'suggestMoments', 'youtubeKit', 'saveThumbnail', 'revealOutput', 'openYouTubeStudio', 'thumbAiStatus', 'thumbAiConfigure', 'thumbAiPick', 'generateThumbnail', 'cancelThumbnail',
    ];
    if (operation === 'scenario' || operation === 'reset') throw new BridgeError({ code: 'UNAVAILABLE', message: 'Demo scenarios are disabled in desktop mode', recoverable: false, details: null });
    if (!ops.includes(operation)) throw new BridgeError({ code: 'INVALID_INPUT', message: 'Operation not allowlisted', recoverable: false, details: null });
    const op = operation as Operation;
    // Same structural validation as the renderer, repeated here because main is the boundary.
    try {
      validateRequest(op, input);
    } catch (err) {
      const e = (err as { error?: StructuredError }).error;
      throw new BridgeError(e ?? { code: 'INVALID_INPUT', message: String(err), recoverable: true, details: null });
    }
    const core = this.core;
    const ok = <T>(r: { ok: true; data: T } | { ok: false; error: DriftError }): T => {
      if (!r.ok) throw new DriftFailure(r.error.code, r.error.message, { detail: r.error.detail, retryable: r.error.retryable });
      return r.data;
    };
    const p = input as never;
    switch (op) {
      case 'connect': {
        const { host, port } = p as OperationMap['connect']['input'];
        ok(await core.invoke('settings.update', { obs: { host: host.trim(), port } }));
        const st = ok(await core.invoke('obs.connect', {}));
        if (st.state === 'failed') fail(st.error?.code ?? 'OBS_NOT_CONNECTED', st.detail ?? 'Could not connect to OBS', { retryable: true });
        return undefined;
      }
      case 'disconnect':
        ok(await core.invoke('obs.disconnect', {}));
        return undefined;
      case 'setObsPassword': {
        const { password } = p as OperationMap['setObsPassword']['input'];
        ok(await core.invoke('settings.setObsPassword', { password }));
        return undefined;
      }
      case 'selectProfile':
        // Single setup: nothing to switch. Never touches OBS outputs (a live stream keeps running).
        this.requireProfile((p as OperationMap['selectProfile']['input']).id);
        return undefined;
      case 'saveProfile': {
        const profile = { ...this.normalizeProfile(validateProfile(p)), id: SETUP_ID };
        core.profiles.save(this.toCoreProfile(profile));
        kvSet(core.db, KV_PROFILES, { [SETUP_ID]: profile });
        kvSet(core.db, KV_SELECTED, SETUP_ID);
        this.applyProfileHotkey();
        return undefined;
      }
      case 'prepareSession': {
        this.requireProfile((p as OperationMap['prepareSession']['input']).profileId);
        const checks = ok(await core.invoke('sessions.preflight', { profileId: SETUP_ID }));
        return { steps: checks.map((c) => ({ label: c.label, ok: c.status === 'pass' || c.status === 'skipped' || c.status === 'warn', detail: c.detail })) };
      }
      case 'startSession': {
        this.requireProfile((p as OperationMap['startSession']['input']).profileId);
        return this.mapSession(ok(await core.invoke('sessions.start', { profileId: SETUP_ID })));
      }
      case 'endSession': {
        const active = core.sessions.getActive() ?? fail('NOT_FOUND', 'No session is active');
        if (active.state === 'preparing') ok(await core.invoke('sessions.cancel', { id: active.id }));
        else ok(await core.invoke('sessions.end', { id: active.id }));
        return undefined;
      }
      case 'launchGame': {
        const { profileId } = p as OperationMap['launchGame']['input'];
        const prof = core.profiles.get(this.requireProfile(profileId).id);
        if (prof.game.kind === 'none') fail('VALIDATION', 'No game is configured for this profile');
        const proc = processNameFor(prof.game);
        if (proc && (await isProcessRunning(proc, core.platform.os))) fail('ALREADY_RUNNING', `${proc} is already running`);
        const host = { openExternal: (u: string) => core.platform.openExternal(u), openPath: (f: string) => core.platform.openPath(f) };
        await launch(prof.game.kind === 'uri' ? { kind: 'uri', uri: prof.game.uri } : { kind: 'executable', path: prof.game.path, args: prof.game.args }, host, core.platform.os);
        core.sessions.recordActive('note', `Launched ${prof.gameTitle || 'game'}`);
        return undefined;
      }
      case 'recording': {
        const { enabled } = p as OperationMap['recording']['input'];
        ok(await core.invoke(enabled ? 'obs.startRecording' : 'obs.stopRecording', {}));
        return undefined;
      }
      case 'replay': {
        const { enabled } = p as OperationMap['replay']['input'];
        ok(await core.invoke(enabled ? 'obs.startReplayBuffer' : 'obs.stopReplayBuffer', {}));
        return undefined;
      }
      case 'saveReplay':
        return this.saveReplay();
      case 'scene': {
        const { name } = p as OperationMap['scene']['input'];
        ok(await core.invoke('obs.setScene', { sceneName: name }));
        await this.refreshSources();
        return undefined;
      }
      case 'streaming': {
        const { enabled, destination } = p as OperationMap['streaming']['input'];
        if (enabled) {
          ok(await core.invoke('obs.startStream', { confirm: true }));
          this.streamLabel = destination.trim() || null;
        } else {
          ok(await core.invoke('obs.stopStream', { confirm: true }));
          this.streamLabel = null;
        }
        return undefined;
      }
      case 'audio': {
        const { id, gain, muted } = p as OperationMap['audio']['input'];
        const realId = this.realAudioId(id);
        const current = this.audio.find((a) => a.id === realId) ?? fail('NOT_FOUND', 'Audio source not found');
        if (current.origin !== 'obs-input') fail('UNSUPPORTED', 'Windows device volume and mute are not controlled by Drift Studio');
        if (Math.abs(dbToGain(current.volumeDb) - gain) > 0.004) ok(await core.invoke('audio.setVolume', { sourceId: realId, volumeDb: gainToDb(gain) }));
        if (current.muted !== muted) ok(await core.invoke('audio.setMute', { sourceId: realId, muted }));
        await this.refreshAudio();
        return undefined;
      }
      case 'importClips':
        fail('VALIDATION', 'In the desktop app, use Import media: files are indexed from disk, not from browser handles.');
        return undefined;
      case 'importNative':
        return this.importNative();
      case 'relinkNative': {
        const { id } = p as OperationMap['relinkNative']['input'];
        const [file] = await core.platform.pickPath({ kind: 'file', purpose: 'import', title: 'Locate the original recording' });
        if (!file) return null;
        ok(await core.invoke('clips.relink', { id, path: file }));
        return this.mapClip(core.library.getRecord(id));
      }
      case 'pickMusic': {
        const [file] = await core.platform.pickPath({ kind: 'file', purpose: 'music', title: 'Choose music you own or have licensed' });
        if (!file) return null;
        const token = newId('mus');
        const all = kvGet<Record<string, string>>(core.db, KV_MUSIC) ?? {};
        all[token] = safeAbsolutePath(file);
        kvSet(core.db, KV_MUSIC, all);
        return { handle: `drift-media://music/${token}`, name: path.basename(file) };
      }
      case 'updateClip': {
        const c = p as UiClip;
        core.library.getRecord(c.id);
        ok(await core.invoke('clips.update', { id: c.id, tags: c.tags.slice(0, 32).map((t) => t.slice(0, 40)), favorite: c.favorite, gameTitle: c.game.trim() ? c.game.slice(0, 120) : null }));
        return undefined;
      }
      case 'saveProject': {
        const project = validateProject(p);
        const all = kvGet<Record<string, UiProject>>(core.db, KV_PROJECTS) ?? {};
        all[project.id] = project;
        kvSet(core.db, KV_PROJECTS, all);
        return undefined;
      }
      case 'export': {
        const { project, preset, simulateFailure } = p as OperationMap['export']['input'];
        if (simulateFailure) fail('UNSUPPORTED', 'Failure simulation is only available in the browser demo');
        validateProject(project);
        const converted = this.toCoreProject(project);
        core.projects.upsertForExport(converted);
        const job = ok(
          await core.invoke('exports.enqueue', {
            projectId: converted.id,
            settings: exportSettings(preset),
            destinationDirectory: this.resolveExportDir(preset.destination),
            fileName: sanitizeFileStem(project.name.replace(MEDIA_EXT, '') || 'Clip'),
          }),
        );
        return this.mapJob(job);
      }
      case 'cancelJob':
        ok(await core.invoke('jobs.cancel', { id: (p as { id: string }).id }));
        return undefined;
      case 'retryJob':
        ok(await core.invoke('jobs.retry', { id: (p as { id: string }).id }));
        return undefined;
      case 'openOutput':
        ok(await core.invoke('system.openOutput', { jobId: (p as { id: string }).id }));
        return undefined;
      case 'revealOutput':
        ok(await core.invoke('system.reveal', { target: { kind: 'jobOutput', id: (p as { id: string }).id } }));
        return undefined;
      case 'suggestMoments':
        return this.suggestMoments((p as { clipId: string }).clipId);
      case 'youtubeKit':
        return this.youtubeKit((p as { jobId: string }).jobId);
      case 'saveThumbnail': {
        const { jobId, dataUrl } = p as OperationMap['saveThumbnail']['input'];
        return this.saveThumbnail(jobId, dataUrl);
      }
      case 'openYouTubeStudio':
        if (!this.opts.openYouTubeStudio) fail('UNSUPPORTED', 'Opening the browser is not available here');
        await this.opts.openYouTubeStudio();
        return undefined;
      case 'thumbAiStatus':
        return this.thumbAiStatus();
      case 'thumbAiConfigure': {
        const { engine, serverUrl } = p as OperationMap['thumbAiConfigure']['input'];
        const url = serverUrl.trim() || DEFAULT_WEBUI;
        if (engine === 'webui') {
          const bad = validateLocalServer(url);
          if (bad) fail('VALIDATION', bad);
        }
        kvSet(core.db, KV_THUMB_AI, { ...this.thumbAiConfig(), engine, serverUrl: url });
        return this.thumbAiStatus();
      }
      case 'thumbAiPick': {
        const { kind } = p as OperationMap['thumbAiPick']['input'];
        const [file] = await core.platform.pickPath(
          kind === 'engine'
            ? { kind: 'file', purpose: 'imageEngine', title: 'Choose the stable-diffusion.cpp program (sd-cli)' }
            : { kind: 'file', purpose: 'imageModel', title: 'Choose a Stable Diffusion model' },
        );
        if (file) {
          const abs = safeAbsolutePath(file);
          if (!isFile(abs)) fail('NOT_FOUND', 'File not found', { detail: abs });
          kvSet(core.db, KV_THUMB_AI, { ...this.thumbAiConfig(), engine: 'sdcpp', [kind === 'engine' ? 'enginePath' : 'modelPath']: abs });
        }
        return this.thumbAiStatus();
      }
      case 'generateThumbnail':
        return this.generateThumbnail(p as OperationMap['generateThumbnail']['input']);
      case 'cancelThumbnail':
        this.generation?.abort();
        return undefined;
      case 'saveSettings':
        return this.saveSettings(p as UiSettings);
      case 'sessionNotes': {
        const { id, notes } = p as OperationMap['sessionNotes']['input'];
        ok(await core.invoke('sessions.updateNotes', { id, notes: notes.slice(0, 20000) }));
        return undefined;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- operation helpers

  /** Replaces the setup form's placeholder text with real values before storing. */
  private normalizeProfile(p: UiProfile): UiProfile {
    const derived = URI_RE.test(p.gamePath.trim()) ? '' : path.basename(p.gamePath.trim()).replace(/\.(exe|lnk)$/i, '');
    const game = p.game === GAME_PLACEHOLDER ? derived || 'My game' : p.game;
    const name = p.name === NAME_PLACEHOLDER ? (game && game !== 'My game' ? `${game} session` : 'My first profile') : p.name;
    return { ...p, game, name };
  }

  /** Any id the renderer sends refers to the one setup; it must have been saved first. */
  private requireProfile(_id: string): UiProfile {
    const setup = this.uiProfiles()[0] ?? fail('NOT_FOUND', 'Set up your game first (Settings → General → Game session)');
    try {
      this.core.profiles.get(SETUP_ID);
    } catch {
      this.core.profiles.save(this.toCoreProfile(setup)); // migrate older profile data
    }
    return setup;
  }

  private toCoreProfile(p: UiProfile): SessionProfileInput {
    const gamePath = p.gamePath.trim();
    const isUri = URI_RE.test(gamePath);
    const destination = p.destination.trim();
    return {
      id: p.id,
      name: p.name.trim().slice(0, 80),
      gameTitle: (p.game.trim() && p.game !== GAME_PLACEHOLDER ? p.game : isUri ? '' : path.basename(gamePath).replace(/\.(exe|lnk)$/i, '')).slice(0, 120),
      game: isUri ? { kind: 'uri', uri: gamePath, processName: null } : { kind: 'executable', path: gamePath, args: [], processName: null },
      artworkPath: null,
      obs: { sceneName: p.scene.trim() || null, startReplayBuffer: true, startRecording: false },
      replayDurationSec: Math.max(5, Math.min(21600, Math.round(p.replayDurationMs / 1000))),
      recordingDirectory: path.isAbsolute(destination) ? destination : null,
      audioPreset: null,
      companionApps: p.companionApps
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 16)
        .map((appPath, i) => ({ id: `app${i}`, name: path.basename(appPath).replace(/\.(exe|lnk)$/i, '') || `App ${i + 1}`, path: appPath, args: [], processName: null })),
      tags: [],
    };
  }

  /** The selected profile's hotkey drives the global Save Replay shortcut (when shortcuts are enabled). */
  private applyProfileHotkey(): void {
    const s = this.core.settings.get();
    const hotkey = this.uiProfiles()[0]?.hotkey.trim() || null;
    const globalOn = s.shortcuts.some((x) => x.scope === 'global' && x.enabled);
    const next = s.shortcuts.map((x) => (x.action === 'saveReplay' ? { ...x, accelerator: hotkey ?? x.accelerator, enabled: globalOn && (hotkey ?? x.accelerator) !== null } : x));
    try {
      this.core.settings.update({ shortcuts: next });
    } catch (err) {
      this.core.notice('warning', 'Shortcut not applied', toDriftError(err).message);
    }
  }

  private async saveReplay(): Promise<UiClip> {
    const core = this.core;
    const accepted = (await core.invoke('obs.saveReplay', {}));
    if (!accepted.ok) throw new DriftFailure(accepted.error.code, accepted.error.message, { detail: accepted.error.detail, retryable: accepted.error.retryable });
    const { requestId } = accepted.data;
    const savedPath = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new DriftFailure('TIMEOUT', 'OBS accepted the save but did not report a file within 45 s', { retryable: true }));
      }, 45_000);
      const off = core.bus.on('replay.saved', (e) => {
        if (e.requestId === requestId || e.requestId === null) {
          clearTimeout(timer);
          off();
          resolve(e.path);
        }
      });
    });
    // Auto-import (DriftCore) indexes the file; wait for it, or import directly if disabled.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const rec = core.library.findByPath(savedPath);
      if (rec) return this.mapClip(rec);
      if (!core.settings.get().media.autoImportReplays) {
        const r = await core.library.importOne(savedPath, { source: 'replay' });
        if (r.clipId) return this.mapClip(core.library.getRecord(r.clipId));
        throw new DriftFailure(r.error?.code ?? 'IO', r.error?.message ?? 'Import failed');
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new DriftFailure('TIMEOUT', 'The replay was saved but indexing did not finish', { detail: savedPath, retryable: true });
  }

  private async importNative(): Promise<UiClip[]> {
    const core = this.core;
    const files = await core.platform.pickPath({ kind: 'files', purpose: 'import', title: 'Import recordings' });
    if (!files.length) return [];
    const r = await core.invoke('clips.import', { paths: files.slice(0, 200) });
    if (!r.ok) throw new DriftFailure(r.error.code, r.error.message, { detail: r.error.detail });
    const good = r.data.filter((x) => x.clipId).map((x) => this.mapClip(core.library.getRecord(x.clipId!)));
    const failed = r.data.filter((x) => x.outcome === 'failed');
    if (!good.length && failed[0]?.error) throw new DriftFailure(failed[0].error.code, failed[0].error.message, { detail: failed[0].error.detail });
    if (failed.length) core.notice('warning', 'Some files were not imported', failed.map((f) => `${path.basename(f.path)}: ${f.error?.message}`).join('; '));
    return good;
  }

  private async saveSettings(next: UiSettings): Promise<void> {
    const core = this.core;
    const folder = next.mediaFolder.trim();
    if (folder && !path.isAbsolute(folder)) fail('VALIDATION', 'Use a full folder path, for example C:\\Users\\you\\Videos\\Drift');
    const prev = core.settings.get();
    const globalOn = next.shortcuts;
    const shortcuts = prev.shortcuts.map((x) => (x.scope === 'global' ? { ...x, enabled: globalOn && (x.action === 'saveReplay' || x.enabled) } : x));
    const r = await core.invoke('settings.update', {
      media: { libraryDirectory: folder || null },
      obs: { host: next.obsHost.trim(), port: next.obsPort },
      transcription: { enabled: next.transcription },
      performance: { maxConcurrentJobs: next.workerLimit },
      shortcuts,
    });
    if (!r.ok) throw new DriftFailure(r.error.code, r.error.message, { detail: r.error.detail });
    kvSet(core.db, KV_APPEARANCE, next.appearance);
    kvSet(core.db, KV_VOICE, next.voiceClip === true);
    this.opts.onVoiceWanted?.(this.voiceWanted());
    this.applyProfileHotkey();
    void this.refreshDisk();
  }

  // ---------------------------------------------------------------- YouTube helpers

  private momentCache = new Map<string, UiMoment[]>();

  private async suggestMoments(clipId: string): Promise<UiMoment[]> {
    const rec = this.core.library.getRecord(clipId);
    if (!isFile(rec.path)) fail('MEDIA_MISSING', 'The recording was moved or deleted. Relink it first.', { detail: rec.path });
    const key = `${rec.path}|${fs.statSync(rec.path).mtimeMs}`;
    const cached = this.momentCache.get(key);
    if (cached) return cached;
    if (!rec.hasAudio) fail('VALIDATION', 'This clip has no audio, so loud moments cannot be found.');
    const loud = await this.core.tools.loudness(rec.path);
    const moments = findMoments(loud.momentary).map((m) => ({ atMs: Math.min(m.atMs, rec.durationMs), excessLu: m.excessLu }));
    this.momentCache.set(key, moments);
    if (this.momentCache.size > 50) this.momentCache.delete(this.momentCache.keys().next().value!);
    return moments;
  }

  private finishedOutput(jobId: string): { job: Job; file: string } {
    const job = this.core.jobs.get(jobId);
    if (job.state !== 'succeeded' || !job.outputPath) fail('CONFLICT', 'The export has not finished yet');
    if (!isFile(job.outputPath)) fail('MEDIA_MISSING', 'The exported file was moved or deleted', { detail: job.outputPath });
    return { job, file: job.outputPath };
  }

  private async youtubeKit(jobId: string): Promise<UiYouTubeKit> {
    const { job, file } = this.finishedOutput(jobId);
    const tools = this.core.tools;
    const probe = await tools.probe(file);
    const loud = probe.audio ? await tools.loudness(file) : { integratedLufs: null, truePeakDb: null, momentary: [] };
    const checks = youtubeChecks(probe, loud, fs.statSync(file).size);
    const short = isShort(probe);

    // Chapters follow the exported timeline; game title from the clips used (else the game setup).
    let parts: Array<{ title: string; durationMs: number }> = [];
    let game: string | null = this.uiProfiles()[0]?.game ?? null;
    let name = path.basename(file, path.extname(file));
    try {
      const project = this.core.projects.get(job.refId ?? '');
      name = project.name || name;
      const items = project.tracks[0]?.items ?? [];
      const titles = items.map((it) => {
        try {
          const r = this.core.library.getRecord(it.clipId);
          game = r.gameTitle ?? game;
          return path.basename(r.fileName, path.extname(r.fileName));
        } catch {
          return '';
        }
      });
      const distinct = new Set(titles).size === titles.length && titles.every(Boolean);
      parts = items.map((it, i) => ({ title: distinct ? titles[i]! : `Part ${i + 1}`, durationMs: it.sourceOutMs - it.sourceInMs }));
    } catch {
      /* project deleted: no chapters */
    }
    const { chapters, reason } = short ? { chapters: [], reason: 'Shorts do not show chapters.' } : buildChapters(parts);
    const meta = buildMetadata({ name, game: game && game !== GAME_PLACEHOLDER ? game : null, short, chapters });

    // Thumbnail candidates: the loudest moment (if any) plus evenly spaced frames.
    const d = probe.durationMs;
    const best = findMoments(loud.momentary, 1)[0]?.atMs;
    const times = [...new Set([best, d * 0.25, d * 0.5, d * 0.75].filter((t): t is number => t !== undefined).map((t) => Math.round(Math.min(Math.max(t, 0), Math.max(0, d - 200)))))].slice(0, 4);
    const frames: string[] = [];
    if (probe.video) {
      for (const t of times) {
        try {
          frames.push('data:image/jpeg;base64,' + (await tools.frameJpeg(file, t, 1280, 720)).toString('base64'));
        } catch {
          /* skip unreadable frame */
        }
      }
    }
    return {
      jobId,
      fileName: path.basename(file),
      durationMs: d,
      width: probe.video?.width ?? 0,
      height: probe.video?.height ?? 0,
      isShort: short,
      loudnessLufs: loud.integratedLufs,
      checks,
      chapters,
      chapterNote: reason,
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      frames,
    };
  }

  private saveThumbnail(jobId: string, dataUrl: string): { fileName: string } {
    const { file } = this.finishedOutput(jobId);
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    const size = jpegSize(bytes);
    if (!size) fail('VALIDATION', 'The thumbnail is not a valid JPEG image');
    if (size.width !== 1280 || size.height !== 720) fail('VALIDATION', 'YouTube thumbnails should be 1280×720', { detail: `${size.width}×${size.height}` });
    if (bytes.length > THUMB_MAX_BYTES) fail('VALIDATION', 'YouTube thumbnails must be 2 MB or smaller');
    const dir = path.dirname(file);
    const stem = path.basename(file, path.extname(file));
    let out = path.join(dir, `${stem} thumbnail.jpg`);
    for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${stem} thumbnail ${n}.jpg`);
    fs.writeFileSync(out, bytes, { flag: 'wx' });
    this.core.platform.showItemInFolder(out);
    return { fileName: path.basename(out) };
  }

  // ---------------------------------------------------------------- local AI thumbnails

  private generation: AbortController | null = null;

  private thumbAiConfig(): { engine: ThumbAiEngine; enginePath: string | null; modelPath: string | null; serverUrl: string } {
    const c = kvGet<Partial<{ engine: ThumbAiEngine; enginePath: string | null; modelPath: string | null; serverUrl: string }>>(this.core.db, KV_THUMB_AI) ?? {};
    return { engine: c.engine ?? 'off', enginePath: c.enginePath ?? null, modelPath: c.modelPath ?? null, serverUrl: c.serverUrl ?? DEFAULT_WEBUI };
  }

  private async thumbAiStatus(): Promise<ThumbAiStatus> {
    const c = this.thumbAiConfig();
    let ready = false;
    let detail: string | null = null;
    if (c.engine === 'off') detail = 'Off. Choose an engine to generate thumbnails on this PC.';
    else if (c.engine === 'sdcpp') {
      detail = SdCppEngine.problem(c.enginePath, c.modelPath);
      ready = detail === null;
      if (ready) detail = `Ready · ${path.basename(c.modelPath!)}`;
    } else {
      const s = await new WebUiEngine(c.serverUrl).check();
      ready = s.ok;
      detail = s.ok ? `Connected${s.model ? ` · ${s.model}` : ''}` : s.reason;
    }
    return {
      engine: c.engine,
      engineFile: c.enginePath ? path.basename(c.enginePath) : null,
      modelFile: c.modelPath ? path.basename(c.modelPath) : null,
      serverUrl: c.serverUrl,
      ready,
      detail,
      busy: this.generation !== null,
    };
  }

  private async generateThumbnail(input: OperationMap['generateThumbnail']['input']): Promise<OperationMap['generateThumbnail']['output']> {
    const c = this.thumbAiConfig();
    let engine: ImageEngine;
    if (c.engine === 'sdcpp') {
      const problem = SdCppEngine.problem(c.enginePath, c.modelPath);
      if (problem) fail('VALIDATION', problem);
      engine = new SdCppEngine(c.enginePath!, c.modelPath!, async (input, output, w, h) => {
        const r = await run(this.core.tools.requireFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`, output], { timeoutMs: 60_000 });
        if (r.code !== 0 || !isFile(output)) fail('MEDIA_INVALID', 'Could not read the starting image', { detail: r.stderr.slice(-1000) });
      });
    } else if (c.engine === 'webui') engine = new WebUiEngine(c.serverUrl);
    else fail('UNSUPPORTED', 'Turn on the thumbnail generator in Settings → AI & Privacy');
    if (this.generation) fail('BUSY', 'A thumbnail is already being generated');
    // Generation saturates the GPU; during a live stream that would drop frames for viewers.
    if (this.core.obs.getState().streaming.active) fail('BUSY', 'You are live. Generate thumbnails after the stream so viewers do not see dropped frames.');
    let init: Buffer | null = null;
    if (input.initImage) {
      init = Buffer.from(input.initImage.slice(input.initImage.indexOf(',') + 1), 'base64');
      if (!isPng(init) && !isJpeg(init)) fail('VALIDATION', 'The starting image must be a PNG or JPEG');
    }
    const ctrl = new AbortController();
    this.generation = ctrl;
    this.schedule();
    const started = Date.now();
    const seed = Math.floor(Math.random() * 2 ** 31);
    try {
      const r = await engine.generate({ description: input.description, init, strength: input.strength, count: input.count, seed }, ctrl.signal);
      return { images: r.images.map((b) => 'data:image/png;base64,' + b.toString('base64')), engine: engine.label, seed, ms: Date.now() - started };
    } finally {
      this.generation = null;
    }
  }

  private resolveExportDir(destination: string): string {
    const d = destination.trim();
    if (path.isAbsolute(d)) return safeAbsolutePath(d, 'Export destination');
    const s = this.core.settings.get();
    const base = s.media.exportDirectory ?? s.media.libraryDirectory ?? fail('VALIDATION', 'Choose a media folder in Settings first, or enter a full export path');
    return path.join(base, sanitizeFileStem(d || 'Exports'));
  }

  /** Converts the renderer's edit model into the service EditProject used by the FFmpeg export. */
  toCoreProject(p: UiProject): EditProject {
    const segments = p.tracks
      .filter((t) => t.kind === 'video')
      .flatMap((t) => t.segments)
      .sort((a, b) => a.offsetMs - b.offsetMs);
    if (!segments.length) fail('VALIDATION', 'The timeline is empty');
    const first = this.core.library.getRecord(segments[0]!.assetId);
    const targetAspect = p.aspect === '9:16' ? 9 / 16 : 16 / 9;
    const srcAspect = first.width && first.height ? first.width / first.height : 16 / 9;
    // Renderer crop = CSS object-position (percent) with object-fit: cover.
    let crop: EditProject['crop'];
    if (srcAspect > targetAspect + 0.001) {
      const w = targetAspect / srcAspect;
      crop = { x: ((1 - w) * p.cropX) / 100, y: 0, w, h: 1 };
    } else if (srcAspect < targetAspect - 0.001) {
      const h = srcAspect / targetAspect;
      crop = { x: 0, y: ((1 - h) * p.cropY) / 100, w: 1, h };
    } else crop = null;
    const total = segments.reduce((s, x) => s + (x.outMs - x.inMs), 0);
    // Caption size is in output-canvas pixels (1920×1080 or 1080×1920); the service scales from 1080 px height.
    const canvasHeight = p.aspect === '9:16' ? 1920 : 1080;
    const music = p.musicHandle
      ? (() => {
          const token = /^drift-media:\/\/music\/([\w-]+)$/.exec(p.musicHandle)?.[1];
          const file = token ? this.resolveMusic(token) : null;
          if (!file) fail('MEDIA_MISSING', 'The music file for this draft is not available. Choose it again in the Audio tab.');
          return { path: file, userSupplied: true as const, gainDb: gainToDb(p.musicGain), startMs: 0, fadeInMs: 0, fadeOutMs: 0 };
        })()
      : null;
    const now = new Date().toISOString();
    return {
      id: p.id,
      name: p.name.slice(0, 120) || 'Clip',
      revision: 0,
      tracks: [
        {
          id: 'main',
          kind: 'main',
          muted: false,
          items: segments.map((s) => ({
            id: s.id,
            clipId: s.assetId,
            sourceInMs: Math.round(s.inMs),
            sourceOutMs: Math.round(s.outMs),
            gainDb: gainToDb(s.gain),
            fadeInMs: Math.round(s.fadeInMs),
            fadeOutMs: Math.round(s.fadeOutMs),
          })),
        },
      ],
      aspect: p.aspect,
      crop,
      webcam: null, // renderer webcam is a layout guide, not a connected source
      captions: p.captions
        .filter((c) => c.text.trim() && c.startMs < total)
        .map((c) => ({ id: c.id, startMs: Math.round(c.startMs), endMs: Math.round(Math.min(c.endMs, total)), text: c.text.slice(0, 500) }))
        .filter((c) => c.endMs > c.startMs),
      captionStyle: {
        ...DEFAULT_CAPTION_STYLE,
        fontFamily: p.captionStyle.font.slice(0, 80) || DEFAULT_CAPTION_STYLE.fontFamily,
        sizePx: Math.max(12, Math.min(200, Math.round((p.captionStyle.size * 1080) / canvasHeight))),
        color: /^#[0-9a-fA-F]{6}$/.test(p.captionStyle.color) ? p.captionStyle.color : '#FFFFFF',
        position: p.captionStyle.position,
      },
      music,
      originalAudioGainDb: gainToDb(p.originalGain),
      videoFadeInMs: 0,
      videoFadeOutMs: 0,
      presetId: null,
      createdAt: now,
      updatedAt: now,
    };
  }
}

export function exportSettings(preset: UiExportPreset): ExportSettings {
  const short = preset.resolution;
  const long = Math.round((short * 16) / 9 / 2) * 2;
  return {
    aspect: preset.aspect,
    width: preset.aspect === '9:16' ? short : long,
    height: preset.aspect === '9:16' ? long : short,
    fps: preset.fps,
    quality: preset.quality === 'high' ? 'high' : 'standard',
    codec: preset.codec,
    encoder: 'auto',
    audioBitrateKbps: 192,
    loudnessLufs: preset.loudness ? YOUTUBE_LOUDNESS_LUFS : null,
  };
}
