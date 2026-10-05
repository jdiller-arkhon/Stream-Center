/** Wire protocol v1. Times are integer milliseconds; timestamps are ISO-8601 UTC.
 * IDs are opaque strings. Paths are handles resolved and authorized in main, never commands.
 * Null means a measurement is unavailable, never zero. */
export const API_VERSION = 1 as const;
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';
export type Capability = 'obs' | 'recording' | 'replay' | 'preview' | 'launch' | 'obsAudio' | 'windowsAudio' | 'import' | 'export' | 'transcription' | 'telemetry' | 'streaming';
export type Capabilities = Record<Capability, {
    available: boolean;
    reason: string | null;
}> & {
    /** Desktop only (Claude phase): offline "Clip that" voice command. Optional so older snapshots stay valid. */
    voice?: {
        available: boolean;
        reason: string | null;
    };
};
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
    /** Normalise loudness to YouTube's ~−14 LUFS playback level. Optional so older presets stay valid. */
    loudness?: boolean;
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
    /** Desktop only: listen for "Clip that" (offline). Optional so older stored settings stay valid. */
    voiceClip?: boolean;
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
    /** Desktop only: state of the offline "Clip that" listener. Optional so older snapshots stay valid. */
    voice?: {
        state: 'off' | 'loading' | 'listening' | 'error';
        detail: string | null;
        device: string | null;
        lastHeardAt: string | null;
        /** Which command was heard last (optional for older desktop builds). */
        lastCommand?: 'clip' | 'mark' | null;
    };
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
    /** Desktop only (added in the Claude integration phase): native picker in main, then ffprobe indexing. Empty array if cancelled. */
    importNative: {
        input: undefined;
        output: ClipAsset[];
    };
    /** Desktop only: native picker to relink a missing clip. null if cancelled. */
    relinkNative: {
        input: {
            id: string;
        };
        output: ClipAsset | null;
    };
    /** Desktop only: native picker for user-supplied music; returns an authorized handle. */
    pickMusic: {
        input: undefined;
        output: {
            handle: string;
            name: string;
        } | null;
    };
    /** Desktop only: store (or clear) the OBS WebSocket password in OS-protected storage. */
    setObsPassword: {
        input: {
            password: string | null;
        };
        output: void;
    };
    /** Desktop only: loudest passages of a clip (FFmpeg EBU R128 analysis), loudest first. */
    suggestMoments: {
        input: {
            clipId: string;
        };
        output: Moment[];
    };
    /** Desktop only: probes and measures a finished export, then drafts YouTube metadata. Nothing is uploaded. */
    youtubeKit: {
        input: {
            jobId: string;
        };
        output: YouTubeKit;
    };
    /** Desktop only: saves a 1280×720 JPEG thumbnail (≤ 2 MB) next to the export and shows it in the folder. */
    saveThumbnail: {
        input: {
            jobId: string;
            dataUrl: string;
        };
        output: {
            fileName: string;
        };
    };
    /** Desktop only: shows the exported file in its folder. */
    revealOutput: {
        input: {
            id: string;
        };
        output: void;
    };
    /** Desktop only: opens YouTube Studio (fixed https URL) in the default browser. */
    openYouTubeStudio: {
        input: undefined;
        output: void;
    };
    /** Desktop only: local AI thumbnail generator settings and readiness. */
    thumbAiStatus: {
        input: undefined;
        output: ThumbAiStatus;
    };
    thumbAiConfigure: {
        input: {
            engine: ThumbAiEngine;
            serverUrl: string;
        };
        output: ThumbAiStatus;
    };
    /** Native picker for the stable-diffusion.cpp program or a model file. */
    thumbAiPick: {
        input: {
            kind: 'engine' | 'model';
        };
        output: ThumbAiStatus;
    };
    /** Generates thumbnail backgrounds on this PC (no text; the app adds the title). */
    generateThumbnail: {
        input: {
            description: string;
            /** Optional starting image (PNG/JPEG data URL), e.g. an upload or a video frame. */
            initImage: string | null;
            /** 0.1–1: how far the result may move from the starting image. */
            strength: number;
            count: number;
            /** Style preset key (see THUMB_STYLE_OPTIONS) or 'none'. Optional so older callers stay valid. */
            style?: string;
            /** Extra things to keep out of the image. */
            avoid?: string;
            quality?: 'fast' | 'balanced' | 'best';
            /** Reuse a seed (e.g. "More like this"); omitted = random. */
            seed?: number | null;
        };
        output: {
            images: string[];
            engine: string;
            seed: number;
            ms: number;
        };
    };
    cancelThumbnail: {
        input: undefined;
        output: void;
    };
}
export type ThumbAiEngine = 'off' | 'sdcpp' | 'webui';
/** Style presets the desktop generator understands (labels for the UI; prompts live in the service). */
export const THUMB_STYLE_OPTIONS: { key: string; label: string }[] = [
    { key: 'none', label: 'No style' }, { key: 'cinematic', label: 'Cinematic' }, { key: 'neon', label: 'Neon' }, { key: 'anime', label: 'Anime' },
    { key: 'comic', label: 'Comic' }, { key: 'photo', label: 'Photoreal' }, { key: 'fantasy', label: 'Fantasy' }, { key: 'horror', label: 'Horror' },
    { key: 'minimal', label: 'Minimal' }, { key: '3d', label: '3D render' },
];
export interface ThumbAiStatus {
    engine: ThumbAiEngine;
    /** File names only (the full paths stay in the desktop service). */
    engineFile: string | null;
    modelFile: string | null;
    serverUrl: string;
    ready: boolean;
    /** What is missing, or what is ready (e.g. the WebUI's loaded model). */
    detail: string | null;
    busy: boolean;
}
export interface Moment {
    atMs: number;
    /** Loudness above the clip's typical level, in LU. */
    excessLu: number;
}
export interface YouTubeCheck {
    id: string;
    label: string;
    status: 'pass' | 'warn' | 'fail';
    detail: string;
}
export interface YouTubeKit {
    jobId: string;
    fileName: string;
    durationMs: number;
    width: number;
    height: number;
    isShort: boolean;
    /** Game title from the clips or the game setup, when known. */
    game?: string | null;
    loudnessLufs: number | null;
    checks: YouTubeCheck[];
    chapters: {
        atMs: number;
        title: string;
    }[];
    chapterNote: string | null;
    title: string;
    description: string;
    tags: string[];
    /** Candidate thumbnail frames: 1280×720 JPEG data URLs taken from the export. */
    frames: string[];
}
/** Operations only the desktop bridge implements; DemoAdapter rejects them. */
export const DESKTOP_ONLY_OPERATIONS: Operation[] = ['importNative', 'relinkNative', 'pickMusic', 'setObsPassword', 'suggestMoments', 'youtubeKit', 'saveThumbnail', 'revealOutput', 'openYouTubeStudio', 'thumbAiStatus', 'thumbAiConfigure', 'thumbAiPick', 'generateThumbnail', 'cancelThumbnail'];
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
