// MovAi — បង្កើតរូបភាព & វីដេអូ (standalone image & video generation site)
// Serves index.html and proxies the free image/video APIs so the browser
// never hits CORS problems. The server NEVER stores API keys — keys arrive
// with each request only, from the visitor's own browser (localStorage).
// Run:  node server.js        (PORT env var, default 3000)
const http = require('http');
const crypto = require('crypto');
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
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // CORS: the MovAi website and the MovAi Admin app are separate origins.
    // Without these headers the browser blocks every API call (preflight).
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
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

/* ------------------------- MovAi Admin API (/api/admin/*) ------------------ */
// The MovAi website and the separate MovAi Admin app both talk to THIS server.
// Accounts + credits live here (file ./data/users.json) so the admin can see
// every user and grant credits. The website's localStorage is only a cache;
// the server is the truth for credits.
// Admin-only endpoints need:  Authorization: Bearer <MOVAI_ADMIN_KEY>
// (env var on the Render service; never in code, never in git).
// /api/admin/sync is called by the website itself (no admin key) so a user
// can register and read their server balance.
// NOTE: Render free disk is ephemeral — ./data can be lost on restart/redeploy.
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GRANTS_FILE = path.join(DATA_DIR, 'grants.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const FREE_MEDIA_CREDITS = 250;
const FREE_SONG_CREDITS = 24;

/* ---------------- GitHub-backed persistent storage ----------------- */
// Render free disk is ephemeral — ./data/*.json is wiped on restart, so
// posts, credits and users vanish. When MOVAI_GITHUB_TOKEN is set, the 15
// JSON data files are ALSO stored in a private GitHub repo (branch main,
// repo root, same filenames). On startup the server pulls each file from
// GitHub into the local ./data/ cache (overwriting local); on every local
// write it ALSO pushes to GitHub. Most files are fire-and-forget (never
// blocks a response, failures only logged); the CRITICAL writes (public
// post, grant, purchase approve, user sync) AWAIT the GitHub PUT via
// ghFlushFile before returning success, so a restart cannot lose a write
// already reported as ok. When the token is unset, behaviour is EXACTLY
// as before (local ./data/*.json only).
// Uploads (./data/uploads/) are binary and stay local/ephemeral.
// The token is NEVER hardcoded and NEVER logged — only process.env.
const GH_REPO = process.env.MOVAI_DATA_REPO || 'sokhoeun356/movai-data';
const GH_TOKEN = process.env.MOVAI_GITHUB_TOKEN || '';
const GH_DATA_FILES = [
  'users.json', 'grants.json', 'settings.json', 'admin-keys.json',
  'activity.json', 'followers.json', 'notifications.json', 'vapid.json',
  'push-subs.json', 'packages.json', 'purchase-requests.json',
  'public.json', 'package-events.json', 'blocked-models.json',
  'model-logins.json',
];
const ghShaCache = {}; // filename -> GitHub blob sha (for PUT updates)
function ghEnabled() { return !!GH_TOKEN; }
function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'movai-proxy',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
function ghContentsUrl(name) {
  return 'https://api.github.com/repos/' + GH_REPO + '/contents/' + encodeURIComponent(name);
}
// GET one file from GitHub. Returns {sha, text} or null (missing/unreachable).
async function ghGetFile(name) {
  const r = await fetch(ghContentsUrl(name) + '?ref=main', { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || typeof j.content !== 'string') return null;
  const text = Buffer.from(j.content.replace(/\s/g, ''), 'base64').toString('utf8');
  return { sha: typeof j.sha === 'string' ? j.sha : '', text };
}
// PUT one file to GitHub (create or update). Returns a Promise<boolean>:
// true = confirmed on GitHub, false = failed (logged, never throws).
// Writes for the SAME file are serialized through a per-file queue so
// rapid successive writes each land in order (no lost updates, no sha
// races); writes for different files run in parallel.
const ghQueue = {}; // filename -> Promise<boolean> (tail of the chain)
function ghPutFile(name, text) {
  const prev = ghQueue[name] || Promise.resolve(true);
  const p = prev.catch(() => {}).then(() => ghPutFileInner(name, text));
  ghQueue[name] = p;
  const done = p.then(
    (ok) => { if (ghQueue[name] === p) delete ghQueue[name]; return ok; },
    () => { if (ghQueue[name] === p) delete ghQueue[name]; return false; }
  );
  return done;
}
async function ghPutFileInner(name, text) {
  try {
    let sha = ghShaCache[name] || '';
    if (!sha) {
      const cur = await ghGetFile(name);
      if (cur && cur.sha) sha = cur.sha;
    }
    const send = async (useSha) => {
      const body = { message: 'movai-proxy: update ' + name, content: Buffer.from(text, 'utf8').toString('base64'), branch: 'main' };
      if (useSha) body.sha = useSha;
      return fetch(ghContentsUrl(name), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    };
    let r = await send(sha);
    if ((r.status === 409 || r.status === 422) && sha) {
      // Sha went stale (concurrent update) — refetch and retry once.
      const cur = await ghGetFile(name);
      if (cur && cur.sha) r = await send(cur.sha);
    }
    if (!r.ok) { console.log('[github] PUT ' + name + ' failed: HTTP ' + r.status); return false; }
    const j = await r.json().catch(() => null);
    if (j && j.content && typeof j.content.sha === 'string') ghShaCache[name] = j.content.sha;
    return true;
  } catch (e) {
    console.log('[github] PUT ' + name + ' error: ' + (e && e.message ? e.message : e));
    return false;
  }
}
// Called AFTER a local write of a JSON data file. Fire-and-forget: never
// blocks the API response and never throws. No-op when the token is unset.
function ghPersistFile(filePath) {
  if (!ghEnabled()) return;
  const name = path.basename(filePath);
  if (!GH_DATA_FILES.includes(name)) return;
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) { return; }
  ghPutFile(name, text).catch(() => {});
}
// Awaited flush for CRITICAL data (public post, grant, purchase approve,
// user sync): waits until the latest local content of filePath is confirmed
// on GitHub BEFORE the handler returns success, so a Render restart in the
// next second cannot lose a write that was already reported as ok.
// Returns true on success, false when GitHub failed — the local data is
// still saved, so the caller must NOT fail the request for a GitHub
// hiccup, only log it. Never throws. No-op (returns true) when GitHub is
// disabled or the file is not a tracked data file.
async function ghFlushFile(filePath) {
  if (!ghEnabled()) return true;
  const name = path.basename(filePath);
  if (!GH_DATA_FILES.includes(name)) return true;
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) { return false; }
  const ok = await ghPutFile(name, text);
  if (!ok) console.log('[github] FLUSH ' + name + ' failed — local data saved, GitHub not yet updated (will retry on next write)');
  return ok;
}
// Startup restore: pull every JSON data file from GitHub into the local
// ./data/ cache (overwrites local). Missing/unreachable files keep the
// local copy. Never throws. Runs before the server starts listening.
async function ghRestoreAll() {
  if (!ghEnabled()) return;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  await Promise.all(GH_DATA_FILES.map(async (name) => {
    try {
      const cur = await ghGetFile(name);
      if (!cur) return;
      JSON.parse(cur.text); // validate JSON before overwriting the local cache
      fs.writeFileSync(path.join(DATA_DIR, name), cur.text);
      if (cur.sha) ghShaCache[name] = cur.sha;
      console.log('[github] restored ' + name);
    } catch (e) {
      console.log('[github] restore ' + name + ' skipped: ' + (e && e.message ? e.message : e));
    }
  }));
}

function adminKeyOk(req) {
  const k = process.env.MOVAI_ADMIN_KEY;
  if (!k) return { ok: false, error: 'Admin key not configured on server' };
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m || m[1] !== k) return { ok: false, error: 'Admin key មិនត្រឹមត្រូវទេ' };
  return { ok: true };
}
function normEmail(v) {
  if (typeof v !== 'string') return '';
  const e = v.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}
function numOr(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
function loadUsers() {
  try { const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch (e) {}
  return {};
}
function saveUsers(u) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
  ghPersistFile(USERS_FILE);
}
// User IDs: 10 chars, uppercase letters + digits, no confusing chars
// (0/O and 1/I excluded). Auto-generated once on first sync; once assigned
// it NEVER changes. Used in the user's Profile (with a Copy button) and in
// the Admin app so the admin can tell users apart.
const USER_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genUserId(existingIds) {
  let id = '';
  do {
    id = '';
    for (let i = 0; i < 10; i++) id += USER_ID_CHARS[crypto.randomInt(USER_ID_CHARS.length)];
  } while (existingIds && existingIds.has(id));
  return id;
}
// Client IP + device type, captured on every /api/admin/sync so the Admin
// app can show where each user connects from and on what device. The IP
// comes from X-Forwarded-For (Render/proxy) with a socket fallback; the
// device is parsed from the User-Agent header. No DNS server info is
// available to a web server — the browser never sends it.
function getClientIp(req) {
  try {
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const first = xff.split(',')[0].trim();
      if (first) return first.replace(/^::ffff:/, '').slice(0, 64);
    }
    const ra = req.socket && req.socket.remoteAddress;
    if (ra) return String(ra).replace(/^::ffff:/, '').slice(0, 64);
  } catch (e) {}
  return '';
}
function deviceFromUA(ua) {
  const s = typeof ua === 'string' ? ua : '';
  if (/Android/i.test(s)) return 'Android';
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s)) return 'iPad';
  if (/Windows/i.test(s)) return 'Windows PC';
  if (/Macintosh|Mac OS X/i.test(s)) return 'Mac';
  if (/CrOS/i.test(s)) return 'Chromebook';
  if (/Linux/i.test(s)) return 'Linux';
  return s ? 'Unknown' : '';
}
// Device MODEL CODE from the User-Agent, stored on the user record next to
// device/lastIp/lastSeen. Android carries the model in parentheses, e.g.
// "Linux; Android 13; CPH2325" -> "CPH2325" (the token right after the
// Android version, up to the first space/;/)). iPhone/iPad/desktop return
// the device family (those browsers send no per-model code).
function modelFromUA(ua) {
  const s = typeof ua === 'string' ? ua : '';
  if (!s) return '';
  const m = /Android\s+[\d.]+;\s*([^\s;)]+)/i.exec(s);
  if (m && m[1]) return m[1].trim().slice(0, 64);
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s)) return 'iPad';
  if (/Windows/i.test(s)) return 'Windows PC';
  if (/Macintosh|Mac OS X/i.test(s)) return 'Mac';
  if (/CrOS/i.test(s)) return 'Chromebook';
  if (/Linux/i.test(s)) return 'Linux';
  return 'Unknown';
}
// Blocked device models (./data/blocked-models.json) — an array of model
// codes. A blocked model cannot sync (no user created/updated, no credits
// granted). GitHub-backed like the other data files.
const BLOCKED_MODELS_FILE = path.join(DATA_DIR, 'blocked-models.json');
function loadBlockedModels() {
  try { const j = JSON.parse(fs.readFileSync(BLOCKED_MODELS_FILE, 'utf8')); if (Array.isArray(j)) return j.filter((x) => typeof x === 'string'); } catch (e) {}
  return [];
}
function saveBlockedModels(arr) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(BLOCKED_MODELS_FILE, JSON.stringify(arr, null, 2));
  ghPersistFile(BLOCKED_MODELS_FILE);
}
// Login count per device model (./data/model-logins.json) — a map
// model code -> number of syncs (logins) from that model. Incremented on
// every /api/admin/sync that carries a model. GitHub-backed.
const MODEL_LOGINS_FILE = path.join(DATA_DIR, 'model-logins.json');
function loadModelLogins() {
  try { const j = JSON.parse(fs.readFileSync(MODEL_LOGINS_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch (e) {}
  return {};
}
function saveModelLogins(m) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(MODEL_LOGINS_FILE, JSON.stringify(m, null, 2));
  ghPersistFile(MODEL_LOGINS_FILE);
}
function pubUser(u, modelLogins) {
  const map = modelLogins || loadModelLogins();
  const model = u.model || '';
  const count = model && map && typeof map === 'object' ? (Number(map[model]) || 0) : 0;
  return { id: u.id || '', email: u.email, name: u.name || '', firstName: u.firstName || '', lastName: u.lastName || '', credits: u.credits, songCredits: u.songCredits, plan: u.plan || '', songPlan: u.songPlan || '', createdAt: u.createdAt, updatedAt: u.updatedAt, lastIp: u.lastIp || '', device: u.device || '', model, modelLogins: count, lastSeen: u.lastSeen || '' };
}
function logGrant(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let arr = [];
    try { const j = JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8')); if (Array.isArray(j)) arr = j; } catch (e) {}
    arr.push(entry);
    if (arr.length > 1000) arr = arr.slice(-1000);
    fs.writeFileSync(GRANTS_FILE, JSON.stringify(arr, null, 2));
    ghPersistFile(GRANTS_FILE);
  } catch (e) {}
}
// Activity log (./data/activity.json) — one record per generation attempt
// (create calls only: /api/gen/image, /api/gen/video, /api/gen/song) and
// per /api/admin/sync call (user sign-in/app open), so the Admin app can
// show daily/weekly/monthly users and per-day generations + failures.
// Never logs API keys. Capped at 5000 records (oldest dropped).
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const ACTIVITY_MAX = 5000;
function loadActivity() {
  try { const j = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); if (Array.isArray(j)) return j; } catch (e) {}
  return [];
}
function saveActivity(arr) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(arr, null, 2));
  ghPersistFile(ACTIVITY_FILE);
}
function logActivity(rec) {
  try {
    const arr = loadActivity();
    arr.push(rec);
    if (arr.length > ACTIVITY_MAX) arr.splice(0, arr.length - ACTIVITY_MAX);
    saveActivity(arr);
  } catch (e) {}
}
// Wrap res.end so exactly one activity record is written when a generation
// endpoint sends its response. ctx = {provider, email} — the handler fills
// it in after parsing the body; the wrapper reads it at response time.
// mode = 'image' | 'video' | 'song'.
function wrapGenLog(res, mode, ctx) {
  const origEnd = res.end.bind(res);
  let logged = false;
  res.end = function (chunk, ...rest) {
    if (!logged) {
      logged = true;
      try {
        const j = chunk ? JSON.parse(chunk.toString('utf8')) : null;
        const ok = !!(j && j.ok);
        let err = '';
        if (!ok && j) {
          if (typeof j.error === 'string') err = j.error;
          else if (j.message && typeof j.message === 'string') err = j.message;
          else if (j.message && j.message.km) err = j.message.km;
        }
        logActivity({ at: new Date().toISOString(), mode, provider: ctx.provider || '', ok, error: String(err || '').slice(0, 200), email: ctx.email || '' });
      } catch (e) {}
    }
    return origEnd(chunk, ...rest);
  };
}
// Followers of the Public page (./data/followers.json) — users who tapped
// Follow on the Public page. A new public post notifies ONLY followers
// (in-app 'post' notification + Web Push to their phones). Stored as a
// plain array of lowercased emails, capped at 5000.
const FOLLOWERS_FILE = path.join(DATA_DIR, 'followers.json');
const FOLLOWERS_MAX = 5000;
function loadFollowers() {
  try { const j = JSON.parse(fs.readFileSync(FOLLOWERS_FILE, 'utf8')); if (Array.isArray(j)) return j.filter((e) => typeof e === 'string'); } catch (e) {}
  return [];
}
function saveFollowers(arr) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(FOLLOWERS_FILE, JSON.stringify(arr, null, 2));
  ghPersistFile(FOLLOWERS_FILE);
}
// Notifications (./data/notifications.json) — real notifications for the
// admin AND for users. The Admin app reads them (GET /api/admin/notifications)
// and the website reads its own (GET /api/public/notifications?email=).
// Each notification: {id, at, kind, email, title, text, read:false}.
// Kinds: 'login' (new user first sync), 'purchase-request', 'purchase-approved',
// 'purchase-rejected', 'gift-claimed' (new user claims the free gift),
// 'grant' (admin grants credits), 'deduct' (admin deducts credits),
// 'post' (new PUBLIC post — broadcast: email '*', shown to every user
// and pushed to every subscribed phone immediately).
// Stored newest first, capped at 5000 (oldest dropped).
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const NOTIFICATIONS_MAX = 5000;
function loadNotifications() {
  try { const j = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8')); if (Array.isArray(j)) return j; } catch (e) {}
  return [];
}
function saveNotifications(arr) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(arr, null, 2));
  ghPersistFile(NOTIFICATIONS_FILE);
}
function newNotificationId() {
  return 'ntf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
// Create a notification. For admin-facing kinds (login, purchase-request,
// gift-claimed) ALSO send a Telegram message to the admin (fire-and-forget:
// it never blocks the response and its errors are swallowed). The bot token
// is never logged and never returned by any endpoint.
function addNotification(kind, email, title, text) {
  const n = { id: newNotificationId(), at: new Date().toISOString(), kind, email: email || '', title: title || '', text: text || '', read: false };
  try {
    const arr = loadNotifications();
    arr.unshift(n);
    if (arr.length > NOTIFICATIONS_MAX) arr.length = NOTIFICATIONS_MAX;
    saveNotifications(arr);
  } catch (e) {}
  if (kind === 'login' || kind === 'purchase-request' || kind === 'gift-claimed') {
    sendTelegramAdmin('🔔 ' + n.title + '\n' + n.text);
  }
  // Phone-native Web Push for the same event (admin devices and/or the
  // user the notification is about). Fire-and-forget, never blocks.
  sendPushForNotification(n);
  return n;
}
function sendTelegramAdmin(text) {
  try {
    const s = loadSettings();
    const tel = (s && s.telegram && typeof s.telegram === 'object' && !Array.isArray(s.telegram)) ? s.telegram : {};
    const token = typeof tel.botToken === 'string' ? tel.botToken.trim() : '';
    const chatId = typeof tel.chatId === 'string' ? tel.chatId.trim() : '';
    if (!token || !chatId) return; // not configured — skip silently
    fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  } catch (e) {}
}
// Web Push notifications (phone-native push, from the phone itself — not
// Telegram). Uses the `web-push` package + VAPID keys.
// VAPID keys: ./data/vapid.json, created on first use if missing (never in
// code, never in git). The PUBLIC key is exposed at GET /api/public/vapid-key
// so the website/Admin app can subscribe; the PRIVATE key never leaves the
// server. Push subscriptions: ./data/push-subs.json, capped at 5000.
// A subscription: {email, endpoint, keys:{p256dh, auth}, role, createdAt,
// updatedAt}. role 'admin' marks an admin device (the Admin app subscribes
// with {email:<admin gmail>, role:'admin'}).
const ADMIN_EMAILS = ['sokhoeun7788@gmail.com', 'yemsokhoeun98@gmail.com', 'sokhoeun350@gmail.com'];
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const VAPID_SUBJECT = 'mailto:sokhoeun356@gmail.com';
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');
const PUSH_SUBS_MAX = 5000;
let webPushLib = undefined; // undefined = not tried yet
function getWebPush() {
  if (webPushLib === undefined) {
    try { webPushLib = require('web-push'); } catch (e) { webPushLib = null; }
  }
  return webPushLib;
}
function getVapidKeys() {
  const wp = getWebPush();
  if (!wp) return null;
  try {
    let keys = null;
    try {
      const j = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (j && typeof j.publicKey === 'string' && j.publicKey && typeof j.privateKey === 'string' && j.privateKey) keys = j;
    } catch (e) {}
    if (!keys) {
      keys = wp.generateVAPIDKeys();
      try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
      fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
      ghPersistFile(VAPID_FILE);
    }
    wp.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    return keys;
  } catch (e) { return null; }
}
function getVapidPublicKey() {
  const keys = getVapidKeys();
  return keys ? keys.publicKey : '';
}
function loadPushSubs() {
  try { const j = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')); if (Array.isArray(j)) return j; } catch (e) {}
  return [];
}
function savePushSubs(arr) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(arr, null, 2));
  ghPersistFile(PUSH_SUBS_FILE);
}
// Validate a browser PushSubscription JSON. Returns {endpoint, keys} or null.
function cleanPushSub(s) {
  if (!s || typeof s !== 'object') return null;
  const endpoint = typeof s.endpoint === 'string' ? s.endpoint.trim() : '';
  if (!endpoint || endpoint.length > 2000) return null;
  const keys = s.keys && typeof s.keys === 'object' ? s.keys : {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  if (!p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}
function removePushSubByEndpoint(endpoint) {
  try {
    const arr = loadPushSubs();
    const kept = arr.filter((s) => s && s.endpoint !== endpoint);
    if (kept.length !== arr.length) savePushSubs(kept);
  } catch (e) {}
}
// Send one Web Push. Fire-and-forget: the caller never awaits it. A 410/404
// from the push service means the subscription is gone — delete it. All
// other push errors are swallowed.
function sendWebPush(sub, payload) {
  const wp = getWebPush();
  if (!wp) return;
  const keys = getVapidKeys();
  if (!keys) return;
  const subObj = cleanPushSub(sub);
  if (!subObj) return;
  try {
    const p = wp.sendNotification(subObj, JSON.stringify(payload));
    Promise.resolve(p).catch((err) => {
      const code = err && err.statusCode;
      if (code === 410 || code === 404) removePushSubByEndpoint(subObj.endpoint);
    });
  } catch (e) {}
}
// Send a Web Push for a notification. Admin kinds (login, purchase-request,
// gift-claimed) go to admin subscriptions (role 'admin' or an admin Gmail);
// user kinds (purchase-approved, purchase-rejected, grant, deduct,
// gift-claimed) go to that user's own subscriptions. Deduplicated by
// endpoint. Fire-and-forget — never blocks the response.
function sendPushForNotification(n) {
  try {
    const ADMIN_KINDS = ['login', 'purchase-request', 'gift-claimed'];
    const USER_KINDS = ['purchase-approved', 'purchase-rejected', 'grant', 'deduct', 'gift-claimed', 'post'];
    const subs = loadPushSubs();
    if (!subs.length) return;
    const targets = new Map();
    for (const s of subs) {
      if (!s || typeof s.endpoint !== 'string') continue;
      const sEmail = String(s.email || '').toLowerCase();
      const isAdminSub = s.role === 'admin' || ADMIN_EMAILS.includes(sEmail);
      const isUserSub = !!n.email && sEmail === String(n.email).toLowerCase();
      // 'post' notifications now carry a real follower email (per-follower),
      // so they flow through USER_KINDS above. The old '*' broadcast is
      // kept only for backward compat with any broadcast already stored.
      const isBroadcast = n.email === '*';
      if (isBroadcast || (ADMIN_KINDS.includes(n.kind) && isAdminSub) || (USER_KINDS.includes(n.kind) && isUserSub)) {
        targets.set(s.endpoint, s);
      }
    }
    if (!targets.size) return;
    const payload = { title: n.title || 'MovAi', body: n.text || '', tag: n.kind || 'movai' };
    for (const s of targets.values()) sendWebPush(s, payload);
  } catch (e) {}
}
function fmtCreditDelta(dMedia, dSong) {
  const parts = [];
  if (dMedia) parts.push((dMedia > 0 ? '+' : '') + dMedia + ' Image.Video');
  if (dSong) parts.push((dSong > 0 ? '+' : '') + dSong + ' Song');
  return parts.join(' / ') || '0';
}
// Server settings (admin-controlled, read by the website). smoothModeAuto:
// when true, every MovAi website enables Smooth mode automatically.
// Appearance fields mirror the website's own Settings (localStorage keys
// movai-theme / movai-font / movai-glass-* / movai-tshadow / movai-txtblur /
// movai-bgb / movai-brandfx / movai-mode) — the admin is the truth for them;
// the website applies them on load and hides its own appearance controls.
const SETTINGS_DEFAULTS = {
  smoothModeAuto: false,
  theme: 0, font: 50,
  glassClear: 45, glassBlur: 65, glassShine: 55,
  tshadow: 'none', txtblur: 0, bgb: 50, brandfx: 'none', mode: 'dark',
  // Active provider/model per mode, set by the admin. null = admin has not
  // set one yet — the website shows "admin មិនទាន់កំណត់" for that mode.
  providers: { image: null, video: null, song: null },
  // Admin-locked models (master switch). Map "provider:model" -> true.
  // A locked model is not used/shown in MovAi. Empty = nothing locked.
  lockedModels: {},
  // Payment settings (admin-controlled, read by the website for the Buy
  // flow). khqrLink = Canadia Bank KHQR payment link (local payers);
  // binanceUsdtAddress = Binance USDT wallet address (foreign payers).
  // Only these two strings are stored — no bank account numbers, no
  // holder names, no passwords, no keys.
  payment: {
    khqrLink: 'https://pay.canadiabank.com.kh/K6EkJR30W0BM3VVK',
    binanceUsdtAddress: '',
  },
  // Telegram notifications for the admin. botToken is a SECRET — it is
  // never returned by any endpoint (GET /api/admin/settings exposes only
  // hasBotToken) and never logged. chatId = the admin's Telegram chat.
  telegram: {
    botToken: '',
    chatId: '',
  },
};
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function cleanSettings(j, base) {
  // base = stored settings when merging (invalid/missing fields keep the
  // stored value); defaults when loading from disk.
  const s = Object.assign({}, base || SETTINGS_DEFAULTS);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return s;
  if (typeof j.smoothModeAuto === 'boolean') s.smoothModeAuto = j.smoothModeAuto;
  s.theme = Math.round(clampNum(j.theme, 0, 6, s.theme));
  s.font = clampNum(j.font, 0, 100, s.font);
  s.glassClear = clampNum(j.glassClear, 0, 100, s.glassClear);
  s.glassBlur = clampNum(j.glassBlur, 0, 100, s.glassBlur);
  s.glassShine = clampNum(j.glassShine, 0, 100, s.glassShine);
  if (typeof j.tshadow === 'string' && j.tshadow) s.tshadow = j.tshadow.slice(0, 50);
  s.txtblur = clampNum(j.txtblur, 0, 100, s.txtblur);
  s.bgb = clampNum(j.bgb, 0, 100, s.bgb);
  if (typeof j.brandfx === 'string' && j.brandfx) s.brandfx = j.brandfx.slice(0, 50);
  if (j.mode === 'dark' || j.mode === 'light' || j.mode === 'auto') s.mode = j.mode;
  // Active providers per mode. A mode is valid only when it has a provider
  // name; null clears it; missing/invalid keeps the stored (base) value.
  const baseProv = (base && base.providers && typeof base.providers === 'object') ? base.providers : SETTINGS_DEFAULTS.providers;
  const prov = {};
  for (const m of ['image', 'video', 'song']) {
    const v = j.providers && typeof j.providers === 'object' ? j.providers[m] : undefined;
    if (v && typeof v === 'object' && typeof v.provider === 'string' && v.provider.trim()) {
      prov[m] = { provider: v.provider.trim().toLowerCase().slice(0, 100), model: typeof v.model === 'string' ? v.model.trim().slice(0, 100) : '' };
    } else if (v === null) {
      prov[m] = null;
    } else {
      prov[m] = baseProv[m] || null;
    }
  }
  s.providers = prov;
  // Admin-locked models (master switch). When the field is present it
  // REPLACES the stored map (Admin app always sends the full object);
  // when absent the stored value is kept. Only boolean true entries are
  // kept; key format "provider:model".
  if (j.lockedModels && typeof j.lockedModels === 'object' && !Array.isArray(j.lockedModels)) {
    const locked = {};
    for (const k of Object.keys(j.lockedModels)) {
      if (j.lockedModels[k] === true) locked[k.slice(0, 100)] = true;
    }
    s.lockedModels = locked;
  } else {
    const baseLocked = (base && base.lockedModels && typeof base.lockedModels === 'object' && !Array.isArray(base.lockedModels)) ? base.lockedModels : {};
    s.lockedModels = Object.assign({}, baseLocked);
  }
  // Payment settings. Both fields are plain strings (max 500 chars);
  // missing/invalid fields keep the stored (base) value. An empty string
  // is valid (means "not set yet").
  const basePay = (base && base.payment && typeof base.payment === 'object' && !Array.isArray(base.payment)) ? base.payment : SETTINGS_DEFAULTS.payment;
  const payIn = (j.payment && typeof j.payment === 'object' && !Array.isArray(j.payment)) ? j.payment : {};
  s.payment = {
    khqrLink: typeof payIn.khqrLink === 'string' ? payIn.khqrLink.trim().slice(0, 500) : (typeof basePay.khqrLink === 'string' ? basePay.khqrLink : SETTINGS_DEFAULTS.payment.khqrLink),
    binanceUsdtAddress: typeof payIn.binanceUsdtAddress === 'string' ? payIn.binanceUsdtAddress.trim().slice(0, 500) : (typeof basePay.binanceUsdtAddress === 'string' ? basePay.binanceUsdtAddress : SETTINGS_DEFAULTS.payment.binanceUsdtAddress),
  };
  // Telegram notifications for the admin. botToken is a SECRET: a
  // non-empty string sets/rotates it; an empty string or missing field
  // KEEPS the stored token (the Admin app leaves the field blank when it
  // does not know the token — that must never wipe it); null clears it.
  // chatId follows the same rule (non-empty sets, empty/missing keeps, null clears).
  const baseTel = (base && base.telegram && typeof base.telegram === 'object' && !Array.isArray(base.telegram)) ? base.telegram : SETTINGS_DEFAULTS.telegram;
  const telIn = (j.telegram && typeof j.telegram === 'object' && !Array.isArray(j.telegram)) ? j.telegram : {};
  let botToken;
  if (typeof telIn.botToken === 'string' && telIn.botToken.trim()) botToken = telIn.botToken.trim().slice(0, 500);
  else if (telIn.botToken === null) botToken = '';
  else botToken = typeof baseTel.botToken === 'string' ? baseTel.botToken : '';
  let chatId;
  if (typeof telIn.chatId === 'string' && telIn.chatId.trim()) chatId = telIn.chatId.trim().slice(0, 200);
  else if (telIn.chatId === null) chatId = '';
  else chatId = typeof baseTel.chatId === 'string' ? baseTel.chatId : '';
  s.telegram = { botToken, chatId };
  return s;
}
function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return cleanSettings(j);
  } catch (e) {}
  return Object.assign({}, SETTINGS_DEFAULTS);
}
function saveSettings(s, base) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  const out = cleanSettings(s, base);
  out.updatedAt = new Date().toISOString();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2));
  ghPersistFile(SETTINGS_FILE);
  return out;
}
// Public-safe settings: the Telegram bot token is a secret and is NEVER
// returned (GET /api/admin/settings is public). Clients only see
// hasBotToken (whether a token is set) + chatId. To set/rotate the token,
// POST telegram.botToken as a non-empty string; an empty/missing botToken
// keeps the stored one.
function publicSettings(s) {
  const out = Object.assign({}, s);
  const tel = (s && s.telegram && typeof s.telegram === 'object' && !Array.isArray(s.telegram)) ? s.telegram : {};
  out.telegram = { hasBotToken: !!(typeof tel.botToken === 'string' && tel.botToken.trim()), chatId: typeof tel.chatId === 'string' ? tel.chatId : '' };
  return out;
}
// Admin provider keys (./data/admin-keys.json). The admin puts each
// provider's API key here from the Admin app; the server uses them to call
// providers so the browser never holds a key. Key VALUES are never returned
// by any endpoint and never go into git — only the file on this server.
// Providers: novai, magichour, masterpiecex, hunyuan3d, suno, acemusic,
// musicapi (tavus kept for the legacy proxy branch).
const ADMIN_KEYS_FILE = path.join(DATA_DIR, 'admin-keys.json');
const KNOWN_KEY_PROVIDERS = ['novai', 'magichour', 'masterpiecex', 'hunyuan3d', 'suno', 'acemusic', 'musicapi', 'tavus'];
function normProvider(v) {
  if (typeof v !== 'string') return '';
  let p = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (p === 'movai') p = 'suno'; // MovAi is the display name of the Suno provider
  return p;
}
function loadAdminKeys() {
  try { const j = JSON.parse(fs.readFileSync(ADMIN_KEYS_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch (e) {}
  return {};
}
function saveAdminKeys(k) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify(k, null, 2));
  ghPersistFile(ADMIN_KEYS_FILE);
}
// {key, endpoint} stored for a provider, or null. endpoint is the Suno
// gateway URL (only Suno needs one — the other providers have fixed hosts).
function adminProviderKey(provider) {
  const k = loadAdminKeys()[normProvider(provider)];
  if (!k || typeof k !== 'object') return null;
  return {
    key: typeof k.key === 'string' ? k.key.trim() : '',
    endpoint: typeof k.endpoint === 'string' ? k.endpoint.trim() : '',
  };
}
// Resolve a provider API key: the request's own key first, else the
// admin-stored key. The browser now sends no key — the admin key is used.
function resolveProviderKey(reqKey, provider) {
  if (typeof reqKey === 'string' && reqKey.trim()) return reqKey.trim();
  const a = adminProviderKey(provider);
  return a && a.key ? a.key : '';
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
    const genCtx = { provider: '', email: '' };
    wrapGenLog(res, 'image', genCtx);
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (body && typeof body === 'object') {
        if (typeof body.provider === 'string') genCtx.provider = body.provider;
        if (typeof body.email === 'string') genCtx.email = body.email;
      }
      try {
        if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        const provider = body.provider;
        const key = typeof body.key === 'string' ? body.key : '';
        const prompt = body.prompt.trim().slice(0, 2000);
        const width = Math.max(64, Math.min(2048, Number(body.width) || 768));
        const height = Math.max(64, Math.min(2048, Number(body.height) || 768));
        if (provider === 'magichour') {
          // Magic Hour image via the admin-stored key (browser sends no key).
          const k = resolveProviderKey(key, 'magichour');
          if (!k) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
          const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 100) : 'z-image-turbo';
          const r = await fetch('https://api.magichour.ai/v1/ai-image-generator', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MovAi image', model, style: { prompt } }), signal: AbortSignal.timeout(60000) });
          const j = await r.json().catch(() => null);
          const id = j && j.id;
          if (id) return sendJSON(res, 200, { ok: true, jobId: id });
          return sendJSON(res, 200, { ok: false, error: 'Magic Hour: ' + genErrText(j, 'HTTP ' + r.status) });
        }
        if (provider === 'novai') {
          // NovAI image via the admin-stored key (browser sends no key).
          const k = resolveProviderKey(key, 'novai');
          if (!k) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ NovAI Key ទេ' });
          const size = Math.min(2048, Math.max(64, width)) + 'x' + Math.min(2048, Math.max(64, height));
          const r = await fetch('https://aiapi-pro.com/v1/images/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cogview-3-flash', prompt, size }), signal: AbortSignal.timeout(120000) });
          const j = await r.json().catch(() => null);
          const url = j && j.data && j.data[0] && j.data[0].url;
          if (url) return sendJSON(res, 200, { ok: true, done: true, imageUrl: url });
          const id = j && (j.id || (j.data && j.data.id));
          if (id) return sendJSON(res, 200, { ok: true, jobId: id });
          return sendJSON(res, 200, { ok: false, error: 'NovAI: ' + genErrText(j, 'HTTP ' + r.status) });
        }
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
  // POST /api/gen/image/status — {provider:'magichour'|'novai', key, jobId}
  if (req.method === 'POST' && urlPath === '/api/gen/image/status') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const provider = body.provider;
        const jobId = String(body.jobId || '');
        if (!jobId) return sendJSON(res, 200, { ok: false, error: 'មិនមាន jobId ទេ' });
        if (provider === 'magichour') {
          const k = resolveProviderKey(body.key, 'magichour');
          if (!k) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
          const r = await fetch('https://api.magichour.ai/v1/image-projects/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
          const j = await r.json().catch(() => null);
          const st = j && j.status;
          if (st === 'complete') {
            const dl = j.downloads && j.downloads[0] && j.downloads[0].url;
            if (dl) return sendJSON(res, 200, { ok: true, status: 'done', imageUrl: dl });
            return sendJSON(res, 200, { ok: true, status: 'done', imageUrl: '', raw: j });
          }
          if (st === 'error') return sendJSON(res, 200, { ok: false, error: 'Magic Hour: ' + ((j && j.error) || 'បង្កើតមិនបានទេ') });
          return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: st || 'queued' });
        }
        if (provider === 'novai') {
          const k = resolveProviderKey(body.key, 'novai');
          if (!k) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ NovAI Key ទេ' });
          const r = await fetch('https://aiapi-pro.com/v1/images/generations/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
          const j = await r.json().catch(() => null);
          const url = j && j.data && j.data[0] && j.data[0].url;
          if (url) return sendJSON(res, 200, { ok: true, status: 'done', imageUrl: url });
          const st = j && (j.status || (j.data && j.data.status));
          if (st === 'failed' || st === 'error') return sendJSON(res, 200, { ok: false, error: 'NovAI: បង្កើតមិនបានទេ' });
          return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: st || 'queued' });
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/video — {provider:'novai'|'magichour'|'tavus'|'hf', key, prompt, duration, res, width, height, replicaId}
  if (req.method === 'POST' && urlPath === '/api/gen/video') {
    const genCtx = { provider: '', email: '' };
    wrapGenLog(res, 'video', genCtx);
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (body && typeof body === 'object') {
        if (typeof body.provider === 'string') genCtx.provider = body.provider;
        if (typeof body.email === 'string') genCtx.email = body.email;
      }
      try {
        if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        const provider = body.provider;
        const key = resolveProviderKey(typeof body.key === 'string' ? body.key : '', provider);
        const prompt = body.prompt.trim().slice(0, 4000);
        const duration = [5, 10].includes(Number(body.duration)) ? Number(body.duration) : 5;
        if (!key) {
          const pname = provider === 'novai' ? 'NovAI' : provider === 'magichour' ? 'Magic Hour' : provider === 'tavus' ? 'Tavus' : null;
          return sendJSON(res, 200, { ok: false, error: pname ? ('Admin មិនទាន់ដាក់ ' + pname + ' Key ទេ') : 'មិនទាន់មាន API Key ទេ' });
        }
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
        const key = resolveProviderKey(typeof body.key === 'string' ? body.key : '', provider);
        const jobId = String(body.jobId || '');
        if (!jobId) return sendJSON(res, 200, { ok: false, error: 'មិនមាន jobId ទេ' });
        if (!key) {
          const pname = provider === 'novai' ? 'NovAI' : provider === 'magichour' ? 'Magic Hour' : provider === 'tavus' ? 'Tavus' : null;
          return sendJSON(res, 200, { ok: false, error: pname ? ('Admin មិនទាន់ដាក់ ' + pname + ' Key ទេ') : 'មិនទាន់មាន API Key ទេ' });
        }
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
    const genCtx = { provider: '', email: '' };
    wrapGenLog(res, 'song', genCtx);
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (body && typeof body === 'object') {
        if (typeof body.provider === 'string') genCtx.provider = body.provider;
        if (typeof body.email === 'string') genCtx.email = body.email;
      }
      try {
        if (!body || (typeof body.prompt !== 'string' && typeof body.title !== 'string' && typeof body.lyrics !== 'string' && typeof body.style !== 'string')) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        const provider = body.provider;
        const key = resolveProviderKey(typeof body.key === 'string' ? body.key : '', 'musicapi');
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
        const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim().slice(0, 4000) : '';
        const style = typeof body.style === 'string' ? body.style.trim().slice(0, 500) : '';
        const voice = body.voice === 'male' || body.voice === 'female' ? body.voice : 'random';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : '';
        const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 50) : 'v6';
        if (!title && !lyrics && !style && !prompt) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        if (provider === 'musicapi' && !key) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ MusicAPI Key ទេ' });
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
        if (provider === 'suno') {
          // Suno (MovAi) via the admin-stored gateway endpoint + key.
          // The browser sends no key and no endpoint — both live on the server.
          const a = adminProviderKey('suno');
          if (!a || !a.key) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
          if (!a.endpoint) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
          const genBody = {
            prompt: lyrics || (style ? style + (title ? ' titled "' + title + '"' : '') : (title || prompt)),
            tags: style || '',
            model,
            make_instrumental: false,
          };
          if (title) genBody.title = title;
          const ep = a.endpoint.replace(/\/+$/, '');
          const r = await fetch(ep + '/api/generate', { method: 'POST', headers: { 'Authorization': 'Bearer ' + a.key, 'Content-Type': 'application/json' }, body: JSON.stringify(genBody), signal: AbortSignal.timeout(60000) });
          const j = await r.json().catch(() => null);
          const ids = [];
          const collectIds = (o) => {
            if (!o) return;
            if (Array.isArray(o)) { o.forEach(collectIds); return; }
            if (typeof o === 'object') {
              if (typeof o.id === 'string' && o.id) ids.push(o.id);
              if (Array.isArray(o.clips)) o.clips.forEach(collectIds);
              if (Array.isArray(o.data)) o.data.forEach(collectIds);
              else if (o.data && typeof o.data === 'object') collectIds(o.data);
            }
          };
          collectIds(j);
          const uniq = [...new Set(ids)];
          if (uniq.length) return sendJSON(res, 200, { ok: true, jobId: uniq.join(',') });
          return sendJSON(res, 200, { ok: false, error: 'Suno: ' + genErrText(j, 'HTTP ' + r.status) });
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
        const key = resolveProviderKey(typeof body.key === 'string' ? body.key : '', 'musicapi');
        const jobId = String(body.jobId || '');
        if (!jobId) return sendJSON(res, 200, { ok: false, error: 'មិនមាន jobId ទេ' });
        if (provider === 'suno') {
          // Suno status: poll the admin gateway /api/get?ids=<clip ids>.
          const a = adminProviderKey('suno');
          if (!a || !a.key) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
          if (!a.endpoint) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
          const ep = a.endpoint.replace(/\/+$/, '');
          const r = await fetch(ep + '/api/get?ids=' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + a.key }, signal: AbortSignal.timeout(30000) });
          const j = await r.json().catch(() => null);
          if (j && typeof j.error === 'string' && j.error) return sendJSON(res, 200, { ok: false, error: 'Suno: ' + j.error });
          const clips = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
          if (clips.length && clips.every((c) => c && typeof c.audio_url === 'string' && c.audio_url)) {
            const songs = clips.map((c) => ({ url: c.audio_url, title: typeof c.title === 'string' ? c.title : '', image: typeof c.image_url === 'string' ? c.image_url : '' }));
            return sendJSON(res, 200, { ok: true, status: 'done', songs });
          }
          if (clips.some((c) => c && (c.status === 'failed' || c.state === 'failed' || c.status === 'error' || c.state === 'error'))) return sendJSON(res, 200, { ok: false, error: 'Suno: បង្កើតមិនបានទេ' });
          return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: 'queued' });
        }
        if (provider === 'musicapi') {
          if (!key) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ MusicAPI Key ទេ' });
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
  // ---- MovAi Admin API ----
  // POST /api/admin/sync — {email, name, credits, songCredits, plan, songPlan}
  // Called by the MovAi website (no admin key). Creates the user on first
  // sync (free grant 250 media + 24 song credits when credits are absent);
  // on later syncs the SERVER credits are the truth — the client's credits
  // are ignored and the server values are returned.
  if (req.method === 'POST' && urlPath === '/api/admin/sync') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      // Blocked device model: refuse the sync entirely — no user is
      // created/updated and no credits are granted.
      const _model = modelFromUA(req.headers && req.headers['user-agent']);
      if (_model && loadBlockedModels().some((b) => b.toUpperCase() === _model.toUpperCase())) {
        return sendJSON(res, 200, { ok: false, error: 'ម៉ូដែលនេះត្រូវបានប្លុក · This device model is blocked' });
      }
      const now = new Date().toISOString();
      logActivity({ at: now, mode: 'sync', email });
      const users = loadUsers();
      const isNewUser = !users[email];
      let u = users[email];
      if (!u) {
        const takenIds = new Set(Object.values(users).map((x) => x.id).filter(Boolean));
        u = {
          id: genUserId(takenIds),
          email,
          name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '',
          firstName: typeof body.firstName === 'string' ? body.firstName.trim().slice(0, 50) : '',
          lastName: typeof body.lastName === 'string' ? body.lastName.trim().slice(0, 50) : '',
          credits: numOr(body.credits, FREE_MEDIA_CREDITS),
          songCredits: numOr(body.songCredits, FREE_SONG_CREDITS),
          plan: typeof body.plan === 'string' ? body.plan.slice(0, 50) : '',
          songPlan: typeof body.songPlan === 'string' ? body.songPlan.slice(0, 50) : '',
          createdAt: now, updatedAt: now,
        };
        users[email] = u;
      } else {
        // Legacy users created before IDs existed get one now; once an id
        // exists it is NEVER changed.
        if (!u.id) {
          const takenIds = new Set(Object.values(users).map((x) => x.id).filter(Boolean));
          u.id = genUserId(takenIds);
        }
        if (typeof body.name === 'string' && body.name.trim()) u.name = body.name.trim().slice(0, 100);
        if (typeof body.firstName === 'string' && body.firstName.trim()) u.firstName = body.firstName.trim().slice(0, 50);
        if (typeof body.lastName === 'string' && body.lastName.trim()) u.lastName = body.lastName.trim().slice(0, 50);
        if (typeof body.plan === 'string') u.plan = body.plan.slice(0, 50);
        if (typeof body.songPlan === 'string') u.songPlan = body.songPlan.slice(0, 50);
        u.updatedAt = now;
      }
      // Capture where this user connects from + on what device (every sync).
      const _cip = getClientIp(req);
      if (_cip) u.lastIp = _cip;
      const _dev = deviceFromUA(req.headers && req.headers['user-agent']);
      if (_dev) u.device = _dev;
      if (_model) u.model = _model;
      u.lastSeen = now;
      // Count this login against the device model.
      let _modelLogins = null;
      if (_model) {
        _modelLogins = loadModelLogins();
        _modelLogins[_model] = (Number(_modelLogins[_model]) || 0) + 1;
        saveModelLogins(_modelLogins);
      }
      u.credits = Math.max(0, Math.floor(numOr(u.credits, 0)));
      u.songCredits = Math.max(0, Math.floor(numOr(u.songCredits, 0)));
      saveUsers(users);
      // Critical write: confirm users.json is on GitHub BEFORE returning
      // success, so a restart in the next second cannot lose this user
      // (new account / first sync / credit truth).
      await ghFlushFile(USERS_FILE);
      if (isNewUser) {
        addNotification('login', email, '👤 អ្នកប្រើថ្មី · New user', (u.name || email) + ' (' + email + ') បាន log in លើកដំបូង');
      }
      if (body && body.giftClaimed === true) {
        addNotification('gift-claimed', email, '🎁 កាដូបានទទួល · Gift claimed', (u.name || email) + ' (' + email + ') បានទទួលកាដូ Free 250 Image.Video + 24 Song Credit');
      }
      return sendJSON(res, 200, { ok: true, user: pubUser(u, _modelLogins) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/users — admin key required. Newest first.
  if (req.method === 'GET' && urlPath === '/api/admin/users') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const users = loadUsers();
    const modelLogins = loadModelLogins();
    const list = Object.values(users).sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || ''))).map((x) => pubUser(x, modelLogins));
    return sendJSON(res, 200, { ok: true, users: list });
  }
  // GET /api/admin/user?email=... — admin key required.
  if (req.method === 'GET' && urlPath === '/api/admin/user') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const u = loadUsers()[email];
    if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
    return sendJSON(res, 200, { ok: true, user: pubUser(u) });
  }
  // POST /api/admin/grant — {email, credits, songCredits, note?} — admin key required.
  // credits/songCredits are DELTAS (can be negative to deduct, balance never below 0).
  if (req.method === 'POST' && urlPath === '/api/admin/grant') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
      const dMedia = Math.floor(numOr(body.credits, 0));
      const dSong = Math.floor(numOr(body.songCredits, 0));
      if (!dMedia && !dSong) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ចំនួន Credit' });
      u.credits = Math.max(0, Math.floor(numOr(u.credits, 0)) + dMedia);
      u.songCredits = Math.max(0, Math.floor(numOr(u.songCredits, 0)) + dSong);
      u.updatedAt = new Date().toISOString();
      saveUsers(users);
      // Critical write: confirm the new balance is on GitHub BEFORE
      // returning success, so a restart cannot lose a granted/deducted
      // credit that the Admin app already reported as done.
      await ghFlushFile(USERS_FILE);
      logGrant({ email, credits: dMedia, songCredits: dSong, note: typeof body.note === 'string' ? body.note.slice(0, 200) : '', at: u.updatedAt });
      const deltaText = fmtCreditDelta(dMedia, dSong);
      const grantNote = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
      if (dMedia < 0 || dSong < 0) {
        addNotification('deduct', email, '➖ កាត់ Credit · Credits deducted', 'Admin បានកាត់ ' + deltaText + ' ពី ' + email + (grantNote ? ' — ' + grantNote : ''));
      } else {
        addNotification('grant', email, '➕ បន្ថែម Credit · Credits granted', 'Admin បានបន្ថែម ' + deltaText + ' ឲ្យ ' + email + (grantNote ? ' — ' + grantNote : ''));
      }
      return sendJSON(res, 200, { ok: true, user: pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/admin/user?email=... — admin key required. Removes a user
  // (used to clean up a test user; the Admin app can also use it).
  if (req.method === 'DELETE' && urlPath === '/api/admin/user') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const users = loadUsers();
    if (!users[email]) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
    delete users[email];
    saveUsers(users);
    return sendJSON(res, 200, { ok: true, deleted: email });
  }
  // POST /api/admin/block-model — {model} — admin key required. Adds a
  // device model code to the blocked list; that model can no longer sync
  // (no user created/updated, no credits granted). Comparison is
  // case-insensitive; the code is stored as sent.
  if (req.method === 'POST' && urlPath === '/api/admin/block-model') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const model = typeof body && typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      if (!model) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់កូដម៉ូដែល' });
      const blocked = loadBlockedModels();
      if (!blocked.some((b) => b.toUpperCase() === model.toUpperCase())) blocked.push(model);
      saveBlockedModels(blocked);
      // Critical write: confirm the block list is on GitHub BEFORE
      // returning success, so a restart cannot lose the block.
      await ghFlushFile(BLOCKED_MODELS_FILE);
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/unblock-model — {model} — admin key required. Removes
  // a device model code from the blocked list so it can sync again.
  if (req.method === 'POST' && urlPath === '/api/admin/unblock-model') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const model = typeof body && typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      if (!model) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់កូដម៉ូដែល' });
      const blocked = loadBlockedModels().filter((b) => b.toUpperCase() !== model.toUpperCase());
      saveBlockedModels(blocked);
      await ghFlushFile(BLOCKED_MODELS_FILE);
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/blocked-models — admin key required. Lists the blocked
  // device model codes.
  if (req.method === 'GET' && urlPath === '/api/admin/blocked-models') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, blocked: loadBlockedModels() });
  }
  // GET /api/admin/settings — PUBLIC (no admin key). The MovAi website reads
  // it on load to know whether the admin turned Smooth mode Auto on.
  if (req.method === 'GET' && urlPath === '/api/admin/settings') {
    return sendJSON(res, 200, { ok: true, settings: publicSettings(loadSettings()) });
  }
  // POST /api/admin/settings — {smoothModeAuto, theme, font, glassClear,
  // glassBlur, glassShine, tshadow, txtblur, bgb, brandfx, mode, payment} — admin key
  // required. Fields sent are merged over the stored settings; missing
  // fields keep their stored value. Values are validated/clamped.
  if (req.method === 'POST' && urlPath === '/api/admin/settings') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then((body) => {
      const cur = loadSettings();
      const merged = Object.assign({}, cur, body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      const saved = saveSettings(merged, cur);
      return sendJSON(res, 200, { ok: true, settings: publicSettings(saved) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/keys — {provider, key, endpoint?} — admin key required.
  // Stores a provider API key on the server. The response NEVER contains
  // the key value. endpoint is only needed for Suno (its gateway URL).
  if (req.method === 'POST' && urlPath === '/api/admin/keys') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then((body) => {
      const provider = normProvider(body && body.provider);
      if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ API Key' });
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim().slice(0, 500) : '';
      const keys = loadAdminKeys();
      keys[provider] = { key, endpoint, updatedAt: new Date().toISOString() };
      saveAdminKeys(keys);
      return sendJSON(res, 200, { ok: true, provider, hasKey: true, hasEndpoint: !!endpoint });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/keys — admin key required. Lists ONLY which providers
  // have a key stored (and whether an endpoint is set). Key values are
  // NEVER returned.
  if (req.method === 'GET' && urlPath === '/api/admin/keys') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const keys = loadAdminKeys();
    const list = Object.keys(keys).sort().map((p) => ({ provider: p, hasKey: true, hasEndpoint: !!(keys[p].endpoint && keys[p].endpoint.trim()) }));
    return sendJSON(res, 200, { ok: true, keys: list });
  }
  // POST /api/admin/providers — {mode:'image'|'video'|'song', provider, model}
  // — admin key required. Sets the active provider/model for one mode.
  if (req.method === 'POST' && urlPath === '/api/admin/providers') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then((body) => {
      const mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
      if (!['image', 'video', 'song'].includes(mode)) return sendJSON(res, 200, { ok: false, error: 'Mode មិនត្រឹមត្រូវទេ' });
      const provider = normProvider(body && body.provider);
      if (!provider) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើស provider' });
      const model = typeof body.model === 'string' ? body.model.trim().slice(0, 100) : '';
      const cur = loadSettings();
      cur.providers[mode] = { provider, model };
      const saved = saveSettings(cur, cur);
      return sendJSON(res, 200, { ok: true, providers: saved.providers });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/providers — PUBLIC (no admin key). The MovAi website
  // reads it to know which provider/model the admin set for each mode.
  // A mode is null when the admin has not set it yet.
  if (req.method === 'GET' && urlPath === '/api/admin/providers') {
    const s = loadSettings();
    return sendJSON(res, 200, { ok: true, providers: s.providers || { image: null, video: null, song: null } });
  }
  // ---- Purchase requests (Buy → admin approval) ----
  // The MovAi website's Buy button sends ONLY {email, packageId, plan,
  // amount} — no credit amount. The server is the truth for what a package
  // grants, keyed by packageId (from the artifact's PKG_PLANS /
  // SONG_PKG_PLANS). 'song-free' never sends a request (its button is
  // Automatic/disabled) and is rejected here if it ever arrives.
  // Editable package catalog (./data/packages.json). The admin edits prices
  // from the Admin app; the website reads the live prices from
  // GET /api/public/packages. price = current sale price, originalPrice =
  // the pre-discount price — when price < originalPrice the client shows a
  // discount percent. Credits/durations NEVER change via price edits.
  // 'song-free' ($0, 24 song Cr) is NOT a purchase package — never here.
  const PACKAGE_SEED = {
    monthly: { credits: 11000, songCredits: 0, days: 30, price: 25 },
    yearly: { credits: 140000, songCredits: 0, days: 365, price: 216 },
    'song-trial': { credits: 0, songCredits: 750, days: 30, price: 5 },
    'song-popular': { credits: 0, songCredits: 1500, days: 30, price: 10 },
    'song-pro': { credits: 0, songCredits: 3750, days: 30, price: 22 },
  };
  const PACKAGE_ORDER = ['monthly', 'yearly', 'song-trial', 'song-popular', 'song-pro'];
  const PACKAGES_FILE = path.join(DATA_DIR, 'packages.json');
  function cleanPackages(j) {
    const out = {};
    for (const id of PACKAGE_ORDER) {
      const seed = PACKAGE_SEED[id];
      const v = j && typeof j === 'object' && j[id] && typeof j[id] === 'object' ? j[id] : {};
      const price = numOr(v.price, seed.price);
      const originalPrice = numOr(v.originalPrice, seed.price);
      out[id] = {
        id,
        price: Number.isFinite(price) && price >= 0 ? price : seed.price,
        originalPrice: Number.isFinite(originalPrice) && originalPrice >= 0 ? originalPrice : seed.price,
        credits: seed.credits,
        songCredits: seed.songCredits,
        days: seed.days,
      };
    }
    return out;
  }
  function loadPackages() {
    try { const j = JSON.parse(fs.readFileSync(PACKAGES_FILE, 'utf8')); return cleanPackages(j); } catch (e) {}
    return cleanPackages(null);
  }
  function savePackages(map) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    const out = cleanPackages(map);
    fs.writeFileSync(PACKAGES_FILE, JSON.stringify(out, null, 2));
    ghPersistFile(PACKAGES_FILE);
    return out;
  }
  // Public view: credits/durations exposed as mediaCredits/songCredits/durationDays.
  function pubPackages() {
    const map = loadPackages();
    return PACKAGE_ORDER.map((id) => {
      const p = map[id];
      return { id: p.id, price: p.price, originalPrice: p.originalPrice, mediaCredits: p.credits, songCredits: p.songCredits, durationDays: p.days };
    });
  }
  // GET /api/public/packages — PUBLIC. The website reads live package prices
  // from here (discount % = round((originalPrice-price)/originalPrice*100)
  // when price < originalPrice, computed by the client).
  if (req.method === 'GET' && urlPath === '/api/public/packages') {
    return sendJSON(res, 200, { ok: true, packages: pubPackages() });
  }
  // POST /api/admin/packages — {packages:[{id, price, originalPrice?}]}
  // — admin key required. Edits price and/or originalPrice per package id.
  // Unknown ids are rejected; price/originalPrice must be >= 0. Returns the
  // full updated list.
  if (req.method === 'POST' && urlPath === '/api/admin/packages') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then((body) => {
      const list = body && Array.isArray(body.packages) ? body.packages : null;
      if (!list || !list.length) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់កញ្ចប់ដែលចង់កែ' });
      const map = loadPackages();
      for (const item of list) {
        const id = item && typeof item.id === 'string' ? item.id.trim() : '';
        if (!PACKAGE_ORDER.includes(id)) return sendJSON(res, 200, { ok: false, error: 'កញ្ចប់នេះមិនស្គាល់ទេ: ' + (id || '?') });
        if (item.price !== undefined) {
          const p = Number(item.price);
          if (!Number.isFinite(p) || p < 0) return sendJSON(res, 200, { ok: false, error: 'តម្លៃមិនត្រឹមត្រូវទេ: ' + id });
          map[id].price = p;
        }
        if (item.originalPrice !== undefined) {
          const op = Number(item.originalPrice);
          if (!Number.isFinite(op) || op < 0) return sendJSON(res, 200, { ok: false, error: 'តម្លៃដើមមិនត្រឹមត្រូវទេ: ' + id });
          map[id].originalPrice = op;
        }
      }
      savePackages(map);
      return sendJSON(res, 200, { ok: true, packages: pubPackages() });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  const PURCHASE_REQUESTS_FILE = path.join(DATA_DIR, 'purchase-requests.json');
  function loadPurchaseRequests() {
    try { const j = JSON.parse(fs.readFileSync(PURCHASE_REQUESTS_FILE, 'utf8')); if (Array.isArray(j)) return j; } catch (e) {}
    return [];
  }
  function savePurchaseRequests(arr) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    fs.writeFileSync(PURCHASE_REQUESTS_FILE, JSON.stringify(arr, null, 2));
    ghPersistFile(PURCHASE_REQUESTS_FILE);
  }
  function newPurchaseId() {
    return 'pr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  // POST /api/admin/purchase-request — PUBLIC (no admin key). The website
  // sends a buy request; credits are granted ONLY after the admin approves.
  if (req.method === 'POST' && urlPath === '/api/admin/purchase-request') {
    readJSONBody(req, 64 * 1024).then((body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const packageId = typeof body.packageId === 'string' ? body.packageId.trim() : '';
      const pkg = loadPackages()[packageId];
      if (!pkg) return sendJSON(res, 200, { ok: false, error: 'កញ្ចប់នេះមិនស្គាល់ទេ' });
      const now = new Date().toISOString();
      const reqs = loadPurchaseRequests();
      const r = {
        id: newPurchaseId(), email, packageId,
        plan: typeof body.plan === 'string' ? body.plan.slice(0, 50) : packageId,
        amount: pkg.price,
        credits: pkg.credits, songCredits: pkg.songCredits, days: pkg.days,
        status: 'pending', createdAt: now, updatedAt: now,
      };
      reqs.push(r);
      savePurchaseRequests(reqs);
      addNotification('purchase-request', email, '🛒 សំណើទិញកញ្ចប់ · Purchase request', email + ' បានស្នើទិញកញ្ចប់ ' + packageId + ' ($' + pkg.price + ')');
      return sendJSON(res, 200, { ok: true, request: r });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/purchase-requests?status=pending|approved|rejected|all
  // — admin key required. Pending first, then newest first.
  if (req.method === 'GET' && urlPath === '/api/admin/purchase-requests') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const status = (new URL(req.url, 'http://localhost').searchParams.get('status') || 'all').trim().toLowerCase();
    const reqs = loadPurchaseRequests();
    const order = { pending: 0, approved: 1, rejected: 2 };
    const list = reqs
      .filter((r) => status === 'all' || r.status === status)
      .sort((x, y) => ((order[x.status] ?? 3) - (order[y.status] ?? 3)) || String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
    return sendJSON(res, 200, { ok: true, requests: list });
  }
  // POST /api/admin/purchase-request/approve — {id} — admin key required.
  // Grants the package credits to the user and marks the request approved.
  if (req.method === 'POST' && urlPath === '/api/admin/purchase-request/approve') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const reqs = loadPurchaseRequests();
      const r = reqs.find((x) => x.id === id);
      if (!r) return sendJSON(res, 200, { ok: false, error: 'រកសំណើនេះមិនឃើញទេ' });
      if (r.status !== 'pending') return sendJSON(res, 200, { ok: false, error: 'សំណើនេះបានសម្រេចរួចហើយ' });
      const pkg = loadPackages()[r.packageId];
      if (!pkg) return sendJSON(res, 200, { ok: false, error: 'កញ្ចប់នេះមិនស្គាល់ទេ' });
      const users = loadUsers();
      const u = users[r.email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
      const now = new Date().toISOString();
      u.credits = Math.max(0, Math.floor(numOr(u.credits, 0)) + pkg.credits);
      u.songCredits = Math.max(0, Math.floor(numOr(u.songCredits, 0)) + pkg.songCredits);
      if (pkg.credits) u.plan = r.packageId;
      if (pkg.songCredits) u.songPlan = r.packageId;
      u.updatedAt = now;
      saveUsers(users);
      logGrant({ email: r.email, credits: pkg.credits, songCredits: pkg.songCredits, note: 'purchase:' + r.packageId, at: now });
      r.status = 'approved';
      r.decidedAt = now;
      r.updatedAt = now;
      savePurchaseRequests(reqs);
      // Critical writes: confirm BOTH the granted credits and the
      // approved request are on GitHub BEFORE returning success, so a
      // restart cannot lose a purchase the Admin app already approved.
      await ghFlushFile(USERS_FILE);
      await ghFlushFile(PURCHASE_REQUESTS_FILE);
      addNotification('purchase-approved', r.email, '✅ បានអនុម័ត · Purchase approved', 'កញ្ចប់ ' + r.packageId + ' របស់ ' + r.email + ' បានអនុម័ត — +' + pkg.credits + ' Image.Video / +' + pkg.songCredits + ' Song Credit');
      return sendJSON(res, 200, { ok: true, request: r, user: pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/purchase-request/reject — {id} — admin key required.
  // Marks the request rejected; no credits are granted.
  if (req.method === 'POST' && urlPath === '/api/admin/purchase-request/reject') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then((body) => {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const reqs = loadPurchaseRequests();
      const r = reqs.find((x) => x.id === id);
      if (!r) return sendJSON(res, 200, { ok: false, error: 'រកសំណើនេះមិនឃើញទេ' });
      if (r.status !== 'pending') return sendJSON(res, 200, { ok: false, error: 'សំណើនេះបានសម្រេចរួចហើយ' });
      const now = new Date().toISOString();
      r.status = 'rejected';
      r.decidedAt = now;
      r.updatedAt = now;
      savePurchaseRequests(reqs);
      addNotification('purchase-rejected', r.email, '❌ បដិសេធ · Purchase rejected', 'សំណើទិញកញ្ចប់ ' + r.packageId + ' របស់ ' + r.email + ' ត្រូវបានបដិសេធ');
      return sendJSON(res, 200, { ok: true, request: r });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/stats — admin key required. Usage analytics for the
  // Admin app: distinct users (by sync) in the last 1/7/30 days, today's
  // successful generations by mode, today's failures, and recent errors.
  // Never throws on empty data.
  if (req.method === 'GET' && urlPath === '/api/admin/stats') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    try {
      const nowMs = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const act = loadActivity();
      const users = loadUsers();
      function distinctSyncUsers(days) {
        const since = nowMs - days * DAY;
        const set = new Set();
        for (const r of act) {
          if (r && r.mode === 'sync' && r.email && r.at) {
            const t = Date.parse(r.at);
            if (Number.isFinite(t) && t >= since) set.add(r.email);
          }
        }
        if (set.size) return set.size;
        // Fallback: no sync records yet — count users created in the window.
        let n = 0;
        for (const u of Object.values(users)) {
          const t = Date.parse(u.createdAt || '');
          if (Number.isFinite(t) && t >= since) n++;
        }
        return n;
      }
      const todayStart = nowMs - DAY;
      let songsToday = 0, videosToday = 0, imagesToday = 0, failuresToday = 0;
      const failures = [];
      for (const r of act) {
        if (!r || !r.at) continue;
        const t = Date.parse(r.at);
        if (!Number.isFinite(t) || t < todayStart) continue;
        if (r.mode === 'song' && r.ok) songsToday++;
        else if (r.mode === 'video' && r.ok) videosToday++;
        else if (r.mode === 'image' && r.ok) imagesToday++;
        if ((r.mode === 'image' || r.mode === 'video' || r.mode === 'song') && r.ok === false) {
          failuresToday++;
          failures.push({ at: r.at, mode: r.mode, provider: r.provider || '', error: r.error || '' });
        }
      }
      return sendJSON(res, 200, { ok: true, stats: {
        usersToday: distinctSyncUsers(1),
        usersWeek: distinctSyncUsers(7),
        usersMonth: distinctSyncUsers(30),
        songsToday, videosToday, imagesToday,
        failuresToday,
        recentErrors: failures.slice(-20).reverse(),
      }});
    } catch (e) {
      return sendJSON(res, 200, { ok: true, stats: { usersToday: 0, usersWeek: 0, usersMonth: 0, songsToday: 0, videosToday: 0, imagesToday: 0, failuresToday: 0, recentErrors: [] } });
    }
  }
  // ---- Notifications ----
  // GET /api/admin/notifications — admin key required. All notifications,
  // newest first, limit 100. The Admin app polls this for its bell/feed.
  if (req.method === 'GET' && urlPath === '/api/admin/notifications') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const list = loadNotifications().slice(0, 100);
    return sendJSON(res, 200, { ok: true, notifications: list });
  }
  // POST /api/admin/notifications/read — {id} or {all:true} — admin key
  // required. Marks one notification (or all) as read.
  if (req.method === 'POST' && urlPath === '/api/admin/notifications/read') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then((body) => {
      const arr = loadNotifications();
      let marked = 0;
      if (body && body.all === true) {
        for (const n of arr) { if (n && !n.read) { n.read = true; marked++; } }
      } else {
        const id = body && typeof body.id === 'string' ? body.id.trim() : '';
        const n = arr.find((x) => x && x.id === id);
        if (n && !n.read) { n.read = true; marked = 1; }
      }
      if (marked) saveNotifications(arr);
      return sendJSON(res, 200, { ok: true, marked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/public/notifications?email= — PUBLIC. Only that user's own
  // notifications (purchase-approved/rejected, grant, deduct, ...), newest
  // first, limit 50. email is required; 'guest' returns an empty list.
  if (req.method === 'GET' && urlPath === '/api/public/notifications') {
    const rawEmail = (new URL(req.url, 'http://localhost').searchParams.get('email') || '').trim().toLowerCase();
    if (!rawEmail) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    if (rawEmail === 'guest') return sendJSON(res, 200, { ok: true, notifications: [] });
    const email = normEmail(rawEmail);
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const list = loadNotifications().filter((n) => n && (n.email === email || n.email === '*')).slice(0, 50);
    return sendJSON(res, 200, { ok: true, notifications: list });
  }
  // ---- Follow the Public page ----
  // POST /api/public/follow — PUBLIC. {email, follow: true|false}.
  // follow=true adds the email to the followers list; false removes it.
  // Returns {ok, following, followers}.
  if (req.method === 'POST' && urlPath === '/api/public/follow') {
    readJSONBody(req, 64 * 1024).then((body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const want = !!(body && body.follow);
      let arr = loadFollowers();
      if (want) {
        if (!arr.includes(email)) arr.push(email);
      } else {
        arr = arr.filter((e) => e !== email);
      }
      if (arr.length > FOLLOWERS_MAX) arr = arr.slice(-FOLLOWERS_MAX);
      saveFollowers(arr);
      return sendJSON(res, 200, { ok: true, following: want, followers: arr.length });
    }).catch((e) => sendJSON(res, 200, { ok: false, error: String(e && e.message ? e.message : e) }));
    return;
  }
  // GET /api/public/follow?email= — PUBLIC. Returns {ok, following, followers}.
  if (req.method === 'GET' && urlPath === '/api/public/follow') {
    const rawEmail = (new URL(req.url, 'http://localhost').searchParams.get('email') || '').trim().toLowerCase();
    const email = normEmail(rawEmail);
    const arr = loadFollowers();
    return sendJSON(res, 200, { ok: true, following: !!(email && arr.includes(email)), followers: arr.length });
  }
  // ---- Web Push (phone-native push, from the phone itself) ----
  // GET /api/public/vapid-key — PUBLIC. Returns the public VAPID key the
  // website/Admin app needs to subscribe for Web Push. The private key is
  // never exposed. The key pair is created on first use (./data/vapid.json).
  if (req.method === 'GET' && urlPath === '/api/public/vapid-key') {
    const pub = getVapidPublicKey();
    if (!pub) return sendJSON(res, 200, { ok: false, error: 'Web Push មិនទាន់បើកទេ' });
    return sendJSON(res, 200, { ok: true, publicKey: pub });
  }
  // POST /api/public/push-subscribe — PUBLIC. {email, subscription, role?}
  // subscription = browser PushSubscription JSON {endpoint, keys:{p256dh,
  // auth}}. Stored/overwritten by endpoint+email. role 'admin' marks an
  // admin device (the Admin app subscribes with its admin Gmail + role).
  if (req.method === 'POST' && urlPath === '/api/public/push-subscribe') {
    readJSONBody(req, 64 * 1024).then((body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const sub = cleanPushSub(body && body.subscription);
      if (!sub) return sendJSON(res, 200, { ok: false, error: 'subscription មិនត្រឹមត្រូវទេ' });
      const role = body && body.role === 'admin' ? 'admin' : '';
      const arr = loadPushSubs();
      const now = new Date().toISOString();
      const idx = arr.findIndex((s) => s && s.endpoint === sub.endpoint && String(s.email || '').toLowerCase() === email);
      const rec = { email, endpoint: sub.endpoint, keys: sub.keys, role, createdAt: idx >= 0 && arr[idx].createdAt ? arr[idx].createdAt : now, updatedAt: now };
      if (idx >= 0) arr[idx] = rec; else arr.push(rec);
      if (arr.length > PUSH_SUBS_MAX) arr.splice(0, arr.length - PUSH_SUBS_MAX);
      savePushSubs(arr);
      return sendJSON(res, 200, { ok: true, subscribed: true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/push-unsubscribe — PUBLIC. {email, endpoint} — removes
  // the matching subscription(s). email is optional (endpoint alone matches).
  if (req.method === 'POST' && urlPath === '/api/public/push-unsubscribe') {
    readJSONBody(req, 64 * 1024).then((body) => {
      const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
      if (!endpoint) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ endpoint' });
      const email = normEmail(body && body.email);
      const arr = loadPushSubs();
      const kept = arr.filter((s) => !(s && s.endpoint === endpoint && (!email || String(s.email || '').toLowerCase() === email)));
      const removed = arr.length - kept.length;
      if (removed) savePushSubs(kept);
      return sendJSON(res, 200, { ok: true, removed });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Public feed (Public tab) ----
  // Anyone can post their creations as public (visible to everyone, ranked
  // by likes + views) or private (the feed never lists private posts). No
  // admin key, no passwords, no API keys stored.
  // Storage: ./data/public.json, capped at 5000 posts (oldest dropped).
  const PUBLIC_FILE = path.join(DATA_DIR, 'public.json');
  const PUBLIC_MAX = 5000;
  const PUBLIC_MODES = ['song', 'image', 'video', '3d'];
  function loadPublicPosts() {
    try { const j = JSON.parse(fs.readFileSync(PUBLIC_FILE, 'utf8')); if (Array.isArray(j)) return j; } catch (e) {}
    return [];
  }
  function savePublicPosts(arr) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    fs.writeFileSync(PUBLIC_FILE, JSON.stringify(arr, null, 2));
    ghPersistFile(PUBLIC_FILE);
  }
  function newPublicId() {
    return 'pub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  // Public view of a post. likedBy (liker emails) is never exposed.
  function pubPost(p) {
    return { id: p.id, email: p.email, name: p.name || '', userId: p.userId || '', mode: p.mode, title: p.title, url: p.url, cover: p.cover || '', aspect: p.aspect || '', youtube: p.youtube || '', youtubeChannel: p.youtubeChannel || '', visibility: p.visibility, likes: p.likes || 0, views: p.views || 0, createdAt: p.createdAt };
  }
  // ---- File uploads for the Admin app Post form (MP3 + cover image) ----
  // POST /api/public/upload — ADMIN KEY required. JSON {kind: 'audio'|'image',
  // filename, data: base64}. Saves under ./data/uploads/ and returns the
  // public URL. Audio max 15 MB, image max 5 MB. The Admin app reads the
  // chosen file as base64 and POSTs it here, then fills the Post Link/Cover
  // field with the returned URL. Render free disk is ephemeral (same as
  // ./data/*.json) — uploaded files can be lost on restart/redeploy.
  const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
  const UPLOAD_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  function uploadSafeExt(kind, filename) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    const dot = '.' + (ext || '');
    if (kind === 'audio') return ['.mp3', '.wav', '.ogg', '.m4a'].includes(dot) ? dot : '';
    if (kind === 'image') return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(dot) ? dot : '';
    return '';
  }
  if (req.method === 'POST' && urlPath === '/api/public/upload') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 20 * 1024 * 1024).then((body) => {
      const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
      if (kind !== 'audio' && kind !== 'image') return sendJSON(res, 200, { ok: false, error: 'kind ត្រូវជា audio ឬ image' });
      const ext = uploadSafeExt(kind, body.filename);
      if (!ext) return sendJSON(res, 200, { ok: false, error: 'ប្រភេទឯកសារមិនត្រឹមត្រូវទេ' });
      const b64 = typeof body.data === 'string' ? body.data.replace(/\s/g, '') : '';
      if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return sendJSON(res, 200, { ok: false, error: 'ទិន្នន័យឯកសារមិនត្រឹមត្រូវទេ' });
      const buf = Buffer.from(b64, 'base64');
      const maxBytes = kind === 'audio' ? 15 * 1024 * 1024 : 5 * 1024 * 1024;
      if (!buf.length || buf.length > maxBytes) return sendJSON(res, 200, { ok: false, error: kind === 'audio' ? 'MP3 ធំពេក (អតិបរមា 15 MB)' : 'រូបភាពធំពេក (អតិបរមា 5 MB)' });
      try {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        const name = Date.now().toString(36) + '-' + crypto.randomInt(100000, 999999) + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
        const proto = req.headers && req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const host = (req.headers && req.headers.host) || 'movai-proxy.onrender.com';
        return sendJSON(res, 200, { ok: true, url: proto + '://' + host + '/uploads/' + name, name, kind, size: buf.length });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: 'រក្សាទុកឯកសារបរាជ័យ' });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /uploads/<name> — serve an uploaded MP3/cover. Name is basename-only
  // (no path traversal); unknown extension or missing file -> 404.
  if (req.method === 'GET' && urlPath.startsWith('/uploads/')) {
    const name = path.basename(urlPath.slice('/uploads/'.length)).split('?')[0];
    const ext = '.' + String(name).toLowerCase().split('.').pop();
    const mime = UPLOAD_MIME[ext];
    if (!mime || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const buf = fs.readFileSync(path.join(UPLOADS_DIR, name));
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch (e) { res.writeHead(404); res.end('Not found'); }
    return;
  }
  // POST /api/public/post — PUBLIC. {email, name, userId?, mode, title, url, cover?, visibility?}
  if (req.method === 'POST' && urlPath === '/api/public/post') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
      if (!PUBLIC_MODES.includes(mode)) return sendJSON(res, 200, { ok: false, error: 'Mode មិនត្រឹមត្រូវទេ' });
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
      if (!title) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ចំណងជើង' });
      const url = typeof body.url === 'string' ? body.url.trim().slice(0, 2000) : '';
      if (!url) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ link' });
      const visibility = body.visibility === 'private' ? 'private' : 'public';
      const aspectRaw = typeof body.aspect === 'string' ? body.aspect.trim() : '';
      const aspect = (aspectRaw === '1x1' || aspectRaw === '4x6') ? aspectRaw : '';
      const youtube = typeof body.youtube === 'string' ? body.youtube.trim().slice(0, 2000) : '';
      const youtubeChannel = typeof body.youtubeChannel === 'string' ? body.youtubeChannel.trim().slice(0, 2000) : '';
      const now = new Date().toISOString();
      const posts = loadPublicPosts();
      const p = {
        id: newPublicId(), email,
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '',
        userId: typeof body.userId === 'string' ? body.userId.trim().slice(0, 50) : '',
        mode, title, url,
        cover: typeof body.cover === 'string' ? body.cover.trim().slice(0, 2000) : '',
        aspect, youtube, youtubeChannel, visibility, likes: 0, views: 0, likedBy: [], createdAt: now,
      };
      posts.push(p);
      if (posts.length > PUBLIC_MAX) posts.splice(0, posts.length - PUBLIC_MAX);
      savePublicPosts(posts);
      // Critical write: confirm public.json is on GitHub BEFORE returning
      // success, so a restart in the next second cannot lose a post that
      // the Admin app already reported as posted.
      await ghFlushFile(PUBLIC_FILE);
      // New public post -> notify FOLLOWERS only (one 'post' notification
      // per follower, in-app + Web Push to their phones immediately).
      // Private posts never notify anyone.
      if (visibility === 'public') {
        for (const f of loadFollowers()) {
          addNotification('post', f, '📢 បានផុសថ្មី · New post', p.title + ' (' + mode + ') — ' + (p.name || email));
        }
      }
      return sendJSON(res, 200, { ok: true, post: pubPost(p) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/public/post — ADMIN KEY required. {id}. Removes the post
  // record from public.json (an uploaded file in ./data/uploads/ is left
  // alone — only the post record is deleted). The GitHub flush is awaited
  // before success is returned, so the deletion survives a restart
  // (same pattern as POST /api/public/post).
  if (req.method === 'DELETE' && urlPath === '/api/public/post') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ post id' });
      const posts = loadPublicPosts();
      const idx = posts.findIndex((x) => x && x.id === id);
      if (idx < 0) return sendJSON(res, 200, { ok: false, error: 'រកមិនឃើញ post នេះទេ' });
      posts.splice(idx, 1);
      savePublicPosts(posts);
      // Critical write: confirm public.json is on GitHub BEFORE returning
      // success, so a restart in the next second cannot resurrect a post
      // the Admin app already reported as deleted.
      await ghFlushFile(PUBLIC_FILE);
      return sendJSON(res, 200, { ok: true, deletedId: id });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/public/feed — PUBLIC. Only public posts, ranked by
  // views (highest first); ties broken by more likes, then earlier
  // createdAt. rank is 1-based; tier 1 = rank 1–50, tier 2 = 51–200,
  // tier 3 = the rest.
  if (req.method === 'GET' && urlPath === '/api/public/feed') {
    const posts = loadPublicPosts().filter((p) => p && p.visibility === 'public');
    posts.sort((a, b) => ((b.views || 0) - (a.views || 0)) || ((b.likes || 0) - (a.likes || 0)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const out = posts.map((p, i) => {
      const rank = i + 1;
      const d = pubPost(p);
      d.rank = rank;
      d.tier = rank <= 50 ? 1 : rank <= 200 ? 2 : 3;
      return d;
    });
    return sendJSON(res, 200, { ok: true, posts: out });
  }
  // POST /api/public/like — PUBLIC. {postId, email}. One like per email;
  // a repeat like from the same email returns the current count unchanged.
  if (req.method === 'POST' && urlPath === '/api/public/like') {
    readJSONBody(req, 64 * 1024).then((body) => {
      const postId = typeof body.postId === 'string' ? body.postId.trim() : '';
      const email = normEmail(body && body.email) || (typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : '');
      if (!postId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId' });
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const posts = loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      if (!Array.isArray(p.likedBy)) p.likedBy = [];
      if (!p.likedBy.includes(email)) {
        p.likedBy.push(email);
        p.likes = p.likedBy.length;
        savePublicPosts(posts);
      }
      return sendJSON(res, 200, { ok: true, likes: p.likes || 0 });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/view — PUBLIC. {postId}. Counts one view.
  if (req.method === 'POST' && urlPath === '/api/public/view') {
    readJSONBody(req, 64 * 1024).then((body) => {
      const postId = typeof body.postId === 'string' ? body.postId.trim() : '';
      if (!postId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId' });
      const posts = loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      p.views = (p.views || 0) + 1;
      savePublicPosts(posts);
      return sendJSON(res, 200, { ok: true, views: p.views });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Package-interaction events (Packages tab tracking) ----
  // The MovAi website logs every package interaction so the admin can
  // tell real buyers apart from people who only looked and cancelled:
  // 'view' = opened the Packages panel / looked at a package,
  // 'buy' = tapped Buy on a package, 'cancel' = closed/cancelled the
  // buy flow, 'request' = sent the purchase request to the admin.
  // Storage: ./data/package-events.json, capped at 5000 events (oldest
  // dropped). No passwords, no API keys, no amounts stored — only who
  // did what to which package, and when.
  const PKG_EVENTS_FILE = path.join(DATA_DIR, 'package-events.json');
  const PKG_EVENTS_MAX = 5000;
  const PKG_EVENT_ACTIONS = ['view', 'buy', 'cancel', 'request'];
  function loadPkgEvents() {
    try { const j = JSON.parse(fs.readFileSync(PKG_EVENTS_FILE, 'utf8')); if (Array.isArray(j)) return j; } catch (e) {}
    return [];
  }
  function savePkgEvents(arr) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    fs.writeFileSync(PKG_EVENTS_FILE, JSON.stringify(arr, null, 2));
    ghPersistFile(PKG_EVENTS_FILE);
  }
  // POST /api/public/package-event — PUBLIC. {email, packageId, action}
  // email may be 'guest' for visitors who are not signed in.
  if (req.method === 'POST' && urlPath === '/api/public/package-event') {
    readJSONBody(req, 64 * 1024).then((body) => {
      const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const email = rawEmail === 'guest' ? 'guest' : normEmail(rawEmail);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const packageId = typeof body.packageId === 'string' ? body.packageId.trim().slice(0, 100) : '';
      if (!packageId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ packageId' });
      const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';
      if (!PKG_EVENT_ACTIONS.includes(action)) return sendJSON(res, 200, { ok: false, error: 'action មិនត្រឹមត្រូវទេ' });
      const events = loadPkgEvents();
      events.push({ at: new Date().toISOString(), email, packageId, action });
      if (events.length > PKG_EVENTS_MAX) events.splice(0, events.length - PKG_EVENTS_MAX);
      savePkgEvents(events);
      return sendJSON(res, 200, { ok: true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/package-events?email=&packageId=&action= — admin key
  // required. Newest first, limit 500.
  if (req.method === 'GET' && urlPath === '/api/admin/package-events') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const q = new URL(req.url, 'http://localhost').searchParams;
    const fEmail = (q.get('email') || '').trim().toLowerCase();
    const fPkg = (q.get('packageId') || '').trim();
    const fAction = (q.get('action') || '').trim().toLowerCase();
    const list = loadPkgEvents()
      .filter((e) => e && (!fEmail || e.email === fEmail) && (!fPkg || e.packageId === fPkg) && (!fAction || e.action === fAction))
      .sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')))
      .slice(0, 500);
    return sendJSON(res, 200, { ok: true, events: list });
  }
  return sendJSON(res, 404, errBody('not_found', 'រកមិនឃើញទេ', 'Not found'));
}

/* ------------------------------- static files ------------------------------ */
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  // CORS preflight for /api/* (the website and Admin app are other origins;
  // the Admin app also sends an Authorization header, which always preflights).
  if (req.method === 'OPTIONS' && urlPath.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  if (urlPath.startsWith('/api/') || urlPath.startsWith('/uploads/')) return apiRoute(req, res, urlPath);
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
  // Restore persistent data from GitHub first (no-op without a token),
  // so the server starts with the true data, then listen.
  ghRestoreAll().catch(() => {}).finally(() => {
    server.listen(PORT, () => console.log('MovAi Gen live on port ' + PORT));
  });
}
module.exports = { server };
