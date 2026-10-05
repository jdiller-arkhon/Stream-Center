/**
 * A small fake OBS implementing the obs-websocket v5 JSON protocol (Hello → Identify →
 * Identified, Request/RequestResponse, Event, Reidentify, auth challenge). It is a
 * contract-test double, not a substitute for testing against real OBS.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeObsOptions {
  password?: string | null;
  replayBufferAvailable?: boolean;
  /** Called on SaveReplayBuffer; must return the path of the "saved" file. */
  onSaveReplay?: () => string;
  replaySaveDelayMs?: number;
  /** Do not emit ReplayBufferSaved (simulates a lost event). */
  dropReplayEvent?: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('base64');

export class FakeObs {
  wss: WebSocketServer | null = null;
  port = 0;
  readonly requests: Array<{ type: string; data: unknown }> = [];
  scenes = ['Gameplay', 'BRB', 'Starting Soon'];
  currentScene = 'Gameplay';
  recording = false;
  replay = false;
  streaming = false;
  lastReplay: string | null = null;
  inputs: Record<string, { kind: string; muted: boolean; volumeDb: number; deviceId?: string }> = {
    'Mic/Aux': { kind: 'wasapi_input_capture', muted: false, volumeDb: 0, deviceId: '{mic-1}' },
    'Desktop Audio': { kind: 'wasapi_output_capture', muted: false, volumeDb: -3, deviceId: 'default' },
    'Game Capture': { kind: 'game_capture', muted: false, volumeDb: 0 },
  };
  private sockets = new Set<WebSocket>();

  constructor(private opts: FakeObsOptions = {}) {}

  async start(port = 0): Promise<number> {
    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => this.wss!.once('listening', () => r()));
    this.port = (this.wss.address() as { port: number }).port;
    this.wss.on('connection', (ws) => this.onConnection(ws));
    return this.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    this.sockets.clear();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.wss = null;
  }

  /** Broadcast an OBS event to identified clients. */
  emit(eventType: string, eventData: Record<string, unknown>): void {
    const msg = JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } });
    for (const s of this.sockets) s.send(msg);
  }

  /** Simulate the user pressing "Start Recording" inside OBS. */
  startRecordingFromObs(): void {
    this.recording = true;
    this.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputPath: null });
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    const salt = 'c2FsdA==';
    const challenge = 'Y2hhbGxlbmdl';
    const auth = this.opts.password ? { challenge, salt } : undefined;
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, ...(auth ? { authentication: auth } : {}) } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { op: number; d: Record<string, unknown> };
      if (msg.op === 1) {
        if (this.opts.password) {
          const expected = sha(sha(this.opts.password + salt) + challenge);
          if (msg.d.authentication !== expected) {
            ws.close(4009, 'Authentication failed.');
            return;
          }
        }
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      } else if (msg.op === 3) {
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      } else if (msg.op === 6) {
        const { requestType, requestId, requestData } = msg.d as { requestType: string; requestId: string; requestData?: Record<string, unknown> };
        this.requests.push({ type: requestType, data: requestData });
        let status = { result: true, code: 100 } as { result: boolean; code: number; comment?: string };
        let responseData: unknown;
        try {
          responseData = this.handle(requestType, requestData ?? {});
        } catch (err) {
          status = { result: false, code: (err as { code?: number }).code ?? 600, comment: (err as Error).message };
        }
        ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: status, ...(responseData ? { responseData } : {}) } }));
      }
    });
  }

  private handle(type: string, data: Record<string, unknown>): unknown {
    const err = (code: number, m: string) => Object.assign(new Error(m), { code });
    switch (type) {
      case 'GetVersion':
        return { obsVersion: '31.0.0', obsWebSocketVersion: '5.5.0', rpcVersion: 1, platform: 'windows', platformDescription: 'Windows 11' };
      case 'GetSceneList':
        return { currentProgramSceneName: this.currentScene, scenes: this.scenes.map((n, i) => ({ sceneName: n, sceneIndex: this.scenes.length - 1 - i })) };
      case 'SetCurrentProgramScene':
        if (!this.scenes.includes(String(data.sceneName))) throw err(600, 'No source was found');
        this.currentScene = String(data.sceneName);
        this.emit('CurrentProgramSceneChanged', { sceneName: this.currentScene });
        return undefined;
      case 'GetSceneItemList':
        return { sceneItems: [{ sourceName: 'Game Capture', inputKind: 'game_capture', sceneItemEnabled: true }] };
      case 'GetRecordStatus':
        return { outputActive: this.recording, outputPaused: false, outputDuration: this.recording ? 12_000 : 0, outputBytes: this.recording ? 1_000_000 : 0 };
      case 'GetRecordDirectory':
        return { recordDirectory: '/tmp' };
      case 'StartRecord':
        this.recording = true;
        setTimeout(() => this.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputPath: null }), 10);
        return undefined;
      case 'StopRecord':
        this.recording = false;
        return { outputPath: '/tmp/rec.mkv' };
      case 'GetReplayBufferStatus':
        if (this.opts.replayBufferAvailable === false) throw err(604, 'Replay buffer is not available.');
        return { outputActive: this.replay };
      case 'StartReplayBuffer':
        if (this.opts.replayBufferAvailable === false) throw err(604, 'Replay buffer is not available.');
        this.replay = true;
        setTimeout(() => this.emit('ReplayBufferStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' }), 10);
        return undefined;
      case 'StopReplayBuffer':
        this.replay = false;
        setTimeout(() => this.emit('ReplayBufferStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' }), 10);
        return undefined;
      case 'SaveReplayBuffer': {
        if (!this.replay) throw err(501, 'Replay buffer is not active.');
        const file = this.opts.onSaveReplay?.() ?? path.join('/tmp', 'Replay.mkv');
        this.lastReplay = file;
        if (!this.opts.dropReplayEvent) setTimeout(() => this.emit('ReplayBufferSaved', { savedReplayPath: file }), this.opts.replaySaveDelayMs ?? 50);
        return undefined;
      }
      case 'GetLastReplayBufferReplay':
        if (!this.lastReplay) throw err(604, 'No replay');
        return { savedReplayPath: this.lastReplay };
      case 'GetStreamStatus':
        return { outputActive: this.streaming, outputReconnecting: false, outputDuration: 0, outputSkippedFrames: 0, outputTotalFrames: 0 };
      case 'StartStream':
        this.streaming = true;
        return undefined;
      case 'StopStream':
        this.streaming = false;
        return undefined;
      case 'GetStats':
        return {
          cpuUsage: 3.2, memoryUsage: 512, availableDiskSpace: 100_000, activeFps: 60, averageFrameRenderTime: 1.4,
          renderSkippedFrames: 0, renderTotalFrames: 1000, outputSkippedFrames: 2, outputTotalFrames: 900,
        };
      case 'GetProfileParameter':
        if (data.parameterName === 'Mode') return { parameterValue: 'Simple', defaultParameterValue: 'Simple' };
        if (data.parameterName === 'RecRBTime') return { parameterValue: '30', defaultParameterValue: '20' };
        return { parameterValue: null, defaultParameterValue: null };
      case 'GetInputList':
        return { inputs: Object.entries(this.inputs).map(([n, i]) => ({ inputName: n, inputKind: i.kind, unversionedInputKind: i.kind })) };
      case 'GetSpecialInputs':
        return { desktop1: 'Desktop Audio', mic1: 'Mic/Aux' };
      case 'GetInputMute': {
        const i = this.inputs[String(data.inputName)];
        if (!i || i.kind === 'game_capture') throw err(604, 'The specified input does not support audio.');
        return { inputMuted: i.muted };
      }
      case 'SetInputMute': {
        const i = this.inputs[String(data.inputName)]!;
        i.muted = Boolean(data.inputMuted);
        this.emit('InputMuteStateChanged', { inputName: data.inputName, inputMuted: i.muted });
        return undefined;
      }
      case 'GetInputVolume': {
        const i = this.inputs[String(data.inputName)]!;
        return { inputVolumeDb: i.volumeDb, inputVolumeMul: 10 ** (i.volumeDb / 20) };
      }
      case 'SetInputVolume':
        this.inputs[String(data.inputName)]!.volumeDb = Number(data.inputVolumeDb);
        return undefined;
      case 'GetInputSettings':
        return { inputSettings: { device_id: this.inputs[String(data.inputName)]?.deviceId ?? 'default' }, inputKind: 'x' };
      case 'GetInputPropertiesListPropertyItems':
        return { propertyItems: [{ itemName: 'Default', itemValue: 'default', itemEnabled: true }, { itemName: 'Microphone (Shure MV7)', itemValue: '{mic-1}', itemEnabled: true }] };
      case 'GetSourceScreenshot':
        return { imageData: 'data:image/jpeg;base64,/9j/AAAA' };
      default:
        throw err(204, `Unknown request ${type}`);
    }
  }
}

export function writeFileSafe(p: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
