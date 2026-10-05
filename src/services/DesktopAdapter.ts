import { ServiceError, type DesktopBridge, type Operation, type OperationMap, type StudioSnapshot, type StudioService } from '../shared/contracts';
import { validateRequest, validateResponse, validateSnapshot, assertCapability } from '../shared/validation';
export class DesktopAdapter implements StudioService {
    readonly mode = 'desktop' as const;
    private state: StudioSnapshot | null = null;
    private listeners = new Set<() => void>();
    private unsubscribe: (() => void) | null = null;
    private bridge: DesktopBridge;
    constructor(bridge: DesktopBridge) { if (bridge.apiVersion !== 1)
        throw new ServiceError({ code: 'VERSION_MISMATCH', message: 'Unsupported desktop bridge', recoverable: false, details: null }); this.bridge = bridge; }
    getSnapshot = () => { if (!this.state)
        throw new Error('DesktopAdapter not initialized'); return this.state; };
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private accept = (value: unknown) => { const state = validateSnapshot(value); if (state.mode !== 'desktop')
        throw new ServiceError({ code: 'INVALID_INPUT', message: 'Desktop bridge returned demo data', recoverable: false, details: null }); this.state = state; this.listeners.forEach(l => l()); };
    async initialize() { this.unsubscribe = this.bridge.onState(this.accept); try {
        this.accept(await this.bridge.readState());
    }
    catch (e) {
        this.unsubscribe();
        this.unsubscribe = null;
        throw e;
    } }
    async invoke<K extends Operation>(operation: K, input: OperationMap[K]['input']): Promise<OperationMap[K]['output']> { if (['reset', 'scenario'].includes(operation))
        throw new ServiceError({ code: 'UNAVAILABLE', message: 'Demo scenarios are disabled in desktop mode', recoverable: false, details: null }); validateRequest(operation, input); assertCapability(this.getSnapshot(), operation); const result = await this.bridge.request(operation, input, crypto.randomUUID()); return validateResponse(operation, result) as OperationMap[K]['output']; }
    dispose() { this.unsubscribe?.(); this.listeners.clear(); }
}
