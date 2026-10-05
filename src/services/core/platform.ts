import type { PickPathRequest } from '../../shared/contracts';

/**
 * Everything the services need from the host (Electron in production, fakes in tests).
 * Keeping this narrow lets the whole service layer run under plain Node for tests.
 */
export interface Platform {
  readonly os: NodeJS.Platform;
  readonly appVersion: string;
  readonly dataDir: string;
  readonly logsDir: string;
  /** Opens an allow-listed launcher URI (steam://, com.epicgames.launcher://, ...). */
  openExternal(uri: string): Promise<void>;
  /** Opens a file with its default application. Returns an error string or ''. */
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  pickPath(req: PickPathRequest): Promise<string[]>;
  secrets: SecretStore;
  shortcuts: ShortcutHost | null;
}

export interface SecretStore {
  /** False when the OS cannot protect secrets (then passwords are kept in memory only). */
  readonly available: boolean;
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export interface ShortcutHost {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
  unregisterAll(): void;
}

/** Memory-only secret store used when OS protected storage is unavailable, and in tests. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  constructor(readonly available = false) {}
  get(key: string): string | null { return this.values.get(key) ?? null; }
  set(key: string, value: string | null): void {
    if (value === null) this.values.delete(key);
    else this.values.set(key, value);
  }
}
