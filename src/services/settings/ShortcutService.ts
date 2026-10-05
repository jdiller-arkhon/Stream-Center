import type { Shortcut, ShortcutAction, ShortcutStatus } from '../../shared/contracts';
import type { Logger } from '../core/logger';
import type { ShortcutHost } from '../core/platform';

/**
 * Registers only explicit, user-configured global shortcuts through the OS
 * (Electron globalShortcut). No keyboard hooks. Conflicts are reported, never forced.
 * Start the app with --safe-mode / DRIFT_SAFE_MODE=1 to skip registration entirely.
 */
export class ShortcutService {
  private registered = new Map<string, ShortcutAction>();
  private statuses: ShortcutStatus[] = [];

  constructor(
    private readonly host: ShortcutHost | null,
    private readonly log: Logger,
    private readonly onTrigger: (action: ShortcutAction) => void,
    private readonly safeMode: boolean,
  ) {}

  apply(shortcuts: Shortcut[]): ShortcutStatus[] {
    this.host?.unregisterAll();
    this.registered.clear();
    this.statuses = shortcuts.map((s): ShortcutStatus => {
      if (!s.enabled || !s.accelerator) return { action: s.action, accelerator: s.accelerator, registered: false, problem: s.enabled ? 'No key assigned' : null };
      if (s.scope === 'local') return { action: s.action, accelerator: s.accelerator, registered: true, problem: null };
      if (this.safeMode) return { action: s.action, accelerator: s.accelerator, registered: false, problem: 'Safe mode: global shortcuts are disabled for this run' };
      if (!this.host) return { action: s.action, accelerator: s.accelerator, registered: false, problem: 'Global shortcuts are not available' };
      let ok = false;
      try {
        ok = this.host.register(s.accelerator, () => this.onTrigger(s.action));
      } catch (err) {
        return { action: s.action, accelerator: s.accelerator, registered: false, problem: `Invalid shortcut: ${String(err)}` };
      }
      if (!ok) {
        this.log.warn('shortcut conflict', { action: s.action, accelerator: s.accelerator });
        return { action: s.action, accelerator: s.accelerator, registered: false, problem: 'Already in use by another application or by Windows' };
      }
      this.registered.set(s.accelerator, s.action);
      return { action: s.action, accelerator: s.accelerator, registered: true, problem: null };
    });
    return this.status();
  }

  status(): ShortcutStatus[] {
    return this.statuses.map((s) => ({ ...s }));
  }

  dispose(): void {
    this.host?.unregisterAll();
    this.registered.clear();
  }
}
