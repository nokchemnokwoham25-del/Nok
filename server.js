const express = require('express');
const cors = require('cors');
const fs = require('fs');
const zlib = require('zlib');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));
// ---- Makes the website installable like an app (PWA) ----
// PNG-START
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(s) {
  const row = 1 + s * 3;
  const raw = Buffer.alloc(row * s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let r = 0x5b, g = 0x4b, b = 0xdb;
      if (x >= 0.38 * s && x <= 0.72 * s && Math.abs(y - 0.5 * s) <= 0.2 * s * (0.72 * s - x) / (0.34 * s)) { r = g = b = 255; }
      const o = y * row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// PNG-END
const icons = { 192: makePng(192), 512: makePng(512) };
app.get('/icon-192.png', (req, res) => res.type('png').send(icons[192]));
app.get('/icon-512.png', (req, res) => res.type('png').send(icons[512]));
app.get('/manifest.json', (req, res) => res.json({
  id: '/',
  name: 'Nokchem',
  short_name: 'Nokchem',
  description: 'Type any topic and watch a narrated visual lesson.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#14141c',
  theme_color: '#5b4bdb',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}));
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').send(
    "self.addEventListener('install',e=>self.skipWaiting());" +
    "self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));" +
    "self.addEventListener('fetch',e=>{});"
  );
});
app.get('/', (req, res) => {
  let html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  html = html
    .replace('</head>', '<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#5b4bdb"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/icon-192.png"></head>')
    .replace('</body>', '<script>if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(function(){})}</script></body>');
  res.type('html').send(html);
});

const KEY = process.env.GEMINI_API_KEY;
const MODELS = [...new Set([
  process.env.GEMINI_MODEL,
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
].filter(Boolean))];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callModel(model, prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16000 },
      }),
    }
  );
  const data = await r.json();
  if (!r.ok) {
    const err = new Error((data.error && data.error.message) || 'Gemini ' + r.status);
    err.status = r.status;
    throw err;
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

app.post('/api/lesson', async (req, res) => {
  const { topic, cls, subject } = req.body || {};
  if (!topic || typeof topic !== 'string' || topic.length > 120) {
    return res.status(400).json({ error: 'Invalid topic', detail: 'Invalid topic' });
  }
  if (!KEY) return res.status(500).json({ error: 'nokey', detail: 'GEMINI_API_KEY is missing in Render' });

  const prompt = `You are a friendly teacher making a short video lesson for a student in ${String(cls).slice(0, 20)} who likes ${String(subject).slice(0, 30)}, on the topic: "${topic}". Match vocabulary and depth to that class level.
Return ONLY JSON: {"title":string,"scenes":[{"svg":string,"narration":string}]}
Rules: exactly 5 scenes that build the idea step by step (intro, 3 key steps, recap). Each svg is one complete SVG, viewBox='0 0 600 400', white background rect, bright colors, big clear labels (text size 16-20), arrows and simple shapes, use single quotes for all attributes, no scripts. Each narration is 1-2 simple sentences spoken to the student, matching its picture.`;

  let lastErr = null;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lesson = await callModel(model, prompt);
        return res.json(lesson);
      } catch (e) {
        lastErr = e;
        console.error(model, attempt, e.message);
        const busy = e.status === 429 || e.status === 503 || /demand|overload|try again/i.test(e.message);
        if (busy && attempt === 0) { await sleep(2500); continue; }
        break;
      }
    }
  }
  res.status(500).json({ error: 'Could not make lesson', detail: String(lastErr && lastErr.message).slice(0, 200) });
});

app.listen(process.env.PORT || 3000, () => console.log('Nokchem running'));
