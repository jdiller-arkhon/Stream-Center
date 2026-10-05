/**
 * Sandboxed preload. Exposes exactly one object, `window.driftDesktop`, with
 * allow-listed invoke/on. No Node, no ipcRenderer, no arbitrary channels.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CONTRACT_VERSION_FOR_PRELOAD, EVENT_ALLOWLIST, IPC_CHANNELS, METHOD_ALLOWLIST } from '../services/contract/channels';

const methods = new Set<string>(METHOD_ALLOWLIST);
const events = new Set<string>(EVENT_ALLOWLIST);
const listeners = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on(IPC_CHANNELS.event, (_e: IpcRendererEvent, msg: { event: string; payload: unknown }) => {
  const set = listeners.get(msg?.event);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(msg.payload);
    } catch (err) {
      console.error('[drift] event handler failed', err);
    }
  }
});

contextBridge.exposeInMainWorld('driftDesktop', {
  contractVersion: CONTRACT_VERSION_FOR_PRELOAD,
  invoke(method: string, input: unknown) {
    if (typeof method !== 'string' || !methods.has(method)) {
      return Promise.resolve({ ok: false, error: { code: 'VALIDATION', message: `Unknown operation ${String(method)}`, detail: null, retryable: false } });
    }
    return ipcRenderer.invoke(IPC_CHANNELS.invoke, { method, input: input ?? {} });
  },
  on(event: string, handler: (payload: unknown) => void) {
    if (typeof event !== 'string' || !events.has(event) || typeof handler !== 'function') throw new Error(`Unknown event ${String(event)}`);
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  },
});
