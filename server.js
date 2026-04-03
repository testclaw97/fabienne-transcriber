require('dotenv').config();
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
app.use(express.static('public'));

const GLADIA_API_KEY = process.env.GLADIA_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ROOT_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '1T1TrG_5JpMolwTEm2oiKKH4C-n7fLtar';
const PORT = process.env.PORT || 3000;

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
    timeout: 300_000, // 5 min download timeout
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
  const maxAttempts = 120; // 10 minutes max (5s intervals)

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));

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
  const utterances = gladiaResult?.transcription?.utterances;

  if (utterances && utterances.length > 0) {
    return utterances.map(u => ({
      start: Math.floor(u.start),
      timestamp: formatTimestamp(u.start),
      text: (u.text || u.transcript || '').trim(),
    }));
  }

  // Fallback: words grouped into ~10-second chunks
  const words = gladiaResult?.transcription?.words || [];
  if (words.length === 0) return [];

  const chunks = [];
  let chunk = null;
  const CHUNK_SECONDS = 10;

  for (const word of words) {
    const bucketStart = Math.floor(word.start / CHUNK_SECONDS) * CHUNK_SECONDS;
    if (!chunk || chunk.bucketStart !== bucketStart) {
      chunk = { bucketStart, start: word.start, words: [] };
      chunks.push(chunk);
    }
    chunk.words.push(word.word);
  }

  return chunks.map(c => ({
    start: Math.floor(c.start),
    timestamp: formatTimestamp(c.start),
    text: c.words.join(' ').trim(),
  }));
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
    if (sizeBytes && sizeBytes > 500 * 1024 * 1024) {
      throw new Error(
        `Das Video ist zu groß (${sizeMB} MB). Bitte teile das Video in kleinere Teile auf (max. 500 MB) und versuche es erneut.`
      );
    }
    const downloadMsg = sizeMB && sizeMB > 100
      ? `Lade Video herunter… (${sizeMB} MB — das dauert einige Minuten, bitte warten)`
      : 'Lade Video herunter…';
    notifyClients(jobId, { type: 'progress', step: 'downloading', pct: 0, message: downloadMsg });
    await downloadFromDrive(fileId, videoPath);

    notifyClients(jobId, { type: 'progress', step: 'extracting', pct: 20, message: 'Extrahiere Audio…' });
    await extractAudio(videoPath, audioPath);

    // Delete video right away — we only need the audio
    fs.rmSync(videoPath, { force: true });

    let transcript;
    try {
      notifyClients(jobId, { type: 'progress', step: 'uploading', pct: 35, message: 'Lade Audio hoch…' });
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

    const job = jobs.get(jobId);
    if (job) {
      job.status = 'done';
      job.result = { transcript, fullText };
    }

    notifyClients(jobId, { type: 'done', transcript, fullText });
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

  const content = response.data.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");

  const idPattern = /\[null,"(1[a-zA-Z0-9_-]{25,})"\],null,null,null,"(application\/vnd\.google-apps\.folder|video\/[^"]+)"/g;
  const items = [];
  const seen = new Set();
  let m;

  while ((m = idPattern.exec(content)) !== null) {
    const id = m[1];
    const mime = m[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const chunk = content.slice(m.index, m.index + 600);
    const nameMatch = chunk.match(/\[\["([^"]+)",null,true\]/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const isFolder = mime === 'application/vnd.google-apps.folder';
    const isVideo = VIDEO_MIMES.has(mime);

    if (isFolder || isVideo) {
      items.push({ id, name, type: isFolder ? 'folder' : 'file', mime });
    }
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'de');
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

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

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'processing', clients: [], result: null });

  // Fire-and-forget — progress delivered via SSE
  processJob(jobId, fileId);

  res.json({ jobId });
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
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);

  job.clients.push(res);

  req.on('close', () => {
    clearInterval(keepAlive);
    if (job.clients) {
      job.clients = job.clients.filter(c => c !== res);
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Fabienne Transcription running at http://localhost:${PORT}`);
});
