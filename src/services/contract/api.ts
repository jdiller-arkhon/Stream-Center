/**
 * The Drift Studio service surface: every operation the renderer may request and
 * every event it may receive. The main process validates each request against
 * `methods[name].input` and rejects names that are not in this registry.
 *
 * Both the DemoAdapter (frontend, fixtures) and the DesktopAdapter (IPC) implement
 * `DriftClient` over this registry.
 */
import { z } from 'zod';
import {
  AudioMeters,
  AudioSource,
  Capabilities,
  ClipAsset,
  ClipImportResult,
  ClipQuery,
  ConnectionStatus,
  Db,
  DiskStatus,
  EditProject,
  ExportPreset,
  ExportRequest,
  FilePath,
  Id,
  Job,
  Notice,
  ObsPreview,
  ObsState,
  PickPathRequest,
  PreflightCheck,
  ProjectSummary,
  RevealTarget,
  Session,
  SessionProfile,
  SessionProfileInput,
  SessionStep,
  Settings,
  SettingsPatch,
  ShortcutAction,
  ShortcutStatus,
  StatusStrip,
  Telemetry,
  ValidationIssue,
  Waveform,
  type DriftError,
  type Result,
} from './dto';

const Empty = z.object({}).strict();
const Void = z.null();
const ById = z.object({ id: Id }).strict();

function m<I extends z.ZodType, O extends z.ZodType>(input: I, output: O) {
  return { input, output };
}

export const methods = {
  // --- system -------------------------------------------------------------
  'system.getCapabilities': m(Empty, Capabilities),
  'system.getStatusStrip': m(Empty, StatusStrip),
  'system.getTelemetry': m(Empty, Telemetry),
  'system.getDisk': m(z.object({ path: FilePath.nullable() }).strict(), DiskStatus.nullable()),
  'system.pickPath': m(PickPathRequest.strict(), z.array(FilePath)),
  'system.reveal': m(z.object({ target: RevealTarget }).strict(), Void),
  'system.openOutput': m(z.object({ jobId: Id }).strict(), Void),
  'system.exportDiagnostics': m(Empty, z.object({ path: FilePath })),
  'system.listNotices': m(Empty, z.array(Notice)),

  // --- settings -----------------------------------------------------------
  'settings.get': m(Empty, Settings),
  'settings.update': m(SettingsPatch, Settings),
  'settings.setObsPassword': m(z.object({ password: z.string().max(512).nullable() }).strict(), Settings),
  'settings.getShortcutStatus': m(Empty, z.array(ShortcutStatus)),

  // --- obs ----------------------------------------------------------------
  'obs.connect': m(Empty, ConnectionStatus),
  'obs.disconnect': m(Empty, ConnectionStatus),
  'obs.getState': m(Empty, ObsState),
  'obs.setScene': m(z.object({ sceneName: z.string().min(1).max(256) }).strict(), ObsState),
  'obs.startRecording': m(Empty, ObsState),
  'obs.stopRecording': m(Empty, ObsState),
  'obs.startReplayBuffer': m(Empty, ObsState),
  'obs.stopReplayBuffer': m(Empty, ObsState),
  /**
   * Accepted != completed. Resolves once OBS accepted the save request; the
   * saved file arrives asynchronously as `replay.saved` then `clip.added`.
   */
  'obs.saveReplay': m(Empty, z.object({ requestId: Id, acceptedAt: z.string() })),
  /** Broadcasting requires an explicit confirmation flag from a dedicated Go Live control. */
  'obs.startStream': m(z.object({ confirm: z.literal(true) }).strict(), ObsState),
  'obs.stopStream': m(z.object({ confirm: z.literal(true) }).strict(), ObsState),
  'obs.getPreview': m(z.object({ width: z.number().int().min(160).max(1920) }).strict(), ObsPreview),

  // --- audio --------------------------------------------------------------
  'audio.list': m(Empty, z.array(AudioSource)),
  'audio.setMute': m(z.object({ sourceId: Id, muted: z.boolean() }).strict(), AudioSource),
  'audio.setVolume': m(z.object({ sourceId: Id, volumeDb: Db }).strict(), AudioSource),
  'audio.setMeterSubscription': m(z.object({ enabled: z.boolean() }).strict(), Void),

  // --- profiles -----------------------------------------------------------
  'profiles.list': m(Empty, z.array(SessionProfile)),
  'profiles.get': m(ById, SessionProfile),
  'profiles.validate': m(z.object({ profile: SessionProfileInput }).strict(), z.array(ValidationIssue)),
  'profiles.save': m(z.object({ profile: SessionProfileInput }).strict(), SessionProfile),
  'profiles.duplicate': m(ById, SessionProfile),
  'profiles.delete': m(ById, Void),

  // --- sessions -----------------------------------------------------------
  'sessions.preflight': m(z.object({ profileId: Id }).strict(), z.array(PreflightCheck)),
  'sessions.plan': m(z.object({ profileId: Id }).strict(), z.array(SessionStep)),
  'sessions.start': m(z.object({ profileId: Id }).strict(), Session),
  'sessions.cancel': m(ById, Session),
  'sessions.end': m(ById, Session),
  'sessions.list': m(z.object({ limit: z.number().int().min(1).max(200) }).strict(), z.array(Session)),
  'sessions.get': m(ById, Session),
  'sessions.getActive': m(Empty, Session.nullable()),
  'sessions.updateNotes': m(z.object({ id: Id, notes: z.string().max(20000) }).strict(), Session),

  // --- clips --------------------------------------------------------------
  'clips.list': m(ClipQuery.strict(), z.object({ items: z.array(ClipAsset), total: z.number().int() })),
  'clips.get': m(ById, ClipAsset),
  'clips.import': m(z.object({ paths: z.array(FilePath).min(1).max(200) }).strict(), z.array(ClipImportResult)),
  'clips.update': m(
    z
      .object({
        id: Id,
        tags: z.array(z.string().max(40)).max(32).optional(),
        favorite: z.boolean().optional(),
        gameTitle: z.string().max(120).nullable().optional(),
      })
      .strict(),
    ClipAsset,
  ),
  'clips.relink': m(z.object({ id: Id, path: FilePath }).strict(), ClipAsset),
  'clips.verify': m(Empty, z.object({ checked: z.number().int(), missing: z.number().int() })),
  /** Removes from the library only. Original media files are never deleted. */
  'clips.remove': m(ById, Void),
  'clips.getWaveform': m(z.object({ id: Id, resolution: z.number().int().min(1).max(200) }).strict(), Waveform),
  'clips.listGames': m(Empty, z.array(z.string())),

  // --- projects -----------------------------------------------------------
  'projects.list': m(Empty, z.array(ProjectSummary)),
  'projects.get': m(ById, EditProject),
  'projects.createFromClip': m(z.object({ clipId: Id, name: z.string().max(120).nullable() }).strict(), EditProject),
  /** Rejects with CONFLICT if `project.revision` is not the stored revision. */
  'projects.save': m(z.object({ project: EditProject }).strict(), EditProject),
  'projects.delete': m(ById, Void),
  'projects.applyPreset': m(z.object({ id: Id, presetId: Id }).strict(), EditProject),

  // --- exports / jobs -----------------------------------------------------
  'presets.list': m(Empty, z.array(ExportPreset)),
  'exports.enqueue': m(ExportRequest.strict(), Job),
  'jobs.list': m(Empty, z.array(Job)),
  'jobs.cancel': m(ById, Job),
  'jobs.retry': m(ById, Job),
  'jobs.clearFinished': m(Empty, Void),

  // --- transcription (optional) -------------------------------------------
  'transcription.transcribeProject': m(ById, Job),
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type MethodInput<M extends MethodName> = z.input<Methods[M]['input']>;
export type MethodOutput<M extends MethodName> = z.output<Methods[M]['output']>;

export const events = {
  'obs.state': ObsState,
  'connection.changed': ConnectionStatus,
  'audio.meters': AudioMeters,
  'audio.changed': z.array(AudioSource),
  'replay.saved': z.object({ path: FilePath, requestId: Id.nullable(), savedAt: z.string() }),
  'clip.added': ClipAsset,
  'clip.updated': ClipAsset,
  'job.updated': Job,
  'session.updated': Session,
  'notice': Notice,
  'shortcut.triggered': z.object({ action: ShortcutAction }),
} as const;

export type Events = typeof events;
export type EventName = keyof Events;
export type EventPayload<E extends EventName> = z.output<Events[E]>;

export const METHOD_NAMES = Object.keys(methods) as MethodName[];
export const EVENT_NAMES = Object.keys(events) as EventName[];

/** IPC channel names. The renderer never sees raw ipcRenderer. */
export const IPC = {
  invoke: 'drift:invoke',
  event: 'drift:event',
} as const;

/** The interface both adapters implement. */
export interface DriftClient {
  readonly mode: 'desktop' | 'demo';
  invoke<M extends MethodName>(method: M, input: MethodInput<M>): Promise<Result<MethodOutput<M>>>;
  on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void): () => void;
}

/** Shape of the object exposed on `window.driftDesktop` by the preload script. */
export interface DriftDesktopBridge {
  readonly contractVersion: string;
  invoke(method: string, input: unknown): Promise<Result<unknown>>;
  on(event: string, handler: (payload: unknown) => void): () => void;
}

export function errorResult(error: DriftError): { ok: false; error: DriftError } {
  return { ok: false, error };
}
