# Capability and delivery status

| Area | Frontend delivered | Demo behavior | Claude / desktop remaining |
|---|---|---|---|
| Shell/navigation | Seven routes, palette, setup, notifications, status strip | Interactive | Native window, persistence, secure bridge |
| Session prep | Profile preview, preflight, per-check results, cancel view | Simulated | Cancellable preparation orchestration, partial external result recovery |
| Game launch | Profile configuration and typed request | No process launched | Executable/launcher allowlist, validation, duplicate-process guard |
| OBS connection/state | Connection/disconnection UI, validated client | Offline/connecting/connected/failed | Real OBS WebSocket, native-change events, reconnect reconciliation |
| Recording/replay | Separate capture controls and state | Simulated | Actual recording and replay-buffer lifecycle |
| Save replay | Recent clips/session linking | Fixture created after simulated completion | Await ReplayBufferSaved, validate and index actual file |
| Broadcasting | Separate Go Live destination confirmation | Never broadcasts | Real destination/state and OBS support checks |
| Preview | Large monitor/placeholder; Command Center can render supplied preview URL | Original illustrative vector | OBS-supported preview; shared Stream Controls feed |
| Telemetry | Game FPS and OBS FPS remain separate; null-safe values | Unavailable | Honest measurements, encoder stats, free disk bytes |
| Audio | Named sources, mute/gain, no invented meters; separate Windows panel | Simulated OBS source controls | Device/source discovery, signal data, supported Windows API, verified routing |
| Import/library | Browser metadata/thumbnail, filter/search/tags/favorites/relink | Real local file playback plus fixtures | Native picker/authorized handles, ffprobe index, hashing, source watchers |
| Editor | Trim/split/order, undo/redo, draft autosave, project-clock scrub/zoom/snap | Actual metadata and browser preview | Frame-accurate/proxy playback, multi-source editing, precise output waveform/thumbnails |
| Crop/captions | Canvas ratio/crop/guides, editable captions/style/timing | Browser preview | Matching FFmpeg transforms, retiming/validation, optional transcription |
| Music | User import, playback and gain | Real browser audio preview | Native music handles, fades/multitrack output, audio sync |
| Export | Destination/ratio/resolution/fps/quality/codec, queue/cancel/retry/error UI | Simulation only, no file or fake output handle | Encoder probing, rendering, validation, atomic completion, open output |
| Sessions/profiles | Event history, notes, linked clips/exports; profile edit/duplicate, hotkey conflict check | Local browser persistence | SQLite, OS shortcut registration/conflict handling, recovery |
| AI/Stream Deck | Explicit capability explanations | Unavailable | Optional local transcription/download, documented optional Stream Deck plugin |
| Packaging | Build and packaging checklist | Browser only | Signed Windows installer and real Windows smoke tests |

A browser test passing does not promote a desktop capability to implemented. Update the rightmost column with actual evidence as services land.
