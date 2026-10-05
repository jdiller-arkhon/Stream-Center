// Pin the JSON wire format (the package root resolves to msgpack under Node).
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js/json';
import type { AudioMeters, ConnectionStatus, DriftError, ObsPreview, ObsState, ObsStats } from '../../shared/contracts';
import { DriftFailure, fail } from '../core/errors';
import type { EventBus } from '../core/events';
import { newId, nowIso } from '../core/ids';
import type { Logger } from '../core/logger';

export interface ObsConfig {
  host: string;
  port: number;
  password: string | null;
}

/** Minimal surface of obs-websocket-js we depend on (lets tests inject a client). */
export interface ObsClient {
  connect(url: string, password?: string, identification?: { rpcVersion?: number; eventSubscriptions?: number }): Promise<unknown>;
  disconnect(): Promise<void>;
  reidentify(data: { eventSubscriptions?: number }): Promise<unknown>;
  call(requestType: string, requestData?: object): Promise<unknown>;
  on(event: string, handler: (data: never) => void): unknown;
  off(event: string, handler: (data: never) => void): unknown;
}

const AUTH_FAILED_CLOSE = 4009;
const BASE_SUBSCRIPTIONS = EventSubscription.All;
const METER_SUBSCRIPTIONS = EventSubscription.All | EventSubscription.InputVolumeMeters;
const POLL_MS = 2000;
const REPLAY_SAVE_TIMEOUT_MS = 30_000;

interface PendingSave {
  requestId: string;
  at: number;
  timer: NodeJS.Timeout;
}

type AnyRecord = Record<string, unknown>;

export interface ObsCallbacks {
  onReplaySaved(path: string, requestId: string | null): void;
  onRecordingStopped(path: string): void;
  onOutputEvent(kind: 'recording.started' | 'recording.stopped' | 'replay.started' | 'replay.stopped' | 'stream.started' | 'stream.stopped'): void;
  onInputsChanged(): void;
  onMeters(meters: AudioMeters): void;
  notice(level: 'info' | 'warning' | 'error' | 'success', title: string, message: string): void;
}

function emptyState(conn: ConnectionStatus): ObsState {
  return {
    connection: conn,
    version: null,
    currentScene: null,
    scenes: [],
    recording: { active: false, paused: false, durationMs: null, bytes: null, directory: null },
    replayBuffer: { available: false, active: false, unavailableReason: 'Not connected to OBS' },
    streaming: { active: false, reconnecting: false, durationMs: null, skippedFrames: null, totalFrames: null },
    stats: null,
    updatedAt: nowIso(),
  };
}

export const OBS_INPUT_ID_PREFIX = 'obs:';

export class ObsService {
  private client: ObsClient;
  private state: ObsState;
  private wanted = false;
  private config: ObsConfig | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private connecting: Promise<ConnectionStatus> | null = null;
  private connectingConfig: ObsConfig | null = null;
  private pendingSave: PendingSave | null = null;
  private recentSaves = new Map<string, number>();
  private metersEnabled = false;
  private lastMeterEmit = 0;
  private pollCount = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly cb: ObsCallbacks,
    clientFactory: () => ObsClient = () => new OBSWebSocket() as unknown as ObsClient,
  ) {
    this.client = clientFactory();
    this.state = emptyState(this.status('disconnected', 'Not connected. Configure OBS WebSocket in Settings.'));
    this.bindEvents();
  }

  // ---- public state -------------------------------------------------------

  getState(): ObsState {
    return structuredClone(this.state);
  }

  get connected(): boolean {
    return this.state.connection.state === 'connected';
  }

  // ---- connection ---------------------------------------------------------

  async connect(config: ObsConfig): Promise<ConnectionStatus> {
    const sameAs = (c: ObsConfig | null) => c !== null && c.host === config.host && c.port === config.port && c.password === config.password;
    const connectedWithSame = this.connected && sameAs(this.config);
    this.config = config;
    this.wanted = true;
    this.clearReconnect();
    this.attempt = 0;
    while (this.connecting) {
      if (sameAs(this.connectingConfig)) return this.connecting;
      await this.connecting.catch(() => {}); // settle the stale attempt, then retry with the new config
      this.clearReconnect();
      if (this.config !== config) return this.state.connection; // superseded by a newer call
    }
    if (this.connected) {
      if (connectedWithSame) return this.state.connection;
      // Mark as connecting first so the ConnectionClosed handler doesn't schedule a reconnect.
      this.setConnection(this.status('connecting', 'Applying new OBS connection settings'));
      await this.client.disconnect().catch(() => {});
    }
    return this.tryConnect();
  }

  async disconnect(): Promise<ConnectionStatus> {
    this.wanted = false;
    this.clearReconnect();
    this.stopPolling();
    await this.client.disconnect().catch(() => {});
    this.setConnection(this.status('disconnected', 'Disconnected by user'));
    return this.state.connection;
  }

  private tryConnect(): Promise<ConnectionStatus> {
    // One attempt at a time: concurrent connects on one client abort each other.
    if (this.connecting) return this.connecting;
    const cfg = this.config!;
    this.connectingConfig = cfg;
    const url = `ws://${cfg.host}:${cfg.port}`;
    this.setConnection(this.status(this.attempt > 0 ? 'reconnecting' : 'connecting', `Connecting to ${url}`));
    this.connecting = (async () => {
      try {
        await this.client.connect(url, cfg.password ?? undefined, {
          rpcVersion: 1,
          eventSubscriptions: this.metersEnabled ? METER_SUBSCRIPTIONS : BASE_SUBSCRIPTIONS,
        });
        this.attempt = 0;
        const conn = this.status('connected', null);
        conn.lastConnectedAt = nowIso();
        this.state.connection = conn;
        await this.refreshAll();
        this.startPolling();
        this.setConnection(conn);
        this.log.info('obs connected', { endpoint: url, obs: this.state.version?.obs });
        return conn;
      } catch (err) {
        this.stopPolling();
        await this.client.disconnect().catch(() => {});
        const code = (err as { code?: number }).code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code === AUTH_FAILED_CLOSE) {
          this.wanted = false;
          const e: DriftError = { code: 'OBS_AUTH_FAILED', message: 'OBS rejected the password', detail: msg, retryable: false };
          this.setConnection({ ...this.status('failed', 'Authentication failed. Check the OBS WebSocket password in Settings.'), error: e });
        } else {
          const e: DriftError = {
            code: 'OBS_NOT_CONNECTED',
            message: 'Could not reach OBS',
            detail: msg,
            retryable: true,
          };
          this.setConnection({
            ...this.status('failed', `OBS is not reachable at ${url}. Is OBS running with WebSocket server enabled (Tools → WebSocket Server Settings)?`),
            error: e,
          });
          this.scheduleReconnect();
        }
        return this.state.connection;
      } finally {
        this.connecting = null;
        this.connectingConfig = null;
      }
    })();
    return this.connecting;
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this.state.connection = { ...this.state.connection, state: 'reconnecting', retryInMs: delay };
    this.emitState();
    this.bus.emit('connection.changed', this.state.connection);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted && !this.connecting && !this.connected) void this.tryConnect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private status(state: ConnectionStatus['state'], detail: string | null): ConnectionStatus {
    return {
      service: 'obs',
      state,
      detail,
      endpoint: this.config ? `ws://${this.config.host}:${this.config.port}` : null,
      lastConnectedAt: this.state?.connection.lastConnectedAt ?? null,
      retryInMs: null,
      error: null,
    };
  }

  private setConnection(conn: ConnectionStatus): void {
    const wasConnected = this.connected;
    if (conn.state !== 'connected') {
      const fresh = emptyState(conn);
      fresh.replayBuffer.unavailableReason = conn.detail ?? 'Not connected to OBS';
      this.state = fresh;
    } else {
      this.state.connection = conn;
    }
    this.emitState();
    this.bus.emit('connection.changed', conn);
    if (wasConnected && conn.state !== 'connected') this.cb.notice('warning', 'OBS disconnected', conn.detail ?? 'Connection to OBS was lost');
  }

  // ---- events from OBS ----------------------------------------------------

  private bindEvents(): void {
    const c = this.client;
    c.on('ConnectionClosed', ((err: { code?: number; message?: string }) => {
      this.stopPolling();
      if (this.state.connection.state === 'connecting' || this.state.connection.state === 'reconnecting') return; // handled by connect()
      if (!this.wanted) return;
      if (err?.code === AUTH_FAILED_CLOSE) return;
      this.log.warn('obs connection closed', { code: err?.code });
      this.setConnection(this.status('reconnecting', 'Connection to OBS lost. Reconnecting…'));
      this.scheduleReconnect();
    }) as never);
    c.on('ExitStarted', (() => {
      this.cb.notice('info', 'OBS is closing', 'Drift Studio will reconnect when OBS starts again.');
    }) as never);
    c.on('CurrentProgramSceneChanged', ((d: AnyRecord) => {
      this.state.currentScene = String(d.sceneName);
      this.emitState();
    }) as never);
    c.on('SceneListChanged', ((d: { scenes: AnyRecord[] }) => {
      this.state.scenes = mapScenes(d.scenes);
      this.emitState();
    }) as never);
    c.on('RecordStateChanged', ((d: AnyRecord) => {
      const st = String(d.outputState);
      this.state.recording.active = Boolean(d.outputActive);
      if (st === 'OBS_WEBSOCKET_OUTPUT_PAUSED') this.state.recording.paused = true;
      if (st === 'OBS_WEBSOCKET_OUTPUT_RESUMED' || st === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.state.recording.paused = false;
      if (st === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.cb.onOutputEvent('recording.started');
      if (st === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
        this.state.recording.durationMs = null;
        this.cb.onOutputEvent('recording.stopped');
        if (typeof d.outputPath === 'string' && d.outputPath) this.cb.onRecordingStopped(d.outputPath);
      }
      this.emitState();
    }) as never);
    c.on('ReplayBufferStateChanged', ((d: AnyRecord) => {
      const st = String(d.outputState);
      this.state.replayBuffer.active = Boolean(d.outputActive);
      this.state.replayBuffer.available = true;
      this.state.replayBuffer.unavailableReason = null;
      if (st === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.cb.onOutputEvent('replay.started');
      if (st === 'OBS_WEBSOCKET_OUTPUT_STOPPED') this.cb.onOutputEvent('replay.stopped');
      this.emitState();
    }) as never);
    c.on('StreamStateChanged', ((d: AnyRecord) => {
      const st = String(d.outputState);
      this.state.streaming.active = Boolean(d.outputActive);
      this.state.streaming.reconnecting = st === 'OBS_WEBSOCKET_OUTPUT_RECONNECTING';
      if (st === 'OBS_WEBSOCKET_OUTPUT_STARTED') this.cb.onOutputEvent('stream.started');
      if (st === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
        this.cb.onOutputEvent('stream.stopped');
        this.state.streaming.durationMs = null;
      }
      this.emitState();
    }) as never);
    c.on('ReplayBufferSaved', ((d: AnyRecord) => {
      const path = String(d.savedReplayPath ?? '');
      if (path) this.handleReplaySaved(path);
    }) as never);
    const inputsChanged = () => this.cb.onInputsChanged();
    for (const ev of ['InputCreated', 'InputRemoved', 'InputNameChanged', 'InputMuteStateChanged', 'InputVolumeChanged', 'InputSettingsChanged']) {
      c.on(ev, inputsChanged as never);
    }
    c.on('InputVolumeMeters', ((d: { inputs: Array<{ inputName: string; inputLevelsMul: number[][] }> }) => {
      const now = Date.now();
      if (now - this.lastMeterEmit < 100) return; // ~10 Hz is plenty for UI meters
      this.lastMeterEmit = now;
      this.cb.onMeters({
        at: nowIso(),
        levels: (d.inputs ?? []).map((i) => ({
          sourceId: OBS_INPUT_ID_PREFIX + i.inputName,
          peakDb: (i.inputLevelsMul ?? []).map((ch) => toDb(ch[1] ?? 0)),
        })),
      });
    }) as never);
  }

  private handleReplaySaved(path: string): void {
    // De-duplicate (event + fallback lookup may both report the same file).
    const seen = this.recentSaves.get(path);
    if (seen && Date.now() - seen < 60_000) return;
    this.recentSaves.set(path, Date.now());
    let requestId: string | null = null;
    if (this.pendingSave) {
      requestId = this.pendingSave.requestId;
      clearTimeout(this.pendingSave.timer);
      this.pendingSave = null;
    }
    this.bus.emit('replay.saved', { path, requestId, savedAt: nowIso() });
    this.cb.onReplaySaved(path, requestId);
  }

  // ---- polling ------------------------------------------------------------

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    if (!this.connected) return;
    this.pollCount++;
    try {
      await Promise.all([this.refreshStats(), this.refreshRecord(), this.refreshStream(), this.pollCount % 5 === 0 ? this.refreshReplay() : null]);
      this.state.updatedAt = nowIso();
      this.emitState();
    } catch (err) {
      this.log.debug('obs poll failed', { error: String(err) });
    }
  }

  private async refreshAll(): Promise<void> {
    const v = (await this.req('GetVersion')) as AnyRecord;
    this.state.version = { obs: String(v.obsVersion), websocket: String(v.obsWebSocketVersion), platform: String(v.platformDescription ?? v.platform ?? '') };
    await Promise.all([this.refreshScenes(), this.refreshRecord(), this.refreshReplay(), this.refreshStream(), this.refreshStats()]);
    try {
      const d = (await this.req('GetRecordDirectory')) as AnyRecord;
      this.state.recording.directory = String(d.recordDirectory ?? '') || null;
    } catch {
      this.state.recording.directory = null;
    }
    this.state.updatedAt = nowIso();
  }

  private async refreshScenes(): Promise<void> {
    const d = (await this.req('GetSceneList')) as AnyRecord;
    this.state.currentScene = (d.currentProgramSceneName as string) ?? null;
    this.state.scenes = mapScenes(d.scenes as AnyRecord[]);
  }

  private async refreshRecord(): Promise<void> {
    const d = (await this.req('GetRecordStatus')) as AnyRecord;
    this.state.recording.active = Boolean(d.outputActive);
    this.state.recording.paused = Boolean(d.outputPaused);
    this.state.recording.durationMs = d.outputActive ? Number(d.outputDuration ?? 0) : null;
    this.state.recording.bytes = d.outputActive ? Number(d.outputBytes ?? 0) : null;
  }

  private async refreshReplay(): Promise<void> {
    try {
      const d = (await this.req('GetReplayBufferStatus')) as AnyRecord;
      this.state.replayBuffer = { available: true, active: Boolean(d.outputActive), unavailableReason: null };
    } catch (err) {
      this.state.replayBuffer = {
        available: false,
        active: false,
        unavailableReason: 'Replay buffer is not enabled in OBS. Enable it in OBS → Settings → Output → Replay Buffer.',
      };
      this.log.debug('replay buffer unavailable', { detail: String(err) });
    }
  }

  private async refreshStream(): Promise<void> {
    const d = (await this.req('GetStreamStatus')) as AnyRecord;
    this.state.streaming = {
      active: Boolean(d.outputActive),
      reconnecting: Boolean(d.outputReconnecting),
      durationMs: d.outputActive ? Number(d.outputDuration ?? 0) : null,
      skippedFrames: d.outputActive ? Number(d.outputSkippedFrames ?? 0) : null,
      totalFrames: d.outputActive ? Number(d.outputTotalFrames ?? 0) : null,
    };
  }

  private async refreshStats(): Promise<void> {
    const d = (await this.req('GetStats')) as AnyRecord;
    const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
    const stats: ObsStats = {
      activeFps: num('activeFps'),
      averageFrameRenderMs: num('averageFrameRenderTime'),
      renderSkippedFrames: num('renderSkippedFrames'),
      renderTotalFrames: num('renderTotalFrames'),
      outputSkippedFrames: num('outputSkippedFrames'),
      outputTotalFrames: num('outputTotalFrames'),
      cpuUsagePercent: num('cpuUsage'),
      memoryMb: num('memoryUsage'),
      availableDiskMb: num('availableDiskSpace'),
    };
    this.state.stats = stats;
  }

  private emitState(): void {
    this.state.updatedAt = nowIso();
    this.bus.emit('obs.state', this.getState());
  }

  // ---- requests -----------------------------------------------------------

  /** Raw request. Callers must already have checked that OBS is connected. */
  async req(type: string, data?: object): Promise<unknown> {
    try {
      return await this.client.call(type, data);
    } catch (err) {
      const code = (err as { code?: number }).code;
      throw new DriftFailure('OBS_REQUEST_FAILED', `OBS could not complete ${type}`, { detail: `${code ?? ''} ${err instanceof Error ? err.message : String(err)}`.trim(), retryable: true });
    }
  }

  private requireConnected(): void {
    if (!this.connected) fail('OBS_NOT_CONNECTED', 'OBS is not connected', { detail: this.state.connection.detail, retryable: true });
  }

  async setScene(sceneName: string): Promise<ObsState> {
    this.requireConnected();
    if (!this.state.scenes.some((s) => s.name === sceneName)) fail('NOT_FOUND', `Scene "${sceneName}" does not exist in OBS`);
    await this.req('SetCurrentProgramScene', { sceneName });
    this.state.currentScene = sceneName;
    this.emitState();
    return this.getState();
  }

  async startRecording(): Promise<ObsState> {
    this.requireConnected();
    await this.refreshRecord();
    if (!this.state.recording.active) await this.req('StartRecord');
    await this.refreshRecord().catch(() => {});
    this.emitState();
    return this.getState();
  }

  async stopRecording(): Promise<ObsState> {
    this.requireConnected();
    await this.refreshRecord();
    if (this.state.recording.active) await this.req('StopRecord');
    this.emitState();
    return this.getState();
  }

  async startReplayBuffer(): Promise<ObsState> {
    this.requireConnected();
    await this.refreshReplay();
    if (!this.state.replayBuffer.available) fail('REPLAY_BUFFER_UNAVAILABLE', this.state.replayBuffer.unavailableReason ?? 'Replay buffer unavailable');
    if (!this.state.replayBuffer.active) await this.req('StartReplayBuffer');
    await this.refreshReplay();
    this.emitState();
    return this.getState();
  }

  async stopReplayBuffer(): Promise<ObsState> {
    this.requireConnected();
    await this.refreshReplay();
    if (this.state.replayBuffer.active) await this.req('StopReplayBuffer');
    await this.refreshReplay();
    this.emitState();
    return this.getState();
  }

  /**
   * Asks OBS to save the replay buffer. Resolves when OBS has accepted the request.
   * The file arrives asynchronously via the ReplayBufferSaved event. Rapid repeat
   * presses while a save is pending return the same request.
   */
  async saveReplay(): Promise<{ requestId: string; acceptedAt: string }> {
    this.requireConnected();
    if (this.pendingSave && Date.now() - this.pendingSave.at < 1500) {
      return { requestId: this.pendingSave.requestId, acceptedAt: new Date(this.pendingSave.at).toISOString() };
    }
    if (!this.state.replayBuffer.available) fail('REPLAY_BUFFER_UNAVAILABLE', this.state.replayBuffer.unavailableReason ?? 'Replay buffer unavailable');
    if (!this.state.replayBuffer.active) fail('REPLAY_BUFFER_UNAVAILABLE', 'The replay buffer is not running. Start it before saving a replay.', { retryable: true });
    const requestId = newId('save');
    await this.req('SaveReplayBuffer');
    const at = Date.now();
    if (this.pendingSave) clearTimeout(this.pendingSave.timer);
    const timer = setTimeout(() => void this.onSaveTimeout(requestId), REPLAY_SAVE_TIMEOUT_MS);
    this.pendingSave = { requestId, at, timer };
    return { requestId, acceptedAt: new Date(at).toISOString() };
  }

  private async onSaveTimeout(requestId: string): Promise<void> {
    if (this.pendingSave?.requestId !== requestId) return;
    // Event may have been missed (e.g. brief disconnect). Ask OBS for the last replay.
    try {
      const d = (await this.req('GetLastReplayBufferReplay')) as AnyRecord;
      const p = String(d.savedReplayPath ?? '');
      if (p && !this.recentSaves.has(p)) {
        this.handleReplaySaved(p);
        return;
      }
    } catch {
      /* fall through */
    }
    if (this.pendingSave?.requestId === requestId) this.pendingSave = null;
    this.cb.notice('warning', 'Replay not confirmed', 'OBS accepted the save request but did not report a saved file. Check OBS for errors.');
  }

  async startStream(): Promise<ObsState> {
    this.requireConnected();
    await this.refreshStream();
    if (!this.state.streaming.active) await this.req('StartStream');
    this.emitState();
    return this.getState();
  }

  async stopStream(): Promise<ObsState> {
    this.requireConnected();
    await this.refreshStream();
    if (this.state.streaming.active) await this.req('StopStream');
    this.emitState();
    return this.getState();
  }

  async preview(width: number): Promise<ObsPreview> {
    this.requireConnected();
    const scene = this.state.currentScene ?? fail('NOT_FOUND', 'OBS has no active program scene');
    const d = (await this.req('GetSourceScreenshot', { sourceName: scene, imageFormat: 'jpg', imageWidth: width, imageCompressionQuality: 70 })) as AnyRecord;
    return { sceneName: scene, imageDataUrl: String(d.imageData), width, capturedAt: nowIso() };
  }

  /** Reads the configured replay buffer length from OBS profile parameters, when exposed. */
  async replayBufferSeconds(): Promise<number | null> {
    if (!this.connected) return null;
    try {
      const mode = (await this.req('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })) as AnyRecord;
      const category = String(mode.parameterValue ?? '') === 'Advanced' ? 'AdvOut' : 'SimpleOutput';
      const d = (await this.req('GetProfileParameter', { parameterCategory: category, parameterName: 'RecRBTime' })) as AnyRecord;
      const v = Number(d.parameterValue ?? d.defaultParameterValue);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  async setMeters(enabled: boolean): Promise<void> {
    if (this.metersEnabled === enabled) return;
    this.metersEnabled = enabled;
    if (this.connected) await this.client.reidentify({ eventSubscriptions: enabled ? METER_SUBSCRIPTIONS : BASE_SUBSCRIPTIONS }).catch(() => {});
  }

  dispose(): void {
    this.wanted = false;
    this.clearReconnect();
    this.stopPolling();
    if (this.pendingSave) clearTimeout(this.pendingSave.timer);
    void this.client.disconnect().catch(() => {});
  }
}

function mapScenes(scenes: AnyRecord[] | undefined): Array<{ name: string; index: number }> {
  // OBS returns scenes bottom-to-top; present them in the order shown in OBS's UI.
  return (scenes ?? [])
    .map((s) => ({ name: String(s.sceneName), index: Number(s.sceneIndex ?? 0) }))
    .sort((a, b) => b.index - a.index);
}

export function toDb(mul: number): number {
  if (!(mul > 0)) return -100;
  return Math.max(-100, Math.round(20 * Math.log10(mul) * 10) / 10);
}
