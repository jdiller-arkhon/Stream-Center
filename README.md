# Drift Studio

Personal gaming and streaming workstation for **drift**: prepare a session → launch the game → control OBS and audio → save a highlight → edit → export.

Windows desktop app (Electron + TypeScript). React renderer (frontend branch) talks to desktop services through a versioned, validated contract.

| Doc | What |
| --- | --- |
| [docs/contract.md](docs/contract.md) | Shared DTOs, methods, events, error codes — the frontend/backend agreement |
| [docs/backend-handoff.md](docs/backend-handoff.md) | Services architecture, capability matrix, frontend wiring guide, packaging, verification status |
| [docs/user-guide.md](docs/user-guide.md) | Short user guide |
| docs/frontend-handoff.md | Frontend (ChatGPT) — when available |

```bash
npm install && npm test && npm start
```
