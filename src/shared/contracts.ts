/** Wire protocol v1. Times are integer milliseconds; timestamps are ISO-8601 UTC.
 * IDs are opaque strings. Paths are handles resolved and authorized in main, never commands.
 * Null means a measurement is unavailable, never zero. */
export const API_VERSION = 1 as const;
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';
export type Capability = 'obs' | 'recording' | 'replay' | 'preview' | 'launch' | 'obsAudio' | 'windowsAudio' | 'import' | 'export' | 'transcription' | 'telemetry' | 'streaming';
export type Capabilities = Record<Capability, {
    available: boolean;
    reason: string | null;
}>;
export interface StructuredError {
    code: 'UNAVAILABLE' | 'INVALID_INPUT' | 'DISCONNECTED' | 'NOT_FOUND' | 'BUSY' | 'CANCELED' | 'IO_ERROR' | 'VERSION_MISMATCH';
    message: string;
    recoverable: boolean;
    details: string | null;
}
export class ServiceError extends Error {
    constructor(public readonly error: StructuredError) { super(error.message); }
}
export interface SessionProfile {
    id: string;
    name: string;
    game: string;
    gamePath: string;
    scene: string;
    destination: string;
    replayDurationMs: number;
    audioPreset: string;
    companionApps: string[];
    hotkey: string;
}
export interface Session {
    id: string;
    profileId: string;
    name: string;
    startedAt: string;
    endedAt: string | null;
    notes: string;
    events: {
        id: string;
        at: string;
        message: string;
    }[];
    clipIds: string[];
}
export interface OBSState {
    connection: ConnectionStatus;
    scene: string;
    scenes: string[];
    sources: string[];
    recording: boolean;
    replayBuffer: boolean;
    streaming: boolean;
    streamDestination: string | null;
    outputFps: number | null;
    encoderSkippedFrames: number | null;
    previewUrl: string | null;
}
export interface AudioSource {
    id: string;
    name: string;
    scope: 'obs' | 'windows';
    deviceName: string;
    gain: number;
    muted: boolean;
    level: number | null;
}
export interface ClipAsset {
    id: string;
    name: string;
    game: string;
    sessionId: string | null;
    createdAt: string;
    durationMs: number;
    tags: string[];
    favorite: boolean;
    status: 'ready' | 'missing' | 'processing' | 'failed';
    mediaHandle: string | null;
    thumbnailUrl: string | null;
    fixture: boolean;
}
export interface TimelineSegment {
    id: string;
    assetId: string;
    inMs: number;
    outMs: number;
    offsetMs: number;
    gain: number;
    fadeInMs: number;
    fadeOutMs: number;
}
export interface TimelineTrack {
    id: string;
    kind: 'video' | 'audio';
    name: string;
    segments: TimelineSegment[];
}
export interface Caption {
    id: string;
    text: string;
    startMs: number;
    endMs: number;
}
export interface EditProject {
    id: string;
    name: string;
    assetId: string;
    updatedAt: string;
    tracks: TimelineTrack[];
    aspect: '16:9' | '9:16';
    cropX: number;
    cropY: number;
    webcam: boolean;
    safeAreas: boolean;
    captions: Caption[];
    captionStyle: {
        font: string;
        size: number;
        color: string;
        position: 'top' | 'middle' | 'bottom';
    };
    preset: string;
    musicHandle: string | null;
    musicGain: number;
    originalGain: number;
}
export interface ExportPreset {
    destination: string;
    aspect: '16:9' | '9:16';
    resolution: 720 | 1080 | 1440;
    fps: 30 | 60;
    quality: 'balanced' | 'high';
    codec: 'h264' | 'hevc';
}
export interface Job {
    id: string;
    projectId: string;
    name: string;
    status: 'accepted' | 'processing' | 'completed' | 'failed' | 'canceled';
    progress: number;
    error: StructuredError | null;
    outputHandle: string | null;
    simulated: boolean;
}
export interface StudioSettings {
    mediaFolder: string;
    obsHost: string;
    obsPort: number;
    appearance: 'studio' | 'contrast';
    transcription: boolean;
    workerLimit: 1 | 2;
    shortcuts: boolean;
}
export interface StudioSnapshot {
    apiVersion: 1;
    mode: 'demo' | 'desktop';
    capabilities: Capabilities;
    obs: OBSState;
    audio: AudioSource[];
    profiles: SessionProfile[];
    selectedProfileId: string;
    sessions: Session[];
    activeSessionId: string | null;
    clips: ClipAsset[];
    projects: EditProject[];
    jobs: Job[];
    settings: StudioSettings;
    telemetry: {
        gameFps: number | null;
        diskFreeBytes: number | null;
    };
    warnings: string[];
}
export interface OperationMap {
    connect: {
        input: {
            host: string;
            port: number;
        };
        output: void;
    };
    disconnect: {
        input: undefined;
        output: void;
    };
    selectProfile: {
        input: {
            id: string;
        };
        output: void;
    };
    saveProfile: {
        input: SessionProfile;
        output: void;
    };
    prepareSession: {
        input: {
            profileId: string;
        };
        output: {
            steps: {
                label: string;
                ok: boolean;
                detail: string;
            }[];
        };
    };
    startSession: {
        input: {
            profileId: string;
        };
        output: Session;
    };
    endSession: {
        input: undefined;
        output: void;
    };
    launchGame: {
        input: {
            profileId: string;
        };
        output: void;
    };
    recording: {
        input: {
            enabled: boolean;
        };
        output: void;
    };
    replay: {
        input: {
            enabled: boolean;
        };
        output: void;
    };
    saveReplay: {
        input: undefined;
        output: ClipAsset;
    };
    scene: {
        input: {
            name: string;
        };
        output: void;
    };
    streaming: {
        input: {
            enabled: boolean;
            destination: string;
        };
        output: void;
    };
    audio: {
        input: {
            id: string;
            gain: number;
            muted: boolean;
        };
        output: void;
    };
    importClips: {
        input: {
            files: {
                name: string;
                durationMs: number;
                mediaHandle: string;
            }[];
        };
        output: ClipAsset[];
    };
    updateClip: {
        input: ClipAsset;
        output: void;
    };
    saveProject: {
        input: EditProject;
        output: void;
    };
    export: {
        input: {
            project: EditProject;
            preset: ExportPreset;
            simulateFailure: boolean;
        };
        output: Job;
    };
    cancelJob: {
        input: {
            id: string;
        };
        output: void;
    };
    retryJob: {
        input: {
            id: string;
        };
        output: void;
    };
    openOutput: {
        input: {
            id: string;
        };
        output: void;
    };
    saveSettings: {
        input: StudioSettings;
        output: void;
    };
    sessionNotes: {
        input: {
            id: string;
            notes: string;
        };
        output: void;
    };
    scenario: {
        input: {
            name: 'normal' | 'missing' | 'empty' | 'failed' | 'storage';
        };
        output: void;
    };
    reset: {
        input: undefined;
        output: void;
    };
}
export type Operation = keyof OperationMap;
export interface StudioService {
    readonly mode: 'demo' | 'desktop';
    getSnapshot(): StudioSnapshot;
    subscribe(listener: () => void): () => void;
    initialize(): Promise<void>;
    invoke<K extends Operation>(operation: K, input: OperationMap[K]['input']): Promise<OperationMap[K]['output']>;
    dispose(): void;
}
/** preload must validate requests, allowlist operations and authorize every media handle. */
export interface DesktopBridge {
    apiVersion: 1;
    readState(): Promise<unknown>;
    request(operation: Operation, input: unknown, requestId: string): Promise<unknown>;
    onState(listener: (state: unknown) => void): () => void;
}
declare global {
    interface Window {
        drift?: DesktopBridge;
    }
}
