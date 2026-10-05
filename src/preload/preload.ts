/**
 * Sandboxed preload. Exposes exactly the bridge specified in docs/frontend-handoff.md:
 *   window.drift = { apiVersion: 1, readState(), request(operation, input, requestId), onState(listener) }
 * No Node, no ipcRenderer, no arbitrary channels. Operations are allow-listed here and
 * validated again in the main process.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const CHANNELS = { readState: 'drift:readState', request: 'drift:request', state: 'drift:state' } as const;
const OPERATIONS = new Set([
  'connect', 'disconnect', 'selectProfile', 'saveProfile', 'prepareSession', 'startSession', 'endSession', 'launchGame',
  'recording', 'replay', 'saveReplay', 'scene', 'streaming', 'audio', 'importClips', 'updateClip', 'saveProject', 'export',
  'cancelJob', 'retryJob', 'openOutput', 'saveSettings', 'sessionNotes', 'importNative', 'relinkNative', 'pickMusic', 'setObsPassword',
  'scenario', 'reset',
]);

type Snapshot = { revision?: number } & Record<string, unknown>;
const listeners = new Set<(state: unknown) => void>();
let newest: Snapshot | null = null;

ipcRenderer.on(CHANNELS.state, (_e: IpcRendererEvent, snapshot: Snapshot) => {
  if (newest && typeof snapshot?.revision === 'number' && typeof newest.revision === 'number' && snapshot.revision < newest.revision) return;
  newest = snapshot;
  for (const l of listeners) {
    try {
      l(snapshot);
    } catch (err) {
      console.error('[drift] state listener failed', err);
    }
  }
});

function unwrap(r: { ok: boolean; data?: unknown; error?: { message?: string; code?: string } }): unknown {
  if (r && r.ok) return r.data;
  const err = new Error(r?.error?.message ?? 'Desktop service error');
  err.name = r?.error?.code ?? 'ServiceError';
  throw err;
}

contextBridge.exposeInMainWorld('drift', {
  apiVersion: 1,
  async readState() {
    const snap = unwrap(await ipcRenderer.invoke(CHANNELS.readState)) as Snapshot;
    // An event that arrived while reading is newer than the read; never go backwards.
    if (newest && typeof newest.revision === 'number' && typeof snap?.revision === 'number' && newest.revision > snap.revision) return newest;
    newest = snap;
    return snap;
  },
  async request(operation: string, input: unknown, requestId: string) {
    if (typeof operation !== 'string' || !OPERATIONS.has(operation)) throw new Error('Operation not allowlisted');
    return unwrap(await ipcRenderer.invoke(CHANNELS.request, { operation, input, requestId: String(requestId ?? '') }));
  },
  onState(listener: (state: unknown) => void) {
    if (typeof listener !== 'function') throw new Error('listener must be a function');
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
});
