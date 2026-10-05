# Drift Studio

A personal gaming and streaming workstation: **prepare → capture → edit → export**.

This branch is the **ChatGPT Frontend phase**. It contains the React renderer, an interactive browser demo, validated service contracts, and a handoff for Claude's Windows desktop implementation. It is not an Electron installer or a working OBS/FFmpeg capture application.

## Run the interactive demo

Use Node.js 22.12+ and npm:

```sh
npm ci
npm run dev
```

Open the localhost address printed by Vite. The demo starts offline. Click **Connect demo OBS**, then **Start Session**, **Save Replay**, and **Open ClipForge**. The persistent Demo mode banner identifies simulated integrations. Import your own browser-compatible video to try real playback and trimming.

```sh
npm run build
npm run preview
npm test
npx playwright install chromium
npm run test:browser
```

The browser suite also needs FFmpeg on PATH to generate a three-second synthetic test video. No user media is used by tests. It starts its own local server; do not start another server on port 5174.

## What works

- Seven distinct screens, command palette, notifications, setup checklist, reduced-motion support and responsive layouts.
- Simulated session preflight, connection/reconnection, recording, replay, scene and broadcast state, source mute/gain, profiles and shortcut conflict checks.
- Local video import and thumbnail inspection, search, game filters, tags, favorites, missing-file relinking, filename duplicate detection.
- Non-destructive trims, split/reorder/remove segments, keyboard transport, zoom/snapping, undo/redo, draft autosave and JSON download.
- Widescreen/vertical crop, caption editing/style/placement, source audio fades/gain, imported music playback and gain.
- Export configuration, a simulated queue, cancellation, failure details, retry and an explanation for unavailable output files.

No real game launching, recording, OBS controls, broadcasting, device discovery, FFmpeg export, transcription or installer is implemented. Original files are not modified. Browser imports need relinking after restart. Thumbnails/drafts persist in local browser storage; the demo makes no cloud uploads.

## Screenshots

![Command Center](docs/screenshots/command-center-1440.webp)
![ClipForge](docs/screenshots/clipforge-1440.webp)

More views: [screenshot gallery](docs/screenshots.md).

## Claude handoff

Read [docs/frontend-handoff.md](docs/frontend-handoff.md), [integration matrix](docs/integration-matrix.md), and [desktop packaging instructions](docs/desktop-packaging.md) before editing.

Keep the renderer and visual identity. Implement `window.drift` through a restricted preload bridge and connect it to `DesktopAdapter`. Do not silently substitute `DemoAdapter` when desktop initialization fails.

The repository began empty. No separate UI reference image was included with this request; visual implementation follows the attached master prompt, preserved in [docs/master-prompt.md](docs/master-prompt.md).
