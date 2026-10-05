import { API_VERSION, ServiceError, type Operation, type StudioSnapshot, type EditProject, type SessionProfile } from './contracts';
export const invalid = (message: string): never => { throw new ServiceError({ code: 'INVALID_INPUT', message, recoverable: true, details: null }); };
const obj = (x: unknown): Record<string, unknown> => { if (!x || typeof x !== 'object' || Array.isArray(x))
    invalid('Expected an object'); return x as Record<string, unknown>; };
const str = (x: unknown, label: string,limit=8192): string => { if (typeof x !== 'string' || x.length > limit)
    invalid(`${label} must be text`); return x as string; };
const number = (x: unknown, min: number, max: number, label: string): number => { if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max)
    invalid(`${label} must be between ${min} and ${max}`); return x as number; };
const bool = (x: unknown, label: string) => { if (typeof x !== 'boolean')
    invalid(`${label} must be boolean`); };
const list = (x: unknown, label: string): unknown[] => { if (!Array.isArray(x) || x.length > 10000)
    invalid(`${label} must be an array`); return x as unknown[]; };
const one = (x: unknown, values: unknown[], label: string) => { if (!values.includes(x))
    invalid(`Invalid ${label}`); };
const nullable = (x: unknown, check: (v: unknown) => unknown) => { if (x !== null)
    check(x); };
const id = (x: unknown) => { if (!str(x, 'ID').trim())
    invalid('Missing ID'); };
const date = (x: unknown) => { if (Number.isNaN(Date.parse(str(x, 'timestamp'))))
    invalid('Invalid timestamp'); };
function profile(value: unknown) { const p = obj(value); for (const k of ['id', 'name', 'game', 'gamePath', 'scene', 'destination', 'audioPreset', 'hotkey'])
    str(p[k], k); id(p.id); if (!String(p.name).trim() || !String(p.gamePath).trim() || !String(p.destination).trim())
    invalid('Profile needs a name, game path and destination'); number(p.replayDurationMs, 5000, 300000, 'Replay duration'); list(p.companionApps, 'apps').forEach(x => str(x, 'app')); }
function project(value: unknown) { const p = obj(value); for (const k of ['id', 'name', 'assetId', 'preset'])
    str(p[k], k); date(p.updatedAt); one(p.aspect, ['16:9', '9:16'], 'aspect'); number(p.cropX, 0, 100, 'crop'); number(p.cropY, 0, 100, 'crop'); bool(p.webcam, 'webcam'); bool(p.safeAreas, 'safe areas'); nullable(p.musicHandle, x => str(x, 'music')); number(p.musicGain, 0, 1, 'music gain'); number(p.originalGain, 0, 1, 'original gain'); const style = obj(p.captionStyle); str(style.font, 'font'); number(style.size, 12, 96, 'caption size'); str(style.color, 'caption color'); one(style.position, ['top', 'middle', 'bottom'], 'caption position'); list(p.captions, 'captions').forEach(c => { const v = obj(c); id(v.id); str(v.text, 'caption'); number(v.startMs, 0, 86400000, 'caption start'); number(v.endMs, Number(v.startMs) + 1, 86400000, 'caption end'); }); list(p.tracks, 'tracks').forEach(t => { const v = obj(t); id(v.id); str(v.name, 'track'); one(v.kind, ['video', 'audio'], 'track type'); list(v.segments, 'segments').forEach(s => { const z = obj(s); id(z.id); id(z.assetId); number(z.inMs, 0, 86400000, 'in'); number(z.outMs, Number(z.inMs) + 1, 86400000, 'out'); number(z.offsetMs, 0, 86400000, 'offset'); number(z.gain, 0, 1, 'gain'); number(z.fadeInMs, 0, 10000, 'fade'); number(z.fadeOutMs, 0, 10000, 'fade'); }); }); }
function clip(value: unknown) { const p = obj(value); id(p.id); str(p.name, 'name'); str(p.game, 'game'); nullable(p.sessionId, id); date(p.createdAt); number(p.durationMs, 1, 86400000, 'duration'); list(p.tags, 'tags').forEach(x => str(x, 'tag')); bool(p.favorite, 'favorite'); bool(p.fixture, 'fixture'); one(p.status, ['ready', 'missing', 'processing', 'failed'], 'clip status'); nullable(p.mediaHandle, x => str(x, 'media handle')); nullable(p.thumbnailUrl, x => str(x, 'thumbnail',2000000)); }
function settings(value: unknown) { const p = obj(value); for (const k of ['mediaFolder', 'obsHost'])
    str(p[k], k); number(p.obsPort, 1, 65535, 'port'); one(p.appearance, ['studio', 'contrast'], 'appearance'); bool(p.transcription, 'transcription'); bool(p.shortcuts, 'shortcuts'); one(p.workerLimit, [1, 2], 'worker limit'); }
function job(value: unknown) { const j = obj(value); for (const k of ['id', 'projectId', 'name'])
    str(j[k], k); one(j.status, ['accepted', 'processing', 'completed', 'failed', 'canceled'], 'job status'); number(j.progress, 0, 100, 'progress'); bool(j.simulated, 'simulated'); nullable(j.outputHandle, x => str(x, 'output')); nullable(j.error, x => { const e = obj(x); str(e.code, 'error code'); str(e.message, 'error'); bool(e.recoverable, 'recoverable'); nullable(e.details, v => str(v, 'details')); }); }
export const validateProfile = (p: unknown): SessionProfile => { profile(p); return p as SessionProfile; };
export const validateProject = (p: unknown): EditProject => { project(p); return p as EditProject; };
export function validateRequest(op: Operation, input: unknown): void {
    if (['disconnect', 'endSession', 'saveReplay', 'reset'].includes(op)) {
        if (input !== undefined)
            invalid('Expected no input');
        return;
    }
    const p = obj(input);
    switch (op) {
        case 'connect':
            str(p.host, 'host');
            if (!String(p.host).trim())
                invalid('Host required');
            number(p.port, 1, 65535, 'port');
            break;
        case 'saveProfile':
            profile(p);
            break;
        case 'saveProject':
            project(p);
            break;
        case 'updateClip':
            clip(p);
            break;
        case 'saveSettings':
            settings(p);
            break;
        case 'audio':
            id(p.id);
            number(p.gain, 0, 1, 'gain');
            bool(p.muted, 'mute');
            break;
        case 'recording':
        case 'replay':
            bool(p.enabled, 'enabled');
            break;
        case 'streaming':
            bool(p.enabled, 'enabled');
            if (p.enabled && !str(p.destination, 'destination').trim())
                invalid('Destination required');
            break;
        case 'scene':
            str(p.name, 'scene');
            break;
        case 'sessionNotes':
            id(p.id);
            str(p.notes, 'notes');
            break;
        case 'scenario':
            one(p.name, ['normal', 'missing', 'empty', 'failed', 'storage'], 'scenario');
            break;
        case 'importClips':
            list(p.files, 'files').forEach(f => { const v = obj(f); str(v.name, 'name'); str(v.mediaHandle, 'handle'); number(v.durationMs, 1, 86400000, 'duration'); });
            break;
        case 'export':
            project(p.project);
            bool(p.simulateFailure, 'failure');
            {
                const e = obj(p.preset);
                str(e.destination, 'destination');
                if (!String(e.destination).trim())
                    invalid('Export destination required');
                one(e.aspect, ['16:9', '9:16'], 'aspect');
                one(e.resolution, [720, 1080, 1440], 'resolution');
                one(e.fps, [30, 60], 'fps');
                one(e.quality, ['balanced', 'high'], 'quality');
                one(e.codec, ['h264', 'hevc'], 'codec');
            }
            break;
        case 'selectProfile':
        case 'cancelJob':
        case 'retryJob':
        case 'openOutput':
            id(p.id);
            break;
        case 'prepareSession':
        case 'startSession':
        case 'launchGame':
            id(p.profileId);
            break;
        default: invalid('Operation not allowlisted');
    }
}
export function validateSnapshot(value: unknown): StudioSnapshot {
    const p = obj(value);
    if (p.apiVersion !== API_VERSION)
        throw new ServiceError({ code: 'VERSION_MISMATCH', message: 'Desktop API version mismatch', recoverable: false, details: 'Expected protocol 1' });
    one(p.mode, ['demo', 'desktop'], 'mode');
    const caps = obj(p.capabilities);
    for (const k of ['obs', 'recording', 'replay', 'preview', 'launch', 'obsAudio', 'windowsAudio', 'import', 'export', 'transcription', 'telemetry', 'streaming']) {
        const c = obj(caps[k]);
        bool(c.available, 'capability');
        nullable(c.reason, x => str(x, 'reason'));
    }
    const o = obj(p.obs);
    one(o.connection, ['disconnected', 'connecting', 'connected', 'failed'], 'connection');
    str(o.scene, 'scene');
    for (const k of ['scenes', 'sources'])
        list(o[k], k).forEach(x => str(x, k));
    for (const k of ['recording', 'replayBuffer', 'streaming'])
        bool(o[k], k);
    nullable(o.streamDestination, x => str(x, 'destination'));
    nullable(o.outputFps, x => number(x, 0, 1000, 'fps'));
    nullable(o.encoderSkippedFrames, x => number(x, 0, Number.MAX_SAFE_INTEGER, 'frames'));
    nullable(o.previewUrl, x => str(x, 'preview'));
    list(p.audio, 'audio').forEach(a => { const v = obj(a); id(v.id); str(v.name, 'name'); str(v.deviceName, 'device'); one(v.scope, ['obs', 'windows'], 'scope'); number(v.gain, 0, 1, 'gain'); bool(v.muted, 'mute'); nullable(v.level, x => number(x, 0, 1, 'level')); });
    list(p.profiles, 'profiles').forEach(profile);
    id(p.selectedProfileId);
    nullable(p.activeSessionId, id);
    list(p.sessions, 'sessions').forEach(s => { const v = obj(s); id(v.id); id(v.profileId); str(v.name, 'session'); str(v.notes, 'notes'); date(v.startedAt); nullable(v.endedAt, date); list(v.clipIds, 'clips').forEach(id); list(v.events, 'events').forEach(e => { const z = obj(e); id(z.id); date(z.at); str(z.message, 'message'); }); });
    list(p.clips, 'clips').forEach(clip);
    list(p.projects, 'projects').forEach(project);
    list(p.jobs, 'jobs').forEach(job);
    settings(p.settings);
    const t = obj(p.telemetry);
    nullable(t.gameFps, x => number(x, 0, 2000, 'game fps'));
    nullable(t.diskFreeBytes, x => number(x, 0, Number.MAX_SAFE_INTEGER, 'storage'));
    list(p.warnings, 'warnings').forEach(x => str(x, 'warning'));
    return p as unknown as StudioSnapshot;
}
export function validateResponse(op: Operation, value: unknown): unknown {
    if (op === 'startSession') {
        const p = obj(value);
        id(p.id);
        id(p.profileId);
        str(p.name, 'session');
        date(p.startedAt);
        return p;
    }
    if (op === 'saveReplay')
        clip(value);
    else if (op === 'importClips')
        list(value, 'clips').forEach(clip);
    else if (op === 'export')
        job(value);
    else if (op === 'prepareSession')
        list(obj(value).steps, 'steps').forEach(s => { const v = obj(s); str(v.label, 'label'); bool(v.ok, 'ok'); str(v.detail, 'detail'); });
    else if (value !== undefined && value !== null)
        invalid('Unexpected operation response');
    return value;
}
/** Renderer check; main must independently repeat capability and authorization checks. */
export function assertCapability(state: StudioSnapshot, operation: Operation): void {
    const map: Partial<Record<Operation, keyof StudioSnapshot['capabilities']>> = { connect: 'obs', recording: 'recording', replay: 'replay', saveReplay: 'replay', scene: 'obs', streaming: 'streaming', audio: 'obsAudio', launchGame: 'launch', startSession: 'launch', importClips: 'import', export: 'export' };
    const capability = map[operation];
    if (!capability)
        return;
    const value = state.capabilities[capability];
    if (!value.available)
        throw new ServiceError({ code: 'UNAVAILABLE', message: value.reason ?? `${capability} is unavailable`, recoverable: true, details: null });
}
