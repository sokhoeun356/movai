// MovAi — បង្កើតរូបភាព & វីដេអូ (standalone image & video generation site)
// Serves index.html and proxies the free image/video APIs so the browser
// never hits CORS problems. The server NEVER stores API keys — keys arrive
// with each request only, from the visitor's own browser (localStorage).
// Run:  node server.js        (PORT env var, default 3000)
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let WebSocketLib = null;
try { WebSocketLib = require('ws'); } catch (e) { WebSocketLib = null; }
let NodemailerLib = null;
try { NodemailerLib = require('nodemailer'); } catch (e) { NodemailerLib = null; }

/* ------- server stability (Hercules plan Step 7, 2026-11-17) --------------
   Render Free (512 MB) restarts the whole service when the process dies,
   so a single uncaught error can take the site down. These handlers make
   failures VISIBLE in the logs instead of silent, and let Render restart
   cleanly. Neither handler may throw itself (all logging is try/catch). */
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason && reason.stack ? String(reason.stack) : String(reason);
    console.error('[unhandledRejection]', msg.slice(0, 500));
  } catch (e) { try { console.error('[unhandledRejection] (log failed)'); } catch (e2) {} }
  // Do NOT exit: an unhandled rejection is not necessarily fatal — the
  // request that caused it already failed, and the process can keep
  // serving. Exiting on every rejected promise would restart the
  // service far more often than needed.
});
process.on('uncaughtException', (err) => {
  try {
    const msg = err && err.stack ? String(err.stack) : String(err);
    console.error('[uncaughtException]', msg.slice(0, 500));
  } catch (e) { try { console.error('[uncaughtException] (log failed)'); } catch (e2) {} }
  // An uncaught exception means the process is in an UNKNOWN state
  // (some invariant may be broken). Continuing could corrupt data or
  // serve wrong results, so exit and let Render restart the service
  // cleanly from a known-good state.
  process.exit(1);
});

/* Memory logging for heavy jobs (Hercules plan Step 7, 2026-11-17):
   one concise line per heavy-job start/end so Render logs show whether
   a job (MP3 convert / song store) is what ate the 512 MB. RSS = whole
   process, heapUsed = JS heap. Never logs a full URL (truncated by
   the caller). */
function memLog(tag) {
  try {
    const m = process.memoryUsage();
    console.log('[mem] ' + tag + ' rss=' + (m.rss / 1048576).toFixed(1) + 'MB heapUsed=' + (m.heapUsed / 1048576).toFixed(1) + 'MB');
  } catch (e) {}
}

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
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const FREE_MEDIA_CREDITS = 250;
const FREE_SONG_CREDITS = 24;

/* ---------------- GitHub-backed persistent storage ----------------- */
// Render free disk is ephemeral — ./data/*.json is wiped on restart, so
// posts, credits and users vanish. When MOVAI_GITHUB_TOKEN is set, the 21
// JSON data files are ALSO stored in a private GitHub repo (branch main,
// repo root, same filenames). On startup the server pulls each file from
// GitHub into the local ./data/ cache (overwriting local); on every local
// write it ALSO pushes to GitHub. Most files are fire-and-forget (never
// blocks a response, failures only logged); the CRITICAL writes (public
// post, grant, purchase approve, user sync) AWAIT the GitHub PUT via
// ghFlushFile before returning success, so a restart cannot lose a write
// already reported as ok. When the token is unset, behaviour is EXACTLY
// as before (local ./data/*.json only).
// Uploads (./data/uploads/) are binary. They are ALSO backed up to
// GitHub (movai-data repo, uploads/) on every upload and restored on
// startup (ghPutUpload / ghRestoreUploads) — a proxy restart/redeploy
// can no longer wipe a song MP3 or cover. (2026-11-16: uploads were
// wiped on EVERY restart — the recurring song-breaker.)
// The token is NEVER hardcoded and NEVER logged — only process.env.
const GH_REPO = process.env.MOVAI_DATA_REPO || 'sokhoeun356/movai-data';
const GH_TOKEN = process.env.MOVAI_GITHUB_TOKEN || '';
const GH_DATA_FILES = [
  'users.json', 'grants.json', 'settings.json', 'admin-keys.json',
  'activity.json', 'followers.json', 'notifications.json', 'vapid.json',
  'push-subs.json', 'packages.json', 'purchase-requests.json',
  'public.json', 'package-events.json', 'blocked-models.json',
  'model-logins.json', 'blocked-ips.json', 'blocked-emails.json',
  'updates.json', 'admin-lockouts.json', 'history.json', 'mp3cache.json',
  'cloudinary-accounts.json', 'cloudinary-rotation.json', 'admin-key.json',
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
  await ghRestoreUploads(); // uploaded MP3/cover files (GitHub-backed)
}

// Graduated admin-key lockout (owner order 2026-11-16, corrected) —
// wrong Admin key attempts escalate per IP in LEVELS, stored in
// ./data/admin-lockouts.json (GitHub-backed, survives restarts):
// L1: 4 wrong tries → 5 min block, L2: 3 tries → 20 min,
// L3: 2 tries → 1 hour, L4+: 1 try → 12 hours. Each level allows
// FEWER tries but blocks LONGER. The block auto-expires; a correct key
// always wins (the key IS the admin identity) and clears all strikes,
// so the real admin can never lock themselves out. Attempts made WHILE
// blocked do not count tries or extend the block. Manual blocks in
// blocked-ips.json stay permanent and are checked separately.
const ADMIN_LOCKOUTS_FILE = path.join(DATA_DIR, 'admin-lockouts.json');
const LOCKOUT_LEVELS = [
  { tries: 4, mins: 5 },
  { tries: 3, mins: 20 },
  { tries: 2, mins: 60 },
  { tries: 1, mins: 720 },
];
function lockoutLevelCfg(level) {
  return LOCKOUT_LEVELS[Math.min(Math.max(level, 1) - 1, LOCKOUT_LEVELS.length - 1)];
}
function loadAdminLockouts() {
  try { const j = JSON.parse(fs.readFileSync(ADMIN_LOCKOUTS_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch (e) {}
  return {};
}
function saveAdminLockouts(obj) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(ADMIN_LOCKOUTS_FILE, JSON.stringify(obj, null, 2));
  ghPersistFile(ADMIN_LOCKOUTS_FILE);
}
function adminLockoutRemainingMs(ip) {
  try {
    if (!ip) return 0;
    const rec = loadAdminLockouts()[ip];
    if (!rec || !rec.blockedUntil) return 0;
    return Math.max(0, rec.blockedUntil - Date.now());
  } catch (e) { return 0; }
}
function lockoutTextKm(ms) {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return mins + ' នាទី';
  const h = Math.floor(mins / 60), r = mins % 60;
  return h + ' ម៉ោង' + (r ? ' ' + r + ' នាទី' : '');
}
function lockoutTextEn(ms) {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return mins + (mins === 1 ? ' minute' : ' minutes');
  const h = Math.floor(mins / 60), r = mins % 60;
  return h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + (r === 1 ? ' minute' : ' minutes') : '');
}
function clearAdminLockout(ip) {
  try {
    if (!ip) return;
    const all = loadAdminLockouts();
    if (all[ip]) { delete all[ip]; saveAdminLockouts(all); ghFlushFile(ADMIN_LOCKOUTS_FILE).catch(() => {}); }
  } catch (e) {}
}
function recordFailedAdminAttempt(req, ip) {
  try {
    if (!ip) return 0;
    const now = Date.now();
    const all = loadAdminLockouts();
    let rec = all[ip];
    if (!rec || typeof rec !== 'object') rec = { level: 1, tries: 0, blockedUntil: 0, model: '' };
    // Already inside a lockout: do not extend it, do not count tries.
    if (rec.blockedUntil && rec.blockedUntil > now) return 0;
    const level = Math.min(Math.max(rec.level || 1, 1), LOCKOUT_LEVELS.length);
    const cfg = lockoutLevelCfg(level);
    rec.tries = (rec.tries || 0) + 1;
    rec.level = level;
    const model = modelFromUA(req.headers && req.headers['user-agent']);
    if (model) rec.model = model;
    if (rec.tries >= cfg.tries) {
      // Level reached: block for this level's duration, advance a level.
      rec.blockedUntil = now + cfg.mins * 60 * 1000;
      rec.tries = 0;
      rec.level = Math.min(level + 1, LOCKOUT_LEVELS.length);
      rec.updatedAt = new Date().toISOString();
      all[ip] = rec;
      saveAdminLockouts(all);
      ghFlushFile(ADMIN_LOCKOUTS_FILE).catch(() => {});
      addNotification('security', '', '🚫 វាយប្រហារ · Auto-blocked attack', 'IP ' + ip + (rec.model ? ' (' + rec.model + ')' : '') + ' ព្យាយាមចូល Admin ដោយ key ខុស (កម្រិតទី ' + level + ') — ត្រូវបានប្លុក ' + cfg.mins + ' នាទី');
      return cfg.mins;
    }
    rec.updatedAt = new Date().toISOString();
    all[ip] = rec;
    saveAdminLockouts(all);
    ghFlushFile(ADMIN_LOCKOUTS_FILE).catch(() => {});
    return 0;
  } catch (e) { return 0; }
}
// ---- File-backed Admin Key (owner order 2026-11-17) ----
// The Admin Key lives in ./data/admin-key.json (GitHub-backed, survives
// restarts) so the admin can reveal / reset it after a Google sign-in.
// The env MOVAI_ADMIN_KEY stays as an emergency fallback and as the
// seed: when the file has no key yet, the env value is copied into it
// (the value is never logged).
const ADMIN_KEY_FILE = path.join(DATA_DIR, 'admin-key.json');
function loadAdminKeyFile() {
  try { const j = JSON.parse(fs.readFileSync(ADMIN_KEY_FILE, 'utf8')); if (j && typeof j.key === 'string' && j.key) return j.key; } catch (e) {}
  return '';
}
function saveAdminKeyFile(key) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(ADMIN_KEY_FILE, JSON.stringify({ key, updatedAt: new Date().toISOString() }, null, 2));
  ghPersistFile(ADMIN_KEY_FILE);
}
function currentAdminKey() {
  let k = loadAdminKeyFile();
  if (!k) {
    const env = process.env.MOVAI_ADMIN_KEY || '';
    if (env) { k = env; try { saveAdminKeyFile(env); } catch (e) {} }
  }
  return k;
}
function adminKeyOk(req) {
  const k = currentAdminKey();
  if (!k) return { ok: false, error: 'Admin key not configured on server' };
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (m && m[1] === k) {
    // Correct key proves the admin — clear any lockout/strikes from
    // this IP (a typo storm is forgiven once the right key arrives).
    try { clearAdminLockout(getClientIp(req)); } catch (e) {}
    return { ok: true };
  }
  // Wrong or missing key. A manually-blocked IP stays blocked.
  const ip = getClientIp(req);
  if (ip && loadBlockedIps().some((b) => b === ip)) {
    return { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' };
  }
  const remMs = adminLockoutRemainingMs(ip);
  if (remMs > 0) {
    return { ok: false, error: 'គណនីនេះត្រូវបានប្លុក ' + lockoutTextKm(remMs) + 'ទៀត · This account is blocked for ' + lockoutTextEn(remMs) + ' more' };
  }
  const blockedMins = recordFailedAdminAttempt(req, ip);
  if (blockedMins > 0) {
    const ms = blockedMins * 60 * 1000;
    return { ok: false, error: 'Admin key មិនត្រឹមត្រូវទេ — ត្រូវបានប្លុក ' + lockoutTextKm(ms) + ' · Wrong admin key — blocked for ' + lockoutTextEn(ms) };
  }
  // Wrong key but not blocked yet: say how many tries are left at this level.
  try {
    const rec = loadAdminLockouts()[ip];
    if (rec) {
      const cfg = lockoutLevelCfg(rec.level || 1);
      const left = Math.max(0, cfg.tries - (rec.tries || 0));
      return { ok: false, error: 'Admin key មិនត្រឹមត្រូវទេ (នៅសល់ ' + left + ' ដង) · Wrong admin key (' + left + ' ' + (left === 1 ? 'try' : 'tries') + ' left)' };
    }
  } catch (e) {}
  return { ok: false, error: 'Admin key មិនត្រឹមត្រូវទេ' };
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
// History: each user's created things (songs/images/videos), keyed by
// lowercased email: {"<email>": [items...]}. The website's localStorage
// is only a cache; the server is the truth, so ONE Gmail shows ALL old
// data on ANY device. Base64 thumbnails are NEVER stored here.
function loadHistory() {
  try { const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch (e) {}
  return {};
}
function saveHistory(h) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2));
  ghPersistFile(HISTORY_FILE);
}
// History merge key: item id first, else its src/url. Items with neither
// cannot be matched across devices and are skipped on sync.
function histKey(it) {
  if (typeof it.id === 'string' && it.id.trim()) return 'id:' + it.id.trim();
  const u = (typeof it.src === 'string' && it.src.trim()) ? it.src.trim() : (typeof it.url === 'string' ? it.url.trim() : '');
  return u ? 'url:' + u : '';
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
  if (m && m[1]) {
    const tok = m[1].trim().slice(0, 64);
    // Modern Chrome hides the real model for privacy and sends a single
    // "K" placeholder ("Android 13; K") — "K" is not a model.
    if (tok === 'K') return '';
    return tok;
  }
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
// Blocked IPs (./data/blocked-ips.json) + blocked Gmails
// (./data/blocked-emails.json) — MANUAL blocks by the admin only. The
// admin reviews the Security section and decides; a new or changed IP is
// NEVER auto-blocked — it only raises a 'new device' notification. The
// ONLY auto-block is the attack rule in recordFailedAdminAttempt (5 failed
// admin-key attempts in 10 minutes). Both files are GitHub-backed like
// the other data files.
const BLOCKED_IPS_FILE = path.join(DATA_DIR, 'blocked-ips.json');
function loadBlockedIps() {
  try { const j = JSON.parse(fs.readFileSync(BLOCKED_IPS_FILE, 'utf8')); if (Array.isArray(j)) return j.filter((x) => typeof x === 'string'); } catch (e) {}
  return [];
}
function saveBlockedIps(arr) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(BLOCKED_IPS_FILE, JSON.stringify(arr, null, 2));
  ghPersistFile(BLOCKED_IPS_FILE);
}
const BLOCKED_EMAILS_FILE = path.join(DATA_DIR, 'blocked-emails.json');
function loadBlockedEmails() {
  try { const j = JSON.parse(fs.readFileSync(BLOCKED_EMAILS_FILE, 'utf8')); if (Array.isArray(j)) return j.filter((x) => typeof x === 'string'); } catch (e) {}
  return [];
}
function saveBlockedEmails(arr) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(BLOCKED_EMAILS_FILE, JSON.stringify(arr, null, 2));
  ghPersistFile(BLOCKED_EMAILS_FILE);
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
// Known devices per user — u.knownDevices is an array (max 20, newest
// first) of {model, device, ip, firstSeen, lastSeen}. Updated on every
// successful sync. A (model + IP) pair never seen before for this user is
// a NEW device (raises a 'security' alert, unless this is the very first
// sync / account creation, when the first device is recorded silently).
const KNOWN_DEVICES_MAX = 20;
function trackKnownDevice(u, model, device, ip, now, country, countryCode) {
  const m = typeof model === 'string' ? model : '';
  const d = typeof device === 'string' ? device : '';
  const i = typeof ip === 'string' ? ip : '';
  const c = typeof country === 'string' ? country : '';
  const cc = typeof countryCode === 'string' ? countryCode : '';
  if (!m && !d && !i) return { isNew: false };
  if (!Array.isArray(u.knownDevices)) u.knownDevices = [];
  const idx = u.knownDevices.findIndex((x) => x && x.model === m && x.ip === i);
  if (idx >= 0) {
    const e = u.knownDevices[idx];
    e.lastSeen = now;
    if (d && !e.device) e.device = d;
    if (c && !e.country) e.country = c;
    if (cc && !e.countryCode) e.countryCode = cc;
    u.knownDevices.splice(idx, 1);
    u.knownDevices.unshift(e);
    return { isNew: false };
  }
  u.knownDevices.unshift({ model: m, device: d, ip: i, country: c, countryCode: cc, firstSeen: now, lastSeen: now });
  if (u.knownDevices.length > KNOWN_DEVICES_MAX) u.knownDevices.length = KNOWN_DEVICES_MAX;
  return { isNew: true };
}
// IP country lookup (lightweight, fire-and-forget): ipapi.co, 3s timeout.
// ONE call to /json/ returns both country_name and country_code (KH).
// Never blocks a sync — when the country arrives it is patched into the
// user record + the knownDevices entry for that IP in the background; on
// failure (rate-limited, unreachable) both stay '' and the sync still
// succeeds. No dependency.
function lookupIpCountryAsync(email, ip) {
  if (!email || !ip) return;
  fetch('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', { signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json().catch(() => null) : null))
    .then((j) => {
      const country = j && typeof j.country_name === 'string' ? j.country_name.trim().slice(0, 100) : '';
      const countryCode = j && typeof j.country_code === 'string' ? j.country_code.trim().toUpperCase().slice(0, 8) : '';
      if (!country && !countryCode) return;
      try {
        const users = loadUsers();
        const u = users[email];
        if (!u) return;
        let changed = false;
        if (country && u.country !== country) { u.country = country; changed = true; }
        if (countryCode && u.countryCode !== countryCode) { u.countryCode = countryCode; changed = true; }
        if (!changed) return;
        if (Array.isArray(u.knownDevices)) {
          for (const e of u.knownDevices) {
            if (e && e.ip === ip) {
              if (country && !e.country) e.country = country;
              if (countryCode && !e.countryCode) e.countryCode = countryCode;
            }
          }
        }
        saveUsers(users);
      } catch (e) {}
    })
    .catch(() => {});
}
function pubUser(u, modelLogins) {
  const map = modelLogins || loadModelLogins();
  const model = u.model || '';
  const count = model && map && typeof map === 'object' ? (Number(map[model]) || 0) : 0;
  return { id: u.id || '', email: u.email, name: u.name || '', firstName: u.firstName || '', lastName: u.lastName || '', credits: u.credits, songCredits: u.songCredits, plan: u.plan || '', songPlan: u.songPlan || '', createdAt: u.createdAt, updatedAt: u.updatedAt, lastIp: u.lastIp || '', country: u.country || '', countryCode: u.countryCode || '', device: u.device || '', model, modelLogins: count, lastSeen: u.lastSeen || '', knownDevices: Array.isArray(u.knownDevices) ? u.knownDevices : [], hasPassword: !!(u.passwordHash && u.passwordSalt) };
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
// ---- Server-side credit deduction (real, persistent) ----
// Generation used to deduct credits only in the browser; the next sync
// overwrote the browser value with the server value, so spent credits
// came back. Now the server is the truth: it checks the balance BEFORE
// calling the provider, and deducts AFTER the provider accepts the job.
// Every deduction is logged to grants.json (the credit history) and the
// user file is GitHub-flushed before returning success.
// Out-of-credit notifications: at most one per user per 24h, so a user
// hammering Generate does not spam the Admin bell + Telegram. Goes to
// Admin (bell) + Telegram via the 'out-of-credit' kind.
const outOfCreditNotifiedAt = new Map();
function notifyOutOfCredit(email, kind, balance, cost) {
  try {
    const em = normEmail(email);
    if (!em) return;
    const now = Date.now();
    const last = outOfCreditNotifiedAt.get(em) || 0;
    if (now - last < 24 * 60 * 60 * 1000) return;
    outOfCreditNotifiedAt.set(em, now);
    const users = loadUsers();
    const u = users[em];
    const uid = u && u.id ? u.id : '—';
    addNotification('out-of-credit', em, '⚠️ Credit អស់ · Out of credit', (u && u.name ? u.name : em) + ' · ' + em + ' · ID: ' + uid + ' — ' + (kind === 'media' ? 'Image.Video' : 'Song') + ' Credit មិនគ្រប់ (នៅសល់ ' + Math.floor(numOr(balance, 0)) + ' / ត្រូវការ ' + Math.floor(numOr(cost, 0)) + ')');
  } catch (e) {}
}
async function deductForGeneration(email, mediaCost, songCost, reason) {
  const em = normEmail(email);
  if (!em) return { ok: true, guest: true };
  const users = loadUsers();
  const u = users[em];
  if (!u) return { ok: true, guest: true };
  const mCost = Math.floor(numOr(mediaCost, 0));
  const sCost = Math.floor(numOr(songCost, 0));
  const mBal = Math.floor(numOr(u.credits, 0));
  const sBal = Math.floor(numOr(u.songCredits, 0));
  if (mCost > 0 && mBal < mCost) { notifyOutOfCredit(em, 'media', mBal, mCost); return { ok: false, error: 'Image.Video Credit មិនគ្រប់ទេ', needBuy: true, kind: 'media', balance: mBal, cost: mCost }; }
  if (sCost > 0 && sBal < sCost) { notifyOutOfCredit(em, 'song', sBal, sCost); return { ok: false, error: 'Song Credit មិនគ្រប់ទេ', needBuy: true, kind: 'song', balance: sBal, cost: sCost }; }
  if (mCost > 0 || sCost > 0) {
    if (mCost > 0) u.credits = Math.max(0, mBal - mCost);
    if (sCost > 0) u.songCredits = Math.max(0, sBal - sCost);
    u.updatedAt = new Date().toISOString();
    saveUsers(users);
    await ghFlushFile(USERS_FILE);
    logGrant({ email: em, credits: -mCost, songCredits: -sCost, note: reason || 'generation', at: u.updatedAt });
    // Admin bell: every generation deduction is visible to the Admin
    // immediately (account + amount), and to the user in their own bell.
    // The website also raises a local bell notice instantly; this is the
    // durable server-side one the Admin app reads.
    try {
      const _parts = [];
      if (mCost > 0) _parts.push('-' + mCost + ' Image.Video');
      if (sCost > 0) _parts.push('-' + sCost + ' Song');
      addNotification('deduct', em, '➖ កាត់ Credit · ' + (u.name || em), _parts.join(' · ') + ' — ' + (reason || 'generation') + ' · នៅសល់ ' + Math.floor(numOr(u.credits, 0)) + ' Image.Video / ' + Math.floor(numOr(u.songCredits, 0)) + ' Song · ' + em + ' · ID: ' + (u.id || '—'));
    } catch (e) {}
  }
  return { ok: true, credits: Math.floor(numOr(u.credits, 0)), songCredits: Math.floor(numOr(u.songCredits, 0)) };
}
// Refund a generation charge (provider failed AFTER we deducted).
// Adds the credits back and logs a 'refund' grant entry.
async function refundForGeneration(email, mediaCost, songCost, reason) {
  const em = normEmail(email);
  if (!em) return { ok: true };
  const users = loadUsers();
  const u = users[em];
  if (!u) return { ok: true };
  const mCost = Math.floor(numOr(mediaCost, 0));
  const sCost = Math.floor(numOr(songCost, 0));
  if (mCost > 0) u.credits = Math.floor(numOr(u.credits, 0)) + mCost;
  if (sCost > 0) u.songCredits = Math.floor(numOr(u.songCredits, 0)) + sCost;
  u.updatedAt = new Date().toISOString();
  saveUsers(users);
  await ghFlushFile(USERS_FILE);
  logGrant({ email: em, credits: mCost, songCredits: sCost, note: 'refund: ' + (reason || 'generation failed'), at: u.updatedAt });
  return { ok: true, credits: Math.floor(numOr(u.credits, 0)), songCredits: Math.floor(numOr(u.songCredits, 0)) };
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
// 'security' (new-device login or blocked-model login attempt — admin
// notification + Telegram alert for the admin).
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
// ---- Purchase notification display (big + clean) ----
// The Admin bell + Telegram + website show a purchase as BIG, clean lines:
// package name, price, credits — with the buyer small at the bottom.
// No long messy sentence. Used by purchase-request / approved / rejected.
function tgEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const PKG_DISPLAY_NAME = { monthly: 'Monthly', yearly: 'Yearly', 'song-trial': 'Song Trial', 'song-popular': 'Song Popular', 'song-pro': 'Song Pro' };
function pkgDisplay(pkg) {
  if (!pkg || typeof pkg !== 'object') return { pkgName: '', priceText: '', creditText: '' };
  const days = numOr(pkg.days, 30);
  const per = days >= 365 ? 'year' : 'month';
  const price = numOr(pkg.price, 0);
  const cr = (numOr(pkg.songCredits, 0) || 0) + (numOr(pkg.credits, 0) || 0);
  return {
    pkgName: PKG_DISPLAY_NAME[pkg.id] || String(pkg.id || ''),
    priceText: '$' + price + '/' + per,
    creditText: Number(cr).toLocaleString('en-US') + ' Credit/' + per,
  };
}
// Clean multi-line notification text: package name / price / credits /
// buyer. The Admin app + website render the first 3 lines BIG.
function pkgNotifText(pkg, email, buyerId) {
  const d = pkgDisplay(pkg);
  const buyer = (email || '') + (buyerId && buyerId !== '—' ? ' · ID: ' + buyerId : '');
  return [d.pkgName, d.priceText, d.creditText, buyer].filter(Boolean).join('\n');
}
// Telegram version of the same lines, with the 3 key lines bold.
function pkgNotifTelegram(title, pkg, email, buyerId) {
  const d = pkgDisplay(pkg);
  const buyer = tgEsc(email || '') + (buyerId && buyerId !== '—' ? ' · ID: ' + tgEsc(buyerId) : '');
  return '🔔 ' + tgEsc(title) + '\n<b>' + tgEsc(d.pkgName) + '</b>\n<b>' + tgEsc(d.priceText) + '</b>\n<b>' + tgEsc(d.creditText) + '</b>\n' + buyer;
}
// When a purchase request is decided (approved/rejected), mark the
// original purchase-request notification as decided so the Admin bell
// no longer shows it as a pending/new request.
function markPurchaseRequestDecided(email, packageId, decision, at) {
  try {
    const arr = loadNotifications();
    const orig = arr.find((x) => x && x.kind === 'purchase-request' && x.email === email && !x.decision && (!x.pkg || x.pkg === packageId));
    if (orig) {
      orig.decision = decision;
      orig.decidedAt = at || new Date().toISOString();
      orig.read = true;
      saveNotifications(arr);
    }
  } catch (e) {}
}
// Create a notification. For admin-facing kinds (login, purchase-request,
// gift-claimed, security, update, grant, deduct, purchase-approved,
// purchase-rejected, plan-expired, out-of-credit) ALSO send a Telegram
// message to the admin (fire-and-forget:
// it never blocks the response and its errors are swallowed). The bot token
// is never logged and never returned by any endpoint.
function addNotification(kind, email, title, text, opts) {
  const n = { id: newNotificationId(), at: new Date().toISOString(), kind, email: email || '', title: title || '', text: text || '', read: false };
  if (opts && typeof opts === 'object' && opts.extra && typeof opts.extra === 'object') Object.assign(n, opts.extra);
  try {
    const arr = loadNotifications();
    arr.unshift(n);
    if (arr.length > NOTIFICATIONS_MAX) arr.length = NOTIFICATIONS_MAX;
    saveNotifications(arr);
  } catch (e) {}
  if (kind === 'login' || kind === 'purchase-request' || kind === 'gift-claimed' || kind === 'security' || kind === 'update' || kind === 'grant' || kind === 'deduct' || kind === 'purchase-approved' || kind === 'purchase-rejected' || kind === 'plan-expired' || kind === 'out-of-credit') {
    if (opts && typeof opts === 'object' && typeof opts.telegramHtml === 'string' && opts.telegramHtml) {
      sendTelegramAdmin(opts.telegramHtml, 'HTML');
    } else {
      sendTelegramAdmin('🔔 ' + n.title + '\n' + n.text);
    }
  }
  // Phone-native Web Push for the same event (admin devices and/or the
  // user the notification is about). Fire-and-forget, never blocks.
  sendPushForNotification(n);
  return n;
}
function sendTelegramAdmin(text, parseMode) {
  try {
    const s = loadSettings();
    const tel = (s && s.telegram && typeof s.telegram === 'object' && !Array.isArray(s.telegram)) ? s.telegram : {};
    const token = typeof tel.botToken === 'string' ? tel.botToken.trim() : '';
    const chatId = typeof tel.chatId === 'string' ? tel.chatId.trim() : '';
    if (!token || !chatId) return; // not configured — skip silently
    const body = { chat_id: chatId, text: String(text).slice(0, 4000) };
    if (parseMode) body.parse_mode = parseMode;
    fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  } catch (e) {}
}
/* ---------------- Email verification (login) — EMAIL_VERIFY_MODULE_V1 ---- */
// EVERY login requires verification: after the user picks a Google account
// the server emails them a 6-digit code + a magic link. They verify with
// the code OR by clicking the link. Signing out and logging in again
// requires a FRESH verification (a new code + link each time) — there is
// no "remember this device" skip. The email is branded: MovAi logo +
// name + intro + Privacy Policy + About | Privacy Policy at the bottom.
// Sending uses Gmail SMTP (nodemailer) with the admin's Gmail + App
// Password from settings.email (set in the Admin app → Email Settings).
// The App Password is NEVER returned by any endpoint and NEVER logged.
const VERIFY_CODE_TTL_MS = 60 * 1000; // a code/link lives 60 seconds (owner order 2026-11-17 — resend after expiry)
const VERIFY_MAX_ATTEMPTS = 5; // wrong-code guesses per code before it dies
const VERIFY_SEND_MAX_PER_HOUR = 5; // emails per address per hour (anti-spam)
const VERIFY_SITE_URL = 'https://movai-1.onrender.com';
// Logo embedded as a data URI: the static-site push cannot carry binary
// files, so the email logo lives here (transparent MovAi logo, white text).
const VERIFY_LOGO_URL = 'data:image/webp;base64,UklGRkKaAABXRUJQVlA4WAoAAAAQAAAA+AQA+AQAQUxQSF8nAAABsMH/t6ja1t+yLMyyMMuyMMvCLMvCLNuYZVm4LQuzbFu4Ldv4h3PvPXuNOeaYc4y13isiJgBv/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2///R+Hyxr+/hJj1k399HcWZ0SebPYaVGZs9D8LLlDLvo2gyocxXL64cKPl7GkcWFD2IKCPKf4SQHuVfosmRiX5Ejw8muggkTPkaOb6Y8DmIMPmoweQDCFWMGNTwHjxW1DJaPKnkJnJQ00ixpqJh40ldz1GiT10vMYP69kME9Q0YfWr8Ex/m1PgQLbZUuhccqHWsoN6PyDCk3pGCqscFqh4nqPwsKFD5fYwYUP1TSKD62wgxZg7jwQcz+BUfhsxjNGAev6LDgLnshwLm8hUcmM9eIGA+r6GBOe2HAeb0EBiY11EQYF4HYYG5jQHMbVT4yg4jAPMbE9bMsP8xxyGBWfa+nyzdAwIz7XsP5nkYDk65oudtmetwwGyf/W7MfAcDZtztBsz4IBRcc0avY9ZDAfPuc8z7LhAw9x7H3MeBYfbob/fsfYUB5v/hbSvmPwpMDMC5rw1pwGsQoAl9jSaMAUMb0NNow30IoBX9jFaMRPSyn0D0tMOPj51pxwBAQ249bMl2Ah2sT0v23Y+29C/aMhbRu9hmoG8xFt3MQc86mOPufLTnh1/1aM9oxL5bsf3AnlMxGt1NQp+iSe+uR6N6FI0akOhP5/bE3ZsWbE/ww5d6DEhju3DgSoxItKwn0bBfMYl+RNMGJXrRvY1BH1qzlXH2oDHbGVw4ENsa9B+2N+g9jEsDA9F3GJimFqLn3CzUd7utiT78ZksLz93uaCL23YYmXrvd00YcOA1tfHA7WtlnaORLdKLH0MrP8ER/oZ3j08tbDi0Srn1lwDYJfYXtEnoK2yb0E7ZP6CVso9BHPtopexdhO4UzB2Fbhf7BKNUzGL2DYWpiMfrGV5xamYyecWSc+rAZ/WLEQPVltINbMFLR6l5Bow9iFX2CVh8HK3oEzb6MVvQH2v0Qrm7esDHcNVzx4AtzGv4erzhzBVr+FbDoCbR9xKIfsH1DL2Abhz5waOd8ecCM7RyuHYBtHQ6qH9s7rH1s87DuMWz1yoA1bxu3RoXAejdg3JqXwqvaMXDtSoGnSsdSHLjcqRg4qXIsxrHLsSCHFY7luA9erG/PgjhFL9a2NQvyFr5Y2ViSz/jFqsayDGCsaGwdPaoZ20dcVrJXG4njKnZkK4n9CjZhS4kVjCGsXySsXoxh8zK5Vy4GsXWZcFO1GMUOhcKatQ5jp1JhxWIY+yoWViuW6sjhWLCVisU6DWXfVYrlugxlXFWoz4LZxDLWpwML9hbMWJv6LNpoxsrEVhWrEltWrEhsXe2qEdtXnFWiYxuLdWjFVhZr0IQBrV9ErECMaNMyYvVhSFsX0r3yMKZ9FBJXVYdB7V5KHFScZyn13Y3lXG92LOV5XGO1YTFvAhsrDcv5M7LdqwwL+hXZuKowLOrQxkF1YXuMteXaJmNd2bBVxpoyYsvsWVHYNuOumrB9xlElYXgblRjrCOPbrMhYQ2YBbl1mrCAMcPtCY/VghLuU2rFysNCHznYvNY6qBkt95Gws95rBYt9HOdaLbbk9wxxrxYAFH+dYKdiKY5VgS+5cIdiW46Q6XNtzrA1ztuhYGdiqY1Vgy44Vga27RTVg+46jSsA2HuvAvp3HGrBguOtVAlYA1sG+q61rAYuPlXDlah/V4KvwWAs/XO1RDbgrOlbDb1djRRwU3LUeMOix3A5s/bHUZuwAYJn12AnwXWTsBuC2wNgVwPJ6dgewtObsEGBhsVOARcWOARYUOwf2xcTuAfYK6aeLgL0i+mCVnDjauFKwhHask1tH29cKlk+PlfLuaPdq8SweVktH+64WPBcOWwCsmNOiYbcB+wVz7jpguczYecBSGbEDgYXCToSPImE3AgcFwq4Elge7E1ga5y4FlsWMnQosCnYssCBYQ/vtgk0xsIrO3GxaRzgrBNbRDzdbGeBuIg6K4FlJrm52MABsxBLY0cSTXf7oZncLwEa034AmnmERZ2gC2Ijmo4kXwCjQPQDARt/Go4m/AAwC3e2Pq4l4MR1tjD8D3ekP2IgTw9HGiHa7f4CNODDbxUYId8t/go1otTlN3I93/X+BjWizGU28RbzDvx9sRJPRxA9EPhiJBqONEftgpJ25aGNEP9iIU2PRxoh/sBH7pjrZaBJyptbo2YiWmtPEexhj5mRba+BoI9ppRBM/YI2dkx3NgauNaCbaGOY4OtnTHjASjUQbwx5fTkaDwEhHE9HGMAjjDmzEkYG+bDT5ha/IBxvRPl808Q6/eAx9sBGtM6eN8ZuH2Le2EY1DG+NXt2Hu9jswEk1DG+N3V2Fu90sw0sUwtDF+eRLm5r8FG9EuLxvNfgthrvdrsBF7RlnSxHtEPzRoI9qkRxujxXC0EU1CG6PNACPRILQxwk/PNjDS0Ry0MeLP1DiwEWfG+LbRzDh9F9tZBzZizxRbmvgE40xd7GieqY1oiSVtDOtsXOzTPHjaiIagjWGeq4s97AMj0Qy0MezzcjEaCEY6G4E2nhqIUQg24sIEtPEnmr8HuW8JsBEtcDYSBO6D3EnE3kbMX582hsRZkNuKwMtGzB5tDJGDNgGMxMzRxhAa5CDVSOes0cajNgZsxH7GzjbaoZUxsRHzNaeN0c7AxkbM1YA2RlsDVxsxU7QxYlHPVDDST5ZoYwSjka1gI54zRBsPbTVysLmxYCPmhzbewlZzBztYCzZibjY2usJYOwe7mGtlI+alTxvDWkcHu5kLRmJWaGOY68vBnvaCkZgR2hj2ooPRYDASs0Eboy0CI90yQRtP2yNTG/GShaeNvpHgs60AI/GegQ1tjBQfIe6SBIzEo360MZL8CHGHNGAkLrUb2AhpzkLcMBEYiTPl0LPQIJFeiOulAiNxphxgnyNSDXFIdmskTrTDwzpoo8BKXGqHkW3QToGVuNUOsAwiU990sBLP6uFiFpiu515j28FKfKoHGGVuu4l7zY03sRKpHx4WOcJ2K/faGg93M1E/9AwC4y3d62A92In6AeaA9XbudTEf7MSFfljaAua7uNfdfrATH/oBloD97u71KoCJncgM4McMvQKge7EAsDUUR/phaIQ12jH4MhSf+gEmeEDBRzsCliIzgIMBoOGxJQFTcasfkD2oOA1wPzrAVGQGcM4blAxwRyWmtuJaPyBnk9bEhxLY2IrMAPJ1RGtirQWsxZF+GOcK7YmpGrAWqR+QJ7QoBnrAXBzph1mGUBK98DJSBOYi9QOyg6IYhhdourIXM4BpXhZl0XeuXlnAYKR+QFZQFmPnmhQGLMa+ftjkA4Wxdq6lA5D6AblAaeyda+4C7OuHaxZQHDfnOvkAX/qhn4FhedC5Xk5ADtQD1FtB3Ud0oRuQ+mGu2zf0PbTnOFYPUA0KT1p0/NYPn3pB5TYdqR+gFVoZj7rAjX7QadTOuFYGUj9MFFqjnXGsDhyoB6jzg5bGuj6Q+mGtDNoasxpB/QBVELSGBuhXCT71w14PlMzQtcYGQJ0g9QO0QNGMXWviFzzqh5MKo7KZudbMMUj9MFTggLKZu9baNXhWD7gnh8I5utaHb5D6YZwYSufiWjfv4Fo9ICkUz921Xu5B6od5Or3yebkWHYRT9YBU9lD/lj+2fUj9sEniBf1PHQAcqQekgAxuuwB41g8HccjhqhOA1A8QhiyuOwJ41A9XScjjLLh91RNSPwzkjDPRD26XmsKpesBDyAm5DG6HqkLqh5EMtEN2lYUj9QAJKKi+Yw0MsK4tpH5YNoaSmjrWyADL+sK5ekBDKKqlYy0NMKowpH44NTEoq61jbQ0wrDJcqwf83hFldXSsswEGdYbUD7/1QmFdHetugH6t4VI94HdQWk/HogFRbUj98BsoLraUuFcP079CZwipHvAX4y4RztXD8b+s0SlCqgf82xUZ/u424EA9/Aty/NVxwJt6uPyBLF+7Dkj1sCGR53P3Abfa5fvQgUAWyqYTgWUyN8AwsHzXI15LZGyAqVv1DfBRkcgCgQHGbjU1wK4qcVehZm61NcCiLpH16eBWJwNMaxNntensVjQgqhNZme6tKtYltqv47O4hO3z47O4hO3y47e4hO3y4t9+rs4E0363DgTPj7bocSNstAtu9hnFsubEB+k41NMC1ipGG6xtg6lQzA2wrGQdmgwF2TrU2wLiW8Vhvzk71Y4B+NSOrzZdT0YCoaPyoNGyDkR0+XHb3kB0+7PDhubuH7PDhubuH7PDhrruH7PDhykZfQaXvfKSJjkFl4n6cGWgeVFYG+Kx9pH36QeVigG39o3lggKFLfRlg6QA8VY+lS9GAEw8ga8cpqAx8gJe68QgqcAKyarDlxlV3D9nhw2V3D9nhw013D9nhw4E5nt0ZpDWOXRo0xqpTgw9TDIPa0ytISyCkjCIDv2PbygAHxyAH9WDiUGcDzF2DrAZbh3oYYOQcrAVnh3oZYOodZB14OBQNOPYPVoFXSOk5CHcVgCEFHkJ2+HDc3UN2+LDf3cOP7h6yw4eP7oEB/nFVPuSoWwD/uXx46RCY4y8nxUPm6NhOwi+WD7f52baShr+BfvGQ2ZkFlKEBvq13xi+/ioeTzAwN0HOnjQEO1sPvFw+Zl54Bxu70YYCN8e4N4Lt4OMkJDLB2p6sBZsZDs8VDFtWnOz0NMCoZlA9HBfVyp5cBUDQYFg9ZTnQn1i6gfDjrLMCqePjqLACKh+wuwLl4eO8swLB4yM4C4FE8PHcWYFg8ZGcBUD48dxYAxUN2F+BQPLzpdQon/doGFA+p1sYAE2caGOBVWjgWD59KjQwwd6aZAa7FBRQPqRMMsHGmnQHWBYbP4uFnmZyd6WSAaYlhWDxkkdyd6WqAXpEB5cN9gXw509MAKDSsi4csDzoT6x1QPlx2FuBePGRnAXrlw1lXAXAvHr46CzAsHrKzALgVD5edBUDx8Ke7AOfSIbsLgOJhhwEupcORAl8G6LdTgNLhLr2tAUZtFVwLh8fkDgaYu9LEAPeKABQOab+tKy0MsK0KeBQOE9sY4ORKOwNM6wJQOExrYoCrK50M0K8NeJYNkxob4O5KNwOgOmBYNk/bPV3p2yOAouExoZEBXq5En8CoZLhPp2cAtmCAkmE/GbTksCsYjjoOgIJh5wHO5cLOA6Bc2H2Aj2LZdx8ApcIuBJwKheGn5yFAoTD6jA3wU0PwWSY7k40caWKAUxUBioQJvAwwd6SNAT4qCc4lQnkXA2wd6WCAYS0BSuQq7mCAoyNdDYB6gld5UNzKAA9HeroKxuVBaTMD/DgSfQUoj42wiQHY3kG/NChs2OoDSuMpCy0/DMqCnQpAWbBbASiKQccCSoJdC5h39wDlwO4FbKtcrx0ElAJNNXajvvfgo77N3WhigFvlAcrgM+LMDXCqPvgqAcq5G2DjRlsDrOoPUAITMQcDnNzoYIBJDUIBUMzKAFc3uhhgVoUwLqaBAe5udDfAuA4B5jtKgQFebvQyQL8WYWY82oluRAOiGgEdPtiY7tztAFiOXQ/47O4B7LbsfsDBauyAADp8sO/uAUy2tlLPiXp+hYPBaKWhE40cC6hWUyeauRa25uqL+DbAwolWBrjXLMBaGxE3A6ydaGOAa93Cp60o4sMAOyc6GeBUuYDiWBrg5ERfBthVLxwLY2KAuxPRgMv6BRhqIGFqgJ8wMqthOJhpJ6FnAIaRcRUDrHSWgEDWq2S42Yixrl/LgPYR6hk6fDDo7gEqUa+VhVkVGrSzgBo0amthYZqRjSatLcAyBxstWlwwzMtG6zbXxC600aHNBdM9DXBsdcFyJwNcXGgcsZYGuLnQ0u++DQcD/LjQwe8OVYcudPW7efh7GuCn1s3CHw14qXXTFtCh1m1aQKtaxxbQpLsH/2vj2t3Dzh529lwN822kSWvrQcN+GmnW1qJp1yKeBliGkJ/61qdtJyJOBtg4UN8Ar+pG60Lk2gBnB5oY4FLZhiyCgQG+HWhtgHVdo4FlwAB0oA8DLGragG2CuwGWFY02jjNPA0yrWZ82vsQZGrBfy+408iTSoZLRzOiaoKE7Jibs6rnR0t+dErT1okNiT2OjO4LmNtSg5bShuX/EvAywaDfR4DMxZwNs20wrWhxilwa4uM/QAD/VijaXMzPAl/vMDXCrVCPafC1nZAC6z8YA5zr1Q6NDbj+A7A2wrFF9ml0QAsjJALMK9UWz30LNzQDD+kTDj0PNwwC92rSj5RFqaEBUJpr+2OWwp+3R4UDrdzcsaX10NtD+XQ072n/X0cASRCfDliU462RgGUL63QCj9s+WZXgSdzbA0nkGDsRShPidAXbOMzPAT+WZsxRX8pYG+HSepQHudYfliAQNcHOenQE+as6C5bgzGZ3nbIBlxWFJIuDcDbCpNnOW5CjiPA0wrTUsS0QcGrBfZ8YsSwQ9VJkfluWxQ4Glic6EF0sTXQl9FuelK+HJ8kRHAgsU3QgvFuimG4FFirDT95QvFilsN3CdoaOwTJH0ywBj15m7ySfLdJ3W1QBr19l6CQv1irTnBti7ztFHdixVJD4wwMl1rgb4qiAsVqQ+McDNdb4NcK0eBxYr0jcAXefLAMfawXJF9HkZYFs3jixXhB8acF41WLBoA4wqxgcLdtIKQL1gyfbQZXBkyULLlhqLFl0GBxYtugxYtghCPZc4s2i/UBZjxxl5BMt2hcKYOc7UH04s2x5KY+c4S3dg4UJbC5wd5+AMa5btE+reDfDtOBdfYOGOoe/eAHScsydsWbjQeBs6Hgb4rgYs3B1UXoYOGvBRCVYsXCg9DV7XOsDC3ULrYfDa1oA5Cxd694LXvAKwcHfQPHj1im/JwoXuwQulx8J9obNgzMKF+i0uFu4nOgv6LFzksK3Fwj2hs6DPwkUmX4FjUO9YuDfk8hE4ZrVuyMLtIZufBpi5zbrSvVi4yOjRACu3OVW5GQt3gpweDHBwm0eNY+kirxsD3NyG9a3Hwh0iswsDsDXxzcJFdqeh61FWLNwlMhy6LiV1YuEiy6FrX1As3B1aF+tiWrNwkevQhVJi4Z7Q7ts2sWLhIuMtITbAwv1E+2/9WzMWbh8ha1iZ+Ess3G9kPm5MaxN/48jCHSFqrasT/2rE0kX+LTB1mn194sd/u7BwYUELrJzmWKFI9v9p+MnC/UIl2DvNpU6VMox4NcDdae6BA1Y8GoBO8wwba5hxHzYeUQOGXIYNxowDLDkKXC+HgTED16e7TGDMXuBaewvsGbgmvjJFm6TnKjBp4Bo4yggtE/gJrNp9sUJXDwzbcbFG3Ri02GBbC8xdphciFqgeK5cZRQiY1wI7l5nGhzVqyNFlVuEBFr4Z4Ooyu+BwgIlPBvhymVNsgJEPBvhxmWtk2MLKGwPQZRgYYOdVx8QJhp52S8DUw7D19IgTbN0LWx8OAXOHrbU73NCamXgDLB62er5wRZjrWQCuMECt6TvMOBZ8weoWGDnMMhTA7hZYOMwuEqDqbBzmGAeWsPzLACeHuYQB2P5qgKvDMAhMYPydAZ5tLZh/bgC2s2bo6kEJDjoZUIhdDGj1PGreDO2eS8VDQQatXbWbo/Uzr3Uoy6A1rHM7VKdexECVQ3FaoO8uPZ87oEaN3GXocijRiDF3uCcq1cxd1v6GQv02wMJdju6GUr0aYOsuV2cboFg/DHBwl4evoWDXBji6Cz1tjpJdGuCrxYSynRiAraUDCnfYXdBH8XYV7FDAIetZwVDEIetUvXZoLc1rF0o5ZE3q1hhtpkHVQkGHrF7FWqPl1K9XKOuQhVp1Rcth4Fco7ngx86oratzAWdZOhRL/MsDCWU4udUGRfxrg6Cwvj0KhHwzwdBb60x2lvjYAWz4o91HAelSlO0o+YO1rEso+YC3r0RVtq0U1QvEHrHElOqGF1a9DqIEBq1eDPtHOQgXqo6PngVrYvkM9bNu90NoYec8IvjB2lYnvfKEuWmDhKkvXQW20wM5VNp4Dhzi5ys1vxqiP3wa4u8rTbVAjTwZ4uQqdZogqeTAAg8WtxqBSzsLVsb7MUC3D1a66oGKGq3VlmaNFtqwrqJvhalZT1miXjSsKqme4GlSTA1pnqCWooe20NZxk0D5BJbXAzFFmPrKGn2wdZesiqKcWODnK2UFmcJVPR3n6B6qqBX4chd6xRV29GoAR6Wkz1NZVO2FpsRuq6zhYPXPRMxgqbC9YnXMBc91QZYPVtlKg0gardZX4RituWiN6aMeNsnE3FCpusJpko2emGVpzg2zASqi7oeJpANSFKSrvK1J8ltTdQqi++0jxUVIj+8xQf+eRYlhSMA9qcD9/a0dB/i7VYIk6nL9ZpBjlZG4a1OL8TSIFsmqYBdwIUenbLKjI80hxKCoYZYuqHCmQu20FQGXO3SZS9DIzMcgRvoRIgdzaY4TqvIwUn2U1MMYdNTpSTPI2zg5sgTqdt76zIG/IsCEeqNSPrMFbvyod6nWk6OVsmSMY4QyXGroLcoYsP02Aqv3MGPx1W1gwwBqVO19Xh0G+RpmaZg/VO1/w2Fe2kOvMrVG/h5ECuRpnC1lDFc8VIgXy3cvXE3V8EimQp23G8MwVqnmeECmQ9TzdUM8XkQI5WuYNOUJVzxH89itDyH12DqjskQL5QfaHmUF1zw88d5ObV/4wy8kFFT43B9dBbmDBdT5Q5beZgfPmZWoCnDPxRKXPC7x3kxUY8ZgF1Puc3NwHOYEZ9xlAxZ9kBA6cj54dsNAOdT8fcOFcHGBK3VD7c7H0oUkmYEzFpqj/ebjDiXdZgDlPWsED+1mAG39lAAbtqzSAD+4yAEfWDzbV5wU3vKkHV9auZxRclIEnagdn1m0Iu2qyhi/qBnfWDKbdqQF31AwOrResqwM8Ui+49KdSMHB6I/ikVnDqnUqwcVoDuOVVJfi1QjDzNRm45lKfBTxbmyEsPUlhB/fUBs59UAXm3sq6wkW/VYF/67GCyadSTnDTvh4jePiXErB779zUaQpf1QJersEM1u8tf+U0hMsONICjD1N7IBjvU9vA13dJISBfU/qBvy+T6SEmf6byDZ9fJ4HAfEjhE44v7YDoLA3eP5ZzQoieyJkjBn4KmCFQDwVcEAvXv3dCxO5//N4JUbE/O99//uH52I0RvgeL4+Mffu7n9QBv/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b/2/9v/7/9//b///fZ6+I58T/eu3RG/OtxR86Cv9rvwuGvd9+wwa4bNtptw4ZDwPh5Op5PH4c/j8fj8XK5XG632+3xfPH1+n5+fT0et9v1+j3L1miyWm02q/V6vV6tVqv1n5vd/ng8Hi+Xy+V0On587Leb09QJHj/88+f559fX19frP//8/Pzw37+VY+MRgIJz9aRcH6DovWpsfhcqRpmiY1GzsQCGCuZp5yxbM1DiZ3iis1D4S6+JCIaKRzihXpQ5jxTM0dNZjrZiqFhmiM5C8XetpgGF4YRaMYLRWU4JDOPUIzgwwZ84xdwcnGWQAgPVLDN0lntsY2hgmi0FOks/uj0CAxNdqXSNKczJt49RpYmQc7joZ4TOsrYEhCBcMB9Tb2GyW5U+gxe9jCpBRC9g7IPC2hhPCQgYzAW9hSmrBAHorBk0towZzAO9ZWcOHJtCdwTT1gmfzSBqjHIwDCA4N4GwwRzQWxYmwerXvtElwdS1An5piMjxo98zimD4CzvEwTSoH73lbhcAj/82QiRMZK3d3l2Y/F21Pwfb83E+QjRMhNrRW/rpUb2gGEKeoY660V2oYUfLLthtNKO7UMV5oGI0YaQa6rVwl2u4o150Fyq5bAFsvY6R6qEV3eUR8KjUwF+o5iFSzXSiu0z1YKRiDKDMdRviw6kg4yNSXTWiu3zIOGAngpGKCvX8hTIBhLOpPvS9Q6RiEU0Wa/7q5bDq14C9jD2AgwhGvqs5xjc2/b0cFB5l4s9w9tCGtjhS7CilDSVqcaXAU/52ijwpMHqwXCj9mgxl6nClyARuMmb/sBNBRRhgFrrQCmOm+ZPGMB8UeUuAMvHP9uhFDxYIUx4mAFvAAMwKItHJAiumvtWJGqyUusoY/csynFET5m9PDcUtc0GRhwQoE/8uY5STQYtgSi2FwRIwAXPSjx8nPZg7aqrPOL2ZUpSJ/7i3Ri9+sBCo7EPSUATTo8idfpAxiXiXvFFfQbADlPoSx4z0Awi1YM6o8lPOw24PGfjP+5bCNGfUWgxEMDWKRIKUBxmTULXUgflaUO8q8JEAQxVt96LmJyFPq1Em/nJui14UYraovQyIOKZFkb08QMY6Eh2aYxZmSlF/NagflPpIgpEIOXgIgE7MoYibdlOlKBN/vY5nTI+ZYh4lQMQ+JYpELiBjlwuEiIEF+ioxk2claI6+jEsijEQQcEmNAqERs7kRcNFtrhRl4hdn4WrYHNVba8SMCoCITTo3EcgHZJwiEQT00qJAKHTOCXVgOtRpKOOcDEPRvjnai3ltbqvZQMQrAcrEr36EK+i2EQCFmNvGIOKeyl4EcgIZ91i1Tok5YnYfGjAV6rSRcUiIoQjNUbWLPpf8sLFl3k4JUCZ+edcmoEDowxQPA/zr4icJNgUR0zSWIpAXyGAoOjVHS1H8aoC/H8ujAkyDOu1kHMMY9NoKgDp7YSf8vi7I2T4BysSvX2UMY9U5FWaIoi9oVhbzNBaB3EAGQxGao1pLdSj5geZFTdNjCtRp3RKhQGjTlwSRfUFsCPlaJECZaHApYxqKes1RqYM6FAypgr6NgvxABkMRdHoJgDZrOQvIlcOGLhIo76XTMeDdmzulwPxQLEQ/xbAZqESJgwQoE43uZJxCEZpjAj0B0GYvBsJPloP8gQKQwejG/FAqxL+ksJmdBEp76ESZz2iG5qjQLFMreVABClEitELDCxnX2EaB0IZCv5GilHsBjFSADMair+ZO6nxnCmkKYTN9CZT1LeE7AQY9NEdhKwHQ5iwEiS6FrBuBOpQIraaNQcYhsjE/lDlOBUJovp4Q6MBYhOaoDPKEdBWABEraSjglQC2OwY/5uchAwh8yPjNCidBqKAAyvmPRsrmBKht1qB1k0HgDIdCCsQjNUdBSALKEpGfpQQLl7CWsEqAeh9DH/Jz1g4xLNigRWvVFQAZjEZqjIlCHIpH4TQRNNxaCtgOLBOlBAqVMJQwToCaXgPXR3EmNVZbGBUGJ0KonBDIYi9AchWwEQJ2TCKQvgs1822YvBG0HZog2ggSqgQSpy1HGMhahOSqBLI0VeJiBKvWE9MRABgMajQIN0zvk4zuBqxBEtlVzOxX2+iwN8WwGEqgEEqQ2RxnLWITmKKAnAPpQ4iIXzAEzBskyGIy+m+s1x+YfeYKK+/RWuVgk8GgDoDkqALshPUi4qIAEqc9exi2YsfawOWasLwoyGIz6zTE5KDQx1CAPowQoFNENqe2ytJIwzceuIeQBNrjKOEareTNsfqERJULJswQ2dRLApqjSRMhQGGQwGKE5NjISANMNFUAOkCCFQqVeIGPze9uhPjEYTZtjUii+qwA2Q5WGQqbiELGQEisI9EOCFIoQd2xulRA87UsGgxGa46+d7fLMybCxiwA2QYG3BCZCjgkgpg1/i80fsnXJybgxaIcEKXSk1jgYoTn+0lQAsrVU4yphVSpQizGMuRpIWKhxk7BubiDg9XsUuEmgL+QziVXI2jbHRKDUQsJUjYeEXXMQwJSQILM/D0ZI45WtnYSJGl8S9tWF4Wr4G2x+oNVJQk+Nl4QPARDw/K2ngHEC+9YBmmMS0OosYaAGc8HfokAkSAMO4hebv6p1kjByDUajZXNMAGrtJEyNAQH8nZ0AJHhoIUAeM7Yxxo9iVImtjG9x0GsuYZeTl4iDVj9WYzRCc/yLTc4GEs45+RYBAa/fGAtAgvs2CJu/KAYJzMlTCf4GVaIRR9Fo2RyFoZgOMqDTw26MRpDFijDS4vZ3GwFI8NzaoCiUE4R+N8e/o0o04y0aQdKuvkCjfQI9OzBeXf6Nze8qzM/fXAQgQbYX0BwFoRDmmmyb49+wcBi2WEzUBPosE1i3Gb6aoxgot5VwyMePItf/dhSABGnKXjSCFGYPEpiPhZxFc/xvLB7GKwqZlxQEa4MEJ+0GyBgKQCkMc/P6L3uVaMxRvLoALKenMmiO/4UFxHDUa44ioN9DwkoFWmacwL7tAAm0ACQwFzdddv82E4AE2XrYNScRxTAQ0RPVa47/xuYfJcBwhJpAkZCtCRLct2HWVqBFXs1tNKNB++EI6SELU6OhOf4Tm1+WAdsZyAJFTnOFBM+tiFVqsAOzAOmz5qZ6USjUlDIJR7DRMQNLldAc/2DzS/s8hFCRXgha5qIvgolR5EeukOBeyFEPZAdRZJwWcgH9PmQgweb6WlEosnMIRyiHV1LMFYGf5sYWOghhKEM+IIIpMWdsHgl+CdlpgqiFcqB2SLK5oU4UigydA9k0JysZw2SYMY6bg40+hDAeDdNBTiCDqRyEPJQSmAKFfuqCqAXthjlhIhSKRNO76YUs7cIY8gIhzyRoGyQ4yNNBCOMRCoLzBCi1n8ozQxR61Aax7pAbCKE8ikWyqW31Qqb28QhpQOwoM5RGsYtcIcFJrg5C2NKYSqEsykW6q+xQ6EUfhK1lCsgPxPAoiHInCSGtqV7I1iMewUYQQ0pZUDByhQRH+VoIYUC6ydsJmuSIMih5lBQyQ6F3jRC2IA9ZgiCyuTlFI1cLvZCxS1vjIIls5oOykfgjISQ4y9leCAMSpCFTkEVOfmtP6bfUkBUKPekEKf1IN1UFwkg+/6r/zQSRLeiFrP0EpA9ZyNdd3D+/Pvbn05WpIv1lRhZ5OwhhQIKRkEjaTwWQEQqdaAUpm9j1yhnyg3xBL2SOAQmSIHuuzSo3UHGcjUfudm0XZAZKZoNCZ3pByjkg3eQgc8jKKmfQC9ljQIKZkJEfqJkJ5m8W3i7SpgohH8jZQ6+pZpByT64XUCAFBkAuoOg9AegFA7DVgTxA1SzQAkspk4C0kgEbIAfI21avkW6QwoAES0E/KDsXhwTnUlACw6gzMAO0g7oZoA0WUmYBCRJgB+iG3C30mmsHKUxsFHRuloBiB2gsDAnOpaAIpjFl2xx6lsBUK+isHq0AKYu05jEFAhJUDdAJBhjrtTQDAxbMgW995lBbFBLcSUGbAeYCtIHiytEOkDILV/ckxurhS5MBND8Jgl57QzAibZqBTQA1zlBetS8paDfAZIAOUF81WmIsZRasYBjMk/tGBudioNc2D5DCiAR1hpkAlkktkEfFPqWgFCYBZ5UIsgEMk0E2FaMtRlJ6CY3iir4ZATBKoIeMDoVAr00uIGWcENqLJ0FXdNDuBYzRZTu6/s5lhrf/3/5/+//t/7f/3/5/+//t/7f/3/5/+//t///LFgBWUDggvHIAAPAOA50BKvkE+QQ+bTaZSSQmIqEjFLiQwA2JZ278Tg6SFoKJrX7LL2Z/ZPwf/Qz0oYZ+y3Dr0n9x/JLyh5+UWvpjOf/IAdFj+4/yX9A/YC7jsT28/lp69o1e+fkJ/hf2n+wfhPwy7r92P63+wfzH4H3+N5iXiX5x/vf7Z/e/22+mn+S/u/sl/vXqD/pF/p/7p/gf23+u/oK8wX7jfuv7mP/A/bv3Kf2f1C/6T/xv/N7Y/qm/vJ7Ef9I/53//9d792v//8uX7P/tT///da///7//AB///b46V/qF/RP7f+sn7c/N741+n/4P+9/sH/dvZ38e+kftX5K/3n/te/7nX9D/pvQ3+Sfen+h/kfbl/N/9bwf4Av5Z/YfAn+0vcg2U/aj2BfbP7B38v+96G/of+i/7fuAfyz+yf8z0o/zvhh/Pf9t7AX8d/uP/J/xH+e/bD6ZP5f/nf5T/QfuJ7XPyj/G/+f/VfAJ/If6//5P8X7O33//ND9tv+Z+f///+xP9Xf/d+2H////4iBpgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsA59Gj5uR4NsCxycpUZ7QR2rODCvnXpRHBpwgLAS2F9TYpg5lkUwct6zYBiCR2PFZTeP1SE1yPYhzVawZqnpUM1T0p9uqkPeGXuk64tIit287nvWyRN4Bp5GnL9j22Xx8A091PIxkl7pOuLTjdvKYCwFgK+wQqQab9nP7lF7x7kH7RLDlKCr2pvHTiaRUsFtphQiS+UwFgLAVYz/2YjtyS3C1VQIKHb5KDX058fCi1/bf239t/bf239t/bf239s0jrAiE7qtT5C9m+EdIvP3eyty9ON28pgLD2CpzZON28R+xbH2QYTZONqHE+ey+nisrt+nlq0DGQMZAxkDGQMZAxkDGQMZAvAZTNmFWPIFfUnUpxEs9xwOpJOm3bymAsBet0wFgLAWAdPujxbf1/E27UYUoYpblvI6f8IjzCCchbZjd/IhsZJXG79gvBBXPZmCLyGm4lU9ubu4kiXuk64tPnPNk43byl9v344+8VFj2qVNGDyRTbGEqBgL3Jb2KiyiO6vgCW7DB5zvgFNFiMTvjR/RohofOZar0pR0Ok3EPZg8hJ1xacbt4j3LUF4Gtl9kZDHObq5lqdJH/8CHAhwIcCHAhwIcBtitmXjnGrSCzDl45qjLKgDGAVIl7pOuLYCGnG7eUwFW1QruE7YvVsUhlhQohEsAnJBt+evKiyJWqmMK+UvlMGw9q9NX6ROJOq8wpVi46P41LmInG7eUwFh7BU5snG7eJAZg9nmynDsGZnq75vBRZDJSW/tv7b+2/tv7b+2aZuJTNYTL3SdbHe0Vp0xqXyl8pfKXyh6X8KAenG7eUwFW53tLFteFJslQVaKUaK5Mp3KCwRLWJdaqYqmKpiqYqko/VHXFLawTwlaiN8m446KtU5f5kX2JmGezCPYgmrPioNnOMlTmycbt5PUjENzi+DVtOp5Fpj4IVcl6RLYFZTq6YqmKpiqYbKSRyQ4odF5C/FBFSOq0/FzcsCXymAsBYE8nXFpxu3k9RV3HVxBeeaZM31JCyDQkrAbgzcMvdJ1w5n3ELcprXUStvJ1xap2Ho3ftdvn6yfrJ+sn6yiYwVObJxu3iP2pXoIdTguEvS02HtN6QfeuLqZwEm0HNk43bxFxlzMmo32C+kVIZnDzxfCT6M5A2bhl7pOuWp5snG7eUvt5l1naruN+GUS4ud4QirIl8NJtC6U6qAVIl7pM2TlEiei/p12OMBV5Ha647GMBJHFWj9QU4dAjV4asugPsWnG7eUwFW905/3nezdxC6NDrqqd0Oy5aAtpw1NUHYoktipHsxE43bxB+GpVcKQQbBoESzHublAchArQl6PHEAAC7NQDy3AhwIcCHADlBU5snG7b/au0n25a/2rK+tzA5KxWBJzjn1rdN82PHCPDbT/TiLTDJOvfgtXOpIj+JMBZXrvLXDi047DdtBjXdfOIw3HmKabu/t174AXLnjdaqYqmKpiqC+4tON28pfbpUhyS90aKpKU2Ro6NpH+/fk73efVKEPQg/g64UXLh61UodY+0k+Uz9cIejAgLnNxdISTQDLa8HWyW7/KS+ccEvesDUOy6zEPZhHsQTVnxap5WAsBYCwFWtOXqccFZeJrkqQgOs9Wd+yRtVEeOl4nG7kASOzzmh8GpqD/PQ9x+szQeyVf7XYxEFhzR4QWXs/0LOKcY/VEhsJceKE8kALl825OrpiqYqmKn7zvDL3Sda6Dpcwj87+kqBC8XVQjIpW+aKEr8KDqzY3E90aYTUKIF6ZL5LljTaWRRtmUGqXY+3IYQwP9f8flYqxuKQbx2zVT0Iztc6r8C/h2Yl72SmIjOBkm4h7MI9iCaGzcMvdJ1w97l8qFDuaDcIlnwdJZ61tlQOVvlMBViTLa/3S1tZsIqdgNYS9ssRvLqY0Uc99WxyKXpZVWLAWQ65xeFDA7bKBdbaQv8/ZVygqc2TjeSp1xacbt4jr2Cdw5DI026Y1LZAtz2S1FaICa2+SUggHtXh7VTynt3OqZKju1fWYcPALQDYNTIiVB09HHDI4+i3ZoLyZL3be8cOREkS90nXFrn8MvdJ1xX8f2ppNXAHBzzNpzxVtSZuLnf5gkLhzt8vSNayjtkxBIZtgNPrLiECeApvyV+h77fBiyeKefbo6t8/J1KBHYDbynNtxvGTrPuLTjdvKdjri043byeeoxly/fKf7/N3m2bV+73OeIhe6Tt1e1dAyeA55iLP+Z/HkYeKP1QrtyVbpT96EwXJSKZcaxb3TAOfGkp5P2AfYB9gH2Ak25uGXuk61ehaqC5jUVv55LjXegUy/vjpW9DuzqRGEj0xxu4gXr6pkL8El8pgHNsBYg3cMYG2ZCPeTXejssojumshe6Tri025lKpf2BL4i/zKdNcefTzZOpEvdL4i61IPhb2KwyPVlaWYk6cbtvwBTdVIoO25WhqXyl8pfKXyIuuLTjdvJ6OEIijn3ufQ9FXJtBLXjhO8iXuk9hrpGwQ8APRf8IGp5Xq+nG79iwmgQs03SjaXmb0i41sFKfKXyIuuLTjdvJ6PC1WHWHrbNv8ngkVSlBE84QzreX3j46m/bYDe59fEp1hIlZxUrjmGv1dTi78JLfCLoPR00fYGuiXH+y+P/Xdd/qTBlU9WMvdJ1xaP1ghEJAUGWgh0f8gZ2C3Juy/jCUCtiPNdRgtZ5mPu0mBKKuGXurxNV9K1QLFzwWS8XF6m5N7lXcmwuepqX31I57XTWTPKkS90nXGGeLTjdvKX2tgrXgdHlK05C1mTn8Q4P+XUYr+xxNz+r+4HWieR9XQPoYhELc8zPBK2l5L/GQNGH8qeG5jao5PFMSAY9P4lGJsAXXqF7pOuLYCGnG7eUwDoUFVN4tOLdgpZWGN5Z2nt1yGDVzxgjjadctyG4NtelrH1ibKdjrV07IP+w/XaPB+/HJj6/ZfBzC4vTgacbt5TAnk64tON28Rvw7rd7pOj7reYhwer/8/9sVXoI8+qZK8pMkU3JsBTiCH03o3uEzWfxBtrSujNU4wMWW5ZQ+NxnvlL7gdq2B5nNk43bynY64tON28nrEsrMkLU5ksUqf0SttZyfcBt2DuBtv6pkonYKvzN0iQ8p5ELTBoIwCxR/WWKyWa2LAviQOoE9grVBU5snHJslQVObJxbyObxhe+U2epvor1vVsMYT9nk7DKXDL5rhbQQFgJr0Aknexjz30YQFoW2NMr1tleFeeBgJ8zXpyDlWyxy7i53hmPHbjdvKYCwFW2fZ3lxaQPSgEV7uPtW65YkQdoiC5AWAtriUo1NW2WGEHpkW7b5+IIGpAwb4J5tonqb6L3BNWfFqvSlHQ6RwzNk43bylbXxTC+E/R9uhDjsb4nJwkItz++2XO8Mt45t0SA0HtJMdbJItOYfOGBYwG/UGPzXZ+pWurFjJNxD2YR7EE1WezTyvbymAsBV5f56bTKm3c9gTlskP1upsAjVJMTklWjXml87nEaEfZQv0C4srf6hp4VcZjvFTnpvxpM2uOYIOvmVCDdDksSbEihNYIbqqU6Uo6HSbiHswjpgfCsuLTjdvE/hkiJ5kDGlBJ6lz27d5ZwXxMS2BSU6mXNa6vf+qAuncUeXEbK2TqRL1BAi4eDTw4bggzs6Ecw69+WmAsBYC9bpgLAWAq2GIvxBfCkraHDtcDIlLbZajcGE0cwsA//Bh3UXfbNu3lMA84TZIm0tC+mgO+si/4+oXqW3bMFzVyVBU5swENON28pfbr46+s4w8zEcHtkSiOjrcSYJYjaVshFvFloKcKOQ1ycbr+1lcg7iqiZU9HCHkWJepUTDEKkS90nXKWGXuk64r+CfMIhxAfQSvHB7kMv4udjAV9LFH0Js65QMomKCtFcnULQvcp4Jv/xqQtj558dFAaceMb3kWPeg96D3oPe0O2TjdvKVqSs5gybJVPhk1DBk9WUYQFWgMkx96L0zd2Nu0l3wET7ZOpEvdGyKjX2nPHQpIBBmqVekXl4uZ3JGmz0Xw5t6DNca2ClPN+pzZON235z8CaAWF+XZF4J1M/vtv0bpAzf3VHms2OrffDQoeyeMHcMiAOT4RScDIjU+5HKUKTWaT4ejf+6vgCW7DCwUflMBYCwDobyM4KjhD03c197yQ1r1t+6NMBWHBRGqRG0A6OPtmQZbIQ74+YEPW4Ue9WGNuh5zdZzivaXTFUxVMVP3neGXuk6PNw1d1cTwAAOPETcBVvzbhkMXm/dGZghP9ZKa+LVelKOhZ9i0aZZ+0aBZMTX7rnxar0pR0OkVFpxu3lL7jCCKMfR8v8SYXqVSbLSudECsaho0CeTpKATvE7w7KAjPfcQTVv/////+P+HYQCS+T6qENGb0YaIkH9t/bf239pFSJe6Trh1FctcIe3YUrRMEqwVIEhIZuJaYm6kA/tRSozsuSm5HSbiHswjhF1ZTLf0zdFhnDL4Xlxk1xAreVqpiqYqfvO8MvdJ0dcWsoIeunL9AN+R3nMtV2iVtFrhl7o2AFrsGdfpuCuPAoTytVMVTFUm+lH5jlQ9l8SCL+dV3PdJ1xafOebJxu3k9RQ3M17o0Vux7/hLWcUlycL1t28nndhHi3/TwwebSNbMVawZqpI4NNRU6vdJ0fbraQaImXFpxu5RJfKYCwFW0PlDdvK4FxWyHYS3BhLgttkyTzXuk6Wxh5/7IEN15kDXZm4EOBDgQ4EN7qBKxLozPPYEn3Fpxu3l2kaYCwFgHEzttBU+MBpxaVdMetiRHUJK2f70AJOuHOUBBlSR3Vxacbt5TAV9tyrA88ya9yKAmf0mBE4vlMBYFaRpgLAWAdfYozwkjbjntkvhTm6jEQ7v7ZqVtFKsZ0se9F+ytTKgBAsFjQ0Mg1kJtZHAhwIcCHAhwIb2zXxLZjg1eyijYJeoGkXMrtYVWXoHC+A3DL3SdcP3QYGBJZnz/qATgpEBE3Fm2gseQkzEKOSm5HRP3dTsBwbHoS2MQ6ZgsB6EAaAXPuxdo49/5q1K97+2/tv7b+2/tv7b5zo2kgcQdzt6HZMqBwgt0Z/yLnkcx5o6GwEfo/R+j9E8nXFpxu3it6HubuEEGygX1M/lX5qrgzAny6D99/xtD1+Xu0N09lXpSjhIMPZ6fggIt6Uo6HSbiHswj2IJqz4tV6Umo2hmoLyPf2n4vSTHsxrfye5r7bHBp8pfKXyl8PvzphRTAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYB6OVyTY6W2aFqClWsKhzxuCkb+pg2a0/Wvy1qWSOYWDmlRVZegcL61hVZed2AWwPMjuL5W487q/BAWCGHlzLjGyUFn0a04KvW9L0DhfWsKrLz9UiXuk64tOLzPxLVeXDPu2S4+kSigmUmoA0NoHLZaYCwFgLAWAsBVg4/C7wwhEdXNp9NNUYR4cDLcQLX/Q40wHj9jGJTZON28pgTydcWnG7eUsFKCUevtBRipx52GUIT6PrdQLblBU5snG7eUwFfY84Ms21uvpl8ObI3PIzCqAcP+gpeedX20KBBtSe5JbBSnyl8pfIi64tON28pfi3Fvr2JWkP+9/ffRA12Em/5VIT/1/Qytz/VncVmHB4gdt96UVLrYbwFmzECrw+wsLuRsLKJbQlJtaNOyzt4NL9XaO9L+3dk8vItnoC3grk2nfxNY3lhURYMlQVObJxzLbdvKYCwFfi2ZRlRq8h1/ZeqTEqJf1VPrR8x56nzOxSmH5dGvxKkKgwyfu/fEnyL0flHxkHogjPMG+MNivbzmpd7Br6EhQpCM+0DB7U2qhac6gYXaRv2LXPfBB8g1pkeJSQmEMgUe3hOIr+cCozxzhtKs4KnNk43b21BFMBYCwFfgdvU2NmTl4tzOogOVrTYMU3DGSdrNkRXRGwCIzUE/WWlxIxhCYEgVZvas+4beL77/z67xAKNkKPp10qxL/Y+OgdxQUHqMMANTuO+Vs33sWkQYwwgrtpyuoc0Ih9NkruhfdPcHu1CQcpKTbOqSDEkEkE0oaA/RNWfFqvSlHQ6TcPlgqc2TjdvJ+zqEcDU+c47hkTYu7DTn14qxWOcY3lCfh+wy0B8BKbJnRUl1SSD5V8DzYsQn0MkZArwefgXlHaaOScZR6cG3L2dccgL1yBmBu2bbPmLGxj+dDXa+8Xo8+JzYycRd+rZQrD6GpsgiPm2fIyqjg927rIW2Y3gBD3SdcWnG7cTP5NVq/7NRtxKt83kH9tHM5kR3YdnTQLm9hloEFOei1yfkQoeuMWRCm4pAbsoh5OlFgGNWfmjpnHZLn980dBbH67XUBPx/antwaIkArcQ4afBhRctcr/F5ffqC3Mk4nX6EC12Fs+Q7n/ASGYcw5hzDlvSNMBYCwFgH2df4+Np/lpKRGlPky9LxlWrKxbJ1m1Iv0KFrTi1Y2WIBmq/ZZ9kG+wNWPGGp6Y8bzt5pkwt3LByXoyoxCpeOjowF8wl8Na/+5xvcUWUxGiGdiDTMfWjVJRwEyuISUzmS2d2u6tDH+8JAluwwsHIUEFTmycbt4q2dFApOrVj817SdK0TnyfmE6uVzyCjJxbWoR3nlNcvaR0dg5SCfFXIlFhWC/TK5bgJAzqYHsC5auz13ROPApJsWkk5wl9f7RGevYUWp2VQkxLkuNxgAksA4H2NyEjkm4mr3xf+Wq9KUdDpNw/FBFMBYCwFfi2cUdULO3IABhGHidEPCy/41QYuHN/jxrlGOP5qeB9PK73Nh6YTS4j3jvveQN90h3vdJ7WW8y7/ZWtmaty9cjWPFsuNvpMcjGmx1TeVQ28MltSbHhWFXd3ObBWVoOAr2onFww4rgemeB+ias+LVelKOh0m4Xr/PnVBU5snG7cTP5x/cAX9n+3jVJYXLhsmMPQJtWQSZ/vPPESmdIdIlB7vVcsf8gYwaBsJWF9Iw/bJ2LjSPGChMVPD7fNTXPs6+BGnyED3W1N2s8hH0MUN527JZZArMjzYXJ0sKiniWq9KUdDpNxD2YOBcQVObJxu3CiacpiqFDpjNGF7sY1etYGYGz02l3/laC2PZ+D2miae4vTkQ2y/9wYvWNK4ULjY97Pa17xScZEJuabjM3T8G35ksQY1/6YUeyIFeTbvYR9iIQn8/0/u9ArG/ahEAzXKIq2OEBy57HHfObxGhoA6PCUvGjXLB/NZON28pgL1umAsBYCwFYOTDxXmHc7FAvXx9z33D+Mpiq5oevvDTLwm7Ak8csLPP2dyeD/TOfj+P48Qp7D+MpqmqapqmqbBZ35az0pR0Ok3EPY0zjN1ZON28pgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAWAsBYCwFgLAVidguS2F9awqsvRejvCVqPIMu5Z/dKjm7wkCW7DCwc0qKrL0Xo7LKI7kgrZPcWnG7bwAP7MFgAAAAAAAAAAAAAAAAAAAAAAAGNX+J6I/tZ/X4JPEU//9PZg0iBWZkQyFfH6V1GuuEbAx36WGm9McP0855RX4ZeA+WmedCq1xYr/gmlsKYuG+QUEXw/at61qrMVNBhadCa1s8EWX1P0pq3kAFTxffzx9twbGxu8z6lgxs0FxWQS4fzSVonaAQN/l9z+bXv8IyfpbgOp5OmbhcOf/yFG5RTFlKmLgZwo/EVkOw/h7WVBNXnyGV4YKeish2H8PayoJq8+QyvDBT0VkOw/h7WVBNXnyGVxowioE6URaMdKCZ/ZxITyjrtZmfnNdSmicva3aNRecWWOeiYeIM2a+rpfugPA876Suztkrhppgx7j/r6i69MNPxK617ovftsIBzw9EtB/yY2nOTSFqD4dTWSgvy5tVQjCsVTanqF0AJV4147jabTQSA/DrIu2QL0YqDFX/88qnp9qhaRh2QhgAf1zXkiA145lIWzJQTV58hleGCnorIdh/D2sqCavPkGEcAfCBWmusRM4c1h80eVFEluVMwdbFLOmeyneLwfdv/iB2vAZjKThEo4Hlo4CI7VSrc6/3lm225G9yxG5dPC2A6djjjh2GDBg8Vapb2D9wxRI8FZmwEA/fRUsgq7L7/FUDA2e7b4wQUoD8/9xRFGk5jovhWR6aggQdhZecy/bX8UDT+mDF9sk99WB2BMM+3/NKFbl2sfVVLAS+cUuHKXB74Mv+awG0E0L0tr1qxDDnAAAAAAT+VcV1XZafz2ggE17v0tmHp8Vp6sEsx8k4Cajq2cbklxgOp7aRKyL6g4GJgb7bFbPAw9fSvSHb8EltfJNsatEqEPb9MKxlmneOn1RCcaQqJnziJvfdtSzTJk4+69rertrQp0UFYkaRy0AkI+cli0lcu0Hy9K55S40wTHOQVGX/48a8+BU3bFIGe594inOx94Fk7lbpRdhLw1oZt6fmgDiAAAaJ8WDVN/9USeS+gWgKGy+Fl+W0A4cwLzJUZFNZmo7cIrMvH3dVEq4LttK92AG4ZRmjGokG3I3wGEKgDSsuosRD/MTBKX62MkRTY9lTEtIbm+Ev7DleMGnuefPrY7AIPKCC2oQcxc/81o69aeKLgqB/R6bmQK6gQYXqQXmHlMbT2pK1Y64Ntu2gbbn8AAAD2rMIxeVz+/aEhaU9E/vYtah9sBh+5BRX59hlNPbd266RWRLK23hz8XMi9vYWsgR9ffBd6voHV6I5Bnue6Bp1xSnSiYo5NmPQB7zHDBhG4MvHS9x8DtX4SlF0y/5rfsX8nIpcFpJlsp2y3fe5Pjsdv/fx5sn8Ny12nAH9wEszuBDeVG2XHW3ral3qkJ9/t1+tI36LBEsB7RDj9Fcuine0BkDBZFHt/9cpd6SfvuSK6vHgdgQW51YMJcoJjV2xyULGGtJVvRuu9BrVfwVobFEg9OHtE8zdXfRM09F5MhUmtVwmMYLUW/w+DwU1uVxz0Qnkhwv9f7AAAJTmqTh6/0yJPV9zu8lParxDyu5qvjNtmaw3ZNTwr84+Fc6zaXyAfWUQvZN1cDfP8P302L8S3iuxsNbaODeel9rhRdflU404ep3gRqRVPWzIQuEQ4ehAi95BdqdNM219amuF7CB5xahBim68WLrBK9OpZsLv+gr0AAAQWwrNhFw5oMYUNx+dgaG0Q+45WwguyLWaZqybu9mpW3qBbHKCp9jRF9LgMxinBNVhXbJ796Vk3FSmOxl3fgNtqxl/KPd+z1MXX/BMa653+71yGL3XVXrxh45C4okWShp44NJ9Zo2xRMI17zV93mr7vNX3eb9xVWvm/ZecMHqmgGDQiRXhMqCuHqWThRLe7mOnZS2PXlbrU97SahlhNy0BOATnvexpvMan+7Y05fUOBRFOHWl80dMtlEPcHw4X4TXNSDgzUeD1AS0GD3dE/sjUdw3wCLbETL9usDiG5ShVNh1E0tj4knu6CiSe7oKJJ7pwDG5rimnwebPh06ak94IVlWZMwwGrvyJxYMjUpRcYWqgkN9Oa/lNZorbzVbmUu1QiPruhMzNVdfmCshhn4SO70IMQWQYfn3f/KUpkIza7kgWwjbhiIeAPzARPTBE9MET00voR1Wnq6LuJzuglmmHy5D6VTIzRobf0JCc/0f26+SxWH4UQRJmLHj3sLeXJ9OZujiWFojXLB9ikCHpj23IILNNxF0eUHe9xF/VaxuyjPUKcCrCJUaigcUZE+vMajiKSpAcams8pKkBxqaysAjzkdPtHOyyjTSb6MKgmSrd40K58nbNBM6pYVQzInZ0B49GGFUwn3M8lBbctfauIuqBickgI6duDblny6tadZBGrLjNdHTWValOMWzWh+97A8y3wBpeBV10AhfuJI6xmXDXr0AAOYl97SIvvaRF/lHlQjvLF1PfHWQvqBoQoVvV8+MlQ1WklCe1F40YUojI7OlKUpgBvBSo2vnuB+5rDAL7JaOdeP+f8T5Ali3FNqyYzqNRYiUwoJXU8D+zuKXlskDtNmBfttNpS5KEFV1oZFdigtFjm93GaCAieZ0HTHK4zgtrQC9kJWidkxoQgeoQadbAHYEGSz2VpJ/8epN55y/3z6MJHPk82V8WrDLIVBY92+g9JTUzv5c8w4kkE52uGtue+vjqmr6dpxwmghEjEPdo66iXv7wwCXxs8tJ4sldk3GOXpFzpPwA1pQ+E0ma8QIB2PzMLO+iQ9fhxnGSPDvrxYdN0OzPPUCEImY6Wmj/dW9kuVLWQcD8FHNSb9y9o65YWUiaUqQq8qlmmrsKJGkf1DAyEt0pQBtMM8oR8A+xtkXd9GYWNO2epbVjeNbwy0UU8ssa3hloop5ZY1vDK9jgFXkttceJTyRvxFBRoXNPqgbbHuLb6WbRnorOCog5f8Ypca8bJf0bt+kEaFBPtgKvDGXV5ftwjJZltYInUl4/J/Z29q5JGdL3KZKImSs7/iveABMLJgO8sXXeTZq1Eroh+3b5Rn3881DW/GP9B9MKuj0AzuY70K7m7/KhP7vIDy+hIPjbs2qWbv61X23I2L7/7Xz2drZm6L26Y1Nzq3s/LNhbYK+ITnK3Tgu/2MnDlhNOHLCacOUo3AYhcpOxODBka/PZ6L+lTb44C4OA3pADshoWwp47gc0kAk0rT4AEnhW/xkqUOVJ4kZV0XGN/QLBThSOKHEyXjw3q8/PSAU1blKuPkWqA+KfNRi8H0G5atIbJAXTNMMH0GBm+BgTggCGNjUTRvj6migyGm9/w60wwJN5au/2js2fZFUYDaKLXwf/T1PayIEgxyuBFV89kYAMDT1y7W5g5C6B7py9/5t/ssHlcxlUU4RMEJAAX4PRnn7PQLtRNw/04G7Zg4FhXBsC1Z6BYwqyigLAAGm0ArwSDYyEnGWBi5LL5XPacOgiPCv+6TwEPNBf9EyF5ZKM6jytfz8IDspSV9atTAfC9l2OqBMqNv1Q1X/dwEY6bUs0kbVzboQBufmxRZNxoAxEFXvtGRqJ0hvJLmlgzrr5CA6wNwG4DcBuA3AbgN19SKaXOrSGt4+43ACmjye3+wEd1+I8iEw2ISfQV8oPAMfg67x05Le8kL2k1FUBou2Jw5/qUhKjesQUMYrfobmekpWSiq+VHRPGwq99APgvwR/Jq66D80jJH/Eom1LiHkIHjyFsBxNum0esgF14Envv7T5sBlMqZTxe8znYlwZs/iJGd+6eU8GM4nuTNYZ1t/7MB+RYPuf7xzbdPDRXwCXjjyvkijVDhkN/yVVgT1LCCXixQQIZQR055bP2/4PXlHI82SQWe88d421BpoAAVixiEJ0qfYeGU9d+fv/gS4p24pCZ+2C339wT+8uGzj9MQUYm3+urcS9lNSyGtw6pxaVd2KcOChArxGLnf5Ruqpm1WwRFAaSvi0HsidW0lUR0UrNOFWO8C5qkrSdP2g3KWdAAAChNpHTEaL5SucH2KP3MJyXq5Vm0JVjY5+abbkRIQsSDiSXxGo1wRGVDUG0CIlYCa6Booc6jtjO44LHWLhmHrbM9tBFP/KPqCm167qyewVMadUsv1rpLNaF/ucuDXBrg1wa4NbdzVJw/KkRWX0AMZpCuXcrbOq0x1BlXyBHR2H6kzu8VUniCixpf/nj/1lIZrD7QyUOGisHvgOX/V/m/n+2tbgjnkX7uOG5caFCdGWNA0W9U3Hg8FOu0vaQazhH7i1kwrjY7uYJMrdfAAAPCQ3omnInjdNv01+pdFDq3B+74zg2dUU+TcHh8ZCU9pIQSCEAmMvxEyE9FtMJolpbLBo/bjk+hLhx+CWzSslTcP/DyABmD7ZBqBQg+UVH/MPIKTY5n0JexxZoInwZ14LRCpJ5SnKN3/hKdyAVUSkCR1EZwjGHoa7BBHQXtFi3RmLFxBtbukJh2uK4Q+qMFg4vcHloQMjvr3vTUUxo3CuWHnp7fVKVDJgRckiN9xWLyiHm4fPJk/S/H0ZMilC6E5KByUD+78MX9SZO+IRv0lsjXuy2wk4dlTmIfCj1N4nPDH/wqpkzHlUzdk1KalNSmpTUpqaDxgQJLEndgR4AphrNQaGPpSeCXmKeGRdWM5LoEIW6c306clz8lU71tsvvfWIUeNOWPugGD0FDYOJVWeF7WwhGq2g5K3NBDq1D3N3NPvWICD8RlWP8b2SU23DFq/dDJYoK+kU5Km9yDHZIKTqcmggWd0VrUZBBTxtMaGw8t0lIaidlI9/FUdtE/TvHoNwiyiOwwEYnXFJuvrcLG89IIFrV70al3Z3BWAT0s+i/NUYtgqohZ/JNYkeL2QriswxKQsBoJ+KWrThlKwTQ991a5ZJAxydDpEqOIs5LLFN5JWWulhvMLQ9DTSaV9+xRq2R4TGQCTlEjNrAKS67SwhpXJ8spozwgkJbmyJA0FPwJkj9LAvMqRtI+Qn/y9/q7G8wJ2H+3n1FXZa8BjgcGqoL5mUPRw04F9Xp3W1VeSS9rJqclUCky2nLtoG2WWUcJ6cErlWc68R8fa2Z/nx0O0fbyFC+ORyWuQ8BL7gtd6VOWcn+AOyOTjx0VFUpc45WH0pKSPVYHPl69tgic13qM6hmdUPubORMdZ0QufrVJIK5qNP9u+lwFXJH7twFu+u26J2dddYZsWBPBmj1ExmWRytHsuDffgLG1feTFcIBXmyisrQ7T97Z9KfQEjM9+C0h5qDFWfH8daLfmxJWGREBEGw8z+HrDyyd3TupDTFQa3b4IQezXf8XVAHc1PDHGiyPnobz2XElE3YfBm6V4itLYwuVE/MBfy7E1jpBaMbmb7N64gDtn+qshFmjMQDaEPxKHAcOdnZzDkL6z5UoHI4aU44ipW9LMPyZn+eaLmdAmGO76gMNPvHLfA8IapTyYcqBFZKnKal/iRXeRgBLLdPO0OUJA7b3EilWrhK3F/JHG9B8ZRE93+AL2k1TSwQ9mNUm0/8A0o9cuPNQdrg4By1qHvBUMm5TbB35R+Lw+tE/KlXRoXouBF0NhFlS6z+NwVa8KRT6EpRpFPF+DsigFWRKPmEpPHcbMcGcGEoxoVSbJhvqel+G+p6X4Z8A3XlvpJ+sHLdoPa0HJ7WVvvzCqHIXX5Pm/5/XfitR+UaOEAlfcKy81DQ4mwiFQbnQQsdT4s5tiyZ88G2i4tqhntHXzL50A1FAw5fQW1iHKskBoiycyBOo8R2slHw4JWlTC+5LcBSJRE3Bmvb+ob5nTJmjlBQ/TqTgfEn5KAfY0QCXplw9Lit5S6blrVMqcPZf9JL2D8KAxZY8RxspPwDTjfh2bAWiwPQBkN/i1uL6cLkvAbivhJxNW8XPfQgnlLDoPs0kLczSKhiykdq+BbG7Pph5COBogps/eWNmzFpPqlfNpl2NyL6ijXpnEPZUWMb3yMF3UROzhL/WRnJGq5cBB6cV9YZ57GJRxGeDd3zypFkuDTeGOf0NvUj3vUFRqqSfBby7bQtQ4E+rEr5mPhfMuxhs5D/2eLZnMAFzAgzkll4EFXKLh2dXyGZVQ4ooYNZ4cYXV1Qj/ns2vz6vIV9msykPab/KQ9pv8r+/wCr3Oe3YJqJ16pDoB9GEFdwFjs/M0owrUpESNUvD3dWoXz47NtRP7iuleIPTQV0ldXkrYtAOuMdGskWxxA5EWQFe35jxTAm55uPnB/9J9xUQvt4bPNpXIi+beMqzmDL6gyVMllq79T95dxkfIvJEy0i4v51OYMSH3MVeWZ7HcgcOj8RSBSKehlu0DQWRui/RIsCsUG8Tu1kI6DgHPWTu5cxszUPOSJUhVpENReon/mU1IrHiijTLjJu5aaQYWpT2o8obTZoTSaUA/8vP+kHbUG8V85hbRzcOwAnvpsFXQMUjbzDdWIzVrpe2pjMZCx2h9lrmfLCiuy8SqPghn3mHMukyxMyCQypgN5SaiatHEDN1XJIIPiFMUKqRqKP+Q0n7XpeiLjXg7tZeSvDL/TSzSeOMu7MxO7kVkQ+yuL6v06ksiehYpcCmhOvPsB+xs6yXXiX5dmc8PnngsRxy4DwC+E7HZQ22UuhAj3uzdIO/+Yj1ki0gWaOYEb/5iPWSLSBZo5gRwBhuv8C4BdB9oDRECt+fRNacfROF4VnLGQ8M4HqO1o2KvSQzHK3z8h3jTG3rtKO53F5J6H/GLIUNIFEJTliUTRmfIybiWo0Vl8rAzlu1XwRaHwjt27ePAMqOgFmsMpTdRaIBLDLqDWX5+sVN+jfFX/r/qXGYeceJFA5kNYduzmHFxS1STQ8fYOFU7Gu7oqwTic82f4ufrTiur+f3e4LRjFLr3k6jHLez9t2vMlIaP34IlLu8W8aiyWwC7FDWVHKiPrhWS+BmZKij1Rdd7UvvQzyoylMa759AtQlfSs/x15gxUxIeUuzkubQ21xXlQKolM+QGB3zjZzLOxwannB3cMn5U+B3OaGz/LTMfQKMXYCU783DhsUtDJyWApkci7YSBNruXvAifNNrqyMVeVFS8Xw405+F1ifKfB2dXLjjj1rvFKUJlYt8U/y+zKiiPLHIYdYfhZkU+0OuRboJa37cweYtgpah1ONb7KBE4KMUOkmg9CgPmjED/fW25rbunQLzJOm1OhWa0VLOIi2cKgJGWM0AAVfZEAGBiy4T5tY+kOGGjT0DY58FP7+Ix6/H4+u4kSSHwVeqZ9ugqSTLxUqMdm/CAQJN08Tj6HWfC4/TfXEy3+18WmYyCeIo9MGwl3DKGW3YEGQKRlTXts4+pdq1t10lrE+o22K08zDQUGs3In3JoKK6ysAjtywq3dNwRvnj9ch6jCPqx0K0oFDDlcNjrFxDJh55zVL6eI+n/9o5edzq/b7MFKwr3Dwws0A7S3TR09qbbd01GJJ81MF+m84bGWPpSZ2VI0Wds3uRo/D76WwAPAb/wCMS5gXM0aSkfS2PoKi4zQ/0Wg/ObVLtK4RnfQACe2qUcMbtt4Cfq+fISi0owaQNZxSJOCiKTa5C0znf6o2R5rdiLdix4prnjxWDJwwhFXTAV4ME1zXwvZ2nWHXoZEjj7q0V+XN/hjIin65SzcZQdqXKKiVIFHbS+CMcnHLBpvRQL5XSdCHIaraaare2Xg5xV099+JzLpuCHDq4ExgZNbR0MzUJAW3gc/v/MPn4BotQ0/JpsH+2lvmdmOs0sNskvW+9w1v/1iXI/duCPKRL+1FKTFyvTmIumX0MhwiEPV/SipUNwZdfFiMUPqejKwgIaw6XXAYyJ7tS5OWoanjYOJmLUQTcy2QpsDoNbjimHqTqPGlK03RmfAFf6c3YDDeVUWjW7oOMSbbTYCVOQ+zTScIuMYblLiNXB2BBjRNDRYOI6XpVF14heEF5c3Nwl5o0XuFZd3J3+yImkgXQ74ZOnTXF0dL1U9or1+2cp4yk2XhYCePfXfS7HBRa54wEvXm6euP5labVl33qK/kJO00vTnW9jttU80d52Oh6j9ZbIlS8AOGOknuwchIBztxj+teZjV1bgl/kJAOZO1YN1xf/3cUVq7L0cNTLcHb/ZdbHuYBTMZHH6zdNrdHmSYT0Ga6I24wVXXnSh4mPfFCG68CVmADs7KiNJ2+HPkybTLn1RbvfRdpyG4O2i5i2ovLB4A8AeAPAHgDt8BP1yyTetw+w6i93Yvrkhgy2sxtdZNjDb9tmHP3QjAymvZEH9cdpdhLqOpUSPmN11lzaW6ARWNp7yi9LiER+983okQ3Wf9Oq0EAozCb1Dbg+TOrO21Gkbl/VGJcx261S+KXkk4j0QTnhqOBY04ARbSOc3DBrt1izLstwhfHw8LOqaNsYt7H31coA2OQwN/EPxgdRh++To6OlWKvmVGkacSzSOujnn0C2/COqtVmgQj1DHMfEOHE74IRGLgbmxVdBvUjVmf9g8U71VHN1inHi7j7bmERaUFTa4TFvK9sDBtVa1n/1QP9+CWXMekUpA/cZyYXsMpEnN2A19G+Rfw35J9mSdGKHBVX18W402JvmXbhCefl9elnOy0Xl2GnI7l6esOld4v9GirEu4tGb/lf0cf9A6ha2pDaNzAi8OQ4z3K38Nz6gD9LD8TXBMNzSLfLQYMHn1gkSQkwRlDil6vluSAAAEXNqhOpWJGYwZO6lDUszt3XFbR+fsgOmTkLtK8cd+EhogoLZEnBHSTqJU6DBCL5eluEh9W1J3xNpftV3HOrNcIu73lW0qpVddFzoi2XfaQ1yuTZfxAjYmXj/pS54q82tysPcdZlT2lGebqsenlLdupvO1nJy4bfm8xird7ao0d5afxKt1S91C5sF7ctjqsrj+zlA5Sty36Qc5i4xt19W/rs75x9KWjR8qPUEE7zOfdDNfE4B2qt9qfCkuvA43yfD7VMpbU2MPET06UZFSISwA23GMav8d/8d27ylKvPYBx/9p/0r1HTtvmK/l4v6kkU3QNwfoHJmgWk5n/0nM/+k4IBqnutR/ZIRO489ovICaNk4ixoC8YLWpEZueXpM6m0++0AlOcH3p4spGs3wlc2atXAEiHUAUEFZBq0KDlnZcEdwaV2SXj8omDWJaHPVOkH4+m6IpWdQmxMgHxyuO6oGrU10YE2abDcb5vj+cHs+SW5Pbw6ly8x+E1VLY+xYtQdllYHzGiKHtOCVyEUiTMG6Wy3RgWQtHvhs8X3SEi9kbN5QMb9busARrrdkBaYUd/YU1bjlxAXa9x99ImZY/vU4fJXYPjUFaxZeT3pLfekuH60Ag+1KEw52lPTTAxVeywI8BG4VK9FcfyUl3JQLxEyT2nFb7RgcAikrpdMG+s/3PN+cFUuCynq5HxjHj4LtUAIsMNlvY/ek6dDvAExdVAF6QB+1VdgggK+dbrJasb2tOPUEUt1IaoIJ153R4Sj3M9+jaZ6bC8SiAqB13JO6DoARqgdcRSnRmW3PIYml3Tfw4OmDeJSm7MJioVTfMpzuzAMV45jSo+dKocEDMjoHCLxKE+dlrLQyZRHZtEtDJhCWTI/9DimilirEIHjwaiK+Guf1Kd52mEfAeBwnO49XyDZA2vZbdtUhBBXLKKy6miOMfxY0RKy60fSty+olSb2Rx8JzIcO+YNsjNNOgPBQwOe9glhTURDS8tN4Uw7R+1UCNfwU3E5nUZzVojf44IxWE+dOG+2GDyZC1KTbCPCZplVGa7ON+Oum5o9XkH+GVPOEcmwVBVp04YtsRwJfGztP9F5zvS9wMZ+4D3A4DuEavvEc/o/IhAu+qXgZhCWJEUUzOvbw7zxzHqeemdPbM6jhCHv++R6f7N1shueT/KG0u+xQ7QbGmQeUUvOYilS85TgQqQDXyNuEvbk8dIyVdZEwa5UGPS4qewaEuxa0wDv0S0ZzKjyBoOQU1oY1gtQvgT6Kqy8UeOoLWI7Acx2Zx5rKYm9cAtw9NCLZj91AqUrTtDVrjTBoOCb3EEzCqwuK6KbZBYOHlMgMehJdTWG1HfikcPgzyNxIdv8Jo+6iOgTCEOK0t+vzRIpEkyknYEANOu7RWezOEYxY/sfj9WMshth3l8ptjL0RIzDtuf1lTCk9prFaGdHBFI9eONNsVLn24VLOF0M9t5aszVhMttnYTn2qs6GhOMSmjZ6P5m0Nj5BupEtXxJpqDaoEJwXIzO/UiMK/gxJVZNuiFDbYQDypTAaS/gNAuHxy2K9WIu0A125ARyqUiczka4NfccCDwImwKOCinH9O4NE5LA69U60Da0JJPPx3/pds03o+lV5wk9VqvwGVSymZrEE4Ar+WhApyx/SvtoMk93gx8k4y1HAR4rgRwalGSPNs+pQN//lB5Uxf9gaJk5aNxpH7ovMGV/g87YPzHeDS+8LYoaRNONwkkpKGoQYVNZoNRFWnXtNuVUjLY/EAUA5yFA9GP/cxDYVw2YwHKppIqMkAij38tJsRgsZNn1w8MZdcIR611NKSnywkqmT4+C3sOrlW3uhSLIY7OQ7gtiauxS7F6Wb63cIB+2H/Fp7GdoF4yS5lkU5kdc8C1MPTEUPpOqKsTlOCLiXdFTArQ1wh4BnxsvuARysBqgKWo0BT0daeZ9JQFHz11C/df2YVo9/UlKOZr71OM1z0EUdTQAQ5lgpI2jSuYZEWrClF70P9s7+X0MEvOx82x+ctpWCwAISHUR4W+bM08fMZ43m7LPCcvaeSisbOdvYfqAvLeiMce0Oj7rSpSqaGgSwGufyjtgCWDSAkbJ28irI7cOaMOQfgBqeIsOpyYE2XvQK/T1RPygPJB7pjijvCBsahNs/VBHm87crUBJwwOqFX8Tg6nyWas2DZ8BD6zf5KkVcYKZq3LE51VNrQmc7IxnuFpNgaRM/nH3qK/ewqjsIGE2FKWBEP8T7ml5x36BnkV8X7MjZO1hKULu6hyMqfZtEwCsgftJVeHFqfIbuGv/6bMEPvv8On/wI9rHo0Hc78HaaC2y1rf4rY9p0QSlvUlrDu2kIRAgBjn6nXDF4ByKoy5jq+4vyCOFRmUc0U3h7tHfngT0Sa5Ohm65SnYTE9qtFhIFYQE+yQ5vcB+vQ9Zv5GAlZ8Due+j45KWc6CsRJcHDDdnM++G0ViQvRCSBWJwl1Cl0L7C1D36bFdrfi+tuWkPImY4axwxSZL9SCegrwh3WvVoXm5DHF9rplYrotOJA98ioLoeC5qyckUHdaW3yLTc3Vo+1AM+qJuq7JpjyVmlGu/izj0d3aBPfzUth4k21rTIXUzbT79pAWE8/IdM/xC3ODDjI2mnlehxa+hme+d5R8+UWzHJ/EQNMfPb3nCi6/HhnjXuHNYR+RoY2e/QgXuGhHwpSEzpVCXNvJbcLg6850SLqOzPmUkTmdR1US6/8P9L8bKca29IDoYFrOG20LRanFMZh7bpZwq/q1oLOIC2kYHBmn/fLeZfe22mhSFbXHpgsFGkuDRwDdbqvjHAsyvT2fOW3NrSWafIlsGcTuG2tb3fmjLSqodK0co6MktoYedO+ZEpXdS2zEvVrCLYR6wkjiDPpomoBuQbydCY7a6REKjIqM9Yy4Bl2NunHUSuO0wY66VNmQq3MbyDbz9IG+YRu4Eu4SCTdKJT4caFnO0+lkPkjxmNAX0Y7DXmA0NZRA9GjHIweXeb1DAhUfs7dyw2ItuqeJIDP07Z5p2wIy9auuYsa/SWP99yZ6KAIS28DWr3HNjTFIVbWalmrbIUUIdVXfV6f8AZKsHWhjKyNEvijHCS5zpbX9mGnZOXYFzzkYaqcotUs0GgV8q+VfKvlXyr4WvgniEmALc12f1v/DpCIuSoTcPbclen/kpfagctdVGlFkcNMXDV06ZWUfB8Uk66ZAPsRgmr1HBzrLPse1TjKUdnd0ejYehn52KgeifUGgG8sl+n9T5vQl53mg9os368QA7GV04O0bDCb801sF8ouYLUjH23B4XI/oOeng2fjRoLtZpFaotbbiYJGPxRNui/3H80+U4yyK+9x2J56RhU8HkVuyBrOgz1MGshsArtBaET5B1C5W4Y63ks0Y/KIW1CVRzJNxhY4kT65h6b/1ZA8wI5DlATWFadSm7hG9s4EYgi41M4skmvwhLjnwnT2Ua8ZrDC5gqU4w6zGkZimDtJSZNznTgh1pf67oQBoCnCniLAa/R8Mftg7h4qsi+j4Y/P/ALSCwzqxbPKjaUNb19HzNPn7aAs5YiEQOmjHg/HgSv2YX+pJSE9YobKCxBfbjXurLs0Y9bCPExLvNhvTFGBa7aEvoP11GJzXA7iHCOYDud4nxx/is+jA3T6BJxFQ0qzV8oAAh9kx4NRGA7PKVheoQttdcsN/q/cMmxtGWUXBRpE0rLofsnEDM1jo/AU/eFYGq3/qCpdldU1Pf3tNvo38kNRujxYcJiO0GM5wRSvqdgU1g3Ev1UxZ238Cqg3zMs99BgYKGGKw9D56/epodyS1UilmlQq7v3reMZLnIm0TP8/AXWDWLQOmAsjpmq9yDD0ZXd6usQP4e+1pC+tCUB/Et5csalLAL//wqXUdARi/Ve2CSVq82tv4fOZCAYXlZ81jmMOjC2NrkPQhay6QwBYZXPMzCOQOcasYnlQY0eZ2cHSmZ3/An2iRYbjh+R3JsDYtjVaRo+oyRWzGvoaUivxkyQg1RXPVp/dQKszdWhFY2BuLhSmrnwf6IchjbPDOEKaH9Btli6oH9fubuei8KPjt6R7HJuqHu2gFPuv2OHKDq+80prhinYGHW1MTcWbDz/OAUakboLyub8tO8CAh7P6lC7K9R18n+D/3i1SfSVmyRA3AbgNwG84wnHAsSvWI+rtgIsHXLm3Q31OHjGkBQ1rRwiXhOQRlvnZKaGyuCj+BsnR45uY645msKYygtN8mRg9voSIAk9xtXZHMhfkbC5pWKLJ5yh66SaCYydLWhmbGRJaqs0m0hfzGa5A8FgWewquIdsy9j+j1IyR6/cgnhRNn93js271l1Vkr2Bxfo3Fj9wR31WvwzmhP1UKtUEMmE64I+JfF8p9HE79QrmbIlsaa6KdYqgP1GYRdkDiQs7sKdVrZA4vOT84tFmccqm+nSeQS/rfBUR+wYrJZ8LngMt1ybAzHC60jcwF1nkQ/LRpXDfg+L3ferh+UoJJdj3Of3VFhUKvxew0ZBFLQGSRnEO+gCzZT1fJ/xaeyDviVgvRKws8fQFon4bVxXlh9w/KDzUMwRa4kI+zzJLCbcocrn4ArGDmubeh5vNCx2bNXVzlWaGwCxWD/EPPtLyQBP0HwXEZtap6i2GANVXORXLndfRz3VMWgFK2JWMyo5LwXA/oOfIu6ZA+ntwpwUODFJk63b19vo4+04O0L5NBe35/j4gx93qDbUrsw41yDf8Udy3O+GV1LrSvk9idWj2JR/P4veJ0qktexFXqWIDLJeeggggYg+XmCq+3OwXI81kgyQuXrbps75mjMJnMANvazuKJFMaS+ramcjBR76UZKMlGSilJhwPwv639qNN2uN441KLoKX1RaoNHNRGvNC4BOnsTY7sngYZVI0AUq2lf+MVWqgNikTZ/d9OZo+dOAPbtF+I60wO5yp52/u3yPLqxpRKFEW97NRKMC/bm+o7uDNbsg4+JPJ1amoerOJBAblCbyVNmTo0eIS535/qyNv6R/ly6ixVwCJFczZubuhTkgfQtzBP0EtZuE3LpSqEA0rQVaa8um097BR3lac7RkHj1Jg3osyuMF5CHMzyu776ErLm3qBSteHGEUkQC2CIUySPYwd5iwp4jBdr2PtcCjunO7MFxCbt1ulRcNuR0G+nmNrnZPOWpj4A0jAeWeLXC+2UjJMW9nCR3MRqAFmfJqB7oR5B1zYzmZC+aIKAjsG2xLn9B26gUwAAC6GmQQJtlOmBxKOaQd/939oyoGVUmuTbRRzAiTMtTsFZy8RuQ4VXg/oC9a2o4eMkaB/yBNCLXzTsZL41q27gKGzHOQS7O4nnANoOni0iiurND4jRT8SR2Gs3ooWSld28VJYwo5ONY4yDIwguJ85pKJhYbLWyuxc1Qkq51Vt4vvKOirmYoIz/Z1gRMGQOXfVJkFT6WBRiBo6PWV+CNdql9r0NNXXTfOiS9oHlZjxMDQ7dwQrE2ZRGBqKsDFTCLiEYnTTqeQO5YfxlKEDY91n+5r45vhcKN/KgpX92Dmc6QO7DoGLYu283flqP6I48WbA+BBt8FY0RQ5tdWcWMWBKiz4Xqmtuh/SlRqfENcl7j0s5jiQskfFqsCLQwTM4wIrF6OwdqUIAAFh/qtHvtS4X/erboyfP4rH8yjVHsMkwBSeS1JJhyZnHReC7ExA1mHMrJ1V3AFI/XPTzXUH/mwY+A4ABr1lQw0YOwULv4gdGaQd2NLFAZh4WCKwlLZ35hxwO7KsUKpweIXntAUUMdZHDXJD9V93Lzyij8IadgTYu/mQ6qayfN4gmzYGCcZwf7gI5nLxgbUS1Rd68cKFA/RtRcNPjE11NRLO6dyfuQ4Pzke8l4JrNGrVyOWJkVpVt+0uzj+wXxB1vyrLxxCwRWMZNfcrNiU/Z2uTXshVZDAHLcJeAVv6yjj1Mfx5+T1p0lZIlYsmcxIg/q5gBNpXH19XIpZ3D+ykqgUu0+E00VJphw6Kc8NMJl0BeDcwKWZla/mqdx4e/N4AvMGXjgvarDefdqoAdrA+oopqIXkHoM858js2EOb8YtJnAr1yNqTbKys7gOTuf+P9IGpsY9gi42F0SweZn5IQn1bdRfku8bQqAgmHEXhh+xBHSUfHXquqBdWD3q1EE1VfJX9zODeJa6kq1hHAa2ZTNtonGcJT11yykB3li7UwSN5ZeazOS/jUT5ptO0NC6QRTbVF+pAovB/EKNH4uLRQv5rm4CQ3psYbejIbVgcfWiRwHi6s5d5DoikAqLDYKEF/loCSUWbPlOzj/IlKiATD/RTBW+jjNKxYjE8JBg74fTzGkxtzhSWeKPNhs4U+Kal/3mM8HowPO0t76C9INPBiExjnLrA22NUhdEPWuh6sq5D7arUVa3Z+odumAP/nalar/k9ZWftJHy5yBxWwRu+a0o1hmS02qAIjMCQINuxx949lAjzl6ugEt8vaA1S9lfktdbVPbQtoW0LaFtB24G7VjTJapUU4xORQI+iOagqrioO77Qto1tn9kq5+EtEixNvd6cRj7R7mh5V823C3tM8NL84CLxzHrfJPunHE2lY/QYBW9uZsamyEtH0TcmV6je0PYqw1OHhd4LNeQy6DtgFl4Yy9iQhrUyhHimk1o7G5pz8UeCoE/mtJRB58LPJ6lZLcMBPa8ub3FN1tmulNMZxuCSTM5Yqs9PclHvxwdov+clWHTVXRk4xRbcGrD9rsik0XFbjEu063/efmeWsuHI5DWLBFZD5JMsgNfNciAuKY1AHbaKNlN1tuI6iF/z4+r1dCSjxFzFHos4+6KMdGDIHLSmQxuUHrpMxBuaPZCrmTjDNDU3mrdLi9GbEaqlNtH3T7tAf/pjbPxzAJrHuSkdocOAOLE8ApleelesJk/1bMnTp8VBucvTqFxy9mC1tZBPxI9fgLeieFfN9Hloa8aY+a1ENgub4cVicDAmOpnGp0+xLxb1N0KuL84AynA5P/WnqRIhpdarDkt5pB9XgKAJ2HE1TRCqVRIAAKJulYgvoaCjdMsJK7mDUOpCZPvrQ7CnpZSrbRtZpJO3hDLYx/amR8Zn2OdG6QHG8ZfKWFQIbDYGb6aJ6kIpuPEWBmAo8KySPP2HvqAZ9p6lO8nWWId2+n2SzRxAsBi+H+gx8qpDgAV85Ofocd8Z+hAfikhIU4LHhe4DUsL7xfzB3KcLHu6WHXW+CMPw56hvbrPsWzN7+/DJLnKpKnOzupIEzicaq2KrQl8AQ0WMdurGRIpR/AWknp6wnBr2xTl1agm6CRh0oIFuDaHJLMGIP3DKM/iAj1KVsdeD5Th4AG5WildTgICo18y5HsPKMCCrCh/n4YkRLS1IN6vQ/U1X2hIF2VZMCwLjAVcexaCBQCoiyrZPBAXggLwQF6MAQwYADpaZd1r4/UxTFdcO20Zb0X9SktH99AUVx/EFRFBxu3+asAmMXXcxdb0CX2PYOEQComOQGtMGeFJTyMsld2LIfGeacpfAAUN2vSY+GoW40GuONv4phyvUplLgNTyxyCiNTShl+4nf12i7sbovNPhjo2phxOiMquyyFRKsTp60Ka7YrSfF3VH4414Fa4vdOpJKKXdCnHkA+WC8O8hoQ7+GGMlhs2vZVHD7ZJTCOiiOAtSmtPObtSObfyjGpmiiEJUMs7iSqQYsqQwjrvZToMDH1d3dnn+yBYLDy9a9mP5AdbvfwMVFNAQCwzDrZFN1Hwmdkc87I552R8T+Bm6QH9sR9dNT7DUkE70g4iV9Isug0RqnCLg+MlPUZoEaVYbR2mkTW7nGYvOycHdIQDNGSzqXA3Y53yB2piseeckCUM43vsGFb2pmaEIvhRL/QaCRaroXFpwBMxQBO6Os4RGdgu2neS26xfwssYdI2yGHaMLCuvTN/o3t+foLARpWasPOqzu34cZFVRW95pb28bLRfi60L9obVpj8z0rnqcYqDuJhrE9HgFOQpVBTvB/dv/+qBwlGelEwAhREzU4gfUIfPKU7zv3JncFQACVLHlU0/zKAqWYK3R/Vrg5iObk6yknP3/Mg1X1tnRMxf01JcVgj6BDGfXae06/Rs14mqQ4mXIw4FDjHpvo8sAalcus8skmHLAqmYL0xexySimAzwjr04LitcFwyjEuU26gm8BmAzE3uZ4VENg3quqXDOqBFpNnCIJP6XAnQfMWq68s+i5FnX9MVbtJ8XczoZNoS9qrjwydKKNa5/x7twEslg2XrIBhnA+t3wOoRyR7wtHfd9dG3n4XHm6WStZy/9G8g2sScQydg9y9E6zlJiimVghwsrdk8sJE/WMS3gtz2/oEj4QqQlF2/Hf3u8HNk7YVnUmJYAdYuC58xwT/fQj1r7ENfEuusIh+drF3aqa4iR9O2iGOxVRSQLdCb/g/pFtHb1X6Ykd1wsN9j4qHa0nTFiH9tycvQN4xKUftg0BrEBHHN8tFzPSSQR63jWJlJyRCE4IZSPgFNxVODiLUqbTXalexrW0QNGUNv76RxQCs9tXTFjipO2lDEvG+Fb8Clfvq/MBfD4KMCA/7ERANaD8Wy45vidg3oeHBTZZGOXGJadH/XWwo2+a2x+t3hQLNFnSC/m71pJlWyv7QcqHsMoknu6CjUgbJaZ2ovQ1uz+4UKcUMCxWR22V7Y3JNW5WipR2R/c7cNQmEGpIdWcyIVIGySARYOeSGKSENBXO4Ab3hJxUm0mtLyCiv5JIyxZZ6ZEFofan0r2ZwpELpeI4KwQQYGfz83xzo39ftQ4tAdtTbnvvJeLYcp9JFyVZkRqrjaXTUU+1qoMl1mK3qgaH7LvayhixwbikE/K34UKe1pEadCsaeaS8rvv33haWL5AIt3DlTHphBO3jAt5B3hY1L0+pmqo6KiMG5Ku5x7uSV7eTFRQYZi7GWF+62j2CPAP+PCUX90Kv1/hgfhf40uJH2qFbjHUGHC7CzGELMYQsxg6Tsn2bxDRFjYnavQviAaFek7E1zPZ9kg36CudvLXGhPnYuE+3+pLjAAAACAiv0aXTPdif3KQ8QpWffLHDRy20AVG1B+S0ugH6oDwDvsQglovvwGiggiXdFimxpI6xakS1ChqA7YEVHJ//aEAILl7De8hnjj4HejcAKWVeW2O5nFs9fMH7zaE34ZOC+ajx1/ZT+2G0JkM2M/qpmmqiATEK1ZZS1fcOs5g3DmLZW8G9EBj60lmd6Bqjv08g8MBRk7L+IyLzeP1HcXdW30MGgqHhT88i+FBFqS4YaRjj7UaVZz2eJ2poiYJ8NkGFp8FdEoOMs5Q2biqCecQzxp9NR/OkVerf6pqPCCCKdEq8FYupMaMclRFzIewHCqAAA1dR4Dq2DMdK8glKVD0XV4aq12MTH//YGUymuq72ZX2C2lMt2ZajFYPHUG2s4hCaW7aZwkCOiEM0XifFaOBPml6nWqU8yC5KKDhLgBEPMQaDssYr69YYTmGk8EkJEDpTUSJXq/4/TaMboXT3/ygvL7xdSIJIhjKVCfnNwHMENpEGXf5Zq2L2Vo/cSy5Zkl2iBhdI2CBRC2fkxYN/w5jJ/rdHPjsiet2Xi+nKbAC9jpmLbVuB4JVo8hOvQxt0HWcKvUpStnf35GAAjpZF0WuYK2nDBkGYhQbG681kzIc2jCwLkP5CneW4zpIlhfRHl/+HoYf7pkbZuRZbwQ2ACt4AAd2q6dvWFGdi2dbln96tQUdatf+zk9ZpGQQPSvvzyvH7p8JIGYOs5+1m4JQgisO53cxOSN7Avw8aXf3jk9LPO5qE2OURu86Yxlr6kM9TDnTd0WPHbOmP3kWA/Mg1qqeT96+/fYZNK9zx2ghSZs0n+z8P7pOVfJUiriUT795xHPWGO/LO2nTVcFGJsKQpVA4nS3zDjTYB1opaqiFyJVy2G6WQMWNfkdwanRPmCsU41emHXAWfMNGdv/wDyYWpAFfPHW1zdxcXw034KLDgrjcvZSjQ7NcBD48UfA+XEzhmqOwXwefQWdp4pLDh2REvE9lYkGKokgAWN0jdCybuyVu1eCk7WVdnYGbILnfNLUPGWhBHmXBLdu5ArFHvNS4ln80aMGq7GVJ4GzpuKEvMxwuwvympg3gYnHMkmOD2ax07E4QMYEjRjG5lSGr/6lEV2AAAySE2eVuMUElPprDutKRBu0JcrGLwcEZPfAFEickQ8bSGOu215+l0SFOMmRnboME4+kcMriresJUPu2/0lhr8FNTl8FxEz1vCOo2TWG11Bz0OiiZgXcpFu2ThqqINqIIsg2uDmz09vyTCqOoRa30CDmfn7l3DEOGHwKqbUd6JW9IPKrOgWYitUjZ6tzEe3AFRDVJ/S78o3WTBBBZ+uhdw32LZ3ehVrDt/oSEiBi2LrH9VPfSpBIrWv8rO8mvwKCv3rqNrjYdQh9cPb0tY6g3qBWbww9NgtN+t4eBNEww5mhSlNYrCzeyIOgVK1/cKcrP/j8W9SdzVCw5SLobPR7EjN6uVxgYIb0vlPy7J/7A8yA+Qz6CeaB1JF3T58GQGqUquBbuMAkVtWLdxgEitqxbuMAkVtWLdxgEitqxfAsHwaIV1wioQtTTOY2ST8YF9EC86dYLAN9hEoXZjXXvP9A5mXPQv3nH0rx/ejwDJ9X1N5NTL3FPzuCLy/TpoYC8rJU5g/gqPaQrlumSA1KIkDFLfl4i4CrsgCM3tYS/p/bnPsmVP+yvOWRvCFQHw7CAdhAOwgHYQDsIccOakngPN8/s+2TUVQIc65W9PCuIAZOle0r65Ku2EA0M/JCHKs2vy3+3DPB4TaQj06Hsqifl4BIyu69ggBVlJj8HIxDI9jV56HdHIHIjR7AWrnIB8aHEH15l1zU5qFLhBsNMKoJhMdXQKM5XxSm/iA6m+cbLBmgk056H275iYPrMKotYHUazCQOXDK+3+qNWMbo7OaCLjo2RdJbK6jf//+Gq6tYY9TN+5a+CQ112OtDtKq3hBPvgy3R98cgOAgtqZ26MLSW6JOxlm1rabMPNejQeUxxKQLF5VKFrv2MySCHMuB/I90fRFQEHePcJ5fRshMvXvE5EX1Gx+NaCW8eJP4di5eWfqJmM9oOBcnA+GH7RrEbh9DtlP2lvUT1o0EzjlGD6nj8xntzKP8NHEu3KCpc8e8EPHJzlbTkpvfJSHLWj+pib5XuhWJlj/VtdTJv9mPLjwBoB7UkqmQZ+3pwxgVN+uOug0AfIAthZiwvB4gC5gaP+KeO8IgGBzyLJxfCo7z+t2zYK+FJmPQ/DqvogvqPGJL6RxJfSOJL6RxJfSOJLv7LraDLFZ6cUzmDqsx0xQhnPktic+eU4Lzg3AZofxwmiQLKlQ1k2Jf5/bSUmbi2bSZh8kr+oWKSvroF9lr+dax+y2lTWDIMLw+L8kTk54e2Mh201eKk4R5jmqGU74eeF8ShJ4BKHNZrFFOKusk+J7W+7Z93u8X4JbZaUr6j+Ccz23JF/lWtZH9rBBWU6qr8xuyuxtZN/ce7h+dB3sGlFNF4CsNM1smcgdbALeoW6U+w5rocsGnAxPbljE02SavWOW+wej0I/ZsznCZbxuxc/p6bal3b2CA+5amZdqCI0CRBf+x6HIb38Tmoz1g7P7POh1Vn0Au0BNTjw81IDyRLKAj/11keuuVjCquKvn8IRoKH6LN/HePI8/jlnqaOQ/8F9EXjdaxRZ6InBitIzCWKSKPbTlKKbcti7boihdTj6izoAAAAAM7IJhuYGXgQZuKt7Zg9ReyptXdcR17s+O7j0shwWxDgOGkPSYOkUrKY4fxC3aOFqwTLLglWBbl5P7h7lx9AsFR7gTbgzo60XsvFSoyg/fDZe0ULdIwrZ2CjUBQUlE/9MQp2cBzdF6LX279p/4Q9MVy3LgGjxDgbHFMauNBG/bD7lae7B8ipH9WvKnj0FO5XMQtoW0LaFtC2ff/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/arv++/hjx5kdmOE9+bjCRisuVYeurXbfrpmJveKSdI4uzvyBEX1otFnQ9cz6SNekyC3DncwGXS48utZ3PfX0gX1LF5Q6vMzSt9XKmrA5+DpfVjiJ/vAYeWVoPzUvynVqQo3FrSEMJnyW+9Jb70lvvSUakACznQDpTjxyd93Ur5B6GJ3+61veO+CsngyamWVJ7jI+vYmkrryiOndqkBtUNfgWh7Wa4sSturEgj5sUECU3uU6D+49QOMwv3PL6gNeAeTN3YGnRE06BS6Q6Zef9F87jf3QmbZOKp/4fgUGQcApUkKpETMgzkR9nonfIWL4atAGFPJujzifmXrsrNIdRoKUfELZbE70KR9yXfWzxU6FKUklnsZ1a9V893WOtV7Cw1TuotNHjmyeft2KGsnQAqDKTdIvcluGSbuFzUaxj0sh3aGe6kzt7B1i1xOQnIKfxUofmGP0BWMlvvSW+9ks/s4AFaTPoaT7h+orbyipmnRY/TiDz1slum8OkyYu8wXQ3J5BWwveBQJLlSMY3BDEIi+gOWdid6Rx4PaaYdSAmKtmDfrMBId6CVA+f3V9j6cUv+HqgHobOTPmQrh5k785gAA+B3beBQPZXS4dADW99FVNj14GS4+b2aywEntcKmZkEbKU2w82r/eQl9xXTl/8FxCKGQhIeL1S4cenjV/MB9cE7cm4kLIZS75f+eI+md/bh+4c+dWkNNvJr4xW/rz07YwiLUOzVRlISI+cQAQ6/ygy7iIvme6gzlI8zX3/T4aldpMDBiay8ZFPi6h9wk/6+L04f1pDeHNW3inIMp5+tNrfTKWm1Srep87V9zsFTxwC57f5/GeCJ9RZpF/IB6YUSGiQ5HYCYo9MKJDRIcjsBMUeXvAAsgT+ohEclBsM9pRiymjkBZ4SEoYG66oezcCFsDeaF4voTy1j/Cyb/PH2tf9fPqK8Xvsp8vz7Zdz9I9lw3FSr93mGrb1aT/YoiPBmRRJPd0FEk93QUST3dBRJPd0OGsameBr/9X4H8oJVJCk0Cmkbw1KwBwjYQEq06gUMy3eVqJKMONA5A4MrODPeVHxmick0X8V8p55h3g2uzzMlSxMI864YeQeB/U+u5zIptVYPVj6/dcwggGosahaYTlT9u/pRRGlun2xfgPMhCdmdEYn01QYECV+GzFTgy2mih9B5ObXXYwr3uQezyn+2h1sCxgn7PYy7zqTuQjjXcNdAUtVJNB9MzH2b/HM8RUo5Er2WNgvOEBjjO6g3hQlwA1/AYntEgfGsh8HDWjOFMXy78g07o8+Six6sTB/+FlV6+LZVVrr1/VLt3sDVBS74Bn1D500wRjLCjyc5GSpEwhX23mPttpeIygSZtVlbeulMNghw2ZzkikAwi5DEPyQ+eHaRGtwhKIFjKIFao0G7bYOsFn2TqZQYME95iUKMX9yFkBwWYACSaPKgtB+S3zp/5hWq6XP2JaVhsmKvD+2fBKxvDzKWM6TAXSvPgjgbDpRmh/LTiM6zT75PylrlgBI8i0jHuO6GhliQvrQO2wgf8ctBG52AnOfiCldRiFggoe06Y5cIu8nW3KeNMCpSFD7RyMIseF5OGMLPpIgTWyUy4V8dvxF0cC90lluqFou7CuIPaSE9BvdyePov3f82hTkFH1ed2lm/X99pulAA7DmZwgEzh66w8eNdwAG2Y8vKaX7dtgOlAxAEULhIY6UBwtXDf5Z+qhHhu7exkq4vnfPDKpZBiaoguOLHhuUfeOQMETrNFuLfYyOhO5maxo7pwjtUTDey29VI5lsa5v6rgts1IJBX79GJqOfnH+VXWzR1cdeZfQR9/nX/OLPnlfsdwZeMxscNMPf9tqy1USOM6jrSdtv9VtybA0P2S4fgjaDiLHaSi6Zx48BHqF78wOFxtYOe17sz6V8JZllNI3guGRZAEyjgdXdew1s63R8tE6gw0RpXsBAUtEWfsntydiGcqaVeJGAe6dv1q7mwz4XUyatAGmFueudXhwBtQ3u+w8EWhrOQpA6CSqBXjfQKLc1jIl/6W20cjywsjHyWZB2m/TkHab9M8ARYmdtroBenTtBSB2oaPKu18/4uR/MhCtvEjiwoHEi2byJHTR9OtyoXNdYUqIJloEfquyLEMxJ5V6jM8MPmiZW/rpwv7R/xOHU+x7OjPsgj+pcQM9lLrPzrN1AlfGeXHr8pNfqikISHc/UgUzxhg0UxSmHEgd5URQrGeFBASFT649hV68vHt7z5Weta4Q8CLnOLgU2SCqkuCyKVfoPilXDoVV7mcLpNsBoCw7NYAKNxS2SsWQyDvACSPpJ0yM+wEl8dGturgPSTqEV6B+R7wzzipDyXphUV1wLcp6EjmF/zw3vBioQS+A6lRaI+ltUJMW12ye5bBiS4iSlS9DbLVviUx9x0aW7DkigiIpmT5XtxOhD+JbKKt/Fi8mKO0Qfp6GuOTwjqinXi5oWUHXqgOTEvFkSLKJatuiQbmn9Dsh1LwNX1DMlvHlqfr1zQtBWsHo0SsI9GRK0himqIzRaAWzYyjaV2E/+sVPNhoW7di3g0yOAN1ykp2zuDy5jbDAwfk5SsvpreHBosjbSlfR1lShFq6ChmLvmwVgKspbQvEK7bNJKgp354kczkcxH1XWBY/iEUqU6FbmAsVnN+IQ1flJtC314NybyCIKyIStClbwPQ/PE1N0aP0wR7CIpnoRSrmUC2aOld8k0dzW1sxIU65r90hho44BgbkxesRmx8VpOX5j451ASFnI46nMFkk17/h7/10rhecxidoJjtw2BhNyzhWAZo6qH1COrYSvVsXEZDLAXXjywNaHr4ZBJPrTQ3AXwqLKYFz0yn7iY0Vh04yujO/I1J363uys+Cd3STcxYT/ZOEG0/YbBpZrThn3vsEeitymXQPb7v/uOa+2mgNkBBLw7D2gXxXvUkLNkSQ2Lr69DI+hXwQ6gAAAKbmsKTgYECNVQNKaOlRBFm3K/k6o8GfLWakBG/Zs/J5u7CPm8LW/78Hyz0bfSdPypMshSu+LyE8skA6b0b2HRnFbA4ZS/OIEQFp+INTlQc6nevGiOnIgc9qIBUlosKT3rcbRJSldjwTJ9dTgeKVzq8DYr/5HOytU6q94HkWoDEmVbkHASo4Tc3oZ8OGx7Efimg9e2HKe5KCv5wpFReezVtK7EiSSlJe98KfmWqqq76xjzK35Wx+cF0jMvqjejGmS2BtS5wU/ozpxhmEtZLPGZJb2PMfZj0KFIuhkDlPZHoIiHVBqvFfrCOEldknVtO4V9cZvueCcGrqA7xoVwlhd3jHK0/OF8iEy+VDOP+eFRqEneRTrk9aevaxPT9chImyAuBZO+UiLiO3xV4AkJIHbvkk/HNlskZ8BlxzDpHZ99EkH2gWyKjHCNj0LqEdRLU9zEgU9YT3Mux0Zzja7s3zVAJRZt/hSMzJK+dp2Vhtc4AHFHHSBtWlSoABRuvyRPpnLPjWgUGu39xw9fG+z2KVuGi7BILserXLtT++4BlU1TdsZ0T0Jmczppseoxmk61C8nfD0hunu0K37fZDFPGaz2qd8gji+FWbgD+vi3lzvN6x/VwE2phTPmWbmymn7KuDQymqD6DnsEMCBAVgOpP7kBZQqYmNcOHBsPzNfTDdjsUAZH4KaZXvp+7zWI1gEU+I6dtG7waG/ULYO4GLvz45DmBbJsOnO0upOAkEqgEtpWlkTl1+qSjvozR+cSp0Qx1e7IL1g5dDH5WrijfITbHO+Qo1EdRZ6pl4lQrML0cpYQCXKyELoU/lhpl2z2XnlBRqvDK3cpMsgZkK3nB4hm+rZttsRqUuR2IGohk7VwDuSQpPeIhgWb4EfvsOH6LDwdlbm8Tlh+ZMTP4SjBtowx997AJ9gEfP+6oIM9E215iXkT83vRievHZhcnd4j4nqRwojxsLlJQtYzhFfJQBdwrLDDxuJgyGvXEFvETMbGqZTl5LdJQpO0liSk4UA4rjiYw3aLhvMCU7YrvZj+gFpgm+5w0a/Uh7YOQJAVZAGsk3asRS/OFNy/l6ntsZxLUnql+TBb9rfNjgD/+9Xt8QB+qeH7Ti5f6iH27fDF9qcVq4ixLarn5whBj5f3bcHDPwlvyZkwbqrTvY++OkMq60d9RvwQ9nIchSNsQ1OLhLcUaw6FxKxAUFZ3t7z4THslZHgM+E9nrJPyoGO+n12UEJWyCqS64os7xZtKuMforgd+lWra1Kw2spb4K7fohNkjRb58Jm7wDlTCPreKAKgcNplQsF3RJ/G5qQZYUoYMj2H3D4nDpILebJapAn4T77dZQAOjWssjIvhSxHf7/ET9LtF4zEnhll6W9UzL3PDAjKdkeZQ0/6tMPwKmfkms4+lOaPzcTDswCGUHYcXdgufgf7PD4kA9Uwi9shSvmMep8dLE77UWPNfF1w7R9DZB/qzm9u/vIdc72p2H0yeBicbj9Owh4cPmqJ1dgdeOd8vj8vTWyQQM2x5jTyp6ZqgTffGzEVQZj9j1QWUIvtfndZL1I75cJFeqUuCYxuUbQJLbyh0gg3nO2ch9Q4UZCvOWY4x6AVxOYonIblFzUY/ZA1WHIV3O3WfQI0OcNa3ZqU4tmoE/DUp8bcPmxu//J5Na+Iey8EIfLp1AD6Z1Tl3x8FlSMYqe55Ti4gL3eEcGxf5pRCz89qtzFIWtRj9PgmcZw+VduE9K3RcmtnMtk6kprzD7IdwmTSF/4hz1N+aFbdNG5eZyG5MbuhyduSqPgR5sbQ/8vZBgFTooM/V0/groi57M6X8oJ/5pGypMw3r3FPxSwZYANDrTptFt5867niKADnQqbiAehvUYik2Rnea8ZOPAu2WWw9TyseI4Q5FowR7fIo0CDJhdDmoPqzG6wVNl6ApVFcB2GO2PLGvOsiR061JX3Px/hUEGeYzStM1YzYQu+kJxHPLzzB2tEfomSTNxOZS/NTa5NiOZyzZhujbv/5jG9nSpP+sBcuQ9za5FWUJZhrUz7SIYx8PTYGhDYxXY8cVCWlBXA2vdNQTVQTVQTVNHd8AmL2sIrPSDJP/p8+QIAoR38h2srzkB5lSUCF8u+gNcWeymjBkuRtpnr0h5xFYjJCHl1AFDT0/qAdjhucUSmLd9PVuJLpGhUjobsRhV7Ui8s08Y522bLyHfw66nOLPJKPgkrODJ25jtKkByVSz97VmKPu1kmzAwk9SWdUkfbWym9fsvVyf7SWqxABNIquXn2aF1i+7db6AQRrudjXL3rHoi5X5qIgFFc1lGUObkjd5yOr1W7qnI6MTvnn0KkT0M/blrSTU5wDSOFYi/a1J/BqghkX7jPglB/Z8P8GxGicihRhIWwBP/kz4wpjT4FzucI6FQTsuxSQ3zGwyDI+op/lpOSG3ZJ5P7wvLiqPF3EKAh5KYKD3VKoD+3hwSuQY+FIvH+glaSz06nuTe5Xv59e5eqnRWIwn+cXZrAvq0n/sfxwPt/1b/EVbcoGD3v98AXRqgZZZbNDOEiKeQlE6gPW+jJMTZ2VsqcH0y+iFTcYWOHDFiYvBqXRIsk0kZ2Moj0hjBeIh2Ozh6XO2dE6YpTDiQRtMhMEYvt4uKABOWbkzSGeCEsrLQ87iSn8jmBen6bn2FrOE6nbUjIxfnwvHyBDcMtzVNgjqhxYrKEuJPNg0q8/kg3Oxws7ZmeSAvt0cYlNtUfrpmu/piAO4h8xhF+ggH7I3c21nUulpee+b71u2EXagj1nrIApxuWIT2+zewCo3odSYpudcTg1f8Ton1wTT/NojrNh/EI71AdZrKbTS4VJHe26DmRP5Sa+p1trWs0hE9UNv9Lv0Mjsc+DDbkn5zTMxEUD9XRRq95fKSWiK+EhN31FuC17aHGaWBgvEAAglsGdPu14csLU/ZSSIzEdp/axvjHh+cV7M3hm34h3sJ0lpqXTsVDY98Q7wZtEksAeDyuu7GXMl1lTxdM/B6fock20LXgJoRzP+HOBQhLs6itNHKJzR2zOTb8SocXGSlLDg+HJQKmm/QLhpSWejxERRke1GvEmkcOD1cxfr+IddElLH+KiWxvOUnZtMxKRXPid7l3W0tZIOPGtUX05/843mDxD9Jcim3DqM1mlK3k5bEnRN207UWw/IBpswx8VhX76YLoGpi3ZOv0xv4y36znvA7p0mdCQgodja31CDomcY2pMjber0f9xH8Hn+JnRJqYG4NSnJ/yop7YbNA2A9Vf4TxJ4js++/AQux1KJ4SWNRGYZZObl+ZguoQF0s5rq0vx+MlnfQGKxl1D3zg03RqGeenCVgI8BINZH0Yjxn9uPzg4LD0eE9Df0EsA7RrAs8snOY2+VOH/NUOMq2OwQ/VqChuIzzMpQknMX/UoceJgBALTzDG07WmwEs7Uatbc3BdClEWrCPkb3aaAB1IQTKLhp7CSoh1r/tVbhB3iwufuB9bxXPui8uHNsZu4dwb4xDz5O2JAHfYlPNS6I5Td5TWZ+O0JHnqNBgAdqYKLgtQA9YLREbf8kL35OBYnCLfeNu69Fb9mivnQ4dWXPYGJCDQQE4PaDuzPagFfdsxmZeORNGFQXpNFQWXsc/V092SJEhA3ba2l+d52o8bJ46bMELlNheYF4JsKIL5xZJsJIHeveznjzAxYHJh3COJw6X4Lqi2R0zt+UhHpRjpO4VNnqOhGy4V9vPAKOfqE6AJQXTi+yfAYTUkLBowDU5SccGV1Xah5r6h5wSJh8QM9tdDoL4kgIdzy8tnDCjDi2moLjZc/1MoXGdUQciYCJ6YMn2djgEWJynK9RUqCoV1ilPH6ieGNzkYzYPmbkX2dxWfCOwiKTvTKzrUEqBA+8uCV6XD0dn34+NvfpMwpHwxVlsqq5MqIrz5SYNHD8eD0SV+aF0LFQQHpDZO/4S2t62G6RQCh5PLvB4ejuBwsOE2wrVl9bTmGUgPZUqGCOJuB3Op+njGt5xcKF3zwH8Dr1OwATYQqrQyi/MvNTUq/vJurcJNpVfh/PToLCVbPsm4GTTCm2ae6yIz+7vqhPfiZSE307DGeMoZj2VMfgoDETYol4epdFjQFn3G1Ov5ShkSDpPHcasOyTUpUYx7tyVU9m7TqzvwnkVRPofEv5TNP+FaWp7yQA1KBhyelUvglEN1epE+YQK2zgQMWhvN5RN5n2O5PnkjAEcyMPRbHl/nD2V5MZLIyObIy+2px/dx6Mo5lI/tahSpEoSHPVbty4euzP6R5Z1O+jE2z60d86Ip1ExW7tZMPYAQMQg0XFPWK8XdTG5VZaSAWhghGu27qhqxlzRqFztAPdDHsE5Cs2KnLH4rgHLCrqK7Js8/5OVJTBYmOv4o2Jtaxua09RJjg/PX+b+SloO7+tabS/+3z9BEuo5tl4e+z1/dSYs6BmoNGzwshP6Nlh61xLPq6kRw+SWtXeTeLm5qG6n4LDGBk2jZ/2BJqCytVqlw0GuByTN1gGbcqWHfITiqVweI2vBaZD7XYYS7VWYoNQFy5Id6ft5Bj6DH0QBHseIwyQgb+iikASztKCu/mmE2QVh2mAQeNeNyeSmijV6ow1+f3R/JQ8OwyWu033H0pOVbfi0lp3oZHDGW1BQL85+NZiGKGGTEbQFpdMGeW0M6ofZDv53c03a0LPy9i87cgYBi5AwDFyBgGLkDAMXIGl8+i0AABvueNuZ3N/mPo1ch3QvJSsPz+MyKuXt3+B5v5QmvxPYA/S3f6ejoKDO4Q1QcbSf1OaFBbmEkvm0rbVT0b7gu5pR7akcsfs2kuL76Tc+c1oMg7cVlCVpasjFrm4jmfT1JaWgSCH/PAWMpr2+AgSX4eypzqXHCuL4TnYqS+WxlHz32bRRjk3TnChQ4HWFCGWGgvPG8Q6O+o4/o6lYIHfjas6GefH8XSy6Xu43WYSB5gePsparX+XqJi6VIE5s3bqcgmg1zQKFtTtk+AFDK6Wz3zW8oitHR7N4erbdsDSCMsnbxT9qCw3l4bNuGbtbFdxLJgAf5eRmwyDKMrSdZX+8IQ7T1kzCye8Ziah7uXEJ4yU+oSgD5Rr7DctL2ThywzHBRJ+25imkhJ86fTFW3j0E2t8h33DzV6YWihoFf1nLyXISolx0kwGBY3t7Lef3RQPuXv0Jta5EsE08+WfUpBYF4wJl1r3UqVxgQQGbHKf7/3+S0TEuGwMwWtqqLVWLbfQNVVheAgzGKWaLATRezIfLqVAyaEv4wkspieaCL/Lu6KdbYgCU+RQ2vSMMYeqPQVcRK8RgtV3jv7pMRini5pOTi4Q9g1cJ0s8fXK9PwINi8GgSeq/voktIGhJ8E9Uicx9iVHc1rOJLITO2j9SkhxH1iAdAg0uyZPCsQOFjEhnt5Zy5htTCslCXv240RzgQhjjR1Odt9XQzUXsXCQqgchyBw+eQm7R07S2NUEm02hWW8mug/zSN98/8y2+8mjro+VvOS+PGukyWDyeMGnPKtksNrjr7vKPvfe07qiDQL00Yx8Pr9rusw/rkIAAAxtxAngFw4k4GLxs3BqaLdkpL00P8d0wEAg23aoI9NNRR9EtsibJ3ZgNXiC3ulZuNgelwYx2eXMUWEx7b0i+VivQbQQZlLwZymnGq42PdzJMdkn2sktUfhJ7bB14M1As7GOlOeUPG6DURFJpXl2xrAYmMl4t4qzvYgWaDkgBs8PCfpNGgOI9rw8ZFrGoNDppi+SIsLaMVO2II8oM2a4+cDLbNXHmv/FiHkzyhWH9nFc7Q1blOsGFZrU3uNJTLN3gz+5C8+H1WWLEBD9xAaVN7s4skwGVwx6UgrSkpcrRxIwOt8yZIuuR1sr5WItCbgrccBFG5jy/goklOm0TSTx5f3ngTbp99I2eIJ3ilaJsP+mwu2HGRT+gxkOIGDsk2PV7tQVm4kErNhitmShUyMyIR+to14j46v5GW8MJ7lFd0h/gUqqxcwQ5VFTG5nLkRj6frvJxphtkaikqUYPnAPpRUcKB8xmjMUiZwAQvSbCJQf8584v7gbxLlRpJrT4tBFRxxG35r2OmbRK8ZKHHhFcJZOr7TQqWEeD0T+T1M67dKU9orrtB1ri6quN10puEaOMkbxdx7rbB8lctJ9BwiYfmSq33Ld+k0ps9P4f6zQf74jfAjmkYNKstwtANj5/ldZtFQGeGNg/QA6sVw6tvrUjGBLVx997PnmOS/1YAakDx2/3sdVY7dgdexYjxPT6GlqsxY9taPZAXw+D0vknF2abUialSJQlYRE19/5TfpazCaqiNex99qaXh9ZUbFefOPncalq3ZlcD/YiYBiPc/Wg4/fNyHxb67GWmdyajiS+kcSX0jiTF+HFCGawAEbESq/OTVsVk9YhbtOAHLERCFlkPQWNp6CMbc1PKWntGxZ3oE+m90JAjC6mIUqf9SrZJ4P95Tx0p4ir/TzoVvqz6y1ux2HOpkT55PpqsbuBWhhWObMbkNhkqxXkEfxZIzYcGOmG5y/ai7WWeWS/4WQn2T+NvXrZRoqVIJ6tilRJDLgh2YTGE6ktjOMqvYJANtSS3QdtgO5+yoTXAPp1oaI2CLvm+WdXo3Z5HnXslARUh0BL6NkVE/Q3mg+xwTIjonkJOG+d6RLbx5OKrbufVG+rpc1Es13bJ6JvD4FKQUdKueLpzgitOdsOGnaQNUNdZH4Kwg81lmtSeR//zeUMfKz8MAndcWry3wyaXwNd3D9WCb5H7Rok+KvXpEuPFi61NfzkGCAcziggIFQrWRSLNmejIE4Cx2YGrEV7Lvx2/48In5uePCrD8aNsTzxfXJ5IHjm3jXH4SONwEwZFyrngostPkL704X1fWuyIwGadO8wPbZvq4O5hdSAvPJM86qWBcIFZiHHHo95lY4u+oCRaHIXa1iS4cuabHJgBqMyNKqILl+sNrlDjhTruzONKzv2ZE71ZBEUciJ61OcsRtepEJLMNXRXZzRz5IZj+23+xaO+lSpBJG97IOdrkNmJsDDQNoSt2xaGwh6QU7LbvrFXhRux/OMyF7NMGgTOpF8M5CXvp/CnInS2924v4F2e31GUal14ETq2cbfBwsjZNDvPBsF0XNKBrGTruYCNtn2w5QfpxwZbjVzmJWftOuoZSfPF6d/sgtyJ65QwlBFbQbpOqMemilqOJ89vZgl1+PefC8Qp4Dt2wpT6hkFt2ulm2WSdfTeoLyKE37AKQT0SdKNRK9PwmePGOSJOmJfKDR3/WzPgnp35CXF+ZRHG+IzxbvdPTruV6A7Qt0T2vAdTOlpPiZ0xSCWLeKEnexKLwQN97ZQw6ZgDol77545aqR2+tk6xxhUrl/cffQGu91dW/VwoeUSxYAAAAAAATzDp1By0Pe4r92IEiu+77MPUKWmRFkdeDLPnHQv/CQeAAAAAAAAAAAAAAAAAAAAFzL7DRQpDTN03vSlphKYl2qRTbKk9ge1K605IiQCMqJRRDxUgQ8TfqkChuwPZvkE0JzowAAAA';
// In-memory only (a restart invalidates pending codes — the user just
// requests a new one). Keyed by lowercase email.
const verifyStore = new Map(); // email -> {code, token, expiresAt, attempts}
const verifySendCount = new Map(); // email -> {count, windowStart}
let emailTransporter = null;
let emailTransporterKey = '';
function getEmailTransporter() {
  try {
    const s = loadSettings();
    const em = (s && s.email && typeof s.email === 'object') ? s.email : {};
    const user = typeof em.user === 'string' ? em.user.trim() : '';
    const pass = typeof em.appPassword === 'string' ? em.appPassword.replace(/\s+/g, '') : '';
    if (!user || !pass || !NodemailerLib) return null;
    const key = user + '|' + pass.length;
    if (!emailTransporter || emailTransporterKey !== key) {
      // Port 587 + STARTTLS (not 465): Render's network times out on
      // smtp.gmail.com:465 (implicit TLS), but 587 is the standard
      // submission port and connects. Explicit timeouts so a dead
      // connection fails fast (15s) instead of hanging the request
      // for nodemailer's 2-minute default. family:4 forces IPv4 —
      // Render's IPv6 route to Gmail SMTP blackholes (both 465 and
      // 587 timed out; owner order 2026-11-17).
      emailTransporter = NodemailerLib.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true,
        auth: { user, pass },
        family: 4,
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      });
      emailTransporterKey = key;
    }
    return emailTransporter;
  } catch (e) { return null; }
}
// Brevo send counter (server-side, for the live usage display).
// A Restricted Brevo key (Transactional email — All) can SEND email but
// cannot read Brevo's account/statistics APIs (403), so the usage
// endpoint cannot rely on Brevo's statistics. Instead the server counts
// every successful Brevo send itself, per day (Phnom Penh), persisted to
// brevo-usage.json so it survives restarts. This counts exactly the
// emails MovAi sends through Brevo (the only use of this Brevo account).
const BREVO_USAGE_FILE = path.join(DATA_DIR, 'brevo-usage.json');
let _brevoUsage = null;
function brevoUsageLoad() {
  if (_brevoUsage && typeof _brevoUsage === 'object') return _brevoUsage;
  try { const j = JSON.parse(fs.readFileSync(BREVO_USAGE_FILE, 'utf8')); if (j && typeof j === 'object' && typeof j.date === 'string') { _brevoUsage = j; return _brevoUsage; } } catch (e) {}
  _brevoUsage = { date: '', sent: 0 };
  return _brevoUsage;
}
function brevoUsageSave() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BREVO_USAGE_FILE, JSON.stringify(_brevoUsage, null, 2)); ghPersistFile(BREVO_USAGE_FILE); } catch (e) {}
}
function brevoUsageRecordSent() {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
    const u = brevoUsageLoad();
    if (u.date !== today) { u.date = today; u.sent = 0; }
    u.sent = (Number(u.sent) || 0) + 1;
    brevoUsageSave();
  } catch (e) {}
}
function brevoUsageToday() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
  const u = brevoUsageLoad();
  if (u.date !== today) { u.date = today; u.sent = 0; }
  return { date: today, sent: Number(u.sent) || 0 };
}
// Brevo HTTPS email API (replaces Gmail SMTP, which is blocked from
// Render — all SMTP ports time out). Brevo sends over HTTPS (port
// 443), so it works from Render. Free tier: 300 emails/day. The API
// key lives in settings.email.brevoApiKey (set in Admin → Settings →
// Email). Sender must be a Brevo-verified sender (sokhoeun356).
async function sendViaBrevo(toEmail, fromEmail, subject, html, text) {
  const s = loadSettings();
  const em = (s && s.email && typeof s.email === 'object') ? s.email : {};
  const apiKey = typeof em.brevoApiKey === 'string' ? em.brevoApiKey.trim() : '';
  if (!apiKey) return { ok: false, error: 'Brevo API key not configured' };
  const from = (typeof fromEmail === 'string' && fromEmail.trim()) ? fromEmail.trim() : 'sokhoeun356@gmail.com';
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 20000);
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'MovAi', email: from },
        to: [{ email: toEmail }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: 'Brevo error ' + r.status + ': ' + String(t).slice(0, 200) };
    }
    brevoUsageRecordSent();
    return { ok: true };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: 'Brevo send failed — ' + (e && e.message ? String(e.message).slice(0, 200) : 'error') };
  }
}
function verifyEmailConfigured() {
  try {
    const s = loadSettings();
    const em = (s && s.email && typeof s.email === 'object') ? s.email : {};
    const brevoOk = typeof em.brevoApiKey === 'string' && em.brevoApiKey.trim().length > 0;
    const gmailOk = !!(typeof em.user === 'string' && em.user.trim() && typeof em.appPassword === 'string' && em.appPassword.trim() && NodemailerLib);
    return brevoOk || gmailOk;
  } catch (e) { return false; }
}
function buildVerifyEmailHtml(code, link) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#0A0B0D;font-family:Arial,Helvetica,sans-serif;color:#fff;">'
    + '<div style="max-width:480px;margin:0 auto;padding:24px 16px;">'
    + '<div style="text-align:center;padding:8px 0 16px;">'
    + '<img src="' + VERIFY_LOGO_URL + '" alt="MovAi" width="72" height="72" style="border-radius:16px;display:block;margin:0 auto 10px;">'
    + '<div style="font-size:26px;font-weight:900;letter-spacing:.5px;">Mov<span style="color:#ADDC29;">Ai</span></div>'
    + '<div style="font-size:13px;color:#9ca3af;margin-top:4px;">បង្កើតរូបភាព · វីដេអូ · បទចម្រៀង · 3D — Create images, videos, songs &amp; 3D with AI</div>'
    + '</div>'
    + '<div style="background:#17181c;border:1px solid #26272c;border-radius:16px;padding:22px 18px;text-align:center;">'
    + '<div style="font-size:17px;font-weight:700;margin-bottom:6px;">លេខកូដផ្ទៀងផ្ទាត់ · Your verification code</div>'
    + '<div style="font-size:13px;color:#9ca3af;margin-bottom:16px;">បញ្ចូលលេខកូដនេះក្នុង MovAi ដើម្បីចូលប្រើ — Enter this code in MovAi to log in. វាមានសុពលភាព 60 វិនាទី · Valid for 60 seconds.</div>'
    + '<div style="font-size:38px;font-weight:900;letter-spacing:10px;color:#ADDC29;background:#0A0B0D;border:1px dashed #ADDC29;border-radius:12px;padding:12px 8px;margin-bottom:16px;">' + esc(code) + '</div>'
    + '<div style="font-size:13px;color:#9ca3af;margin-bottom:10px;">ឬចុច Link ខាងក្រោមដើម្បីចូលប្រើភ្លាម · Or tap the button below to log in instantly:</div>'
    + '<a href="' + esc(link) + '" style="display:inline-block;background:#ADDC29;color:#0A0B0D;font-weight:800;font-size:15px;text-decoration:none;padding:12px 28px;border-radius:999px;">ចូលប្រើ MovAi · Log in to MovAi</a>'
    + '<div style="font-size:12px;color:#6b7280;margin-top:14px;word-break:break-all;">' + esc(link) + '</div>'
    + '</div>'
    + '<div style="text-align:center;font-size:12px;color:#9ca3af;padding:18px 8px 4px;line-height:1.7;">'
    + 'បើអ្នកមិនបានសុំលេខកូដនេះទេ សូមមិនអើពើ email នេះ។ · If you did not request this code, please ignore this email.<br>'
    + '<a href="' + VERIFY_SITE_URL + '/about" style="color:#ADDC29;text-decoration:none;">About</a>'
    + ' &nbsp;|&nbsp; '
    + '<a href="' + VERIFY_SITE_URL + '/privacy-policy" style="color:#ADDC29;text-decoration:none;">Privacy Policy</a>'
    + '<br><span style="color:#6b7280;">© MovAi · YEM SOKHOEUN</span>'
    + '</div>'
    + '</div></body></html>';
}
function buildVerifyEmailText(code, link) {
  return [
    'MovAi \u2014 \u179b\u17c1\u1781\u1780\u17bc\u178a\u1795\u17d2\u1784\u1795\u17d2\u178f\u17d2\u178f \u00b7 Your verification code',
    '',
    '\u179b\u17c1\u1781\u1780\u17bc\u178a\u1795\u17d2\u1784\u1795\u17d2\u178f\u17d2\u178f\u179a\u1794\u179f\u17d2\u1793 (\u1798\u17b6\u1793\u179f\u17bb\u1796\u179b\u1797\u17b6\u1796 60 \u179c\u17b7\u1793\u17b6\u178f\u17b8): ' + code,
    '',
    '\u17ac\u17be\u1785\u17bb\u1785 Link \u1793\u17b9\u17c1\u17c7\u178a\u17be\u1798\u1794\u17be\u1794\u1785\u17d2\u179b\u1785\u17d2\u1794\u179a\u17d2\u1793: ' + link,
    '',
    '\u1794\u17be\u17a2\u17a2\u1780\u1798\u17b7\u1793\u1794\u17b6\u1793\u179f\u17bb\u1798\u179b\u17c1\u1781\u1780\u17bc\u178a\u1795\u17d2\u1784\u1795\u17d2\u178f\u17d2\u178f\u179a\u1794\u179f\u17d2\u1793\u1791\u17c1 \u179f\u17bc\u1798\u17a2\u17be\u1798\u17a2\u17be\u179a email \u1793\u17b9\u17c1\u17c7\u1793\u17c1\u17c7\u17b8',
    'About: ' + VERIFY_SITE_URL + '/about',
    'Privacy Policy: ' + VERIFY_SITE_URL + '/privacy-policy',
    ''
  ].join('\n');
}
async function sendVerificationEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' };
  // Rate limit: max 5 emails per address per hour.
  const now = Date.now();
  const sc = verifySendCount.get(em);
  if (sc && now - sc.windowStart < 3600 * 1000 && sc.count >= VERIFY_SEND_MAX_PER_HOUR) {
    return { ok: false, error: 'ផ្ញើច្រើនពេក — សូមរង់ចាំ 1 ម៉ោង' };
  }
  if (!sc || now - sc.windowStart >= 3600 * 1000) verifySendCount.set(em, { count: 0, windowStart: now });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const token = crypto.randomBytes(24).toString('hex');
  const link = VERIFY_SITE_URL + '/?verify=' + token;
  verifyStore.set(em, { code, token, expiresAt: now + VERIFY_CODE_TTL_MS, attempts: 0 });
  const s = loadSettings();
  const fromUser = (s && s.email && typeof s.email.user === 'string' && s.email.user.trim()) ? s.email.user.trim() : 'sokhoeun7788@gmail.com';
  const subject = 'MovAi — លេខកូដផ្ទៀងផ្ទាត់ ' + code;
  const html = buildVerifyEmailHtml(code, link);
  const text = buildVerifyEmailText(code, link);
  // Brevo HTTPS API first (Gmail SMTP is blocked from Render).
  const brevo = await sendViaBrevo(em, fromUser, subject, html, text);
  if (brevo.ok) {
    const sc2 = verifySendCount.get(em);
    if (sc2) sc2.count += 1;
    return { ok: true, sent: true, via: 'brevo' };
  }
  // Brevo not configured or failed — fall back to Gmail SMTP.
  const transporter = getEmailTransporter();
  if (!transporter) {
    verifyStore.delete(em);
    return { ok: false, error: brevo.error && brevo.error !== 'Brevo API key not configured' ? brevo.error : 'Admin មិនទាន់ដាក់ Email (Gmail App Password) ទេ' };
  }
  try {
    await transporter.sendMail({
      from: '"MovAi" <' + fromUser + '>',
      to: em,
      subject,
      text,
      html,
    });
  } catch (e) {
    verifyStore.delete(em);
    return { ok: false, error: 'ផ្ញើ email មិនបានទេ — ' + (e && e.message ? String(e.message).slice(0, 200) : 'error') };
  }
  const sc2 = verifySendCount.get(em);
  if (sc2) sc2.count += 1;
  return { ok: true, sent: true, via: 'smtp' };
}
function verifyCodeCheck(email, code) {
  const em = String(email || '').trim().toLowerCase();
  const c = String(code || '').replace(/\D/g, '').slice(0, 6);
  if (!em || c.length !== 6) return { ok: false, error: 'សូមដាក់លេខកូដ 6 ខ្ទង់' };
  const rec = verifyStore.get(em);
  if (!rec) return { ok: false, error: 'លេខកូដផុតកំណត់ហើយ — សូមសុំលេខកូដថ្មី' };
  if (Date.now() > rec.expiresAt) { verifyStore.delete(em); return { ok: false, error: 'លេខកូដផុតកំណត់ហើយ — សូមសុំលេខកូដថ្មី' }; }
  if (rec.attempts >= VERIFY_MAX_ATTEMPTS) { verifyStore.delete(em); return { ok: false, error: 'បញ្ចូលខុសច្រើនដងពេក — សូមសុំលេខកូដថ្មី' }; }
  if (rec.code !== c) { rec.attempts += 1; return { ok: false, error: 'លេខកូដមិនត្រឹមត្រូវទេ' }; }
  verifyStore.delete(em);
  return { ok: true, verified: true };
}
function verifyTokenCheck(token) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: 'Link មិនត្រឹមត្រូវទេ' };
  for (const [em, rec] of verifyStore.entries()) {
    if (rec.token === t) {
      if (Date.now() > rec.expiresAt) { verifyStore.delete(em); return { ok: false, error: 'Link ផុតកំណត់ហើយ — សូមសុំ Link ថ្មី' }; }
      verifyStore.delete(em);
      return { ok: true, verified: true, email: em };
    }
  }
  return { ok: false, error: 'Link មិនត្រឹមត្រូវទេ ឬផុតកំណត់ហើយ' };
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
const ADMIN_EMAILS = ['sokhoeun7788@gmail.com', 'yemsokhoeun98@gmail.com', 'sokhoeun356@gmail.com'];
// ---- Admin-key Google session (Admin website Google sign-in) ----
// After Google sign-in the Admin app proves its Gmail with a Google ID
// token; the server verifies it and issues a short-lived (15 min)
// session token tied to that admin Gmail. The session is in-memory
// only (a restart simply asks the admin to sign in again). It is used
// ONLY to reveal / reset the Admin Key — it never replaces the Admin
// Key itself, and key-entry attempts keep the graduated lockout.
const MOVAI_GOOGLE_CLIENT_ID = '809358546010-dspkik0o4ahg7km15dspro5cj3qjk384.apps.googleusercontent.com';
const ADMIN_KEY_SESSION_MS = 15 * 60 * 1000;
const _adminKeySessions = new Map(); // token -> {email, name, picture, expiresAt}
const _adminKeyRate = new Map(); // email + ':' + action -> {count, windowStart}
function issueAdminKeySession(email, name, picture) {
  const token = crypto.randomBytes(32).toString('hex');
  _adminKeySessions.set(token, { email, name: name || '', picture: picture || '', expiresAt: Date.now() + ADMIN_KEY_SESSION_MS });
  return token;
}
function adminKeySessionFromReq(req) {
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const s = _adminKeySessions.get(m[1]);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { _adminKeySessions.delete(m[1]); return null; }
  if (!ADMIN_EMAILS.includes(s.email)) return null;
  return s;
}
function adminKeyRateOk(email, action) {
  const key = email + ':' + action;
  const now = Date.now();
  const rec = _adminKeyRate.get(key);
  if (!rec || now - rec.windowStart >= 60 * 60 * 1000) { _adminKeyRate.set(key, { count: 1, windowStart: now }); return true; }
  if (rec.count >= 5) return false;
  rec.count += 1;
  return true;
}
// ---- Password auth (owner order 2026-11-17) ----
// Sign-up: Google (proves the Gmail belongs to them) -> create a
// password -> Create Account. Sign-in: Gmail + password. Passwords are
// NEVER stored in plain text — scrypt with a per-user random salt.
// The hash/salt live on the user record in users.json; pubUser() never
// returns them (only hasPassword:true/false so the website knows
// whether to show the Create Password screen).
const scryptAsync = (password, salt, keylen) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, keylen, (err, derived) => err ? reject(err) : resolve(derived));
});
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
async function verifyPassword(password, saltHex, hashHex) {
  try {
    const hash = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch (e) { return false; }
}
// Verify a Google ID token for ANY Gmail (not just admins). Same checks
// as the admin verify-google endpoint (aud, iss, email_verified, exp).
// Returns {email, name, picture} or null.
async function verifyGoogleIdToken(idToken) {
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const info = await r.json().catch(() => null);
    if (!info || typeof info !== 'object') return null;
    if (info.aud !== MOVAI_GOOGLE_CLIENT_ID) return null;
    if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') return null;
    if (info.email_verified !== 'true' && info.email_verified !== true) return null;
    const expMs = Number(info.exp) * 1000;
    if (!Number.isFinite(expMs) || expMs <= Date.now()) return null;
    const email = normEmail(info.email);
    if (!email) return null;
    return { email, name: typeof info.name === 'string' ? info.name : '', picture: typeof info.picture === 'string' ? info.picture : '' };
  } catch (e) { return null; }
}
// Brute-force guard for Gmail+password sign-in: 5 wrong passwords ->
// that Gmail is locked for 15 minutes. A correct password always
// clears the lock. In-memory only (a restart clears it); the lock is
// a throttle, not a permanent block.
const signinFails = new Map(); // email -> {count, lockedUntil}
function signinLocked(email) {
  const f = signinFails.get(email);
  if (!f) return false;
  if (f.lockedUntil && Date.now() < f.lockedUntil) return true;
  if (f.lockedUntil && Date.now() >= f.lockedUntil) { signinFails.delete(email); return false; }
  return false;
}
function signinFail(email) {
  const f = signinFails.get(email) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= 5) f.lockedUntil = Date.now() + 15 * 60 * 1000;
  signinFails.set(email, f);
  return f;
}
function signinClear(email) { signinFails.delete(email); }
// ---- Remember-me (owner order 2026-11-17) ----
// After a successful sign-in the website asks "Save password?" — if
// the user says yes, the server issues a long-lived remember token.
// Next time the login screen shows the saved Account (Gmail + masked
// password); tapping it logs in automatically via the token — no
// password typing. The token itself is a random 32-byte value; the
// server stores ONLY its SHA-256 hash, on the user record, max 5
// tokens (one per device). Tokens expire after 90 days and are all
// revoked when the password is changed/reset. The website stores the
// raw token in localStorage (per-device). A stolen token can only log
// in as that user — it cannot reveal the password or change anything.
const REMEMBER_TOKEN_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const REMEMBER_TOKEN_MAX = 5;
function rememberTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function issueRememberToken(u) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = rememberTokenHash(token);
  const now = Date.now();
  if (!Array.isArray(u.rememberTokens)) u.rememberTokens = [];
  u.rememberTokens = u.rememberTokens.filter((t) => t && t.hash && now - Number(t.createdAt || 0) < REMEMBER_TOKEN_MS);
  u.rememberTokens.push({ hash, createdAt: now });
  if (u.rememberTokens.length > REMEMBER_TOKEN_MAX) u.rememberTokens = u.rememberTokens.slice(-REMEMBER_TOKEN_MAX);
  return token;
}
function findRememberToken(u, token) {
  if (!u || !Array.isArray(u.rememberTokens) || !token) return null;
  const hash = rememberTokenHash(token);
  const now = Date.now();
  const entry = u.rememberTokens.find((t) => t && t.hash === hash);
  if (!entry) return null;
  if (now - Number(entry.createdAt || 0) >= REMEMBER_TOKEN_MS) return null; // expired
  return entry;
}
function revokeRememberToken(u, token) {
  if (!u || !Array.isArray(u.rememberTokens) || !token) return false;
  const hash = rememberTokenHash(token);
  const before = u.rememberTokens.length;
  u.rememberTokens = u.rememberTokens.filter((t) => t && t.hash !== hash);
  return u.rememberTokens.length !== before;
}
function revokeAllRememberTokens(u) {
  if (!u) return;
  u.rememberTokens = [];
}
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
// gift-claimed, security) go to admin subscriptions (role 'admin' or an admin Gmail);
// user kinds (purchase-approved, purchase-rejected, grant, deduct,
// gift-claimed) go to that user's own subscriptions. Deduplicated by
// endpoint. Fire-and-forget — never blocks the response.
function sendPushForNotification(n) {
  try {
    const ADMIN_KINDS = ['login', 'purchase-request', 'gift-claimed', 'security'];
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
  // Email verification (login). The server sends a 6-digit code + a magic
  // link to the user's Gmail on EVERY login (also after sign-out + log in
  // again — verification is required every time). user = the Gmail the
  // server sends FROM (the admin's Gmail); appPassword is a SECRET — a
  // Gmail App Password (16 chars), never returned by any endpoint and
  // never logged. The Admin app sets it in Email Settings; an empty /
  // missing appPassword keeps the stored one, null clears it.
  email: {
    user: 'sokhoeun7788@gmail.com',
    appPassword: '',
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
  // Email verification settings. appPassword is a SECRET: a non-empty
  // string sets/rotates it; an empty string or missing field KEEPS the
  // stored password (the Admin app leaves the field blank when it does
  // not know it — that must never wipe it); null clears it. user follows
  // the same rule (non-empty sets, empty/missing keeps, null clears).
  const baseEm = (base && base.email && typeof base.email === 'object' && !Array.isArray(base.email)) ? base.email : SETTINGS_DEFAULTS.email;
  const emIn = (j.email && typeof j.email === 'object' && !Array.isArray(j.email)) ? j.email : {};
  let emUser;
  if (typeof emIn.user === 'string' && emIn.user.trim()) emUser = emIn.user.trim().slice(0, 200);
  else if (emIn.user === null) emUser = '';
  else emUser = typeof baseEm.user === 'string' ? baseEm.user : '';
  let emPass;
  if (typeof emIn.appPassword === 'string' && emIn.appPassword.trim()) emPass = emIn.appPassword.replace(/\s+/g, '').slice(0, 200);
  else if (emIn.appPassword === null) emPass = '';
  else emPass = typeof baseEm.appPassword === 'string' ? baseEm.appPassword : '';
  // Brevo API key is a SECRET, same rule as appPassword: a non-empty
  // string sets/rotates it; an empty string or missing field KEEPS the
  // stored key (the Admin app leaves the field blank when it does not
  // know it — that must never wipe it); null clears it. Without this,
  // cleanSettings dropped the key on every save, so Brevo could never
  // be configured (email-usage always reported "not configured").
  let emBrevo;
  if (typeof emIn.brevoApiKey === 'string' && emIn.brevoApiKey.trim()) emBrevo = emIn.brevoApiKey.replace(/\s+/g, '').slice(0, 200);
  else if (emIn.brevoApiKey === null) emBrevo = '';
  else emBrevo = typeof baseEm.brevoApiKey === 'string' ? baseEm.brevoApiKey : '';
  s.email = { user: emUser, appPassword: emPass, brevoApiKey: emBrevo };
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
  const em = (s && s.email && typeof s.email === 'object' && !Array.isArray(s.email)) ? s.email : {};
  out.email = { user: typeof em.user === 'string' ? em.user : '', hasAppPassword: !!(typeof em.appPassword === 'string' && em.appPassword.trim()), hasBrevoApiKey: !!(typeof em.brevoApiKey === 'string' && em.brevoApiKey.trim()) };
  return out;
}
// Admin provider keys (./data/admin-keys.json). The admin puts each
// provider's API key here from the Admin app; the server uses them to call
// providers so the browser never holds a key. Key VALUES are never returned
// by any endpoint and never go into git — only the file on this server.
// MULTI-KEY: each provider holds a LIST — keys[provider] =
// { keys: [{key, endpoint, addedAt}], updatedAt }. The admin can add MANY
// keys per provider; when one is exhausted the server automatically
// switches to the next (see withProviderKeyRotation). Old single-key files
// ({key, endpoint, updatedAt}) are migrated on load, never losing a key.
// Providers: novai, magichour, masterpiecex, hunyuan3d, suno, acemusic,
// musicapi, groq (the AI chat key), tavus kept for the legacy proxy branch).
const ADMIN_KEYS_FILE = path.join(DATA_DIR, 'admin-keys.json');
const KNOWN_KEY_PROVIDERS = ['novai', 'magichour', 'masterpiecex', 'hunyuan3d', 'suno', 'acemusic', 'musicapi', 'tavus', 'groq', 'mvsep'];
function normProvider(v) {
  if (typeof v !== 'string') return '';
  let p = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (p === 'movai') p = 'suno'; // MovAi is the display name of the Suno provider
  return p;
}
// Normalize one provider record to the multi-key shape
// {keys:[{key, endpoint, addedAt}], updatedAt}. Old single-key records
// ({key, endpoint, updatedAt}) become a one-entry list — the key is kept.
function normAdminKeyRecord(v, fallbackAt) {
  const at = typeof fallbackAt === 'string' && fallbackAt ? fallbackAt : new Date().toISOString();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { keys: [], updatedAt: at };
  if (Array.isArray(v.keys)) {
    const list = [];
    for (const e of v.keys) {
      if (!e || typeof e.key !== 'string' || !e.key.trim()) continue;
      list.push({ key: e.key.trim(), endpoint: typeof e.endpoint === 'string' ? e.endpoint.trim().slice(0, 500) : '', addedAt: typeof e.addedAt === 'string' && e.addedAt ? e.addedAt : at });
    }
    return { keys: list, updatedAt: typeof v.updatedAt === 'string' && v.updatedAt ? v.updatedAt : at };
  }
  if (typeof v.key === 'string' && v.key.trim()) {
    return { keys: [{ key: v.key.trim(), endpoint: typeof v.endpoint === 'string' ? v.endpoint.trim().slice(0, 500) : '', addedAt: typeof v.updatedAt === 'string' && v.updatedAt ? v.updatedAt : at }], updatedAt: typeof v.updatedAt === 'string' && v.updatedAt ? v.updatedAt : at };
  }
  return { keys: [], updatedAt: at };
}
function loadAdminKeys() {
  let j = null;
  try { const parsed = JSON.parse(fs.readFileSync(ADMIN_KEYS_FILE, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) j = parsed; } catch (e) {}
  if (!j) return {};
  // Migrate old single-key records to the multi-key shape on load and
  // persist the migrated file (once — later loads already see the new shape).
  let changed = false;
  const out = {};
  for (const p of Object.keys(j)) {
    const v = j[p];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.key === 'string' && !Array.isArray(v.keys)) changed = true;
    out[p] = normAdminKeyRecord(v);
  }
  if (changed) saveAdminKeys(out);
  return out;
}
function saveAdminKeys(k) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify(k, null, 2));
  ghPersistFile(ADMIN_KEYS_FILE);
}
// The provider's stored keys as a list [{key, endpoint}] (multi-key
// shape). Key VALUES are only used server-side — never returned or logged.
function adminProviderKeyList(provider) {
  const rec = loadAdminKeys()[normProvider(provider)];
  if (!rec || !Array.isArray(rec.keys)) return [];
  return rec.keys.filter((e) => e && typeof e.key === 'string' && e.key.trim()).map((e) => ({ key: e.key.trim(), endpoint: typeof e.endpoint === 'string' ? e.endpoint.trim() : '' }));
}
// First stored key for a provider, or null (kept for single-key checks
// like "is a Groq key configured?"). endpoint is the Suno gateway URL
// (only Suno needs one — the other providers have fixed hosts).
function adminProviderKey(provider) {
  const list = adminProviderKeyList(provider);
  return list.length ? list[0] : null;
}
// Resolve a provider API key: the request's own key first, else the
// admin-stored key. The browser now sends no key — the admin key is used.
function resolveProviderKey(reqKey, provider) {
  if (typeof reqKey === 'string' && reqKey.trim()) return reqKey.trim();
  const a = adminProviderKey(provider);
  return a && a.key ? a.key : '';
}
// Error that carries the upstream HTTP status (for rotation decisions).
function rotErr(message, httpStatus) {
  const e = new Error(String(message || 'request failed'));
  e.httpStatus = Number(httpStatus) || 0;
  return e;
}
// Per-provider "next start" index for key rotation (in-memory only;
// resets on restart). STRICT ROUND-ROBIN (owner order 2026-11-18):
// after every successful call the pointer advances to the NEXT key,
// so usage spreads evenly across all keys (call 1 → key 1, call 2 →
// key 2, call 3 → key 3, then back to key 1) instead of draining one
// account until it fails. Applies to ALL providers (Groq, Suno, Magic
// Hour, NovAI, MusicAPI, Tavus, MVSEP, Whisper, Translate).
const _keyRotationStart = new Map();
// ---- API key health (red/green) ----
// Per provider + key index: 'ok' (green, working) or 'exhausted' (red,
// ran out of credits/quota or auth failed). Persisted to key-health.json
// so it survives restarts. Key VALUES are never stored or exposed — only
// the index + status + a short error note.
const KEY_HEALTH_FILE = path.join(DATA_DIR, 'key-health.json');
let _keyHealth = {};
try { const _kh = JSON.parse(fs.readFileSync(KEY_HEALTH_FILE, 'utf8')); if (_kh && typeof _kh === 'object') _keyHealth = _kh; } catch (e) {}
function keyHealthSave() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(KEY_HEALTH_FILE, JSON.stringify(_keyHealth, null, 2)); ghPersistFile(KEY_HEALTH_FILE); } catch (e) {}
}
function keyHealthSet(provider, idx, status, note) {
  const p = String(provider || '').toLowerCase();
  if (!_keyHealth[p]) _keyHealth[p] = {};
  const cur = _keyHealth[p][String(idx)] || {};
  _keyHealth[p][String(idx)] = { status, note: String(note || '').slice(0, 120), at: new Date().toISOString(), lastOk: status === 'ok' ? new Date().toISOString() : (cur.lastOk || '') };
  keyHealthSave();
}
function keyHealthList() {
  // Returns {provider: [{key: 1, status, note, at, lastOk}, ...]} for every
  // provider that has stored keys. Keys are identified by 1-based index only.
  const out = {};
  for (const p of Object.keys(_keyHealth)) {
    const arr = [];
    for (const idx of Object.keys(_keyHealth[p]).sort((a, b) => Number(a) - Number(b))) {
      const h = _keyHealth[p][idx] || {};
      arr.push({ key: Number(idx) + 1, status: h.status || 'unknown', note: h.note || '', at: h.at || '', lastOk: h.lastOk || '' });
    }
    out[p] = arr;
  }
  // Also include providers that have keys configured but no health record
  // yet (shown as 'unknown' until first use).
  try {
    for (const p of ['suno', 'magichour', 'musicapi', 'novai', 'groq', 'mvsep']) {
      const n = adminProviderKeyList(p).length;
      if (!n) continue;
      if (!out[p]) out[p] = [];
      for (let i = 0; i < n; i++) {
        if (!out[p].some((x) => x.key === i + 1)) out[p].push({ key: i + 1, status: 'unknown', note: '', at: '', lastOk: '' });
      }
      out[p].sort((a, b) => a.key - b.key);
    }
  } catch (e) {}
  return out;
}
// ---- Groq token usage (live remaining per key) ----
// Groq has no public quota API, so the server tracks chat tokens itself:
// every Groq chat completion returns usage.total_tokens, which is
// recorded per key (by 1-based index) per day. Free tier = 200,000
// tokens/day per key (the quota the owner already knows from x1One).
// Whisper (audio transcription) returns no token usage, so it is NOT
// counted here — this display covers chat/text tokens (AI Chat +
// translation) only. Persisted to groq-usage.json so it survives
// restarts; the day rolls over in Phnom Penh time. Key VALUES are never
// stored or exposed — only the 1-based index + counts.
const GROQ_USAGE_FILE = path.join(DATA_DIR, 'groq-usage.json');
const GROQ_DAILY_LIMIT = 200000;
let _groqUsage = null;
function groqUsageLoad() {
  if (_groqUsage && typeof _groqUsage === 'object') return _groqUsage;
  try { const j = JSON.parse(fs.readFileSync(GROQ_USAGE_FILE, 'utf8')); if (j && typeof j === 'object' && typeof j.date === 'string') { _groqUsage = j; return _groqUsage; } } catch (e) {}
  _groqUsage = { date: '', keys: {} };
  return _groqUsage;
}
function groqUsageSave() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(GROQ_USAGE_FILE, JSON.stringify(_groqUsage, null, 2)); ghPersistFile(GROQ_USAGE_FILE); } catch (e) {}
}
function groqUsageTodayDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
}
function recordGroqTokens(keyValue, totalTokens) {
  try {
    const n = Number(totalTokens) || 0;
    if (n <= 0) return;
    const today = groqUsageTodayDate();
    const u = groqUsageLoad();
    if (u.date !== today) { u.date = today; u.keys = {}; }
    const list = adminProviderKeyList('groq');
    let idx = -1;
    for (let i = 0; i < list.length; i++) { if (list[i].key === keyValue) { idx = i; break; } }
    if (idx < 0) return; // request-provided key, not an admin-stored one
    const k = String(idx);
    const prev = (u.keys[k] && Number(u.keys[k].used)) || 0;
    u.keys[k] = { used: prev + n };
    groqUsageSave();
  } catch (e) {}
}
function groqUsageList() {
  // Returns {date, dailyLimit, keys:[{key, usedToday, remainingToday,
  // percentRemaining, status}]} — status: green (>50% left), yellow
  // (<=50% left, still >0), red (0 left / exhausted). Keys are 1-based.
  const today = groqUsageTodayDate();
  const u = groqUsageLoad();
  if (u.date !== today) { u.date = today; u.keys = {}; }
  const n = adminProviderKeyList('groq').length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const used = (u.keys[String(i)] && Number(u.keys[String(i)].used)) || 0;
    const remaining = Math.max(0, GROQ_DAILY_LIMIT - used);
    const pct = Math.round((remaining / GROQ_DAILY_LIMIT) * 100);
    const status = remaining <= 0 ? 'red' : (pct <= 50 ? 'yellow' : 'green');
    out.push({ key: i + 1, usedToday: used, remainingToday: remaining, percentRemaining: pct, status });
  }
  return { date: today, dailyLimit: GROQ_DAILY_LIMIT, keys: out };
}
// ---- MVSEP stem separation usage (per-key daily count) ----
// MVSEP has no quota API, so the server counts its own successful
// separations per key (by 1-based index) per day. Free Registered plan =
// 50 separations/day per key. Persisted to mvsep-usage.json so it
// survives restarts; the day rolls over in Phnom Penh time. Key VALUES
// are never stored or exposed — only the 1-based index + counts.
const MVSEP_USAGE_FILE = path.join(DATA_DIR, 'mvsep-usage.json');
const MVSEP_DAILY_LIMIT = 50;
let _mvsepUsage = null;
function mvsepUsageLoad() {
  if (_mvsepUsage && typeof _mvsepUsage === 'object') return _mvsepUsage;
  try { const j = JSON.parse(fs.readFileSync(MVSEP_USAGE_FILE, 'utf8')); if (j && typeof j === 'object' && typeof j.date === 'string') { _mvsepUsage = j; return _mvsepUsage; } } catch (e) {}
  _mvsepUsage = { date: '', keys: {} };
  return _mvsepUsage;
}
function mvsepUsageSave() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(MVSEP_USAGE_FILE, JSON.stringify(_mvsepUsage, null, 2)); ghPersistFile(MVSEP_USAGE_FILE); } catch (e) {}
}
function mvsepUsageTodayDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
}
function recordMvsepSeparation(keyValue, hash) {
  try {
    if (hash) {
      if (_mvsepCountedHashes.has(hash)) return; // already counted — never count one separation twice
      if (_mvsepCountedHashes.size > 10000) _mvsepCountedHashes.clear();
      _mvsepCountedHashes.add(hash);
    }
    const today = mvsepUsageTodayDate();
    const u = mvsepUsageLoad();
    if (u.date !== today) { u.date = today; u.keys = {}; }
    const list = adminProviderKeyList('mvsep');
    let idx = -1;
    for (let i = 0; i < list.length; i++) { if (list[i].key === keyValue) { idx = i; break; } }
    if (idx < 0) return; // not an admin-stored key
    const k = String(idx);
    const prev = (u.keys[k] && Number(u.keys[k].used)) || 0;
    u.keys[k] = { used: prev + 1 };
    mvsepUsageSave();
  } catch (e) {}
}
function mvsepUsageList() {
  // Returns {date, dailyLimit, keys:[{key, usedToday, remainingToday,
  // status}]} — status: green (separations left), red (0 left / daily
  // limit reached). Keys are 1-based.
  const today = mvsepUsageTodayDate();
  const u = mvsepUsageLoad();
  if (u.date !== today) { u.date = today; u.keys = {}; }
  const n = adminProviderKeyList('mvsep').length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const used = (u.keys[String(i)] && Number(u.keys[String(i)].used)) || 0;
    const remaining = Math.max(0, MVSEP_DAILY_LIMIT - used);
    out.push({ key: i + 1, usedToday: used, remainingToday: remaining, status: remaining <= 0 ? 'red' : 'green' });
  }
  return { date: today, dailyLimit: MVSEP_DAILY_LIMIT, keys: out };
}
// ---- MVSEP stem separation (Demucs4 HT) ----
// Official API (mvsep.com/en/full_api + ZFTurbo/MVSep-API-Examples):
// Create: POST https://mvsep.com/api/separation/create with multipart
// form fields api_token, url (audio link — no file upload), sep_type=20,
// add_opt1=0, output_format=0. Response {success, data:{hash, link}}.
// Poll: GET https://mvsep.com/api/separation/get?hash=<hash> until
// data.files appears: [{url, download}] — download is the stem filename
// (e.g. vocals.mp3). sep_type 20 = Demucs4 HT (vocals, drums, bass,
// other); add_opt1 0 = htdemucs_ft (High Quality, Slow). output_format 0
// = mp3 320kbps. Free Registered plan: 50 separations/day per key, audio
// <=10 min, file <=100 MB, 1 concurrent job. The server never stores
// stem files — it returns MVSEP's download URLs and the website fetches
// them directly. Key VALUES are never logged or returned.
const MVSEP_CREATE_URL = 'https://mvsep.com/api/separation/create';
const MVSEP_GET_URL = 'https://mvsep.com/api/separation/get';
const MVSEP_SEP_TYPE = 20;
const MVSEP_MODEL_OPT = 0; // htdemucs_ft
const MVSEP_POLL_INTERVAL_MS = 10000;
const MVSEP_POLL_TIMEOUT_MS = 240000; // 4 min server-side; the Studio resumes longer jobs via /api/studio/separate/status
const MVSEP_STEM_ORDER = ['vocals', 'drums', 'bass', 'other', 'piano', 'guitar'];
// hash -> key value that created it (in-memory only; used to count a
// separation against the right key when it finishes via the status
// endpoint after a poll timeout).
const _mvsepHashKey = new Map();
// Hashes already counted, so one separation is never counted twice (e.g.
// if the Studio checks the status of a separation that already succeeded
// through /api/studio/separate). In-memory only; capped so it cannot
// grow without bound.
const _mvsepCountedHashes = new Set();
function mvsepStemNameFromFile(download) {
  const base = String(download || '').toLowerCase().replace(/\\+/g, '/').split('/').pop().replace(/\.[a-z0-9]+$/, '');
  // Filenames look like "vocals.mp3" or "<title>_vocals.mp3" — match the stem keyword inside.
  for (const name of MVSEP_STEM_ORDER) { if (base.includes(name)) return name; }
  if (base.includes('instrumental') || base.includes('instrum') || base.includes('music')) return 'other';
  return base ? base.slice(0, 40) : 'other';
}
function mvsepParseStems(files) {
  // files: [{url, download}] -> [{name, url}] in stem order, deduped by name.
  const out = [];
  const seen = {};
  for (const f of (Array.isArray(files) ? files : [])) {
    const url = f && typeof f.url === 'string' ? f.url.replace(/\\\//g, '/') : '';
    if (!url) continue;
    const name = mvsepStemNameFromFile(f.download);
    if (seen[name]) continue;
    seen[name] = true;
    out.push({ name, url });
  }
  out.sort((a, b) => {
    const ia = MVSEP_STEM_ORDER.indexOf(a.name); const ib = MVSEP_STEM_ORDER.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return out;
}
function mvsepErrText(j) {
  if (!j || typeof j !== 'object') return '';
  const d = j.data;
  if (typeof j.error === 'string' && j.error) return j.error;
  if (j.error && typeof j.error === 'object' && typeof j.error.message === 'string') return j.error.message;
  if (typeof j.message === 'string' && j.message) return j.message;
  if (typeof d === 'string' && d) return d;
  if (d && typeof d === 'object' && typeof d.error === 'string' && d.error) return d.error;
  if (d && typeof d === 'object' && typeof d.message === 'string' && d.message) return d.message;
  return '';
}
function mvsepIsSuccess(j) {
  // MVSEP documents success as boolean true, but the live API has
  // returned a created job (with hash) while the strict boolean check
  // failed — so treat true, "true" and 1 as success.
  if (!j || typeof j !== 'object') return false;
  return j.success === true || j.success === 'true' || j.success === 1;
}
function mvsepIsLimitText(s) {
  return /limit|quota|exceed|daily|too many/i.test(String(s || ''));
}
function mvsepQuotaErr(detail, httpStatus) {
  // Message MUST contain "quota" so _isRotatableError treats it as a
  // rotate-to-next-key error (the key's 50/day is spent).
  return rotErr('MVSEP quota exceeded — daily limit 50 reached for this key' + (detail ? ': ' + String(detail).slice(0, 120) : ''), httpStatus || 429);
}
async function mvsepCreateSeparation(keyValue, audioUrl) {
  // Upload the audio FILE itself (`audiofile`), exactly like the official
  // MVSEP API example. The `url` remote-fetch parameter returned HTTP 400
  // for every URL we tried (public MP3, MovAi proxy MP3, Cloudinary MP3),
  // so the server downloads the song into memory first and uploads it.
  // (In-memory Buffer only — no file is ever written to disk on Render,
  // same as the /api/mv/lyrics audio handling.)
  const au = await fetch(audioUrl, { signal: AbortSignal.timeout(90000) });
  if (!au.ok) throw new Error('MVSEP: could not download the song audio (HTTP ' + au.status + ')');
  const buf = Buffer.from(await au.arrayBuffer());
  if (!buf.length) throw new Error('MVSEP: the song audio is empty');
  if (buf.length > 100 * 1024 * 1024) throw new Error('MVSEP: the song is too large (over 100 MB)');
  const ct = au.headers.get('content-type') || 'audio/mpeg';
  const fname = String(audioUrl.split('/').pop().split('?')[0] || 'song.mp3').slice(0, 120) || 'song.mp3';
  const fd = new FormData();
  fd.append('api_token', keyValue);
  fd.append('audiofile', new Blob([buf], { type: ct }), fname);
  fd.append('sep_type', String(MVSEP_SEP_TYPE));
  fd.append('add_opt1', String(MVSEP_MODEL_OPT));
  fd.append('add_opt2', '');
  fd.append('output_format', '0');
  fd.append('is_demo', '0');
  const r = await fetch(MVSEP_CREATE_URL, { method: 'POST', body: fd, headers: { 'User-Agent': 'MovAi/1.0 (https://movai-1.onrender.com)' }, signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => null);
  const text = mvsepErrText(j) || ('HTTP ' + r.status);
  if (r.status === 429 || (j && j.success === false && mvsepIsLimitText(text))) throw mvsepQuotaErr(text, r.status);
  if (r.status === 401 || r.status === 403) throw rotErr('MVSEP: invalid API key (HTTP ' + r.status + ')', r.status);
  // The hash is the real proof of success — accept it whenever it is
  // present, even if the API returns success as a string or omits it.
  // (The live API returned "Job created successfully" WITH a hash, but
  // the old strict j.success === true check rejected it, so Split (AI)
  // failed on the user's phone even though the job was created.)
  const hash = (j && j.data && typeof j.data.hash === 'string' && j.data.hash) || (j && typeof j.hash === 'string' && j.hash) || '';
  if (hash) return hash;
  if (!r.ok || !j || !mvsepIsSuccess(j)) throw new Error('MVSEP: ' + text);
  throw new Error('MVSEP: no separation hash returned');
}
async function mvsepGetSeparation(hash) {
  // GET .../separation/get?hash=<hash> — no api_token needed (the official
  // example passes only the hash). Returns {done, stems} when the files
  // are ready, {done:false} while still processing, and THROWS on a
  // failed separation.
  const r = await fetch(MVSEP_GET_URL + '?hash=' + encodeURIComponent(hash), { signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!j || typeof j !== 'object') throw new Error('MVSEP: bad status response (HTTP ' + r.status + ')');
  // Files are the real proof the separation is done — accept them
  // whenever they are present, even if success comes back as a string
  // or is omitted (same lenient rule as the create call).
  const files = j.data && Array.isArray(j.data.files) ? j.data.files : null;
  if (files) {
    const stems = mvsepParseStems(files);
    if (stems.length) return { done: true, stems };
    return { done: false };
  }
  // No files yet: only an explicit failure (success === false) throws;
  // anything else is still processing (the poll loop times out after
  // 4 minutes and the Studio resumes via the status endpoint).
  if (j.success === false) {
    const text = mvsepErrText(j) || ('HTTP ' + r.status);
    throw new Error('MVSEP separation failed: ' + text);
  }
  return { done: false };
}
async function mvsepSeparateWithKey(keyValue, audioUrl) {
  // Create + poll with ONE key. Only the create step can trigger key
  // rotation (quota errors); a poll timeout / failure is a plain error so
  // a second separation is never created (and no second quota spent).
  const hash = await mvsepCreateSeparation(keyValue, audioUrl);
  // Remember which key created this hash (in-memory) so a later status
  // check can count the separation against the right key.
  try { _mvsepHashKey.set(hash, keyValue); } catch (e) {}
  const deadline = Date.now() + MVSEP_POLL_TIMEOUT_MS;
  for (;;) {
    const res = await mvsepGetSeparation(hash);
    if (res.done) return { hash, stems: res.stems, keyUsed: keyValue };
    if (Date.now() >= deadline) {
      const e = new Error('MVSEP separation still processing after ' + Math.round(MVSEP_POLL_TIMEOUT_MS / 1000) + ' seconds');
      e.code = 'mvsep_timeout';
      e.hash = hash;
      throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, MVSEP_POLL_INTERVAL_MS));
  }
}
function _isRotatableError(e) {
  if (!e) return false;
  const st = e && e.httpStatus;
  if (st === 401 || st === 403 || st === 429) return true;
  const msg = String((e && e.message) || '').toLowerCase();
  return /insufficient|not[-\s]?enough|balance|credit|rate[-\s]?limit|quota|too many requests|unauthorized|forbidden/.test(msg);
}
// Try a provider's keys in order, starting from the remembered start
// index. fn(key, endpoint) must return a value on success or THROW on
// failure. On a credit/rate-limit/auth error the NEXT key is tried; any
// other error fails immediately without rotating. STRICT ROUND-ROBIN
// (owner order 2026-11-18): on success the pointer advances to the
// NEXT key, so usage spreads evenly across all keys (1 → 2 → 3 → 1 …).
// If every key fails with a credit/rate-limit/auth error, the LAST
// key's error is thrown. If the provider has no keys (and no request
// key), a 'no key configured' error (err.noKey = true) is thrown. Key
// values are never logged.
async function withProviderKeyRotation(provider, fn, reqKey, candidatesOverride) {
  const p = normProvider(provider);
  let candidates;
  if (Array.isArray(candidatesOverride)) {
    candidates = candidatesOverride;
  } else if (typeof reqKey === 'string' && reqKey.trim()) {
    candidates = [{ key: reqKey.trim(), endpoint: '' }];
  } else {
    candidates = adminProviderKeyList(p);
  }
  if (!candidates.length) {
    const err = new Error('no key configured');
    err.noKey = true;
    throw err;
  }
  const start = _keyRotationStart.get(p) || 0;
  const n = candidates.length;
  let lastErr = null;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const cand = candidates[idx];
    try {
      const out = await fn(cand.key, cand.endpoint);
      // STRICT ROUND-ROBIN (owner order 2026-11-18): after EVERY success
      // advance to the NEXT key, so the next call uses the next key
      // (1 → 2 → 3 → 1 …) instead of reusing this one. On a rotatable
      // error the loop below already tries the next key.
      _keyRotationStart.set(p, (idx + 1) % n);
      keyHealthSet(p, idx, 'ok', '');
      return out;
    } catch (e) {
      lastErr = e;
      if (!_isRotatableError(e)) throw e;
      keyHealthSet(p, idx, 'exhausted', String((e && e.message) || e).slice(0, 120));
      if (i < n - 1) console.log('[keys] ' + p + ' key ' + (idx + 1) + '/' + n + ' failed (' + String((e && e.message) || e).slice(0, 120) + '), trying next key');
    }
  }
  throw lastErr;
}

// ---- Auto Update Version New (top-level helpers) ----
// Watches provider model lists for NEW models/versions (e.g. Suno v6.5).
// When a new model appears: a pending update is created + the admin is
// notified (Telegram + in-admin 'update' notification). The admin Approves
// it or sets "Don't update" (blocks it forever). If Auto-Apply is ON and
// the admin does not decide within autoApplyHours, the system applies it
// by itself (and notifies the admin that it did). Approved models are
// served at GET /api/public/models so the website shows new models
// automatically with a "New" badge. Data: ./data/updates.json
// (GitHub-backed). Only providers with a real listable endpoint are
// auto-polled (Groq + NovAI /v1/models, Suno gateway /v1/models best
// effort); other providers are added manually by the admin.
const UPDATES_FILE = path.join(DATA_DIR, 'updates.json');
const UPDATES_SEED_MODELS = {
  groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
  novai: ['cogview-3-flash', 'cogvideox-flash'],
  suno: ['v6', 'v6-wild', 'v6-mini'],
  magichour: ['z-image-turbo', 'flux-2-klein', 'qwen-image-2.1', 'krea-2', 'gpt-image-2', 'nano-banana-2.1', 'nano-banana-pro', 'ltx-2.5', 'minimax-h3', 'kling-3.0', 'kling-4.0', 'veo-3.1', 'seedance-2.5'],
  musicapi: ['suno-v6'],
  tavus: [],
  acemusic: [],
  masterpiecex: [],
  hunyuan3d: [],
};
function loadUpdates() {
  try {
    const j = JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8'));
    if (j && typeof j === 'object') {
      if (!j.knownModels || typeof j.knownModels !== 'object') j.knownModels = {};
      if (!j.approvedModels || typeof j.approvedModels !== 'object') j.approvedModels = {};
      if (!Array.isArray(j.blockedModels)) j.blockedModels = [];
      if (!Array.isArray(j.updates)) j.updates = [];
      if (!j.settings || typeof j.settings !== 'object') j.settings = {};
      if (typeof j.settings.autoApply !== 'boolean') j.settings.autoApply = true;
      if (typeof j.settings.autoApplyHours !== 'number' || j.settings.autoApplyHours < 1) j.settings.autoApplyHours = 24;
      if (typeof j.settings.checkIntervalHours !== 'number' || j.settings.checkIntervalHours < 1) j.settings.checkIntervalHours = 6;
      for (const p of Object.keys(UPDATES_SEED_MODELS)) {
        if (!Array.isArray(j.approvedModels[p])) j.approvedModels[p] = UPDATES_SEED_MODELS[p].slice();
        if (!Array.isArray(j.knownModels[p])) j.knownModels[p] = UPDATES_SEED_MODELS[p].slice();
      }
      return j;
    }
  } catch (e) {}
  const d = { knownModels: {}, approvedModels: {}, blockedModels: [], updates: [], settings: { autoApply: true, autoApplyHours: 24, checkIntervalHours: 6 }, lastCheckAt: null, lastCheckResult: '' };
  for (const p of Object.keys(UPDATES_SEED_MODELS)) { d.approvedModels[p] = UPDATES_SEED_MODELS[p].slice(); d.knownModels[p] = UPDATES_SEED_MODELS[p].slice(); }
  return d;
}
function saveUpdates(u) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(UPDATES_FILE, JSON.stringify(u, null, 2));
  ghPersistFile(UPDATES_FILE);
}
function newUpdateId() { return 'upd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
// Fetch a provider's model list (array of model ids) or null when the
// provider has no listable endpoint.
async function fetchProviderModelList(provider) {
  const p = normProvider(provider);
  const timeoutMs = 15000;
  try {
    if (p === 'groq' || p === 'novai') {
      const url = p === 'groq' ? 'https://api.groq.com/openai/v1/models' : 'https://aiapi-pro.com/v1/models';
      const ids = await withProviderKeyRotation(p, async (k) => {
        const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const arr = Array.isArray(j && j.data) ? j.data : [];
        return arr.map((x) => (x && typeof x.id === 'string' ? x.id.trim() : '')).filter(Boolean);
      });
      return ids;
    }
    if (p === 'suno') {
      const list = adminProviderKeyList('suno');
      const ep = list.length && typeof list[0].endpoint === 'string' ? list[0].endpoint.replace(/\/+$/, '') : '';
      if (!ep) return null;
      const key = list[0].key;
      for (const suffix of ['/v1/models', '/api/models']) {
        try {
          const r = await fetch(ep + suffix, { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
          if (r.status !== 200) continue;
          const j = await r.json();
          const arr = Array.isArray(j && j.data) ? j.data : (Array.isArray(j && j.models) ? j.models : []);
          const ids = arr.map((x) => (typeof x === 'string' ? x.trim() : (x && typeof x.id === 'string' ? x.id.trim() : ''))).filter(Boolean);
          if (ids.length) return ids;
        } catch (e) {}
      }
      return null;
    }
  } catch (e) { return null; }
  return null;
}
// One full check: poll listable providers, record any NEW model as a
// pending update + notify the admin. Returns the number of new models.
async function autoUpdateCheckModels() {
  const u = loadUpdates();
  let added = 0;
  for (const p of ['groq', 'novai', 'suno']) {
    const ids = await fetchProviderModelList(p);
    if (!ids) continue;
    if (!Array.isArray(u.knownModels[p])) u.knownModels[p] = [];
    for (const id of ids) {
      if (u.knownModels[p].includes(id)) continue;
      u.knownModels[p].push(id);
      const blockedKey = p + ':' + id;
      if (u.blockedModels.includes(blockedKey)) continue;
      const already = u.updates.find((x) => x.provider === p && x.model === id && (x.status === 'pending' || x.status === 'approved' || x.status === 'auto-applied'));
      if (already) continue;
      const rec = { id: newUpdateId(), provider: p, model: id, status: 'pending', source: 'auto-detect', detectedAt: new Date().toISOString(), decidedAt: null, decidedBy: '', note: '' };
      u.updates.unshift(rec);
      added++;
      addNotification('update', '', '🆕 Model ថ្មី · ' + p + ' — ' + id, 'Provider ' + p + ' មាន model ថ្មី៖ ' + id + '។ សូម Approve ឬដាក់ "មិនចាំបាច់ Update" ក្នុង Admin → Auto Update។ បើមិនឆ្លើយក្នុង ' + u.settings.autoApplyHours + ' ម៉ោង ហើយ Auto-Apply បើក វានឹង Update ដោយខ្លួនឯង។');
    }
  }
  u.lastCheckAt = new Date().toISOString();
  u.lastCheckResult = added ? ('រកឃើញ model ថ្មី ' + added) : 'មិនមាន model ថ្មីទេ';
  saveUpdates(u);
  await ghFlushFile(UPDATES_FILE);
  return added;
}
// Apply one update (add the model to the approved list shown on the
// website). decidedBy: 'admin' or 'auto'.
async function autoUpdateApplyUpdate(rec, decidedBy) {
  const u = loadUpdates();
  const r = u.updates.find((x) => x.id === rec.id);
  if (!r || r.status !== 'pending') return false;
  if (!Array.isArray(u.approvedModels[r.provider])) u.approvedModels[r.provider] = [];
  if (!u.approvedModels[r.provider].includes(r.model)) u.approvedModels[r.provider].push(r.model);
  r.status = decidedBy === 'auto' ? 'auto-applied' : 'approved';
  r.decidedAt = new Date().toISOString();
  r.decidedBy = decidedBy;
  saveUpdates(u);
  await ghFlushFile(UPDATES_FILE);
  const who = decidedBy === 'auto' ? 'ប្រព័ន្ធ Auto-Apply' : 'Admin';
  addNotification('update', '', '✅ Model ថ្មីបាន Update · ' + r.provider + ' — ' + r.model, who + ' បានអនុម័ត model ថ្មី៖ ' + r.model + '។ វាបង្ហាញក្នុង website ហើយ (New)។');
  return true;
}
// Hourly sweep: auto-apply pending updates older than autoApplyHours
// (when Auto-Apply is ON), then run a model check when due.
async function autoUpdateSweep() {
  try {
    const u = loadUpdates();
    if (u.settings.autoApply) {
      const now = Date.now();
      const cutoff = u.settings.autoApplyHours * 3600 * 1000;
      const due = u.updates.filter((x) => x.status === 'pending' && x.detectedAt && (now - new Date(x.detectedAt).getTime()) >= cutoff);
      for (const rec of due) {
        await autoUpdateApplyUpdate(rec, 'auto');
      }
    }
    const last = u.lastCheckAt ? new Date(u.lastCheckAt).getTime() : 0;
    if (Date.now() - last >= u.settings.checkIntervalHours * 3600 * 1000) {
      await autoUpdateCheckModels();
    }
  } catch (e) {}
}

/* --------------------------------- api ------------------------------------- */
// ---- Multi-user fairness + attack protection (FREE, in-memory) ----
// (1) Per-user generation rate limit: each Gmail may start at most
// GEN_LIMIT_PER_MIN generations per minute (image+video+song combined).
// One user can never hog the whole server — everyone gets a fair turn.
// (2) Per-provider create throttle: at most one new generation per
// provider every GEN_THROTTLE_MS — simultaneous creates are spread out
// in time (a queue) so the provider is never hit by 20 users at the
// exact same instant. A create waits at most GEN_THROTTLE_WAIT_MS.
// (3) Per-IP request rate limit + auto-block: every public request is
// counted per IP in a 60s window. Over IP_LIMIT_PER_MIN requests/min
// the IP is slowed (429). Over IP_BLOCK_PER_MIN it is auto-blocked at
// once (blocked-ips.json + 'security' notification) — the same block
// the admin-key attack guard uses. A request carrying the CORRECT
// admin key is never rate-limited or blocked by these guards, so the
// admin can never lock themselves out.
function isAdminKeyRequest(req) {
  try {
    const k = process.env.MOVAI_ADMIN_KEY;
    if (!k) return false;
    const h = String(req.headers['authorization'] || '');
    const m = /^Bearer\s+(.+)$/.exec(h);
    return !!(m && m[1] === k);
  } catch (e) { return false; }
}
const GEN_LIMIT_PER_MIN = 10;
const GEN_WINDOW_MS = 60 * 1000;
const _genRate = new Map();
function genRateCheck(email) {
  const now = Date.now();
  const key = email || 'guest';
  let rec = _genRate.get(key);
  if (!rec || (now - rec.windowStart) >= GEN_WINDOW_MS) { rec = { count: 0, windowStart: now }; _genRate.set(key, rec); }
  if (rec.count >= GEN_LIMIT_PER_MIN) {
    return { ok: false, waitSec: Math.ceil((GEN_WINDOW_MS - (now - rec.windowStart)) / 1000) };
  }
  rec.count += 1;
  return { ok: true };
}
const GEN_THROTTLE_MS = 800;
const GEN_THROTTLE_WAIT_MS = 20000;
const _genLastCreate = new Map();
async function genThrottle(provider) {
  const p = normProvider(provider) || 'unknown';
  const start = Date.now();
  for (;;) {
    const last = _genLastCreate.get(p) || 0;
    const now = Date.now();
    if (now - last >= GEN_THROTTLE_MS) { _genLastCreate.set(p, now); return true; }
    if (now - start >= GEN_THROTTLE_WAIT_MS) return false;
    await new Promise((r) => setTimeout(r, Math.min(200, GEN_THROTTLE_MS - (now - last))));
  }
}
const IP_LIMIT_PER_MIN = 120;
const IP_BLOCK_PER_MIN = 300;
const IP_WINDOW_MS = 60 * 1000;
const _ipRate = new Map();
function ipRateCheck(req) {
  const ip = getClientIp(req);
  if (!ip) return { ok: true };
  if (loadBlockedIps().some((b) => b === ip)) return { ok: false, blocked: true };
  const lockMs = adminLockoutRemainingMs(ip);
  if (lockMs > 0) return { ok: false, blocked: true, lockoutMs: lockMs };
  const now = Date.now();
  let rec = _ipRate.get(ip);
  if (!rec || (now - rec.windowStart) >= IP_WINDOW_MS) { rec = { count: 0, windowStart: now }; _ipRate.set(ip, rec); }
  rec.count += 1;
  if (rec.count > IP_BLOCK_PER_MIN) {
    _ipRate.delete(ip);
    const blocked = loadBlockedIps();
    if (!blocked.some((b) => b === ip)) {
      blocked.push(ip);
      saveBlockedIps(blocked);
      ghFlushFile(BLOCKED_IPS_FILE).catch(() => {});
      addNotification('security', '', '🚫 វាយប្រហារ · Auto-blocked attack', 'IP ' + ip + ' request ' + rec.count + ' ដងក្នុង 1 នាទី (spam/DDoS) — ត្រូវបានប្លុកដោយអូតូ');
    }
    return { ok: false, blocked: true };
  }
  if (rec.count > IP_LIMIT_PER_MIN) return { ok: false, rateLimited: true, retryAfter: Math.ceil((IP_WINDOW_MS - (now - rec.windowStart)) / 1000) };
  return { ok: true };
}
// Block enforcement for generation (defense in depth): a blocked Gmail or
// a blocked IP cannot generate even if they somehow hold a session (e.g.
// they were logged in before the Admin blocked them). The website enforces
// the block at login (sync rejection); this stops generation directly.
// Returns an error string to send, or '' when the request may proceed.
// The model block is enforced at sync/login only (gen requests do not
// reliably carry the device model).
function genBlockedCheck(email, req) {
  try {
    const em = normEmail(email);
    if (em && loadBlockedEmails().some((b) => b === em)) return 'គណនីនេះត្រូវបានប្លុក · This account is blocked';
    const ip = getClientIp(req);
    if (ip && loadBlockedIps().some((b) => b === ip)) return 'គណនីនេះត្រូវបានប្លុក · This account is blocked';
  } catch (e) {}
  return '';
}
// Enforce the per-user generation rate limit + the per-provider create
// throttle for one generation create. Returns an error string to send,
// or '' when the request may proceed.
async function genFairnessGate(email, provider) {
  const gr = genRateCheck(email);
  if (!gr.ok) return 'បង្កើតច្រើនពេក — សូមរង់ចាំ ' + gr.waitSec + ' វិនាទី · Too many generations, please wait ' + gr.waitSec + 's';
  const th = await genThrottle(provider);
  if (!th) return 'Server រវល់ — សូមសាកល្បងម្តងទៀត · Server is busy, please try again';
  return '';
}
// ---- Suno (sunoapi.org) ----
// sunoapi.org API (verified 2026-11-16 from docs.sunoapi.org):
// generate POST {endpoint}/api/v1/generate (customMode, instrumental,
// callBackUrl, model V6/V6_WILD/V6_MINI); status GET
// {endpoint}/api/v1/generate/record-info?taskId=...; credit GET
// {endpoint}/api/v1/generate/credit. The gateway REQUIRES a callBackUrl
// and calls it at stages text / first / complete.
const SUNO_CALLBACK_URL = process.env.SUNO_CALLBACK_URL || 'https://movai-proxy.onrender.com/api/suno/callback';
// Latest callback result per taskId: {status, songs, preview, updatedAt}.
// In-memory only (a restart loses it — the status handler then falls
// back to polling record-info, so nothing breaks).
const sunoCallbacks = new Map();
function sunoApiModel(m) {
  const s = String(m || '').trim().toLowerCase();
  if (s === 'v6-wild' || s === 'v6_wild') return 'V6_WILD';
  if (s === 'v6-mini' || s === 'v6_mini') return 'V6_MINI';
  return 'V6';
}
// sunoapi.org puts its error text in `msg` (genErrText does not read it).
function sunoErrText(j, fb) {
  if (j && typeof j.msg === 'string' && j.msg) return j.msg;
  return genErrText(j, fb);
}
// Extract playable songs from a record-info / callback data object.
function sunoSongsFromData(d) {
  const resp = (d && d.response) || {};
  const arr = Array.isArray(resp.sunoData) ? resp.sunoData : (Array.isArray(d && d.sunoData) ? d.sunoData : []);
  return arr.filter((c) => c && typeof c.audio_url === 'string' && c.audio_url).map((c) => ({
    url: c.audio_url,
    title: typeof c.title === 'string' ? c.title : '',
    image: typeof c.image_url === 'string' ? c.image_url : '',
    duration: typeof c.duration === 'number' ? c.duration : 0,
  }));
}
function sunoPreviewFromData(d) {
  const resp = (d && d.response) || {};
  const arr = Array.isArray(resp.sunoData) ? resp.sunoData : (Array.isArray(d && d.sunoData) ? d.sunoData : []);
  const first = arr.find((c) => c && (c.stream_audio_url || c.audio_url));
  return first ? (first.stream_audio_url || first.audio_url) : '';
}
function apiRoute(req, res, urlPath) {
  // Attack protection: count this IP's requests (all /api/* + /uploads/*).
  // A correct admin key is never rate-limited or blocked here (the admin
  // can never lock themselves out — see isAdminKeyRequest).
  if (!isAdminKeyRequest(req)) {
    const ipc = ipRateCheck(req);
    if (!ipc.ok) {
      if (ipc.blocked) {
        const rem = ipc.lockoutMs || 0;
        const err = rem > 0 ? ('គណនីនេះត្រូវបានប្លុក ' + lockoutTextKm(rem) + 'ទៀត · This account is blocked for ' + lockoutTextEn(rem) + ' more') : 'គណនីនេះត្រូវបានប្លុក · This account is blocked';
        return sendJSON(res, 200, { ok: false, error: err });
      }
      if (ipc.rateLimited) { try { res.setHeader('Retry-After', String(ipc.retryAfter || 60)); } catch (e) {} return sendJSON(res, 429, { ok: false, error: 'Request ច្រើនពេក — សូមរង់ចាំ ' + (ipc.retryAfter || 60) + ' វិនាទី · Too many requests, please wait' }); }
    }
  }
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
        if (!normEmail(body.email)) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
        const provider = body.provider;
        const _gateErr = await genFairnessGate(normEmail(body.email), provider);
        if (_gateErr) return sendJSON(res, 200, { ok: false, error: _gateErr });
        const _blkErr = genBlockedCheck(normEmail(body.email), req);
        if (_blkErr) return sendJSON(res, 200, { ok: false, error: _blkErr });
        const key = typeof body.key === 'string' ? body.key : '';
        const prompt = body.prompt.trim().slice(0, 2000);
        const width = Math.max(64, Math.min(2048, Number(body.width) || 768));
        const height = Math.max(64, Math.min(2048, Number(body.height) || 768));
        // Server-side credit check (image): Magic Hour costs by model
        // (media credits). NovAI is free. Cloudflare/Gemini use the
        // user's own key, so no MovAi credit is charged.
        const IMAGE_COSTS = { 'z-image-turbo': 5, 'flux-2-klein': 5, 'qwen-image-2.1': 10, 'krea-2': 10, 'gpt-image-2': 50, 'nano-banana-2.1': 50, 'nano-banana-pro': 150 };
        let imgCost = 0;
        if (provider === 'magichour') {
          const _m = typeof body.model === 'string' ? body.model.trim() : '';
          imgCost = IMAGE_COSTS[_m] || 5;
        }
        if (imgCost > 0) {
          const _imgEm = normEmail(body.email);
          if (_imgEm) {
            const _imgUsers = loadUsers();
            const _imgU = _imgUsers[_imgEm];
            if (_imgU && Math.floor(numOr(_imgU.credits, 0)) < imgCost) {
              notifyOutOfCredit(_imgEm, 'media', Math.floor(numOr(_imgU.credits, 0)), imgCost);
              return sendJSON(res, 200, { ok: false, error: 'Image.Video Credit មិនគ្រប់ទេ · Not enough Image/Video Credits — សូមទិញ Credit បន្ថែម', needBuy: true, kind: 'media', balance: Math.floor(numOr(_imgU.credits, 0)), cost: imgCost });
            }
          }
        }
        if (provider === 'magichour') {
          // Magic Hour image via the admin-stored keys (browser sends no
          // key). Rotates to the next key when one is exhausted.
          const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 100) : 'z-image-turbo';
          // Deduct FIRST (before the provider call) so the user account,
          // the server, and the Admin all show the same reduced balance
          // the moment Generate is tapped. Refunded below if the provider fails.
          const _dedImg = await deductForGeneration(body.email, imgCost, 0, 'image:magichour:' + model);
          if (!_dedImg.ok) return sendJSON(res, 200, { ok: false, error: _dedImg.error || 'Credit មិនគ្រប់ទេ', needBuy: true, kind: 'media', balance: _dedImg.balance, cost: imgCost });
          let out;
          try {
            out = await withProviderKeyRotation('magichour', async (k) => {
              const r = await fetch('https://api.magichour.ai/v1/ai-image-generator', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MovAi image', model, style: { prompt } }), signal: AbortSignal.timeout(60000) });
              const j = await r.json().catch(() => null);
              const id = j && j.id;
              if (id) return { jobId: id };
              throw rotErr('Magic Hour: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            }, key);
          } catch (e) {
            await refundForGeneration(body.email, imgCost, 0, 'image:magichour:' + model + ' failed');
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Magic Hour: request failed' });
          }
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, credits: _dedImg.credits, songCredits: _dedImg.songCredits });
        }
        if (provider === 'novai') {
          // NovAI image via the admin-stored keys (browser sends no key).
          // Rotates to the next key when one is exhausted.
          const size = Math.min(2048, Math.max(64, width)) + 'x' + Math.min(2048, Math.max(64, height));
          let out;
          try {
            out = await withProviderKeyRotation('novai', async (k) => {
              const r = await fetch('https://aiapi-pro.com/v1/images/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cogview-3-flash', prompt, size }), signal: AbortSignal.timeout(120000) });
              const j = await r.json().catch(() => null);
              const url = j && j.data && j.data[0] && j.data[0].url;
              if (url) return { done: true, imageUrl: url };
              const id = j && (j.id || (j.data && j.data.id));
              if (id) return { jobId: id };
              throw rotErr('NovAI: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            }, key);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ NovAI Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'NovAI: request failed' });
          }
          if (out.done) return sendJSON(res, 200, { ok: true, done: true, imageUrl: out.imageUrl });
          return sendJSON(res, 200, { ok: true, jobId: out.jobId });
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
          let out;
          try {
            out = await withProviderKeyRotation('magichour', async (k) => {
              const r = await fetch('https://api.magichour.ai/v1/image-projects/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              const st = j && j.status;
              if (st === 'complete') {
                const dl = j.downloads && j.downloads[0] && j.downloads[0].url;
                if (dl) return { status: 'done', imageUrl: dl };
                return { status: 'done', imageUrl: '', raw: j };
              }
              if (st === 'error') throw rotErr('Magic Hour: ' + ((j && j.error) || 'បង្កើតមិនបានទេ'), r.status);
              return { status: 'working', providerStatus: st || 'queued' };
            }, body.key);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Magic Hour: request failed' });
          }
          return sendJSON(res, 200, Object.assign({ ok: true }, out));
        }
        if (provider === 'novai') {
          let out;
          try {
            out = await withProviderKeyRotation('novai', async (k) => {
              const r = await fetch('https://aiapi-pro.com/v1/images/generations/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              const url = j && j.data && j.data[0] && j.data[0].url;
              if (url) return { status: 'done', imageUrl: url };
              const st = j && (j.status || (j.data && j.data.status));
              if (st === 'failed' || st === 'error') throw rotErr('NovAI: បង្កើតមិនបានទេ', r.status);
              return { status: 'working', providerStatus: st || 'queued' };
            }, body.key);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ NovAI Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'NovAI: request failed' });
          }
          return sendJSON(res, 200, Object.assign({ ok: true }, out));
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
        if (!normEmail(body.email)) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
        const provider = body.provider;
        const _gateErr = await genFairnessGate(normEmail(body.email), provider);
        if (_gateErr) return sendJSON(res, 200, { ok: false, error: _gateErr });
        const _blkErr = genBlockedCheck(normEmail(body.email), req);
        if (_blkErr) return sendJSON(res, 200, { ok: false, error: _blkErr });
        const reqKey = typeof body.key === 'string' ? body.key : '';
        const prompt = body.prompt.trim().slice(0, 4000);
        const duration = [5, 10].includes(Number(body.duration)) ? Number(body.duration) : 5;
        // Server-side credit check (video): Magic Hour costs 10 media
        // credits per second. NovAI is free. Tavus/HF are not charged
        // here (Tavus removed from the website; HF uses the user's key).
        let vidCost = 0;
        if (provider === 'magichour') vidCost = 10 * duration;
        if (vidCost > 0) {
          const _vidEm = normEmail(body.email);
          if (_vidEm) {
            const _vidUsers = loadUsers();
            const _vidU = _vidUsers[_vidEm];
            if (_vidU && Math.floor(numOr(_vidU.credits, 0)) < vidCost) {
              notifyOutOfCredit(_vidEm, 'media', Math.floor(numOr(_vidU.credits, 0)), vidCost);
              return sendJSON(res, 200, { ok: false, error: 'Image.Video Credit មិនគ្រប់ទេ · Not enough Image/Video Credits — សូមទិញ Credit បន្ថែម', needBuy: true, kind: 'media', balance: Math.floor(numOr(_vidU.credits, 0)), cost: vidCost });
            }
          }
        }
        // No key at all (no request key and no admin key for this
        // provider): same message as before. Rotation happens per branch.
        if (!reqKey.trim() && !adminProviderKeyList(provider).length) {
          const pname = provider === 'novai' ? 'NovAI' : provider === 'magichour' ? 'Magic Hour' : provider === 'tavus' ? 'Tavus' : null;
          return sendJSON(res, 200, { ok: false, error: pname ? ('Admin មិនទាន់ដាក់ ' + pname + ' Key ទេ') : 'មិនទាន់មាន API Key ទេ' });
        }
        const key = reqKey; // hf (request-key only) still uses the raw key
        if (provider === 'novai') {
          let out;
          try {
            out = await withProviderKeyRotation('novai', async (k) => {
              const r = await fetch('https://aiapi-pro.com/v1/video/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cogvideox-flash', prompt }), signal: AbortSignal.timeout(60000) });
              const j = await r.json().catch(() => null);
              if (j && j.id) return { jobId: j.id };
              throw rotErr('NovAI: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            }, reqKey);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ NovAI Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'NovAI: request failed' });
          }
          return sendJSON(res, 200, { ok: true, jobId: out.jobId });
        }
        if (provider === 'magichour') {
          const width = Number(body.width) || 768;
          const height = Number(body.height) || 432;
          const aspect = width >= height ? '16:9' : '9:16';
          const resName = { 480: '480p', 720: '720p', 1080: '1080p', 4000: '4k' }[Number(body.res)] || '720p';
          // Deduct FIRST (before the provider call) so the user account,
          // the server, and the Admin all show the same reduced balance
          // the moment Generate is tapped. Refunded below if the provider fails.
          const _dedVid = await deductForGeneration(body.email, vidCost, 0, 'video:magichour:' + duration + 's');
          if (!_dedVid.ok) return sendJSON(res, 200, { ok: false, error: _dedVid.error || 'Credit មិនគ្រប់ទេ', needBuy: true, kind: 'media', balance: _dedVid.balance, cost: vidCost });
          let out;
          try {
            out = await withProviderKeyRotation('magichour', async (k) => {
              const r = await fetch('https://api.magichour.ai/v1/text-to-video', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MovAi video', end_seconds: duration, aspect_ratio: aspect, resolution: resName, model: 'default', style: { prompt } }), signal: AbortSignal.timeout(60000) });
              const j = await r.json().catch(() => null);
              if (j && j.id) return { jobId: j.id };
              throw rotErr('Magic Hour: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            }, reqKey);
          } catch (e) {
            await refundForGeneration(body.email, vidCost, 0, 'video:magichour:' + duration + 's failed');
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Magic Hour: request failed' });
          }
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, credits: _dedVid.credits, songCredits: _dedVid.songCredits });
        }
        if (provider === 'tavus') {
          const replicaId = String(body.replicaId || '').trim();
          if (!replicaId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Tavus Replica ID (Face ID) ជាមុនសិន' });
          let out;
          try {
            out = await withProviderKeyRotation('tavus', async (k) => {
              const r = await fetch('https://tavusapi.com/v2/videos', { method: 'POST', headers: { 'x-api-key': k, 'Content-Type': 'application/json' }, body: JSON.stringify({ replica_id: replicaId, script: prompt, video_name: 'MovAi video' }), signal: AbortSignal.timeout(60000) });
              const j = await r.json().catch(() => null);
              if (j && j.video_id) return { jobId: j.video_id };
              throw rotErr('Tavus: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            }, reqKey);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Tavus Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Tavus: request failed' });
          }
          return sendJSON(res, 200, { ok: true, jobId: out.jobId });
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
        const reqKey = typeof body.key === 'string' ? body.key : '';
        const jobId = String(body.jobId || '');
        if (!jobId) return sendJSON(res, 200, { ok: false, error: 'មិនមាន jobId ទេ' });
        if (!reqKey.trim() && !adminProviderKeyList(provider).length) {
          const pname = provider === 'novai' ? 'NovAI' : provider === 'magichour' ? 'Magic Hour' : provider === 'tavus' ? 'Tavus' : null;
          return sendJSON(res, 200, { ok: false, error: pname ? ('Admin មិនទាន់ដាក់ ' + pname + ' Key ទេ') : 'មិនទាន់មាន API Key ទេ' });
        }
        if (provider === 'novai') {
          let out;
          try {
            out = await withProviderKeyRotation('novai', async (k) => {
              const r = await fetch('https://aiapi-pro.com/v1/video/generations/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              const st = j && (j.status || (j.data && j.data.status));
              if (st === 'succeeded') {
                const url = j && (j.url || j.video_url || (j.data && (j.data.url || j.data.video_url)) || (j.output && j.output.url) || (j.result && j.result.url));
                if (url) return { status: 'done', videoUrl: url };
                return { status: 'done', videoUrl: '', raw: j };
              }
              if (st === 'failed') throw rotErr('NovAI: បង្កើតមិនបានទេ', r.status);
              return { status: 'working', providerStatus: st || 'queued' };
            }, reqKey);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ NovAI Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'NovAI: request failed' });
          }
          return sendJSON(res, 200, Object.assign({ ok: true }, out));
        }
        if (provider === 'magichour') {
          let out;
          try {
            out = await withProviderKeyRotation('magichour', async (k) => {
              const r = await fetch('https://api.magichour.ai/v1/video-projects/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              const st = j && j.status;
              if (st === 'complete') {
                const dl = j.downloads && j.downloads[0] && j.downloads[0].url;
                if (dl) return { status: 'done', videoUrl: dl };
                return { status: 'done', videoUrl: '', raw: j };
              }
              if (st === 'error') throw rotErr('Magic Hour: ' + ((j && j.error) || 'បង្កើតមិនបានទេ'), r.status);
              return { status: 'working', providerStatus: st || 'queued' };
            }, reqKey);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Magic Hour: request failed' });
          }
          return sendJSON(res, 200, Object.assign({ ok: true }, out));
        }
        if (provider === 'tavus') {
          let out;
          try {
            out = await withProviderKeyRotation('tavus', async (k) => {
              const r = await fetch('https://tavusapi.com/v2/videos/' + encodeURIComponent(jobId), { headers: { 'x-api-key': k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              const st = j && j.status;
              if (st === 'ready') {
                if (j.download_url) return { status: 'done', videoUrl: j.download_url };
                return { status: 'done', videoUrl: '', raw: j };
              }
              if (st === 'error') throw rotErr('Tavus: បង្កើតមិនបានទេ', r.status);
              return { status: 'working', providerStatus: st || 'queued' };
            }, reqKey);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Tavus Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Tavus: request failed' });
          }
          return sendJSON(res, 200, Object.assign({ ok: true }, out));
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/suno/callback — PUBLIC (no admin key). sunoapi.org calls
  // this when a generation changes stage (text / first / complete).
  // We store the result by taskId so /api/gen/song/status can answer
  // instantly; polling record-info remains the fallback. Always
  // answers 200 — a non-200 makes the gateway report CALLBACK_EXCEPTION.
  if (req.method === 'POST' && urlPath === '/api/suno/callback') {
    readJSONBody(req, 256 * 1024).then((body) => {
      try {
        const d = (body && body.data) || body || {};
        const taskId = typeof d.taskId === 'string' && d.taskId ? d.taskId : (typeof body.taskId === 'string' ? body.taskId : '');
        if (taskId) {
          const st = typeof d.status === 'string' ? d.status : '';
          sunoCallbacks.set(taskId, { status: st, songs: sunoSongsFromData(d), preview: sunoPreviewFromData(d), updatedAt: Date.now() });
          if (sunoCallbacks.size > 200) { const k = sunoCallbacks.keys().next().value; sunoCallbacks.delete(k); }
        }
      } catch (e) {}
      return sendJSON(res, 200, { code: 200, msg: 'ok' });
    }).catch(() => sendJSON(res, 200, { code: 200, msg: 'ok' }));
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
        const _gateErr = await genFairnessGate(normEmail(body.email), provider);
        if (_gateErr) return sendJSON(res, 200, { ok: false, error: _gateErr });
        const _blkErr = genBlockedCheck(normEmail(body.email), req);
        if (_blkErr) return sendJSON(res, 200, { ok: false, error: _blkErr });
        const reqKey = typeof body.key === 'string' ? body.key : '';
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
        const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim().slice(0, 4000) : '';
        const style = typeof body.style === 'string' ? body.style.trim().slice(0, 500) : '';
        const voice = body.voice === 'male' || body.voice === 'female' ? body.voice : 'random';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : '';
        const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 50) : 'v6';
        if (!title && !lyrics && !style && !prompt) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        // Require a logged-in account: without an email the server cannot
        // check or deduct credit, so the generation would be FREE (guest
        // loophole). Block it instead of letting it through.
        if (!normEmail(body.email)) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
        // Server-side credit check: a song costs 12 Song Credits. If the
        // user cannot pay, fail BEFORE calling the provider (so the admin's
        // provider account is never charged for a song the user cannot afford).
        // needBuy tells the website to offer buying more credit.
        // Song cost by provider (MovAi user credits):
        // - Suno: 12 Song Credits per generation (flat, 2 songs).
        // - Magic Hour: 60 per minute = 1 per second, by duration
        //   (2 min = 120, 3.5 min = 210). Variable, NOT flat.
        //   Deducts from the IMAGE.VIDEO (media) pool, NOT the song pool,
        //   because Magic Hour is a media provider.
        // - MusicAPI: 20 Song Credits per generation (flat, 2 songs).
        let SONG_COST = 12;
        let SONG_POOL = 'song';
        if (provider === 'musicapi') {
          SONG_COST = 20;
        } else if (provider === 'magichour') {
          const _d = numOr(body.duration, 0) || numOr(body.durationSeconds, 0) || numOr(body.duration_seconds, 0) || 0;
          let _secs = 120;
          if (_d > 0 && _d <= 5) _secs = Math.round(_d * 60);
          else if (_d >= 15 && _d <= 300) _secs = Math.round(_d);
          SONG_COST = Math.max(15, Math.min(300, _secs));
          SONG_POOL = 'media';
        }
        const _songEm = normEmail(body.email);
        if (_songEm) {
          const _songUsers = loadUsers();
          const _songU = _songUsers[_songEm];
          const _bal = SONG_POOL === 'media' ? Math.floor(numOr(_songU.credits, 0)) : Math.floor(numOr(_songU.songCredits, 0));
          if (_songU && _bal < SONG_COST) {
            const _err = SONG_POOL === 'media' ? 'Image.Video Credit មិនគ្រប់ទេ · Not enough Image/Video Credits — សូមទិញ Credit បន្ថែម' : 'Song Credit មិនគ្រប់ទេ · Not enough Song Credits — សូមទិញ Credit បន្ថែម';
            notifyOutOfCredit(_songEm, SONG_POOL, _bal, SONG_COST);
            return sendJSON(res, 200, { ok: false, error: _err, needBuy: true, kind: SONG_POOL, balance: _bal, cost: SONG_COST });
          }
        }
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
          // Deduct FIRST (before the provider call) so the user account,
          // the server, and the Admin all show the same reduced balance
          // the moment Generate is tapped. Refunded below if the provider fails.
          const _ded = await deductForGeneration(body.email, SONG_POOL === 'media' ? SONG_COST : 0, SONG_POOL === 'media' ? 0 : SONG_COST, 'song:' + provider);
          if (!_ded.ok) return sendJSON(res, 200, { ok: false, error: _ded.error || 'Credit មិនគ្រប់ទេ', needBuy: true, kind: SONG_POOL, balance: _ded.balance, cost: SONG_COST });
          let out;
          try {
            out = await withProviderKeyRotation('musicapi', async (k) => {
              const r = await fetch('https://api.musicapi.ai/api/v1/sonic/create', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(60000) });
              const j = await r.json().catch(() => null);
              const taskId = j && (j.task_id || (j.data && j.data.task_id));
              if (taskId) return { jobId: taskId };
              throw rotErr('MusicAPI: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            }, reqKey);
          } catch (e) {
            await refundForGeneration(body.email, SONG_POOL === 'media' ? SONG_COST : 0, SONG_POOL === 'media' ? 0 : SONG_COST, 'song:' + provider + ' failed');
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ MusicAPI Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'MusicAPI: request failed' });
          }
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, credits: _ded.credits, songCredits: _ded.songCredits });
        }
        if (provider === 'suno') {
          // Suno (MovAi) via sunoapi.org — the admin-stored gateway
          // endpoint + key. The browser sends no key and no endpoint —
          // both live on the server. Each stored Suno key carries its
          // own gateway endpoint; keys without an endpoint cannot be
          // called and are skipped. Rotates to the next key when one is
          // exhausted. sunoapi.org requires customMode + instrumental +
          // callBackUrl + model (V6/V6_WILD/V6_MINI).
          const sunoKeys = adminProviderKeyList('suno').filter((e) => e.endpoint);
          if (!sunoKeys.length) {
            if (!adminProviderKeyList('suno').length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
          }
          const genBody = {
            customMode: true,
            instrumental: false,
            callBackUrl: SUNO_CALLBACK_URL,
            model: sunoApiModel(model),
            style: (style || 'pop').slice(0, 1000),
            lyrics: (lyrics || prompt || '').slice(0, 5000),
            title: title.slice(0, 80),
          };
          if (voice === 'male') genBody.vocalGender = 'm';
          else if (voice === 'female') genBody.vocalGender = 'f';
          const _ded = await deductForGeneration(body.email, SONG_POOL === 'media' ? SONG_COST : 0, SONG_POOL === 'media' ? 0 : SONG_COST, 'song:' + provider);
          if (!_ded.ok) return sendJSON(res, 200, { ok: false, error: _ded.error || 'Credit មិនគ្រប់ទេ', needBuy: true, kind: SONG_POOL, balance: _ded.balance, cost: SONG_COST });
          let out;
          try {
            out = await withProviderKeyRotation('suno', async (k, endpoint) => {
              const ep = endpoint.replace(/\/+$/, '');
              const r = await fetch(ep + '/api/v1/generate', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(genBody), signal: AbortSignal.timeout(60000) });
              const j = await r.json().catch(() => null);
              const data = (j && j.data) || {};
              const taskId = typeof data.taskId === 'string' ? data.taskId : '';
              if (j && j.code === 200 && taskId) return { jobId: taskId };
              throw rotErr('Suno: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
            }, '', sunoKeys);
          } catch (e) {
            await refundForGeneration(body.email, SONG_POOL === 'media' ? SONG_COST : 0, SONG_POOL === 'media' ? 0 : SONG_COST, 'song:' + provider + ' failed');
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno: request failed' });
          }
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, credits: _ded.credits, songCredits: _ded.songCredits });
        }
        if (provider === 'magichour') {
          // Magic Hour music — POST /v1/ai-music-generator.
          // duration 15-300s, 1 credit/sec. style: {instrumental, lyrics, prompt}.
          // Returns a project id; poll GET /v1/audio-projects/{id}.
          const instrumental = body.instrumental === true || body.make_instrumental === true;
          // The website sends duration in MINUTES (picker: 1, 2, 3, 3.5, 5).
          // Magic Hour wants SECONDS (15-300). Convert minutes to seconds.
          // A small value (<= 5) is minutes; 15-300 is already seconds.
          let mhDuration = 120;
          if (typeof body.duration === 'number' && body.duration > 0) {
            const d = body.duration;
            if (d <= 5) mhDuration = Math.round(d * 60);
            else if (d >= 15 && d <= 300) mhDuration = Math.round(d);
          }
          if (mhDuration < 15) mhDuration = 15;
          if (mhDuration > 300) mhDuration = 300;
          const mhPromptParts = [];
          if (style) mhPromptParts.push(style);
          if (voice === 'male' && !instrumental) mhPromptParts.push('male vocals');
          else if (voice === 'female' && !instrumental) mhPromptParts.push('female vocals');
          if (title) mhPromptParts.push('titled "' + title + '"');
          const mhPrompt = mhPromptParts.join('. ').slice(0, 1000) || 'pop song';
          const mhBody = {
            name: (title || 'MovAi song').slice(0, 80),
            duration: mhDuration,
            style: {
              instrumental: instrumental,
              lyrics: lyrics.slice(0, 5000),
              prompt: mhPrompt,
            },
          };
          const _ded = await deductForGeneration(body.email, SONG_POOL === 'media' ? SONG_COST : 0, SONG_POOL === 'media' ? 0 : SONG_COST, 'song:' + provider);
          if (!_ded.ok) return sendJSON(res, 200, { ok: false, error: _ded.error || 'Credit មិនគ្រប់ទេ', needBuy: true, kind: SONG_POOL, balance: _ded.balance, cost: SONG_COST });
          let out;
          try {
            out = await withProviderKeyRotation('magichour', async (k) => {
              const r = await fetch('https://api.magichour.ai/v1/ai-music-generator', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(mhBody), signal: AbortSignal.timeout(60000) });
              const j = await r.json().catch(() => null);
              const id = j && typeof j.id === 'string' ? j.id : '';
              if (id) return { jobId: id };
              throw rotErr('Magic Hour: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            });
          } catch (e) {
            await refundForGeneration(body.email, SONG_POOL === 'media' ? SONG_COST : 0, SONG_POOL === 'media' ? 0 : SONG_COST, 'song:' + provider + ' failed');
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Magic Hour: request failed' });
          }
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, credits: _ded.credits, songCredits: _ded.songCredits });
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
        const reqKey = typeof body.key === 'string' ? body.key : '';
        const jobId = String(body.jobId || '');
        if (!jobId) return sendJSON(res, 200, { ok: false, error: 'មិនមាន jobId ទេ' });
        if (provider === 'suno') {
          // Suno status (sunoapi.org): first check the callback store
          // (the gateway calls /api/suno/callback when a stage
          // completes), then poll /api/v1/generate/record-info.
          // Keys without an endpoint cannot be called and are skipped.
          const sunoKeys = adminProviderKeyList('suno').filter((e) => e.endpoint);
          if (!sunoKeys.length) {
            if (!adminProviderKeyList('suno').length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
          }
          const cb = sunoCallbacks.get(jobId);
          if (cb && cb.status === 'SUCCESS' && cb.songs && cb.songs.length) {
            return sendJSON(res, 200, { ok: true, status: 'done', songs: cb.songs });
          }
          if (cb && cb.status === 'FIRST_SUCCESS' && cb.preview) {
            return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: 'first', preview: cb.preview, streamUrl: cb.preview });
          }
          let out;
          try {
            out = await withProviderKeyRotation('suno', async (k, endpoint) => {
              const ep = endpoint.replace(/\/+$/, '');
              const r = await fetch(ep + '/api/v1/generate/record-info?taskId=' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              if (r.status === 401 || r.status === 403 || r.status === 429) throw rotErr('Suno: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
              const d = (j && j.data) || null;
              if (!d || typeof d.status !== 'string') throw rotErr('Suno: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
              const st = d.status;
              if (st === 'SUCCESS') {
                const songs = sunoSongsFromData(d);
                if (songs.length) return { status: 'done', songs };
                throw rotErr('Suno: បង្កើតបានតែគ្មានបទទេ', r.status);
              }
              if (st === 'FIRST_SUCCESS') {
                const preview = sunoPreviewFromData(d);
                return { status: 'working', providerStatus: 'first', preview, streamUrl: preview };
              }
              if (st === 'PENDING' || st === 'TEXT_SUCCESS') return { status: 'working', providerStatus: 'queued' };
              throw rotErr('Suno: ' + (d.errorMessage || st || 'បង្កើតមិនបានទេ'), r.status);
            }, '', sunoKeys);
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno: request failed' });
          }
          return sendJSON(res, 200, Object.assign({ ok: true }, out));
        }
        if (provider === 'musicapi') {
          let out;
          try {
            out = await withProviderKeyRotation('musicapi', async (k) => {
              const r = await fetch('https://api.musicapi.ai/api/v1/sonic/task/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              if (j && (j.type === 'forbidden' || typeof j.error === 'string')) throw rotErr('MusicAPI: ' + genErrText(j, 'HTTP ' + r.status), r.status);
              const data = (j && j.data) || j || {};
              // MusicAPI real shape: {code:200, data:[{clip_id, state:'succeeded', title, audio_url, ...}, ...]}
              // The state lives INSIDE each clip in the data ARRAY — there is no top-level state.
              if (Array.isArray(data) && data.length) {
                const states = data.map((c) => (c && (c.state || c.status)) || '');
                const allDone = states.every((s) => s === 'succeeded' || s === 'success' || s === 'completed');
                if (allDone) {
                  const songs = [];
                  data.forEach((c) => { if (c && typeof c.audio_url === 'string' && c.audio_url) songs.push({ url: c.audio_url, title: typeof c.title === 'string' ? c.title : '' }); });
                  if (songs.length) return { status: 'done', songs };
                  return { status: 'done', songs: [], raw: j };
                }
                if (states.some((s) => s === 'failed' || s === 'error')) throw rotErr('MusicAPI: ' + genErrText(j, 'បង្កើតមិនបានទេ'), r.status);
                return { status: 'working', providerStatus: states.find((s) => s && s !== 'succeeded' && s !== 'success' && s !== 'completed') || 'queued' };
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
                if (songs.length) return { status: 'done', songs };
                return { status: 'done', songs: [], raw: j };
              }
              if (st === 'failed' || st === 'error') throw rotErr('MusicAPI: ' + genErrText(j, 'បង្កើតមិនបានទេ'), r.status);
              return { status: 'working', providerStatus: st || 'queued' };
            }, reqKey);
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ MusicAPI Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'MusicAPI: request failed' });
          }
          return sendJSON(res, 200, Object.assign({ ok: true }, out));
        }
        if (provider === 'magichour') {
          let out;
          try {
            out = await withProviderKeyRotation('magichour', async (k) => {
              const r = await fetch('https://api.magichour.ai/v1/audio-projects/' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              if (r.status === 401 || r.status === 403 || r.status === 429) throw rotErr('Magic Hour: ' + genErrText(j, 'HTTP ' + r.status), r.status);
              const st = j && typeof j.status === 'string' ? j.status : '';
              if (st === 'complete') {
                const songs = [];
                if (Array.isArray(j.downloads)) {
                  j.downloads.forEach((d) => { if (d && typeof d.url === 'string' && d.url) songs.push({ url: d.url, title: typeof j.name === 'string' ? j.name : '' }); });
                }
                if (songs.length) return { status: 'done', songs };
                return { status: 'done', songs: [], raw: j };
              }
              if (st === 'error') throw rotErr('Magic Hour: ' + genErrText(j, 'បង្កើតមិនបានទេ'), r.status);
              if (st === 'canceled') throw rotErr('Magic Hour: បទត្រូវបានលុបចោល', r.status);
              return { status: 'working', providerStatus: st || 'queued' };
            });
          } catch (e) {
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Magic Hour: request failed' });
          }
          return sendJSON(res, 200, Object.assign({ ok: true }, out));
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/gen/video/file?u=<encoded provider URL>&name=<optional filename> — proxy download (CORS workaround)
  if (req.method === 'GET' && urlPath === '/api/gen/video/file') {
    const qp = new URL(req.url, 'http://localhost').searchParams;
    const u = qp.get('u') || '';
    let target;
    try { target = new URL(u); } catch { res.writeHead(400); return res.end('Bad url'); }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') { res.writeHead(400); return res.end('Bad url'); }
    const rawName = (qp.get('name') || '').slice(0, 120);
    const safeName = rawName.replace(/[^A-Za-z0-9 ._-]/g, '_').replace(/\s+/g, ' ').trim() || 'movai-video.mp4';
    fetch(target.toString(), { signal: AbortSignal.timeout(300000) }).then(async (r) => {
      if (!r.ok) { res.writeHead(502); return res.end('Upstream ' + r.status); }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'video/mp4', 'Content-Disposition': 'attachment; filename="' + safeName.replace(/"/g, '') + '"', 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    }).catch(() => { try { res.writeHead(502); res.end('Fetch failed'); } catch {} });
    return;
  }
  // ---- AI Chat (MovAi assistant) ----
  // 5-stage pipeline, each stage a named helper so the flow is visible:
  // (1) chatLeaderValidate — leader/orchestrator: validate the message.
  // (2) chatReceiverContext — receiver: gather live server context.
  // (3) chatThinkerCallGroq — thinker: ask the Groq model (live, never canned).
  // (4) chatDirectReply — direct answer: return the model's raw reply.
  // (5) CHAT_SYSTEM_PROMPT — helper knowledge: the facts the model may use.
  // The AI NEVER uses pre-prepared answers — every reply is generated live
  // by the model from this prompt + the live context. The Groq key is the
  // ADMIN-STORED key (provider 'groq' in admin-keys.json); its value is
  // never logged and never returned by any endpoint.
  // MOVAI BOOK — the complete manual. Teach the AI everything about
  // the website like a new member, so it can answer any question about
  // how MovAi works. Use ONLY these facts. Never invent.
  const MOVAI_BOOK = [
    '1. WHAT MOVAI IS: MovAi is a website to create images, videos, 3D models and songs with AI. Users create with a prompt, download the result, and can post it to the Public feed.',
    '2. LOGIN: Google account ONLY. There is no "create account" page and no other login method. After first login a gift popup appears. The user must tap CLAIM to get FREE 250 Image/Video Credit + 24 Song Credit. If they do not tap CLAIM they stay at 0. If the Google account has no first and last name, the user must type both names before they can create. Every account gets a permanent 10-character User ID (shown in Profile with a Copy button). Guests can browse Public but cannot create, cannot use chat, cannot download.',
    '3. CREDITS (2 kinds, separate): Image/Video Credit (purple) is for images, videos and 3D. Song Credit (lime) is for songs only. A user gets credits from the gift CLAIM (250 media + 24 song, once), buying a package, or the admin granting them. Image costs: Magic Hour Z-Image Turbo 5, Flux 2 Klein 5, Qwen Image 2.1 10, Krea 2 10 Credit per image. NovAI image is free 10 times per day. Song costs: 12 Credit per generation = 2 songs (MovAi/Suno). Magic Hour music 60 Credit per minute. MusicAPI 20 Credit = 2 songs. Video costs depend on model and length. Free Magic Hour videos carry a watermark cover with "MovAi" + "YEM SOKHOEUN / Create by Owner". Package videos have no cover.',
    '4. PACKAGES (buy in the Packages sheet): Media (purple, Image/Video Credit only): Monthly $25 = 11,000 Credit, 30 days. Yearly $15 per month, billed $180 for the year = 140,000 Credit, 365 days. Songs (lime, Song Credit only): Free $0 = 24 Credit per month. Trial $5 = 750 Credit, 30 days. Popular $10 = 1,500 Credit, 30 days. Pro $22 = 3,750 Credit, 30 days. How to buy: open Packages, tap Buy on a package, pay by KHQR (Canadia payment link) or Binance USDT address, then tap "I have paid". The admin approves the request and the credits are added. There is no automatic payment gateway. Download limits: NONE — song downloads are FREE and UNLIMITED for everyone (owner order 2026-11-16: the old 4-free limit is removed); no package is needed to download songs. Downloads happen in place (direct download on the same page, file named after the song — never redirect to another page). Image downloads have no limit. Video downloads have no limit but carry the MovAi company logo watermark overlaid on the video.',
    '5. HOW TO CREATE AN IMAGE: Go to Create, choose Image, pick a provider (Magic Hour or NovAI), write what you want in the Prompt box, tap Generate, wait for the image, then Download or keep it in History. Magic Hour image models: Z-Image Turbo (5 Credit), Flux 2 Klein (5), Qwen Image 2.1 (10), Krea 2 (10). GPT Image 2 (50), Nano Banana 2.1 (50) and Nano Banana Pro (150) are LOCKED — they need a package. NovAI image (cogview-3-flash) is free 10 times per day. The result appears blurry first and sharpens to clear as it finishes.',
    '6. HOW TO CREATE A VIDEO: Go to Create, choose Video, pick a provider (Magic Hour or NovAI), write the prompt, choose duration and quality, tap Generate. Magic Hour video: LTX 2.5 up to 60 seconds, MiniMax H3 up to 30 seconds. Free users can make up to 10 seconds; 15 seconds and longer need a package. Kling 3.0/4.0, Veo 3.1 and Seedance 2.5 are LOCKED (need a package). NovAI video is free but only 5 seconds and 720p, and it is often busy. A long story can be split into episodes (each episode is its own card with its own Generate and Download). If the internet drops during generation, the job waits and resumes automatically; the user can Pause/Resume or Cancel (Cancel saves nothing and deducts no Credit).',
    '7. HOW TO CREATE A SONG: Go to Create, choose Song, pick a provider, fill Title, Lyrics, Style and Voice (male, female or random), tap Generate. MovAi (Suno v6, v6-wild, v6-mini): sings Khmer clearest on v6. One generation is 12 Credit and gives 2 songs. A playable preview appears after about 20-30 seconds; the full song arrives when done. Magic Hour music: 60 Credit per minute, no model choice. MusicAPI: 20 Credit = 2 songs, takes about 25 minutes. ACE Music is LOCKED (no new API keys can be obtained). Songs can be listened to in History and posted to Public.',
    '8. HOW TO CREATE 3D: Go to 3D Design. Option 1: upload an image and turn it into 3D. Option 2: write text, make an image, then turn it into 3D. Providers: Hunyuan3D (generates in the page) and Masterpiece X (opens its website). Free 3D credits are limited.',
    '9. HISTORY: Everything the user creates is saved in History, separated by Gmail (each Gmail sees only its own). They can download, delete, like, share, or post it to Public. Images and videos show in carousels; songs show as compact rows with a player.',
    '10. PUBLIC: The Public tab shows songs, images and videos posted by users, newest first, in separate categories (Songs, Images, Videos, 3D). Anyone can listen, watch, like and follow. The admin name shows in gold. The bell rings when someone the user follows posts something new.',
    '11. NOTIFICATIONS: The bell (top right) shows new device login alerts (with model and IP), gift claims, package approvals/rejections, credit grants/deductions, and new posts from followed users. Tap a notification to go to the right place (Profile, Packages, Public).',
    '12. PACKAGES SHEET: Two tabs: "Create Music" (lime, song packages) and "Create Video" (purple, media packages). Most expensive first, Free last. Price and credit numbers are big. Features are in a scrollable list inside each card with checkmarks. Tap Buy to pay.',
    '13. PROFILE: Shows the user name, Gmail, User ID (with Copy), both credit balances, and plan. Packages are shown only when tapped. The user can set/change/remove their profile picture. Log out is here.',
    '14. SETTINGS AND MENU (drawer): Language Khmer/English, font size, app colour (7 themes, lime is the default), day/night/auto, text shadow, glass effect, background brightness, brand effects, smooth mode (on weak phones smooth mode is locked on by the admin). The drawer opens from the left; the bottom dock has Public, Create, History, Packages, Notifications. The floating round button (bottom right) opens image/video/3D/History. The AI chat button (bottom left, robot) opens this chat; it hides while the drawer is open.',
    '15. OFFLINE: If the internet drops, a popup appears with Retry and Cancel. Generation does not fail — it waits and resumes. When the internet returns, a green "Network ready" toast shows for 3 seconds.',
    '16. ADMIN AND HELP: The creator/admin is YEM SOKHOEUN. Phone 081 914 728. Gmail sokhoeun7788@gmail.com. Telegram @yemsokhoeun_9999. The admin approves package purchases, grants or deducts credits, and blocks abusive models, IPs or Gmails. For any problem the user cannot solve, tell them to contact the admin on Telegram @yemsokhoeun_9999.',
    '17. PROVIDERS: Image: Magic Hour (works), NovAI (works). Video: Magic Hour (works), NovAI (often busy). Songs: MovAi/Suno (works), Magic Hour (works), MusicAPI (works, slow). ACE Music is LOCKED. Tavus and Puter.js are not used.',
  ].join('\n');
  const CHAT_SYSTEM_PROMPT = [
    'You are the MovAi assistant — a helpful AI chat inside the MovAi website.',
    'MovAi is a website to create images, videos, 3D models and songs with AI.',
    'HOW LOGIN WORKS: Login is Google account ONLY — there is no other login method and no "create account" page. After first login a gift popup appears — the user must tap CLAIM to get FREE 250 Image/Video Credit + 24 Song Credit. If they do not tap CLAIM they stay at 0. If their Google account has no first and last name, they must type both names before they can create. Every account gets a permanent 10-character User ID.',
    'CREDITS: There are 2 separate credits. Image/Video Credit (purple) is for images, videos and 3D. Song Credit (lime) is for songs only. A user gets credits from the gift CLAIM, from buying a package, or from the admin. Image generation costs 5-10 Credit per image (Magic Hour Z-Image Turbo 5, Flux 2 Klein 5, Qwen Image 2.1 10, Krea 2 10). Song generation costs 12 Credit and gives 2 songs. Video costs depend on the model and length.',
    'MEDIA PACKAGES (purple, Image/Video Credit only): Monthly $25 = 11,000 Credit for 30 days. Yearly $15 per month, billed $180 for the year = 140,000 Credit for 365 days.',
    'SONG PACKAGES (lime, Song Credit only): Free 24 Credit per month. Trial $5 = 750 Credit. Popular $10 = 1,500 Credit. Pro $22 = 3,750 Credit. Each song generation is 12 Credit and gives 2 songs.',
    'HOW TO BUY A PACKAGE: Open Packages, tap Buy, pay by KHQR (Canadia link) or Binance USDT address, then tap "I have paid". The admin approves the request and the credits are added to the account. Song downloads are FREE and UNLIMITED for everyone (no package needed to download); downloads happen in place (direct download, file named after the song — never redirect). Image downloads have no limit. Video downloads have no limit but carry the MovAi logo watermark.',
    'HOW TO CREATE AN IMAGE: Go to Create, choose Image, pick a provider (Magic Hour or NovAI), write what you want in the Prompt box, tap Generate, wait for the image, then Download or save it to History. Magic Hour image models: Z-Image Turbo, Flux 2 Klein, Qwen Image 2.1, Krea 2. GPT Image 2 and Nano Banana are locked (need a package). NovAI image is free 10 times per day.',
    'HOW TO CREATE A VIDEO: Go to Create, choose Video, pick a provider (Magic Hour or NovAI), write the prompt, choose duration and quality, tap Generate. Magic Hour video: LTX 2.5 up to 60 seconds, MiniMax H3 up to 30 seconds. Free users can make up to 10 seconds; 15 seconds and longer need a package. Kling, Veo and Seedance are locked (need a package). NovAI video is free but only 5 seconds and 720p, and it is often busy. A long story can be split into episodes.',
    'HOW TO CREATE A SONG: Go to Create, choose Song, pick a provider (MovAi / Suno v6, Magic Hour, or MusicAPI), fill Title, Lyrics, Style and Voice (male, female or random), tap Generate. MovAi (Suno v6) sings Khmer clearest and gives a playable preview after about 20-30 seconds; one generation is 12 Credit and gives 2 songs. Magic Hour music costs 60 Credit per minute. MusicAPI takes about 25 minutes and costs 20 Credit for 2 songs. ACE Music is LOCKED (no new API keys).',
    'HOW TO CREATE 3D: Go to 3D Design. Option 1: upload an image and turn it into 3D. Option 2: write text, make an image, then turn it into 3D. Providers: Hunyuan3D (in the page) and Masterpiece X (opens its website).',
    'HISTORY: Everything the user creates is saved in History, separated by Gmail. They can download, delete, like, share, or post it to Public.',
    'PUBLIC: The Public tab shows songs, images and videos posted by users, newest first. Anyone can listen, watch, like and follow. The admin name shows in gold.',
    'NOTIFICATIONS: The bell shows login alerts (including a new device login with model and IP), gift claims, package approvals and new posts from people the user follows.',
    'SETTINGS: Language (Khmer/English), app colour, day/night mode, smooth mode, text size and glass effect are in the drawer menu.',
    'Login is Google account ONLY — there is no other login method.',
    'New users get FREE 250 Image/Video Credit + 24 Song Credit via a gift CLAIM popup after first login (they must tap CLAIM, otherwise they stay at 0).',
    'Media packages (purple): Monthly $25 = 11,000 Credit/month, Yearly $15/month billed $180/year = 140,000 Credit/year.',
    'Song packages (lime): Free 24 Credit/month, Trial $5 = 750 Credit, Popular $10 = 1,500 Credit, Pro $22 = 3,750 Credit (12 Credit per song generation = 2 songs).',
    'Song downloads are FREE and UNLIMITED for everyone (no package needed; the old 4-free limit is removed). Downloads happen in place with the song name (no redirect). Video downloads unlimited but watermarked with the MovAi logo.',
    'Providers: Magic Hour, NovAI, MusicAPI, MovAi (Suno v6). ACE Music is LOCKED (no new API keys).',
    'The creator/admin is YEM SOKHOEUN, phone 081 914 728, Gmail sokhoeun7788@gmail.com, Telegram @yemsokhoeun_9999. For problems the user can contact the admin on Telegram @yemsokhoeun_9999.',
    'CONTACT (show ONLY when the user asks for contact, a phone number, or a Gmail — never volunteer it unasked): Admin phones: +855 81914728 and +855 60397433 (tap to call). Admin Gmails: sokhoeun7788@gmail.com, sokhoeun356@gmail.com, yemsokhoeun98@gmail.com. Show the Gmails MASKED — first 2 letters + dots + last 2 letters before @gmail, e.g. so••••88@gmail.com, so••••56@gmail.com, ye••••98@gmail.com — with @gmail shown in full. Never show a full Gmail address in the chat. The website also shows a tappable contact card with these same numbers and masked Gmails.',
    'GREETING: If the user greets you (hello, hi, susdei, or any greeting, in Khmer or English), greet them back by their FULL name.',
    'RULES: LANGUAGE (absolute rule — never break it): Reply ONLY in the language the user writes. If the user writes in Khmer, reply ONLY in Khmer — never reply in English, never mix English words into a Khmer reply, not even in greetings. If the user writes in English, reply ONLY in English. Answer DIRECTLY and appropriately. NEVER use pre-prepared or canned answers — every reply must be generated live from this prompt and the live context. NEVER invent prices, limits or features that are not in this prompt. Use ONLY the facts in this prompt and the live context — if you do not know something, say you do not know and tell the user to ask the admin on Telegram @yemsokhoeun_9999. If asked whether the system is down, slow or broken, use the live context (server uptime and provider status) to answer honestly and tell the user what is wrong. NAME: the chat header shows "MovAi AI" (the app name), NEVER the user\'s name. GREET: greet the user by their FULL name (the full name shown in the live context, first name plus last name together, never just the first name alone) ONLY when the live context says this is their first message after 2 or more hours away — otherwise do NOT greet with their name at all, just answer directly. Never greet with the name twice in one conversation. STYLE: plain text ONLY — NEVER use markdown or any formatting symbols: no asterisks (* **), no square brackets ([ ]), no backticks (`), no # headings, no > quotes, no bullet symbols, no emojis, no decorative symbols of any kind. Give a link ONLY when the user explicitly asks for a link (then give just that link, nothing else). Just plain sentences. STRUCTURE (user order): a long answer must have a head and a tail — start with one short opening line, then the points as numbered rows going down (1. 2. 3.), then one short closing line. Never dump a messy wall of text; keep every row short and neat. LENGTH: If the user asks a simple fact question, answer in 1 to 3 short sentences. If the user asks HOW something works or HOW to do something, give a COMPLETE and CLEAR answer that covers every step they need, in order, using plain sentences (First... Then... After that...). Never give a tiny fragment when they asked how it works. Never dump all the facts when they only asked one small thing. THINK FIRST: before answering, think step by step about what the user actually asks, then answer ONLY that question.',
    'ACTIONS (the website acts on these tags — put the tag at the very end of your reply on its own line, and the website will do it and hide the tag from the user): VOICE CHANGE — when the user asks you to change the voice to female or male (in any words, Khmer or English, for example "ប្ដូរសំឡេងស្រី" or "change to a female voice"), confirm the change in your reply AND put [VOICE:female] or [VOICE:male] at the end. PACKAGE CARD — when the user asks about the price of a package or wants to buy a package, answer with the price AND put [PACKAGE:<id>] at the end, where <id> is one of: song-free, song-trial, song-popular, song-pro, monthly, yearly. The website will show that package as a card with a Buy button. Only use a tag when the user actually asked for that action. Never invent a tag.',
  ].join('\n');
  function chatLeaderValidate(body) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'សូមសរសេរសំណួរជាមុនសិន · Please write a message first' };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return { ok: false, error: 'សូមសរសេរសំណួរជាមុនសិន · Please write a message first' };
    if (message.length > 2000) return { ok: false, error: 'សារវែងពេក (អតិបរមា 2000 តួអក្សរ) · Message too long (max 2000 characters)' };
    return { ok: true, message };
  }
  function chatReceiverContext(email) {
    const s = loadSettings();
    const providers = (s && s.providers && typeof s.providers === 'object') ? s.providers : {};
    const fmtMode = (mode) => {
      const p = providers[mode];
      if (!p || !p.provider) return mode + ': not set by admin yet';
      return mode + ': ' + p.provider + (p.model ? ' (' + p.model + ')' : '');
    };
    const uptimeSec = Math.floor(process.uptime());
    const uptimeText = uptimeSec < 60 ? uptimeSec + 's' : uptimeSec < 3600 ? Math.floor(uptimeSec / 60) + 'm ' + (uptimeSec % 60) + 's' : Math.floor(uptimeSec / 3600) + 'h ' + Math.floor((uptimeSec % 3600) / 60) + 'm';
    let userText = 'guest (no Gmail given)';
    if (email) {
      const u = loadUsers()[email];
      if (u) { const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim(); userText = email + (nm ? ' — name "' + nm + '"' : '') + ' — Image/Video Credit ' + Math.max(0, Math.floor(numOr(u.credits, 0))) + ', Song Credit ' + Math.max(0, Math.floor(numOr(u.songCredits, 0))) + ', media plan ' + (u.plan || 'free') + ', song plan ' + (u.songPlan || 'free'); }
      else userText = email + ' — no account on this server yet';
    }
    const gk = adminProviderKey('groq');
    const groqConfigured = !!(gk && gk.key);
    return [
      'LIVE CONTEXT (use this for status questions; never invent status):',
      'Server uptime: ' + uptimeText + ' (server is running).',
      'Active providers — ' + fmtMode('image') + ' | ' + fmtMode('video') + ' | ' + fmtMode('song') + '.',
      'Groq AI chat key configured: ' + (groqConfigured ? 'yes' : 'no') + '.',
      'User: ' + userText + '.',
      'Greet by name: ' + (chatGreetFlag(email) ? 'YES — this is the user\'s first message after 2+ hours away, greet them once by their FULL name (first name plus last name together, never just the first name alone), then answer.' : 'NO — do NOT greet with their name, just answer directly.') + '.',
    ].join('\n');
  }
  // Two chat models alternate (user order 2026-11-17): each call starts
  // with the other model, and on ANY failure the other model is tried,
  // so the two help each other. (Kimi K2 does not respond on Groq for
  // these keys — verified 2026-11-16 — so it is not used.)
  let _chatModelFlip = 0;
  async function chatThinkerCallGroq(systemPrompt, history, message, key) {
    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        if (!h || typeof h !== 'object') continue;
        const role = h.role === 'assistant' ? 'assistant' : (h.role === 'user' ? 'user' : null);
        if (!role || typeof h.content !== 'string' || !h.content.trim()) continue;
        messages.push({ role, content: h.content.trim().slice(0, 2000) });
      }
    }
    messages.push({ role: 'user', content: message });
    const _chatModels = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
    const models = (_chatModelFlip++ % 2 === 0) ? _chatModels : [_chatModels[1], _chatModels[0]];
    let lastErr = null;
    for (const model of models) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature: 0.7, max_tokens: 2000, messages }),
          signal: AbortSignal.timeout(25000),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) {
          const em = (j && j.error && typeof j.error.message === 'string' && j.error.message) ? j.error.message : ('Groq HTTP ' + r.status);
          lastErr = { ok: false, error: 'Groq: ' + String(em).slice(0, 300), status: r.status };
          continue;
        }
        const content = j && j.choices && j.choices[0] && j.choices[0].message && typeof j.choices[0].message.content === 'string' ? j.choices[0].message.content : '';
        if (!content.trim()) return { ok: false, error: 'Groq: empty reply', status: r.status };
        // Record chat tokens for the live per-key remaining display.
        try { const tot = j && j.usage && Number(j.usage.total_tokens); if (tot > 0) recordGroqTokens(key, tot); } catch (e) {}
        return { ok: true, reply: content.trim(), model };
      } catch (e) {
        lastErr = { ok: false, error: 'Groq: ' + (e && e.message ? e.message : 'request failed'), status: 0 };
        continue;
      }
    }
    return lastErr || { ok: false, error: 'Groq: request failed', status: 0 };
  }
  // HARD LOCK on reply style (user order 2026-11-16): the model keeps
  // emitting ** and emoji despite the prompt, so the server STRIPS every
  // markdown marker and every emoji/decorative symbol from the reply
  // before returning it. What reaches the user is plain text only.
  function sanitizeChatReply(t) {
    let s = String(t || '');
    s = s.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
    s = s.replace(/^#{1,6}\s*/gm, '').replace(/^>\s*/gm, '');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[\[\]]/g, '');
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2022}\u{25AA}-\u{25FF}]/gu, '');
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    return s;
  }
  function chatDirectReply(text) { return sanitizeChatReply(text); }
  // Greet-by-name only once per conversation gap: the user is greeted by
  // name ONLY when their previous chat was 2+ hours ago (or never). The
  // map is in-memory; a server restart simply greets once more.
  const _lastChatAt = new Map();
  const CHAT_GREET_GAP_MS = 2 * 60 * 60 * 1000;
  function chatGreetFlag(email) {
    const now = Date.now();
    const last = email ? _lastChatAt.get(email) : 0;
    const greet = !last || (now - last) >= CHAT_GREET_GAP_MS;
    if (email) _lastChatAt.set(email, now);
    return greet;
  }
  // POST /api/chat — {email?, message, history?} — PUBLIC (no admin key).
  // Runs the 5-stage pipeline above and returns {ok:true, reply}.
  if (req.method === 'POST' && urlPath === '/api/chat') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      logActivity({ at: new Date().toISOString(), mode: 'chat', email: email || '' });
      const v = chatLeaderValidate(body);
      if (!v.ok) return sendJSON(res, 200, { ok: false, error: v.error });
      const reqKey = body && typeof body.key === 'string' ? body.key : '';
      const context = chatReceiverContext(email);
      const t0 = Date.now();
      let replyObj;
      try {
        replyObj = await withProviderKeyRotation('groq', async (k) => {
          const r = await chatThinkerCallGroq(CHAT_SYSTEM_PROMPT + '\n\n' + MOVAI_BOOK + '\n\n' + context, body && body.history, v.message, k);
          if (!r.ok) throw rotErr(r.error || 'Groq: request failed', r.status || 0);
          return { reply: r.reply, model: r.model || '' };
        }, reqKey);
      } catch (e) {
        if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Groq API Key ទេ · Admin has not set a Groq API Key yet' });
        return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Groq: request failed' });
      }
      const ms = Date.now() - t0;
      return sendJSON(res, 200, { ok: true, reply: chatDirectReply(replyObj.reply), model: replyObj.model || '', ms });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Microsoft Edge TTS (FREE, no API key) ----
  // Speaks an AI chat reply aloud in Khmer. Male = km-KH-PisethNeural,
  // Female = km-KH-SreymomNeural. Uses the same free Edge endpoint the
  // Edge browser's Read Aloud uses (WebSocket, no key). Returns an MP3
  // Buffer. Throws on failure (the website then falls back to the
  // browser's own speechSynthesis).
  const EDGE_TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const EDGE_TTS_WS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + EDGE_TTS_TOKEN;
  function edgeTTS(text, voice) {
    return new Promise((resolve, reject) => {
      if (!WebSocketLib) return reject(new Error('ws module missing'));
      const connId = crypto.randomUUID().replaceAll('-', '');
      const ws = new WebSocketLib(EDGE_TTS_WS + '&ConnectionId=' + connId, {
        headers: {
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.66 Safari/537.36 Edg/103.0.1264.44',
        },
      });
      const audio = [];
      const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('Edge TTS timeout')); }, 20000);
      const fail = (err) => { clearTimeout(timer); try { ws.close(); } catch (e) {} reject(err instanceof Error ? err : new Error(String(err))); };
      ws.on('open', () => {
        const ts = new Date().toUTCString();
        try {
          ws.send('X-Timestamp:' + ts + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
          const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="km-KH"><voice name="' + voice + '"><prosody rate="+0%" volume="+0%" pitch="+0Hz">' + esc + '</prosody></voice></speak>';
          ws.send('X-RequestId:' + connId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + ts + '\r\nPath:ssml\r\n\r\n' + ssml);
        } catch (e) { fail(e); }
      });
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const s = data.toString('utf8');
          if (s.includes('turn.end')) { clearTimeout(timer); try { ws.close(); } catch (e) {} resolve(Buffer.concat(audio)); }
          return;
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const sep = Buffer.from('Path:audio\r\n');
        const idx = buf.indexOf(sep);
        if (idx >= 0) audio.push(buf.subarray(idx + sep.length));
      });
      ws.on('error', (e) => fail(e));
      ws.on('close', () => { if (audio.length === 0) fail(new Error('Edge TTS closed with no audio')); });
    });
  }
  // POST /api/chat/tts — {text, voice:'male'|'female'} — PUBLIC.
  // Returns MP3 audio of the text spoken in Khmer (Edge TTS, no key).
  if (req.method === 'POST' && urlPath === '/api/chat/tts') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
      if (!text) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរអត្ថបទជាមុនសិន' });
      const voice = body.voice === 'female' ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';
      try {
        const mp3 = await edgeTTS(text, voice);
        if (!mp3 || mp3.length < 100) return sendJSON(res, 200, { ok: false, error: 'Microsoft TTS មិនបានឆ្លើយតបទេ · Microsoft TTS did not respond' });
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length, 'Cache-Control': 'no-store' });
        return res.end(mp3);
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: 'Microsoft TTS មានបញ្ហា · ' + (e && e.message ? String(e.message).slice(0, 120) : 'request failed') });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- MV lyrics (karaoke) — transcription via Groq Whisper ----
  // POST /api/mv/lyrics {audioUrl, translateTo?} — PUBLIC (no admin key).
  // Fetches the song audio (in-memory only, never to disk), transcribes it
  // with Groq Whisper (whisper-large-v3-turbo, verbose_json) and returns
  // timed lyric lines in the language the song is sung in. NO translation
  // by default; when translateTo is given, the lines are translated with
  // Groq chat (gpt-oss-120b) keeping the same timings. Groq Whisper
  // rejects files over 25 MB, so bigger files are CONVERTED first (the
  // existing Cloudinary store flow transcodes them to MP3, or a
  // Cloudinary URL is re-fetched at 64k); only as a last resort is the
  // audio split into <=20 MB chunks and transcribed piece by piece.
  // NOTE: the handler itself lives AFTER the Cloudinary section (after
  // the /api/gen/song/mp3 endpoint) because it calls cloudinaryStoreSong
  // — helpers defined after the old spot would be in TDZ from there.
  const MV_LYRICS_MAX_BYTES = 25 * 1024 * 1024;
  const MV_LYRICS_FETCH_TIMEOUT_MS = 60000;
  const MV_LYRICS_WHISPER_TIMEOUT_MS = 120000;
  function mvLyricsFileName(contentType, audioUrl) {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('wav') || ct.includes('x-wav')) return 'song.wav';
    if (ct.includes('ogg')) return 'song.ogg';
    if (ct.includes('flac')) return 'song.flac';
    if (ct.includes('m4a') || ct.includes('mp4')) return 'song.m4a';
    if (ct.includes('webm')) return 'song.webm';
    const m = String(audioUrl || '').toLowerCase().match(/\.([a-z0-9]{2,5})(?:[?#]|$)/);
    if (m && ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'webm', 'mp4'].includes(m[1])) return 'song.' + m[1];
    return 'song.mp3';
  }
  function mvLyricsMime(fileName) {
    if (/\.wav$/i.test(fileName)) return 'audio/wav';
    if (/\.ogg$/i.test(fileName)) return 'audio/ogg';
    if (/\.flac$/i.test(fileName)) return 'audio/flac';
    if (/\.m4a$/i.test(fileName)) return 'audio/mp4';
    if (/\.webm$/i.test(fileName)) return 'audio/webm';
    return 'audio/mpeg';
  }
  async function mvLyricsFetchAudio(audioUrl, maxBytes, timeoutMs) {
    // Returns {ok:true, buf, contentType} or {ok:false, tooLarge:true} or
    // {ok:false, error}. Streams with a hard cap so a huge file is never
    // fully loaded into memory. maxBytes/timeoutMs are optional — the
    // full-file (chunking) fetch passes a higher cap + longer timeout;
    // the default is the 25 MB fast path.
    const cap = Number(maxBytes) > 0 ? Number(maxBytes) : MV_LYRICS_MAX_BYTES;
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : MV_LYRICS_FETCH_TIMEOUT_MS;
    let r;
    try {
      r = await fetch(audioUrl, { signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      return { ok: false, error: 'fetch' };
    }
    if (!r.ok) return { ok: false, error: 'fetch' };
    const lenHdr = r.headers && r.headers.get ? r.headers.get('content-length') : null;
    const len = lenHdr ? parseInt(lenHdr, 10) : NaN;
    if (!Number.isNaN(len) && len > cap) return { ok: false, tooLarge: true };
    const ct = (r.headers && r.headers.get ? r.headers.get('content-type') : '') || '';
    if (!r.body || typeof r.body.getReader !== 'function') {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > cap) return { ok: false, tooLarge: true };
      return { ok: true, buf, contentType: ct };
    }
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) { try { await reader.cancel(); } catch (e) {} return { ok: false, tooLarge: true }; }
        chunks.push(Buffer.from(value));
      }
    } catch (e) {
      return { ok: false, error: 'fetch' };
    }
    return { ok: true, buf: Buffer.concat(chunks), contentType: ct };
  }
  async function mvLyricsWhisper(buf, fileName, key) {
    // Returns {ok:true, language, lyrics}. Throws rotErr on failure so
    // withProviderKeyRotation can rotate on 429/auth errors; other
    // failures (e.g. a 400 for bad audio) fail immediately without
    // burning the other keys.
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mvLyricsMime(fileName) }), fileName);
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('response_format', 'verbose_json');
    let r;
    try {
      r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key },
        body: fd,
        signal: AbortSignal.timeout(MV_LYRICS_WHISPER_TIMEOUT_MS),
      });
    } catch (e) {
      throw rotErr('Whisper: ' + (e && e.message ? String(e.message).slice(0, 120) : 'request failed'), 0);
    }
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const em = (j && j.error && typeof j.error.message === 'string' && j.error.message) ? j.error.message : ('Groq HTTP ' + r.status);
      throw rotErr('Whisper: ' + String(em).slice(0, 200), r.status);
    }
    const segs = Array.isArray(j && j.segments) ? j.segments : [];
    const lyrics = [];
    for (const s of segs) {
      const text = s && typeof s.text === 'string' ? s.text.trim() : '';
      if (!text) continue;
      const start = typeof s.start === 'number' && isFinite(s.start) ? Math.max(0, Math.round(s.start * 100) / 100) : 0;
      const end = typeof s.end === 'number' && isFinite(s.end) ? Math.max(start, Math.round(s.end * 100) / 100) : start;
      lyrics.push({ text, start, end });
      if (lyrics.length % 50 === 0) await new Promise((res2) => setImmediate(res2));
    }
    const language = j && typeof j.language === 'string' ? j.language.trim().toLowerCase() : '';
    return { ok: true, language, lyrics };
  }
  async function mvLyricsTranslate(lyrics, translateTo, key) {
    // Translate each lyric line to translateTo via Groq chat, keeping the
    // same line count and timings. Returns {ok:true, lines} or
    // {ok:false, error, status} (so a 429 can still rotate to the next key).
    const numbered = lyrics.map((l, i) => (i + 1) + '. ' + l.text).join('\n');
    const sys = 'You are a lyrics translator. Translate each numbered lyric line to ' + translateTo + '. Reply with ONLY the translated lines, same numbering, one per line, no extra text, no explanations, no markdown, no emojis.';
    const r = await chatThinkerCallGroq(sys, null, numbered, key);
    if (!r.ok) return { ok: false, error: r.error || 'translate failed', status: r.status || 0 };
    const clean = sanitizeChatReply(r.reply || '');
    const out = [];
    const lines = clean.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].replace(/^\s*\d+\s*[.)]\s*/, '').trim();
      if (t) out.push(t);
      if (i % 50 === 0) await new Promise((res2) => setImmediate(res2));
    }
    if (!out.length) return { ok: false, error: 'translate failed', status: 0 };
    return { ok: true, lines: out };
  }
  // NOTE: the POST /api/mv/lyrics handler lives below, after the
  // Cloudinary section (after the /api/gen/song/mp3 endpoint), because
  // it calls cloudinaryStoreSong — helpers defined after this point
  // would be in TDZ from here (apiRoute returns at the first match).
  // POST /api/studio/separate — {email, audioUrl, songTitle?} — requires logged-in email.
  // MVSEP Demucs4 HT stem separation for MOVAI STUDIO: creates a separation
  // (vocals/drums/bass/other) for the song's audio URL, polls MVSEP until it
  // finishes, and returns {ok, stems:[{name,url}], hash}. Keys rotate on
  // daily-limit errors (50/day/key); if every key is exhausted returns
  // error 'mvsep_limit'. If the job is still processing after the
  // server-side poll timeout, returns error 'mvsep_timeout' WITH the hash
  // so the Studio can resume via GET /api/studio/separate/status without
  // creating (and paying quota for) a second separation. The server never
  // stores stem files — it returns MVSEP's download URLs.
  if (req.method === 'POST' && urlPath === '/api/studio/separate') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const email = normEmail(body && body.email);
        if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
        const audioUrl = body && typeof body.audioUrl === 'string' ? body.audioUrl.trim() : '';
        if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) return sendJSON(res, 200, { ok: false, error: 'មិនមាន Link បទចម្រៀងទេ · No song audio URL' });
        const songTitle = body && typeof body.songTitle === 'string' ? body.songTitle.trim().slice(0, 200) : '';
        let out;
        try {
          out = await withProviderKeyRotation('mvsep', async (k) => {
            const r = await mvsepSeparateWithKey(k, audioUrl);
            return { hash: r.hash, stems: r.stems, keyUsed: k };
          });
        } catch (e) {
          if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'mvsep_no_key', message: { km: 'Admin មិនទាន់ដាក់ MVSEP API Key ទេ', en: 'Admin has not added an MVSEP API key yet' } });
          if (e && e.code === 'mvsep_timeout') return sendJSON(res, 200, { ok: false, error: 'mvsep_timeout', hash: e.hash || '', message: { km: 'MVSEP កំពុងបំបែកបទនេះ — សូមរង់ចាំបន្តិច ហើយចុច Split (AI) ម្តងទៀត', en: 'MVSEP is still separating this song — please wait a bit and tap Split (AI) again' } });
          if (e && /quota exceeded/i.test(String(e.message || ''))) return sendJSON(res, 200, { ok: false, error: 'mvsep_limit', message: { km: 'MVSEP ដល់កំណត់ 50 បទ/ថ្ងៃ លើ Key ទាំងអស់ហើយ — សូមសាកល្បងម្តងទៀតនៅថ្ងៃស្អែក', en: 'MVSEP daily limit of 50 songs/day reached on all keys — please try again tomorrow' } });
          return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'MVSEP: request failed' });
        }
        // Success: count it against the key that did the work (server-side daily counter for the Admin display).
        recordMvsepSeparation(out.keyUsed, out.hash);
        return sendJSON(res, 200, { ok: true, provider: 'mvsep', hash: out.hash, songTitle, stems: out.stems });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'MVSEP: ' + (e && e.message ? String(e.message).slice(0, 200) : 'request failed') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/studio/separate/status?hash=<hash>&email=<email> — requires logged-in email.
  // Checks one MVSEP separation created earlier (e.g. after an mvsep_timeout)
  // WITHOUT creating a new separation, so no extra daily quota is spent.
  // Tries each stored MVSEP key until one returns the separation. Returns
  // {ok, done:true, stems, hash} when finished, {ok, done:false, status, hash}
  // while still processing, or an error.
  if (req.method === 'GET' && urlPath === '/api/studio/separate/status') {
    (async () => {
      try {
        const qp = new URL(req.url, 'http://localhost').searchParams;
        const email = normEmail(qp.get('email') || '');
        if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
        const hash = String(qp.get('hash') || '').trim().slice(0, 200);
        if (!hash) return sendJSON(res, 200, { ok: false, error: 'មិនមាន hash ទេ · No separation hash' });
        const keys = adminProviderKeyList('mvsep');
        if (!keys.length) return sendJSON(res, 200, { ok: false, error: 'mvsep_no_key', message: { km: 'Admin មិនទាន់ដាក់ MVSEP API Key ទេ', en: 'Admin has not added an MVSEP API key yet' } });
        // The GET status endpoint takes only the hash (official example
        // passes no api_token), so one check is enough — no key loop.
        let r;
        try {
          r = await mvsepGetSeparation(hash);
        } catch (e) {
          return sendJSON(res, 200, { ok: false, error: 'mvsep_not_found', hash, message: { km: 'រក Separation នេះមិនឃើញទេ — វាអាចបរាជ័យ ឬផុតកំណត់ហើយ', en: 'Separation not found — it may have failed or expired' } });
        }
        if (r.done) {
          const kv = _mvsepHashKey.get(hash);
          if (kv) recordMvsepSeparation(kv, hash);
          return sendJSON(res, 200, { ok: true, done: true, hash, stems: r.stems });
        }
        return sendJSON(res, 200, { ok: true, done: false, status: 'processing', hash });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'MVSEP: ' + (e && e.message ? String(e.message).slice(0, 200) : 'status check failed') }); }
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'MVSEP: status check failed' }));
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
      // Blocked IP or blocked Gmail (MANUAL blocks by the admin): refuse
      // the sync entirely — no user is created/updated, no credits
      // granted. A NEW or changed IP is never blocked here — it only
      // raises a 'new device' notification for the admin to review.
      const _cip0 = getClientIp(req);
      if (_cip0 && loadBlockedIps().some((b) => b === _cip0)) {
        addNotification('security', email, '🚫 គណនី/IP ត្រូវបានប្លុកព្យាយាមចូល · Blocked account/IP login attempt', email + ' tried to log in from blocked IP ' + _cip0 + ' · IP ' + _cip0);
        return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      }
      if (loadBlockedEmails().some((b) => b === email)) {
        addNotification('security', email, '🚫 គណនី/IP ត្រូវបានប្លុកព្យាយាមចូល · Blocked account/IP login attempt', email + ' tried to log in from blocked email ' + email + ' · IP ' + (_cip0 || '—'));
        return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      }
      // Blocked device model: refuse the sync entirely — no user is
      // created/updated and no credits are granted.
      // The website sends the real model in body.model (from Client
      // Hints) because modern Chrome hides it in the UA ("Android 13;
      // K"). Prefer body.model; fall back to the UA only when the body
      // model is missing or is the "K" placeholder.
      const _bodyModel = typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      const _model = (_bodyModel && _bodyModel !== 'K') ? _bodyModel : modelFromUA(req.headers && req.headers['user-agent']);
      if (_model && loadBlockedModels().some((b) => b.toUpperCase() === _model.toUpperCase())) {
        addNotification('security', email, '🚫 ម៉ូឌែលត្រូវបានប្លុកព្យាយាមចូល · Blocked model login attempt', email + ' tried to log in from blocked model ' + _model + ' · IP ' + (getClientIp(req) || '—'));
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
          // GIFT LOCK (owner order 2026-11-17): a new account ALWAYS
          // starts at 0/0. The server NEVER trusts the client's
          // balance — a browser could send credits:250 and mint the
          // gift without claiming, and a stale/new-device sync could
          // re-create the account with the gift. The gift (+250 media
          // / +24 song) is granted ONLY by the CLAIM flow below
          // (giftClaimed:true + !giftClaimed), once per Gmail,
          // forever, on any device. The Admin/server balance is the
          // only truth; the Profile number is display-only.
          credits: 0,
          songCredits: 0,
          giftClaimed: false,
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
      // Known devices: record this model/device/IP. A (model + IP) pair
      // never seen before for this user is a NEW device (alerted below),
      // except on the very first sync (account creation).
      const _hadKnownDevices = Array.isArray(u.knownDevices) && u.knownDevices.length > 0;
      const _deviceTrack = trackKnownDevice(u, _model || '', _dev || '', _cip || '', now, u.country || '', u.countryCode || '');
      // IP country: fill it in the background (never blocks this sync).
      const _kdEntry = Array.isArray(u.knownDevices) ? u.knownDevices.find((x) => x && x.ip === _cip) : null;
      if (_cip && (!_kdEntry || !_kdEntry.country || !_kdEntry.countryCode)) lookupIpCountryAsync(email, _cip);
      const _isNewDevice = _deviceTrack.isNew && _hadKnownDevices;
      // Count this login against the device model.
      let _modelLogins = null;
      if (_model) {
        _modelLogins = loadModelLogins();
        _modelLogins[_model] = (Number(_modelLogins[_model]) || 0) + 1;
        saveModelLogins(_modelLogins);
      }
      // GIFT — LOCKED once per Gmail, forever (owner order 2026-11-17,
      // biggest problem): when the website sends giftClaimed:true the
      // server grants the gift (+250 media / +24 song), once per user.
      // giftClaimed flag prevents a second grant; Math.max tops the
      // balance UP to 250/24 instead of adding. New accounts start at
      // 0/0 (see above) so the gift can only arrive through this
      // CLAIM flow. The 21:01 exploit: Oun Lyna2 got the gift again
      // (+50 media / +24 song) by logging in from a new device,
      // because her earlier admin grant never set giftClaimed — the
      // flag is now the single lock, and the notification below fires
      // ONLY when credits are actually granted (never on a refused
      // re-claim). Logged to grants.json so it shows in credit history.
      if (body && body.giftClaimed === true && !u.giftClaimed) {
        const _gm = Math.max(0, FREE_MEDIA_CREDITS - Math.floor(numOr(u.credits, 0)));
        const _gs = Math.max(0, FREE_SONG_CREDITS - Math.floor(numOr(u.songCredits, 0)));
        if (_gm > 0) u.credits = Math.floor(numOr(u.credits, 0)) + _gm;
        if (_gs > 0) u.songCredits = Math.floor(numOr(u.songCredits, 0)) + _gs;
        u.giftClaimed = true;
        // Notify ONLY when credits were actually granted. The old code
        // notified on every sync with giftClaimed:true, even when the
        // gift was already locked (no credits given) — the Admin got a
        // false "Gift claimed" alert for a user who got nothing.
        if (_gm > 0 || _gs > 0) {
          logGrant({ email, credits: _gm, songCredits: _gs, note: 'gift', at: now });
          addNotification('gift-claimed', email, '🎁 កាដូបានទទួល · Gift claimed', (u.name || email) + ' (' + email + ') បានទទួលកាដូ Free 250 Image.Video + 24 Song Credit');
        }
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
      if (_isNewDevice) {
        addNotification('security', email, '🔐 ឧបករណ៍ថ្មី · New device login', email + ' logged in from a new device: ' + (_model || _dev || 'Unknown') + ' · IP ' + (_cip || '—'));
      }
      return sendJSON(res, 200, { ok: true, user: pubUser(u, _modelLogins) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/set-password — {idToken, password, passwordConfirm}
  // PUBLIC. The website calls this after a Google sign-in (sign-up or
  // forgot-password): the Google ID token proves the Gmail belongs to
  // the caller, so the server sets (or resets) the MovAi password for
  // that Gmail. Password 6–64 chars, must match the confirmation.
  // Creates the user (0/0, giftClaimed:false) if they do not exist yet.
  // Returns {ok:true, user} (pubUser, with hasPassword:true) so the
  // website can log them in. The password hash is scrypt + per-user
  // salt — never plain text, never returned.
  if (req.method === 'POST' && urlPath === '/api/auth/set-password') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const idToken = body && typeof body.idToken === 'string' ? body.idToken.trim() : '';
      const password = body && typeof body.password === 'string' ? body.password : '';
      const passwordConfirm = body && typeof body.passwordConfirm === 'string' ? body.passwordConfirm : '';
      if (!idToken) return sendJSON(res, 200, { ok: false, error: 'Google sign-in មិនត្រឹមត្រូវទេ · Google sign-in failed' });
      if (password.length < 6 || password.length > 64) return sendJSON(res, 200, { ok: false, error: 'Password ត្រូវមាន 6–64 តួអក្សរ · Password must be 6–64 characters' });
      if (password !== passwordConfirm) return sendJSON(res, 200, { ok: false, error: 'Password ទាំងពីរមិនដូចគ្នាទេ · Passwords do not match' });
      const g = await verifyGoogleIdToken(idToken);
      if (!g) return sendJSON(res, 200, { ok: false, error: 'Google sign-in មិនត្រឹមត្រូវទេ · Google sign-in failed' });
      const email = g.email;
      // Blocked IP / Gmail: refuse (same as sync).
      const _cip0 = getClientIp(req);
      if (_cip0 && loadBlockedIps().some((b) => b === _cip0)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      if (loadBlockedEmails().some((b) => b === email)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      const now = new Date().toISOString();
      logActivity({ at: now, mode: 'set-password', email });
      const users = loadUsers();
      const isNewUser = !users[email];
      let u = users[email];
      if (!u) {
        const takenIds = new Set(Object.values(users).map((x) => x.id).filter(Boolean));
        u = { id: genUserId(takenIds), email, name: g.name || '', credits: 0, songCredits: 0, giftClaimed: false, plan: '', songPlan: '', createdAt: now, updatedAt: now };
        users[email] = u;
      } else {
        if (!u.id) { const takenIds = new Set(Object.values(users).map((x) => x.id).filter(Boolean)); u.id = genUserId(takenIds); }
        if (g.name && !u.name) u.name = g.name;
        u.updatedAt = now;
      }
      const hp = await hashPassword(password);
      u.passwordSalt = hp.salt;
      u.passwordHash = hp.hash;
      // A new password revokes ALL saved (remember-me) logins — the old
      // saved Accounts must not keep working after a password change.
      revokeAllRememberTokens(u);
      u.updatedAt = now;
      // A (re)set password clears any sign-in lock for this Gmail.
      signinClear(email);
      saveUsers(users);
      await ghFlushFile(USERS_FILE);
      if (isNewUser) addNotification('login', email, '👤 អ្នកប្រើថ្មី · New user', (u.name || email) + ' (' + email + ') បានចុះឈ្មោះ (Sign-up + Password)');
      return sendJSON(res, 200, { ok: true, user: pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/signin — {email, password} — PUBLIC. Gmail +
  // password sign-in (the normal sign-in after sign-up). Verifies the
  // scrypt hash; 5 wrong passwords lock the Gmail for 15 minutes.
  // Returns {ok:true, user} (pubUser) so the website can log them in
  // the same way as a Google sign-in. A WRONG password returns a
  // generic error (never says which part was wrong). BUT a Gmail with
  // NO account yet (never did Continue with Google) returns a clear
  // "no account yet" error + noAccount:true (owner order 2026-11-17)
  // so the website can show "Continue with Google first" — and it
  // does NOT count toward the lockout (it is not a wrong password).
  if (req.method === 'POST' && urlPath === '/api/auth/signin') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const password = body && typeof body.password === 'string' ? body.password : '';
      if (!email || !password) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail និង Password · Please enter Gmail and password' });
      // Blocked IP / Gmail: refuse (same as sync).
      const _cip0 = getClientIp(req);
      if (_cip0 && loadBlockedIps().some((b) => b === _cip0)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      if (loadBlockedEmails().some((b) => b === email)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      if (signinLocked(email)) return sendJSON(res, 200, { ok: false, error: 'បញ្ចូល Password ខុសច្រើនដងពេកហើយ សាកល្បងម្តងទៀត 15 នាទីក្រោយ · Too many wrong attempts, try again in 15 minutes' });
      const users = loadUsers();
      const u = users[email];
      const bad = () => sendJSON(res, 200, { ok: false, error: 'Gmail ឬ Password មិនត្រឹមត្រូវទេ · Wrong Gmail or password' });
      // No account yet, or the account never set a password (never did
      // Continue with Google): say so clearly so the website can send
      // them to Continue with Google first. Not a wrong-password
      // attempt, so it does not count toward the lockout.
      if (!u || !u.passwordHash || !u.passwordSalt) {
        return sendJSON(res, 200, { ok: false, error: 'មិនទាន់មាន Gmail នេះទេ — សូម Continue with Google ជាមុនសិន ទើបអាច Log in បាន · No account with this Gmail yet — please Continue with Google first, then you can log in', noAccount: true });
      }
      const okPw = await verifyPassword(password, u.passwordSalt, u.passwordHash);
      if (!okPw) { signinFail(email); return bad(); }
      signinClear(email);
      const now = new Date().toISOString();
      logActivity({ at: now, mode: 'signin', email });
      u.lastSeen = now;
      if (_cip0) u.lastIp = _cip0;
      u.updatedAt = now;
      saveUsers(users);
      await ghFlushFile(USERS_FILE);
      return sendJSON(res, 200, { ok: true, user: pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/remember — {email, password} — PUBLIC. Issues a
  // remember-me token after a successful Gmail+password sign-in (the
  // website calls this when the user answers "Yes" to "Save
  // password?"). Verifies the password the same way as signin, then
  // returns {ok:true, rememberToken} — the website stores it in
  // localStorage (per-device) with the Gmail. The token is random;
  // only its SHA-256 hash is stored server-side.
  if (req.method === 'POST' && urlPath === '/api/auth/remember') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const password = body && typeof body.password === 'string' ? body.password : '';
      if (!email || !password) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail និង Password · Please enter Gmail and password' });
      if (signinLocked(email)) return sendJSON(res, 200, { ok: false, error: 'បញ្ចូល Password ខុសច្រើនដងពេកហើយ សាកល្បងម្តងទៀត 15 នាទីក្រោយ · Too many wrong attempts, try again in 15 minutes' });
      const users = loadUsers();
      const u = users[email];
      const bad = () => sendJSON(res, 200, { ok: false, error: 'Gmail ឬ Password មិនត្រឹមត្រូវទេ · Wrong Gmail or password' });
      if (!u || !u.passwordHash || !u.passwordSalt) { signinFail(email); return bad(); }
      const okPw = await verifyPassword(password, u.passwordSalt, u.passwordHash);
      if (!okPw) { signinFail(email); return bad(); }
      signinClear(email);
      const token = issueRememberToken(u);
      u.updatedAt = new Date().toISOString();
      saveUsers(users);
      await ghFlushFile(USERS_FILE);
      return sendJSON(res, 200, { ok: true, rememberToken: token, email });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/remember-login — {email, rememberToken} — PUBLIC.
  // Tap-to-login with a saved Account: no password needed, the token
  // proves the device was saved. Returns {ok:true, user} on success.
  // Expired or revoked tokens fail with a generic error — the website
  // then drops the saved Account and shows the password form.
  if (req.method === 'POST' && urlPath === '/api/auth/remember-login') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const token = body && typeof body.rememberToken === 'string' ? body.rememberToken.trim() : '';
      if (!email || !token) return sendJSON(res, 200, { ok: false, error: 'ការចូលដែលបានសេវផុតកំណត់ហើយ សូមចូលដោយ Password ម្តងទៀត · Saved login expired, please sign in with your password' });
      const _cip0 = getClientIp(req);
      if (_cip0 && loadBlockedIps().some((b) => b === _cip0)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      if (loadBlockedEmails().some((b) => b === email)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      const users = loadUsers();
      const u = users[email];
      const bad = () => sendJSON(res, 200, { ok: false, error: 'ការចូលដែលបានសេវផុតកំណត់ហើយ សូមចូលដោយ Password ម្តងទៀត · Saved login expired, please sign in with your password' });
      if (!u) return bad();
      const entry = findRememberToken(u, token);
      if (!entry) return bad();
      const now = new Date().toISOString();
      logActivity({ at: now, mode: 'remember-login', email });
      u.lastSeen = now;
      if (_cip0) u.lastIp = _cip0;
      u.updatedAt = now;
      saveUsers(users);
      await ghFlushFile(USERS_FILE);
      return sendJSON(res, 200, { ok: true, user: pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/forget — {email, rememberToken} — PUBLIC. Removes
  // one saved Account (the website calls this when the user taps the
  // X on a saved Account). Always returns ok:true — a missing token
  // is already forgotten.
  if (req.method === 'POST' && urlPath === '/api/auth/forget') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const token = body && typeof body.rememberToken === 'string' ? body.rememberToken.trim() : '';
      if (!email || !token) return sendJSON(res, 200, { ok: true });
      const users = loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: true });
      if (revokeRememberToken(u, token)) {
        u.updatedAt = new Date().toISOString();
        saveUsers(users);
        await ghFlushFile(USERS_FILE);
      }
      return sendJSON(res, 200, { ok: true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/request-reset — {email} — PUBLIC. Forgot password:
  // sends the 6-digit verification code to the Gmail (same code system
  // as email verification — code lives 60 seconds, max 5 sends/hour).
  // The user must exist; otherwise the error says so (no code is sent
  // to a Gmail with no MovAi account). REQUIRES the Admin to have set
  // up email (Gmail App Password in settings) — otherwise the error
  // says email is not configured yet.
  if (req.method === 'POST' && urlPath === '/api/auth/request-reset') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = loadUsers();
      if (!users[email]) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន · No account with this Gmail, please sign up first' });
      if (!verifyEmailConfigured()) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Email (Gmail App Password) ទេ — សូមប្រាប់ Admin · Email is not set up yet, please tell the Admin' });
      const sent = await sendVerificationEmail(email);
      if (!sent.ok) return sendJSON(res, 200, { ok: false, error: sent.error || 'ផ្ញើលេខកូដមិនបានទេ · Could not send the code' });
      return sendJSON(res, 200, { ok: true, sent: true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/reset-password — {email, code, password,
  // passwordConfirm} — PUBLIC. Forgot password step 2: the 6-digit
  // code (from request-reset) proves the Gmail belongs to the caller,
  // then the new password is set (6–64 chars, must match). All saved
  // (remember-me) logins are revoked and the sign-in lock is cleared.
  // Returns {ok:true, user} so the website can log them in at once.
  if (req.method === 'POST' && urlPath === '/api/auth/reset-password') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const code = body && typeof body.code === 'string' ? body.code : '';
      const password = body && typeof body.password === 'string' ? body.password : '';
      const passwordConfirm = body && typeof body.passwordConfirm === 'string' ? body.passwordConfirm : '';
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      if (password.length < 6 || password.length > 64) return sendJSON(res, 200, { ok: false, error: 'Password ត្រូវមាន 6–64 តួអក្សរ · Password must be 6–64 characters' });
      if (password !== passwordConfirm) return sendJSON(res, 200, { ok: false, error: 'Password ទាំងពីរមិនដូចគ្នាទេ · Passwords do not match' });
      const v = verifyCodeCheck(email, code);
      if (!v.ok) return sendJSON(res, 200, { ok: false, error: v.error });
      const users = loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ · No account with this Gmail' });
      const hp = await hashPassword(password);
      u.passwordSalt = hp.salt;
      u.passwordHash = hp.hash;
      revokeAllRememberTokens(u);
      signinClear(email);
      const now = new Date().toISOString();
      logActivity({ at: now, mode: 'reset-password', email });
      u.updatedAt = now;
      saveUsers(users);
      await ghFlushFile(USERS_FILE);
      addNotification('security', email, '🔑 Password ត្រូវបានប្តូរ · Password changed', (u.name || email) + ' (' + email + ') បានប្តូរ Password តាមរយៈលេខកូដ 6 ខ្ទង់');
      return sendJSON(res, 200, { ok: true, user: pubUser(u) });
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
  // GET /api/admin/email-usage — admin key required. Live Brevo usage
  // for the Admin → Settings → Email panel: plan (Free), daily limit
  // (300/day), how many emails sent today, and how many remain.
  // Uses the stored Brevo API key; queries Brevo's account + today's
  // SMTP aggregated report. Returns {ok, provider:'brevo', plan,
  // dailyLimit, usedToday, remainingToday}. If no Brevo key is set,
  // returns ok:false (Gmail SMTP has no quota to show).
  if (req.method === 'GET' && urlPath === '/api/admin/email-usage') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const s = loadSettings();
    const em = (s && s.email && typeof s.email === 'object') ? s.email : {};
    const apiKey = typeof em.brevoApiKey === 'string' ? em.brevoApiKey.trim() : '';
    if (!apiKey) return sendJSON(res, 200, { ok: false, error: 'Brevo API key not configured' });
    (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 15000);
        // Today's date in Phnom Penh (the user's day) for the report.
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
        // Plan name from Brevo's account API when the key allows it
        // (a Restricted key may 403 here — fall back to 'Free').
        let planName = 'Free';
        try {
          const accR = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': apiKey, 'Accept': 'application/json' }, signal: ctrl.signal });
          if (accR.ok) {
            const acc = await accR.json().catch(() => ({}));
            const planType = (acc && Array.isArray(acc.plan) && acc.plan[0] && typeof acc.plan[0].type === 'string') ? acc.plan[0].type : 'free';
            planName = planType.toLowerCase().includes('free') ? 'Free' : planType;
          }
        } catch (e) {}
        clearTimeout(timer);
        // Used today comes from the server's own send counter (see
        // brevoUsageToday) — a Restricted key cannot read Brevo's
        // statistics API, so Brevo's numbers are not used here.
        const usedToday = brevoUsageToday().sent;
        const dailyLimit = 300;
        return sendJSON(res, 200, { ok: true, provider: 'brevo', plan: planName, dailyLimit, usedToday, remainingToday: Math.max(0, dailyLimit - usedToday), date: today });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: 'Brevo usage check failed — ' + (e && e.message ? String(e.message).slice(0, 200) : 'error') });
      }
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'Brevo usage check failed' }));
    return;
  }
  // GET /api/admin/groq-usage — admin key required. Live Groq token
  // usage per key for the Admin → API Keys display: daily limit
  // (200,000 tokens/day/key), used today, remaining today, percent
  // remaining, and status (green >50% left, yellow <=50%, red 0 left).
  // Keys are 1-based indexes only — key values are never returned.
  if (req.method === 'GET' && urlPath === '/api/admin/groq-usage') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const u = groqUsageList();
    return sendJSON(res, 200, { ok: true, provider: 'groq', date: u.date, dailyLimit: u.dailyLimit, keys: u.keys });
  }
  // GET /api/admin/mvsep-usage — admin key required. MVSEP separations used
  // today per key for the Admin → API Keys display: daily limit (50/day/key),
  // used today, remaining today, and status (green = separations left, red =
  // daily limit reached). Keys are 1-based indexes only — key values are
  // never returned.
  if (req.method === 'GET' && urlPath === '/api/admin/mvsep-usage') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const u = mvsepUsageList();
    return sendJSON(res, 200, { ok: true, provider: 'mvsep', date: u.date, dailyLimit: u.dailyLimit, keys: u.keys });
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
        addNotification('deduct', email, '➖ កាត់ Credit · Credits deducted', 'Admin បានកាត់ ' + deltaText + ' ពី ' + email + ' · ID: ' + (u.id || '—') + (grantNote ? ' — ' + grantNote : ''));
      } else {
        addNotification('grant', email, '➕ បន្ថែម Credit · Credits granted', 'Admin បានបន្ថែម ' + deltaText + ' ឲ្យ ' + email + ' · ID: ' + (u.id || '—') + (grantNote ? ' — ' + grantNote : ''));
      }
      return sendJSON(res, 200, { ok: true, user: pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/reset-password — {email, newPassword?} — admin key
  // required. Admin password management (owner order 2026-11-17): the
  // Admin can reset any user's password. With newPassword (6–64 chars)
  // it sets that password for the user (Admin tells the user the new
  // password). WITHOUT newPassword it CLEARS the password — the user
  // must set a new one via Forgot password (6-digit code) or Google.
  // NOTE: the Admin can NEVER view a user's plain password — passwords
  // are stored only as scrypt hashes, which cannot be reversed. The
  // Admin sees hasPassword (in pubUser) and can reset; that is the
  // secure equivalent. All saved (remember-me) logins are revoked and
  // the sign-in lock is cleared.
  if (req.method === 'POST' && urlPath === '/api/admin/reset-password') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const newPassword = body && typeof body.newPassword === 'string' ? body.newPassword : '';
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
      const now = new Date().toISOString();
      if (newPassword) {
        if (newPassword.length < 6 || newPassword.length > 64) return sendJSON(res, 200, { ok: false, error: 'Password ត្រូវមាន 6–64 តួអក្សរ · Password must be 6–64 characters' });
        const hp = await hashPassword(newPassword);
        u.passwordSalt = hp.salt;
        u.passwordHash = hp.hash;
        addNotification('security', email, '🔑 Admin បានប្តូរ Password · Admin reset password', 'Admin បានប្តូរ Password ឲ្យ ' + email + ' (Password ថ្មី — សូមប្រាប់អ្នកប្រើ)');
      } else {
        u.passwordHash = null;
        u.passwordSalt = null;
        addNotification('security', email, '🔑 Admin បានលុប Password · Admin cleared password', 'Admin បានលុប Password របស់ ' + email + ' — អ្នកប្រើត្រូវបង្កើត Password ថ្មី (Forgot password ឬ Google)');
      }
      revokeAllRememberTokens(u);
      signinClear(email);
      logActivity({ at: now, mode: 'admin-reset-password', email });
      u.updatedAt = now;
      saveUsers(users);
      await ghFlushFile(USERS_FILE);
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
  // POST /api/admin/block-ip — {ip} — admin key required. MANUAL block:
  // the admin reviews the Security section and decides. A blocked IP
  // cannot sync (and cannot call admin endpoints with a wrong key).
  if (req.method === 'POST' && urlPath === '/api/admin/block-ip') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const ip = typeof body && typeof body.ip === 'string' ? body.ip.trim().slice(0, 64) : '';
      if (!ip || !/^[0-9a-zA-Z:.\-]+$/.test(ip)) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ IP ត្រឹមត្រូវ' });
      const blocked = loadBlockedIps();
      if (!blocked.some((b) => b === ip)) blocked.push(ip);
      saveBlockedIps(blocked);
      await ghFlushFile(BLOCKED_IPS_FILE);
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/unblock-ip — {ip} — admin key required. Removes an IP
  // from the blocked list so it can sync again.
  if (req.method === 'POST' && urlPath === '/api/admin/unblock-ip') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const ip = typeof body && typeof body.ip === 'string' ? body.ip.trim().slice(0, 64) : '';
      if (!ip) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ IP ត្រឹមត្រូវ' });
      const blocked = loadBlockedIps().filter((b) => b !== ip);
      saveBlockedIps(blocked);
      await ghFlushFile(BLOCKED_IPS_FILE);
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/blocked-ips — admin key required. Lists blocked IPs.
  if (req.method === 'GET' && urlPath === '/api/admin/blocked-ips') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, blocked: loadBlockedIps() });
  }
  // POST /api/admin/block-email — {email} — admin key required. MANUAL
  // block: a blocked Gmail cannot sync at all.
  if (req.method === 'POST' && urlPath === '/api/admin/block-email') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const blocked = loadBlockedEmails();
      if (!blocked.some((b) => b === email)) blocked.push(email);
      saveBlockedEmails(blocked);
      await ghFlushFile(BLOCKED_EMAILS_FILE);
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/unblock-email — {email} — admin key required. Removes
  // a Gmail from the blocked list so it can sync again.
  if (req.method === 'POST' && urlPath === '/api/admin/unblock-email') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const blocked = loadBlockedEmails().filter((b) => b !== email);
      saveBlockedEmails(blocked);
      await ghFlushFile(BLOCKED_EMAILS_FILE);
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/blocked-emails — admin key required. Lists blocked Gmails.
  if (req.method === 'GET' && urlPath === '/api/admin/blocked-emails') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, blocked: loadBlockedEmails() });
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
  // APPENDS the key to that provider's list (the others are NOT replaced).
  // If the exact key value already exists, only its endpoint is updated
  // (no duplicate). The response NEVER contains the key value. endpoint
  // is only needed for Suno (its gateway URL).
  if (req.method === 'POST' && urlPath === '/api/admin/keys') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const provider = normProvider(body && body.provider);
      if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ API Key' });
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim().slice(0, 500) : '';
      const keys = loadAdminKeys();
      const rec = keys[provider] && Array.isArray(keys[provider].keys) ? keys[provider] : { keys: [], updatedAt: new Date().toISOString() };
      const now = new Date().toISOString();
      const existing = rec.keys.find((e) => e && e.key === key);
      if (existing) {
        existing.endpoint = endpoint;
      } else {
        rec.keys.push({ key, endpoint, addedAt: now });
      }
      rec.updatedAt = now;
      keys[provider] = rec;
      saveAdminKeys(keys);
      await ghFlushFile(ADMIN_KEYS_FILE);
      return sendJSON(res, 200, { ok: true, provider, keyCount: rec.keys.length, hasKey: true, hasEndpoint: rec.keys.some((e) => e && e.endpoint && e.endpoint.trim()) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/admin/keys — {provider, index} — admin key required.
  // Removes the key at that index from the provider's list.
  if (req.method === 'DELETE' && urlPath === '/api/admin/keys') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const provider = normProvider(body && body.provider);
      if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      const idx = Number(body && body.index);
      const keys = loadAdminKeys();
      const rec = keys[provider];
      const list = rec && Array.isArray(rec.keys) ? rec.keys : [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return sendJSON(res, 200, { ok: false, error: 'Index មិនត្រឹមត្រូវទេ' });
      list.splice(idx, 1);
      rec.updatedAt = new Date().toISOString();
      saveAdminKeys(keys);
      await ghFlushFile(ADMIN_KEYS_FILE);
      return sendJSON(res, 200, { ok: true, provider, keyCount: list.length, hasKey: list.length > 0, hasEndpoint: list.some((e) => e && e.endpoint && e.endpoint.trim()) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/keys — admin key required. Lists which providers have
  // keys stored, HOW MANY per provider (keyCount), and whether an endpoint
  // is set. Key values are NEVER returned.
  if (req.method === 'GET' && urlPath === '/api/admin/keys') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const keys = loadAdminKeys();
    const list = Object.keys(keys).sort().map((p) => {
      const arr = keys[p] && Array.isArray(keys[p].keys) ? keys[p].keys : [];
      return { provider: p, hasKey: arr.length > 0, keyCount: arr.length, hasEndpoint: arr.some((e) => e && e.endpoint && e.endpoint.trim()) };
    });
    return sendJSON(res, 200, { ok: true, keys: list });
  }
  // GET /api/admin/keys/values?provider=X — admin key required. Returns
  // the FULL key values for one provider so the Admin app can show (eye)
  // and copy them. Only the admin-key holder (the owner) can call this —
  // the public GET /api/admin/keys never returns values.
  if (req.method === 'GET' && urlPath === '/api/admin/keys/values') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const provider = normProvider(new URL(req.url, 'http://localhost').searchParams.get('provider') || '');
    if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
    const rec = loadAdminKeys()[provider];
    const list = rec && Array.isArray(rec.keys) ? rec.keys : [];
    return sendJSON(res, 200, { ok: true, provider, keys: list.map((e) => ({ key: e.key || '', endpoint: e.endpoint || '', addedAt: e.addedAt || '' })) });
  }
  // ---- Admin Key: Google sign-in session + reveal + reset ----
  // POST /api/admin/key/verify-google — PUBLIC. {idToken} (Google ID
  // token from the Admin website's Google sign-in). The server verifies
  // the token with Google (tokeninfo: aud, iss, exp, email_verified),
  // checks the Gmail is one of the three admin Gmails, and issues a
  // 15-minute session token tied to that Gmail. The error never says
  // whether the token or the Gmail was the problem.
  if (req.method === 'POST' && urlPath === '/api/admin/key/verify-google') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const idToken = body && typeof body.idToken === 'string' ? body.idToken.trim() : '';
      if (!idToken) return sendJSON(res, 200, { ok: false, error: 'Google sign-in មិនត្រឹមត្រូវទេ · Google sign-in failed' });
      let info = null;
      try {
        const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { signal: AbortSignal.timeout(10000) });
        if (r.ok) info = await r.json().catch(() => null);
      } catch (e) {}
      const bad = () => sendJSON(res, 200, { ok: false, error: 'Google sign-in មិនត្រឹមត្រូវទេ · Google sign-in failed' });
      if (!info || typeof info !== 'object') return bad();
      if (info.aud !== MOVAI_GOOGLE_CLIENT_ID) return bad();
      if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') return bad();
      if (info.email_verified !== 'true' && info.email_verified !== true) return bad();
      const expMs = Number(info.exp) * 1000;
      if (!Number.isFinite(expMs) || expMs <= Date.now()) return bad();
      const email = normEmail(info.email);
      if (!email || !ADMIN_EMAILS.includes(email)) return bad();
      const session = issueAdminKeySession(email, typeof info.name === 'string' ? info.name : '', typeof info.picture === 'string' ? info.picture : '');
      return sendJSON(res, 200, { ok: true, session, email, name: typeof info.name === 'string' ? info.name : '', picture: typeof info.picture === 'string' ? info.picture : '' });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/key/reveal — requires header Authorization: Bearer
  // <session> (valid, unexpired, admin Gmail). Returns the current
  // Admin Key so the Admin app can show (eye) and copy it. Max 5
  // reveals per Gmail per hour.
  if (req.method === 'GET' && urlPath === '/api/admin/key/reveal') {
    const s = adminKeySessionFromReq(req);
    if (!s) return sendJSON(res, 200, { ok: false, error: 'Session ផុតកំណត់ហើយ សូមចូល Google ម្តងទៀត · Session expired, please sign in with Google again' });
    if (!adminKeyRateOk(s.email, 'reveal')) return sendJSON(res, 200, { ok: false, error: 'មើល key ច្រើនដងពេកហើយ សាកល្បងម្តងទៀត 1 ម៉ោងក្រោយ · Too many reveals, try again in 1 hour' });
    const k = currentAdminKey();
    if (!k) return sendJSON(res, 200, { ok: false, error: 'Admin key មិនទាន់បានកំណត់ទេ · Admin key is not configured' });
    return sendJSON(res, 200, { ok: true, key: k });
  }
  // POST /api/admin/key/reset — {newKey} — requires header
  // Authorization: Bearer <session>. Replaces the Admin Key with
  // newKey (8–64 chars). The old key stops working immediately. The
  // IP's lockout strikes are cleared and a security notification is
  // logged. Max 5 resets per Gmail per hour.
  if (req.method === 'POST' && urlPath === '/api/admin/key/reset') {
    const s = adminKeySessionFromReq(req);
    if (!s) return sendJSON(res, 200, { ok: false, error: 'Session ផុតកំណត់ហើយ សូមចូល Google ម្តងទៀត · Session expired, please sign in with Google again' });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const newKey = body && typeof body.newKey === 'string' ? body.newKey.trim() : '';
      if (newKey.length < 8 || newKey.length > 64) return sendJSON(res, 200, { ok: false, error: 'Key ថ្មីត្រូវមាន 8–64 តួអក្សរ · New key must be 8–64 characters' });
      if (!adminKeyRateOk(s.email, 'reset')) return sendJSON(res, 200, { ok: false, error: 'ប្តូរ key ច្រើនដងពេកហើយ សាកល្បងម្តងទៀត 1 ម៉ោងក្រោយ · Too many resets, try again in 1 hour' });
      saveAdminKeyFile(newKey);
      await ghFlushFile(ADMIN_KEY_FILE);
      try { clearAdminLockout(getClientIp(req)); } catch (e) {}
      addNotification('security', s.email, '🗝️ Admin Key ត្រូវបានប្តូរ · Admin Key changed', 'Admin Key ត្រូវបានប្តូរដោយ ' + s.email + ' (តាមរយៈ Google sign-in)');
      return sendJSON(res, 200, { ok: true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // Test one provider key with a lightweight authenticated call.
  // status: 'ok' = works (green), 'blocked' = 401/403 invalid or blocked
  // (red), 'error' = rate limit / network / other (yellow), 'unknown' =
  // this provider has no testable endpoint (yellow).
  async function testProviderKey(provider, key, endpoint) {
    const p = normProvider(provider);
    const timeoutMs = 15000;
    const blockedMsg = (s) => ({ status: 'blocked', message: 'Key មិនត្រឹមត្រូវ ឬត្រូវបានប្លុក (HTTP ' + s + ')' });
    const okMsg = { status: 'ok', message: 'Ready — Key ដំណើរការល្អ' };
    try {
      if (p === 'groq') {
        const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 200) return okMsg;
        if (r.status === 401 || r.status === 403) return blockedMsg(r.status);
        if (r.status === 429) return { status: 'error', message: 'Rate limit (HTTP 429) — សាកល្បងម្តងទៀតពេលក្រោយ' };
        return { status: 'error', message: 'Groq ឆ្លើយ HTTP ' + r.status };
      }
      if (p === 'novai') {
        const r = await fetch('https://aiapi-pro.com/v1/models', { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 200) return okMsg;
        if (r.status === 401 || r.status === 403) return blockedMsg(r.status);
        if (r.status === 429) return { status: 'error', message: 'Rate limit (HTTP 429) — សាកល្បងម្តងទៀតពេលក្រោយ' };
        return { status: 'error', message: 'NovAI ឆ្លើយ HTTP ' + r.status };
      }
      if (p === 'tavus') {
        const r = await fetch('https://tavusapi.com/v2/replicas', { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 200) return okMsg;
        if (r.status === 401 || r.status === 403) return blockedMsg(r.status);
        if (r.status === 429) return { status: 'error', message: 'Rate limit (HTTP 429) — សាកល្បងម្តងទៀតពេលក្រោយ' };
        return { status: 'error', message: 'Tavus ឆ្លើយ HTTP ' + r.status };
      }
      if (p === 'magichour') {
        // GET on the POST-only create endpoint: a valid key answers 405
        // (wrong method, auth passed); a bad key answers 401/403.
        const r = await fetch('https://api.magichour.ai/v1/ai-image-generator', { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 401 || r.status === 403) return blockedMsg(r.status);
        if (r.status === 429) return { status: 'error', message: 'Rate limit (HTTP 429) — សាកល្បងម្តងទៀតពេលក្រោយ' };
        return okMsg;
      }
      if (p === 'musicapi') {
        // GET a fake task id: a valid key answers 404/400 (task not found,
        // auth passed); a bad key answers 401/403.
        const r = await fetch('https://api.musicapi.ai/api/v1/sonic/task/00000000-0000-0000-0000-000000000000', { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 401 || r.status === 403) return blockedMsg(r.status);
        if (r.status === 429) return { status: 'error', message: 'Rate limit (HTTP 429) — សាកល្បងម្តងទៀតពេលក្រោយ' };
        return okMsg;
      }
      if (p === 'suno') {
        const ep = typeof endpoint === 'string' ? endpoint.replace(/\/+$/, '') : '';
        if (!ep) return { status: 'unknown', message: 'មិនមាន gateway endpoint — មិនអាចសាកល្បងបាន' };
        // GET the credit balance (sunoapi.org): a valid key answers 200
        // (integer credits); a bad key answers 401/403.
        const r = await fetch(ep + '/api/v1/generate/credit', { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 401 || r.status === 403) return blockedMsg(r.status);
        if (r.status === 429) return { status: 'error', message: 'Rate limit (HTTP 429) — សាកល្បងម្តងទៀតពេលក្រោយ' };
        return okMsg;
      }
      return { status: 'unknown', message: 'Provider នេះមិនមាន endpoint សម្រាប់សាកល្បងទេ' };
    } catch (e) {
      return { status: 'error', message: 'មិនអាចភ្ជាប់បាន — ' + String((e && e.message) || e).slice(0, 120) };
    }
  }
  // GET /api/admin/keys/status?provider=X — admin key required. Tests
  // every stored key for one provider and returns per-key status
  // (ok/blocked/error/unknown) for the Admin app's green/red/yellow dots.
  if (req.method === 'GET' && urlPath === '/api/admin/keys/status') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const provider = normProvider(new URL(req.url, 'http://localhost').searchParams.get('provider') || '');
    if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
    const rec = loadAdminKeys()[provider];
    const list = rec && Array.isArray(rec.keys) ? rec.keys : [];
    (async () => {
      const results = [];
      for (let i = 0; i < list.length; i++) {
        const t = await testProviderKey(provider, list[i].key, list[i].endpoint);
        results.push({ index: i, status: t.status, message: t.message });
      }
      return sendJSON(res, 200, { ok: true, provider, results });
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'សាកល្បងមិនបានទេ' }));
    return;
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
  // GET /api/public/credit-history?email=... — PUBLIC. The user's own
  // credit history: every grant (+) and deduction (-) with note + time,
  // newest first. This is what the Profile shows as "History".
  if (req.method === 'GET' && urlPath === '/api/public/credit-history') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail' });
    let arr = [];
    try { const j = JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8')); if (Array.isArray(j)) arr = j; } catch (e) {}
    const mine = arr.filter((g) => g && typeof g.email === 'string' && g.email.toLowerCase() === email).slice(-100).reverse();
    return sendJSON(res, 200, { ok: true, email, history: mine.map((g) => ({ credits: numOr(g.credits, 0), songCredits: numOr(g.songCredits, 0), note: typeof g.note === 'string' ? g.note : '', at: g.at || '' })) });
  }
  // GET /api/public/history?email=... — PUBLIC. The user's own created
  // things (History): songs/images/videos, newest first, max 300.
  // This is what makes ONE Gmail show ALL old data on ANY device.
  if (req.method === 'GET' && urlPath === '/api/public/history') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail' });
    const h = loadHistory();
    const arr = Array.isArray(h[email]) ? h[email] : [];
    return sendJSON(res, 200, { ok: true, email, items: arr.slice(0, 300) });
  }
  // POST /api/public/history — PUBLIC. {email, items:[...]}. Merges the
  // incoming items with the stored History for that email (by item id,
  // else by src/url; same key keeps the one with the larger ts), strips
  // base64 thumbnails, sorts newest first, caps at 300.
  if (req.method === 'POST' && urlPath === '/api/public/history') {
    readJSONBody(req, 512 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail' });
      if (!body || !Array.isArray(body.items)) return sendJSON(res, 200, { ok: false, error: 'ទិន្នន័យមិនត្រឹមត្រូវទេ' });
      const h = loadHistory();
      const byKey = {};
      const stored = Array.isArray(h[email]) ? h[email] : [];
      for (const it of stored) {
        if (!it || typeof it !== 'object') continue;
        const k = histKey(it);
        if (k) byKey[k] = it;
      }
      for (const it of body.items) {
        if (!it || typeof it !== 'object') continue;
        const k = histKey(it);
        if (!k) continue;
        const clean = Object.assign({}, it);
        delete clean.thumb;
        const prev = byKey[k];
        if (!prev || numOr(clean.ts, 0) > numOr(prev.ts, 0)) byKey[k] = clean;
      }
      const merged = Object.values(byKey).sort((a, b) => numOr(b.ts, 0) - numOr(a.ts, 0)).slice(0, 300);
      h[email] = merged;
      saveHistory(h);
      // Critical write: confirm history.json is on GitHub BEFORE
      // returning success, so a restart cannot lose History already
      // reported as saved.
      await ghFlushFile(HISTORY_FILE);
      return sendJSON(res, 200, { ok: true, email, items: merged });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }

  // ---- Auto Update Version New (endpoints) ----
  // GET /api/admin/updates — admin key required. Lists updates + settings.
  if (req.method === 'GET' && urlPath === '/api/admin/updates') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const u = loadUpdates();
    return sendJSON(res, 200, { ok: true, updates: u.updates, settings: u.settings, lastCheckAt: u.lastCheckAt, lastCheckResult: u.lastCheckResult, approvedModels: u.approvedModels, blockedModels: u.blockedModels });
  }
  // POST /api/admin/updates/check — admin key required. Run a check now.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/check') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    (async () => {
      const n = await autoUpdateCheckModels();
      return sendJSON(res, 200, { ok: true, newCount: n });
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'ពិនិត្យមិនបានទេ' }));
    return;
  }
  // POST /api/admin/updates/approve — {updateId} — admin key required.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/approve') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.updateId === 'string' ? body.updateId.trim() : '';
      const u = loadUpdates();
      const rec = u.updates.find((x) => x.id === id);
      if (!rec) return sendJSON(res, 200, { ok: false, error: 'រក update នេះមិនឃើញទេ' });
      const ok2 = await autoUpdateApplyUpdate(rec, 'admin');
      return sendJSON(res, 200, { ok: ok2, updates: loadUpdates().updates });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/updates/reject — {updateId} — admin key required.
  // "Don't update": blocks the model so it is never re-detected.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/reject') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.updateId === 'string' ? body.updateId.trim() : '';
      const u = loadUpdates();
      const rec = u.updates.find((x) => x.id === id);
      if (!rec) return sendJSON(res, 200, { ok: false, error: 'រក update នេះមិនឃើញទេ' });
      if (rec.status === 'pending') {
        rec.status = 'rejected';
        rec.decidedAt = new Date().toISOString();
        rec.decidedBy = 'admin';
        const key = rec.provider + ':' + rec.model;
        if (!u.blockedModels.includes(key)) u.blockedModels.push(key);
        saveUpdates(u);
        await ghFlushFile(UPDATES_FILE);
        addNotification('update', '', '🚫 មិន Update · ' + rec.provider + ' — ' + rec.model, 'Admin ដាក់ "មិនចាំបាច់ Update" សម្រាប់ model ' + rec.model + '។ វានឹងមិនលេចឡើងម្តងទៀតទេ។');
      }
      return sendJSON(res, 200, { ok: true, updates: loadUpdates().updates });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/updates/settings — {autoApply, autoApplyHours, checkIntervalHours} — admin key required.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/settings') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const u = loadUpdates();
      if (typeof body.autoApply === 'boolean') u.settings.autoApply = body.autoApply;
      if (typeof body.autoApplyHours === 'number' && body.autoApplyHours >= 1 && body.autoApplyHours <= 720) u.settings.autoApplyHours = Math.round(body.autoApplyHours);
      if (typeof body.checkIntervalHours === 'number' && body.checkIntervalHours >= 1 && body.checkIntervalHours <= 168) u.settings.checkIntervalHours = Math.round(body.checkIntervalHours);
      saveUpdates(u);
      await ghFlushFile(UPDATES_FILE);
      return sendJSON(res, 200, { ok: true, settings: u.settings });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/updates/add — {provider, model, note} — admin key
  // required. Manually register a new model (e.g. Suno v6.5 announced on
  // their blog — no API to detect it). Creates a pending update.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/add') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const provider = normProvider(body && body.provider);
      const model = typeof body.model === 'string' ? body.model.trim().slice(0, 100) : '';
      if (!provider || !model) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ provider និង model' });
      const u = loadUpdates();
      if (!Array.isArray(u.knownModels[provider])) u.knownModels[provider] = [];
      if (!u.knownModels[provider].includes(model)) u.knownModels[provider].push(model);
      const dup = u.updates.find((x) => x.provider === provider && x.model === model && x.status === 'pending');
      if (dup) return sendJSON(res, 200, { ok: false, error: 'Model នេះមានក្នុងបញ្ជីរង់ចាំហើយ' });
      const rec = { id: newUpdateId(), provider, model, status: 'pending', source: 'manual', detectedAt: new Date().toISOString(), decidedAt: null, decidedBy: '', note: typeof body.note === 'string' ? body.note.slice(0, 200) : '' };
      u.updates.unshift(rec);
      saveUpdates(u);
      await ghFlushFile(UPDATES_FILE);
      addNotification('update', '', '🆕 Model ថ្មី (Manual) · ' + provider + ' — ' + model, 'Admin បន្ថែម model ថ្មី៖ ' + model + '។ សូម Approve ឬដាក់ "មិនចាំបាច់ Update"។');
      return sendJSON(res, 200, { ok: true, updates: u.updates });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/public/models — PUBLIC (no admin key). The MovAi website
  // reads it to show the approved model list; models approved within the
  // last 7 days are flagged "new" so the website can show a New badge.
  if (req.method === 'GET' && urlPath === '/api/public/models') {
    const u = loadUpdates();
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const newModels = [];
    for (const r of u.updates) {
      if ((r.status === 'approved' || r.status === 'auto-applied') && r.decidedAt && new Date(r.decidedAt).getTime() >= weekAgo) newModels.push(r.provider + ':' + r.model);
    }
    return sendJSON(res, 200, { ok: true, models: u.approvedModels, newModels });
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
        receiptUrl: typeof body.receiptUrl === 'string' ? body.receiptUrl.trim().slice(0, 500) : '',
        status: 'pending', createdAt: now, updatedAt: now,
      };
      reqs.push(r);
      savePurchaseRequests(reqs);
      const _pu = loadUsers()[email];
      const _puid = _pu && _pu.id ? _pu.id : '—';
      const _pd = pkgDisplay(pkg);
      addNotification('purchase-request', email, '🛒 សំណើទិញកញ្ចប់ · Purchase request', pkgNotifText(pkg, email, _puid), { extra: { pkg: packageId, pkgName: _pd.pkgName, priceText: _pd.priceText, creditText: _pd.creditText, buyerId: _puid }, telegramHtml: pkgNotifTelegram('🛒 សំណើទិញកញ្ចប់ · Purchase request', pkg, email, _puid) });
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
    const _users = loadUsers();
    const list = reqs
      .filter((r) => status === 'all' || r.status === status)
      .sort((x, y) => ((order[x.status] ?? 3) - (order[y.status] ?? 3)) || String(y.createdAt || '').localeCompare(String(x.createdAt || '')))
      .map((r) => {
        const _u = _users[r.email];
        return Object.assign({}, r, { buyerId: _u && _u.id ? _u.id : '' });
      });
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
      if (pkg.credits) { u.plan = r.packageId; u.planExpiresAt = new Date(Date.now() + Math.max(1, pkg.days || 30) * 86400000).toISOString(); }
      if (pkg.songCredits) { u.songPlan = r.packageId; u.songPlanExpiresAt = new Date(Date.now() + Math.max(1, pkg.days || 30) * 86400000).toISOString(); }
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
      const _pd2 = pkgDisplay(pkg);
      addNotification('purchase-approved', r.email, '✅ បានអនុម័ត · Purchase approved', pkgNotifText(pkg, r.email, u.id || '—'), { extra: { pkg: r.packageId, pkgName: _pd2.pkgName, priceText: _pd2.priceText, creditText: _pd2.creditText, buyerId: u.id || '—', decision: 'approved' }, telegramHtml: pkgNotifTelegram('✅ បានអនុម័ត · Purchase approved', pkg, r.email, u.id || '—') });
      markPurchaseRequestDecided(r.email, r.packageId, 'approved', now);
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
      const _ru = loadUsers()[r.email];
      const _ruid = _ru && _ru.id ? _ru.id : '—';
      const _pkgR = loadPackages()[r.packageId];
      const _pd3 = pkgDisplay(_pkgR);
      addNotification('purchase-rejected', r.email, '❌ បដិសេធ · Purchase rejected', pkgNotifText(_pkgR, r.email, _ruid), { extra: { pkg: r.packageId, pkgName: _pd3.pkgName, priceText: _pd3.priceText, creditText: _pd3.creditText, buyerId: _ruid, decision: 'rejected' }, telegramHtml: pkgNotifTelegram('❌ បដិសេធ · Purchase rejected', _pkgR, r.email, _ruid) });
      markPurchaseRequestDecided(r.email, r.packageId, 'rejected', now);
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
      const yearStart = nowMs - 365 * DAY;
      let songsToday = 0, videosToday = 0, imagesToday = 0, failuresToday = 0;
      let songsYear = 0, videosYear = 0, imagesYear = 0, failuresYear = 0;
      const failures = [];
      for (const r of act) {
        if (!r || !r.at) continue;
        const t = Date.parse(r.at);
        if (!Number.isFinite(t)) continue;
        if (t >= yearStart) {
          if (r.mode === 'song' && r.ok) songsYear++;
          else if (r.mode === 'video' && r.ok) videosYear++;
          else if (r.mode === 'image' && r.ok) imagesYear++;
          if ((r.mode === 'image' || r.mode === 'video' || r.mode === 'song') && r.ok === false) failuresYear++;
        }
        if (t < todayStart) continue;
        if (r.mode === 'song' && r.ok) songsToday++;
        else if (r.mode === 'video' && r.ok) videosToday++;
        else if (r.mode === 'image' && r.ok) imagesToday++;
        if ((r.mode === 'image' || r.mode === 'video' || r.mode === 'song') && r.ok === false) {
          failuresToday++;
          failures.push({ at: r.at, mode: r.mode, provider: r.provider || '', error: r.error || '' });
        }
      }
      // Public totals (from the real public feed) + recent activity so the
      // Admin tracking page shows real numbers everywhere, immediately.
      // NOTE: read public.json directly — loadPublicPosts()/PUBLIC_FILE are
      // declared later in this handler, so calling them here throws a TDZ
      // ReferenceError and the catch below would return all zeros.
      let pubPosts = [];
      try {
        const _pj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'public.json'), 'utf8'));
        if (Array.isArray(_pj)) pubPosts = _pj.filter((p) => p && p.visibility === 'public');
      } catch (e) {}
      let publicPosts = pubPosts.length, publicViews = 0, publicLikes = 0, publicDownloads = 0, songsTotal = 0, mediaTotal = 0;
      for (const p of pubPosts) {
        publicViews += (p.views || 0);
        publicLikes += (p.likes || 0);
        publicDownloads += (p.downloads || 0);
        if (p.mode === 'song') songsTotal++;
        else mediaTotal++;
      }
      const recentActivity = act.slice(-20).reverse().map((r) => ({ at: r.at || '', email: r.email || '', mode: r.mode || '', ok: r.ok !== false, error: r.error || '' }));
      return sendJSON(res, 200, { ok: true, stats: {
        usersToday: distinctSyncUsers(1),
        usersWeek: distinctSyncUsers(7),
        usersMonth: distinctSyncUsers(30),
        usersYear: distinctSyncUsers(365),
        songsToday, videosToday, imagesToday,
        failuresToday,
        songsYear, videosYear, imagesYear, failuresYear,
        recentErrors: failures.slice(-20).reverse(),
        publicPosts, publicViews, publicLikes, publicDownloads, songsTotal, mediaTotal,
        recentActivity,
      }});
    } catch (e) {
      return sendJSON(res, 200, { ok: true, stats: { usersToday: 0, usersWeek: 0, usersMonth: 0, usersYear: 0, songsToday: 0, videosToday: 0, imagesToday: 0, failuresToday: 0, songsYear: 0, videosYear: 0, imagesYear: 0, failuresYear: 0, recentErrors: [], publicPosts: 0, publicViews: 0, publicLikes: 0, publicDownloads: 0, songsTotal: 0, mediaTotal: 0, recentActivity: [] } });
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
  // GET /api/admin/security — admin key required. Security-kind
  // notifications only (new-device logins + blocked-model login
  // attempts), newest first, limit 100. Read/mark-read reuse the
  // existing notifications flow (POST /api/admin/notifications/read).
  if (req.method === 'GET' && urlPath === '/api/admin/security') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const events = loadNotifications().filter((n) => n && n.kind === 'security').slice(0, 100);
    return sendJSON(res, 200, { ok: true, events });
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
  // ---- Email verification (login) — PUBLIC ----
  // POST /api/auth/send-verification — {email} — sends a branded email
  // with a 6-digit code + magic link. Required on EVERY login (also after
  // sign-out + log in again). Rate-limited: 5 emails/address/hour.
  if (req.method === 'POST' && urlPath === '/api/auth/send-verification') {
    readJSONBody(req, 16 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const r = await sendVerificationEmail(email);
      return sendJSON(res, 200, r);
    }).catch(() => sendJSON(res, 200, { ok: false, error: 'Server error' }));
    return;
  }
  // POST /api/auth/verify-code — {email, code} — verifies the 6-digit code.
  if (req.method === 'POST' && urlPath === '/api/auth/verify-code') {
    readJSONBody(req, 16 * 1024).then((body) => {
      const r = verifyCodeCheck(body && body.email, body && body.code);
      return sendJSON(res, 200, r);
    }).catch(() => sendJSON(res, 200, { ok: false, error: 'Server error' }));
    return;
  }
  // POST /api/auth/verify-token — {token} — verifies a magic-link token.
  if (req.method === 'POST' && urlPath === '/api/auth/verify-token') {
    readJSONBody(req, 16 * 1024).then((body) => {
      const r = verifyTokenCheck(body && body.token);
      return sendJSON(res, 200, r);
    }).catch(() => sendJSON(res, 200, { ok: false, error: 'Server error' }));
    return;
  }
  // GET /api/auth/email-status — PUBLIC. Whether email verification is
  // configured (App Password set). The website uses it to decide whether
  // to show the verification step.
  if (req.method === 'GET' && urlPath === '/api/auth/email-status') {
    return sendJSON(res, 200, { ok: true, configured: verifyEmailConfigured() });
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
  // GET /api/health — PUBLIC. Liveness probe (Hercules plan Step 7,
  // 2026-11-17): returns 200 in milliseconds, does NO heavy work and
  // touches NO database/GitHub. Used to wake the server after Render
  // sleep and to check it is alive.
  if (req.method === 'GET' && urlPath === '/api/health') {
    return sendJSON(res, 200, { ok: true, ts: Date.now() });
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
    return { id: p.id, email: p.email, name: p.name || '', userId: p.userId || '', avatar: p.avatar || '', mode: p.mode, title: p.title, url: p.url, cover: p.cover || '', aspect: p.aspect || '', youtube: p.youtube || '', youtubeChannel: p.youtubeChannel || '', visibility: p.visibility, likes: p.likes || 0, views: p.views || 0, downloads: p.downloads || 0, createdAt: p.createdAt };
  }
  // ---- File uploads for the Admin app Post form (MP3 + cover image) ----
  // ---- Server-side MP3 conversion (WAV -> MP3 128kbps) ----
  // The browser (old phone) takes 118s+ to convert a 3-5 min song with
  // lamejs in JS. The server encodes the same song in a few seconds.
  // GET /api/gen/song/mp3?u=<audio-url>&name=<filename.mp3> — PUBLIC.
  // Fetches the audio; if already MP3 it streams through as-is; if WAV
  // it decodes PCM and encodes to MP3 128kbps. Always returns audio/mpeg
  // with Content-Disposition attachment so the download is a small .mp3.
  let _lamejsMod = null;
  async function getLamejs() {
    if (!_lamejsMod) _lamejsMod = await import('@breezystack/lamejs');
    return _lamejsMod;
  }
  function wavParsePcm(buf) {
    // Minimal WAV/RIFF parser. Returns {channels, sampleRate, left, right}
    // (Int16Array per channel) for PCM 8/16-bit. Throws on bad format.
    if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        fmt = { audioFormat: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bitsPerSample: buf.readUInt16LE(off + 22) };
      } else if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
      off += 8 + size + (size % 2);
    }
    if (!fmt || dataOff < 0) throw new Error('WAV fmt/data chunk missing');
    if (fmt.audioFormat !== 1) throw new Error('WAV not PCM (format ' + fmt.audioFormat + ')');
    const ch = fmt.channels, bps = fmt.bitsPerSample, sr = fmt.sampleRate;
    if (ch < 1 || ch > 2 || (bps !== 8 && bps !== 16)) throw new Error('WAV unsupported: ' + ch + 'ch ' + bps + 'bit');
    const bytesPerSample = bps / 8;
    const frames = Math.floor(dataLen / (bytesPerSample * ch));
    const left = new Int16Array(frames), right = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < ch; c++) {
        const p = dataOff + (i * ch + c) * bytesPerSample;
        let v;
        if (bps === 16) v = buf.readInt16LE(p);
        else v = (buf[p] - 128) * 256;
        if (c === 0) left[i] = v; else right[i] = v;
      }
      if (ch === 1) right[i] = left[i];
    }
    return { channels: ch, sampleRate: sr, left, right };
  }
  async function pcmToMp3(pcm, kbps) {
    const { Mp3Encoder } = await getLamejs();
    const enc = new Mp3Encoder(pcm.channels, pcm.sampleRate, kbps || 128);
    const chunks = [];
    const BLOCK = 1152;
    let n = 0;
    for (let i = 0; i < pcm.left.length; i += BLOCK) {
      const l = pcm.left.subarray(i, i + BLOCK);
      const r = pcm.right.subarray(i, i + BLOCK);
      const out = enc.encodeBuffer(l, r);
      if (out && out.length) chunks.push(Buffer.from(out));
      // Yield to the event loop every 200 blocks so other requests
      // (Admin, stats, ...) are not starved while a long song encodes.
      if ((++n % 200) === 0) await new Promise((r2) => setImmediate(r2));
    }
    const tail = enc.flush();
    if (tail && tail.length) chunks.push(Buffer.from(tail));
    return Buffer.concat(chunks);
  }
  function isMp3Bytes(buf) {
    if (!buf || buf.length < 3) return false;
    if (buf.toString('ascii', 0, 3) === 'ID3') return true;
    return buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
  }
  // ---- MP3 cache (converted once, served instantly afterwards) ----
  const MP3_CACHE_FILE = path.join(DATA_DIR, 'mp3cache.json');
  let _mp3Cache = {};
  try { const _mc = JSON.parse(fs.readFileSync(MP3_CACHE_FILE, 'utf8')); if (_mc && typeof _mc === 'object') _mp3Cache = _mc; } catch (e) {}
  function mp3CacheSave() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(MP3_CACHE_FILE, JSON.stringify(_mp3Cache, null, 2)); ghPersistFile(MP3_CACHE_FILE); } catch (e) {}
  }
  function mp3CacheKey(u) {
    return require('crypto').createHash('sha1').update(String(u)).digest('hex').slice(0, 16);
  }
  function mp3CacheGet(u) {
    const k = mp3CacheKey(u);
    const f = _mp3Cache[k];
    if (!f) return null;
    const fp = path.join(DATA_DIR, 'uploads', f);
    try { if (fs.existsSync(fp) && fs.statSync(fp).size > 1000) return fp; } catch (e) {}
    return null;
  }
  // MP3 pre-warm REMOVED (owner order 2026-11-16 ~22:00): NO background
  // conversion. The MP3 is converted ONLY when the user taps Download on
  // that one song (GET /api/gen/song/mp3) — never at generation, never
  // when a song is shown or played.
  // Convert a source audio URL to MP3 128kbps, cache it in uploads/, and
  // return the cached filename. Returns null on failure. If already cached
  // returns the cached filename immediately (no re-convert).
  // MEMORY FIX (2026-11-16): the Free instance has only 512 MB and the
  // server CRASHED twice (OOM) when several long songs converted at once
  // (each holds ~50 MB WAV + ~50 MB PCM). Conversions now run ONE AT A
  // TIME through a queue, and the WAV buffer is freed before encoding.
  // ---- Cloudinary permanent song storage (owner order 2026-11-17,
  // Hercules FINAL FIX: Magic Hour returns a 40-50 MB WAV; converting it
  // on the 512 MB Render instance peaks at ~420 MB RSS (tested 2026-11-17)
  // and can OOM. Cloudinary fetches the provider URL ITSELF (remote URL
  // upload) and converts WAV->MP3 with a transformation, so Render never
  // loads the 50 MB file.
  // MULTI-ACCOUNT (owner order 2026-11-17 ~08:47): the owner has 10
  // Gmails and adds Cloudinary accounts in the Admin (3 fields: Cloud
  // Name, API Key, API Secret, then Save). The MAIN account (bg08mr3i)
  // lives in the Render env var CLOUDINARY_URL and is FIRST in the
  // rotation; admin accounts follow in the order added.
  // ROUND-ROBIN (owner order 2026-11-17): each NEW upload uses the next
  // enabled account in turn (upload 1 -> account 1, upload 2 -> account
  // 2, ... cycling) — the accounts SHARE the work instead of draining
  // one account until it fails. The last-used account is remembered in
  // cloudinary-rotation.json (GitHub-backed, survives restarts). When
  // one account runs out of credits (or its key is wrong) the server
  // marks it and AUTOMATICALLY moves to the next account that still has
  // credits (failover stays as the safety net). Credits renew monthly,
  // so an account marked exhausted is tried again once a new month
  // starts. If every account fails, song-store and the mp3 endpoint
  // return a clear error — there is NO local fallback (the local
  // converter was permanently removed, owner order 2026-11-17).
  // The env-var account is READ-ONLY in the Admin (it is set in Render);
  // admin accounts live in cloudinary-accounts.json (GitHub-backed, in
  // the private movai-data repo — same as the other admin data). The
  // Admin API NEVER returns a full API secret (masked). ----
  const CLOUDINARY_ACCOUNTS_FILE = path.join(DATA_DIR, 'cloudinary-accounts.json');
  function loadCloudinaryAccounts() {
    try { const j = JSON.parse(fs.readFileSync(CLOUDINARY_ACCOUNTS_FILE, 'utf8')); if (Array.isArray(j)) return j.filter((x) => x && typeof x === 'object'); } catch (e) {}
    return [];
  }
  function saveCloudinaryAccounts(arr) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    fs.writeFileSync(CLOUDINARY_ACCOUNTS_FILE, JSON.stringify(arr, null, 2));
    ghPersistFile(CLOUDINARY_ACCOUNTS_FILE);
  }
  function cloudinaryAccountId() {
    return 'cld-' + require('crypto').randomBytes(6).toString('hex');
  }
  // The MAIN account from the Render env vars (CLOUDINARY_CLOUD_NAME /
  // CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET, or the single
  // CLOUDINARY_URL). Returns an account-shaped object or null.
  function cloudinaryEnvAccount() {
    const cn = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    const ck = (process.env.CLOUDINARY_API_KEY || '').trim();
    const cs = (process.env.CLOUDINARY_API_SECRET || '').trim();
    const curl = (process.env.CLOUDINARY_URL || '').trim();
    if (cn && ck && cs) return { id: 'env', source: 'env', readonly: true, label: 'Main (Render)', cloudName: cn, apiKey: ck, apiSecret: cs, enabled: true, exhausted: false, exhaustedAt: null, lastError: '', lastErrorAt: null };
    if (curl) {
      const m = /^cloudinary:\/\/([^:]+):([^@]+)@([^/]+)/.exec(curl);
      if (m) return { id: 'env', source: 'env', readonly: true, label: 'Main (Render)', cloudName: m[3], apiKey: m[1], apiSecret: m[2], enabled: true, exhausted: false, exhaustedAt: null, lastError: '', lastErrorAt: null };
    }
    return null;
  }
  // Is this account exhausted in the CURRENT month? Credits renew
  // monthly, so an exhaustion from a previous month no longer counts.
  function cloudinaryAccountExhaustedNow(a) {
    if (!a || !a.exhausted || !a.exhaustedAt) return false;
    const d = new Date(String(a.exhaustedAt));
    if (Number.isNaN(d.getTime())) return true;
    const now = new Date();
    return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
  }
  // Ordered rotation candidates: env account first, then enabled admin
  // accounts in the order added. Exhausted-this-month accounts are
  // skipped (they get a fresh chance next month).
  function cloudinaryCandidates() {
    const list = [];
    const env = cloudinaryEnvAccount();
    if (env) list.push(env);
    for (const a of loadCloudinaryAccounts()) {
      if (!a || a.enabled === false) continue;
      if (cloudinaryAccountExhaustedNow(a)) continue;
      list.push(a);
    }
    return list;
  }
  function cloudinaryConfigured() { return cloudinaryCandidates().length > 0; }
  // ROUND-ROBIN pointer (owner order 2026-11-17): each NEW upload uses the
  // next enabled account in turn (upload 1 -> account 1, upload 2 ->
  // account 2, ... cycling), instead of draining one account until it
  // fails. The pointer is an account id (stable across adds/removes) and
  // is persisted to GitHub like the other admin data, so it survives
  // Render restarts. Advanced ONLY on a successful store.
  const CLOUDINARY_ROTATION_FILE = path.join(DATA_DIR, 'cloudinary-rotation.json');
  function loadCloudinaryRotation() {
    try { const j = JSON.parse(fs.readFileSync(CLOUDINARY_ROTATION_FILE, 'utf8'));
      if (j && typeof j === 'object') return j; } catch (e) {}
    return { lastAccountId: null };
  }
  function saveCloudinaryRotation(obj) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    fs.writeFileSync(CLOUDINARY_ROTATION_FILE, JSON.stringify(obj, null, 2));
    ghPersistFile(CLOUDINARY_ROTATION_FILE); // fire-and-forget, same as saveCloudinaryAccounts()
  }
  // The Cloudinary SDK is a global singleton: config() mutates it.
  // Uploads run ONE AT A TIME through _cloudQueue, so setting the
  // config inside the queued block (right before the upload and the
  // URL build) is safe — no two accounts can interleave.
  let _cloudinary = null;
  function cloudinarySdk() {
    if (_cloudinary) return _cloudinary;
    try { _cloudinary = require('cloudinary').v2; return _cloudinary; }
    catch (e) { console.error('[cloudinary] SDK load failed:', String((e && e.message) || e).slice(0, 200)); return null; }
  }
  function cloudinaryConfigFor(a) {
    const c = cloudinarySdk();
    if (!c) return null;
    c.config({ cloud_name: a.cloudName, api_key: a.apiKey, api_secret: a.apiSecret });
    return c;
  }
  // Build the download URL for a stored Cloudinary song. `title` is the
  // song's display name (optional) — when given, it becomes the download
  // filename via fl_attachment:<title> so the saved file is named after
  // the song (e.g. "WHY IS LIFE SO HARD ON ME.mp3") instead of the
  // provider's generic name ("output.mp3"). The title is sanitised to
  // URL-safe characters (spaces kept, Khmer kept as percent-encoded
  // UTF-8, slashes/quotes stripped) so the URL stays valid.
  function cloudinaryMp3UrlFor(a, publicId, title) {
    const c = cloudinaryConfigFor(a);
    if (!c) return null;
    const t = String(title || '').trim().replace(/[\\/:*?"<>|()\[\]{}#&=]/g, '').replace(/\s+/g, ' ').slice(0, 120);
    if (t) {
      // fl_attachment:<name> sets the Content-Disposition filename.
      // Use the SDK's attachment flag with a custom filename: build the
      // URL then append the encoded name to the fl_attachment flag.
      const base = c.url(publicId, { resource_type: 'video', format: 'mp3', audio_codec: 'mp3', bit_rate: '192k', flags: 'attachment' });
      if (!base) return null;
      return base.replace('fl_attachment', 'fl_attachment:' + encodeURIComponent(t));
    }
    return c.url(publicId, { resource_type: 'video', format: 'mp3', audio_codec: 'mp3', bit_rate: '192k', flags: 'attachment' });
  }
  // Rewrite an EXISTING Cloudinary MP3 URL so its download filename is
  // the song title (fl_attachment:<title>). Used for songs stored
  // BEFORE the title fix — their stored URL has fl_attachment without
  // a name (downloads as "output.mp3"). Returns the original URL when
  // it is not a Cloudinary URL or has no title to apply.
  function cloudinaryUrlWithTitle(url, title) {
    const u = String(url || '');
    const t = String(title || '').trim().replace(/[\\/:*?"<>|()\[\]{}#&=]/g, '').replace(/\s+/g, ' ').slice(0, 120);
    if (!t || u.indexOf('res.cloudinary.com/') < 0 || u.indexOf('fl_attachment') < 0) return u;
    return u.replace(/fl_attachment(?::[^/]*)?/, 'fl_attachment:' + encodeURIComponent(t));
  }
  // Mask an API key/secret for the Admin: first 2 + last 2 chars only.
  function cloudinaryMask(v) {
    const s = String(v || '');
    if (s.length <= 6) return '••••';
    return s.slice(0, 2) + '••••' + s.slice(-2);
  }
  // Raw Cloudinary Admin API call (ping / usage) with Basic Auth.
  // Uses fetch directly (not the SDK) so the Admin endpoints never
  // touch the SDK global config that the upload queue relies on.
  async function cloudinaryApiGet(a, apiPath, timeoutMs) {
    const url = 'https://api.cloudinary.com/v1_1/' + encodeURIComponent(a.cloudName) + apiPath;
    const basic = Buffer.from(a.apiKey + ':' + a.apiSecret).toString('base64');
    const r = await fetch(url, { headers: { 'Authorization': 'Basic ' + basic }, signal: AbortSignal.timeout(timeoutMs || 10000) });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (j && j.error && j.error.message) ? String(j.error.message) : ('HTTP ' + r.status);
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return j;
  }
  // Account status for the Admin lights. Returns {status,
  // creditsRemaining, creditsLimit, detail}. status: 'ok' (green),
  // 'low' (yellow, credits almost out), 'exhausted' (red, no credits),
  // 'invalid' (red, wrong key/secret), 'disabled' (grey), 'unknown'
  // (yellow, could not verify). The blue credit dot is shown when
  // creditsRemaining > 0.
  async function cloudinaryAccountStatus(a) {
    if (!a) return { status: 'unknown', creditsRemaining: null, creditsLimit: null, detail: '' };
    if (a.source !== 'env' && a.enabled === false) return { status: 'disabled', creditsRemaining: null, creditsLimit: null, detail: 'Disabled' };
    if (cloudinaryAccountExhaustedNow(a)) return { status: 'exhausted', creditsRemaining: 0, creditsLimit: null, detail: 'Credits used up this month' };
    try {
      const u = await cloudinaryApiGet(a, '/usage', 10000);
      const cr = (u && u.credits) || {};
      const used = Number(cr.usage !== undefined ? cr.usage : cr.used);
      const limit = Number(cr.limit);
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
        const remaining = Math.max(0, limit - used);
        if (remaining <= 0) return { status: 'exhausted', creditsRemaining: 0, creditsLimit: limit, detail: 'Credits used up' };
        if (remaining < 5 || remaining / limit < 0.2) return { status: 'low', creditsRemaining: remaining, creditsLimit: limit, detail: 'Credits almost out' };
        return { status: 'ok', creditsRemaining: remaining, creditsLimit: limit, detail: '' };
      }
      return { status: 'ok', creditsRemaining: null, creditsLimit: null, detail: '' };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if ((e && (e.status === 401 || e.status === 403)) || /api_secret mismatch|invalid api key|unauthorized|authentication/i.test(msg)) {
        return { status: 'invalid', creditsRemaining: null, creditsLimit: null, detail: 'Wrong key or secret' };
      }
      return { status: 'unknown', creditsRemaining: null, creditsLimit: null, detail: msg.slice(0, 120) };
    }
  }
  function cloudinaryPublicAccount(a, st) {
    return {
      id: a.id, source: a.source || 'admin', readonly: !!a.readonly,
      label: a.label || a.cloudName, cloudName: a.cloudName,
      apiKeyMasked: cloudinaryMask(a.apiKey),
      enabled: a.enabled !== false,
      exhausted: !!a.exhausted, exhaustedAt: a.exhaustedAt || null,
      lastError: a.lastError || '', lastErrorAt: a.lastErrorAt || null,
      createdAt: a.createdAt || null,
      status: st ? st.status : 'unknown',
      creditsRemaining: st ? st.creditsRemaining : null,
      creditsLimit: st ? st.creditsLimit : null,
      detail: st ? st.detail : '',
    };
  }
  // One Cloudinary upload at a time (serialised through _cloudQueue).
  let _cloudQueue = Promise.resolve();
  // Classify a Cloudinary upload error so the rotation knows what to do:
  // 'gone' = the SOURCE url expired (404/403/410) — no account can fix it.
  // 'quota' = this account is out of credits / rate-limited — mark it
  // exhausted and move to the next account. 'auth' = wrong key/secret —
  // mark it invalid and move on. 'other' = transient — retry once.
  function cloudinaryClassifyUploadError(msg) {
    const m = String(msg || '');
    if (/api_secret mismatch|invalid api key|unauthorized|invalid signature/i.test(m)) return 'auth';
    if (/quota|credit|exceed.*plan|rate limit|too many requests/i.test(m)) return 'quota';
    if (/404|410|not found|gone|forbidden|403/i.test(m)) return 'gone';
    // Large file: Cloudinary accepts the upload but finishes it in the
    // background ("Resource is too large to process synchronously,
    // processing in background"). The asset WILL exist at the public_id
    // we chose, so this is NOT a failure — the caller waits for it.
    if (/too large.*process.*synchronously|processing in background/i.test(m)) return 'async';
    if (/already exists|public_id.*exist/i.test(m)) return 'exists';
    return 'other';
  }
  // Deterministic public_id for a source URL, so the SAME song URL is
  // always stored under the SAME asset (no duplicate large uploads, and
  // the MP3 URL is known even when Cloudinary finishes the upload in
  // the background). Hash only — never the URL itself (it holds a
  // signed query string).
  function cloudinaryPublicIdForUrl(u) {
    const h = require('crypto').createHash('sha256').update(String(u)).digest('hex').slice(0, 24);
    return 'movai/songs/' + h;
  }
  // ---- Cloudinary large-file wait LEVELS (owner order 2026-11-17 ~12:19) ----
  // A big file cannot finish synchronously — Cloudinary processes it in
  // the background. The server waits for it, with the wait picked
  // AUTOMATICALLY from the file's weight (its size):
  //   L1 light   (<=10 MB) : 10s | L2 medium (<=25 MB): 25s
  //   L3 middle  (<=50 MB) : 50s | L4 heavy   (>50 MB)  : 90s (1.5 min)
  // If the asset still is not ready after the level's wait, the attempt
  // CLOSES (returns null -> clear error) and the user tries again; the
  // next try finds the asset already stored (deterministic public_id).
  // Size unknown (HEAD failed / no Content-Length) -> L2 medium (25s).
  function cloudinaryWaitMsForBytes(bytes) {
    const b = Number(bytes);
    if (!Number.isFinite(b) || b <= 0) return 25000;
    if (b <= 10 * 1024 * 1024) return 10000;
    if (b <= 25 * 1024 * 1024) return 25000;
    if (b <= 50 * 1024 * 1024) return 50000;
    return 90000;
  }
  // HEAD the source URL for its Content-Length (bytes). Short timeout;
  // returns null when unknown (server blocks HEAD, no length header...).
  async function cloudinarySourceBytes(u) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(String(u), { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
      clearTimeout(t);
      const len = r && r.headers && r.headers.get && r.headers.get('content-length');
      const n = len ? parseInt(len, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (e) { return null; }
  }
  // Wait until a Cloudinary video asset exists (background processing
  // done) — poll the Admin API, up to `ms` total. Returns true when the
  // asset is visible, false on timeout.
  async function cloudinaryWaitForAsset(c, publicId, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const r = await c.api.resource(publicId, { resource_type: 'video' });
        if (r && r.public_id) return true;
      } catch (e) { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  }
  // Mark an admin account exhausted/invalid in the data file (the env
  // account is not stored, so it is only logged). Never throws.
  function cloudinaryMarkAccount(a, kind, msg) {
    if (!a || a.source === 'env') { console.error('[cloudinary] env account ' + kind + ':', String(msg || '').slice(0, 160)); return; }
    try {
      const now = new Date().toISOString();
      const arr = loadCloudinaryAccounts();
      const it = arr.find((x) => x && x.id === a.id);
      if (!it) return;
      it.lastError = String(msg || kind).slice(0, 200);
      it.lastErrorAt = now;
      if (kind === 'quota') { it.exhausted = true; it.exhaustedAt = now; }
      it.updatedAt = now;
      saveCloudinaryAccounts(arr);
    } catch (e) {}
  }
  // Clear an admin account's exhausted/invalid marks after a success
  // (so it is tried first again next time). Never throws.
  function cloudinaryClearAccountMarks(a) {
    if (!a || a.source === 'env') return;
    try {
      const arr = loadCloudinaryAccounts();
      const it = arr.find((x) => x && x.id === a.id);
      if (!it) return;
      if (it.exhausted || it.lastError) {
        it.exhausted = false; it.exhaustedAt = null; it.lastError = ''; it.lastErrorAt = null;
        it.updatedAt = new Date().toISOString();
        saveCloudinaryAccounts(arr);
      }
    } catch (e) {}
  }
  // Remote-URL upload with AUTOMATIC ROTATION: tries each candidate
  // account in order (env account first, then admin accounts). A quota
  // or auth failure marks that account and moves to the next one, so a
  // song never dies just because one account ran out. Returns
  // {publicId, mp3Url, accountId, accountLabel}, or the marker 'gone'
  // when Cloudinary could not fetch the source (expired provider URL),
  // or null when every account failed (caller falls back to local).
  async function cloudinaryStoreSong(u, title) {
    const candidates = cloudinaryCandidates();
    if (!candidates.length) return null;
    // Round-robin: start from the account AFTER the one that stored the
    // last upload, so new uploads cycle through all enabled accounts
    // instead of draining the first one. (Inside _cloudQueue below, so
    // the read+advance is atomic — no two uploads can interleave it.)
    const rot = loadCloudinaryRotation();
    let start = 0;
    if (rot.lastAccountId) {
      const li = candidates.findIndex((x) => x.id === rot.lastAccountId);
      if (li >= 0) start = (li + 1) % candidates.length;
    }
    const ordered = candidates.slice(start).concat(candidates.slice(0, start));
    const run = _cloudQueue.then(async () => {
      for (const a of ordered) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const c = cloudinaryConfigFor(a);
            if (!c) continue;
            memLog('cloudinary-upload ' + (a.label || a.cloudName) + ' attempt ' + attempt + ' ' + String(u).slice(0, 60));
            const detId = cloudinaryPublicIdForUrl(u);
            const res = await c.uploader.upload(u, { resource_type: 'video', public_id: detId, overwrite: false });
            const publicId = res && res.public_id;
            if (!publicId) continue;
            const mp3Url = cloudinaryMp3UrlFor(a, publicId, title);
            memLog('cloudinary-upload ok ' + publicId + ' via ' + (a.label || a.cloudName));
            cloudinaryClearAccountMarks(a);
            saveCloudinaryRotation({ lastAccountId: a.id, updatedAt: new Date().toISOString() });
            return { publicId, mp3Url, accountId: a.id, accountLabel: a.label || a.cloudName };
          } catch (e) {
            const msg = String((e && e.message) || e);
            const kind = cloudinaryClassifyUploadError(msg);
            console.error('[cloudinary] upload via ' + (a.label || a.cloudName) + ' attempt ' + attempt + ' failed (' + kind + '):', msg.slice(0, 200));
            if (kind === 'exists') {
              // Asset already stored under our deterministic public_id.
              const mp3Url = cloudinaryMp3UrlFor(a, cloudinaryPublicIdForUrl(u), title);
              if (mp3Url) { cloudinaryClearAccountMarks(a); saveCloudinaryRotation({ lastAccountId: a.id, updatedAt: new Date().toISOString() }); return { publicId: cloudinaryPublicIdForUrl(u), mp3Url, accountId: a.id, accountLabel: a.label || a.cloudName }; }
            }
            if (kind === 'async') {
              // Background processing: wait for the asset, with the wait
              // picked AUTOMATICALLY from the file's weight (L1 10s /
              // L2 25s / L3 50s / L4 90s). Do NOT mark the account
              // (nothing is wrong with it). If the asset still is not
              // ready after the level's wait, CLOSE this attempt (null)
              // so the user tries again — the retry finds the asset
              // already stored under its deterministic public_id.
              const detId = cloudinaryPublicIdForUrl(u);
              const waitMs = cloudinaryWaitMsForBytes(await cloudinarySourceBytes(u));
              memLog('cloudinary-async wait ' + waitMs + 'ms for ' + detId);
              const ready = await cloudinaryWaitForAsset(c, detId, waitMs);
              if (!ready) { memLog('cloudinary-async timeout ' + detId); return null; }
              const mp3Url = cloudinaryMp3UrlFor(a, detId, title);
              if (mp3Url) { cloudinaryClearAccountMarks(a); saveCloudinaryRotation({ lastAccountId: a.id, updatedAt: new Date().toISOString() }); return { publicId: detId, mp3Url, accountId: a.id, accountLabel: a.label || a.cloudName }; }
            }
            if (kind === 'gone') return 'gone';
            if (kind === 'quota') { cloudinaryMarkAccount(a, 'quota', msg); break; }
            if (kind === 'auth') { cloudinaryMarkAccount(a, 'auth', msg); break; }
            if (attempt === 2) { cloudinaryMarkAccount(a, 'other', msg); break; }
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
      }
      return null;
    });
    _cloudQueue = run.catch(() => {});
    return run;
  }
  // ---- LOCAL MP3 CONVERSION PERMANENTLY REMOVED (owner order 2026-11-17 ~11:16): ----
  // The local WAV->MP3 converter (convertAndCacheMp3, ~420 MB RSS) OOM-crashed the
  // 512 MB Render instance, so it is DELETED — not disabled, not dormant. Render
  // does NO file work at all: every MP3 download goes through Cloudinary only.
  // If Cloudinary fails, the mp3 endpoint returns a clear 503 error instead of
  // ever converting locally. Do NOT re-add a local converter here. ----
  if (req.method === 'GET' && urlPath === '/api/gen/song/mp3') {
    // Handler is NOT async — run the async work in an IIFE (same pattern
    // as /api/gen/video/file).
    (async () => {
      // NOTE: `q` is defined later in apiRoute — parse the query here.
      const qp = new URL(req.url, 'http://localhost').searchParams;
      const u = (qp.get('u') || '').trim();
      const name = (qp.get('name') || 'song').replace(/[\\/:*?"<>|]/g, '_').replace(/\.mp3$/i, '') + '.mp3';
      // Content-Disposition filename MUST be ASCII — Node rejects
      // non-Latin1 header chars, so a Khmer title crashed the download
      // with "Invalid character in header content [Content-Disposition]"
      // (user hit this 2026-11-16 ~23:56). ASCII fallback + RFC 5987
      // UTF-8 filename so browsers that support it still save the Khmer name.
      const asciiName = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
      const disp = 'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(name).replace(/'/g, '%27');
      if (!u) return sendJSON(res, 400, { ok: false, error: 'missing u' });
      try {
        // Cached MP3? Serve it instantly (no re-fetch, no re-encode).
        // STREAMING: pipe the file to the response — never load the
        // whole MP3 into memory (Hercules fix 2026-11-17).
        const cachedFp = mp3CacheGet(u);
        if (cachedFp) {
          const st = fs.statSync(cachedFp);
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Disposition': disp, 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
          fs.createReadStream(cachedFp).on('error', () => { try { res.end(); } catch (e) {} }).pipe(res);
          return;
        }
        // CLOUDINARY ONLY — NO SERVER FILE WORK (owner order 2026-11-17
        // ~09:45): Render does light API work only (generation); the
        // heavy file work lives entirely in Cloudinary. Every source
        // URL (MP3 or WAV) goes to Cloudinary (it fetches + stores +
        // converts) and the browser is redirected to the Cloudinary
        // MP3. The server never downloads, converts, or caches audio
        // bytes for a new URL — no disk, no bandwidth, no OOM. If
        // Cloudinary is not configured or its upload fails, return a
        // clear error. (The cache check above still serves legacy MP3s
        // already on disk — plain streaming, no work.)
        // Already a Cloudinary URL? Just rewrite its download filename
        // to the song title (no re-upload, no server file work) and
        // redirect to it. This fixes songs stored BEFORE the title
        // fix — their stored URL has fl_attachment without a name
        // (downloads as "output.mp3").
        if (u.indexOf('res.cloudinary.com/') >= 0 && u.indexOf('fl_attachment') >= 0) {
          res.writeHead(302, { Location: cloudinaryUrlWithTitle(u, name.replace(/\.mp3$/i, '')), 'Access-Control-Allow-Origin': '*' });
          res.end();
          return;
        }
        if (!cloudinaryConfigured()) return sendJSON(res, 503, { ok: false, error: 'MP3 download unavailable — Cloudinary not configured' });
        const cl = await cloudinaryStoreSong(u, name.replace(/\.mp3$/i, ''));
        if (cl === 'gone') return sendJSON(res, 410, { ok: false, error: 'gone', message: 'This song is no longer available' });
        if (cl && cl.mp3Url) {
          res.writeHead(302, { Location: cl.mp3Url, 'Access-Control-Allow-Origin': '*' });
          res.end();
          return;
        }
        return sendJSON(res, 503, { ok: false, error: 'MP3 download failed — Cloudinary could not store this song' });
      } catch (e) {
        console.error('[mp3] serve failed:', String((e && e.message) || e).slice(0, 200));
        try { sendJSON(res, 500, { ok: false, error: 'MP3 convert failed: ' + String((e && e.message) || e).slice(0, 200) }); } catch (e2) {}
      }
    })();
    return;
  }
  // ---- MV lyrics: large-file handling (over 25 MB) ----
  // Groq Whisper rejects files over 25 MB, so a big song is CONVERTED
  // first (PRIMARY path, automatic on Start MV — no extra user step):
  //  - already a Cloudinary URL  -> re-fetch it as a 64k MP3 (URL rewrite)
  //  - any other URL + Cloudinary configured -> store/transcode it with
  //    the EXISTING cloudinaryStoreSong flow (the same function the mp3
  //    endpoint and song-store use for 90 MB+ files): Cloudinary fetches
  //    the big file itself and converts WAV->MP3, so Render never
  //    downloads it. The stored MP3 (192k, or 64k for very long songs)
  //    is then transcribed in one Whisper call.
  // Only as a LAST resort (Cloudinary unavailable / still too large) is
  // the audio split into <=20 MB chunks and transcribed piece by piece,
  // with each chunk's segment times offset by its start time.
  // Everything stays IN-MEMORY (Buffers only) — no file is ever written
  // to disk (the local converter was permanently removed, owner order).
  const MV_LYRICS_CHUNK_BYTES = 20 * 1024 * 1024;
  const MV_LYRICS_FULL_MAX_BYTES = 120 * 1024 * 1024;
  const MV_LYRICS_FULL_FETCH_TIMEOUT_MS = 180000;
  function mvLyricsCloudinaryLowBitrateUrl(audioUrl) {
    // Rewrite a Cloudinary audio URL so Cloudinary serves a 64k MP3 of
    // it (transformation change only — no upload, no new asset).
    // Returns the rewritten URL, or null when the URL is not Cloudinary
    // or is already at <=64k (a retry would fetch the same bytes).
    let u;
    try { u = new URL(String(audioUrl || '')); } catch (e) { return null; }
    if (u.hostname !== 'res.cloudinary.com') return null;
    const up = '/upload/';
    const idx = u.pathname.indexOf(up);
    if (idx < 0) return null;
    const head = u.pathname.slice(0, idx + up.length);
    const rest = u.pathname.slice(idx + up.length);
    const segs = rest.split('/');
    if (!segs.length) return null;
    let trans = '';
    let tail = segs;
    if (!/^v\d+$/.test(segs[0])) { trans = segs[0]; tail = segs.slice(1); }
    if (!tail.length) return null;
    const brM = /(?:^|,)br_(\d+)k(?:,|$)/.exec(trans);
    if (brM && Number(brM[1]) <= 64) return null;
    let parts = trans ? trans.split(',') : [];
    let hasBr = false;
    let hasAc = false;
    parts = parts.map((p) => {
      if (/^br_\d+k$/.test(p)) { hasBr = true; return 'br_64k'; }
      if (/^ac_/.test(p)) { hasAc = true; return 'ac_mp3'; }
      return p;
    });
    if (!hasBr) parts.unshift('br_64k');
    if (!hasAc) parts.unshift('ac_mp3');
    u.pathname = head + parts.join(',') + '/' + tail.join('/');
    return u.toString();
  }
  async function mvLyricsCloudinaryStoreMp3(audioUrl) {
    // Convert a big provider audio URL to a stored Cloudinary MP3 via
    // the EXISTING store flow (cloudinaryStoreSong — the same function
    // the mp3 endpoint and song-store use for 90 MB+ files). Cloudinary
    // fetches the file itself and transcodes WAV->MP3, so Render never
    // downloads the big file. Returns {mp3Url}, 'gone' (source expired),
    // or null (not stored / all accounts failed — caller falls back to
    // chunking).
    let r;
    try {
      r = await cloudinaryStoreSong(audioUrl, '');
    } catch (e) {
      return null;
    }
    if (r === 'gone') return 'gone';
    if (r && r.mp3Url) return { mp3Url: r.mp3Url };
    return null;
  }
  // MP3 frame tables (Layer III only) for frame-aligned splitting.
  const MV_MP3_BITRATES = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    25: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  };
  const MV_MP3_SAMPLERATES = {
    1: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    25: [11025, 12000, 8000],
  };
  function mvLyricsMp3FrameAt(buf, off) {
    // Parse the MP3 Layer-III frame header at off. Returns
    // {len, durationSec, bitrate} or null when it is not a valid frame.
    if (off + 4 > buf.length) return null;
    if (buf[off] !== 0xFF || (buf[off + 1] & 0xE0) !== 0xE0) return null;
    const verBits = (buf[off + 1] >> 3) & 0x03;
    if (verBits === 1) return null;
    const version = verBits === 3 ? 1 : (verBits === 2 ? 2 : 25);
    if (((buf[off + 1] >> 1) & 0x03) !== 1) return null;
    const b2 = buf[off + 2];
    const brIdx = (b2 >> 4) & 0x0F;
    const srIdx = (b2 >> 2) & 0x03;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
    const bitrate = MV_MP3_BITRATES[version][brIdx];
    const sampleRate = MV_MP3_SAMPLERATES[version][srIdx];
    if (!bitrate || !sampleRate) return null;
    const coef = version === 1 ? 144 : 72;
    const len = Math.floor(coef * bitrate * 1000 / sampleRate) + ((b2 >> 1) & 0x01);
    if (len <= 0 || off + len > buf.length) return null;
    return { len, durationSec: (version === 1 ? 1152 : 576) / sampleRate, bitrate };
  }
  function mvLyricsMp3SkipId3(buf) {
    // Offset just past an ID3v2 tag at the start (0 when there is none).
    if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
    const size = ((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) | ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F);
    let off = 10 + size;
    if (buf[5] & 0x10) off += 10;
    return off <= buf.length ? off : 0;
  }
  async function mvLyricsSplitMp3(buf) {
    // Frame-aligned split with EXACT start times (sum of frame
    // durations). Returns {parts} or null when the stream cannot be
    // parsed (caller falls back to the generic split).
    const start0 = mvLyricsMp3SkipId3(buf);
    const parts = [];
    let off = start0;
    let time = 0;
    let curStart = off;
    let curStartTime = 0;
    let curBytes = 0;
    let lastBitrate = 128;
    let frames = 0;
    while (off < buf.length) {
      if (buf.length - off < 1024 && !mvLyricsMp3FrameAt(buf, off)) break;
      let f = mvLyricsMp3FrameAt(buf, off);
      if (!f) {
        // Resync: scan forward for the next frame sync (up to 4 KB).
        let found = -1;
        const scanEnd = Math.min(buf.length - 1, off + 4096);
        for (let s = off + 1; s < scanEnd; s++) {
          if (buf[s] === 0xFF && (buf[s + 1] & 0xE0) === 0xE0 && mvLyricsMp3FrameAt(buf, s)) { found = s; break; }
        }
        if (found < 0) return null;
        time += (found - off) / (lastBitrate * 125);
        off = found;
        f = mvLyricsMp3FrameAt(buf, off);
        if (!f) return null;
      }
      lastBitrate = f.bitrate;
      if (curBytes > 0 && curBytes + f.len > MV_LYRICS_CHUNK_BYTES) {
        parts.push({ buf: buf.subarray(curStart, off), start: curStartTime, exact: true, bytesBefore: curStart });
        curStart = off; curStartTime = time; curBytes = 0;
      }
      off += f.len; time += f.durationSec; curBytes += f.len;
      frames++;
      if (frames % 16384 === 0) await new Promise((r) => setImmediate(r));
    }
    if (curBytes > 0) parts.push({ buf: buf.subarray(curStart, off), start: curStartTime, exact: true, bytesBefore: curStart });
    if (!parts.length) return null;
    return { parts };
  }
  function mvLyricsSplitWav(buf) {
    // Split PCM/float WAV data into <=20 MB pieces, each with a rebuilt
    // 44-byte header so Whisper can decode every chunk on its own.
    // Returns {parts} or null when the header cannot be parsed.
    if (buf.length < 44) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let fmt = null;
    let dataOff = -1;
    let dataLen = -1;
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (size > buf.length) break;
      if (id === 'data') {
        dataOff = off + 8;
        dataLen = Math.min(size, buf.length - dataOff);
        break;
      }
      if (id === 'fmt ') {
        if (size < 16 || off + 8 + 16 > buf.length) return null;
        fmt = {
          audioFormat: buf.readUInt16LE(off + 8),
          channels: buf.readUInt16LE(off + 10),
          sampleRate: buf.readUInt32LE(off + 12),
          byteRate: buf.readUInt32LE(off + 16),
          blockAlign: buf.readUInt16LE(off + 20),
          bitsPerSample: buf.readUInt16LE(off + 22),
        };
      }
      off += 8 + size + (size % 2);
      if (off > buf.length) break;
    }
    if (!fmt || dataOff < 0 || dataLen < 0) return null;
    if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) return null;
    if (!fmt.byteRate || !fmt.blockAlign || !fmt.sampleRate) return null;
    if (dataLen <= 0) return null;
    const parts = [];
    let pos = 0;
    while (pos < dataLen) {
      let take = Math.min(MV_LYRICS_CHUNK_BYTES, dataLen - pos);
      take = Math.floor(take / fmt.blockAlign) * fmt.blockAlign;
      if (take <= 0) break;
      const head = Buffer.alloc(44);
      head.write('RIFF', 0); head.writeUInt32LE(36 + take, 4); head.write('WAVE', 8);
      head.write('fmt ', 12); head.writeUInt32LE(16, 16);
      head.writeUInt16LE(fmt.audioFormat, 20); head.writeUInt16LE(fmt.channels, 22);
      head.writeUInt32LE(fmt.sampleRate, 24); head.writeUInt32LE(fmt.byteRate, 28);
      head.writeUInt16LE(fmt.blockAlign, 32); head.writeUInt16LE(fmt.bitsPerSample, 34);
      head.write('data', 36); head.writeUInt32LE(take, 40);
      parts.push({ buf: Buffer.concat([head, buf.subarray(dataOff + pos, dataOff + pos + take)]), start: pos / fmt.byteRate, exact: true, bytesBefore: dataOff + pos });
      pos += take;
    }
    if (!parts.length) return null;
    return { parts };
  }
  function mvLyricsSplitGeneric(buf) {
    // Last-resort split: plain <=20 MB byte ranges. Offsets are
    // estimated later from the first chunk's Whisper timings.
    const parts = [];
    for (let off = 0; off < buf.length; off += MV_LYRICS_CHUNK_BYTES) {
      parts.push({ buf: buf.subarray(off, Math.min(off + MV_LYRICS_CHUNK_BYTES, buf.length)), start: null, exact: false, bytesBefore: off });
    }
    return { parts };
  }
  async function mvLyricsSplitAudio(buf, fileName, contentType) {
    // Pick the splitter for the audio format (MP3/WAV first, generic
    // fallback). Every part is {buf, start, exact, bytesBefore}; start
    // is the chunk's start time in seconds (null = estimate later).
    const name = String(fileName || '').toLowerCase();
    const ct = String(contentType || '').toLowerCase();
    const isWav = name.endsWith('.wav') || ct.includes('wav') || (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF');
    const isMp3 = name.endsWith('.mp3') || ct.includes('mpeg') || ct.includes('mp3') ||
      (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
      (buf.length >= 2 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0);
    if (isWav) { const r = mvLyricsSplitWav(buf); if (r) return r; }
    if (isMp3) { const r = await mvLyricsSplitMp3(buf); if (r) return r; }
    return mvLyricsSplitGeneric(buf);
  }
  async function mvLyricsTranscribeChunked(buf, fileName, contentType) {
    // Transcribe a large buffer piece by piece (each <=20 MB) and
    // combine the segments with correct start-time offsets. Throws
    // rotErr/noKey from Whisper (caller maps them). Returns
    // {ok:true, language, lyrics}.
    const split = await mvLyricsSplitAudio(buf, fileName, contentType);
    const parts = split.parts || [];
    const perChunk = [];
    let language = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const r = await withProviderKeyRotation('groq', async (k) => mvLyricsWhisper(part.buf, fileName, k));
      if (!language && r.language) language = r.language;
      perChunk.push({ lyrics: r.lyrics || [], exact: part.exact, exactStart: part.start, bytesBefore: part.bytesBefore, bufLen: part.buf.length });
      await new Promise((res2) => setImmediate(res2));
    }
    // Calibrate bytes/sec from the first chunk that returned segments
    // (only needed for non-exact splits, where offsets are estimated).
    let bytesPerSec = 0;
    for (const c of perChunk) {
      if (c.lyrics.length) {
        const lastEnd = c.lyrics[c.lyrics.length - 1].end;
        if (lastEnd > 0 && c.bufLen > 0) { bytesPerSec = c.bufLen / lastEnd; break; }
      }
    }
    if (!bytesPerSec) bytesPerSec = 16000;
    const all = [];
    for (const c of perChunk) {
      const start = c.exact ? c.exactStart : (c.bytesBefore / bytesPerSec);
      for (const s of c.lyrics) {
        all.push({ text: s.text, start: Math.round((start + s.start) * 100) / 100, end: Math.round((start + s.end) * 100) / 100 });
      }
    }
    all.sort((a, b) => a.start - b.start);
    return { ok: true, language, lyrics: all };
  }
  async function mvLyricsWhisperSingle(buf, fileName) {
    // One Whisper call through key rotation. Throws rotErr/noKey.
    return withProviderKeyRotation('groq', async (k) => mvLyricsWhisper(buf, fileName, k));
  }
  async function mvLyricsTranscribeSong(audioUrl) {
    // Full transcription flow for one audio URL. Returns
    // {ok:true, language, lyrics} or {ok:false, error} (Khmer+English).
    // Throws rotErr/noKey from Whisper (caller maps them to the no-key /
    // Whisper-failed messages).
    // 1) Fast path: small file, one Whisper call.
    const fast = await mvLyricsFetchAudio(audioUrl);
    if (fast.ok) {
      return mvLyricsWhisperSingle(fast.buf, mvLyricsFileName(fast.contentType, audioUrl));
    }
    if (!fast.tooLarge) {
      return { ok: false, error: 'ទាញយកបទចម្រៀងមិនបាន · Could not download the song audio' };
    }
    // 2) Large file — PRIMARY: MP3 conversion, automatic, inside this
    // call (tapping Start MV). If the URL is already a Cloudinary URL,
    // ask Cloudinary for a 64k MP3 of it (URL rewrite, no upload).
    // Otherwise store/transcode it with the EXISTING cloudinaryStoreSong
    // flow — Cloudinary fetches the big file itself and converts
    // WAV->MP3, so Render never downloads it.
    const isCld = String(audioUrl).indexOf('res.cloudinary.com/') >= 0;
    if (isCld) {
      const low = mvLyricsCloudinaryLowBitrateUrl(audioUrl);
      if (low) {
        const l = await mvLyricsFetchAudio(low);
        if (l.ok) return mvLyricsWhisperSingle(l.buf, 'song.mp3');
        // Low-bitrate variant unfetchable or still too large — chunking below.
      }
    } else if (cloudinaryConfigured()) {
      const stored = await mvLyricsCloudinaryStoreMp3(audioUrl);
      if (stored === 'gone') {
        return { ok: false, error: 'ទាញយកបទចម្រៀងមិនបាន · Could not download the song audio' };
      }
      if (stored && stored.mp3Url) {
        const m = await mvLyricsFetchAudio(stored.mp3Url);
        if (m.ok) return mvLyricsWhisperSingle(m.buf, 'song.mp3');
        if (m.tooLarge) {
          const low = mvLyricsCloudinaryLowBitrateUrl(stored.mp3Url);
          if (low) {
            const l = await mvLyricsFetchAudio(low);
            if (l.ok) return mvLyricsWhisperSingle(l.buf, 'song.mp3');
          }
        }
        // Stored MP3 unfetchable or still too large — chunking below.
      }
      // stored === null (store failed / not ready) — chunking below.
    }
    // 3) Last resort: split the audio into <=20 MB chunks and transcribe
    // each one (only when Cloudinary conversion could not produce a
    // file under 25 MB, or Cloudinary is not configured).
    const full = await mvLyricsFetchAudio(audioUrl, MV_LYRICS_FULL_MAX_BYTES, MV_LYRICS_FULL_FETCH_TIMEOUT_MS);
    if (!full.ok) {
      if (full.tooLarge) {
        return { ok: false, error: 'ឯកសារបទចម្រៀងធំពេក (លើស 120 MB) មិនអាចបង្កើតអក្សរចម្រៀងបានទេ · The song file is too large (over 120 MB) to create lyrics' };
      }
      return { ok: false, error: 'ទាញយកបទចម្រៀងមិនបាន · Could not download the song audio' };
    }
    if (!full.buf || !full.buf.length) {
      return { ok: false, error: 'ទាញយកបទចម្រៀងមិនបាន · Could not download the song audio' };
    }
    return mvLyricsTranscribeChunked(full.buf, mvLyricsFileName(full.contentType, audioUrl), full.contentType);
  }
  if (req.method === 'POST' && urlPath === '/api/mv/lyrics') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      logActivity({ at: new Date().toISOString(), mode: 'mv-lyrics' });
      const audioUrl = body && typeof body.audioUrl === 'string' ? body.audioUrl.trim() : '';
      const translateTo = body && typeof body.translateTo === 'string' ? body.translateTo.trim().slice(0, 50) : '';
      let u;
      try { u = new URL(audioUrl); } catch (e) { u = null; }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || audioUrl.length > 2000) {
        return sendJSON(res, 200, { ok: false, error: 'សូមដាក់លីងបទចម្រៀងត្រឹមត្រូវ · Please provide a valid song audio URL' });
      }
      // Transcribe (fast path, Cloudinary MP3 conversion, or chunked —
      // see mvLyricsTranscribeSong). Throws only for Whisper/no-key.
      let tr;
      try {
        tr = await mvLyricsTranscribeSong(audioUrl);
      } catch (e) {
        if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Groq API Key ទេ · Admin has not set a Groq API Key yet' });
        return sendJSON(res, 200, { ok: false, error: 'ស្ដាប់បទចម្រៀងមិនបាន (Whisper) · Could not transcribe the song (Whisper)' });
      }
      if (!tr || !tr.ok) {
        return sendJSON(res, 200, { ok: false, error: (tr && tr.error) ? tr.error : 'ទាញយកបទចម្រៀងមិនបាន · Could not download the song audio' });
      }
      if (!tr.lyrics || !tr.lyrics.length) {
        return sendJSON(res, 200, { ok: false, error: 'រកមិនឃើញអត្ថបទចម្រៀងក្នុងបទនេះទេ · No lyrics were found in this song' });
      }
      const language = tr.language || '';
      if (!translateTo) {
        return sendJSON(res, 200, { ok: true, language, lyrics: tr.lyrics });
      }
      // Translate, keeping timings. On translation failure, fall back to
      // the original-language lyrics so the MV still has something to show.
      let translated = null;
      try {
        translated = await withProviderKeyRotation('groq', async (k) => {
          const t = await mvLyricsTranslate(tr.lyrics, translateTo, k);
          if (!t.ok) throw rotErr(t.error || 'translate failed', t.status || 0);
          return t.lines;
        });
      } catch (e) {
        translated = null;
      }
      if (!translated) {
        return sendJSON(res, 200, { ok: true, language, lyrics: tr.lyrics, translationFailed: true });
      }
      const outLyrics = tr.lyrics.map((l, i) => ({ text: (translated[i] !== undefined ? translated[i] : l.text), start: l.start, end: l.end }));
      return sendJSON(res, 200, { ok: true, language, translatedTo: translateTo, lyrics: outLyrics });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }

  // POST /api/public/song-store — PUBLIC. {url}. Stores a song
  // PERMANENTLY right after generation (Hercules checklist point A,
  // owner order 2026-11-17): the AI provider's audio URL is TEMPORARY
  // and expires, so the server stores it PERMANENTLY in Cloudinary
  // (Cloudinary fetches + converts to MP3) and returns the Cloudinary
  // MP3 URL. The website then saves THAT URL (never the provider URL)
  // in History, so Play/Download work forever. NO local file work:
  // the local converter was permanently removed (owner order 2026-11-17).
  if (req.method === 'POST' && urlPath === '/api/public/song-store') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const url = String((body && body.url) || '').trim();
      const title = String((body && (body.title || body.name)) || '').trim();
      const proto = req.headers && req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
      const host = (req.headers && req.headers.host) || 'movai-proxy.onrender.com';
      const ownBase = proto + '://' + host;
      try {
        if (!url) return sendJSON(res, 200, { ok: false, error: 'missing url' });
        // Already one of OUR permanent uploads URLs? Nothing to do.
        if (url.indexOf('/uploads/') >= 0 && (url.indexOf(ownBase + '/uploads/') === 0 || url.indexOf('movai-proxy.onrender.com/uploads/') >= 0)) {
          return sendJSON(res, 200, { ok: true, url });
        }
        // Already a Cloudinary MP3 URL? Rewrite its download filename
        // to the song title (no re-upload) so it saves with the song's
        // name instead of the provider's generic "output.mp3".
        if (url.indexOf('res.cloudinary.com/') >= 0) {
          return sendJSON(res, 200, { ok: true, url: cloudinaryUrlWithTitle(url, title), provider: 'cloudinary' });
        }
        memLog('songstore-start');
        // CLOUDINARY ONLY (owner order 2026-11-17 ~09:32): the local
        // WAV→MP3 conversion is TURNED OFF — it peaks at ~420 MB RSS
        // and OOM-crashes the 512 MB Render instance. A provider audio
        // URL goes to Cloudinary only (it fetches + converts to MP3);
        // if Cloudinary is not configured or its upload fails, return a
        // clear error instead of crashing the server. The website keeps
        // the provider URL in that case (temporary) and retries later.
        if (!cloudinaryConfigured()) return sendJSON(res, 200, { ok: false, error: 'cloudinary not configured', url });
        const cl = await cloudinaryStoreSong(url, title);
        if (cl === 'gone') return sendJSON(res, 200, { ok: false, error: 'gone', url });
        if (cl && cl.mp3Url) {
          memLog('song-store-end');
          return sendJSON(res, 200, { ok: true, url: cl.mp3Url, provider: 'cloudinary', publicId: cl.publicId, account: cl.accountLabel || '', accountId: cl.accountId || '' });
        }
        return sendJSON(res, 200, { ok: false, error: 'cloudinary failed', url });
      } catch (e) {
        console.error('[songstore] failed for', url.slice(0, 120), ':', String((e && e.message) || e).slice(0, 200));
        memLog('songstore-end-failed');
        return sendJSON(res, 200, { ok: false, error: 'store failed', url });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Cloudinary accounts (Admin) — owner order 2026-11-17 ~08:47.
  // The owner adds Cloudinary accounts in the Admin (3 fields: Cloud
  // Name, API Key, API Secret, then Save) and the server rotates
  // automatically when one runs out. The MAIN account (env var) is
  // listed FIRST as read-only; admin accounts follow. Each account
  // carries a status light: ok (green), low (yellow, credits almost
  // out), exhausted (red, no credits), invalid (red, wrong key/secret),
  // disabled (grey), unknown (yellow, could not verify). A blue credit
  // dot is shown when credits remain. Placed AFTER the Cloudinary
  // helpers on purpose (TDZ) — these endpoints use them. ----
  // GET /api/admin/cloudinary-accounts — admin key required. Lists the
  // env account (read-only) + admin accounts, each with its status.
  if (req.method === 'GET' && urlPath === '/api/admin/cloudinary-accounts') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    (async () => {
      try {
        const all = [];
        const env = cloudinaryEnvAccount();
        if (env) all.push(env);
        for (const x of loadCloudinaryAccounts()) all.push(x);
        const list = await Promise.all(all.map(async (x) => {
          const st = await cloudinaryAccountStatus(x);
          return cloudinaryPublicAccount(x, st);
        }));
        return sendJSON(res, 200, { ok: true, accounts: list });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
      }
    })();
    return;
  }
  // POST /api/admin/cloudinary-accounts — {cloudName, apiKey, apiSecret}
  // — admin key required. Verifies the pair with a Cloudinary ping
  // BEFORE saving, so a wrong key/secret is reported immediately.
  if (req.method === 'POST' && urlPath === '/api/admin/cloudinary-accounts') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const cloudName = String((body && body.cloudName) || '').trim();
      const apiKey = String((body && body.apiKey) || '').trim();
      const apiSecret = String((body && body.apiSecret) || '').trim();
      if (!cloudName || !apiKey || !apiSecret) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Cloud Name, API Key និង API Secret ទាំងបី' });
      const arr = loadCloudinaryAccounts();
      const dup = arr.find((x) => x && String(x.cloudName || '').trim().toLowerCase() === cloudName.toLowerCase());
      const cand = { id: dup ? dup.id : cloudinaryAccountId(), source: 'admin', readonly: false, label: cloudName, cloudName, apiKey, apiSecret, enabled: dup ? dup.enabled !== false : true, exhausted: false, exhaustedAt: null, lastError: '', lastErrorAt: null, createdAt: dup ? (dup.createdAt || new Date().toISOString()) : new Date().toISOString(), updatedAt: new Date().toISOString() };
      try {
        await cloudinaryApiGet(cand, '/ping', 15000);
      } catch (e) {
        const msg = String((e && e.message) || e);
        return sendJSON(res, 200, { ok: false, error: 'Cloudinary មិនទទួល key/secret នេះទេ · ' + msg.slice(0, 160) });
      }
      if (dup) { const i = arr.findIndex((x) => x && x.id === dup.id); if (i >= 0) arr[i] = cand; }
      else arr.push(cand);
      saveCloudinaryAccounts(arr);
      await ghFlushFile(CLOUDINARY_ACCOUNTS_FILE);
      const st = await cloudinaryAccountStatus(cand);
      return sendJSON(res, 200, { ok: true, account: cloudinaryPublicAccount(cand, st), updated: !!dup });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹমត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/admin/cloudinary-accounts?id=... — admin key required.
  // Removes an admin account. The env (Main) account cannot be deleted.
  if (req.method === 'DELETE' && urlPath === '/api/admin/cloudinary-accounts') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const id = String(new URL(req.url, 'http://localhost').searchParams.get('id') || '').trim();
    if (!id || id === 'env') return sendJSON(res, 200, { ok: false, error: 'មិនអាចលុបគណនី Main នេះបានទេ' });
    const arr = loadCloudinaryAccounts();
    const i = arr.findIndex((x) => x && x.id === id);
    if (i < 0) return sendJSON(res, 200, { ok: false, error: 'រកគណនីនេះមិនឃើញទេ' });
    arr.splice(i, 1);
    saveCloudinaryAccounts(arr);
    return sendJSON(res, 200, { ok: true, deleted: id });
  }
  // POST /api/admin/cloudinary-accounts/toggle — {id, enabled} — admin
  // key required. Enables or disables an admin account.
  if (req.method === 'POST' && urlPath === '/api/admin/cloudinary-accounts/toggle') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = String((body && body.id) || '').trim();
      const enabled = !!(body && body.enabled);
      if (!id || id === 'env') return sendJSON(res, 200, { ok: false, error: 'មិនអាចបិទគណនី Main នេះបានទេ' });
      const arr = loadCloudinaryAccounts();
      const it = arr.find((x) => x && x.id === id);
      if (!it) return sendJSON(res, 200, { ok: false, error: 'រកគណនីនេះមិនឃើញទេ' });
      it.enabled = enabled;
      it.updatedAt = new Date().toISOString();
      saveCloudinaryAccounts(arr);
      const st = await cloudinaryAccountStatus(it);
      return sendJSON(res, 200, { ok: true, account: cloudinaryPublicAccount(it, st) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/cloudinary-accounts/reset — {id} — admin key
  // required. Clears an account's exhausted/invalid marks so it is
  // tried again (credits renew monthly; use this after topping up or
  // fixing a key).
  if (req.method === 'POST' && urlPath === '/api/admin/cloudinary-accounts/reset') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = String((body && body.id) || '').trim();
      if (!id || id === 'env') return sendJSON(res, 200, { ok: false, error: 'គណនី Main មិនមានស្ថានភាពត្រូវសម្អាតទេ' });
      const arr = loadCloudinaryAccounts();
      const it = arr.find((x) => x && x.id === id);
      if (!it) return sendJSON(res, 200, { ok: false, error: 'រកគណនីនេះមិនឃើញទេ' });
      it.exhausted = false; it.exhaustedAt = null; it.lastError = ''; it.lastErrorAt = null;
      it.updatedAt = new Date().toISOString();
      saveCloudinaryAccounts(arr);
      const st = await cloudinaryAccountStatus(it);
      return sendJSON(res, 200, { ok: true, account: cloudinaryPublicAccount(it, st) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/gen/song/mp3-warm — REMOVED (owner order 2026-11-16 ~22:00):
  // no background pre-conversion; MP3 is made only on Download tap.
  // GET /api/public/provider-status — PUBLIC (no admin key). API key
  // health for the website's red/green indicators: green = working,
  // red = exhausted (out of credits/quota/auth failed), unknown = not
  // used yet. Key values are never exposed — only index + status.
  if (req.method === 'GET' && urlPath === '/api/public/provider-status') {
    return sendJSON(res, 200, { ok: true, providers: keyHealthList() });
  }
  // POST /api/public/upload — ADMIN KEY required. JSON {kind: 'audio'|'image',
  // filename, data: base64}. Saves under ./data/uploads/ and returns the
  // public URL. Audio max 15 MB; image (cover) has NO size cap — any size
  // allowed (user order 2026-11-16). The Admin app reads the
  // chosen file as base64 and POSTs it here, then fills the Post Link/Cover
  // field with the returned URL. The file is ALSO backed up to GitHub
  // (uploads/) before success is returned, so a proxy restart/redeploy
  // can no longer wipe it — it is restored on startup.
  const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
  const UPLOAD_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  function uploadSafeExt(kind, filename) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    const dot = '.' + (ext || '');
    if (kind === 'audio') return ['.mp3', '.wav', '.ogg', '.m4a'].includes(dot) ? dot : '';
    if (kind === 'image') return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(dot) ? dot : '';
    return '';
  }
  // ---- GitHub backup for uploaded files (binary) ----
  // Every upload is ALSO PUT to the movai-data repo under uploads/ and
  // restored to ./data/uploads/ on startup, so a Render restart can no
  // longer wipe a song MP3 or cover. Upload names are unique
  // (timestamp-random), so creates never need a sha.
  function ghUploadsUrl(p) {
    return 'https://api.github.com/repos/' + GH_REPO + '/contents/' + p.split('/').map(encodeURIComponent).join('/');
  }
  async function ghPutUpload(name, b64) {
    if (!ghEnabled()) return true;
    try {
      const r = await fetch(ghUploadsUrl('uploads/' + name), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
        body: JSON.stringify({ message: 'movai-proxy: upload ' + name, content: b64, branch: 'main' }),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) { console.log('[github] PUT uploads/' + name + ' failed: HTTP ' + r.status); return false; }
      return true;
    } catch (e) {
      console.log('[github] PUT uploads/' + name + ' error: ' + (e && e.message ? e.message : e));
      return false;
    }
  }
  async function ghGetUpload(name) {
    if (!ghEnabled()) return null;
    try {
      const r = await fetch(ghUploadsUrl('uploads/' + name) + '?ref=main', { headers: ghHeaders(), signal: AbortSignal.timeout(60000) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (!j) return null;
      if (typeof j.content === 'string' && j.content.length) {
        return Buffer.from(j.content.replace(/\s/g, ''), 'base64');
      }
      // Files larger than 1 MB: the GitHub contents API omits `content`.
      // Fetch the raw bytes via download_url (authenticated — private repo).
      if (typeof j.download_url === 'string' && j.download_url) {
        const r2 = await fetch(j.download_url, { headers: { 'Authorization': 'Bearer ' + GH_TOKEN, 'User-Agent': 'movai-proxy' }, signal: AbortSignal.timeout(120000) });
        if (!r2.ok) return null;
        const ab = await r2.arrayBuffer();
        if (!ab || !ab.byteLength) return null;
        return Buffer.from(ab);
      }
      return null;
    } catch (e) { return null; }
  }
  async function ghListUploads() {
    if (!ghEnabled()) return [];
    try {
      const r = await fetch(ghUploadsUrl('uploads') + '?ref=main', { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
      if (!r.ok) return [];
      const j = await r.json().catch(() => null);
      if (!Array.isArray(j)) return [];
      return j.filter((e) => e && e.type === 'file' && typeof e.name === 'string').map((e) => e.name);
    } catch (e) { return []; }
  }
  async function ghRestoreUploads() {
    if (!ghEnabled()) return;
    try { fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true }); } catch (e) {}
    const names = await ghListUploads();
    await Promise.all(names.map(async (name) => {
      try {
        const ext = '.' + String(name).toLowerCase().split('.').pop();
        if (!UPLOAD_MIME[ext]) return;
        const local = path.join(UPLOADS_DIR, name);
        if (fs.existsSync(local)) return; // already here — keep the local copy
        const buf = await ghGetUpload(name);
        if (!buf || !buf.length) return;
        fs.writeFileSync(local, buf);
        console.log('[github] restored upload ' + name);
      } catch (e) {
        console.log('[github] restore upload ' + name + ' skipped: ' + (e && e.message ? e.message : e));
      }
    }));
  }
  if (req.method === 'POST' && urlPath === '/api/public/upload') {
    const a = adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 30 * 1024 * 1024).then(async (body) => {
      const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
      if (kind !== 'audio' && kind !== 'image') return sendJSON(res, 200, { ok: false, error: 'kind ត្រូវជា audio ឬ image' });
      const ext = uploadSafeExt(kind, body.filename);
      if (!ext) return sendJSON(res, 200, { ok: false, error: 'ប្រភេទឯកសារមិនត្រឹមត្រូវទេ' });
      const b64 = typeof body.data === 'string' ? body.data.replace(/\s/g, '') : '';
      if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return sendJSON(res, 200, { ok: false, error: 'ទិន្នន័យឯកសារមិនត្រឹមត្រូវទេ' });
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return sendJSON(res, 200, { ok: false, error: 'ឯកសារទទេ' });
      if (kind === 'audio' && buf.length > 15 * 1024 * 1024) return sendJSON(res, 200, { ok: false, error: 'MP3 ធំពេក (អតិបរមា 15 MB)' });
      try {
        fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
        const name = Date.now().toString(36) + '-' + crypto.randomInt(100000, 999999) + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
        const proto = req.headers && req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const host = (req.headers && req.headers.host) || 'movai-proxy.onrender.com';
        // Back up to GitHub BEFORE returning success, so the Admin app
        // only proceeds to create the post once the file is durable.
        // A GitHub failure does NOT fail the upload (the local file
        // still works) — it is only logged.
        await ghPutUpload(name, b64);
        return sendJSON(res, 200, { ok: true, url: proto + '://' + host + '/uploads/' + name, name, kind, size: buf.length });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: 'រក្សាទុកឯកសារបរាជ័យ' });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/cover — PUBLIC (no admin key). A logged-in user
  // uploads a cover image for their own song post. JSON {email, filename,
  // data (base64)}. No size limit (cover rule: any size). Saved under
  // ./data/uploads/ with a 'cover-' prefix and backed up to GitHub.
  if (req.method === 'POST' && urlPath === '/api/public/cover') {
    readJSONBody(req, 30 * 1024 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
      const ext = uploadSafeExt('image', body.filename);
      if (!ext) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើសរូបភាព (JPG/PNG/WebP)' });
      const b64 = typeof body.data === 'string' ? body.data.replace(/\s/g, '') : '';
      if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return sendJSON(res, 200, { ok: false, error: 'ទិន្នន័យរូបភាពមិនត្រឹមត្រូវទេ' });
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return sendJSON(res, 200, { ok: false, error: 'រូបភាពទទេ' });
      try {
        fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
        const name = 'cover-' + Date.now().toString(36) + '-' + crypto.randomInt(100000, 999999) + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
        const proto = req.headers && req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const host = (req.headers && req.headers.host) || 'movai-proxy.onrender.com';
        await ghPutUpload(name, b64);
        return sendJSON(res, 200, { ok: true, url: proto + '://' + host + '/uploads/' + name, name, kind: 'image', size: buf.length });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: 'រក្សាទុករូបភាពបរាជ័យ' });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/purchase-receipt — PUBLIC (no admin key). The website
  // uploads a payment-receipt screenshot (image only, max 5 MB) and gets
  // back a public URL, which it then sends with the purchase request as
  // receiptUrl. The Admin app shows the receipt so the Admin can verify
  // the payment is real before approving (stops fake "I have paid").
  // Receipts are saved under ./data/uploads/ with an "rcpt-" prefix and
  // backed up to GitHub like other uploads.
  if (req.method === 'POST' && urlPath === '/api/public/purchase-receipt') {
    readJSONBody(req, 8 * 1024 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const ext = uploadSafeExt('image', body.filename);
      if (!ext) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើសរូបភាព (JPG/PNG/WebP)' });
      const b64 = typeof body.data === 'string' ? body.data.replace(/\s/g, '') : '';
      if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return sendJSON(res, 200, { ok: false, error: 'ទិន្នន័យរូបភាពមិនត្រឹមត្រូវទេ' });
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length || buf.length > 5 * 1024 * 1024) return sendJSON(res, 200, { ok: false, error: 'រូបភាពធំពេក (អតិបរមា 5 MB)' });
      try {
        fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
        const name = 'rcpt-' + Date.now().toString(36) + '-' + crypto.randomInt(100000, 999999) + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
        const proto = req.headers && req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const host = (req.headers && req.headers.host) || 'movai-proxy.onrender.com';
        await ghPutUpload(name, b64);
        return sendJSON(res, 200, { ok: true, url: proto + '://' + host + '/uploads/' + name, name, size: buf.length });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: 'រក្សាទុកវិក្កយបត្របរាជ័យ' });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /uploads/<name> — serve an uploaded MP3/cover. Name is basename-only
  // (no path traversal); unknown extension or missing file -> 404.
  // CORS is sent on every response so the website (another origin) can
  // load the audio with crossOrigin='anonymous' and feed it to a Web
  // Audio Analyser — without this the visualizer gets no data and stays
  // still even while the song plays.
  if (req.method === 'GET' && urlPath.startsWith('/uploads/')) {
    const name = path.basename(urlPath.slice('/uploads/'.length)).split('?')[0];
    const ext = '.' + String(name).toLowerCase().split('.').pop();
    const mime = UPLOAD_MIME[ext];
    if (!mime || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not found'); return; }
    (async () => {
      let buf = null;
      try { buf = fs.readFileSync(path.join(UPLOADS_DIR, name)); } catch (e) { buf = null; }
      if (!buf) {
        // File missing locally (proxy restarted and the startup restore
        // missed it) — fetch it from the GitHub backup on demand and
        // cache it, so the song/cover keeps playing.
        try {
          const gb = await ghGetUpload(name);
          if (gb && gb.length) {
            try { fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true }); fs.writeFileSync(path.join(UPLOADS_DIR, name), gb); } catch (e) {}
            buf = gb;
          }
        } catch (e) { buf = null; }
      }
      if (!buf) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    })().catch(() => { try { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not found'); } catch (e) {} });
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
      const avatar = typeof body.avatar === 'string' ? body.avatar.trim().slice(0, 500) : '';
      const now = new Date().toISOString();
      const posts = loadPublicPosts();
      const p = {
        id: newPublicId(), email,
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '',
        userId: typeof body.userId === 'string' ? body.userId.trim().slice(0, 50) : '',
        mode, title, url,
        cover: typeof body.cover === 'string' ? body.cover.trim().slice(0, 2000) : '',
        aspect, youtube, youtubeChannel, avatar, visibility, likes: 0, views: 0, downloads: 0, likedBy: [], createdAt: now,
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
    readJSONBody(req, 64 * 1024).then(async (body) => {
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
        await ghFlushFile(PUBLIC_FILE);
      }
      return sendJSON(res, 200, { ok: true, likes: p.likes || 0 });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/view — PUBLIC. {postId}. Counts one view.
  if (req.method === 'POST' && urlPath === '/api/public/view') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const postId = typeof body.postId === 'string' ? body.postId.trim() : '';
      if (!postId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId' });
      const posts = loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      p.views = (p.views || 0) + 1;
      savePublicPosts(posts);
      await ghFlushFile(PUBLIC_FILE);
      return sendJSON(res, 200, { ok: true, views: p.views });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/download — PUBLIC. {postId}. Counts one download.
  // Mirrors /api/public/view: increment, save, await the GitHub flush so
  // the count is locked in and never lost on restart.
  if (req.method === 'POST' && urlPath === '/api/public/download') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const postId = typeof body.postId === 'string' ? body.postId.trim() : '';
      if (!postId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId' });
      const posts = loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      p.downloads = (p.downloads || 0) + 1;
      savePublicPosts(posts);
      await ghFlushFile(PUBLIC_FILE);
      return sendJSON(res, 200, { ok: true, downloads: p.downloads });
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

// Plan-expiry sweep: when a bought package reaches its expiry date, notify
// the Admin once per expiry (bell + Telegram via 'plan-expired'), so the
// Admin can follow up. A renewal (new approve) stores a new expiry date,
// so the next expiry notifies again. Runs hourly + once after startup.
function checkPlanExpiries() {
  try {
    const users = loadUsers();
    const now = Date.now();
    let changed = false;
    for (const em of Object.keys(users)) {
      const u = users[em];
      if (!u || typeof u !== 'object') continue;
      const plans = [
        { exp: u.planExpiresAt, notified: u.planExpiryNotifiedAt, field: 'planExpiryNotifiedAt', label: (u.plan || 'package') },
        { exp: u.songPlanExpiresAt, notified: u.songPlanExpiryNotifiedAt, field: 'songPlanExpiryNotifiedAt', label: (u.songPlan || 'song package') },
      ];
      for (const pl of plans) {
        if (!pl.exp) continue;
        const expMs = Date.parse(pl.exp);
        if (!expMs || expMs > now) continue;
        if (pl.notified && pl.notified === pl.exp) continue;
        const uid = u.id || '—';
        addNotification('plan-expired', em, '⏰ កញ្ចប់ផុតកំណត់ · Package expired', (u.name || em) + ' · ' + em + ' · ID: ' + uid + ' — កញ្ចប់ ' + pl.label + ' បានផុតកំណត់ (' + String(pl.exp).slice(0, 10) + ')');
        u[pl.field] = pl.exp;
        u.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) { saveUsers(users); ghFlushFile(USERS_FILE).catch(() => {}); }
  } catch (e) {}
}

if (require.main === module) {
  // Restore persistent data from GitHub first (no-op without a token),
  // so the server starts with the true data, then listen.
  ghRestoreAll().catch(() => {}).finally(() => {
    server.listen(PORT, () => {
      console.log('MovAi Gen live on port ' + PORT);
      // Auto Update Version New: hourly sweep (auto-apply due updates +
      // model check when due) + a first sweep 5 min after startup.
      // Plan-expiry sweep runs on the same schedule: when a bought package
      // reaches its expiry date, notify the Admin once (bell + Telegram).
      setTimeout(() => { autoUpdateSweep(); checkPlanExpiries(); }, 5 * 60 * 1000);
      setInterval(() => { autoUpdateSweep(); checkPlanExpiries(); }, 60 * 60 * 1000);
    });
  });
}
module.exports = { server };
