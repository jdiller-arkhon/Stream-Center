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

## Voice commands (optional)
Turn on in **Settings → Shortcuts**. Everything runs offline on your PC; no audio is stored or sent.
- **“Clip that”** saves a replay (OBS replay buffer must be running).
- **“Mark that”** adds a timestamped marker to the current session, so you can find the moment later.

## Making YouTube videos and Shorts
- **Find loud moments** (ClipForge) lists the loudest parts of a clip (cheers, fights, shouting). Click one to jump there.
- **Make a Short** turns the clip vertical (9:16) and cuts up to 30 seconds around the loudest moment. Adjust the in/out points, then export.
- In the export dialog, the **YouTube** preset sets 1080×1920 for Shorts or 1440p60 for regular videos. It also turns on **Normalize loudness to −14 LUFS**, the level YouTube plays videos at.
- When an export finishes, open **Export queue → YouTube kit**:
  - It checks the real file against YouTube's rules: Shorts length, resolution, aspect, frame rate, loudness and peaks.
  - It drafts a title, description (with chapters when your cut has three or more parts of at least 10 seconds) and tags. Edit them and copy them.
  - It builds a 1280×720 thumbnail from a frame of your video with your text, saved next to the video.
  - **Open YouTube Studio** opens YouTube in your browser. Choose Create → Upload videos and drag in the file (**Show video in folder** finds it). Drift Studio never signs in or uploads for you.

## Exporting
Choose a preset or settings and export. The queue shows real progress; a file is marked done only after it is checked (length, audio and video present and in sync). Cancel or retry any time; *Open* shows the result.

## If something goes wrong
- OBS not connecting: check OBS is open, the WebSocket server is enabled, and the password matches.
- "Replay buffer unavailable": enable it in OBS output settings.
- Missing clips: *Settings → Recovery → Check library*, then relink moved files.
- A shortcut misbehaves: start Drift Studio with `--safe-mode`, then change it in *Settings → Shortcuts*.
- *Settings → Diagnostics → Export* writes a local report (passwords removed) you can share if you choose.
