/**
 * DesktopAdapter: the production DriftClient, talking to Electron through the
 * preload bridge (`window.driftDesktop`). Renderer code should depend only on the
 * DriftClient interface so the DemoAdapter can be swapped in for browser previews.
 *
 * It never falls back to demo data: if the bridge is missing it throws, and every
 * service failure is returned as a structured `{ ok: false, error }`.
 */
import { events, methods, type DriftClient, type DriftDesktopBridge, type EventName, type EventPayload, type MethodInput, type MethodName, type MethodOutput } from '../api';
import { CONTRACT_VERSION, type DriftError, type Result } from '../contracts';

declare global {
  interface Window {
    driftDesktop?: DriftDesktopBridge;
  }
}

export function getDesktopBridge(): DriftDesktopBridge | null {
  return typeof window !== 'undefined' && window.driftDesktop ? window.driftDesktop : null;
}

export class DesktopAdapter implements DriftClient {
  readonly mode = 'desktop' as const;
  private readonly bridge: DriftDesktopBridge;
  /** Validate responses against the contract (enable in development and tests). */
  private readonly validate: boolean;

  constructor(opts: { bridge?: DriftDesktopBridge; validateResponses?: boolean } = {}) {
    const bridge = opts.bridge ?? getDesktopBridge();
    if (!bridge) throw new Error('Drift Studio desktop bridge is not available. Use the DemoAdapter for browser previews.');
    const [major] = bridge.contractVersion.split('.');
    if (major !== CONTRACT_VERSION.split('.')[0]) {
      throw new Error(`Contract mismatch: desktop ${bridge.contractVersion}, renderer ${CONTRACT_VERSION}`);
    }
    this.bridge = bridge;
    this.validate = opts.validateResponses ?? false;
  }

  async invoke<M extends MethodName>(method: M, input: MethodInput<M>): Promise<Result<MethodOutput<M>>> {
    let res: Result<unknown>;
    try {
      res = await this.bridge.invoke(method, input);
    } catch (err) {
      return { ok: false, error: { code: 'INTERNAL', message: 'Lost contact with desktop services', detail: String(err), retryable: true } };
    }
    if (res.ok && this.validate) {
      const parsed = methods[method].output.safeParse(res.data);
      if (!parsed.success) {
        return { ok: false, error: { code: 'INTERNAL', message: `Response for ${method} did not match the contract`, detail: parsed.error.message, retryable: false } };
      }
    }
    return res as Result<MethodOutput<M>>;
  }

  on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void): () => void {
    return this.bridge.on(event, (payload) => {
      if (this.validate) {
        const parsed = events[event].safeParse(payload);
        if (!parsed.success) {
          console.error(`[drift] event ${event} did not match the contract`, parsed.error);
          return;
        }
      }
      handler(payload as EventPayload<E>);
    });
  }
}

/** Error thrown by `call()` so UI code can use try/catch while keeping the structured error. */
export class DriftClientError extends Error {
  constructor(readonly error: DriftError) {
    super(error.message);
    this.name = 'DriftClientError';
  }
}

/** Convenience: invoke and unwrap, throwing DriftClientError on failure. */
export async function call<M extends MethodName>(client: DriftClient, method: M, input: MethodInput<M>): Promise<MethodOutput<M>> {
  const r = await client.invoke(method, input);
  if (!r.ok) throw new DriftClientError(r.error);
  return r.data;
}
