import path from 'node:path';
import { Settings, type SettingsPatch } from '../../shared/contracts';
import { defaultSettings } from '../../shared/defaults';
import { kvGet, kvSet, type Db } from '../core/database';
import { fail } from '../core/errors';
import { safeAbsolutePath } from '../core/paths';
import type { SecretStore } from '../core/platform';

const KEY = 'settings';
const OBS_PASSWORD = 'obs.password';

type Listener = (next: Settings, prev: Settings) => void;

export class SettingsService {
  private current: Settings;
  private readonly listeners = new Set<Listener>();
  /** Fallback when OS protected storage is unavailable: kept for this run only. */
  private volatilePassword: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
  ) {
    const stored = kvGet<unknown>(db, KEY);
    const merged = stored ? deepMerge(defaultSettings(), stored as Record<string, unknown>) : defaultSettings();
    const parsed = Settings.safeParse(merged);
    this.current = parsed.success ? parsed.data : defaultSettings();
    this.current.obs.passwordStored = this.obsPassword() !== null;
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  update(patch: SettingsPatch): Settings {
    for (const key of ['libraryDirectory', 'exportDirectory'] as const) {
      const v = patch.media?.[key];
      if (v) patch.media![key] = safeAbsolutePath(v, key);
    }
    // Tool paths are executed later, so only accept binaries with the expected names.
    for (const [key, pattern, label] of [
      ['ffmpegPath', /^ffmpeg(\.exe)?$/i, 'ffmpeg'],
      ['ffprobePath', /^ffprobe(\.exe)?$/i, 'ffprobe'],
    ] as const) {
      const v = patch.tools?.[key];
      if (!v) continue;
      patch.tools![key] = safeAbsolutePath(v, key);
      if (!pattern.test(path.basename(v))) fail('VALIDATION', `Choose the ${label} executable (${label}.exe)`);
    }
    const whisper = patch.transcription?.whisperPath;
    if (whisper) {
      patch.transcription!.whisperPath = safeAbsolutePath(whisper, 'whisperPath');
      if (!/^(whisper(-cli)?|main)(\.exe)?$/i.test(path.basename(whisper))) fail('VALIDATION', 'Choose the whisper.cpp executable (whisper-cli.exe)');
    }
    const model = patch.transcription?.modelPath;
    if (model) {
      patch.transcription!.modelPath = safeAbsolutePath(model, 'modelPath');
      if (!/\.(bin|gguf)$/i.test(model)) fail('VALIDATION', 'Choose a whisper.cpp model file (.bin)');
    }
    if (patch.shortcuts) {
      const seen = new Map<string, string>();
      for (const s of patch.shortcuts) {
        if (!s.enabled || !s.accelerator) continue;
        const norm = s.accelerator.toLowerCase();
        const other = seen.get(norm);
        if (other) fail('CONFLICT', `${s.accelerator} is assigned to both ${other} and ${s.action}`);
        seen.set(norm, s.action);
      }
    }
    const prev = this.current;
    const next = Settings.parse(deepMerge(structuredClone(prev), patch as Record<string, unknown>));
    next.obs.passwordStored = prev.obs.passwordStored;
    this.persist(next);
    for (const l of this.listeners) l(this.get(), prev);
    return this.get();
  }

  setObsPassword(password: string | null): Settings {
    const value = password && password.length ? password : null;
    if (this.secrets.available) this.secrets.set(OBS_PASSWORD, value);
    else this.volatilePassword = value;
    const prev = this.current;
    const next = structuredClone(prev);
    next.obs.passwordStored = value !== null;
    this.persist(next);
    for (const l of this.listeners) l(this.get(), prev);
    return this.get();
  }

  obsPassword(): string | null {
    return this.secrets.available ? this.secrets.get(OBS_PASSWORD) : this.volatilePassword;
  }

  private persist(next: Settings): void {
    this.current = next;
    const { passwordStored: _omit, ...obs } = next.obs;
    kvSet(this.db, KEY, { ...next, obs });
  }
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = (base as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      (base as Record<string, unknown>)[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      (base as Record<string, unknown>)[k] = v;
    }
  }
  return base;
}
