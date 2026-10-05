# Drift Studio — quick guide

## Before you start
1. **OBS Studio 28 or newer.** In OBS: *Tools → WebSocket Server Settings* → enable, note the port (4455) and password. *Settings → Output → Replay Buffer* → enable and set how many seconds to keep.
2. **FFmpeg** (for clips and exports). Install a full build (with libass for captions) and either add it to PATH or pick `ffmpeg.exe`/`ffprobe.exe` in *Settings → Media tools*.

## First run
Pick a library folder and an export folder, enter the OBS password (stored with Windows protection), and add a game: an `.exe`/shortcut or a launcher link such as `steam://rungameid/359550`.

## A session
1. **Command Center → choose a profile.** The checklist shows exactly what will happen (scene, audio, replay buffer, recording, apps, game) and checks OBS, the capture source, the microphone *device name*, and free space.
2. **Start Session.** Steps run one by one; cancel at any time. Drift Studio never undoes things for you — if something fails it tells you what is still running.
3. **Save Replay** with the button or the global shortcut (default *Ctrl+Alt+R*). The clip appears in Recent highlights when OBS has written it.
4. Starting a session never goes live. Streaming only starts from **Go Live** after you confirm.

## Editing
Open a clip in **ClipForge**. Trim, split, reorder, set levels and fades, pick 16:9, 9:16 or 1:1, add captions or your own music. Edits are saved automatically and never change the original file. Presets only change settings you can see and adjust.

## Exporting
Choose a preset or settings and export. The queue shows real progress; a file is marked done only after it is checked (length, audio and video present and in sync). Cancel or retry any time; *Open* shows the result.

## If something goes wrong
- OBS not connecting: check OBS is open, the WebSocket server is enabled, and the password matches.
- "Replay buffer unavailable": enable it in OBS output settings.
- Missing clips: *Settings → Recovery → Check library*, then relink moved files.
- A shortcut misbehaves: start Drift Studio with `--safe-mode`, then change it in *Settings → Shortcuts*.
- *Settings → Diagnostics → Export* writes a local report (passwords removed) you can share if you choose.
