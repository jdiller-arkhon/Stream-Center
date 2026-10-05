import { EventEmitter } from 'node:events';
import type { EventName, EventPayload } from '../../shared/api';

/** Typed in-process bus. The main process forwards every event to renderer windows. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
    this.emitter.emit(event, payload);
    this.emitter.emit('*', event, payload);
  }

  on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void): () => void {
    this.emitter.on(event, handler as (p: unknown) => void);
    return () => this.emitter.off(event, handler as (p: unknown) => void);
  }

  onAny(handler: (event: EventName, payload: unknown) => void): () => void {
    this.emitter.on('*', handler);
    return () => this.emitter.off('*', handler);
  }
}
