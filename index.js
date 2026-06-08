// functions/index.js — محفظتي AI Server
// Gemini proxy + per-user daily rate limiting via Firestore

const http = require('http');
const https = require('https');

// ── Config ──────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const DAILY_LIMIT    = 20;
const PORT           = process.env.PORT || 3000;

// ── Firestore REST API ───────────────────────────────────
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mahfazti-6c7b2';
const FIRESTORE  = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, body: d }); } });
    }).on('error', reject);
  });
}

// ── Rate Limiter via Firestore REST ──────────────────────
async function checkAndIncrement(userId) {
  const today = new Date().toISOString().split('T')[0];
  const docUrl = `${FIRESTORE}/users/${userId}/ai/usage`;

  // Get current usage
  const get = await httpsGet(docUrl).catch(() => ({ status: 404, body: {} }));
  
  let count = 0;
  if (get.status === 200 && get.body.fields) {
    const f = get.body.fields;
    const savedDate = f.date && f.date.stringValue;
    count = savedDate === today ? (parseInt(f.count && f.count.integerValue) || 0) : 0;
  }

  if (count >= DAILY_LIMIT) {
    return { allowed: false, count, limit: DAILY_LIMIT };
  }

  // Update usage
  const newCount = count + 1;
  await httpsPost(
    `${FIRESTORE}/users/${userId}/ai/usage?updateMask.fieldPaths=date&updateMask.fieldPaths=count`,
    { fields: { date: { stringValue: today }, count: { integerValue: String(newCount) } } }
  ).catch(() => {});

  return { allowed: true, count: newCount, limit: DAILY_LIMIT };
}

// ── Gemini Call ──────────────────────────────────────────
async function callGemini(systemPrompt, messages, maxTokens) {
  const contents = [];
  if (systemPrompt) {
    contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
    contents.push({ role: 'model', parts: [{ text: 'OK' }] });
  }
  messages.forEach(m => {
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  });

  const res = await httpsPost(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`,
    { contents, generationConfig: { maxOutputTokens: maxTokens || 400 } }
  );

  if (res.status !== 200) throw new Error((res.body.error && res.body.error.message) || 'Gemini error');
  return res.body.candidates[0].content.parts[0].text;
}

// ── HTTP Server ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // Parse body
  let body = '';
  req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));
  let data = {};
  try { data = JSON.parse(body); } catch(e) {}

  // ── /aiChat ──
  if (url === '/aiChat' && req.method === 'POST') {
    const { userId, messages, systemPrompt, maxTokens } = data;

    if (!userId || !messages) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing userId or messages' }));
      return;
    }

    // Rate limit
    const usage = await checkAndIncrement(userId);
    if (!usage.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'daily_limit_reached',
        message_ar: `وصلت للحد اليومي (${DAILY_LIMIT} سؤال). تعالى بكره! 😊`,
        message_en: `Daily limit reached (${DAILY_LIMIT} questions). Come back tomorrow! 😊`,
        count: usage.count,
        limit: usage.limit
      }));
      return;
    }

    try {
      const text = await callGemini(systemPrompt, messages, maxTokens);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        text,
        usage: { count: usage.count, limit: usage.limit, remaining: usage.limit - usage.count }
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /aiUsage ──
  if (url === '/aiUsage' && req.method === 'POST') {
    const { userId } = data;
    if (!userId) { res.writeHead(400); res.end('{}'); return; }

    const today = new Date().toISOString().split('T')[0];
    const docUrl = `${FIRESTORE}/users/${userId}/ai/usage`;
    const get = await httpsGet(docUrl).catch(() => ({ status: 404, body: {} }));

    let count = 0;
    if (get.status === 200 && get.body.fields) {
      const f = get.body.fields;
      count = f.date && f.date.stringValue === today ? (parseInt(f.count && f.count.integerValue) || 0) : 0;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - count) }));
    return;
  }

  // ── Health check ──
  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'mahfazti-ai' }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Mahfazti AI Server running on port ${PORT}`);
});
