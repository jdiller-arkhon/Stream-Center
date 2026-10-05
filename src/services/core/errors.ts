import type { DriftError, ErrorCode } from '../../shared/contracts';

/** Exception carrying a contract-level DriftError. Thrown by services, mapped to Result at IPC boundary. */
export class DriftFailure extends Error {
  readonly code: ErrorCode;
  readonly detail: string | null;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { detail?: string | null; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'DriftFailure';
    this.code = code;
    this.detail = opts.detail ?? null;
    this.retryable = opts.retryable ?? false;
  }

  toError(): DriftError {
    return { code: this.code, message: this.message, detail: this.detail, retryable: this.retryable };
  }
}

export function fail(code: ErrorCode, message: string, opts?: { detail?: string | null; retryable?: boolean; cause?: unknown }): never {
  throw new DriftFailure(code, message, opts);
}

export function toDriftError(err: unknown): DriftError {
  if (err instanceof DriftFailure) return err.toError();
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message: 'Unexpected error', detail: message, retryable: false };
}
