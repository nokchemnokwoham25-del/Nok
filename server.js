const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

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
