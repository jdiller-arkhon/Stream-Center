# Drift Studio — combined Command Center + ClipForge build prompt

Paste this same prompt into ChatGPT and Claude. Tell each assistant its role. Share the same repository and attach the UI concept image. This is a Windows desktop application; a browser preview is only a frontend development surface.

---

You are building **Drift Studio**, a premium personal gaming and streaming desktop app combining **Drift Command Center** and **ClipForge**. The core journey is: prepare a gaming session → launch the game → control OBS and audio → save a highlight → review and edit it → export a polished clip. Build an actual application, not just a dashboard illustration.

## 1. Ownership and collaboration

**ChatGPT owns the frontend:** visual design, React components, navigation, interaction design, accessibility, animation, responsive layouts, frontend state, typed client adapters, and an explicitly labeled demo mode. Create every screen and its loading, disconnected, empty, processing, failed, and success states. Deliver runnable code and a frontend handoff.

**Claude owns functionality:** Electron desktop integration, secure IPC, OBS connection, game launching, device discovery and supported audio control, recording/replay orchestration, FFmpeg processing, persistent storage, optional transcription, background jobs, logging, packaging, and integration tests. Wire the existing frontend to real services while preserving its design.

Work in separate branches. ChatGPT primarily edits frontend files; Claude primarily edits desktop/services files. Agree on shared contracts before implementation. Neither assistant should casually replace the other's work, change frameworks, or redesign established screens. Changes to shared interfaces require updating both adapters and fixtures. Do not imply the assistants communicate automatically: maintain explicit handoff documents in the repository.

If given an existing repository, read its instructions and architecture first. Reuse a suitable existing stack rather than migrating it without a reason. For a new project, use React + TypeScript + Vite for the renderer, Electron + TypeScript for Windows integration, SQLite for metadata, and FFmpeg/ffprobe for media processing. Validate current dependency versions and licensing before implementation. Keep renderer components independent of Electron so browser demo previews work.

Suggested structure: `src/renderer`, `src/shared`, `src/main`, `src/preload`, `src/services`, `docs`, and `tests`. Use a narrow, validated preload API; disable renderer Node integration, enable context isolation and sandboxing where supported, and restrict external navigation. Never pass arbitrary shell commands from the renderer.

## 2. Product and visual direction

The user's gaming name is **drift**. Design a distinctive creative workstation: black foundation, crisp white typography, restrained icy cyan and electric violet accents, occasional amber for warnings. Use layered charcoal surfaces where needed for readable depth. The overall effect should feel cinematic, tactile, sharp, and expensive.

Avoid an ordinary admin template or a wall of identical cards. Use an asymmetric but aligned workspace, large cinematic previews, compact instrument panels, expressive thumbnails, finely drawn waveforms, precise separators, and thoughtful whitespace. Add a custom abstract chrome ribbon or fractured-glass emblem in the session hero. Confine decorative 3D imagery to a few feature areas so controls stay clear.

Use clean sans-serif typography, tabular numbers for telemetry, readable labels, a consistent spacing scale, 10–16 px panel corners, and restrained border lighting. Motion should explain state: recording indicators, connection changes, timeline movement, and job progress. Respect reduced motion. Essential information must not depend on color alone. Decorative effects must not waste resources while gaming.

The attached image is a design reference, not a functioning product or proof of integrations. Example telemetry and clips shown in it are illustrative. Translate the visual into real components rather than placing the image behind hotspots.

## 3. Navigation and global shell

Left rail: **Command Center, ClipForge, Sessions, Stream Controls, Audio, Profiles, Settings**. Command Center and ClipForge are primary destinations. Include a compact Drift emblem, clear selected state, and connection status at the bottom.

Global header: current profile, session name, command search, notification center, and OBS status. The command palette supports navigation and authorized actions with keyboard shortcuts. A persistent bottom strip shows recording state, replay-buffer state, disk space, and background exports. Only show measurements actually available; unavailable readings display an explanation rather than invented numbers.

Provide first-run setup for media folders, OBS connection, a game shortcut, and optional microphone permission. Default to a useful offline state. Store credentials in OS-protected storage. Permit manual paths and reconnect flows.

## 4. Command Center

Create a hero labeled **“Ready for your next session.”** with a selected profile such as “Siege Night,” a game visual, and a prominent **Start Session** button. Below it, show the session preparation steps and the exact actions the profile will perform.

Session profiles may select a game executable or supported launcher URI, preferred OBS scene, recording destination, replay duration, supported audio preset, and optional companion apps. Validate configuration before launch. Preview actions, avoid launching duplicate processes, show per-step results, and support canceling preparation. Do not claim atomic rollback for external app operations; explain and recover from partial completion.

Include:
- A preflight checklist for OBS connection, capture source availability, configured recording/replay state, microphone signal if accessible, and destination storage. A signal meter does not prove the correct microphone is selected; show device identity.
- A live OBS preview when supported, otherwise a useful placeholder with an explanation.
- Compact controls for recording, replay buffer, scene selection, microphone mute, and Save Replay.
- Recent highlights with thumbnail, duration, source game, timestamp, tags, and Open in ClipForge.
- A session activity feed and summary: elapsed session time, clips saved, recording status, export queue.
- Truthful performance telemetry where available. Distinguish game FPS, OBS output FPS, and encoder statistics; do not substitute one for another.

Keep **Start Session**, **Start Recording**, and **Go Live** separate. Starting a session must not broadcast. Broadcasting requires an explicit Go Live action and clear destination; never stop streaming silently when changing a profile.

## 5. ClipForge workspace

Create an editor with a media browser on the left, large preview in the center, edit inspector on the right, and a multitrack timeline below. Offer a simplified “Quick Clip” workflow alongside the editor.

Features:
- Import local recordings and saved replays; indexed thumbnails, tags, favorites, search, game/session filters, missing-file recovery, and duplicate detection.
- Non-destructive in/out trimming, splitting, clip order, audio levels, fades, undo/redo, and draft autosave.
- A real scrubber with zoom, playhead, selected ranges, snapping, thumbnails, audio waveform, and keyboard transport controls. Keep playback synchronized with the saved edit model.
- Widescreen and vertical layouts with adjustable crop, safe-area guides, optional webcam placement, and preview matching the eventual export.
- Editable captions with timing, font, size, color, and placement. Local transcription may be an optional downloadable feature; core editing remains usable without it.
- Optional user-imported music with preview, gain, fade, and original audio mixing. Do not promise arbitrary songs can be downloaded or used. Include music only when supplied by the user or clearly licensed.
- A few high-quality presets: **Clean Highlight**, **Cinematic**, **Vertical Short**, **Squad Recap**. Each preset should modify inspectable settings, not conceal unexplained effects.
- Export controls for destination, aspect ratio, resolution, frame rate, quality, and compatible codec. Maintain audio/video sync; do not claim added detail from upscaling.
- A queue with actual progress, cancel, retry, error details, and Open Output. Never report completion until the file exists and passes media validation.

Avoid flashing transitions as a default. Favor purposeful cuts, restrained transitions, readable captions, clean audio, and pacing. Automatic framing and highlight suggestions can be later enhancements, with editable results and confidence indicators.

## 6. Supporting screens

**Sessions:** list and detail view with timeline of recording events, clips, notes, profile used, and linked exports.

**Stream Controls:** scene grid, sources where supported, recording/streaming status, connection setup, and clear reconnect behavior. Reflect the actual OBS state, including actions performed directly in OBS.

**Audio:** clear separation between OBS source audio and Windows device/app audio. Label unsupported controls. Show device/source names and microphone meters where available. Do not present separate viewer and headphone mixes unless the required routing is configured and verified.

**Profiles:** duplicate/edit profiles, validated game paths, recording choices, and supported Stream Deck mappings. Start with reliable hotkeys; implement deeper Stream Deck integration as an optional documented plugin rather than pretending it already exists.

**Settings:** media storage, OBS connection, shortcuts, appearance, optional AI/transcription, performance budget, diagnostics, privacy, and recovery.

## 7. Shared frontend/backend contract

Define versioned TypeScript DTOs and runtime validation before building service logic. Cover `ConnectionStatus`, `Capabilities`, `SessionProfile`, `Session`, `OBSState`, `AudioSource`, `ClipAsset`, `EditProject`, `TimelineTrack`, `ExportPreset`, `Job`, and structured errors. Use opaque IDs, explicit time units, timestamps, and documented nullability.

Expose typed operations for connecting to OBS, reading state, preparing/starting a session, launching configured games, starting/stopping recording and replay buffer, saving a replay, importing/listing clips, saving edit projects, enqueuing/canceling exports, and reading supported audio/telemetry state. Include events for OBS state, connection changes, new clips, job progress, and warnings. Validate and allowlist capabilities on the main-process side too.

Use one service interface with **DemoAdapter** and **DesktopAdapter** implementations. Demo mode has a persistent “Demo mode” label, believable fixture data, and simulated transitions. Production must not silently fall back to demo data on failure. Capability flags determine whether actions are enabled and explain unavailable features. Distinguish pending, accepted, processing, and completed states; prevent accidental repeated requests and recover after reconnect.

## 8. Reliability and boundaries

Operate outside game processes. Do not inject code, read game memory, bypass anti-cheat, automate competitive gameplay, or install keyboard hooks that can lock out normal input. Register only explicit shortcuts and provide conflict detection, disable controls, and a recovery path.

Use OBS replay buffering for the first version rather than creating an independent capture engine. Verify required OBS requests against current official documentation. Handle OBS disconnects, recording started elsewhere, missing replay buffer, and a replay save completing asynchronously.

Keep media originals untouched. Store edits as metadata. Use safe file paths, argument arrays for child processes, temporary output files, atomic completion where possible, collision-safe names, cancellation cleanup, and ffprobe validation. Use background workers with bounded concurrency and lower-priority processing while gaming. Support proxy playback for large clips. Detect hardware encoding capability and provide software fallback without claiming universal GPU support.

Local-first operation: no uploads, analytics, or cloud AI by default. If optional cloud services are added, make the destination and data transfer explicit. Do not capture credentials or private messages in diagnostics.

## 9. Delivery sequence

**ChatGPT phase:** inspect/create the project, establish shared interfaces, implement the complete visual shell and screen flows in labeled demo mode, verify at 1920×1080 and 1440×900 plus smaller windows, and deliver screenshots and `docs/frontend-handoff.md`. Document component structure, tokens, routes, state management, API contracts, fixture usage, and remaining integration points. Run production build, type checks, and relevant interaction/accessibility checks. Do not implement fake “live” service claims.

**Claude phase:** read the handoff and preserve the UI; implement desktop services in vertical slices. First connect to OBS and save a real replay. Then index/open that clip, save an edit, and export a real trimmed file with audio. Next add session profiles and remaining supported controls, then captions and optional integrations. Maintain `docs/backend-handoff.md` and a capability/status matrix.

**Final integration:** validate a complete Windows journey: launch → connect → prepare session → start replay buffer → save replay → view clip → trim → export → play exported file. Test disconnect/reconnect, missing OBS, unavailable devices, missing media, insufficient storage, repeated clicks, cancellation, app restart, and a failed export. Validate clip duration and A/V sync. Use mocked contract tests plus real Windows smoke tests; clearly distinguish them.

Provide installer/package instructions, prerequisites, a concise user guide, and a list of implemented versus pending features. If Windows hardware or OBS is unavailable, say exactly which checks remain unverified. Do not claim “flawless,” “fully tested,” or “production ready” from a browser demo alone.

## 10. Acceptance criteria

- Every visible control works or explains its unavailable capability.
- No real-service screen fabricates telemetry, progress, device discovery, or success.
- ChatGPT's frontend and Claude's services communicate through the agreed adapter and shared contracts.
- The unified app retains one visual identity across all screens.
- Core launch/capture/edit/export works without AI or cloud accounts.
- Media sources remain intact, edits persist, jobs recover meaningfully, and UI remains responsive.
- The user can complete a useful first session without navigating technical settings repeatedly.

Begin by confirming your role, inspecting the repository if supplied, proposing the shared contract and architecture, and then implementing the first usable slice. Continue through your assigned phase and produce a concrete handoff, not only a plan.
