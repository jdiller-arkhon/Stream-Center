/**
 * Drift Studio shared contract (frontend <-> desktop services).
 *
 * Rules:
 * - Every DTO here has a runtime schema (zod) and an inferred TypeScript type.
 * - IDs are opaque strings. Never parse them.
 * - Durations/offsets are integer milliseconds and are suffixed `Ms`.
 *   Timestamps are ISO-8601 UTC strings and are suffixed `At`.
 * - `null` means "known to be absent / unavailable". Optional (`?`) is only used
 *   for request patches.
 * - Breaking changes bump CONTRACT_VERSION's major and must update both the
 *   DemoAdapter fixtures and the DesktopAdapter (see docs/contract.md).
 */
import { z } from 'zod';

export const CONTRACT_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const Id = z.string().min(1).max(128);
export const Timestamp = z.string().min(1).max(64); // ISO-8601 UTC
export const Ms = z.number().int().nonnegative();
/** Absolute local file system path. Validated more strictly in the main process. */
export const FilePath = z.string().min(1).max(4096);
export const Db = z.number().min(-100).max(26);
/** Normalized rectangle, all values 0..1 relative to the source frame. */
export const NormRect = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});
export type NormRect = z.infer<typeof NormRect>;

// ---------------------------------------------------------------------------
// Errors / results
// ---------------------------------------------------------------------------

export const ErrorCode = z.enum([
  'VALIDATION',
  'NOT_FOUND',
  'UNSUPPORTED',
  'OBS_NOT_CONNECTED',
  'OBS_AUTH_FAILED',
  'OBS_REQUEST_FAILED',
  'REPLAY_BUFFER_UNAVAILABLE',
  'FFMPEG_MISSING',
  'FFMPEG_FAILED',
  'MEDIA_INVALID',
  'MEDIA_MISSING',
  'INSUFFICIENT_STORAGE',
  'CONFLICT',
  'BUSY',
  'CANCELLED',
  'INTERRUPTED',
  'LAUNCH_FAILED',
  'ALREADY_RUNNING',
  'IO',
  'TIMEOUT',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const DriftError = z.object({
  code: ErrorCode,
  message: z.string(),
  /** Extra technical detail safe to show in an expandable "details" area. */
  detail: z.string().nullable(),
  retryable: z.boolean(),
});
export type DriftError = z.infer<typeof DriftError>;

export type Result<T> = { ok: true; data: T } | { ok: false; error: DriftError };

// ---------------------------------------------------------------------------
// Connection + capabilities
// ---------------------------------------------------------------------------

export const ConnectionState = z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'failed']);
export type ConnectionState = z.infer<typeof ConnectionState>;

export const ConnectionStatus = z.object({
  service: z.enum(['obs']),
  state: ConnectionState,
  /** Human readable explanation of the current state. */
  detail: z.string().nullable(),
  endpoint: z.string().nullable(),
  lastConnectedAt: Timestamp.nullable(),
  /** When reconnecting, milliseconds until the next attempt. */
  retryInMs: Ms.nullable(),
  error: DriftError.nullable(),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const Capability = z.object({
  available: z.boolean(),
  /** Why the capability is unavailable (or a caveat when available). */
  reason: z.string().nullable(),
});
export type Capability = z.infer<typeof Capability>;

export const Capabilities = z.object({
  contractVersion: z.string(),
  mode: z.enum(['desktop', 'demo']),
  platform: z.string(),
  appVersion: z.string(),
  obs: z.object({
    connection: Capability,
    preview: Capability,
    scenes: Capability,
    recording: Capability,
    replayBuffer: Capability,
    streaming: Capability,
    stats: Capability,
  }),
  media: z.object({
    ffmpeg: Capability,
    ffprobe: Capability,
    captionsBurnIn: Capability,
    hardwareEncoders: z.array(z.enum(['nvenc', 'qsv', 'amf'])),
  }),
  audio: z.object({
    obsInputs: Capability,
    obsMeters: Capability,
    windowsDevices: Capability,
    windowsDeviceControl: Capability,
  }),
  launcher: z.object({
    executables: Capability,
    uris: Capability,
    processDetection: Capability,
  }),
  telemetry: z.object({
    gameFps: Capability,
    obsRenderFps: Capability,
    encoderStats: Capability,
    disk: Capability,
  }),
  transcription: Capability,
  hotkeys: Capability,
  secureStorage: Capability,
  streamDeck: Capability,
});
export type Capabilities = z.infer<typeof Capabilities>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const ShortcutAction = z.enum(['saveReplay', 'toggleRecording', 'toggleReplayBuffer', 'toggleMicMute', 'openCommandPalette']);
export type ShortcutAction = z.infer<typeof ShortcutAction>;

export const Shortcut = z.object({
  action: ShortcutAction,
  /** Electron accelerator string, e.g. "CommandOrControl+Alt+R". */
  accelerator: z.string().max(64).nullable(),
  enabled: z.boolean(),
  /** Global shortcuts work while a game is focused; local only inside the app. */
  scope: z.enum(['global', 'local']),
});
export type Shortcut = z.infer<typeof Shortcut>;

export const Settings = z.object({
  firstRunComplete: z.boolean(),
  media: z.object({
    libraryDirectory: FilePath.nullable(),
    exportDirectory: FilePath.nullable(),
    autoImportReplays: z.boolean(),
    autoImportRecordings: z.boolean(),
  }),
  obs: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    /** Whether a password is stored in OS protected storage. The password is never returned. */
    passwordStored: z.boolean(),
    autoConnect: z.boolean(),
    /** Name of the OBS input treated as "the microphone" for quick mute. */
    microphoneInputName: z.string().max(256).nullable(),
  }),
  tools: z.object({
    ffmpegPath: FilePath.nullable(),
    ffprobePath: FilePath.nullable(),
  }),
  performance: z.object({
    maxConcurrentJobs: z.number().int().min(1).max(4),
    lowerPriorityWhileGaming: z.boolean(),
    preferHardwareEncoding: z.boolean(),
  }),
  transcription: z.object({
    enabled: z.boolean(),
    whisperPath: FilePath.nullable(),
    modelPath: FilePath.nullable(),
  }),
  shortcuts: z.array(Shortcut),
  privacy: z.object({
    /** When false, file paths in diagnostics exports are redacted. */
    includePathsInDiagnostics: z.boolean(),
  }),
});
export type Settings = z.infer<typeof Settings>;

export const SettingsPatch = z.object({
  firstRunComplete: z.boolean().optional(),
  media: Settings.shape.media.partial().optional(),
  obs: Settings.shape.obs.omit({ passwordStored: true }).partial().optional(),
  tools: Settings.shape.tools.partial().optional(),
  performance: Settings.shape.performance.partial().optional(),
  transcription: Settings.shape.transcription.partial().optional(),
  shortcuts: z.array(Shortcut).optional(),
  privacy: Settings.shape.privacy.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const ShortcutStatus = z.object({
  action: ShortcutAction,
  accelerator: z.string().nullable(),
  registered: z.boolean(),
  /** e.g. "Accelerator is already used by another application". */
  problem: z.string().nullable(),
});
export type ShortcutStatus = z.infer<typeof ShortcutStatus>;

// ---------------------------------------------------------------------------
// OBS
// ---------------------------------------------------------------------------

export const ObsStats = z.object({
  /** OBS render/output frame rate. This is NOT the game's frame rate. */
  activeFps: z.number().nullable(),
  averageFrameRenderMs: z.number().nullable(),
  renderSkippedFrames: z.number().int().nullable(),
  renderTotalFrames: z.number().int().nullable(),
  /** Encoder (output) frames skipped because the encoder could not keep up. */
  outputSkippedFrames: z.number().int().nullable(),
  outputTotalFrames: z.number().int().nullable(),
  /** OBS process CPU usage percent. */
  cpuUsagePercent: z.number().nullable(),
  memoryMb: z.number().nullable(),
  availableDiskMb: z.number().nullable(),
});
export type ObsStats = z.infer<typeof ObsStats>;

export const ObsState = z.object({
  connection: ConnectionStatus,
  version: z.object({ obs: z.string(), websocket: z.string(), platform: z.string() }).nullable(),
  currentScene: z.string().nullable(),
  scenes: z.array(z.object({ name: z.string(), index: z.number().int() })),
  recording: z.object({
    active: z.boolean(),
    paused: z.boolean(),
    durationMs: Ms.nullable(),
    bytes: z.number().nullable(),
    directory: z.string().nullable(),
  }),
  replayBuffer: z.object({
    /** False when the replay buffer is not enabled in OBS output settings. */
    available: z.boolean(),
    active: z.boolean(),
    unavailableReason: z.string().nullable(),
  }),
  streaming: z.object({
    active: z.boolean(),
    reconnecting: z.boolean(),
    durationMs: Ms.nullable(),
    skippedFrames: z.number().int().nullable(),
    totalFrames: z.number().int().nullable(),
  }),
  stats: ObsStats.nullable(),
  updatedAt: Timestamp,
});
export type ObsState = z.infer<typeof ObsState>;

export const ObsPreview = z.object({
  sceneName: z.string(),
  /** data:image/jpeg;base64,... */
  imageDataUrl: z.string(),
  width: z.number().int(),
  capturedAt: Timestamp,
});
export type ObsPreview = z.infer<typeof ObsPreview>;

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export const AudioSource = z.object({
  id: Id,
  origin: z.enum(['obs-input', 'windows-device']),
  name: z.string(),
  /** OBS input kind (e.g. wasapi_input_capture) or Windows endpoint direction. */
  kind: z.string(),
  /** Underlying device name when known (e.g. the actual microphone behind an OBS input). */
  deviceName: z.string().nullable(),
  muted: z.boolean().nullable(),
  volumeDb: z.number().nullable(),
  isMicrophone: z.boolean(),
  controls: z.object({ mute: z.boolean(), volume: z.boolean() }),
  /** Explanation for missing controls / readings. */
  note: z.string().nullable(),
});
export type AudioSource = z.infer<typeof AudioSource>;

export const AudioMeters = z.object({
  at: Timestamp,
  /** Per OBS input: per-channel peak dBFS (-inf clamped to -100). */
  levels: z.array(z.object({ sourceId: Id, peakDb: z.array(z.number()) })),
});
export type AudioMeters = z.infer<typeof AudioMeters>;

// ---------------------------------------------------------------------------
// Profiles + sessions
// ---------------------------------------------------------------------------

export const GameLaunch = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('executable'),
    path: FilePath,
    args: z.array(z.string().max(1024)).max(64),
    /** Process image name used for duplicate detection; defaults to the exe file name. */
    processName: z.string().max(260).nullable(),
  }),
  z.object({
    kind: z.literal('uri'),
    /** Supported launcher URI, e.g. steam://rungameid/359550 */
    uri: z.string().max(2048),
    processName: z.string().max(260).nullable(),
  }),
]);
export type GameLaunch = z.infer<typeof GameLaunch>;

export const CompanionApp = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  path: FilePath,
  args: z.array(z.string().max(1024)).max(64),
  processName: z.string().max(260).nullable(),
});
export type CompanionApp = z.infer<typeof CompanionApp>;

export const AudioPreset = z.object({
  /** OBS input names to mute / unmute. Windows device control is not supported. */
  mute: z.array(z.string().max(256)).max(64),
  unmute: z.array(z.string().max(256)).max(64),
  volumes: z.array(z.object({ inputName: z.string().max(256), volumeDb: Db })).max(64),
});
export type AudioPreset = z.infer<typeof AudioPreset>;

export const SessionProfile = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  gameTitle: z.string().max(120),
  game: GameLaunch,
  /** Optional local image used for the hero/game visual. */
  artworkPath: FilePath.nullable(),
  obs: z.object({
    sceneName: z.string().max(256).nullable(),
    startReplayBuffer: z.boolean(),
    startRecording: z.boolean(),
  }),
  /** Expected OBS replay buffer length; verified against OBS where readable, never silently changed. */
  replayDurationSec: z.number().int().min(5).max(21600).nullable(),
  /** Where clips from this profile are copied/indexed. null = library default. */
  recordingDirectory: FilePath.nullable(),
  audioPreset: AudioPreset.nullable(),
  companionApps: z.array(CompanionApp).max(16),
  tags: z.array(z.string().max(40)).max(32),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SessionProfile = z.infer<typeof SessionProfile>;

export const SessionProfileInput = SessionProfile.omit({ createdAt: true, updatedAt: true }).extend({
  id: Id.nullable(),
});
export type SessionProfileInput = z.infer<typeof SessionProfileInput>;

export const ValidationIssue = z.object({
  field: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const PreflightCheck = z.object({
  id: z.enum(['obs', 'scene', 'capture', 'replayBuffer', 'recording', 'microphone', 'storage', 'game', 'companions']),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail', 'skipped', 'unknown']),
  detail: z.string(),
});
export type PreflightCheck = z.infer<typeof PreflightCheck>;

export const SessionStepKind = z.enum([
  'obs.connect',
  'obs.scene',
  'audio.preset',
  'obs.replayBuffer',
  'obs.recording',
  'companion.launch',
  'game.launch',
]);

export const SessionStep = z.object({
  id: Id,
  kind: SessionStepKind,
  label: z.string(),
  /** Exactly what will happen, shown before the user starts. */
  detail: z.string(),
  required: z.boolean(),
  status: z.enum(['pending', 'running', 'done', 'skipped', 'failed', 'cancelled']),
  message: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type SessionStep = z.infer<typeof SessionStep>;

export const SessionEvent = z.object({
  id: Id,
  at: Timestamp,
  kind: z.enum([
    'session.preparing',
    'session.started',
    'session.ended',
    'session.failed',
    'session.cancelled',
    'step',
    'recording.started',
    'recording.stopped',
    'replay.started',
    'replay.stopped',
    'replay.saved',
    'stream.started',
    'stream.stopped',
    'clip.added',
    'export.completed',
    'warning',
    'note',
  ]),
  message: z.string(),
  refId: Id.nullable(),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const Session = z.object({
  id: Id,
  profileId: Id.nullable(),
  name: z.string(),
  gameTitle: z.string(),
  state: z.enum(['preparing', 'active', 'ended', 'failed', 'cancelled']),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  steps: z.array(SessionStep),
  events: z.array(SessionEvent),
  clipIds: z.array(Id),
  exportJobIds: z.array(Id),
  notes: z.string().max(20000),
  /** Explanation of what was left running after a partial failure/cancel. */
  recovery: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

// ---------------------------------------------------------------------------
// Clips / media
// ---------------------------------------------------------------------------

export const ClipAsset = z.object({
  id: Id,
  path: FilePath,
  fileName: z.string(),
  sizeBytes: z.number().nonnegative(),
  /** Partial content hash used for duplicate detection. */
  contentHash: z.string(),
  durationMs: Ms,
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  fps: z.number().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  audioChannels: z.number().int().nullable(),
  container: z.string().nullable(),
  source: z.enum(['replay', 'recording', 'import', 'export']),
  gameTitle: z.string().nullable(),
  sessionId: Id.nullable(),
  tags: z.array(z.string().max(40)),
  favorite: z.boolean(),
  status: z.enum(['ok', 'missing', 'error']),
  statusDetail: z.string().nullable(),
  fileCreatedAt: Timestamp,
  importedAt: Timestamp,
  /** URLs servable inside the desktop app (drift-media://). null until generated. */
  mediaUrl: z.string(),
  /** Browser-playable proxy URL when the original container/codec is not playable. */
  playbackUrl: z.string().nullable(),
  playback: z.enum(['direct', 'proxy-pending', 'proxy', 'unplayable']),
  thumbnailUrl: z.string().nullable(),
});
export type ClipAsset = z.infer<typeof ClipAsset>;

export const ClipQuery = z.object({
  search: z.string().max(200).nullable(),
  gameTitle: z.string().max(120).nullable(),
  sessionId: Id.nullable(),
  favoritesOnly: z.boolean(),
  tags: z.array(z.string().max(40)).max(16),
  source: z.enum(['replay', 'recording', 'import', 'export']).nullable(),
  limit: z.number().int().min(1).max(500),
  offset: z.number().int().min(0),
});
export type ClipQuery = z.infer<typeof ClipQuery>;

export const ClipImportResult = z.object({
  path: FilePath,
  outcome: z.enum(['imported', 'duplicate', 'failed']),
  clipId: Id.nullable(),
  error: DriftError.nullable(),
});
export type ClipImportResult = z.infer<typeof ClipImportResult>;

export const Waveform = z.object({
  clipId: Id,
  /** Peaks per second in `peaks`. */
  resolution: z.number().int(),
  /** Normalized peak 0..1 per bucket (mono mixdown). */
  peaks: z.array(z.number()),
  durationMs: Ms,
});
export type Waveform = z.infer<typeof Waveform>;

// ---------------------------------------------------------------------------
// Edit projects
// ---------------------------------------------------------------------------

export const TimelineItem = z.object({
  id: Id,
  clipId: Id,
  /** Trim points in the source clip (non-destructive). */
  sourceInMs: Ms,
  sourceOutMs: Ms,
  gainDb: Db,
  fadeInMs: Ms,
  fadeOutMs: Ms,
});
export type TimelineItem = z.infer<typeof TimelineItem>;

export const TimelineTrack = z.object({
  id: Id,
  /** v1: exactly one 'main' track; items play back-to-back in order (cuts). */
  kind: z.enum(['main']),
  items: z.array(TimelineItem).max(200),
  muted: z.boolean(),
});
export type TimelineTrack = z.infer<typeof TimelineTrack>;

export const Caption = z.object({
  id: Id,
  /** Timeline (output) time. */
  startMs: Ms,
  endMs: Ms,
  text: z.string().max(500),
});
export type Caption = z.infer<typeof Caption>;

export const CaptionStyle = z.object({
  fontFamily: z.string().max(80),
  /** Font size in pixels at 1080 px output height (scaled for other sizes). */
  sizePx: z.number().int().min(12).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  background: z.boolean(),
  position: z.enum(['top', 'middle', 'bottom']),
  bold: z.boolean(),
});
export type CaptionStyle = z.infer<typeof CaptionStyle>;

export const AspectRatio = z.enum(['16:9', '9:16', '1:1']);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const EditProject = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  /** Monotonic revision for optimistic concurrency (autosave vs. manual save). */
  revision: z.number().int().nonnegative(),
  tracks: z.array(TimelineTrack).length(1),
  aspect: AspectRatio,
  /** Crop applied to every source frame before fitting the output aspect. null = auto center crop. */
  crop: NormRect.nullable(),
  webcam: z
    .object({
      enabled: z.boolean(),
      /** Region of the source frame containing the webcam. */
      sourceRect: NormRect,
      /** Placement in the output frame. */
      placement: NormRect,
    })
    .nullable(),
  captions: z.array(Caption).max(2000),
  captionStyle: CaptionStyle,
  music: z
    .object({
      path: FilePath,
      /** User attests they supplied/licensed this track. */
      userSupplied: z.literal(true),
      gainDb: Db,
      startMs: Ms,
      fadeInMs: Ms,
      fadeOutMs: Ms,
    })
    .nullable(),
  originalAudioGainDb: Db,
  videoFadeInMs: Ms,
  videoFadeOutMs: Ms,
  presetId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type EditProject = z.infer<typeof EditProject>;

export const ProjectSummary = z.object({
  id: Id,
  name: z.string(),
  revision: z.number().int(),
  durationMs: Ms,
  clipIds: z.array(Id),
  aspect: AspectRatio,
  updatedAt: Timestamp,
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

// ---------------------------------------------------------------------------
// Export presets + jobs
// ---------------------------------------------------------------------------

export const ExportSettings = z.object({
  aspect: AspectRatio,
  width: z.number().int().min(144).max(7680),
  height: z.number().int().min(144).max(7680),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
  quality: z.enum(['draft', 'standard', 'high']),
  codec: z.enum(['h264', 'hevc']),
  encoder: z.enum(['auto', 'software', 'nvenc', 'qsv', 'amf']),
  audioBitrateKbps: z.number().int().min(64).max(320),
});
export type ExportSettings = z.infer<typeof ExportSettings>;

export const ExportPreset = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  settings: ExportSettings,
  /** Project fields the preset applies when chosen (all inspectable / editable). */
  projectDefaults: z.object({
    videoFadeInMs: Ms,
    videoFadeOutMs: Ms,
    originalAudioGainDb: Db,
    captionStyle: CaptionStyle.nullable(),
  }),
});
export type ExportPreset = z.infer<typeof ExportPreset>;

export const ExportRequest = z.object({
  projectId: Id,
  settings: ExportSettings,
  /** Directory; null = settings.media.exportDirectory. */
  destinationDirectory: FilePath.nullable(),
  /** File name without extension; sanitized and made collision-safe. */
  fileName: z.string().min(1).max(120),
});
export type ExportRequest = z.infer<typeof ExportRequest>;

export const JobKind = z.enum(['export', 'proxy', 'transcription']);

export const Job = z.object({
  id: Id,
  kind: JobKind,
  state: z.enum(['queued', 'running', 'validating', 'succeeded', 'failed', 'cancelled']),
  label: z.string(),
  /** 0..1 from real encoder progress; null when not measurable. */
  progress: z.number().min(0).max(1).nullable(),
  progressDetail: z.string().nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  attempts: z.number().int(),
  error: DriftError.nullable(),
  /** Set only after the output exists and passed ffprobe validation. */
  outputPath: FilePath.nullable(),
  outputClipId: Id.nullable(),
  refId: Id.nullable(),
});
export type Job = z.infer<typeof Job>;

// ---------------------------------------------------------------------------
// System / telemetry
// ---------------------------------------------------------------------------

export const DiskStatus = z.object({
  path: FilePath,
  freeBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
});
export type DiskStatus = z.infer<typeof DiskStatus>;

export const Telemetry = z.object({
  at: Timestamp,
  /** Never populated from OBS numbers. null + reason when not measured. */
  gameFps: z.number().nullable(),
  gameFpsReason: z.string().nullable(),
  obs: ObsStats.nullable(),
  obsReason: z.string().nullable(),
  disk: DiskStatus.nullable(),
  diskReason: z.string().nullable(),
});
export type Telemetry = z.infer<typeof Telemetry>;

export const StatusStrip = z.object({
  recording: z.object({ active: z.boolean(), durationMs: Ms.nullable() }).nullable(),
  replayBuffer: z.object({ available: z.boolean(), active: z.boolean() }).nullable(),
  obsReason: z.string().nullable(),
  disk: DiskStatus.nullable(),
  activeJobs: z.number().int(),
  activeSessionId: Id.nullable(),
});
export type StatusStrip = z.infer<typeof StatusStrip>;

export const PickPathRequest = z.object({
  kind: z.enum(['directory', 'file', 'files']),
  purpose: z.enum(['library', 'export', 'game', 'companion', 'artwork', 'music', 'import', 'ffmpeg', 'ffprobe', 'whisper', 'model']),
  title: z.string().max(120).nullable(),
});
export type PickPathRequest = z.infer<typeof PickPathRequest>;

export const RevealTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clip'), id: Id }),
  z.object({ kind: z.literal('jobOutput'), id: Id }),
  z.object({ kind: z.literal('logs') }),
  z.object({ kind: z.literal('library') }),
]);
export type RevealTarget = z.infer<typeof RevealTarget>;

export const Notice = z.object({
  id: Id,
  at: Timestamp,
  level: z.enum(['info', 'success', 'warning', 'error']),
  title: z.string(),
  message: z.string(),
  refId: Id.nullable(),
});
export type Notice = z.infer<typeof Notice>;
