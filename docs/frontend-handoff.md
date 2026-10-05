# Frontend handoff — Claude

## Ownership and branch

ChatGPT owns this renderer. Continue backend work on a separate `claude/…` branch based on `chatgpt/drift-studio-frontend` (or its merged commit). Preserve the seven destinations and the capture-to-edit journey. No automatic assistant-to-assistant communication occurs; this document is the handoff.

The supplied repository was empty. Only the master prompt was attached; no separate reference image was available. All chrome ribbon, environment illustrations, icons, and CSS are original frontend assets. Fixture art is explicitly illustrative, never presented as actual gameplay or an OBS feed.

## Architecture

| Location | Responsibility |
|---|---|
| `src/renderer/main.tsx` | Bootstrap, bridge selection, loading/failure UI, render error boundary |
| `src/renderer/App.tsx` | Rail, header, demo banner, command palette, setup, notifications, bottom strip |
| `src/renderer/context.tsx` | Navigation, selection, notifications, operation pending state, ephemeral media URL registry |
| `src/renderer/screens/CommandCenter.tsx` | Hero, profile preflight, capture controls, activity, recent clips |
| `src/renderer/screens/ClipForge.tsx` | Browser/editor/inspector/timeline, draft history, import, transport, export dialogs |
| `src/renderer/screens/Supporting.tsx` | Sessions, Stream Controls, Audio, Profiles and Settings |
| `src/renderer/components` | Accessible primitives, modal focus trap, custom icons, illustrative art, media posters |
| `src/renderer/media.ts` | Browser-only metadata and thumbnail inspection |
| `src/shared/contracts.ts` | Protocol v1 DTOs, operation map, bridge and service interfaces |
| `src/shared/validation.ts` | Runtime request, snapshot, response and capability checks |
| `src/services/DemoAdapter.ts` | Persistent fixtures and bounded simulated transitions |
| `src/services/DesktopAdapter.ts` | Validated restricted bridge client; no demo fallback |
| `src/services/fixtures.ts` | Explicit sample data and blank edit-project creation |

React context owns view state. Service snapshots use `useSyncExternalStore`; updates must replace the snapshot object. Components never import Electron or Node. The renderer can be built independently with Vite. Navigation is an in-app route union, intentionally no network-dependent URL routing. On reload the app opens Command Center.

## Visual tokens and layout

`styles.css` defines the identity: foundation `#08090c`, panel `#101216`, raised `#171a20`, separator `#252930`, crisp white text, secondary `#929aa9`, icy cyan `#8ce8ee`, violet `#bca6ff`, amber `#f7cb7a`. Panel corners are 14px; buttons/fields 8px. Use the existing 4/8/12/16/20/24/32 spacing rhythm. Typography is a local system sans stack: no remote font calls. Telemetry uses tabular/monospace numbers.

Command Center has an asymmetric hero and preflight panel, capture desk and pulse, then recent media. ClipForge is a three-column desktop workspace with the timeline below; its first row scales to window height. At <=1000px the inspector moves below the timeline, and at <=760px the library becomes horizontal and navigation collapses. Reduced-motion preferences disable transition effects. Decorations remain static while gaming.

Keep controls meaningful. Start Session, Start Recording and Go Live are different actions. Going live opens a destination confirmation. Profile changes do not stop broadcasting. The demo's completed exports say **Simulation finished**, retain `outputHandle: null`, and explain why no output can be opened.

## Protocol v1

All times in models are milliseconds; timestamps are UTC ISO-8601 strings. IDs are opaque strings (UUIDs or fixture IDs). Measurements are `null` when unavailable. Paths in profiles/settings are configuration strings, not shell command payloads. `mediaHandle` and `outputHandle` identify authorized files, not arbitrary renderer file access.

DTOs: `ConnectionStatus`, `Capabilities`, `SessionProfile`, `Session`, `OBSState`, `AudioSource`, `ClipAsset`, `EditProject`, `TimelineTrack`, `ExportPreset`, `Job`, `StructuredError`, `StudioSettings`, `StudioSnapshot`.

The main process must validate again. `validateRequest` is a renderer guard, not a security boundary. Paths must be canonicalized, access checked, launch URIs allowlisted, and every configured executable/companion app validated. Use argument arrays for child processes. Never interpret profile fields as shell commands. Validate segment bounds against probed source durations, caption limits against draft duration, profile/scene IDs against actual discovery, integer frame/time values, file sizes and encoding compatibility. Require idempotent request handling using the bridge's request ID.

Operations are in `OperationMap`: connect/disconnect, profile selection/save, preparation/start/end and launch, recording/replay/save, scenes/broadcast, OBS audio, clip import/update, draft save, export/cancel/retry/open, settings, notes. `scenario` and `reset` are demo-only and rejected by DesktopAdapter.

### Preload implementation

Expose **only** this bridge through contextBridge:

```ts
window.drift = {
  apiVersion: 1,
  readState(): Promise<unknown>,
  request(operation, input, requestId): Promise<unknown>,
  onState(listener): () => void
}
```

`readState` and each event return a complete protocol-1 snapshot with `mode: 'desktop'`. `onState` is the event boundary: connection, OBS changes (including those made directly in OBS), new clips, queue progress and warnings become atomic state snapshots. Subscribe before the initial read. Queue/revision the initial snapshot and events on main to prevent a stale read replacing a newer event. Return operation-specific outputs described by `OperationMap`. Void operations return undefined/null. Reject with a sanitized structured service error. Do not expose ipcRenderer, Node, arbitrary paths/shell execution, or generic IPC channel selection.

Enable contextIsolation, disable nodeIntegration, sandbox where supported, restrict navigation/window creation, and configure a restrictive production CSP. The renderer has no Electron dependencies or main/preload implementation yet. If the bridge is present but fails/version-mismatches, bootstrap displays a retryable desktop failure; it never renders demo fixtures.

### Media integration points

Browser mode uses `<input type=file>`, object URLs and `readLocalVideo`. Those opaque browser handles are **not** desktop filesystem handles. For Electron, wire the import/Locate Recording buttons to a narrow native file picker and have main index selected paths, ffprobe media, create thumbnails and return authorized handles. Provide local protocol/proxy media URLs through a safe resolver and register them in the renderer's media registry. Do not give the renderer arbitrary `file://` paths. Music import requires the same secure picker/resolver. Returned `thumbnailUrl` is already rendered; `OBSState.previewUrl` is supported in Command Center. Stream Controls' program monitor still needs wiring to the same actual preview source. No preview support should yield the explanatory placeholder.

For browser imports, file duration and a thumbnail are real; filename equality is only a lightweight duplicate check, not a content hash. Blob URLs expire across restart; persisted imported assets become missing and require relink. Main should replace that with a persistent index, fingerprints and missing-file watchers.

## Editing model and behavior

Edits never touch originals. One source asset per draft is supported in this first frontend. Video track segments contain source in/out, output offset, gain and fades. Splitting creates two segments; reordering reflows offsets. Trim edits reflow offsets too. The project clock drives seeking into the selected source segment. Preview crop uses object-position; canvas aspect matches the draft. Caption font sizes use output canvas pixels and scale down to preview width. Safe-area/webcam overlays are layout guides; webcam is not a connected source.

Draft history keeps up to 50 edits. Autosave debounces 450ms and flushes when leaving the editor; modified project timestamps are explicit. Local-storage failures are surfaced. Main should serialize/coalesce draft writes and persist atomically to SQLite; reject stale revisions when needed. Caption ranges need revalidation/clamping if later trims shorten the output. The UI permits editing all caption timings/styles but does not automatically retime captions after arbitrary timeline changes.

Source volume reflects original gain, segment gain and audio fades. Imported music can be previewed with gain; no music download is offered. Browser waveform decoding is limited to clips <=5 minutes and advertised sizes <=128MiB. The fallback is labeled **Illustrative waveform**. The displayed waveform is an analysis of the source, not a precision multitrack output render. Timeline thumbnails for fixture segments are illustrative; actual per-frame timeline thumbnail indexing, proxy playback, crossfade transitions, multiple imported assets/tracks, music fades and frame-accurate playback remain service/editor enhancement points. Do not claim browser requestAnimationFrame seeking is frame-accurate final rendering. Use a proper media clock/proxy for demanding footage.

Presets are inspectable: Clean Highlight sets no fades; Cinematic sets 400ms/600ms segment audio fades and music gain 0.25; Vertical Short sets 9:16 and caption size 42; Squad Recap sets widescreen with clean cuts. No flashing transitions. Presets do not claim advanced automatic montage editing.

## Demo state and recovery

Browser storage key: `drift-studio.demo.v1`. Demo connection begins disconnected. Connecting takes 550ms; entering host `fail` simulates a failed connection. Start Session runs preflight and starts a simulated replay buffer without recording/broadcast. Saved replays are new fixtures, never actual files. The export queue progresses in 8-point steps at 250ms intervals; failure occurs around 48% when requested. Cancel stops its timer. Retry produces a new simulation. Interrupted queue items become recoverable failures after restart.

Settings → Diagnostics provides normal/missing/empty/failed/storage scenarios and a confirmed reset. Production rejects these operations. Capability flags gate adapter requests and capture controls; main must gate again. Unsupported controls explain their limits, e.g. Windows audio, transcription, source visibility and Open Output.

## Verified

- Production TypeScript/Vite build.
- 14 Node contract/adapter tests: validation, offline capture, session flow, duplicate requests, reconnect, broadcast preservation, hotkey conflicts, persistence, export failure/retry/cancel, desktop failure and invalid bridge responses.
- 38 Chromium browser checks: screen layouts at 1920×1080, 1440×900, 1024×768 and 390×844; capture/broadcast separation; profile edit; presets; trim/undo/redo; split/order; captions; quick mode; queue recovery; palette keyboard focus; empty/missing states; actual synthetic local-video import, trimmed playback, restart and relink.
- No horizontal page overflow at checked sizes. No observed runtime page errors.
- Semantic buttons/labels, disabled states, visible focus, modal Tab trap/Escape restoration, skip link, status announcements and reduced-motion CSS. These are focused accessibility checks, not a comprehensive WCAG certification or screen-reader audit.

See `browser-verification.json` and screenshots. Tests are browser/mocked contract evidence, **not** Windows capture/export tests. No OBS instance, Windows devices, game launch, real encoder/output, A/V export sync or installer has been verified.

## Dependencies

Versions are locked to the environment's available, build-tested cache: React/React DOM 18.3.1 (MIT), Vite 5.4.21 (MIT), plugin-react 4.7.0 (MIT), TypeScript 5.2.2 (Apache-2.0), esbuild 0.21.5 (MIT), Playwright 1.51.1 (Apache-2.0), React type packages (MIT). Current official React/Vite docs were checked; these pins are not represented as latest. npm registry metadata access timed out here, so newer-package install/audit was unavailable. Before desktop packaging, review current patched releases and licenses, update pins together and rerun the included checks. This app uses client React, no React Server Components. Vite defaults to localhost; never ship its development server as the desktop runtime.

## Claude's first vertical slices

1. Provide a secure Electron/preload shell and a real snapshot with honest capabilities. Read docs/desktop-packaging.md.
2. Connect OBS using current official obs-websocket requests; react to native OBS state/events. Configure/start its replay buffer and await asynchronous ReplayBufferSaved before adding a real ClipAsset.
3. Index that replay, resolve its local playback URL, save a draft and render a trimmed file with original audio via FFmpeg. Write to temporary output, validate with ffprobe, then mark completion with an output handle.
4. Add native profiles/game launch with duplicate-process detection, persistent sessions, folder/device discovery, lower-priority bounded jobs, cancellation and restart recovery.
5. Implement actual scene/source/mixer controls, preview and telemetry where supported; captions/music/export transforms must match the renderer model. Add optional transcription and Stream Deck plugin later.
6. Maintain docs/backend-handoff.md and update the integration matrix with real verified results. Finish a Windows launch → replay → trim → export → playback smoke test, including disconnects, storage failures and A/V sync checks.
