import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { methods, type MethodInput, type MethodName, type MethodOutput } from './contract/api';
import { CONTRACT_VERSION, type Capabilities, type Notice, type ShortcutAction, type StatusStrip, type Telemetry } from './contract/dto';
import { EXPORT_PRESETS } from './contract/defaults';
import { AudioService } from './audio/AudioService';
import { openDatabase, type Db } from './core/database';
import { DriftFailure, fail, toDriftError } from './core/errors';
import { EventBus } from './core/events';
import { newId, nowIso } from './core/ids';
import { Logger, redact, redactPaths } from './core/logger';
import { diskStatus, isDirectory, isFile, safeAbsolutePath } from './core/paths';
import type { Platform } from './core/platform';
import { JobQueue } from './jobs/JobQueue';
import { createExportHandler, createProxyHandler, type ExportJobPayload, type ProxyJobPayload } from './jobs/mediaJobs';
import { ClipLibrary, waitForStableFile } from './library/ClipLibrary';
import { MediaTools, locateTools } from './media/ffmpeg';
import { ObsService, type ObsClient } from './obs/ObsService';
import { ProjectService } from './projects/ProjectService';
import { ProfileService } from './sessions/ProfileService';
import { SessionService } from './sessions/SessionService';
import { SettingsService } from './settings/SettingsService';
import { ShortcutService } from './settings/ShortcutService';
import { createTranscriptionHandler, type TranscriptionPayload } from './transcription/whisper';
import type { Result } from './contract/dto';

export interface CoreOptions {
  platform: Platform;
  /** Directories searched for bundled ffmpeg/ffprobe. */
  resourceDirs?: string[];
  /** ':memory:' for tests. */
  databaseFile?: string;
  obsClientFactory?: () => ObsClient;
  safeMode?: boolean;
  echoLogs?: boolean;
}

type HandlerInput<M extends MethodName> = z.output<(typeof methods)[M]['input']>;
type Handlers = { [M in MethodName]: (input: HandlerInput<M>) => Promise<MethodOutput<M>> | MethodOutput<M> };

/**
 * Composition root for all desktop services. Contains no Electron imports so it can
 * run under plain Node for integration tests.
 */
export class DriftCore {
  readonly bus = new EventBus();
  readonly log: Logger;
  readonly db: Db;
  readonly settings: SettingsService;
  readonly tools: MediaTools;
  readonly library: ClipLibrary;
  readonly projects: ProjectService;
  readonly jobs: JobQueue;
  readonly obs: ObsService;
  readonly audio: AudioService;
  readonly profiles: ProfileService;
  readonly sessions: SessionService;
  readonly shortcuts: ShortcutService;
  private readonly notices: Notice[] = [];
  private readonly handlers: Handlers;
  private hwEncoders: Array<'nvenc' | 'qsv' | 'amf'> = [];
  private captionsBurnIn = false;

  constructor(private readonly opts: CoreOptions) {
    const p = opts.platform;
    this.log = new Logger(p.logsDir, 'core', opts.echoLogs ?? false);
    this.db = openDatabase(opts.databaseFile ?? path.join(p.dataDir, 'drift-studio.db'));
    this.settings = new SettingsService(this.db, p.secrets);
    const s = this.settings.get();
    this.tools = new MediaTools(locateTools({ ffmpeg: s.tools.ffmpegPath, ffprobe: s.tools.ffprobePath }, opts.resourceDirs ?? []));
    this.library = new ClipLibrary(this.db, this.tools, this.bus, this.log.child('library'), p.dataDir);
    this.projects = new ProjectService(this.db, this.library);
    this.profiles = new ProfileService(this.db, p.os);

    this.obs = new ObsService(
      this.bus,
      this.log.child('obs'),
      {
        onReplaySaved: (file, requestId) => void this.onObsFile(file, 'replay', requestId),
        onRecordingStopped: (file) => void this.onObsFile(file, 'recording', null),
        onOutputEvent: (kind) => {
          const labels = {
            'recording.started': 'Recording started',
            'recording.stopped': 'Recording stopped',
            'replay.started': 'Replay buffer started',
            'replay.stopped': 'Replay buffer stopped',
            'stream.started': 'Stream went live',
            'stream.stopped': 'Stream ended',
          } as const;
          this.sessions.recordActive(kind, labels[kind]);
        },
        onInputsChanged: () => this.audio.scheduleRefresh(),
        onMeters: (m) => this.bus.emit('audio.meters', m),
        notice: (level, title, message) => this.notice(level, title, message),
      },
      opts.obsClientFactory,
    );
    this.audio = new AudioService(this.obs, this.bus, this.log.child('audio'), p.os, () => this.settings.get().obs.microphoneInputName);
    this.sessions = new SessionService({
      db: this.db,
      bus: this.bus,
      log: this.log.child('sessions'),
      obs: this.obs,
      audio: this.audio,
      profiles: this.profiles,
      host: { openExternal: (u) => p.openExternal(u), openPath: (f) => p.openPath(f) },
      platform: p.os,
      connectObs: async () => (await this.connectObs()).state === 'connected',
      libraryDirectory: () => this.settings.get().media.libraryDirectory,
    });

    this.jobs = new JobQueue(
      this.db,
      this.bus,
      this.log.child('jobs'),
      () => this.settings.get().performance.maxConcurrentJobs,
      () => this.settings.get().performance.lowerPriorityWhileGaming && this.sessions.isGaming(),
    );
    this.jobs.register<ExportJobPayload>(
      'export',
      createExportHandler({
        tools: this.tools,
        library: this.library,
        projects: this.projects,
        log: this.log.child('export'),
        preferHardware: () => this.settings.get().performance.preferHardwareEncoding,
        onExported: ({ jobId, outputPath, sourceClipIds }) => {
          const sessionIds = new Set(sourceClipIds.map((id) => this.library.getRecord(id).sessionId).filter((x): x is string => !!x));
          for (const sid of sessionIds) this.sessions.attachExport(sid, jobId, `Exported ${path.basename(outputPath)}`);
          this.notice('success', 'Export ready', path.basename(outputPath), jobId);
        },
      }),
    );
    this.jobs.register<ProxyJobPayload>('proxy', createProxyHandler({ tools: this.tools, library: this.library, log: this.log.child('proxy') }));
    this.jobs.register<TranscriptionPayload>(
      'transcription',
      createTranscriptionHandler({
        tools: this.tools,
        library: this.library,
        projects: this.projects,
        whisper: () => {
          const t = this.settings.get().transcription;
          return { exe: t.enabled ? t.whisperPath : null, model: t.enabled ? t.modelPath : null };
        },
      }),
    );
    this.library.onNeedsProxy = (clipId) => {
      const payload = { clipId };
      if (!this.jobs.findActiveBySpec('proxy', payload)) this.jobs.enqueue('proxy', `Preparing playback for ${this.library.getRecord(clipId).fileName}`, payload, clipId);
    };

    this.shortcuts = new ShortcutService(p.shortcuts, this.log.child('shortcuts'), (a) => void this.onShortcut(a), opts.safeMode ?? false);
    this.settings.onChange((next, prev) => {
      if (next.tools.ffmpegPath !== prev.tools.ffmpegPath || next.tools.ffprobePath !== prev.tools.ffprobePath) {
        this.tools.setPaths(locateTools({ ffmpeg: next.tools.ffmpegPath, ffprobe: next.tools.ffprobePath }, this.opts.resourceDirs ?? []));
        void this.probeMediaCapabilities();
      }
      if (JSON.stringify(next.shortcuts) !== JSON.stringify(prev.shortcuts)) this.shortcuts.apply(next.shortcuts);
    });

    this.handlers = this.buildHandlers();
  }

  /** Starts background work: job recovery, shortcut registration, OBS auto-connect, library verification. */
  async start(): Promise<void> {
    this.jobs.start();
    this.shortcuts.apply(this.settings.get().shortcuts);
    await this.probeMediaCapabilities();
    const verify = this.library.verifyAll();
    if (verify.missing) this.notice('warning', 'Missing media', `${verify.missing} clip(s) could not be found on disk. Relink them in ClipForge.`);
    const s = this.settings.get();
    if (s.obs.autoConnect) void this.connectObs();
    this.log.info('core started', { version: this.opts.platform.appVersion, ffmpeg: !!this.tools.ffmpegPath, hw: this.hwEncoders });
  }

  async dispose(): Promise<void> {
    this.shortcuts.dispose();
    await this.jobs.stop();
    this.obs.dispose();
    this.db.close();
    this.log.close();
  }

  /** Typed in-process call (tests, internal use). Goes through the same validation as IPC. */
  invoke<M extends MethodName>(method: M, input: MethodInput<M>): Promise<Result<MethodOutput<M>>> {
    return this.invokeRaw(method, input) as Promise<Result<MethodOutput<M>>>;
  }

  /** IPC entry point: validates untrusted input against the contract and maps errors to a Result. */
  async invokeRaw(method: string, rawInput: unknown): Promise<Result<unknown>> {
    if (!Object.prototype.hasOwnProperty.call(methods, method)) {
      return { ok: false, error: { code: 'VALIDATION', message: `Unknown operation ${method}`, detail: null, retryable: false } };
    }
    const m = method as MethodName;
    const parsed = methods[m].input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Invalid request', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'), retryable: false } };
    }
    try {
      const data = await (this.handlers[m] as (i: unknown) => unknown)(parsed.data);
      return { ok: true, data: data === undefined ? null : data };
    } catch (err) {
      const e = toDriftError(err);
      if (e.code === 'INTERNAL') this.log.error('handler crashed', { method, detail: e.detail });
      return { ok: false, error: e };
    }
  }

  // ---- internals ----------------------------------------------------------

  private async connectObs() {
    const s = this.settings.get();
    return this.obs.connect({ host: s.obs.host, port: s.obs.port, password: this.settings.obsPassword() });
  }

  private async probeMediaCapabilities(): Promise<void> {
    try {
      this.hwEncoders = await this.tools.hardwareEncoders();
      this.captionsBurnIn = this.tools.ffmpegPath ? (await this.tools.filters()).has('subtitles') : false;
    } catch {
      this.hwEncoders = [];
      this.captionsBurnIn = false;
    }
  }

  private async onObsFile(file: string, source: 'replay' | 'recording', requestId: string | null): Promise<void> {
    const s = this.settings.get();
    const label = source === 'replay' ? 'Replay saved' : 'Recording saved';
    this.sessions.recordActive(source === 'replay' ? 'replay.saved' : 'recording.stopped', `${label}: ${path.basename(file)}`, requestId);
    if (source === 'replay' ? !s.media.autoImportReplays : !s.media.autoImportRecordings) return;
    try {
      await waitForStableFile(file);
      const active = this.sessions.getActive();
      const res = await this.library.importOne(file, { source, sessionId: active?.id ?? null, gameTitle: active?.gameTitle ?? null });
      if (res.outcome === 'failed') {
        this.notice('error', `${label}, but import failed`, res.error?.message ?? 'Unknown error');
        return;
      }
      if (active && res.clipId) this.sessions.attachClip(active.id, res.clipId, `${label} → ClipForge`);
      if (res.outcome === 'imported') this.notice('success', label, path.basename(file), res.clipId);
    } catch (err) {
      this.notice('error', `${label}, but import failed`, toDriftError(err).message);
    }
  }

  private async onShortcut(action: ShortcutAction): Promise<void> {
    this.bus.emit('shortcut.triggered', { action });
    try {
      switch (action) {
        case 'saveReplay':
          await this.obs.saveReplay();
          this.notice('info', 'Saving replay…', 'OBS accepted the request');
          break;
        case 'toggleRecording':
          await (this.obs.getState().recording.active ? this.obs.stopRecording() : this.obs.startRecording());
          break;
        case 'toggleReplayBuffer':
          await (this.obs.getState().replayBuffer.active ? this.obs.stopReplayBuffer() : this.obs.startReplayBuffer());
          break;
        case 'toggleMicMute':
          await this.audio.toggleMicMute();
          break;
        case 'openCommandPalette':
          break; // handled by the renderer
      }
    } catch (err) {
      this.notice('error', 'Shortcut failed', toDriftError(err).message);
    }
  }

  notice(level: Notice['level'], title: string, message: string, refId: string | null = null): void {
    const n: Notice = { id: newId('ntc'), at: nowIso(), level, title, message, refId };
    this.notices.unshift(n);
    if (this.notices.length > 200) this.notices.pop();
    this.bus.emit('notice', n);
  }

  async capabilities(): Promise<Capabilities> {
    const p = this.opts.platform;
    const st = this.obs.getState();
    const connected = this.obs.connected;
    const notConnected = { available: false, reason: st.connection.detail ?? 'Not connected to OBS' };
    const yes = { available: true, reason: null };
    const ff = !!this.tools.ffmpegPath;
    const t = this.settings.get().transcription;
    const transcriptionReady = t.enabled && !!t.whisperPath && isFile(t.whisperPath) && !!t.modelPath && isFile(t.modelPath);
    const win = p.os === 'win32';
    return {
      contractVersion: CONTRACT_VERSION,
      mode: 'desktop',
      platform: p.os,
      appVersion: p.appVersion,
      obs: {
        connection: yes,
        preview: connected ? { available: true, reason: 'Still-frame preview (screenshots), not a live video feed' } : notConnected,
        scenes: connected ? yes : notConnected,
        recording: connected ? yes : notConnected,
        replayBuffer: connected ? (st.replayBuffer.available ? yes : { available: false, reason: st.replayBuffer.unavailableReason }) : notConnected,
        streaming: connected ? { available: true, reason: 'Uses the stream destination configured in OBS' } : notConnected,
        stats: connected ? yes : notConnected,
      },
      media: {
        ffmpeg: ff ? yes : { available: false, reason: 'FFmpeg not found. Install it or set the path in Settings.' },
        ffprobe: this.tools.ffprobePath ? yes : { available: false, reason: 'ffprobe not found. Install FFmpeg or set the path in Settings.' },
        captionsBurnIn: this.captionsBurnIn ? yes : { available: false, reason: ff ? 'This FFmpeg build lacks libass (subtitles filter)' : 'FFmpeg not found' },
        hardwareEncoders: this.hwEncoders,
      },
      audio: {
        obsInputs: connected ? yes : notConnected,
        obsMeters: connected ? yes : notConnected,
        windowsDevices: win ? { available: true, reason: 'Names and status only' } : { available: false, reason: 'Windows only' },
        windowsDeviceControl: { available: false, reason: 'Drift Studio does not change Windows device volume or routing. Use OBS inputs or Windows sound settings.' },
      },
      launcher: {
        executables: yes,
        uris: { available: true, reason: 'steam://, com.epicgames.launcher://, uplay://, origin://, battlenet:// and similar launcher links' },
        processDetection: { available: true, reason: 'By process image name (tasklist); does not read game memory' },
      },
      telemetry: {
        gameFps: { available: false, reason: 'Game frame rate is not measured. Drift Studio does not hook or inject into games.' },
        obsRenderFps: connected ? { available: true, reason: 'OBS render rate, not game FPS' } : notConnected,
        encoderStats: connected ? yes : notConnected,
        disk: yes,
      },
      transcription: transcriptionReady ? { available: true, reason: 'Local whisper.cpp' } : { available: false, reason: 'Optional. Set up a local whisper.cpp executable and model in Settings → Transcription.' },
      hotkeys: p.shortcuts ? (this.opts.safeMode ? { available: false, reason: 'Safe mode' } : yes) : { available: false, reason: 'Not available on this host' },
      secureStorage: p.secrets.available ? yes : { available: false, reason: 'OS protected storage unavailable; the OBS password is kept only until the app closes' },
      streamDeck: { available: false, reason: 'Not implemented. Use global shortcuts (Stream Deck "Hotkey" action) for now; see docs/backend-handoff.md.' },
    };
  }

  private async statusStrip(): Promise<StatusStrip> {
    const st = this.obs.getState();
    const s = this.settings.get();
    const dir = st.recording.directory ?? s.media.libraryDirectory;
    return {
      recording: this.obs.connected ? { active: st.recording.active, durationMs: st.recording.durationMs } : null,
      replayBuffer: this.obs.connected ? { available: st.replayBuffer.available, active: st.replayBuffer.active } : null,
      obsReason: this.obs.connected ? null : st.connection.detail,
      disk: dir ? await diskStatus(dir) : null,
      activeJobs: this.jobs.activeCount(),
      activeSessionId: this.sessions.getActive()?.id ?? null,
    };
  }

  private async telemetry(): Promise<Telemetry> {
    const st = this.obs.getState();
    const dir = st.recording.directory ?? this.settings.get().media.libraryDirectory;
    const disk = dir ? await diskStatus(dir) : null;
    return {
      at: nowIso(),
      gameFps: null,
      gameFpsReason: 'Not measured: Drift Studio does not hook or inject into games.',
      obs: this.obs.connected ? st.stats : null,
      obsReason: this.obs.connected ? null : st.connection.detail,
      disk,
      diskReason: disk ? null : dir ? 'Could not read free space' : 'No recording or library folder configured',
    };
  }

  private async exportDiagnostics(): Promise<{ path: string }> {
    const p = this.opts.platform;
    const s = this.settings.get();
    const scrub = (v: unknown) => {
      const json = JSON.stringify(redact(v), null, 2);
      return s.privacy.includePathsInDiagnostics ? json : redactPaths(json);
    };
    const logFile = this.log.file;
    const logTail = logFile && isFile(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-500).join('\n') : '';
    const out = path.join(p.logsDir, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const body = {
      generatedAt: nowIso(),
      appVersion: p.appVersion,
      contractVersion: CONTRACT_VERSION,
      platform: p.os,
      ffmpeg: await this.tools.version(),
      capabilities: await this.capabilities(),
      obs: { connection: this.obs.getState().connection, version: this.obs.getState().version },
      jobs: this.jobs.list(20).map((j) => ({ kind: j.kind, state: j.state, error: j.error })),
      settings: { ...s, obs: { ...s.obs, passwordStored: s.obs.passwordStored } },
    };
    fs.writeFileSync(out, `${scrub(body)}\n\n--- log tail ---\n${s.privacy.includePathsInDiagnostics ? logTail : redactPaths(logTail)}`);
    return { path: out };
  }

  private defaultExportDir(): string {
    const s = this.settings.get();
    const dir = s.media.exportDirectory ?? (s.media.libraryDirectory ? path.join(s.media.libraryDirectory, 'Exports') : null);
    return dir ?? fail('VALIDATION', 'Choose an export folder in Settings → Media storage first');
  }

  private buildHandlers(): Handlers {
    const p = this.opts.platform;
    const h: Partial<Handlers> = {};
    const def = <M extends MethodName>(m: M, fn: Handlers[M]) => {
      (h as Record<string, unknown>)[m] = fn;
    };

    // system
    def('system.getCapabilities', () => this.capabilities());
    def('system.getStatusStrip', () => this.statusStrip());
    def('system.getTelemetry', () => this.telemetry());
    def('system.getDisk', async ({ path: dir }) => {
      const target = dir ? safeAbsolutePath(dir) : (this.obs.getState().recording.directory ?? this.settings.get().media.libraryDirectory);
      return target ? diskStatus(target) : null;
    });
    def('system.pickPath', (req) => p.pickPath(req));
    def('system.reveal', ({ target }) => {
      if (target.kind === 'clip') p.showItemInFolder(this.library.getRecord(target.id).path);
      else if (target.kind === 'jobOutput') {
        const out = this.jobs.get(target.id).outputPath ?? fail('NOT_FOUND', 'This job has no output file');
        p.showItemInFolder(out);
      } else if (target.kind === 'logs') void p.openPath(p.logsDir);
      else {
        const dir = this.settings.get().media.libraryDirectory ?? fail('VALIDATION', 'No library folder configured');
        void p.openPath(dir);
      }
      return null;
    });
    def('system.openOutput', async ({ jobId }) => {
      const job = this.jobs.get(jobId);
      if (job.state !== 'succeeded' || !job.outputPath) fail('CONFLICT', 'The export has not completed');
      if (!isFile(job.outputPath)) fail('MEDIA_MISSING', 'The exported file was moved or deleted', { detail: job.outputPath });
      const err = await p.openPath(job.outputPath);
      if (err) fail('IO', 'Could not open the file', { detail: err });
      return null;
    });
    def('system.exportDiagnostics', () => this.exportDiagnostics());
    def('system.listNotices', () => this.notices.slice(0, 100));

    // settings
    def('settings.get', () => this.settings.get());
    def('settings.update', (patch) => {
      for (const d of [patch.media?.libraryDirectory, patch.media?.exportDirectory]) {
        if (d) fs.mkdirSync(safeAbsolutePath(d), { recursive: true });
      }
      const next = this.settings.update(patch);
      if (patch.obs && (patch.obs.host !== undefined || patch.obs.port !== undefined) && this.obs.getState().connection.state !== 'disconnected') void this.connectObs();
      return next;
    });
    def('settings.setObsPassword', ({ password }) => {
      const next = this.settings.setObsPassword(password);
      if (this.obs.getState().connection.state !== 'connected') void this.connectObs();
      return next;
    });
    def('settings.getShortcutStatus', () => this.shortcuts.status());

    // obs
    def('obs.connect', () => this.connectObs());
    def('obs.disconnect', () => this.obs.disconnect());
    def('obs.getState', () => this.obs.getState());
    def('obs.setScene', ({ sceneName }) => this.obs.setScene(sceneName));
    def('obs.startRecording', () => this.obs.startRecording());
    def('obs.stopRecording', () => this.obs.stopRecording());
    def('obs.startReplayBuffer', () => this.obs.startReplayBuffer());
    def('obs.stopReplayBuffer', () => this.obs.stopReplayBuffer());
    def('obs.saveReplay', () => this.obs.saveReplay());
    def('obs.startStream', async () => {
      const st = await this.obs.startStream();
      this.notice('warning', 'You are live', 'Streaming started to the destination configured in OBS.');
      return st;
    });
    def('obs.stopStream', () => this.obs.stopStream());
    def('obs.getPreview', ({ width }) => this.obs.preview(width));

    // audio
    def('audio.list', () => this.audio.list());
    def('audio.setMute', ({ sourceId, muted }) => this.audio.setMute(sourceId, muted));
    def('audio.setVolume', ({ sourceId, volumeDb }) => this.audio.setVolume(sourceId, volumeDb));
    def('audio.setMeterSubscription', async ({ enabled }) => {
      await this.obs.setMeters(enabled);
      return null;
    });

    // profiles
    def('profiles.list', () => this.profiles.list());
    def('profiles.get', ({ id }) => this.profiles.get(id));
    def('profiles.validate', ({ profile }) => this.profiles.validate(profile));
    def('profiles.save', ({ profile }) => this.profiles.save(profile));
    def('profiles.duplicate', ({ id }) => this.profiles.duplicate(id));
    def('profiles.delete', ({ id }) => {
      const active = this.sessions.getActive();
      if (active?.profileId === id) fail('CONFLICT', 'This profile is in use by the active session');
      this.profiles.delete(id);
      return null;
    });

    // sessions
    def('sessions.preflight', ({ profileId }) => this.sessions.preflight(profileId));
    def('sessions.plan', ({ profileId }) => this.sessions.plan(profileId));
    def('sessions.start', ({ profileId }) => this.sessions.start(profileId));
    def('sessions.cancel', ({ id }) => this.sessions.cancel(id));
    def('sessions.end', ({ id }) => this.sessions.end(id));
    def('sessions.list', ({ limit }) => this.sessions.list(limit));
    def('sessions.get', ({ id }) => this.sessions.get(id));
    def('sessions.getActive', () => this.sessions.getActive());
    def('sessions.updateNotes', ({ id, notes }) => this.sessions.updateNotes(id, notes));

    // clips
    def('clips.list', (q) => this.library.list(q));
    def('clips.get', ({ id }) => this.library.get(id));
    def('clips.import', async ({ paths }) => {
      this.tools.requireFfprobe();
      return this.library.importMany(paths, { source: 'import' });
    });
    def('clips.update', ({ id, ...patch }) => this.library.update(id, patch));
    def('clips.relink', ({ id, path: file }) => this.library.relink(id, file));
    def('clips.verify', () => this.library.verifyAll());
    def('clips.remove', ({ id }) => {
      this.library.remove(id);
      return null;
    });
    def('clips.getWaveform', ({ id, resolution }) => this.library.waveform(id, resolution));
    def('clips.listGames', () => this.library.listGames());

    // projects
    def('projects.list', () => this.projects.list());
    def('projects.get', ({ id }) => this.projects.get(id));
    def('projects.createFromClip', ({ clipId, name }) => this.projects.createFromClip(clipId, name));
    def('projects.save', ({ project }) => this.projects.save(project));
    def('projects.delete', ({ id }) => {
      this.projects.delete(id);
      return null;
    });
    def('projects.applyPreset', ({ id, presetId }) => this.projects.applyPreset(id, presetId));

    // exports / jobs
    def('presets.list', () => EXPORT_PRESETS);
    def('exports.enqueue', (req) => {
      this.tools.requireFfmpeg();
      const project = this.projects.get(req.projectId);
      if (project.tracks[0]!.items.length === 0) fail('VALIDATION', 'The timeline is empty');
      const destinationDirectory = req.destinationDirectory ? safeAbsolutePath(req.destinationDirectory, 'Export folder') : this.defaultExportDir();
      if (fs.existsSync(destinationDirectory) && !isDirectory(destinationDirectory)) fail('VALIDATION', 'Export destination is not a folder');
      const payload: ExportJobPayload = { request: req, revision: project.revision, destinationDirectory };
      const existing = this.jobs.findActiveBySpec('export', payload);
      if (existing) return existing; // repeated click → same job
      return this.jobs.enqueue('export', `Export “${req.fileName}”`, payload, project.id);
    });
    def('jobs.list', () => this.jobs.list());
    def('jobs.cancel', ({ id }) => this.jobs.cancel(id));
    def('jobs.retry', ({ id }) => this.jobs.retry(id));
    def('jobs.clearFinished', () => {
      this.jobs.clearFinished();
      return null;
    });

    def('transcription.transcribeProject', ({ id }) => {
      const t = this.settings.get().transcription;
      if (!t.enabled || !t.whisperPath || !t.modelPath) throw new DriftFailure('UNSUPPORTED', 'Transcription is optional and not set up. Configure it in Settings → Transcription.');
      this.tools.requireFfmpeg();
      const project = this.projects.get(id);
      const payload = { projectId: id };
      return this.jobs.findActiveBySpec('transcription', payload) ?? this.jobs.enqueue('transcription', `Transcribe “${project.name}”`, payload, id);
    });

    const missing = (Object.keys(methods) as MethodName[]).filter((m) => !h[m]);
    if (missing.length) throw new Error(`Unimplemented methods: ${missing.join(', ')}`);
    return h as Handlers;
  }
}
