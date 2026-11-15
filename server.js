// MovAi — បង្កើតរូបភាព & វីដេអូ (standalone image & video generation site)
// Serves index.html and proxies the free image/video APIs so the browser
// never hits CORS problems. The server NEVER stores API keys — keys arrive
// with each request only, from the visitor's own browser (localStorage).
// Run:  node server.js        (PORT env var, default 3000)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ------------------------------- http helpers ------------------------------ */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function errBody(code, km, en) { return { error: code, message: { km, en } }; }
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req, limitBytes) {
  const buf = await readBody(req, limitBytes);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { return null; }
}

/* --------------------------------- api ------------------------------------- */
function apiRoute(req, res, urlPath) {
  // ---- Generate Image & Video (free APIs) ----
  // Keys arrive with each request only (from the visitor's own browser).
  function genErrText(j, fb) {
    if (j && typeof j.error === 'string' && j.error) return j.error;
    if (j && j.error && typeof j.error === 'object') return j.error.message || JSON.stringify(j.error).slice(0, 200);
    if (j && typeof j.message === 'string' && j.message) return j.message;
    if (j && j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail).slice(0, 200);
    return fb;
  }
  // The server NEVER stores keys — no file, no env var, no log.
  // POST /api/gen/image — {provider:'cloudflare'|'gemini'|'hf', key, accountId, prompt, width, height}
  if (req.method === 'POST' && urlPath === '/api/gen/image') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        const provider = body.provider;
        const key = typeof body.key === 'string' ? body.key : '';
        const prompt = body.prompt.trim().slice(0, 2000);
        const width = Math.max(64, Math.min(2048, Number(body.width) || 768));
        const height = Math.max(64, Math.min(2048, Number(body.height) || 768));
        if (provider === 'cloudflare') {
          const accountId = String(body.accountId || '').trim();
          if (!key || !accountId) return sendJSON(res, 200, { ok: false, error: 'មិនទាន់មាន Cloudflare Account ID / API Token ទេ' });
          const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(accountId) + '/ai/run/@cf/black-forest-labs/flux-1-schnell', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, width, height }), signal: AbortSignal.timeout(180000) });
          const ct = r.headers.get('content-type') || '';
          if (ct.includes('image/')) { const buf = Buffer.from(await r.arrayBuffer()); return sendJSON(res, 200, { ok: true, mime: ct.split(';')[0], b64: buf.toString('base64') }); }
          const j = await r.json().catch(() => null);
          return sendJSON(res, 200, { ok: false, error: 'Cloudflare: ' + ((j && j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status)) });
        }
        if (provider === 'gemini') {
          if (!key) return sendJSON(res, 200, { ok: false, error: 'មិនទាន់មាន Gemini API Key ទេ' });
          const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent', { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }), signal: AbortSignal.timeout(180000) });
          const j = await r.json().catch(() => null);
          const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
          const img = (parts || []).find((pp) => pp.inlineData && pp.inlineData.data);
          if (img) return sendJSON(res, 200, { ok: true, mime: img.inlineData.mimeType || 'image/png', b64: img.inlineData.data });
          return sendJSON(res, 200, { ok: false, error: 'Gemini: ' + genErrText(j, 'HTTP ' + r.status + ' — Key ថ្មីអាចបាន 429') });
        }
        if (provider === 'hf') {
          if (!key) return sendJSON(res, 200, { ok: false, error: 'មិនទាន់មាន Hugging Face Token ទេ' });
          const r = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: prompt, parameters: { width, height } }), signal: AbortSignal.timeout(300000) });
          const ct = r.headers.get('content-type') || '';
          if (ct.includes('image/')) { const buf = Buffer.from(await r.arrayBuffer()); return sendJSON(res, 200, { ok: true, mime: ct.split(';')[0], b64: buf.toString('base64') }); }
          const j = await r.json().catch(() => null);
          return sendJSON(res, 200, { ok: false, error: 'Hugging Face: ' + genErrText(j, 'HTTP ' + r.status) });
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'ហៅ API មិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/video — {provider:'novai'|'magichour'|'tavus'|'hf', key, prompt, duration, res, width, height, replicaId}
  if (req.method === 'POST' && urlPath === '/api/gen/video') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        const provider = body.provider;
        const key = typeof body.key === 'string' ? body.key : '';
        const prompt = body.prompt.trim().slice(0, 4000);
        const duration = [5, 10].includes(Number(body.duration)) ? Number(body.duration) : 5;
        if (!key) return sendJSON(res, 200, { ok: false, error: 'មិនទាន់មាន API Key ទេ' });
        if (provider === 'novai') {
          const r = await fetch('https://aiapi-pro.com/v1/video/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cogvideox-flash', prompt }), signal: AbortSignal.timeout(60000) });
          const j = await r.json().catch(() => null);
          if (j && j.id) return sendJSON(res, 200, { ok: true, jobId: j.id });
          return sendJSON(res, 200, { ok: false, error: 'NovAI: ' + genErrText(j, 'HTTP ' + r.status) });
        }
        if (provider === 'magichour') {
          const width = Number(body.width) || 768;
          const height = Number(body.height) || 432;
          const aspect = width >= height ? '16:9' : '9:16';
          const resName = { 480: '480p', 720: '720p', 1080: '1080p', 4000: '4k' }[Number(body.res)] || '720p';
          const r = await fetch('https://api.magichour.ai/v1/text-to-video', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MovAi video', end_seconds: duration, aspect_ratio: aspect, resolution: resName, model: 'default', style: { prompt } }), signal: AbortSignal.timeout(60000) });
          const j = await r.json().catch(() => null);
          if (j && j.id) return sendJSON(res, 200, { ok: true, jobId: j.id });
          return sendJSON(res, 200, { ok: false, error: 'Magic Hour: ' + genErrText(j, 'HTTP ' + r.status) });
        }
        if (provider === 'tavus') {
          const replicaId = String(body.replicaId || '').trim();
          if (!replicaId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Tavus Replica ID (Face ID) ជាមុនសិន' });
          const r = await fetch('https://tavusapi.com/v2/videos', { method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ replica_id: replicaId, script: prompt, video_name: 'MovAi video' }), signal: AbortSignal.timeout(60000) });
          const j = await r.json().catch(() => null);
          if (j && j.video_id) return sendJSON(res, 200, { ok: true, jobId: j.video_id });
          return sendJSON(res, 200, { ok: false, error: 'Tavus: ' + genErrText(j, 'HTTP ' + r.status) });
        }
        if (provider === 'hf') {
          const r = await fetch('https://router.huggingface.co/hf-inference/models/Wan-AI/Wan2.1-T2V-1.3B', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: prompt }), signal: AbortSignal.timeout(600000) });
          const ct = r.headers.get('content-type') || '';
          if (ct.includes('video/')) { const buf = Buffer.from(await r.arrayBuffer()); return sendJSON(res, 200, { ok: true, done: true, mime: ct.split(';')[0], b64: buf.toString('base64') }); }
          const j = await r.json().catch(() => null);
          return sendJSON(res, 200, { ok: false, error: 'Hugging Face: ' + genErrText(j, 'HTTP ' + r.status) });
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'ហៅ API មិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/video/status — {provider:'novai'|'magichour'|'tavus', key, jobId}
  if (req.method === 'POST' && urlPath === '/api/gen/video/status') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const provider = body.provider;
        const key = typeof body.key === 'string' ? body.key : '';
        const jobId = String(body.jobId || '');
        if (!jobId) return sendJSON(res, 200, { ok: false, error: 'មិនមាន jobId ទេ' });
        if (provider === 'novai') {
          const r = await fetch('https://aiapi-pro.com/v1/video/generations/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(30000) });
          const j = await r.json().catch(() => null);
          const st = j && (j.status || (j.data && j.data.status));
          if (st === 'succeeded') {
            const url = j && (j.url || j.video_url || (j.data && (j.data.url || j.data.video_url)) || (j.output && j.output.url) || (j.result && j.result.url));
            if (url) return sendJSON(res, 200, { ok: true, status: 'done', videoUrl: url });
            return sendJSON(res, 200, { ok: true, status: 'done', videoUrl: '', raw: j });
          }
          if (st === 'failed') return sendJSON(res, 200, { ok: false, error: 'NovAI: បង្កើតមិនបានទេ' });
          return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: st || 'queued' });
        }
        if (provider === 'magichour') {
          const r = await fetch('https://api.magichour.ai/v1/video-projects/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(30000) });
          const j = await r.json().catch(() => null);
          const st = j && j.status;
          if (st === 'complete') {
            const dl = j.downloads && j.downloads[0] && j.downloads[0].url;
            if (dl) return sendJSON(res, 200, { ok: true, status: 'done', videoUrl: dl });
            return sendJSON(res, 200, { ok: true, status: 'done', videoUrl: '', raw: j });
          }
          if (st === 'error') return sendJSON(res, 200, { ok: false, error: 'Magic Hour: ' + ((j && j.error) || 'បង្កើតមិនបានទេ') });
          return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: st || 'queued' });
        }
        if (provider === 'tavus') {
          const r = await fetch('https://tavusapi.com/v2/videos/' + encodeURIComponent(jobId), { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(30000) });
          const j = await r.json().catch(() => null);
          const st = j && j.status;
          if (st === 'ready') {
            if (j.download_url) return sendJSON(res, 200, { ok: true, status: 'done', videoUrl: j.download_url });
            return sendJSON(res, 200, { ok: true, status: 'done', videoUrl: '', raw: j });
          }
          if (st === 'error') return sendJSON(res, 200, { ok: false, error: 'Tavus: បង្កើតមិនបានទេ' });
          return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: st || 'queued' });
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/song — {provider:'musicapi', key, title, lyrics, style, voice, prompt}
  // MusicAPI is CORS-blocked from the browser, so the browser calls this proxy.
  // Keys arrive with each request only (from the visitor's own browser).
  if (req.method === 'POST' && urlPath === '/api/gen/song') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        if (!body || (typeof body.prompt !== 'string' && typeof body.title !== 'string' && typeof body.lyrics !== 'string' && typeof body.style !== 'string')) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        const provider = body.provider;
        const key = typeof body.key === 'string' ? body.key : '';
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
        const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim().slice(0, 4000) : '';
        const style = typeof body.style === 'string' ? body.style.trim().slice(0, 500) : '';
        const voice = body.voice === 'male' || body.voice === 'female' ? body.voice : 'random';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : '';
        if (!title && !lyrics && !style && !prompt) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        if (!key) return sendJSON(res, 200, { ok: false, error: 'មិនទាន់មាន API Key ទេ' });
        if (provider === 'musicapi') {
          let reqBody;
          if (lyrics) {
            // Custom mode: the user wrote their own lyrics, so MusicAPI must sing
            // THOSE words. prompt = lyrics, tags = style. With custom_mode:false
            // MusicAPI ignores the lyrics and auto-generates its own English ones.
            const tagsParts = [];
            if (style) tagsParts.push(style);
            if (voice === 'male') tagsParts.push('male vocals');
            else if (voice === 'female') tagsParts.push('female vocals');
            reqBody = { custom_mode: true, mv: 'sonic-v6', prompt: lyrics.slice(0, 5000), tags: tagsParts.join(', ').slice(0, 1000) };
            if (title) reqBody.title = title.slice(0, 80);
            if (voice === 'male') reqBody.vocal_gender = 'm';
            else if (voice === 'female') reqBody.vocal_gender = 'f';
          } else {
            // AI description mode: no lyrics given, MusicAPI writes its own.
            const parts = [];
            if (style) parts.push(style);
            if (voice === 'male') parts.push('male vocals');
            else if (voice === 'female') parts.push('female vocals');
            if (title) parts.push('titled "' + title + '"');
            if (prompt) parts.push(prompt);
            const desc = parts.join('. ').slice(0, 4000) || prompt;
            reqBody = { custom_mode: false, mv: 'sonic-v6', gpt_description_prompt: desc };
          }
          const r = await fetch('https://api.musicapi.ai/api/v1/sonic/create', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(60000) });
          const j = await r.json().catch(() => null);
          const taskId = j && (j.task_id || (j.data && j.data.task_id));
          if (taskId) return sendJSON(res, 200, { ok: true, jobId: taskId });
          return sendJSON(res, 200, { ok: false, error: 'MusicAPI: ' + genErrText(j, 'HTTP ' + r.status) });
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'ហៅ API មិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/song/status — {provider:'musicapi', key, jobId}
  if (req.method === 'POST' && urlPath === '/api/gen/song/status') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const provider = body.provider;
        const key = typeof body.key === 'string' ? body.key : '';
        const jobId = String(body.jobId || '');
        if (!jobId) return sendJSON(res, 200, { ok: false, error: 'មិនមាន jobId ទេ' });
        if (provider === 'musicapi') {
          const r = await fetch('https://api.musicapi.ai/api/v1/sonic/task/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(30000) });
          const j = await r.json().catch(() => null);
          if (j && (j.type === 'forbidden' || typeof j.error === 'string')) return sendJSON(res, 200, { ok: false, error: 'MusicAPI: ' + genErrText(j, 'HTTP ' + r.status) });
          const data = (j && j.data) || j || {};
          // MusicAPI real shape: {code:200, data:[{clip_id, state:'succeeded', title, audio_url, ...}, ...]}
          // The state lives INSIDE each clip in the data ARRAY — there is no top-level state.
          if (Array.isArray(data) && data.length) {
            const states = data.map((c) => (c && (c.state || c.status)) || '');
            const allDone = states.every((s) => s === 'succeeded' || s === 'success' || s === 'completed');
            if (allDone) {
              const songs = [];
              data.forEach((c) => { if (c && typeof c.audio_url === 'string' && c.audio_url) songs.push({ url: c.audio_url, title: typeof c.title === 'string' ? c.title : '' }); });
              if (songs.length) return sendJSON(res, 200, { ok: true, status: 'done', songs });
              return sendJSON(res, 200, { ok: true, status: 'done', songs: [], raw: j });
            }
            if (states.some((s) => s === 'failed' || s === 'error')) return sendJSON(res, 200, { ok: false, error: 'MusicAPI: ' + genErrText(j, 'បង្កើតមិនបានទេ') });
            return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: states.find((s) => s && s !== 'succeeded' && s !== 'success' && s !== 'completed') || 'queued' });
          }
          const st = data.state || data.status || (j && (j.state || j.status));
          if (st === 'succeeded' || st === 'success' || st === 'completed') {
            const songs = [];
            const collect = (o) => {
              if (!o || typeof o !== 'object') return;
              if (Array.isArray(o)) { o.forEach(collect); return; }
              if (typeof o.audio_url === 'string' && o.audio_url) songs.push({ url: o.audio_url, title: typeof o.title === 'string' ? o.title : '' });
              if (Array.isArray(o.audio_urls)) o.audio_urls.forEach((u) => { if (typeof u === 'string' && u) songs.push({ url: u }); });
              if (Array.isArray(o.clips)) o.clips.forEach(collect);
              if (Array.isArray(o.songs)) o.songs.forEach(collect);
              if (o.data) collect(o.data);
            };
            collect(data);
            if (songs.length) return sendJSON(res, 200, { ok: true, status: 'done', songs });
            return sendJSON(res, 200, { ok: true, status: 'done', songs: [], raw: j });
          }
          if (st === 'failed' || st === 'error') return sendJSON(res, 200, { ok: false, error: 'MusicAPI: ' + genErrText(j, 'បង្កើតមិនបានទេ') });
          return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: st || 'queued' });
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/gen/video/file?u=<encoded provider URL> — proxy download (CORS workaround)
  if (req.method === 'GET' && urlPath === '/api/gen/video/file') {
    const u = new URL(req.url, 'http://localhost').searchParams.get('u') || '';
    let target;
    try { target = new URL(u); } catch { res.writeHead(400); return res.end('Bad url'); }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') { res.writeHead(400); return res.end('Bad url'); }
    fetch(target.toString(), { signal: AbortSignal.timeout(300000) }).then(async (r) => {
      if (!r.ok) { res.writeHead(502); return res.end('Upstream ' + r.status); }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'video/mp4', 'Content-Disposition': 'attachment; filename="movai-video.mp4"', 'Content-Length': buf.length });
      res.end(buf);
    }).catch(() => { try { res.writeHead(502); res.end('Fetch failed'); } catch {} });
    return;
  }
  return sendJSON(res, 404, errBody('not_found', 'រកមិនឃើញទេ', 'Not found'));
}

/* ------------------------------- static files ------------------------------ */
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.startsWith('/api/')) return apiRoute(req, res, urlPath);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log('MovAi Gen live on port ' + PORT));
}
module.exports = { server };
