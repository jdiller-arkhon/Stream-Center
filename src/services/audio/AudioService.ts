import type { AudioSource } from '../../shared/contracts';
import { fail } from '../core/errors';
import type { EventBus } from '../core/events';
import type { Logger } from '../core/logger';
import { run } from '../core/proc';
import { OBS_INPUT_ID_PREFIX, type ObsService } from '../obs/ObsService';

type AnyRecord = Record<string, unknown>;

const WIN_DEVICE_PREFIX = 'win:';
const MIC_KINDS = /input_capture|coreaudio_input|pulse_input|alsa_input/;
const DEVICE_SETTING_KINDS = /wasapi_(input|output)_capture|coreaudio_(input|output)|pulse_(input|output)_capture/;

/**
 * Two clearly separated audio domains:
 *  - OBS inputs (mute/volume/meters via obs-websocket) — controllable.
 *  - Windows endpoints (names/status via PnP) — listed read-only; Drift Studio does
 *    not change Windows device volume or routing.
 */
export class AudioService {
  private windowsCache: { at: number; items: AudioSource[] } | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly obs: ObsService,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly platform: NodeJS.Platform,
    private readonly micInputName: () => string | null,
  ) {}

  async list(): Promise<AudioSource[]> {
    const [obsInputs, win] = await Promise.all([this.listObsInputs(), this.listWindowsDevices()]);
    return [...obsInputs, ...win];
  }

  /** Debounced change notification (OBS fires bursts of input events). */
  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      try {
        this.bus.emit('audio.changed', await this.list());
      } catch (err) {
        this.log.debug('audio refresh failed', { error: String(err) });
      }
    }, 300);
  }

  async listObsInputs(): Promise<AudioSource[]> {
    if (!this.obs.connected) return [];
    const list = (await this.obs.req('GetInputList')) as { inputs: AnyRecord[] };
    let special: AnyRecord = {};
    try {
      special = (await this.obs.req('GetSpecialInputs')) as AnyRecord;
    } catch {
      /* optional */
    }
    const micNames = new Set(['mic1', 'mic2', 'mic3', 'mic4'].map((k) => special[k]).filter((v): v is string => typeof v === 'string'));
    const configuredMic = this.micInputName();
    const out: AudioSource[] = [];
    for (const input of list.inputs ?? []) {
      const name = String(input.inputName);
      const kind = String(input.unversionedInputKind ?? input.inputKind ?? 'unknown');
      let muted: boolean;
      try {
        muted = Boolean(((await this.obs.req('GetInputMute', { inputName: name })) as AnyRecord).inputMuted);
      } catch {
        continue; // not an audio-capable input
      }
      let volumeDb: number | null = null;
      try {
        const v = (await this.obs.req('GetInputVolume', { inputName: name })) as AnyRecord;
        volumeDb = typeof v.inputVolumeDb === 'number' ? Math.max(-100, v.inputVolumeDb) : null;
      } catch {
        /* keep null */
      }
      const isMic = configuredMic ? configuredMic === name : micNames.has(name) || MIC_KINDS.test(kind);
      out.push({
        id: OBS_INPUT_ID_PREFIX + name,
        origin: 'obs-input',
        name,
        kind,
        deviceName: DEVICE_SETTING_KINDS.test(kind) ? await this.deviceNameFor(name) : null,
        muted,
        volumeDb,
        isMicrophone: isMic,
        controls: { mute: true, volume: true },
        note: isMic ? 'A moving meter shows signal on this OBS input; check the device name to confirm it is the right microphone.' : null,
      });
    }
    return out;
  }

  /** Resolves the human readable device behind an OBS audio capture input. */
  private async deviceNameFor(inputName: string): Promise<string | null> {
    try {
      const s = (await this.obs.req('GetInputSettings', { inputName })) as { inputSettings: AnyRecord };
      const id = String(s.inputSettings?.device_id ?? 'default');
      const items = (await this.obs.req('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'device_id' })) as {
        propertyItems: Array<{ itemName: string; itemValue: unknown }>;
      };
      const hit = items.propertyItems?.find((i) => String(i.itemValue) === id);
      if (hit) return hit.itemName;
      return id === 'default' ? 'System default device' : null;
    } catch {
      return null;
    }
  }

  async setMute(sourceId: string, muted: boolean): Promise<AudioSource> {
    const name = this.obsName(sourceId);
    await this.obs.req('SetInputMute', { inputName: name, inputMuted: muted });
    return this.find(sourceId);
  }

  async setVolume(sourceId: string, volumeDb: number): Promise<AudioSource> {
    const name = this.obsName(sourceId);
    await this.obs.req('SetInputVolume', { inputName: name, inputVolumeDb: Math.max(-100, Math.min(26, volumeDb)) });
    return this.find(sourceId);
  }

  async toggleMicMute(): Promise<AudioSource | null> {
    const mic = (await this.listObsInputs()).find((s) => s.isMicrophone);
    if (!mic) return null;
    return this.setMute(mic.id, !mic.muted);
  }

  private obsName(sourceId: string): string {
    if (sourceId.startsWith(WIN_DEVICE_PREFIX)) fail('UNSUPPORTED', 'Windows device volume and mute are not controlled by Drift Studio. Use the Windows sound settings or the OBS input.');
    if (!sourceId.startsWith(OBS_INPUT_ID_PREFIX)) fail('NOT_FOUND', 'Unknown audio source');
    if (!this.obs.connected) fail('OBS_NOT_CONNECTED', 'Connect to OBS to control its audio inputs', { retryable: true });
    return sourceId.slice(OBS_INPUT_ID_PREFIX.length);
  }

  private async find(sourceId: string): Promise<AudioSource> {
    const s = (await this.listObsInputs()).find((x) => x.id === sourceId);
    return s ?? fail('NOT_FOUND', 'Audio source no longer exists');
  }

  async listWindowsDevices(): Promise<AudioSource[]> {
    if (this.platform !== 'win32') return [];
    if (this.windowsCache && Date.now() - this.windowsCache.at < 15_000) return this.windowsCache.items;
    try {
      const script =
        "Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue | Select-Object FriendlyName,Status,InstanceId | ConvertTo-Json -Compress";
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 10_000 });
      if (r.code !== 0 || !r.stdout.trim()) return [];
      const parsed = JSON.parse(r.stdout) as AnyRecord | AnyRecord[];
      const items = (Array.isArray(parsed) ? parsed : [parsed]).map((d): AudioSource => {
        const instance = String(d.InstanceId ?? '');
        // MMDEVAPI\{0.0.1.00000000}... => capture endpoints use {0.0.1.*}, render {0.0.0.*}
        const capture = /\{0\.0\.1\./.test(instance);
        return {
          id: WIN_DEVICE_PREFIX + instance,
          origin: 'windows-device',
          name: String(d.FriendlyName ?? 'Audio device'),
          kind: capture ? 'capture' : 'render',
          deviceName: String(d.FriendlyName ?? ''),
          muted: null,
          volumeDb: null,
          isMicrophone: capture,
          controls: { mute: false, volume: false },
          note: `Status: ${String(d.Status ?? 'unknown')}. Listed for identification only — Windows device volume/mute is not controlled by Drift Studio.`,
        };
      });
      this.windowsCache = { at: Date.now(), items };
      return items;
    } catch (err) {
      this.log.debug('windows audio enumeration failed', { error: String(err) });
      return [];
    }
  }
}
