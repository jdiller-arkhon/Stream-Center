import { ServiceError, type Operation, type OperationMap, type StudioService, type StudioSnapshot, type Job, type Session, type ClipAsset } from '../shared/contracts';
import { validateRequest, validateSnapshot, validateProfile, assertCapability } from '../shared/validation';
import { makeFixtures, now, uid } from './fixtures';
const KEY = 'drift-studio.demo.v1';
export class DemoAdapter implements StudioService {
    readonly mode = 'demo' as const;
    private state = makeFixtures();
    private listeners = new Set<() => void>();
    private busy = new Set<string>();
    private generation = 0;
    private timers = new Map<string, ReturnType<typeof setInterval>>();
    private disposed = false;
    constructor() { try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
            const saved = validateSnapshot(JSON.parse(raw));
            if (saved.mode === 'demo') {
                saved.obs = { ...saved.obs, connection: 'disconnected', recording: false, replayBuffer: false, streaming: false };
                saved.activeSessionId = null;
                saved.jobs = saved.jobs.map(j => ['accepted', 'processing'].includes(j.status) ? { ...j, status: 'failed', error: { code: 'IO_ERROR', message: 'Demo closed during simulation. Retry to resume.', recoverable: true, details: null } } : j);
                saved.clips = saved.clips.map(c => c.fixture ? c : { ...c, status: 'missing', mediaHandle: null });
                this.state = saved;
            }
        }
    }
    catch {
        this.state.warnings.push('Demo cache could not be restored. Defaults loaded.');
    } }
    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    async initialize() { }
    private publish(next: StudioSnapshot) { if (this.disposed)
        return; this.state = next; try {
        localStorage.setItem(KEY, JSON.stringify(next));
    }
    catch {
        this.state = { ...next, warnings: [...next.warnings, 'Browser storage is full; this change is not persisted.'] };
    } this.listeners.forEach(l => l()); }
    private fail(code: 'UNAVAILABLE' | 'DISCONNECTED' | 'NOT_FOUND' | 'BUSY' | 'IO_ERROR', message: string): never { throw new ServiceError({ code, message, recoverable: true, details: null }); }
    private connected() { if (this.state.obs.connection !== 'connected')
        this.fail('DISCONNECTED', 'Connect the demo OBS service first.'); }
    private event(message: string) { const active = this.state.activeSessionId; if (!active)
        return; this.publish({ ...this.state, sessions: this.state.sessions.map(s => s.id === active ? { ...s, events: [...s.events, { id: uid(), at: now(), message }] } : s) }); }
    async invoke<K extends Operation>(operation: K, input: OperationMap[K]['input']): Promise<OperationMap[K]['output']> {
        validateRequest(operation, input);
        assertCapability(this.state, operation);
        const key = operation + (input && typeof input === 'object' && 'id' in input ? String(input.id) : '');
        if (this.busy.has(key))
            this.fail('BUSY', 'This action is already pending.');
        this.busy.add(key);
        const generation = this.generation;
        const p = input as never;
        try {
            const obsActions = ['recording', 'replay', 'saveReplay', 'scene', 'streaming', 'audio'];
            if (obsActions.includes(operation))
                this.connected();
            if (operation === 'connect')
                this.publish({ ...this.state, obs: { ...this.state.obs, connection: 'connecting' } });
            await new Promise<void>(resolve => setTimeout(resolve, ['connect', 'prepareSession', 'startSession', 'saveReplay'].includes(operation) ? 550 : 80));
            if (this.disposed || generation !== this.generation)
                throw new ServiceError({ code: 'CANCELED', message: 'Operation canceled by reset.', recoverable: true, details: null });
            let result: unknown;
            switch (operation) {
                case 'connect':
                    this.publish({ ...this.state, obs: { ...this.state.obs, connection: (input as OperationMap['connect']['input']).host === 'fail' ? 'failed' : 'connected' } });
                    if (this.state.obs.connection === 'failed')
                        this.fail('IO_ERROR', 'Demo connection failure. Change host from “fail” to retry.');
                    break;
                case 'disconnect':
                    this.publish({ ...this.state, obs: { ...this.state.obs, connection: 'disconnected', recording: false, replayBuffer: false, streaming: false } });
                    break;
                case 'selectProfile': {
                    const { id } = p as OperationMap['selectProfile']['input'];
                    if (!this.state.profiles.some(x => x.id === id))
                        this.fail('NOT_FOUND', 'Profile not found');
                    this.publish({ ...this.state, selectedProfileId: id });
                    break;
                }
                case 'saveProfile': {
                    const profile = p as OperationMap['saveProfile']['input'];
                    const conflict = this.state.profiles.find(x => x.id !== profile.id && x.hotkey === profile.hotkey && profile.hotkey);
                    if (conflict)
                        this.fail('IO_ERROR', `Shortcut is already assigned to ${conflict.name}.`);
                    this.publish({ ...this.state, profiles: [...this.state.profiles.filter(x => x.id !== profile.id), profile] });
                    break;
                }
                case 'prepareSession':
                case 'startSession':
                case 'launchGame': {
                    const { profileId } = p as {
                        profileId: string;
                    };
                    const profile = this.state.profiles.find(x => x.id === profileId);
                    if (!profile)
                        this.fail('NOT_FOUND', 'Profile not found');
                    validateProfile(profile);
                    const steps = [{ label: 'OBS connection', ok: this.state.obs.connection === 'connected', detail: 'Demo OBS service' }, { label: 'Capture source', ok: this.state.obs.sources.includes('Game Capture'), detail: 'Game Capture · simulated' }, { label: 'Recording folder', ok: !this.state.warnings.includes('Insufficient storage'), detail: profile.destination }, { label: 'Microphone identity', ok: true, detail: 'Demo USB microphone · signal unavailable' }];
                    if (operation === 'prepareSession') {
                        result = { steps };
                        break;
                    }
                    if (steps.some(x => !x.ok))
                        this.fail('IO_ERROR', 'Preflight did not pass. Connect OBS and check storage.');
                    if (operation === 'launchGame') {
                        this.event('Game launch simulated');
                        break;
                    }
                    if (this.state.activeSessionId)
                        this.fail('BUSY', 'A session is already active. End it before starting another.');
                    const session: Session = { id: uid(), profileId, name: profile.name, startedAt: now(), endedAt: null, notes: '', clipIds: [], events: [{ id: uid(), at: now(), message: 'Profile prepared. Game launch simulated; no process started.' }] };
                    this.publish({ ...this.state, activeSessionId: session.id, sessions: [session, ...this.state.sessions], obs: { ...this.state.obs, scene: profile.scene, replayBuffer: true } });
                    result = session;
                    break;
                }
                case 'endSession':
                    this.publish({ ...this.state, sessions: this.state.sessions.map(s => s.id === this.state.activeSessionId ? { ...s, endedAt: now() } : s), activeSessionId: null });
                    break;
                case 'recording': {
                    const { enabled } = p as {
                        enabled: boolean;
                    };
                    this.publish({ ...this.state, obs: { ...this.state.obs, recording: enabled } });
                    this.event(enabled ? 'Recording started · simulated' : 'Recording stopped · simulated');
                    break;
                }
                case 'replay': {
                    const { enabled } = p as {
                        enabled: boolean;
                    };
                    this.publish({ ...this.state, obs: { ...this.state.obs, replayBuffer: enabled } });
                    break;
                }
                case 'saveReplay': {
                    if (!this.state.obs.replayBuffer)
                        this.fail('IO_ERROR', 'Start the replay buffer before saving a highlight.');
                    const profile = this.state.profiles.find(x => x.id === this.state.selectedProfileId)!;
                    const c: ClipAsset = { id: uid(), name: `Highlight ${this.state.clips.length + 1}`, game: profile.game, sessionId: this.state.activeSessionId, createdAt: now(), durationMs: profile.replayDurationMs, tags: ['Replay'], favorite: false, status: 'ready', mediaHandle: null, thumbnailUrl: null, fixture: true };
                    this.publish({ ...this.state, clips: [c, ...this.state.clips], sessions: this.state.sessions.map(s => s.id === this.state.activeSessionId ? { ...s, clipIds: [...s.clipIds, c.id] } : s) });
                    this.event('Replay saved · fixture only');
                    result = c;
                    break;
                }
                case 'scene': {
                    const { name } = p as {
                        name: string;
                    };
                    if (!this.state.obs.scenes.includes(name))
                        this.fail('NOT_FOUND', 'Scene not found');
                    this.publish({ ...this.state, obs: { ...this.state.obs, scene: name } });
                    break;
                }
                case 'streaming': {
                    const { enabled, destination } = p as OperationMap['streaming']['input'];
                    this.publish({ ...this.state, obs: { ...this.state.obs, streaming: enabled, streamDestination: enabled ? destination : null } });
                    break;
                }
                case 'audio': {
                    const a = p as OperationMap['audio']['input'];
                    if (!this.state.audio.some(x => x.id === a.id))
                        this.fail('NOT_FOUND', 'Audio source not found');
                    this.publish({ ...this.state, audio: this.state.audio.map(x => x.id === a.id ? { ...x, gain: a.gain, muted: a.muted } : x) });
                    break;
                }
                case 'importClips': {
                    const { files } = p as OperationMap['importClips']['input'];
                    const clips: ClipAsset[] = files.map(f => ({ id: uid(), name: f.name, game: 'Imported media', sessionId: null, createdAt: now(), durationMs: f.durationMs, tags: ['Imported'], favorite: false, status: 'ready', mediaHandle: f.mediaHandle, thumbnailUrl: null, fixture: false }));
                    this.publish({ ...this.state, clips: [...clips, ...this.state.clips] });
                    result = clips;
                    break;
                }
                case 'updateClip': {
                    const c = p as ClipAsset;
                    if (!this.state.clips.some(x => x.id === c.id))
                        this.fail('NOT_FOUND', 'Clip not found');
                    this.publish({ ...this.state, clips: this.state.clips.map(x => x.id === c.id ? c : x) });
                    break;
                }
                case 'saveProject': {
                    const project = p as OperationMap['saveProject']['input'];
                    this.publish({ ...this.state, projects: [...this.state.projects.filter(x => x.id !== project.id), project] });
                    break;
                }
                case 'export': {
                    const { project, simulateFailure } = p as OperationMap['export']['input'];
                    if (!this.state.clips.some(x => x.id === project.assetId && x.status === 'ready'))
                        this.fail('IO_ERROR', 'Recover the missing media before exporting');
                    if (this.state.jobs.some(j => j.projectId === project.id && ['accepted', 'processing'].includes(j.status)))
                        this.fail('BUSY', 'This draft is already in the export queue.');
                    const j: Job = { id: uid(), projectId: project.id, name: project.name, status: 'accepted', progress: 0, error: null, outputHandle: null, simulated: true };
                    this.publish({ ...this.state, jobs: [j, ...this.state.jobs] });
                    this.runJob(j.id, simulateFailure);
                    result = j;
                    break;
                }
                case 'cancelJob': {
                    const { id } = p as {
                        id: string;
                    };
                    if (!this.state.jobs.some(j => j.id === id && ['accepted', 'processing'].includes(j.status)))
                        this.fail('NOT_FOUND', 'Active job not found');
                    this.stopTimer(id);
                    this.publish({ ...this.state, jobs: this.state.jobs.map(j => j.id === id ? { ...j, status: 'canceled' } : j) });
                    break;
                }
                case 'retryJob': {
                    const { id } = p as {
                        id: string;
                    };
                    if (!this.state.jobs.some(j => j.id === id && ['failed', 'canceled'].includes(j.status)))
                        this.fail('NOT_FOUND', 'Retryable job not found');
                    this.publish({ ...this.state, jobs: this.state.jobs.map(j => j.id === id ? { ...j, status: 'accepted', progress: 0, error: null } : j) });
                    this.runJob(id, false);
                    break;
                }
                case 'openOutput':
                    this.fail('UNAVAILABLE', 'Demo exports do not create media files. Claude will enable Open Output after file validation.');
                    break;
                case 'saveSettings':
                    this.publish({ ...this.state, settings: p as OperationMap['saveSettings']['input'] });
                    break;
                case 'sessionNotes': {
                    const { id, notes } = p as {
                        id: string;
                        notes: string;
                    };
                    this.publish({ ...this.state, sessions: this.state.sessions.map(s => s.id === id ? { ...s, notes } : s) });
                    break;
                }
                case 'scenario': {
                    const { name } = p as OperationMap['scenario']['input'];
                    if (name === 'normal') {
                        this.publish({ ...this.state, clips: this.state.clips.map(c => c.fixture ? { ...c, status: 'ready' } : c), warnings: [] });
                        break;
                    }
                    if (name === 'missing')
                        this.publish({ ...this.state, clips: this.state.clips.map((c, i) => i === 0 ? { ...c, status: 'missing' } : c) });
                    if (name === 'empty')
                        this.publish({ ...this.state, clips: [] });
                    if (name === 'failed')
                        this.publish({ ...this.state, obs: { ...this.state.obs, connection: 'failed', recording: false, replayBuffer: false, streaming: false } });
                    if (name === 'storage')
                        this.publish({ ...this.state, warnings: ['Insufficient storage'] });
                    break;
                }
                case 'reset':
                    this.generation++;
                    this.timers.forEach(clearInterval);
                    this.timers.clear();
                    this.publish(makeFixtures());
                    break;
            }
            return result as OperationMap[K]['output'];
        }
        finally {
            this.busy.delete(key);
        }
    }
    private runJob(id: string, fail: boolean) { this.stopTimer(id); const t = setInterval(() => { const current = this.state.jobs.find(j => j.id === id); if (!current) {
        this.stopTimer(id);
        return;
    } const progress = Math.min(100, current.progress + 8); const status = fail && progress >= 48 ? 'failed' : progress >= 100 ? 'completed' : 'processing'; const error = status === 'failed' ? { code: 'IO_ERROR' as const, message: 'Simulated encoder failure', recoverable: true, details: 'Demo scenario: no real encoder was invoked.' } : null; this.publish({ ...this.state, jobs: this.state.jobs.map(j => j.id === id ? { ...j, progress, status, error } : j) }); if (status === 'completed' || status === 'failed')
        this.stopTimer(id); }, 250); this.timers.set(id, t); }
    private stopTimer(id: string) { const t = this.timers.get(id); if (t)
        clearInterval(t); this.timers.delete(id); }
    dispose() { this.disposed = true; this.generation++; this.timers.forEach(clearInterval); this.timers.clear(); this.listeners.clear(); }
}
