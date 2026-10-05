# Drift Studio — backend handoff (Claude, functionality)

Status date: 2026-10-05. Branch: `claude/wizardly-johnson-9f4gfl`.

## Read this first

- **The UI is connected.** ChatGPT's renderer (merged from `chatgpt/drift-studio-frontend`) runs inside Electron and talks to the real services through `window.drift`, exactly the bridge its handoff specified. Nothing falls back to demo data: the browser build stays a labelled demo, and the desktop app reports `DESKTOP MODE`.
- **Every UI function was verified end to end** in the real Electron app (`npm run test:e2e`, 38 checks). The test drives the actual UI against a fake obs-websocket server and real FFmpeg, and checks the real effect of each action: OBS state, files on disk, and ffprobe results. See [Verification status](#verification-status).
- **Not yet verified on Windows or against real OBS.** The Windows checklist below remains open.
- **Visual theme:** at the user's request the UI uses an Apple-inspired white and purple-mist theme with a multi-hue colour system (`theme-mist-base.css`, generated, plus `theme-mist.css`). Layout and behaviour are ChatGPT's, unchanged.

## Changes requested after integration

- **Profiles removed.** There is one game setup: Settings → General → Game session (game name, path or launcher link, OBS scene, Save Replay hotkey). The bridge stores it under the fixed id `setup` and maps any profile id the renderer sends onto it. Older multi-profile data migrates automatically, with the selected profile becoming the setup. The protocol is unchanged; `selectProfile` is now a no-op.
- **"Clip that" voice command** (Settings → Shortcuts, opt-in):
  - **Recogniser:** Vosk, Apache-2.0, with a 41 MB small English model, fully offline. It listens only for the closed grammar `clip that | clip it | [unk]`, with a confidence threshold and a 4 s cooldown.
  - **Isolation:** it runs in a **hidden, sandboxed voice window** (`src/voice`, served from `drift-app://voice/`). That window has its own CSP, because the WebAssembly build needs `'unsafe-eval'`, plus a two-message preload and microphone permission. The main UI keeps its strict CSP and gets no microphone access.
  - **Saving:** when the phrase is heard, main calls the same save-replay path as the button. If the replay buffer is off, the user gets a notice instead.
  - **Model files:** the model is fetched with a pinned SHA-256 by `npm run fetch:voice-model` and bundled by `desktop:package` into `resources/models`.
- **"Mark that" voice command.** Same recogniser and grammar (`mark that | mark it` added). It adds `Marker · H:MM:SS into the recording` (or session) to the active session's notes timeline, so moments are easy to find when editing. It needs a running session, not the replay buffer. `snapshot.voice.lastCommand` (`'clip' | 'mark'`, optional) tells the UI which command was heard.
- **YouTube toolkit** (desktop only). Nothing signs in to Google or uploads; the user uploads in YouTube Studio.
  - **Loud-moment finder** (`suggestMoments`): FFmpeg `ebur128` momentary loudness is streamed (10 values/s) and smoothed to 3 s short-term loudness. The loudest passages, spaced ≥ 20 s apart, are returned with how far they sit above the clip's median level. Results are cached per file and mtime. ClipForge shows them as chips that seek the playhead.
  - **Make a Short:** reframes the draft to 9:16 with safe areas, cuts up to 30 s around the loudest moment (70 % lead-up), and switches the export to 1080×1920 with loudness normalisation.
  - **Loudness normalisation:** `ExportSettings.loudnessLufs` (optional) appends single-pass `loudnorm=I=-14:TP=-1.5:LRA=11` after the mix. The UI preset field is `loudness?: boolean`. Measured result in tests: −14.0 LUFS.
  - **YouTube presets** in the export dialog: Shorts 1080×1920 / upload 1440p60, both H.264 + −14 LUFS.
  - **YouTube kit** (`youtubeKit`, from a completed job): probes and measures the real file, then checks it against YouTube's limits (MP4/H.264/AAC, Shorts ≤ 3:00 when vertical, > 15 min needs a verified account, 12 h/256 GB maximum, 16:9 or 9:16, ≥ 1080p, 24–60 fps, loudness around −14 LUFS, true peak ≤ −1 dBTP).
    - It drafts a title (≤ 100 chars, `#Shorts` for Shorts), a description with chapters, and tags (≤ 500 chars). Chapters come from the exported timeline segments and are only included when YouTube's rules are met: starts at 0:00, at least 3 chapters, each ≥ 10 s.
    - It returns up to four 1280×720 candidate frames (loudest moment plus 25/50/75 %) as JPEG data URLs.
  - **Thumbnail maker:** the renderer composes frame + title + accent on a canvas. `saveThumbnail` accepts only a 1280×720 JPEG ≤ 2 MB (checked from the JPEG header in main), writes `<video> thumbnail.jpg` next to the export without overwriting, and reveals it.
  - **Upload hand-off:** `revealOutput` shows the file; `openYouTubeStudio` opens the fixed constant `https://studio.youtube.com/` (never a renderer-supplied URL).
  - **Direct API upload is deferred.** It needs a Google Cloud OAuth client, the `youtube.upload` scope and Google's app verification (unverified apps upload as private only). That is a product decision, not a code gap.
- **Local AI thumbnail generator** (YouTube kit → Thumbnail; Settings → AI & Privacy). Entirely on the user's PC; nothing is uploaded.
  - **Engines** (`src/services/media/imageGen.ts`):
    - **stable-diffusion.cpp** (MIT) runs as a child process with a program and model file the user picks. Arguments: `-m -p -n -W -H --steps --cfg-scale -s -o`, plus `--init-img --strength` for image-to-image. `-M img2img` is added only for older builds whose `--help` lists that mode. The starting image is fitted to the generation size with FFmpeg first.
    - **AUTOMATIC1111 / Forge WebUI API** (`/sdapi/v1/txt2img|img2img`, started with `--api`). Loopback addresses only.
  - **Settings by model name:** few-step models (Turbo/Lightning/LCM/Hyper/Schnell) get 4 steps, CFG 1; others 24 steps, CFG 6.5. SDXL-class models generate at 1344×768, SD 1.x/2.x at 768×448. The app centre-crops to 1280×720.
  - **Prompts** append a thumbnail style and a negative prompt for text/watermarks. Models draw text badly, so the app composites the title itself.
  - **UI:** describe the background; optionally start from the selected background (a video frame or an upload) with a "change" strength; choose 1/2/4 options; cancel at any time. Uploaded images can be backgrounds or **layers on top** (up to 3, left/centre/right, sized and anchored to the bottom, e.g. a transparent cut-out or a logo). Then the existing text/accent compositor and `saveThumbnail`.
  - **Guards:** one generation at a time; refused while streaming (it saturates the GPU and would drop viewers' frames); aborted on app close; out-of-memory explained.
  - **Ops (desktop only):** `thumbAiStatus`, `thumbAiConfigure`, `thumbAiPick`, `generateThumbnail`, `cancelThumbnail`. Config is stored in kv `ui.thumbAi`; the UI only sees file names.
  - **Verified here:** a real stable-diffusion.cpp build (CPU) generated an image from SD-Turbo (Q8 GGUF) in about 30 s with these flags. The automated tests use a fake `sd-cli` and a fake WebUI server, both returning real PNGs. Not bundled: engine builds are GPU-specific and models are 2–7 GB with their own licences, so the user downloads both.
- **Thumbnail compositor** (`src/renderer/thumbCanvas.ts`, renderer only):
  - **Looks:** 8 presets combining font, colours, text effects and background treatment.
  - **Colour grades** use canvas filters plus blend fills.
  - **Background passes:** vignette, speed lines aimed at the first layer, scanlines, glitch (slice displacement with an RGB fringe) and film grain. A seeded PRNG keeps them identical across redraws.
  - **Text:** glow, gradient, slant, 3D extrude and RGB split.
  - **Draggable graphics:** arrow, circle, badge and burst.
  - **Cut-outs:** neon glow outline in any colour.
  - **Fonts:** display faces from @fontsource (Anton, Bebas Neue, Bangers, Black Ops One under OFL-1.1; Permanent Marker under Apache-2.0), latin subset, bundled.
- **CI** (`.github/workflows/frontend.yml`): two jobs. *Renderer* runs the lockfile check, build, contract tests and the browser demo. *Desktop* installs FFmpeg/Xvfb/flite first, then typechecks, runs the service tests, builds, fetches the voice model and runs the Electron end-to-end suite. Earlier runs failed because the service tests ran before FFmpeg was installed. A vitest global setup now fails fast with a clear message when FFmpeg is missing.
- **Logo.** The supplied drift logo is redrawn as vector artwork (`src/renderer/components/Logo.tsx`): brand gradient in the sidebar, white on the hero, plus `public/favicon.svg` and `build/icon.png`/`icon.svg` for the installer.

## How the UI reaches the services

```
renderer (React, ChatGPT)  ── DesktopAdapter (validates every snapshot/reply)
   │ window.drift { apiVersion, readState, request(op, input, requestId), onState }
preload (sandboxed, allow-listed operations)
   │ IPC drift:readState / drift:request / drift:state
main ── StudioBridge (src/services/bridge) ── DriftCore services
```

- `StudioBridge` builds complete `StudioSnapshot`s from real state (OBS, audio, profiles, sessions, clips, projects, jobs, settings, telemetry) and pushes them on change. Each push carries a monotonically increasing `revision`, and the preload never lets an older snapshot replace a newer one.
- Each operation is re-validated in main with the renderer's own `validateRequest`, mapped onto services, and the snapshot is rebuilt **before** the reply. The UI therefore never shows stale state after an action. A repeated `requestId` returns the same result (idempotent retries).
- The renderer's edit model (single track, 0–100 crop, 0–1 gains, canvas-pixel caption sizes) is converted to the service `EditProject` for FFmpeg export (`StudioBridge.toCoreProject`). Its webcam toggle is a layout guide and is not rendered. Exports use automatic encoder selection (hardware if it works, otherwise software).
- **Protocol additions** (desktop only; DemoAdapter rejects them): `importNative` and `relinkNative` (native file picker, then ffprobe indexing), `pickMusic` (an authorized music handle served as `drift-media://music/…`) and `setObsPassword` (OS-protected storage).
- **Renderer changes I made,** kept minimal and mode-aware so demo wording is unchanged:
  - truthful desktop labels;
  - playback of `drift-media://` URLs;
  - the OBS password field;
  - native import, relink and music pickers;
  - the real OBS preview in Stream Controls;
  - real scene names on scene cards.
- **Bugs fixed during verification:**
  - the setup dialog kept a stale media folder, which disabled Save;
  - placeholder text was saved as the profile and game names;
  - export file names had a doubled extension;
  - the live warning outlived the stream;
  - hard-coded scene labels did not match OBS.

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

**Run here (Linux container, no GPU, no real OBS).** These are mocked-integration results, not Windows results:

| Suite | Result | What it proves |
| --- | --- | --- |
| `npm run test:e2e` | **64/64** | Real Electron app, real built UI, clicked through every function. It checks both what the UI shows and the real effect behind it. |
| `npm run test:services` | **80/80** | Services and `StudioBridge` against a fake obs-websocket v5 server and real FFmpeg. Every snapshot and response passes the renderer's own validators. |
| `npm run test:renderer` | **14/14** | ChatGPT's contract and adapter tests. |
| `npm run test:browser` | **37/37** | ChatGPT's browser demo suite: layouts, overflow, focus, keyboard and dialogs, run with the new theme. |
| `npm run typecheck` | clean | Renderer and desktop configs (TypeScript 7). |

The end-to-end run covers:
- boot in desktop mode with no Node globals in the renderer;
- Settings: media folder created on disk, OBS password stored by the service, and connect;
- first-run setup, with the profile named after the game;
- real preflight (finds the capture source in OBS);
- Start Session: replay buffer on, recording and streaming off, the game executable launched;
- Save Replay: a real indexed clip with a thumbnail;
- recording start and stop;
- ClipForge: plays the real clip, trims it, and exports it;
- the export is exactly 3.500 s at 1920×1080, H.264/AAC, with audio and video lengths equal;
- Open Output, and import through the native picker;
- saying “Clip that” into a fake microphone (synthesized speech) saves a replay;
- Make a Short → Shorts preset → a 1080×1920 export at −14.0 LUFS → YouTube kit checks pass on the real file, with a `#Shorts` title → a 1280×720 thumbnail saved next to the video → Open YouTube Studio opens the fixed URL;
- Settings connects the AI thumbnail generator to a (fake) local WebUI → Generate creates two AI backgrounds from a description → an uploaded PNG is layered on top → the thumbnail is saved;
- scene switch with real scene names, and a decoded OBS preview frame;
- Go Live, still live after changing screens, then End stream, with the live warning cleared;
- mute and unmute of the OBS mic;
- session shows its saved replay, and session notes persist across a reload;
- End Session;
- no renderer errors.

**Not verified.** Windows smoke checklist for a real machine:
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
- Optional direct YouTube upload (needs a Google OAuth client and app verification; see above). “Mark that” is covered by the bridge test, not yet by a spoken end-to-end check.
- Stream Deck plugin (optional), PresentMon-based game FPS (optional), and live preview via OBS virtual camera or NDI (optional).
- Undo/redo history stays in the renderer. The backend persists every saved revision only as the latest one.
