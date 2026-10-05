# Drift Studio demo guide

1. Start with `npm ci` and `npm run dev`. Open the local address shown by Vite.
2. Use Setup checklist to configure a media folder and game path. Connect demo OBS. No real game or OBS process is controlled.
3. Choose a profile. Check setup and inspect each preflight result. Start Session arms the simulated replay buffer; Start Recording and Go Live are separate actions.
4. Save Replay creates a clearly labeled fixture. Open a recent highlight in ClipForge.
5. For real preview, import your own MP4/H.264 or WebM. Files stay local. Browser codec support varies; use a compatible proxy if import fails.
6. Trim with In/Out, scrub the playhead, split and reorder segments. Pick a preset and inspect its settings. Undo/Redo recover edits. Layout changes ratio/crop; Captions adds text and timing; Audio imports music and adjusts gain.
7. Export clip opens output settings and a simulated queue. Cancel, fail and retry are supported. Simulation finished does not mean a media file exists. Open Output explains the missing desktop capability.
8. Drafts, profiles, thumbnails and session notes persist in browser storage. Reload expires imported video/music URLs. Locate Recording relinks a video; reimport music as needed. Download draft JSON preserves edit metadata.
9. Sessions keeps notes and linked clips. Stream Controls switches simulated scenes and confirms broadcasts. Audio separates OBS source audio from unsupported Windows device audio.
10. Settings → Diagnostics offers recovery scenarios. Reset demo restores fixture defaults and clears drafts/profiles after confirmation.

Keyboard: Ctrl/⌘+K opens the palette; Escape closes dialogs; Tab stays in an open dialog. ClipForge Space plays/pauses outside text fields; Ctrl/⌘+Z and Ctrl/⌘+Shift+Z undo/redo. Disable in-app shortcuts in Settings if desired.
