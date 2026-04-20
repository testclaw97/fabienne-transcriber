require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GLADIA_API_KEY = process.env.GLADIA_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ROOT_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '1T1TrG_5JpMolwTEm2oiKKH4C-n7fLtar';
const PORT = process.env.PORT || 3000;
const MEDIA_DIR = path.join(__dirname, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const SESSIONS_DIR = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

if (!GLADIA_API_KEY) {
  console.error('ERROR: GLADIA_API_KEY is not set in .env');
  process.exit(1);
}

// In-memory job store
const jobs = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractFileId(url) {
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function notifyClients(jobId, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  job.clients.forEach(res => res.write(payload));
  if (data.type === 'done' || data.type === 'error') {
    job.clients.forEach(res => res.end());
    job.clients = [];
    setTimeout(() => jobs.delete(jobId), 120_000);
  }
}

// ── Google Drive download ─────────────────────────────────────────────────────

async function getFileSizeBytes(fileId) {
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
  try {
    const response = await axios.head(url, {
      timeout: 10_000,
      maxRedirects: 10,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const len = response.headers['content-length'];
    return len ? parseInt(len, 10) : null;
  } catch {
    return null;
  }
}

async function downloadFromDrive(fileId, destPath) {
  // drive.usercontent.google.com works for large public files without cookie dance
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;

  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    maxRedirects: 10,
    timeout: 1_200_000, // 20 min download timeout
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  // Check if Google returned an HTML error page instead of a video
  const contentType = response.headers['content-type'] || '';
  if (contentType.includes('text/html')) {
    throw new Error(
      'Google Drive returned an HTML page instead of the video. ' +
      'Make sure the file is shared as "Anyone with the link".'
    );
  }

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// ── FFmpeg audio extraction ───────────────────────────────────────────────────

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-i', videoPath,
      '-vn',                  // no video
      '-acodec', 'libmp3lame',
      '-ar', '16000',         // 16kHz — sufficient for speech
      '-ac', '1',             // mono
      '-q:a', '4',
      '-y',                   // overwrite
      audioPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (exit ${code}): ${stderr.slice(-300)}`));
    });
    ffmpeg.on('error', err => reject(new Error(`FFmpeg not found: ${err.message}`)));
  });
}

function transcode144p(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-i', videoPath,
      '-vf', 'scale=-2:144',
      '-c:v', 'libx264',
      '-crf', '28',
      '-preset', 'fast',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-y',
      outputPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg 144p transcode failed (exit ${code}): ${stderr.slice(-300)}`));
    });
    ffmpeg.on('error', err => reject(new Error(`FFmpeg not found: ${err.message}`)));
  });
}

// ── Gladia API ────────────────────────────────────────────────────────────────

async function uploadToGladia(audioPath) {
  const form = new FormData();
  form.append('audio', fs.createReadStream(audioPath), {
    filename: 'audio.mp3',
    contentType: 'audio/mpeg',
  });

  const response = await axios.post('https://api.gladia.io/v2/upload', form, {
    headers: {
      ...form.getHeaders(),
      'x-gladia-key': GLADIA_API_KEY,
    },
    maxBodyLength: Infinity,
    timeout: 120_000,
  });

  return response.data.audio_url;
}

async function startTranscription(audioUrl) {
  const response = await axios.post(
    'https://api.gladia.io/v2/pre-recorded',
    {
      audio_url: audioUrl,
      language: 'de',
      diarization: false,
    },
    {
      headers: {
        'x-gladia-key': GLADIA_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    }
  );

  return response.data.id;
}

async function pollTranscription(transcriptionId, jobId) {
  const maxAttempts = 150; // 10 minutes max

  for (let i = 0; i < maxAttempts; i++) {
    const delay = i < 6 ? 1200 : 2500; // fast early polls, slower after
    await new Promise(r => setTimeout(r, delay));

    const response = await axios.get(
      `https://api.gladia.io/v2/pre-recorded/${transcriptionId}`,
      { headers: { 'x-gladia-key': GLADIA_API_KEY }, timeout: 15_000 }
    );

    const { status, result } = response.data;

    if (status === 'done') return result;
    if (status === 'error') throw new Error('Gladia transcription failed');

    // Rough progress estimate: 0–80% while polling
    const pct = Math.min(80, Math.round((i / maxAttempts) * 80));
    notifyClients(jobId, { type: 'progress', step: 'transcribing', pct, message: 'Transkribiere Audio…' });
  }

  throw new Error('Transcription timed out after 10 minutes');
}

// ── Format Gladia result into our transcript shape ───────────────────────────

function formatTranscript(gladiaResult) {
  const utterances = gladiaResult?.transcription?.utterances || [];

  // Extract all words from utterances (Gladia v2 stores words inside each utterance)
  const allWords = [];
  for (const u of utterances) {
    if (u.words && u.words.length > 0) {
      for (const w of u.words) {
        allWords.push({ word: w.word, start: w.start, end: w.end });
      }
    }
  }

  if (allWords.length > 0) {
    // Split into short sentence-based segments: break on punctuation (min 2s) or max 10s
    const segments = [];
    let cur = [];
    let segStart = null;

    for (const w of allWords) {
      if (segStart === null) segStart = w.start;
      cur.push(w.word);

      const endsWithPunct = /[.!?,;]$/.test(w.word.trim());
      const duration = w.end - segStart;

      if ((endsWithPunct && duration >= 2) || duration >= 10) {
        segments.push({
          start: segStart,
          timestamp: formatTimestamp(segStart),
          text: cur.join(' ').trim(),
        });
        cur = [];
        segStart = null;
      }
    }

    if (cur.length > 0 && segStart !== null) {
      segments.push({
        start: segStart,
        timestamp: formatTimestamp(segStart),
        text: cur.join(' ').trim(),
      });
    }

    return segments;
  }

  // Fallback: use utterances as-is (no word-level data available)
  if (utterances.length > 0) {
    return utterances.map(u => ({
      start: u.start,
      timestamp: formatTimestamp(u.start),
      text: (u.text || u.transcript || '').trim(),
    }));
  }

  return [];
}

// ── DeepSeek AI Analysis ─────────────────────────────────────────────────────

async function analyseWithDeepSeek(transcript) {
  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  
  if (!DEEPSEEK_API_KEY) {
    console.log('DEEPSEEK_API_KEY not set, skipping AI analysis');
    return null;
  }

  try {
    // Build the prompt with numbered segments
    const segments = transcript.map((s, i) => ({
      i,
      ts: s.timestamp,
      text: s.text
    }));

    const systemPrompt = 'You are a video transcript analyser. You will receive numbered transcript segments. Return ONLY valid JSON, no markdown, no explanation.';
    
    const userPrompt = `Analyse these German transcript segments and return JSON with this exact shape: { "paragraphs": [ { "labelDe": "German topic label", "labelEn": "English topic label", "segmentIndices": [0,1,2,...] } ], "safety": { "0": "green", "1": "yellow", "2": "red", ... }, "suggestions": { "0": "keep", "1": "delete", ... } }. Rules: (1) Group consecutive segments into topic paragraphs. Each paragraph is a coherent topic. (2) labelDe is a short German heading (3-6 words) describing the paragraph topic. (3) labelEn is the English translation of the label. (4) segmentIndices lists the 0-based indices of all segments in this paragraph. (5) safety: for EVERY segment index as a string key, assign one of: "green" (safe to cut — long pause or topic change), "yellow" (risky — mid-sentence or partial thought), "red" (never cut — mid-word or essential content). (6) suggestions: for EVERY segment index as a string key, assign "delete" if the segment is a repetition, restart, filler phrase (ähm, also nochmal, ich meine, warte mal, etc.), false start, off-topic remark, or private conversation — otherwise assign "keep". When in doubt, assign "keep". Here are the segments: ${JSON.stringify(segments)}`;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 4096,
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 seconds timeout
      }
    );

    let content = response.data.choices[0].message.content;
    // Strip markdown code block wrappers if DeepSeek wraps response in ```json ... ```
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    // Try to parse the JSON response
    try {
      const parsed = JSON.parse(content);
      
      // Validate the structure
      if (!parsed.paragraphs || !parsed.safety) {
        console.log('DeepSeek response missing required fields');
        return null;
      }
      
      return parsed;
    } catch (parseError) {
      console.log('Failed to parse DeepSeek JSON response:', parseError.message);
      return null;
    }
  } catch (error) {
    console.log('DeepSeek API call failed:', error.message);
    return null; // Silently fail, don't crash the job
  }
}

// ── Groq Whisper fallback ─────────────────────────────────────────────────────

async function transcribeWithGroq(audioPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath), {
    filename: 'audio.mp3',
    contentType: 'audio/mpeg',
  });
  form.append('model', 'whisper-large-v3');
  form.append('language', 'de');
  form.append('response_format', 'verbose_json');

  const response = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      maxBodyLength: Infinity,
      timeout: 300_000,
    }
  );

  // Convert Groq's verbose_json format to our transcript shape
  const segments = response.data.segments || [];
  if (segments.length > 0) {
    return segments.map(s => ({
      start: Math.floor(s.start),
      timestamp: formatTimestamp(s.start),
      text: (s.text || '').trim(),
    }));
  }

  // Groq returned plain text only — wrap as single entry
  return [{ start: 0, timestamp: '00:00', text: (response.data.text || '').trim() }];
}

// ── Job processor ─────────────────────────────────────────────────────────────

async function processJob(jobId, fileId) {
  const tmpDir = path.join('/tmp', `transcribe-${jobId}`);
  const videoPath = path.join(tmpDir, 'video.bin');
  const audioPath = path.join(tmpDir, 'audio.mp3');

  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Check file size and warn before starting
    const sizeBytes = await getFileSizeBytes(fileId);
    const sizeMB = sizeBytes ? Math.round(sizeBytes / 1024 / 1024) : null;
    if (sizeBytes && sizeBytes > 2000 * 1024 * 1024) {
      throw new Error(
        `Das Video ist zu groß (${sizeMB} MB). Bitte teile das Video in kleinere Teile auf (max. 2 GB) und versuche es erneut.`
      );
    }
    const downloadMsg = sizeMB && sizeMB > 200
      ? `Lade Video herunter… (${sizeMB} MB — das kann 10–15 Minuten dauern, bitte warten)`
      : 'Lade Video herunter…';
    notifyClients(jobId, { type: 'progress', step: 'downloading', pct: 0, message: downloadMsg });
    await downloadFromDrive(fileId, videoPath);

    notifyClients(jobId, { type: 'progress', step: 'extracting', pct: 20, message: 'Extrahiere Audio…' });
    await extractAudio(videoPath, audioPath);

    // Persist audio in media directory
    const jobMediaDir = path.join(MEDIA_DIR, jobId);
    fs.mkdirSync(jobMediaDir, { recursive: true });
    const persistAudioPath = path.join(jobMediaDir, 'audio.mp3');
    fs.copyFileSync(audioPath, persistAudioPath);

    // Delete video right away — we only need the audio
    fs.rmSync(videoPath, { force: true });

    let transcript;
    try {
      notifyClients(jobId, { type: 'progress', step: 'uploading', pct: 30, message: 'Lade Audio hoch…' });
      const audioUrl = await uploadToGladia(audioPath);
      notifyClients(jobId, { type: 'progress', step: 'transcribing', pct: 50, message: 'Starte Transkription…' });
      const transcriptionId = await startTranscription(audioUrl);
      const gladiaResult = await pollTranscription(transcriptionId, jobId);
      transcript = formatTranscript(gladiaResult);
    } catch (gladiaErr) {
      console.error('Gladia failed, trying Groq fallback:', gladiaErr.message);
      if (!GROQ_API_KEY) throw gladiaErr;
      notifyClients(jobId, { type: 'progress', step: 'transcribing', pct: 50, message: 'Transkribiere mit Backup-Dienst…' });
      transcript = await transcribeWithGroq(audioPath);
    }
    const fullText = transcript.map(t => `[${t.timestamp}] ${t.text}`).join('\n');

    // AI Analysis with DeepSeek
    notifyClients(jobId, { type: 'progress', step: 'ai_grouping', pct: 90, message: 'KI-Analyse läuft…' });
    const aiGrouping = await analyseWithDeepSeek(transcript);

    const job = jobs.get(jobId);
    if (job) {
      job.status = 'done';
      job.result = { transcript, fullText, aiGrouping, hasMedia: true };
    }

    notifyClients(jobId, { type: 'done', transcript, fullText, aiGrouping, hasMedia: true });
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err.message);
    const job = jobs.get(jobId);
    if (job) job.status = 'error';
    notifyClients(jobId, { type: 'error', error: err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Google Drive folder browser (no API key — scrapes public page) ────────────

const VIDEO_MIMES = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/webm', 'video/mpeg', 'video/3gpp',
]);

async function browseDriveFolder(folderId) {
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'de-DE,de;q=0.9',
    },
    timeout: 15_000,
  });

  const raw = response.data;
  const items = [];
  const seen = new Set();

  // New method: parse _DRIVE_ivd embedded JSON
  const ivdMatch = raw.match(/_DRIVE_ivd'\] = '([\s\S]+?)';/);
  if (ivdMatch) {
    try {
      // Decode hex escapes (\x5b → [) then unescape JSON string escapes
      const decoded = ivdMatch[1]
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\\//g, '/');
      const parsed = JSON.parse(decoded);
      // Each entry: [id, [parentId], name, mimeType, ...]
      const entries = Array.isArray(parsed[0]) ? parsed : [parsed];
      const flat = entries.flat(1);
      for (const entry of flat) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[2] !== 'string' || typeof entry[3] !== 'string') continue;
        const id = entry[0];
        const name = entry[2].trim();
        const mime = entry[3];
        if (seen.has(id)) continue;
        seen.add(id);
        const isFolder = mime === 'application/vnd.google-apps.folder';
        const isVideo = VIDEO_MIMES.has(mime);
        if (isFolder || isVideo) {
          items.push({ id, name, type: isFolder ? 'folder' : 'file', mime });
        }
      }
    } catch (e) {
      console.error('_DRIVE_ivd parse error:', e.message);
    }
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'de');
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/browse', async (req, res) => {
  const folderId = req.query.folderId || ROOT_FOLDER_ID;
  try {
    const items = await browseDriveFolder(folderId);
    res.json({ items, rootFolderId: ROOT_FOLDER_ID });
  } catch (err) {
    console.error('Browse error:', err.message);
    res.status(500).json({ error: 'Ordner konnte nicht geladen werden.' });
  }
});

app.post('/transcribe', (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Bitte eine Google Drive URL angeben.' });
  }

  const fileId = extractFileId(url.trim());
  if (!fileId) {
    return res.status(400).json({ error: 'Ungültige Google Drive URL. Format: drive.google.com/file/d/FILE_ID/...' });
  }

  const { folderId } = req.body;
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'processing', clients: [], result: null, folderId: folderId || null });

  // Fire-and-forget — progress delivered via SSE
  processJob(jobId, fileId);

  res.json({ jobId });
});

// ── Google Drive upload ───────────────────────────────────────────────────────

async function uploadToDrive(content, fileName, folderId) {
  const { google } = require('googleapis');
  const { Readable } = require('stream');
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: 'text/plain',
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { mimeType: 'text/plain', body: Readable.from([content]) },
    fields: 'id,name,webViewLink',
  });
  return res.data;
}

app.post('/api/save-notes/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { content, fileName, folderId: bodyFolderId } = req.body;
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(503).json({ error: 'Drive not configured' });
  }
  const job = jobs.get(jobId);
  const folderId = bodyFolderId || job?.folderId || null;
  try {
    const file = await uploadToDrive(content, fileName, folderId);
    res.json({ success: true, link: file.webViewLink });
  } catch (err) {
    console.error('Drive upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Server-Sent Events progress stream
app.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // If already finished, send result immediately and close
  if (job.status === 'done') {
    res.write(`data: ${JSON.stringify({ type: 'done', ...job.result })}\n\n`);
    res.end();
    return;
  }
  if (job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', error: job.error })}\n\n`);
    res.end();
    return;
  }

  // Keep connection alive
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 8_000);

  job.clients.push(res);

  req.on('close', () => {
    clearInterval(keepAlive);
    if (job.clients) {
      job.clients = job.clients.filter(c => c !== res);
    }
  });
});

// ── Session Persistence ─────────────────────────────────────────────────────────────

app.post('/api/session/:jobId', (req, res) => {
  const { jobId } = req.params;
  const { decisions, notes } = req.body;
  
  if (!decisions || typeof decisions !== 'object') {
    return res.status(400).json({ error: 'Decisions object is required' });
  }
  
  if (!notes || typeof notes !== 'object') {
    return res.status(400).json({ error: 'Notes object is required' });
  }
  
  try {
    const sessionPath = path.join(SESSIONS_DIR, `${jobId}.json`);
    const sessionData = { decisions, notes, updatedAt: new Date().toISOString() };
    fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving session:', err.message);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

app.get('/api/session/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  try {
    const sessionPath = path.join(SESSIONS_DIR, `${jobId}.json`);
    if (fs.existsSync(sessionPath)) {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      res.json(sessionData);
    } else {
      res.json({ decisions: {}, notes: {} });
    }
  } catch (err) {
    console.error('Error loading session:', err.message);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

// ── Translation endpoint ──────────────────────────────────────────────────────

app.post('/api/translate', async (req, res) => {
  const { segments } = req.body;
  if (!Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'segments array required' });
  }

  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  if (!DEEPSEEK_API_KEY) {
    return res.status(503).json({ error: 'Translation service not available' });
  }

  try {
    const systemPrompt = 'You are a German to English translator. Translate each segment accurately and naturally. Return ONLY valid JSON, no markdown, no explanation.';
    const userPrompt = `Translate these German transcript segments to English. Return exactly this JSON shape: { "translations": { "0": "English text", "1": "English text", ... } }. Use the "i" field as the key. Here are the segments: ${JSON.stringify(segments.map(s => ({ i: String(s.index), text: s.text })))}`;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 4096,
        temperature: 0.1
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    let content = response.data.choices[0].message.content;
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(content);
    res.json(parsed);
  } catch (err) {
    console.error('Translation error:', err.message);
    res.status(500).json({ error: 'Translation failed: ' + err.message });
  }
});

// ── Media serving ─────────────────────────────────────────────────────────────

app.get('/media/:jobId/audio', (req, res) => {
  const { jobId } = req.params;
  const audioPath = path.join(MEDIA_DIR, jobId, 'audio.mp3');
  
  if (!fs.existsSync(audioPath)) {
    return res.status(404).json({ error: 'Audio not found' });
  }
  
  res.setHeader('Content-Type', 'audio/mpeg');
  res.sendFile(audioPath);
});

app.get('/media/:jobId/preview', (req, res) => {
  const { jobId } = req.params;
  const previewPath = path.join(MEDIA_DIR, jobId, 'preview.mp4');
  
  if (!fs.existsSync(previewPath)) {
    return res.status(404).json({ error: 'Preview not found' });
  }
  
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(previewPath);
});

// ── FFmpeg 144p cut render ───────────────────────────────────────────────────

app.post('/api/render/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { decisions } = req.body;
    
    // 1. Look up job by jobId
    const job = jobs.get(jobId);
    if (!job || job.status !== 'done' || !job.result || !job.result.transcript) {
      return res.status(400).json({ error: 'Job not found or no transcript available' });
    }
    
    // 2. Validate decisions object
    if (!decisions || typeof decisions !== 'object') {
      return res.status(400).json({ error: 'Decisions object is required' });
    }
    
    // 3. Check job media directory exists and has preview.mp4
    const jobMediaDir = path.join(MEDIA_DIR, jobId);
    const previewPath = path.join(jobMediaDir, 'preview.mp4');
    if (!fs.existsSync(jobMediaDir) || !fs.existsSync(previewPath)) {
      return res.status(404).json({ error: 'Preview video not found' });
    }
    
    // 4. Get transcript and compute time ranges
    const transcript = job.result.transcript;
    const segmentsToKeep = [];
    
    for (let i = 0; i < transcript.length; i++) {
      const decision = decisions[String(i)];
      // Only 'cut' and 'delete' are removed, everything else is kept
      if (decision !== 'cut' && decision !== 'delete') {
        const start = transcript[i].start; // seconds, integer
        const end = i + 1 < transcript.length ? transcript[i + 1].start : (start + 30); // fallback 30 seconds
        segmentsToKeep.push({ start, end });
      }
    }
    
    // 5. Check if any segments to keep
    if (segmentsToKeep.length === 0) {
      return res.status(400).json({ error: 'Keine Segmente zum Behalten' });
    }
    
    // 6. Build FFmpeg concat filter
    const concatFile = path.join(jobMediaDir, 'concat.txt');
    const outputPath = path.join(jobMediaDir, 'cut_preview.mp4');
    
    // Write concat.txt file
    const concatLines = [];
    for (const segment of segmentsToKeep) {
      concatLines.push(`file 'preview.mp4'`);
      concatLines.push(`inpoint ${segment.start}`);
      concatLines.push(`outpoint ${segment.end}`);
    }
    fs.writeFileSync(concatFile, concatLines.join('\n'));
    
    // Run FFmpeg concat
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-c', 'copy',
        '-y',
        outputPath,
      ]);
      
      let stderr = '';
      ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
      ffmpeg.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg concat failed (exit ${code}): ${stderr.slice(-300)}`));
      });
      ffmpeg.on('error', err => reject(new Error(`FFmpeg not found: ${err.message}`)));
    });
    
    // 7. Delete temp concat file
    fs.unlinkSync(concatFile);
    
    // 8. Return success with URL
    res.json({ url: '/media/' + jobId + '/cut_preview' });
    
  } catch (err) {
    console.error('Render endpoint error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/media/:jobId/cut_preview', (req, res) => {
  const { jobId } = req.params;
  const cutPreviewPath = path.join(MEDIA_DIR, jobId, 'cut_preview.mp4');
  
  if (!fs.existsSync(cutPreviewPath)) {
    return res.status(404).json({ error: 'Cut preview not found' });
  }
  
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(cutPreviewPath);
});

// ── Media cleanup ─────────────────────────────────────────────────────────────

function cleanOldMedia() {
  try {
    const now = Date.now();
    const maxAge = 48 * 3600 * 1000; // 48 hours in milliseconds
    
    const items = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        const dirPath = path.join(MEDIA_DIR, item.name);
        const stats = fs.statSync(dirPath);
        const age = now - stats.mtimeMs;
        
        if (age > maxAge) {
          console.log(`Cleaning old media directory: ${item.name} (${Math.round(age / 3600000)}h old)`);
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    console.error('Error cleaning old media:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Fabienne Transcription running at http://localhost:${PORT}`);
  cleanOldMedia();
});
