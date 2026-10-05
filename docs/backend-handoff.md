# Drift Studio — backend handoff (Claude, functionality)

Status date: 2026-10-05. Branch: `claude/wizardly-johnson-9f4gfl`.

## Read this first

- **The frontend did not exist when this was written.** `chatgpt/drift-studio-frontend` was still at the initial commit and there was no `docs/frontend-handoff.md`. So nothing here has been wired to ChatGPT's screens yet. The services, IPC bridge, contract and `DesktopAdapter` are done and tested. Connecting them to the UI is the next integration step, described in [Integrating the frontend](#integrating-the-frontend).
- The contract was written first, as the master prompt asks. If ChatGPT's frontend already defines its own DTOs, reconcile them against `src/shared/contracts.ts`. Change both sides together (see `docs/contract.md`) rather than forking the contract.
- **Nothing has been tested on Windows or against real OBS yet.** See [Verification status](#verification-status).

## Architecture

```
src/shared/         contract: zod DTOs (contracts.ts), method/event registry (api.ts),
                    preload allowlists (channels.ts), defaults/presets, DesktopAdapter
src/services/       all functionality, no Electron imports (runs under plain Node in tests)
  DriftCore.ts      composition root + method handlers + capabilities
  core/             db (node:sqlite), errors, logger (redacting, rotating), safe paths, child processes
  obs/              obs-websocket v5 client: reconnect, state cache, async replay save, stats, meters
  audio/            OBS inputs (mute/volume/meters/device identity) + Windows endpoints (read-only)
  library/          clip indexing: ffprobe, partial-hash duplicates, thumbnails, waveforms, relink
  projects/         non-destructive edit projects with optimistic concurrency
  media/            ffmpeg toolkit (probe, peaks, HW encoder detection) + export filtergraph builder
  jobs/             persistent job queue, export + proxy handlers, validation
  sessions/         profiles, preflight, step plan/runner, launcher (exe/URI allowlist, process detection)
  settings/         settings + OS-protected OBS password, global shortcuts
  transcription/    optional local whisper.cpp
src/main/main.ts    Electron: window hardening, drift-app:// + drift-media:// protocols, CSP, IPC
src/preload/        sandboxed bridge → window.driftDesktop { contractVersion, invoke, on }
```

Request path: renderer → `DriftClient.invoke` → `window.driftDesktop.invoke` (allowlisted names) → `ipcMain` (sender origin checked) → `DriftCore.invokeRaw` (zod-validated, unknown names rejected) → service. Errors come back as `Result` values and are never thrown across IPC.

### Security model

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, no `<webview>`.
- The renderer is served from `drift-app://renderer/` with a strict CSP (`script-src 'self'`, no inline scripts, no eval, no remote fonts). The Electron smoke test confirms inline scripts are blocked.
- In-app navigation is locked to the app origin. `window.open` is denied. Only `https:` links open, and they open in the default browser.
- Permissions: only audio-only `media` (mic level preview) and sanitized clipboard writes.
- `drift-media://` resolves **library IDs only**, never paths. CORS allows the app origin only.
- Child processes always use argument arrays (`shell: false`). Launcher URIs are limited to `steam`, `com.epicgames.launcher`, `uplay`, `origin`, `origin2`, `battlenet`, `link2ea`, `heroic`, `goggalaxy`. Executables must be `.exe` or `.lnk` on Windows.
- Tool paths (ffmpeg, ffprobe, whisper) must have the expected file names.
- **Residual risk:** game and companion executables are chosen by the user, and manual path entry is allowed. A compromised renderer could therefore save a profile that launches any `.exe`. This is mitigated by the CSP and by never loading remote content. A stricter option, if wanted later: only accept executable paths that came from `system.pickPath`.

## Capability / status matrix

Legend: ✅ implemented and covered by tests · 🟡 implemented, not verified against the real dependency · ⛔ deliberately unavailable (the UI must show the reason) · ⏳ pending.

| Area | Feature | Status | Notes |
| --- | --- | --- | --- |
| OBS | Connect, password auth, auto-reconnect with backoff, auth-failure stop | ✅ / 🟡 | Tested against a protocol-level fake. Real OBS 30/31 not tested. |
| OBS | State: scenes, recording, replay buffer, stream, stats, actions done in OBS | ✅ / 🟡 | |
| OBS | Save replay (accepted → `ReplayBufferSaved` → import), lost-event recovery | ✅ / 🟡 | Uses `GetLastReplayBufferReplay` after 30 s. |
| OBS | Replay buffer disabled in OBS → explained | ✅ | |
| OBS | Scene switch, start/stop recording and replay buffer | ✅ / 🟡 | |
| OBS | Go Live / End stream with explicit `confirm: true` | ✅ / 🟡 | Never triggered by sessions or profile changes. |
| OBS | Preview | 🟡 | Still frames (`GetSourceScreenshot`), not live video. The capability text says so. |
| OBS | Replay length check | 🟡 | Reads `RecRBTime` from the OBS profile and warns on a mismatch. Never changed silently. |
| Audio | OBS inputs: list, mute, volume, device name behind input | ✅ / 🟡 | |
| Audio | Meters (`InputVolumeMeters`, ~10 Hz, opt-in) | 🟡 | Event mapping is unit-tested. Real OBS not tested. |
| Audio | Windows endpoints | 🟡 | Names and status via `Get-PnpDevice`, read-only. Not run on Windows. |
| Audio | Windows device volume/mute, viewer/headphone mixes | ⛔ | Not implemented; the UI must label it unavailable. |
| Library | Import, ffprobe metadata, thumbnails, waveforms, tags, favorites, search, filters | ✅ | Real ffmpeg. |
| Library | Duplicate detection (size + first/last MiB hash), missing-file verify + relink | ✅ | |
| Library | Auto-import of replays/recordings, linked to the active session | ✅ / 🟡 | |
| Library | Proxy playback (MKV remux / HEVC transcode to 720p H.264) | ✅ | MKV remux tested. |
| Editing | Projects: trims, splits (= more items), order, per-item gain/fades, crop, webcam overlay, captions, music, fades, presets | ✅ | Model + export. Undo/redo is a renderer concern: keep a history stack and save via `projects.save`. |
| Editing | Draft autosave with optimistic concurrency | ✅ | `CONFLICT` on stale revision. |
| Export | FFmpeg render, real progress, cancel, retry, validation (duration, streams, A/V sync), temp file + rename, collision-safe names | ✅ | |
| Export | Hardware encoders (NVENC/QSV/AMF), detected by test-encoding, falls back to software on failure | 🟡 | No GPU here, so only the software path ran. |
| Export | Storage check, below-normal priority while a session is active | ✅ / 🟡 | |
| Export | Caption burn-in (libass) | ✅ | Capability is false when the ffmpeg build lacks libass. |
| Sessions | Profiles CRUD/duplicate/validate, preflight, plan preview, step runner, cancel, partial-failure recovery text | ✅ | |
| Sessions | Game launch by exe/URI, duplicate-process detection | ✅ / 🟡 | Exe launch and detection tested on Linux. `tasklist` path not run on Windows. |
| Jobs | Persistent queue, bounded concurrency, INTERRUPTED recovery after restart | ✅ | |
| Settings | OS-protected OBS password (safeStorage/DPAPI) | 🟡 | Falls back to memory-only and reports it. |
| Shortcuts | Global shortcuts via `globalShortcut`, conflict reporting, `--safe-mode` | ✅ / 🟡 | No keyboard hooks. |
| Transcription | Local whisper.cpp → captions | 🟡 | Parser tested. The CLI run is untested here. Optional. |
| Telemetry | OBS render FPS, encoder skipped frames, OBS CPU, disk free | ✅ / 🟡 | |
| Telemetry | Game FPS | ⛔ | Not measured: no hooking or injection. A PresentMon integration could be added later. |
| Stream Deck | Native plugin | ⏳ | Use Stream Deck's built-in **Hotkey** action with the global shortcuts for now. |
| Diagnostics | Redacted JSON export, rotating local logs | ✅ | Nothing is uploaded. |
| Packaging | electron-builder NSIS x64 config. `win-unpacked` builds from Linux. | 🟡 | Installer not built here (NSIS needs Windows or wine). Unsigned. No app icon yet. |

## Integrating the frontend

1. **Choose an adapter once, at startup:**
   ```ts
   import { DesktopAdapter, getDesktopBridge } from '../shared/client/DesktopAdapter';
   const client: DriftClient = getDesktopBridge()
     ? new DesktopAdapter({ validateResponses: import.meta.env.DEV })
     : new DemoAdapter(); // browser preview only; keep the persistent "Demo mode" label
   ```
   Do not catch DesktopAdapter errors and switch to demo data.
2. **Build the renderer into `dist/renderer/`** with Vite `base: './'` (or `/`), so `drift-app://renderer/index.html` loads it. Bundle fonts locally (e.g. `@fontsource/*`), because the CSP blocks Google Fonts by design. For development, run Vite and start Electron with `DRIFT_RENDERER_URL=http://localhost:5173`.
3. **Read capabilities on load** and again on every `connection.changed`. Disable controls whose `Capability.available` is false and show `reason`. This covers "every visible control works or explains why".
4. **Screen wiring:**

| Screen | Read | Act | Listen |
| --- | --- | --- | --- |
| Shell / header / status strip | `system.getStatusStrip`, `obs.getState`, `system.listNotices`, `sessions.getActive` | — | `obs.state`, `connection.changed`, `job.updated`, `notice`, `session.updated` |
| First run | `settings.get` | `system.pickPath` → `settings.update({ media })`, `settings.update({ obs })` + `settings.setObsPassword` + `obs.connect`, `profiles.save`, mic: renderer `getUserMedia({ audio: true })`, then `settings.update({ firstRunComplete: true })` | `connection.changed` |
| Command Center hero | `profiles.list`, `sessions.plan`, `sessions.preflight` | `sessions.start`, `sessions.cancel`, `sessions.end` | `session.updated` (step statuses, `recovery`) |
| Controls row | `obs.getState` | `obs.startRecording/stopRecording`, `obs.startReplayBuffer/stopReplayBuffer`, `obs.setScene`, `audio.setMute` (mic), `obs.saveReplay` | `obs.state`, `replay.saved`, `clip.added` |
| Live preview | `obs.getPreview({ width: 960 })` at ≤ 2 fps while visible | — | — |
| Recent highlights | `clips.list({ source: 'replay', limit: 8 … })` | `projects.createFromClip` → ClipForge | `clip.added`, `clip.updated` |
| Telemetry | `system.getTelemetry` every 2 s | — | — |
| ClipForge browser | `clips.list`, `clips.listGames` | `clips.import` (via `system.pickPath({ kind: 'files', purpose: 'import' })`), `clips.update`, `clips.relink`, `clips.remove` | `clip.added`, `clip.updated` |
| ClipForge editor | `projects.get`, `clips.getWaveform`, `presets.list` | `projects.save` (autosave, send the loaded revision), `projects.applyPreset`, `transcription.transcribeProject` | `job.updated` |
| Preview `<video>` | `ClipAsset.playbackUrl`. If `playback === 'proxy-pending'`, show "Preparing playback"; if `'unplayable'`, explain. | — | `clip.updated` (proxy ready) |
| Export / queue | `jobs.list` | `exports.enqueue`, `jobs.cancel`, `jobs.retry`, `system.openOutput`, `system.reveal({ kind: 'jobOutput' })` | `job.updated` |
| Sessions | `sessions.list`, `sessions.get` | `sessions.updateNotes` | `session.updated` |
| Stream Controls | `obs.getState` | `obs.setScene`, `obs.connect/disconnect`, Go Live → confirm dialog → `obs.startStream({ confirm: true })` | `obs.state`, `connection.changed` |
| Audio | `audio.list` | `audio.setMute`, `audio.setVolume`, `audio.setMeterSubscription(true/false)` on mount/unmount | `audio.meters`, `audio.changed` |
| Profiles | `profiles.list`, `profiles.validate` (as the user types) | `profiles.save`, `profiles.duplicate`, `profiles.delete`, `system.pickPath({ purpose: 'game' })` | — |
| Settings | `settings.get`, `settings.getShortcutStatus`, `system.getCapabilities` | `settings.update`, `settings.setObsPassword`, `system.exportDiagnostics`, `system.reveal({ kind: 'logs' })`, `clips.verify` | `shortcut.triggered` |

5. **State handling rules:**
   - Disable a button while its request is pending. The backend also de-duplicates.
   - "Saving replay…" lasts from the `obs.saveReplay` result until the `replay.saved`/`clip.added` with the same `requestId`.
   - Only show an export as done when `job.state === 'succeeded'`. `outputPath` is set only after ffprobe validation.

## Running, testing, packaging

Prerequisites: Node ≥ 22.13 (dev), and FFmpeg + ffprobe on PATH or set in Settings. For full use on Windows: OBS Studio 28+ with **Tools → WebSocket Server Settings → Enable**, and the replay buffer enabled under **Settings → Output**.

```bash
npm install
npm run typecheck          # tsc (strict)
npm test                   # vitest: contract/unit + integration (real ffmpeg, fake OBS server)
npm start                  # build main/preload, launch Electron (shows a diagnostics page until dist/renderer exists)
npm run start:safe         # same, with global shortcuts disabled
npm run smoke:electron     # real Electron + Playwright checks (Linux needs xvfb-run; as root it adds --no-sandbox)
npm run dist:win           # NSIS installer → release/ (run on Windows)
```

- Bundling: esbuild bundles main and preload into `dist/`. The asar contains only `dist/**` and `package.json`, with no native modules: SQLite is the built-in `node:sqlite` of Electron's Node 24.
- FFmpeg: not bundled by default. To bundle, put `ffmpeg.exe`/`ffprobe.exe` in `resources/ffmpeg/` before `dist:win`, and ship the matching licence (LGPL vs GPL build).
- App data lives in `%APPDATA%/Drift Studio`: `drift-studio.db`, `logs/`, `derived/` (thumbnails, peaks, proxies), and `secrets.json` (DPAPI-encrypted).
- Before release: add an app icon (`build/icon.ico`, the Drift emblem) and a code-signing certificate.

## Verification status

**Run here (Linux container, no GPU, no OBS):**

- `npm test`: 42 tests passing.
  - Contract/unit tests.
  - Real-ffmpeg integration: vertical slice 2, i.e. import → waveform → trim → save → export with audio → ffprobe duration and A/V check. Also multi-segment vertical export with crop, webcam overlay, captions and music; cancel, retry and cleanup; missing file → relink → retry; duplicates; MKV proxy; INTERRUPTED recovery.
  - Fake-OBS integration: vertical slice 1, i.e. connect → start replay buffer → save replay → clip indexed. Also auth failure, reconnect, lost event, actions done in OBS, audio, shortcuts, and that a session never streams.
- `npm run smoke:electron`: 19/19. Real Electron 44 with the sandboxed preload. Covers IPC validation, OBS connect and replay save from the renderer, the drift-media thumbnail and Range/206, `<video>` playback, navigation and popup blocking, and CSP enforcement.
- `electron-builder --win dir`: produced `Drift Studio.exe` (unsigned) with a 1.2 MB asar.

**Not verified. Windows smoke checklist for a real machine:**

1. Install from the NSIS build. Launch it. The first run stores folders, the OBS password survives a restart, and the app runs with no FFmpeg (capability explains) and then with FFmpeg on PATH.
2. OBS 30/31: connect, then wrong password (no retry loop), then close and reopen OBS (auto-reconnect), then start recording from OBS (UI reflects it).
3. Replay buffer disabled (explained) → enabled → start → Save Replay via button and via the global shortcut while a game is focused → clip appears with thumbnail → plays (MKV proxy if OBS records MKV).
4. Profile with `steam://rungameid/…` and an `.exe` game. Check the preflight, including mic device name and capture source. Start a session, start again while the game is running (no duplicate), cancel mid-way, read the recovery text.
5. Trim → export with each preset. Play the file. Check A/V sync visually around a clap or flash. Test NVENC/QSV/AMF where present, cancel an export, export with a nearly full disk, export after deleting the source (MEDIA_MISSING → relink → retry).
6. Meters move with mic input. Mute/volume reflect in OBS. Windows devices are listed with the unsupported note.
7. Kill the app during an export → restart → job shows INTERRUPTED with Retry.
8. Diagnostics export contains no password or home paths.

## Pending / suggested next work

- Wire ChatGPT's UI through the `DesktopAdapter` once the frontend lands (table above), and run the Windows checklist.
- Stream Deck plugin (optional), PresentMon-based game FPS (optional), and live preview via OBS virtual camera or NDI (optional).
- Undo/redo history stays in the renderer. The backend persists every saved revision only as the latest one.
