## Quick State
**Last session:** 2026-04-20
**Status:** Video transcription service running via PM2 (id=0). Fully autonomous.
**Active branch:** main
**Open todos:** None
**Do NOT:** Restart or modify without explicit TJ instruction. This is the most hands-off service on the VPS.
---

# Fabienne Transcription — Session Handoff
Last updated: 2026-04-10

---

## PROJECT SUMMARY

Web app for Fabienne (German client). She uploads videos from Google Drive, gets a transcription with word-level timestamps, reviews segments (Keep/Delete decisions), then saves the notes as a .txt to Drive or downloads locally.

**Live URL:** https://fabienne-transcriber.onrender.com (Render free tier — cold-starts after inactivity)
**Local:** http://localhost:3000 (pm2 name: `fabienne-transcriber` on VPS port 3000)
**GitHub:** https://github.com/testclaw97/fabienne-transcriber (main branch → auto-deploys to Render)
**Stack:** Node.js + Express, server.js + public/index.html, PM2, Gladia v2 API, DeepSeek API, Google Drive OAuth2

---

## CRITICAL RULES FOR THIS PROJECT

- **Claude Code only** — no Aider, no DeepSeek, no OpenHands. Edit server.js and index.html directly.
- **No auto-deploy** — do NOT git push unless TJ explicitly says to. Work on localhost by default.
- **Money always in cents** — not relevant here (no payments), but general VPS rule.
- **Drive API** — uses OAuth2 refresh token (not service account). Credentials in .env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
- **Render env vars** — all 4 Google vars + `GLADIA_API_KEY` + `DEEPSEEK_API_KEY` must be set in Render dashboard (they are already set).
- **DeepSeek paid key** — use the paid DeepSeek key for this project (from .env), not the free one (that's for Jarvis).

---

## ARCHITECTURE

```
server.js
├── POST /transcribe          → accepts { url, folderId }, creates job, starts async pipeline
├── GET  /transcribe/:jobId   → SSE stream for progress updates
├── GET  /api/browse          → lists Google Drive files/folders (OAuth2)
├── POST /api/save-notes/:id  → uploads .txt to Drive folder
└── GET  /*                   → serves public/index.html

Pipeline (per job):
1. Download video from Drive URL (axios stream)
2. Extract audio with ffmpeg-static → mp3
3. Upload mp3 to Gladia v2 → get transcription_id
4. Poll Gladia until done → word-level timestamps (seconds, not ms)
5. Call DeepSeek → group words into paragraph segments with Keep/Delete suggestions
6. SSE-push result to browser
```

```
public/index.html (single-page app)
├── Drive file browser (breadcrumb navigation, currentFolderId tracked)
├── Transcription view: table with timestamp | text | decision columns
├── Audio player synced to transcript (setInterval 300ms, data-index attributes)
├── Toolbar: Copy | Notizen herunterladen | Notizen in Drive speichern
└── Drive success modal (shown on upload success with link)
```

---

## KEY STATE VARIABLES (index.html)

| Variable | Purpose |
|---|---|
| `currentFolderId` | ID of folder user is currently browsing — passed to /transcribe and /api/save-notes |
| `currentJobId` | Job ID for active transcription — used for SSE and save-notes endpoint |
| `transcriptData` | Array of segment objects `{start, end, text, decision}` |
| `activeFileName` | Name of video being transcribed (used in .txt filename) |
| `audioPlayer` | HTMLAudioElement for playback |

---

## FEATURE STATUS

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Drive file browser + breadcrumb | ✅ | OAuth2, browses subfolders |
| 2 | Transcription via Gladia v2 | ✅ | Word-level timestamps |
| 3 | DeepSeek paragraph grouping | ✅ | Keep/Delete auto-suggestions |
| 4 | Audio player + transcript sync | ✅ | data-index selector, 300ms interval |
| 5 | Two download buttons | ✅ | Herunterladen (local) + Drive speichern |
| 6 | Drive upload with folder targeting | ✅ | folderId passed in body |
| 7 | Drive success modal with link | ✅ | #drive-success-modal |
| 8 | Cold-start retry (all endpoints) | ✅ | Content-type check + retry loop |
| 9 | SSE reconnect grace period | ✅ | 45s grace before showing error |
| 10 | Editor mode removed | ✅ | Always DE language, no toggle |

**All features complete. No pending tasks.**

---

## KNOWN ISSUES / GOTCHAS

- **Render cold start**: Server spins down after ~15min inactivity. All API calls check `content-type` — if HTML returned (Render wake page), retry up to 4× with 10s gaps. Button shows "Server startet… ☕" during wait.
- **SSE on cold start**: EventSource auto-reconnects. 45s grace period before showing "Verbindung unterbrochen" error. Most reconnects succeed within 10s.
- **Gladia word timestamps**: These are in **seconds** (floats), not milliseconds. Do not convert.
- **Audio sync**: Uses `querySelector('[data-index="N"]')` — NOT `rows[N]` — because AI section header rows are inserted in tbody and shift array indices.
- **Drive scope**: `drive.file` only (can only access files the app created or opened). This is intentional and sufficient.
- **DeepSeek 401**: If DeepSeek fails with 401, check `DEEPSEEK_API_KEY` in .env and in Render env vars. The paid key starts with `sk-88...`.

---

## COMMANDS

```bash
# Start/restart local server
pm2 restart fabienne-transcriber

# View logs
pm2 logs fabienne-transcriber --lines 30

# Re-auth Drive (if refresh token expires — unlikely)
cd ~/fabienne-transcription && node auth-drive.js

# Deploy to Render (only when TJ says to)
cd ~/fabienne-transcription && git push origin main
```

---

## FILES

| File | Purpose |
|---|---|
| `server.js` | All backend logic |
| `public/index.html` | Entire frontend (single file) |
| `auth-drive.js` | One-time OAuth2 setup script |
| `.env` | Local secrets (never committed) |
| `render.yaml` | Render deploy config |
