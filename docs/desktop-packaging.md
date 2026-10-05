# Desktop packaging and installer instructions — pending Claude phase

There is no installer in this frontend phase. The browser preview is a renderer-development surface; it is not the Windows application.

## Frontend prerequisites

Node 22.12+ and npm. `npm ci`, `npm run build` produces `dist/`. For checks, `npm test`; install Playwright Chromium and FFmpeg on PATH before `npm run test:browser`.

## Claude's packaging tasks

1. Add Electron + TypeScript under `src/main` and `src/preload`, and services under `src/services`. Pin reviewed current versions and licenses; preserve renderer code/contracts.
2. Build main/preload separately, load the built `dist/index.html` in production, and use only localhost Vite during development. Disable nodeIntegration; enable contextIsolation and sandboxing where compatible. Deny external navigation/new windows except narrow authorized links. Add production CSP and an allowlisted local media protocol.
3. Add electron-builder or an equivalent Windows packager, with explicit metadata, application icon, per-user install location, uninstall behavior, SQLite data paths and optional FFmpeg distribution. Document FFmpeg build/license and redistributability; do not bundle a random binary.
4. Document OBS prerequisites: OBS Studio with obs-websocket enabled, credentials in OS-protected storage, configured game capture and replay output/replay buffer, authorized recording destination. Discover encoder support; use software fallback where applicable.
5. Add Windows CI build and packaging scripts (`desktop:dev`, `desktop:build`, `desktop:package`) only once their implementation exists. Produce an actual Windows installer, verify installation/uninstall and version metadata, and explain code-signing status.
6. Run the full Windows workflow and failure cases from the master prompt. Confirm export existence, duration, codec and audio/video sync with ffprobe plus manual playback. No installer or production-ready claim before those checks pass.

## Safe service boundaries

No game injection, memory reads, anti-cheat bypass, competitive gameplay automation or arbitrary shell commands. Register only explicit user shortcuts; provide disable/recovery and conflict checks. FFmpeg uses validated paths and argument arrays, lower-priority bounded workers, temporary output, collision-safe names, cleanup on cancel and atomic completion after validation. Store credentials separately from diagnostic logs. No uploads/analytics/cloud AI by default.
