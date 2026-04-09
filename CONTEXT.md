# CONTEXT.md — Fabienne Transcription

## What it is
Node.js web app that transcribes German videos from Google Drive. User pastes a Drive link, it downloads the video, extracts audio via FFmpeg, transcribes via Gladia API (with Groq Whisper as fallback), and streams progress via SSE.

## Stack
- Node.js / Express, port 3000
- PM2 process: `fabienne-transcriber` (id=0)
- Entry: `server.js`
- Frontend: `public/index.html` (static, served by Express)

## Pipeline
Drive URL → download video → FFmpeg extract audio (16kHz mono MP3) → upload to Gladia → poll until done → format timestamps → SSE stream to browser

## Key APIs
- Gladia: primary transcription. Env: `GLADIA_API_KEY`
- Groq Whisper: fallback if Gladia fails. Env: `GROQ_API_KEY`
- Google Drive: no API key — uses public download URL pattern

## Limits
- Max video size: 2GB (enforced in code)
- Max transcription wait: 10 min (120 polls × 5s)
- Language hardcoded: German (`de`)

## NEXT FEATURES TO BUILD (2026-04-09)
Build these IN ORDER using oh-build. One feature at a time. Verify in browser before next.

```bash
# Template for each:
oh-build "feature description" ~/fabienne-transcription
pm2 restart fabienne-transcriber
# test in browser, then do next feature
```

### 1. Mode Toggle ← START HERE
Add toggle top-right on every page: "Client Mode" (German primary) / "Editor Mode" (English primary).
Both modes available to Fabienne and editor at any time.

### 2. Decision Buttons
Replace the × delete button on each segment with 3 buttons: ✅ Keep, ✂️ Cut, 🗑️ Delete.
Add drag-to-select: Fabienne can drag across segments X→Y and tag the whole range at once.

### 3. AI Sentence + Paragraph Grouping
After transcription completes, call an LLM API (use DeepSeek — key is DEEPSEEK_API_KEY in env) to:
- Group timestamp segments into complete sentences
- Group sentences into topic paragraphs
- Each paragraph gets a German label (Client Mode) describing the topic
- Auto-assign safety indicator to every segment boundary: 🟢 safe to cut, 🟡 risky, 🔴 never cut
- These appear automatically — Fabienne does nothing to trigger them

### 4. Safety Override
If Fabienne marks a 🔴 segment as Cut or Delete, show confirmation: "AI marked this as unsafe to cut. Are you sure?" She confirms or cancels.

## DO NOT TOUCH
This service runs for a client (Fabienne). Do not restart, modify, or redeploy without explicit instruction from TJ. If something is broken, report it — don't fix it unilaterally.

## Restart (only if instructed)
```bash
pm2 restart fabienne-transcriber
pm2 logs fabienne-transcriber --lines 30
```
