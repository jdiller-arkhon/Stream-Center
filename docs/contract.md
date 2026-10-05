# Drift Studio shared contract (v1.0.0)

Source of truth: `src/shared/contracts.ts` (DTOs + zod schemas) and `src/shared/api.ts` (method/event registry, `DriftClient`).
Both adapters implement `DriftClient`:

```ts
interface DriftClient {
  readonly mode: 'desktop' | 'demo';
  invoke<M extends MethodName>(method: M, input: MethodInput<M>): Promise<Result<MethodOutput<M>>>;
  on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void): () => void;
}
type Result<T> = { ok: true; data: T } | { ok: false; error: DriftError };
```

- **DesktopAdapter** — `src/shared/client/DesktopAdapter.ts`. Wraps `window.driftDesktop` (preload). Throws if the bridge is missing or the contract major differs. Never falls back to demo data. Pass `validateResponses: true` in development to validate every response/event against the schemas.
- **DemoAdapter** — owned by the frontend. Fixtures must parse with the same schemas (recommend a test: `methods[m].output.parse(fixture)` for every method).

## Conventions

| Rule | Detail |
| --- | --- |
| IDs | Opaque strings (`clip_…`, `proj_…`, `job_…`). Never parse. |
| Time | Durations/offsets are integer **milliseconds** suffixed `Ms`. Timestamps are ISO-8601 UTC strings suffixed `At`. |
| Nullability | `null` = known absent/unavailable (UI shows the paired `reason`/`detail`). `?` only in patch inputs. |
| Inputs | Strict objects. Unknown keys → `VALIDATION`. Empty input is `{}`. |
| Errors | `DriftError { code, message, detail, retryable }`. `message` is user-facing; `detail` is for an expandable "details" area. |
| Accepted vs completed | `obs.saveReplay` resolves when OBS **accepted** the request. Completion arrives as `replay.saved` → `clip.added`. Exports return a `Job` in `queued`; follow `job.updated`. |
| Repeated requests | Duplicate `exports.enqueue`/`transcription` with identical specs return the existing active job. `obs.saveReplay` presses within 1.5 s return the same `requestId`. |
| Units for audio | dB (`-100` = silence floor). Meters are per-channel peak dBFS. |
| Media URLs | `drift-media://clip/<id>`, `…/proxy/<id>`, `…/thumb/<id>`. Use `ClipAsset.playbackUrl` for `<video>` (null while a proxy is being made), `thumbnailUrl` for `<img>`. |

## Error codes

`VALIDATION, NOT_FOUND, UNSUPPORTED, OBS_NOT_CONNECTED, OBS_AUTH_FAILED, OBS_REQUEST_FAILED, REPLAY_BUFFER_UNAVAILABLE, FFMPEG_MISSING, FFMPEG_FAILED, MEDIA_INVALID, MEDIA_MISSING, INSUFFICIENT_STORAGE, CONFLICT, BUSY, CANCELLED, INTERRUPTED, LAUNCH_FAILED, ALREADY_RUNNING, IO, TIMEOUT, INTERNAL`

## Methods

| Method | Input | Output | Notes |
| --- | --- | --- | --- |
| `system.getCapabilities` | `{}` | `Capabilities` | Drives enable/disable + explanations for every control. Re-fetch on `connection.changed`. |
| `system.getStatusStrip` | `{}` | `StatusStrip` | Bottom strip: recording, replay buffer, disk, active jobs. |
| `system.getTelemetry` | `{}` | `Telemetry` | `gameFps` is always `null` + reason. OBS render FPS and encoder stats are separate fields. |
| `system.getDisk` | `{ path \| null }` | `DiskStatus \| null` | |
| `system.pickPath` | `{ kind, purpose, title }` | `string[]` | Native dialog; `[]` if cancelled. |
| `system.reveal` | `{ target }` | `null` | Show clip / job output / logs / library in Explorer. |
| `system.openOutput` | `{ jobId }` | `null` | Only for succeeded jobs whose file still exists. |
| `system.exportDiagnostics` | `{}` | `{ path }` | Local JSON file, secrets redacted, paths redacted unless enabled. |
| `system.listNotices` | `{}` | `Notice[]` | Notification center backlog. |
| `settings.get` / `settings.update` | `{}` / `SettingsPatch` | `Settings` | Library/export dirs are created on save. Tool paths must be ffmpeg/ffprobe binaries. |
| `settings.setObsPassword` | `{ password \| null }` | `Settings` | Stored with OS protection (DPAPI via Electron safeStorage). Never returned. |
| `settings.getShortcutStatus` | `{}` | `ShortcutStatus[]` | Registration result + conflict text per action. |
| `obs.connect` / `obs.disconnect` | `{}` | `ConnectionStatus` | Connect may return `connecting`/`reconnecting`/`failed`; follow `connection.changed`. |
| `obs.getState` | `{}` | `ObsState` | Also pushed via `obs.state` (every ~2 s and on change). |
| `obs.setScene` | `{ sceneName }` | `ObsState` | |
| `obs.startRecording` / `stopRecording` | `{}` | `ObsState` | Idempotent. |
| `obs.startReplayBuffer` / `stopReplayBuffer` | `{}` | `ObsState` | `REPLAY_BUFFER_UNAVAILABLE` if disabled in OBS. |
| `obs.saveReplay` | `{}` | `{ requestId, acceptedAt }` | Async completion (see above). |
| `obs.startStream` / `stopStream` | `{ confirm: true }` | `ObsState` | Only from an explicit Go Live/End Stream control. Nothing else ever starts/stops streaming. |
| `obs.getPreview` | `{ width }` | `ObsPreview` | Still JPEG of the program scene. Poll ≤ 2 fps; stop while hidden. |
| `audio.list` | `{}` | `AudioSource[]` | OBS inputs (controllable) + Windows endpoints (read-only). |
| `audio.setMute` / `setVolume` | `{ sourceId, … }` | `AudioSource` | Windows devices → `UNSUPPORTED`. |
| `audio.setMeterSubscription` | `{ enabled }` | `null` | Enable only while a meter is visible (saves resources while gaming). |
| `profiles.list/get/validate/save/duplicate/delete` | | `SessionProfile` etc. | `save` with `id: null` creates. `validate` returns errors + warnings. |
| `sessions.preflight` | `{ profileId }` | `PreflightCheck[]` | |
| `sessions.plan` | `{ profileId }` | `SessionStep[]` | Exact actions before starting. Never contains streaming. |
| `sessions.start` | `{ profileId }` | `Session` (`preparing`) | Steps progress via `session.updated`. One active session at a time. |
| `sessions.cancel` | `{ id }` | `Session` | Remaining steps cancelled; `recovery` explains what stays running. |
| `sessions.end` | `{ id }` | `Session` | Does not stop OBS outputs; `recovery` lists what is still running. |
| `sessions.list/get/getActive/updateNotes` | | | |
| `clips.list` | `ClipQuery` | `{ items, total }` | Search over name/game/tags; filters by game/session/favorite/source. |
| `clips.import` | `{ paths }` | `ClipImportResult[]` | Per-file outcome: `imported`/`duplicate`/`failed`. |
| `clips.update` | `{ id, tags?, favorite?, gameTitle? }` | `ClipAsset` | |
| `clips.relink` / `clips.verify` | | | Missing-file recovery. |
| `clips.remove` | `{ id }` | `null` | Library only; originals are never deleted. |
| `clips.getWaveform` | `{ id, resolution }` | `Waveform` | Peaks/second up to 100. Cached after first call. |
| `clips.listGames` | `{}` | `string[]` | Game filter options. |
| `projects.list/get/delete` | | | |
| `projects.createFromClip` | `{ clipId, name }` | `EditProject` | One item covering the whole clip. |
| `projects.save` | `{ project }` | `EditProject` | Optimistic concurrency: send the revision you loaded; `CONFLICT` if stale. Returns revision+1. Use for autosave. |
| `projects.applyPreset` | `{ id, presetId }` | `EditProject` | Changes only inspectable fields (aspect, fades, gain, caption style). |
| `presets.list` | `{}` | `ExportPreset[]` | Clean Highlight, Cinematic, Vertical Short, Squad Recap. |
| `exports.enqueue` | `ExportRequest` | `Job` | |
| `jobs.list/cancel/retry/clearFinished` | | | |
| `transcription.transcribeProject` | `{ id }` | `Job` | Optional; `UNSUPPORTED` until configured. Adds captions to the project. |

## Events

| Event | Payload | When |
| --- | --- | --- |
| `obs.state` | `ObsState` | Any OBS change, including actions performed directly in OBS; plus ~2 s polling for durations/stats. |
| `connection.changed` | `ConnectionStatus` | Connect/disconnect/reconnect attempts (`retryInMs`). |
| `audio.meters` | `AudioMeters` | ~10 Hz while subscribed. |
| `audio.changed` | `AudioSource[]` | Inputs added/removed/muted/volume changed. |
| `replay.saved` | `{ path, requestId, savedAt }` | OBS wrote a replay (also for OBS-hotkey saves: `requestId` null). |
| `clip.added` / `clip.updated` | `ClipAsset` | Library changes (imports, proxies ready, tags, relink). |
| `job.updated` | `Job` | State changes immediately; progress throttled to 4/s. |
| `session.updated` | `Session` | Step progress and session events. |
| `notice` | `Notice` | For the notification center/toasts. |
| `shortcut.triggered` | `{ action }` | A global shortcut fired (e.g. show a "Saving replay…" toast). |

## Changing the contract

1. Edit `contracts.ts`/`api.ts`, and `channels.ts` (preload allowlist — a test fails if they diverge).
2. Bump `CONTRACT_VERSION` (and `CONTRACT_VERSION_FOR_PRELOAD`): major for breaking changes.
3. Update DemoAdapter fixtures and any DesktopAdapter handling; note it in both handoff docs.
