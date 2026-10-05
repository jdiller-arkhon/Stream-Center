import { createContext, useContext, useState, useSyncExternalStore, useCallback, type ReactNode } from 'react';
import type { ClipAsset, Operation, OperationMap, StudioService } from '../shared/contracts';
export type Route = 'Command Center' | 'ClipForge' | 'Sessions' | 'Stream Controls' | 'Audio' | 'Profiles' | 'Settings';
interface Context {
    service: StudioService;
    route: Route;
    navigate: (r: Route) => void;
    selectedClip: string | null;
    openClip: (c: ClipAsset) => void;
    notify: (message: string) => void;
    run: <K extends Operation>(op: K, input: OperationMap[K]['input']) => Promise<OperationMap[K]['output'] | undefined>;
    pending: Set<Operation>;
    media: Map<string, string>;
    registerMedia: (id: string, url: string) => void;
    toast: string | null;
    clearToast: () => void;
}
const StudioContext = createContext<Context | null>(null);
export function StudioProvider({ service, children }: {
    service: StudioService;
    children: ReactNode;
}) {
    const [route, setRoute] = useState<Route>('Command Center');
    const [selectedClip, setSelectedClip] = useState<string | null>(null);
    const [pending, setPending] = useState<Set<Operation>>(new Set());
    const [toast, setToast] = useState<string | null>(null);
    const [media] = useState(() => new Map<string, string>());
    const notify = useCallback((message: string) => setToast(message), []);
    const run = useCallback(async <K extends Operation>(op: K, input: OperationMap[K]['input']) => { setPending(x => new Set(x).add(op)); try {
        return await service.invoke(op, input);
    }
    catch (e) {
        notify(e instanceof Error ? e.message : 'Operation failed. Please retry.');
        return undefined;
    }
    finally {
        setPending(x => { const next = new Set(x); next.delete(op); return next; });
    } }, [service, notify]);
    return <StudioContext.Provider value={{ service, route, navigate: setRoute, selectedClip, openClip: c => { setSelectedClip(c.id); setRoute('ClipForge'); }, notify, run, pending, media, registerMedia: (id, url) => media.set(id, url), toast, clearToast: () => setToast(null) }}>{children}</StudioContext.Provider>;
}
export function useStudio() { const c = useContext(StudioContext); if (!c)
    throw new Error('StudioProvider required'); return c; }
export function useSnapshot() { const { service } = useStudio(); return useSyncExternalStore(service.subscribe, service.getSnapshot); }
