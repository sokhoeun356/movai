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
// New-user gift (owner order 2026-11-18): SONG credits ONLY — the 250
// media-credit gift is REMOVED. A new registrant who claims the gift
// gets 24 song credits (or 50 when the gift50 toggle is ON and the
// account is brand new). No media credits, no other credits.
const FREE_MEDIA_CREDITS = 0;
const FREE_SONG_CREDITS = 24;
// Gift-50: when the gift50 toggle is ON, a BRAND-NEW account (created
// within this window, never logged in/used before) claims 50 song
// credits instead of 24. Older accounts can never get the 50.
const GIFT50_SONG_CREDITS = 50;
const GIFT50_NEW_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/* ---------------- Supabase-backed persistent storage ----------------- */
// Supabase (PostgreSQL via PostgREST) is now the SINGLE source of truth
// for ALL live data. The old GitHub JSON files are BACKUP ONLY (see
// scheduleBackup below). No npm dependencies: the adapter uses only the
// built-in global fetch.
// Required env vars (already set on Render movai-proxy):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// They are read ONLY from process.env, never hardcoded, never logged.
// If they are unset the server refuses to start (see the main block at
// the bottom) — there is no local-file fallback for live data.
// Table map (see supabase-schema.sql):
//   users                     -> one row per user (email PK, data jsonb)
//   history_items             -> one row per history item (email, item_key)
//   public_posts              -> one row per public post (id PK)
//   wallet_requests           -> one row per wallet request (id PK)
//   notifications             -> one row per notification (id PK)
//   creator_follows           -> one row per follow (follower+creator PK)
//   monetization_applications -> one row per application (email PK)
//   device_records            -> one row per device (device_key PK)
//   kv_docs                   -> one row per remaining document file
// Uploads (./data/uploads/ binary MP3/covers + ghPutUpload /
// ghRestoreUploads) are SEPARATE and untouched by this migration.
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
function sbEnabled() { return !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY; }
function sbHeaders() {
  return {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
}
function sbUrl(table, query) {
  return SUPABASE_URL + '/rest/v1/' + table + (query ? '?' + query : '');
}
// One fetch with a timeout. Returns {ok, status, json}, or null on any
// failure (network, timeout, bad JSON). NEVER throws; logs one line.
async function sbFetch(table, query, opts) {
  if (!sbEnabled()) return null;
  try {
    const r = await fetch(sbUrl(table, query), Object.assign({ signal: AbortSignal.timeout(15000) }, opts || {}));
    const text = await r.text().catch(() => '');
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
    if (!r.ok) { console.log('[supabase] ' + (opts && opts.method ? opts.method : 'GET') + ' ' + table + ' failed: HTTP ' + r.status); return { ok: false, status: r.status, json: j }; }
    return { ok: true, status: r.status, json: j };
  } catch (e) {
    console.log('[supabase] ' + table + ' error: ' + (e && e.message ? e.message : e));
    return null;
  }
}
// SELECT rows. Returns an array, or null on failure. Never throws.
async function sbSelect(table, query) {
  const r = await sbFetch(table, query, { headers: sbHeaders() });
  if (!r || !r.ok || !Array.isArray(r.json)) return null;
  return r.json;
}
// SELECT the first row, or null. Never throws.
async function sbSelectOne(table, query) {
  const rows = await sbSelect(table, query);
  if (!rows || !rows.length) return null;
  return rows[0];
}
// Upsert rows (insert or update on conflict). Returns true/false.
// Never throws.
async function sbUpsert(table, rows, onConflict) {
  if (!rows || !rows.length) return true;
  const q = onConflict ? 'on_conflict=' + encodeURIComponent(onConflict) : '';
  const r = await sbFetch(table, q, {
    method: 'POST',
    headers: Object.assign({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }, sbHeaders()),
    body: JSON.stringify(rows),
  });
  return !!(r && r.ok);
}
// DELETE rows matching a PostgREST query (e.g. 'email=eq.x@y.z').
// Returns true/false. Never throws.
async function sbDelete(table, query) {
  const r = await sbFetch(table, query, { method: 'DELETE', headers: sbHeaders() });
  return !!(r && r.ok);
}
// Upsert every row in `rows`, then delete stored rows whose key is no
// longer present (single-key tables only). The delete step runs ONLY
// when the verification SELECT succeeds — a failed SELECT deletes
// nothing, so a transient outage can never wipe a table. Never throws.
async function sbSyncTable(table, keyCol, rows, onConflict) {
  try {
    if (rows.length) {
      const ok = await sbUpsert(table, rows, onConflict);
      if (!ok) return false;
    }
    const existing = await sbSelect(table, 'select=' + keyCol);
    if (!existing) return true;
    const keep = new Set(rows.map((r) => String(r[keyCol])));
    const gone = existing.map((r) => r[keyCol]).filter((k) => k !== undefined && k !== null && !keep.has(String(k)));
    for (const k of gone) await sbDelete(table, keyCol + '=eq.' + encodeURIComponent(String(k)));
    return true;
  } catch (e) { return false; }
}
// ---- kv_docs helpers (one row per remaining document file) ----
// loadKvDoc returns the stored document, or a fresh copy of `dflt`
// when the row is missing/unreadable (mirrors the old load* defaults).
// saveKvDoc upserts the single row and schedules a GitHub backup.
function kvClone(v) {
  if (v === null || typeof v !== 'object') return v;
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}
async function loadKvDoc(name, dflt) {
  try {
    const row = await sbSelectOne('kv_docs', 'select=data&name=eq.' + encodeURIComponent(name) + '&limit=1');
    if (row && row.data !== undefined && row.data !== null) return row.data;
  } catch (e) {}
  return kvClone(dflt);
}
async function saveKvDoc(name, data, backupName) {
  try {
    await sbUpsert('kv_docs', [{ name, data, updated_at: new Date().toISOString() }], 'name');
  } catch (e) {}
  if (backupName) scheduleBackup(backupName);
}

/* ---------------- GitHub BACKUP ONLY (write-only) ----------------- */
// GitHub is no longer read for data (no restore, no merge — Supabase
// is the single source of truth). The movai-data repo keeps a backup
// copy of each JSON document: scheduleBackup(name) marks a file dirty
// and a timer flushes dirty files at most once per 60 seconds; a full
// snapshot of all 32 files runs at most once per 30 minutes. Backup
// writes NEVER block a response and NEVER throw. Worst-case PUT rate:
// one 32-file snapshot every 30 min = 64 PUTs/hour, far under GitHub's
// 5,000/hour limit. If MOVAI_GITHUB_TOKEN is unset, backup is a no-op.
// ghGetSha below is a SHA-only lookup (no file content) used solely
// because GitHub's contents PUT requires the current blob sha.
const GH_REPO = process.env.MOVAI_DATA_REPO || 'sokhoeun356/movai-data';
const GH_TOKEN = process.env.MOVAI_GITHUB_TOKEN || '';
const GH_DATA_FILES = [
  'users.json', 'grants.json', 'settings.json', 'admin-keys.json',
  'activity.json', 'followers.json', 'notifications.json', 'vapid.json',
  'push-subs.json', 'packages.json', 'purchase-requests.json',
  'public.json', 'package-events.json', 'blocked-models.json',
  'model-logins.json', 'blocked-ips.json', 'blocked-emails.json',
  'updates.json', 'admin-lockouts.json', 'history.json', 'mp3cache.json',
  'cloudinary-accounts.json', 'cloudinary-rotation.json', 'admin-key.json', 'mvsep-cache.json',
  'feature-usage.json', 'wallet-requests.json', 'device-records.json',
  'monetization-earnings.json', 'monetization-applications.json', 'creator-follows.json',
  'deleted-items.json',
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
// SHA-only lookup for the backup writer (see header above). Returns the
// blob sha string or ''. Never file content; never used for data reads.
async function ghGetSha(name) {
  try {
    const r = await fetch(ghContentsUrl(name) + '?ref=main', { headers: ghHeaders(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return '';
    const j = await r.json().catch(() => null);
    return (j && typeof j.sha === 'string') ? j.sha : '';
  } catch (e) { return ''; }
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
      const curSha = await ghGetSha(name);
      if (curSha) sha = curSha;
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
      const curSha = await ghGetSha(name);
      if (curSha) r = await send(curSha);
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
// Serialize one document from Supabase exactly as the old JSON file
// looked (same shape/key order as the old files, so a backup can be
// read back by the old code). Returns the JSON text or null to skip.
// Never throws.
async function backupDocText(name) {
  try {
    switch (name) {
      case 'users.json': {
        const rows = await sbSelect('users', 'select=email,data');
        if (!rows) return null;
        const o = {};
        for (const r of rows) if (r && r.email) o[r.email] = r.data || {};
        return JSON.stringify(o, null, 2);
      }
      case 'history.json': {
        const rows = await sbSelect('history_items', 'select=email,data');
        if (!rows) return null;
        const o = {};
        for (const r of rows) {
          if (!r || !r.email) continue;
          (o[r.email] = o[r.email] || []).push(r.data);
        }
        for (const k of Object.keys(o)) o[k].sort((a, b) => numOr(b.ts, 0) - numOr(a.ts, 0));
        return JSON.stringify(o, null, 2);
      }
      case 'public.json': {
        const rows = await sbSelect('public_posts', 'select=data');
        if (!rows) return null;
        const arr = rows.map((r) => r.data).filter(Boolean);
        arr.sort((a, b) => String(b.createdAt || b.at || '').localeCompare(String(a.createdAt || a.at || '')));
        return JSON.stringify(arr, null, 2);
      }
      case 'wallet-requests.json': {
        const rows = await sbSelect('wallet_requests', 'select=data');
        if (!rows) return null;
        const arr = rows.map((r) => r.data).filter(Boolean);
        arr.sort((a, b) => String(b.at || b.createdAt || '').localeCompare(String(a.at || a.createdAt || '')));
        return JSON.stringify(arr, null, 2);
      }
      case 'notifications.json': {
        const rows = await sbSelect('notifications', 'select=data');
        if (!rows) return null;
        const arr = rows.map((r) => r.data).filter(Boolean);
        arr.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
        return JSON.stringify(arr, null, 2);
      }
      case 'creator-follows.json': {
        const rows = await sbSelect('creator_follows', 'select=follower_email,creator_email');
        if (!rows) return null;
        const o = {};
        for (const r of rows) {
          if (!r || !r.creator_email || !r.follower_email) continue;
          (o[r.creator_email] = o[r.creator_email] || []).push(r.follower_email);
        }
        return JSON.stringify(o, null, 2);
      }
      case 'monetization-applications.json': {
        const rows = await sbSelect('monetization_applications', 'select=email,data');
        if (!rows) return null;
        const o = {};
        for (const r of rows) if (r && r.email) o[r.email] = r.data || {};
        return JSON.stringify(o, null, 2);
      }
      case 'device-records.json': {
        const rows = await sbSelect('device_records', 'select=device_key,data');
        if (!rows) return null;
        const o = {};
        for (const r of rows) if (r && r.device_key) o[r.device_key] = r.data || {};
        return JSON.stringify(o, null, 2);
      }
      default: {
        // Every remaining document lives in kv_docs under its base name.
        const kvName = name.replace(/\.json$/, '');
        const doc = await loadKvDoc(kvName, null);
        if (doc === null || doc === undefined) return null;
        return JSON.stringify(doc, null, 2);
      }
    }
  } catch (e) { return null; }
}
// Debounced background backup (see header above). Marks `name` dirty;
// a timer flushes dirty files at most once per 60 seconds. Never
// blocks a response, never throws. No-op when GitHub is not configured.
const BACKUP_FLUSH_MS = 60 * 1000; // dirty files flush at most once/min
const BACKUP_SNAPSHOT_MS = 30 * 60 * 1000; // full snapshot at most once/30 min
const _backupDirty = new Set();
let _backupTimer = null;
let _backupRunning = false;
let _backupLastSnapshot = 0;
function scheduleBackup(name) {
  if (!ghEnabled()) return;
  if (!GH_DATA_FILES.includes(name)) return;
  _backupDirty.add(name);
  if (!_backupTimer) {
    _backupTimer = setTimeout(() => { _backupTimer = null; flushBackups().catch(() => {}); }, BACKUP_FLUSH_MS);
    if (_backupTimer && typeof _backupTimer.unref === 'function') { try { _backupTimer.unref(); } catch (e) {} }
  }
}
async function flushBackups() {
  if (_backupRunning) return;
  _backupRunning = true;
  try {
    const names = Array.from(_backupDirty);
    _backupDirty.clear();
    for (const name of names) {
      try {
        const text = await backupDocText(name);
        if (typeof text !== 'string') continue;
        await ghPutFile(name, text);
      } catch (e) {}
    }
  } finally { _backupRunning = false; }
}
// Full snapshot: mark every tracked file dirty and flush now.
// Returns {backedUp, skipped}. Never throws.
async function runBackupSnapshot() {
  if (!ghEnabled()) return { backedUp: 0, skipped: true };
  for (const n of GH_DATA_FILES) _backupDirty.add(n);
  _backupLastSnapshot = Date.now();
  await flushBackups();
  return { backedUp: GH_DATA_FILES.length, skipped: false };
}
const _backupInterval = setInterval(() => {
  try { if (Date.now() - _backupLastSnapshot >= BACKUP_SNAPSHOT_MS) runBackupSnapshot().catch(() => {}); } catch (e) {}
}, BACKUP_SNAPSHOT_MS);
if (_backupInterval && typeof _backupInterval.unref === 'function') { try { _backupInterval.unref(); } catch (e) {} }


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
async function loadAdminLockouts() {
  const j = await loadKvDoc('admin-lockouts', {});
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
}
async function saveAdminLockouts(obj) {
  await saveKvDoc('admin-lockouts', obj, 'admin-lockouts.json');
}
async function adminLockoutRemainingMs(ip) {
  try {
    if (!ip) return 0;
    const rec = (await loadAdminLockouts())[ip];
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
async function clearAdminLockout(ip) {
  try {
    if (!ip) return;
    const all = await loadAdminLockouts();
    if (all[ip]) { delete all[ip]; await saveAdminLockouts(all); scheduleBackup('admin-lockouts.json'); }
  } catch (e) {}
}
async function recordFailedAdminAttempt(req, ip) {
  try {
    if (!ip) return 0;
    const now = Date.now();
    const all = await loadAdminLockouts();
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
      await saveAdminLockouts(all);
      scheduleBackup('admin-lockouts.json');
      await addNotification('security', '', '🚫 វាយប្រហារ · Auto-blocked attack', 'IP ' + ip + (rec.model ? ' (' + rec.model + ')' : '') + ' ព្យាយាមចូល Admin ដោយ key ខុស (កម្រិតទី ' + level + ') — ត្រូវបានប្លុក ' + cfg.mins + ' នាទី');
      return cfg.mins;
    }
    rec.updatedAt = new Date().toISOString();
    all[ip] = rec;
    await saveAdminLockouts(all);
    scheduleBackup('admin-lockouts.json');
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
async function loadAdminKeyFile() {
  const j = await loadKvDoc('admin-key', null);
    if (j && typeof j.key === 'string' && j.key) return j.key;
    return '';
}
async function saveAdminKeyFile(key) {
  await saveKvDoc('admin-key', { key, updatedAt: new Date().toISOString() }, 'admin-key.json');
}
async function currentAdminKey() {
  let k = await loadAdminKeyFile();
  if (!k) {
    const env = process.env.MOVAI_ADMIN_KEY || '';
    if (env) { k = env; try { await saveAdminKeyFile(env); } catch (e) {} }
  }
  return k;
}
async function adminKeyOk(req) {
  const k = await currentAdminKey();
  if (!k) return { ok: false, error: 'Admin key not configured on server' };
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (m && m[1] === k) {
    // Correct key proves the admin — clear any lockout/strikes from
    // this IP (a typo storm is forgiven once the right key arrives).
    try { await clearAdminLockout(getClientIp(req)); } catch (e) {}
    return { ok: true };
  }
  // Wrong or missing key. When the Admin Lockout protection is switched
  // OFF (owner order 2026-11-22), a wrong key is simply rejected — no IP
  // block is checked and no failed attempt is recorded. The correct key
  // is still required for every admin call.
  if (!(await lockoutEnabled())) return { ok: false, error: 'Admin key មិនត្រឹមត្រូវទេ · Wrong admin key' };
  // Wrong or missing key. A manually-blocked IP stays blocked.
  const ip = getClientIp(req);
  if (ip && (await loadBlockedIps()).some((b) => b === ip)) {
    return { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' };
  }
  const remMs = await adminLockoutRemainingMs(ip);
  if (remMs > 0) {
    return { ok: false, error: 'គណនីនេះត្រូវបានប្លុក ' + lockoutTextKm(remMs) + 'ទៀត · This account is blocked for ' + lockoutTextEn(remMs) + ' more' };
  }
  const blockedMins = await recordFailedAdminAttempt(req, ip);
  if (blockedMins > 0) {
    const ms = blockedMins * 60 * 1000;
    return { ok: false, error: 'Admin key មិនត្រឹមត្រូវទេ — ត្រូវបានប្លុក ' + lockoutTextKm(ms) + ' · Wrong admin key — blocked for ' + lockoutTextEn(ms) };
  }
  // Wrong key but not blocked yet: say how many tries are left at this level.
  try {
    const rec = (await loadAdminLockouts())[ip];
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
async function loadUsers() {
  const rows = await sbSelect('users', 'select=email,data');
    if (!rows) return {};
    const out = {};
    for (const r of rows) {
      if (r && typeof r.email === 'string' && r.email) out[r.email] = (r.data && typeof r.data === 'object') ? r.data : {};
    }
    return out;
}
async function saveUsers(u) {
  const doc = (u && typeof u === 'object' && !Array.isArray(u)) ? u : {};
    const rows = Object.keys(doc).map((email) => ({ email, data: doc[email] || {}, updated_at: new Date().toISOString() }));
    await sbSyncTable('users', 'email', rows, 'email');
    scheduleBackup('users.json');
}
// History: each user's created things (songs/images/videos), keyed by
// lowercased email: {"<email>": [items...]}. The website's localStorage
// is only a cache; the server is the truth, so ONE Gmail shows ALL old
// data on ANY device. Base64 thumbnails are NEVER stored here.
async function loadHistory() {
  const rows = await sbSelect('history_items', 'select=email,data');
    if (!rows) return {};
    const out = {};
    for (const r of rows) {
      if (!r || typeof r.email !== 'string' || !r.email) continue;
      if (!Array.isArray(out[r.email])) out[r.email] = [];
      out[r.email].push(r.data);
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => numOr(b.ts, 0) - numOr(a.ts, 0));
    return out;
}
async function saveHistory(h) {
  const doc = (h && typeof h === 'object' && !Array.isArray(h)) ? h : {};
    const rows = [];
    for (const email of Object.keys(doc)) {
      const items = Array.isArray(doc[email]) ? doc[email] : [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        // histKey() rule (supabase-schema.sql note 3): items with NEITHER
        // id NOR src/url have an empty key and cannot be stored in this
        // table — skip them, exactly as the sync handler already does.
        const k = histKey(it);
        if (!k) continue;
        rows.push({ email, item_key: k, data: it });
      }
    }
    // Composite key (email, item_key): upsert all rows, then delete stored
    // rows no longer present — only when the verification SELECT succeeds.
    try {
      if (rows.length) {
        const ok = await sbUpsert('history_items', rows, 'email,item_key');
        if (!ok) { scheduleBackup('history.json'); return; }
      }
      const existing = await sbSelect('history_items', 'select=email,item_key');
      if (existing) {
        const keep = new Set(rows.map((r) => r.email + '\0' + r.item_key));
        for (const r of existing) {
          if (!r || typeof r.email !== 'string') continue;
          if (!keep.has(r.email + '\0' + r.item_key)) await sbDelete('history_items', 'email=eq.' + encodeURIComponent(r.email) + '&item_key=eq.' + encodeURIComponent(String(r.item_key)));
        }
      }
    } catch (e) {}
    scheduleBackup('history.json');
}
// History merge key: item id first, else its src/url. Items with neither
// cannot be matched across devices and are skipped on sync.
function histKey(it) {
  if (typeof it.id === 'string' && it.id.trim()) return 'id:' + it.id.trim();
  const u = (typeof it.src === 'string' && it.src.trim()) ? it.src.trim() : (typeof it.url === 'string' ? it.url.trim() : '');
  return u ? 'url:' + u : '';
}
// ---- Deleted-item tombstones (2026-11-18, resurrection bug) ----
// A History item / public post deleted on GitHub must NEVER come back:
// the phone still has it locally and its next history-sync (union by id)
// would re-add it. Tombstones are permanent (never expire) and
// GitHub-backed (deleted-items.json is in GH_DATA_FILES, so it is
// restored on startup and persisted on every write). The merge
// tombstones anything it drops as a GitHub deletion; the sync and post
// handlers refuse anything whose key/id is tombstoned.
const DELETED_ITEMS_FILE = path.join(DATA_DIR, 'deleted-items.json');
async function loadDeletedItems() {
  const j = await loadKvDoc('deleted-items', null);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      return {
        history: (j.history && typeof j.history === 'object' && !Array.isArray(j.history)) ? j.history : {},
        posts: (j.posts && typeof j.posts === 'object' && !Array.isArray(j.posts)) ? j.posts : {},
      };
    }
    return { history: {}, posts: {} };
}
async function saveDeletedItems(t) {
  await saveKvDoc('deleted-items', t, 'deleted-items.json');
}
// Tombstone one public post id immediately (load, add, save). Idempotent.
async function tombstonePostIdNow(id) {
  if (typeof id !== 'string' || !id.trim()) return false;
  const t = await loadDeletedItems();
  if (t.posts[id]) return false;
  t.posts[id] = new Date().toISOString();
  await saveDeletedItems(t);
  return true;
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
async function loadBlockedModels() {
  const j = await loadKvDoc('blocked-models', []);
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [];
}
async function saveBlockedModels(arr) {
  await saveKvDoc('blocked-models', arr, 'blocked-models.json');
}
// Blocked IPs (./data/blocked-ips.json) + blocked Gmails
// (./data/blocked-emails.json) — MANUAL blocks by the admin only. The
// admin reviews the Security section and decides; a new or changed IP is
// NEVER auto-blocked — it only raises a 'new device' notification. The
// ONLY auto-block is the attack rule in recordFailedAdminAttempt (5 failed
// admin-key attempts in 10 minutes). Both files are GitHub-backed like
// the other data files.
const BLOCKED_IPS_FILE = path.join(DATA_DIR, 'blocked-ips.json');
async function loadBlockedIps() {
  const j = await loadKvDoc('blocked-ips', []);
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [];
}
async function saveBlockedIps(arr) {
  await saveKvDoc('blocked-ips', arr, 'blocked-ips.json');
}
const BLOCKED_EMAILS_FILE = path.join(DATA_DIR, 'blocked-emails.json');
async function loadBlockedEmails() {
  const j = await loadKvDoc('blocked-emails', []);
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [];
}
async function saveBlockedEmails(arr) {
  await saveKvDoc('blocked-emails', arr, 'blocked-emails.json');
}
// Login count per device model (./data/model-logins.json) — a map
// model code -> number of syncs (logins) from that model. Incremented on
// every /api/admin/sync that carries a model. GitHub-backed.
const MODEL_LOGINS_FILE = path.join(DATA_DIR, 'model-logins.json');
async function loadModelLogins() {
  const j = await loadKvDoc('model-logins', {});
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
}
async function saveModelLogins(m) {
  await saveKvDoc('model-logins', m, 'model-logins.json');
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
async function lookupIpCountryAsync(email, ip) {
  if (!email || !ip) return;
  (async () => {
    try {
      const r = await fetch('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', { signal: AbortSignal.timeout(3000) });
      const j = r.ok ? await r.json().catch(() => null) : null;
      const country = j && typeof j.country_name === 'string' ? j.country_name.trim().slice(0, 100) : '';
      const countryCode = j && typeof j.country_code === 'string' ? j.country_code.trim().toUpperCase().slice(0, 8) : '';
      if (!country && !countryCode) return;
      const users = await loadUsers();
      const u = users[email];
      if (!u) return;
      // VPN flag (country change for the DEVICE): if this device was
      // previously seen in a DIFFERENT country, the IP's country
      // changed — likely VPN (or travel). The fingerprint still
      // identifies the device; the flag is informational only.
      try {
        const did = u.lastDeviceId || u.deviceId || '';
        if (did && country) {
          const dall = await loadDeviceRecords();
          const dk = 'id:' + did;
          const dr = dall[dk];
          if (dr && typeof dr === 'object') {
            if (dr.country && dr.country !== country) { dr.vpnDetected = true; dr.vpnLastSeen = new Date().toISOString(); }
            if (dr.country !== country) { dr.country = country; await saveDeviceRecords(dall); }
          }
        }
      } catch (e) {}
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
      await saveUsers(users);
    } catch (e) {}
  })().catch(() => {});
}
async function pubUser(u, modelLogins, deviceInfo) {
  const map = modelLogins || await loadModelLogins();
  const model = u.model || '';
  const count = model && map && typeof map === 'object' ? (Number(map[model]) || 0) : 0;
  const out = { id: u.id || '', email: u.email, name: u.name || '', firstName: u.firstName || '', lastName: u.lastName || '', address: u.address || '', credits: u.credits, songCredits: u.songCredits, balance: Math.round(numOr(u.balance, 0) * 100) / 100, earnBalance: Math.round(numOr(u.earnBalance, 0) * 100) / 100, plan: u.plan || '', planExpiresAt: u.planExpiresAt || '', songPlan: u.songPlan || '', songPlanExpiresAt: u.songPlanExpiresAt || '', freeDlUsed: featureFreeUsed(u, 'freeDlUsed'), freeMvUsed: featureFreeUsed(u, 'freeMvUsed'), freeVsUsed: featureFreeUsed(u, 'freeVsUsed'), freePostUsed: featureFreeUsed(u, 'freePostUsed'), freePostUsedByType: freePostUsedByType(u), mvLeft: featurePkgLeft(u, 'mvLeft'), vsLeft: featurePkgLeft(u, 'vsLeft'), mvUnlimited: !!u.mvUnlimited, vsUnlimited: !!u.vsUnlimited, bonusDl: featureBonus(u, 'bonusDl'), bonusMv: featureBonus(u, 'bonusMv'), bonusVs: featureBonus(u, 'bonusVs'), bonusPostByType: bonusPostByType(u), createdAt: u.createdAt, updatedAt: u.updatedAt, lastIp: u.lastIp || '', country: u.country || '', countryCode: u.countryCode || '', device: u.device || '', model, modelLogins: count, lastSeen: u.lastSeen || '', knownDevices: Array.isArray(u.knownDevices) ? u.knownDevices : [], hasPassword: !!(u.passwordHash && u.passwordSalt),
    // Device fingerprint (anti-abuse): the device the account was
    // registered on (deviceId, never overwritten by later sign-ins from
    // other devices), the most recent device seen, and the model the
    // account was registered on. A model change alone never blocks.
    deviceId: u.deviceId || '', lastDeviceId: u.lastDeviceId || '', registeredModel: u.registeredModel || '', hasMyVoice: !!(u.myVoice && u.myVoice.voiceId) };
  // Device-limit picture (Admin reads only — passed by the admin
  // endpoints): accounts on this device, purchased slots, limit,
  // strikes, VPN flags, block state.
  if (deviceInfo && typeof deviceInfo === 'object') {
    out.deviceFingerprint = deviceInfo.fingerprint || '';
    out.deviceAccounts = deviceInfo.accounts;
    out.deviceSlots = deviceInfo.slots;
    out.deviceLimit = deviceInfo.limit;
    out.deviceStrikes = deviceInfo.strikes;
    out.deviceVpnDetected = !!deviceInfo.vpnDetected;
    out.deviceVpnSuspected = !!deviceInfo.vpnSuspected;
    out.deviceVpnLastSeen = deviceInfo.vpnLastSeen || '';
    out.deviceBlocked = !!deviceInfo.deviceBlocked;
    out.deviceBlockedReason = deviceInfo.blockedReason || '';
    out.emailBlocked = !!deviceInfo.emailBlocked;
  }
  return out;
}
// ---- "Free 2 + package allowance" limits (Download MP3, MV, Vocal Studio, Post to Public) ----
// Counters live on the user record (users.data jsonb): freeDlUsed,
// freeMvUsed, freeVsUsed (0–2 each), mvLeft, vsLeft. Post to Public
// uses a PER-TYPE object (see freePostUsedByType below) — the old
// shared freePostUsed (0–2) is KEPT in the data but no longer used
// for the gate/limits. Existing users default to 0 via numOr() —
// no migration, no schema change, no new table.
const FEATURE_FREE_LIMIT = 2;
const FEATURE_MV_VS_GRANT = {
  'song-trial': { mv: 5, vs: 10 },
  'song-popular': { mv: 10, vs: 20 },
  'song-30': { mv: 30, vs: 50 },
  'song-50': { mv: 0, vs: 0, unlimited: true },
  'song-pro': { mv: 22, vs: 33 },
};
function featureFreeUsed(u, field) { return Math.min(FEATURE_FREE_LIMIT, Math.max(0, Math.floor(numOr(u && u[field], 0)))); }
function featurePkgLeft(u, field) { return Math.max(0, Math.floor(numOr(u && u[field], 0))); }
// ---- Post to Public Free 2 — PER TYPE (owner order 2026-11-18 15:12) ----
// The Free 2 for posting is SEPARATE per media type: Songs get 2,
// Images get 2, Videos get 2, 3D gets 2. A song post never consumes
// an image/video/3d free post. Any active package makes ALL types
// unlimited. The old shared `freePostUsed` is KEPT in the data but
// no longer used for the gate/limits — the per-type object below is
// the truth from now on.
// Migration (on read, self-healing): if a user has no per-type
// object but has a legacy `freePostUsed` > 0, each type starts at
// that same value (capped at 2) — they used N total, so they keep
// N free left of EACH type, never more than 2 per type.
const POST_TYPES = ['song', 'image', 'video', '3d'];
function postTypeOf(mode, type) {
  const m = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (POST_TYPES.indexOf(m) >= 0) return m;
  const t = typeof type === 'string' ? type.trim().toLowerCase() : '';
  if (POST_TYPES.indexOf(t) >= 0) return t;
  return 'song';
}
function freePostUsedByType(u) {
  let o = u && u.freePostUsedByType;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    const legacy = featureFreeUsed(u, 'freePostUsed');
    o = { song: legacy, image: legacy, video: legacy, '3d': legacy };
  }
  const out = {};
  for (const t of POST_TYPES) out[t] = Math.min(FEATURE_FREE_LIMIT, Math.max(0, Math.floor(numOr(o[t], 0))));
  return out;
}
// ---- Discount packs (owner order 2026-11-18 23:57): buy 4 uses of ONE
// feature (Post $0.99 / Download $1.29 / MV $1.99 / Vocal Studio $0.29).
// Bonus counters live on the user record (users.data jsonb): bonusDl,
// bonusMv, bonusVs (numbers) and bonusPostByType {song,image,video,'3d'}.
// Unlike mvLeft/vsLeft, bonus NEVER expires with a package — it is a
// purchased allowance, spendable any time until used up. Existing users
// default to 0 via numOr() — no migration, no schema change.
const DISCOUNT_PACK = {
  post: { price: 0.99, uses: 4 },
  download: { price: 1.29, uses: 4 },
  mv: { price: 1.99, uses: 4 },
  vs: { price: 0.29, uses: 4 },
};
const DISCOUNT_FEATURES = ['post', 'download', 'mv', 'vs'];
function featureBonus(u, field) { return Math.max(0, Math.floor(numOr(u && u[field], 0))); }
function bonusPostByType(u) {
  let o = u && u.bonusPostByType;
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = { song: 0, image: 0, video: 0, '3d': 0 };
  const out = {};
  for (const t of POST_TYPES) out[t] = Math.max(0, Math.floor(numOr(o[t], 0)));
  return out;
}
function grantDiscountBonus(u, feature, postType) {
  // Adds 4 uses of ONE feature to the bonus counters. Returns the new bonus left.
  if (feature === 'post') {
    const t = postTypeOf('', postType);
    const b = bonusPostByType(u);
    b[t] = b[t] + DISCOUNT_PACK.post.uses;
    u.bonusPostByType = b;
    return b[t];
  }
  if (feature === 'download') { u.bonusDl = featureBonus(u, 'bonusDl') + DISCOUNT_PACK.download.uses; return u.bonusDl; }
  if (feature === 'mv') { u.bonusMv = featureBonus(u, 'bonusMv') + DISCOUNT_PACK.mv.uses; return u.bonusMv; }
  if (feature === 'vs') { u.bonusVs = featureBonus(u, 'bonusVs') + DISCOUNT_PACK.vs.uses; return u.bonusVs; }
  return 0;
}
// Active package = either plan expiry (media: monthly/yearly) or
// song-plan expiry (song-trial/popular/pro) is still in the future.
// Both expiries are set when a package is activated (purchase approve /
// wallet buy) and are never cleared on expiry — only the date decides,
// exactly as the plan-expiry sweep (checkPlanExpiries) reads them.
function hasActivePackage(u) {
  if (!u) return false;
  const now = Date.now();
  const p = Date.parse(u.planExpiresAt || '');
  if (p && p > now) return true;
  const s = Date.parse(u.songPlanExpiresAt || '');
  if (s && s > now) return true;
  return false;
}
// Weekly public-post limits (owner order 2026-11-21, v2.2.60):
// $5 song-trial = 10/week, $10 song-popular = 20/week,
// $30 song-30 = 30/week, $50 song-50 = unlimited,
// grandfathered $22 song-pro = unlimited. A media-only active plan
// (monthly/yearly) keeps the old behaviour: unlimited.
// Returns Infinity = unlimited, a number = posts/week, null = no
// active package (Free 2 per-type rules apply).
const POST_WEEK_LIMIT = { 'song-trial': 10, 'song-popular': 20, 'song-30': 30, 'song-50': Infinity, 'song-pro': Infinity };
function postWeekLimitFor(u) {
  try {
    if (!u) return null;
    const now = Date.now();
    const sExp = Date.parse(u.songPlanExpiresAt || '');
    if (sExp && sExp > now) {
      const sp = typeof u.songPlan === 'string' ? u.songPlan : '';
      if (Object.prototype.hasOwnProperty.call(POST_WEEK_LIMIT, sp)) return POST_WEEK_LIMIT[sp];
      return Infinity; // unknown song plan id — fail open like before
    }
    const pExp = Date.parse(u.planExpiresAt || '');
    if (pExp && pExp > now) return Infinity; // media-only active plan
    return null;
  } catch (e) { return null; }
}
// Phnom Penh calendar week, Monday 00:00 Asia/Phnom_Penh, as YYYY-MM-DD.
// Counters live on the user record (u.postWeekStart / u.postWeekCount)
// and reset when the week changes — no migration, no schema change.
function postWeekStartMonday(nowMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(nowMs || Date.now()))) parts[p.type] = p.value;
  const dt = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const back = (dt.getUTCDay() + 6) % 7; // days since Monday (Mon=0 .. Sun=6)
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}
function featureLimitsFor(u) {
  const dlUsed = featureFreeUsed(u, 'freeDlUsed');
  const mvUsed = featureFreeUsed(u, 'freeMvUsed');
  const vsUsed = featureFreeUsed(u, 'freeVsUsed');
  // Post to Public Free 2 — PER TYPE (owner order 2026-11-18 15:12):
  // each media type has its OWN 2 lifetime free posts. byType is the
  // truth; the top-level used/freeLeft are the MOST RESTRICTIVE type
  // (max used / min freeLeft) — a summary for old clients only.
  const postByType = freePostUsedByType(u);
  const postTypes = {};
  let postUsedMax = 0, postFreeMin = FEATURE_FREE_LIMIT;
  const postBonus = bonusPostByType(u);
  for (const t of POST_TYPES) {
    const used = postByType[t];
    const freeLeft = Math.max(0, FEATURE_FREE_LIMIT - used);
    postTypes[t] = { used, freeLeft, bonusLeft: postBonus[t] };
    if (used > postUsedMax) postUsedMax = used;
    if (freeLeft < postFreeMin) postFreeMin = freeLeft;
  }
  // Package allowances are usable ONLY while a package is active.
  // When the package expires, any remaining mvLeft/vsLeft is LOST
  // (effective 0 here) — only the lifetime Free 2 survive expiry.
  const active = hasActivePackage(u);
  const mvPkg = active ? featurePkgLeft(u, 'mvLeft') : 0;
  const vsPkg = active ? featurePkgLeft(u, 'vsLeft') : 0;
  // v2.2.60: $50 (song-50) has UNLIMITED MV/VS — carried as flags,
  // never as a number (JSON has no Infinity). The numeric `left`
  // stays a real number for every tier.
  const mvUnlim = active && !!u.mvUnlimited;
  const vsUnlim = active && !!u.vsUnlimited;
  // v2.2.60: weekly post limit for the active song package.
  const postWeekLim = postWeekLimitFor(u);
  const postWeekUsed = (postWeekLim == null) ? 0 : ((u && u.postWeekStart === postWeekStartMonday()) ? Math.max(0, Math.floor(numOr(u.postWeekCount, 0))) : 0);
  const postWeekLeft = (typeof postWeekLim === 'number') ? Math.max(0, postWeekLim - postWeekUsed) : null;
  const mvFreeLeft = Math.max(0, FEATURE_FREE_LIMIT - mvUsed);
  const vsFreeLeft = Math.max(0, FEATURE_FREE_LIMIT - vsUsed);
  const dlBonus = featureBonus(u, 'bonusDl');
  const mvBonus = featureBonus(u, 'bonusMv');
  const vsBonus = featureBonus(u, 'bonusVs');
  return {
    download: { free: FEATURE_FREE_LIMIT, used: dlUsed, freeLeft: Math.max(0, FEATURE_FREE_LIMIT - dlUsed), unlimited: active, bonusLeft: dlBonus },
    mv: { free: FEATURE_FREE_LIMIT, used: mvUsed, freeLeft: mvFreeLeft, pkgLeft: mvPkg, bonusLeft: mvBonus, left: mvFreeLeft + mvPkg + mvBonus, unlimited: mvUnlim },
    vs: { free: FEATURE_FREE_LIMIT, used: vsUsed, freeLeft: vsFreeLeft, pkgLeft: vsPkg, bonusLeft: vsBonus, left: vsFreeLeft + vsPkg + vsBonus, unlimited: vsUnlim },
    // Post to Public (owner order 2026-11-18, per-type 2026-11-18 15:12;
    // tiered weekly limits 2026-11-21, v2.2.60):
    // Free 2 LIFETIME per media type (song/image/video/3d each get 2),
    // same as Download. An active package no longer means unlimited
    // for every tier: $5 = 10 posts/week, $10 = 20/week, $30 = 30/week,
    // $50 / grandfathered $22 Pro / media-only plan = unlimited.
    // When the package expires, posting locks per type unless a free
    // post of that type remains; the per-type counters are lifetime
    // and never reset on re-buy.
    post: { free: FEATURE_FREE_LIMIT, used: postUsedMax, freeLeft: postFreeMin, byType: postTypes, unlimited: postWeekLim === Infinity, weekLimit: (typeof postWeekLim === 'number') ? postWeekLim : null, weekLeft: postWeekLeft, weekUsed: postWeekUsed },
  };
}
// Grant MV/VS allowances for a song-package purchase. Media packages
// (monthly/yearly) grant nothing. Returns the grant {mv, vs} or null.
// hadActive = whether the user had an ACTIVE package BEFORE this
// purchase activates the new plan. If the previous package had
// EXPIRED, its leftover mvLeft/vsLeft is LOST: reset to 0 first, so
// the new grant does NOT stack on expired leftovers. If the previous
// package is still ACTIVE, the new grant accumulates on top.
function grantFeatureAllowance(u, packageId, hadActive) {
  const g = FEATURE_MV_VS_GRANT[packageId];
  if (!g || !u) return null;
  if (!hadActive) { u.mvLeft = 0; u.vsLeft = 0; }
  if (g.unlimited) {
    // v2.2.60: $50 (song-50) — MV/VS unlimited. Flags only; no
    // numeric left is added and Infinity is never stored.
    u.mvUnlimited = true;
    u.vsUnlimited = true;
  } else {
    // A limited grant replaces any unlimited flags (new plan wins).
    u.mvUnlimited = false;
    u.vsUnlimited = false;
    u.mvLeft = featurePkgLeft(u, 'mvLeft') + g.mv;
    u.vsLeft = featurePkgLeft(u, 'vsLeft') + g.vs;
  }
  return g;
}
async function loadGrants() {
  const j = await loadKvDoc('grants', []);
  return Array.isArray(j) ? j : [];
}
async function logGrant(entry) {
  try {
    let arr = await loadGrants();
    arr.push(entry);
    if (arr.length > 1000) arr = arr.slice(-1000);
    await saveKvDoc('grants', arr, 'grants.json');
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
async function notifyOutOfCredit(email, kind, balance, cost) {
  try {
    const em = normEmail(email);
    if (!em) return;
    const now = Date.now();
    const last = outOfCreditNotifiedAt.get(em) || 0;
    if (now - last < 24 * 60 * 60 * 1000) return;
    outOfCreditNotifiedAt.set(em, now);
    const users = await loadUsers();
    const u = users[em];
    const uid = u && u.id ? u.id : '—';
    await addNotification('out-of-credit', em, '⚠️ Credit អស់ · Out of credit', (u && u.name ? u.name : em) + ' · ' + em + ' · ID: ' + uid + ' — ' + (kind === 'media' ? 'Image.Video' : 'Song') + ' Credit មិនគ្រប់ (នៅសល់ ' + Math.floor(numOr(balance, 0)) + ' / ត្រូវការ ' + Math.floor(numOr(cost, 0)) + ')');
  } catch (e) {}
}
async function deductForGeneration(email, mediaCost, songCost, reason) {
  const em = normEmail(email);
  if (!em) return { ok: true, guest: true };
  const users = await loadUsers();
  const u = users[em];
  if (!u) return { ok: true, guest: true };
  const mCost = Math.floor(numOr(mediaCost, 0));
  const sCost = Math.floor(numOr(songCost, 0));
  const mBal = Math.floor(numOr(u.credits, 0));
  const sBal = Math.floor(numOr(u.songCredits, 0));
  if (mCost > 0 && mBal < mCost) { await notifyOutOfCredit(em, 'media', mBal, mCost); return { ok: false, error: 'Image.Video Credit មិនគ្រប់ទេ', needBuy: true, kind: 'media', balance: mBal, cost: mCost }; }
  if (sCost > 0 && sBal < sCost) { await notifyOutOfCredit(em, 'song', sBal, sCost); return { ok: false, error: 'Song Credit មិនគ្រប់ទេ', needBuy: true, kind: 'song', balance: sBal, cost: sCost }; }
  if (mCost > 0 || sCost > 0) {
    if (mCost > 0) u.credits = Math.max(0, mBal - mCost);
    if (sCost > 0) u.songCredits = Math.max(0, sBal - sCost);
    u.updatedAt = new Date().toISOString();
    await saveUsers(users);
    scheduleBackup('users.json');
    await logGrant({ email: em, credits: -mCost, songCredits: -sCost, note: reason || 'generation', at: u.updatedAt });
    // Admin bell: every generation deduction is visible to the Admin
    // immediately (account + amount), and to the user in their own bell.
    // The website also raises a local bell notice instantly; this is the
    // durable server-side one the Admin app reads.
    try {
      const _parts = [];
      if (mCost > 0) _parts.push('-' + mCost + ' Image.Video');
      if (sCost > 0) _parts.push('-' + sCost + ' Song');
      await addNotification('deduct', em, '➖ កាត់ Credit · ' + (u.name || em), _parts.join(' · ') + ' — ' + (reason || 'generation') + ' · នៅសល់ ' + Math.floor(numOr(u.credits, 0)) + ' Image.Video / ' + Math.floor(numOr(u.songCredits, 0)) + ' Song · ' + em + ' · ID: ' + (u.id || '—'));
    } catch (e) {}
  }
  return { ok: true, credits: Math.floor(numOr(u.credits, 0)), songCredits: Math.floor(numOr(u.songCredits, 0)) };
}
// Refund a generation charge (provider failed AFTER we deducted).
// Adds the credits back and logs a 'refund' grant entry.
// Wallet $ deduction -> Admin bell + Telegram (owner order
// 2026-11-21 ~14:44 — EVERY deduction must notify the Admin with
// amount + pool + date; generation-credit deductions already notify
// inside deductForGeneration, instant-reset + withdrawal already
// notify at their sites; these wallet sites sent NOTHING).
async function notifyWalletDeduct(email, amount, poolLabel, reason, balanceAfter) {
  try {
    const amt = walletMoney(amount);
    const dt = new Date().toISOString().slice(0, 10);
    const em = normEmail(email) || email || '';
    await addNotification('deduct', em, '➖ កាត់ $' + amt.toFixed(2) + ' · ' + reason, em + ' បានកាត់ $' + amt.toFixed(2) + ' ពី ' + poolLabel + ' សម្រាប់ ' + reason + ' · ' + dt + (typeof balanceAfter === 'number' ? ' (នៅសល់ $' + walletMoney(balanceAfter).toFixed(2) + ')' : ''), { telegramHtml: '➖ <b>Wallet deduction $' + amt.toFixed(2) + '</b>\n' + em + '\nPool: ' + poolLabel + ' · ' + reason + '\nDate: ' + dt + (typeof balanceAfter === 'number' ? '\nBalance left: $' + walletMoney(balanceAfter).toFixed(2) : '') });
  } catch (e) {}
}
async function refundForGeneration(email, mediaCost, songCost, reason) {
  const em = normEmail(email);
  if (!em) return { ok: true };
  const users = await loadUsers();
  const u = users[em];
  if (!u) return { ok: true };
  const mCost = Math.floor(numOr(mediaCost, 0));
  const sCost = Math.floor(numOr(songCost, 0));
  if (mCost > 0) u.credits = Math.floor(numOr(u.credits, 0)) + mCost;
  if (sCost > 0) u.songCredits = Math.floor(numOr(u.songCredits, 0)) + sCost;
  u.updatedAt = new Date().toISOString();
  await saveUsers(users);
  scheduleBackup('users.json');
  await logGrant({ email: em, credits: mCost, songCredits: sCost, note: 'refund: ' + (reason || 'generation failed'), at: u.updatedAt });
  return { ok: true, credits: Math.floor(numOr(u.credits, 0)), songCredits: Math.floor(numOr(u.songCredits, 0)) };
}

// ---- Pending Cover jobs (v2.2.42) ----
// Suno accepts a cover and returns a jobId, but the phone may never
// receive it (client timeout / Render drops the tiny response). The job
// then runs on Suno while the app shows "Something went wrong" and the
// credits stay deducted, because the callback only stores in memory and
// the client never polls. Every accepted cover job is stored here (kv
// 'cover-pending', Supabase-backed) so the phone can resume polling it
// instead of paying for a new one, and a job Suno reports as failed is
// refunded exactly once.
async function coverPendingLoad() {
  const a = await loadKvDoc('cover-pending', []);
  return Array.isArray(a) ? a : [];
}
async function coverPendingSave(a) {
  await saveKvDoc('cover-pending', a.slice(-100), 'cover-pending.json');
}
async function coverPendingAdd(job) {
  try {
    const a = await coverPendingLoad();
    const now = Date.now();
    // v2.2.48: keep cover jobs 72h (was 24h) so a late failure can still
    // be found and auto-refunded by the server sweep.
    const kept = a.filter((x) => x && now - (x.at || 0) < 72 * 3600 * 1000);
    kept.push(job);
    await coverPendingSave(kept);
  } catch (e) {}
}
async function coverPendingLatest(email, uploadUrl, maxAgeMs) {
  try {
    const a = await coverPendingLoad();
    const now = Date.now();
    const list = a.filter((x) => x && x.email === email && (!uploadUrl || x.uploadUrl === uploadUrl) && now - (x.at || 0) < (maxAgeMs || 72 * 3600 * 1000) && !x.refunded);
    if (!list.length) return null;
    return list[list.length - 1];
  } catch (e) { return null; }
}
async function coverPendingRemove(jobId) {
  try {
    const a = await coverPendingLoad();
    await coverPendingSave(a.filter((x) => x && x.jobId !== jobId));
  } catch (e) {}
}
// Refund a tracked cover job ONCE. Returns true if a refund was issued.
async function coverPendingRefund(jobId) {
  try {
    const a = await coverPendingLoad();
    const it = a.find((x) => x && x.jobId === jobId && !x.refunded);
    if (!it) return false;
    // v2.2.48: refund ONLY a job the user PAID for. A check job that was
    // never used at Generate cost nothing (no deduction happened), and
    // a vocal-retry job is a free re-submit of an already-paid attempt —
    // refunding either would mint free credits. Legacy entries (no paid
    // flag): paid = a fresh cover, or a check job consumed at Generate.
    if (!(it.paid === true || (!it.vocalRetryOf && (!it.checked || it.used)))) return false;
    const rf = await refundForGeneration(it.email, 0, 12, 'song:cover failed');
    if (!(rf && rf.ok)) return false;
    it.refunded = true;
    await coverPendingSave(a);
    // v2.2.69: cross-mark the timeout-endpoint refund key so a later
    // /api/gen/song/timeout call for this job sees 'already refunded'
    // and can never refund the same 12 credits twice.
    try { await saveKvDoc('suno-refund:' + jobId, { email: it.email, jobId: jobId, at: Date.now(), refunded: true }, 'suno-refund.json'); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
// Find one pending cover job by jobId (for the reuse check below).
async function coverPendingById(jobId, email) {
  try {
    const a = await coverPendingLoad();
    return a.find((x) => x && x.jobId === jobId && (!email || x.email === email) && !x.refunded) || null;
  } catch (e) { return null; }
}
// Mark a check job as consumed (paid for at Generate) so a second
// Generate can never reuse it for free.
async function coverPendingMarkUsed(jobId) {
  try {
    const a = await coverPendingLoad();
    const it = a.find((x) => x && x.jobId === jobId);
    if (!it) return false;
    it.used = true;
    it.paid = true;
    await coverPendingSave(a);
    return true;
  } catch (e) { return false; }
}
// Count a vocal retry on a cover job (v2.2.46). A cover that comes back
// instrumental-only (Whisper finds no vocals) is re-submitted at max
// audioWeight with NO extra MovAi charge — the same cover attempt.
// Capped at 3 retries per original job. Returns {ok:true, retries} or
// {ok:false, limit:true} once the cap is hit, {ok:false} if not found.
async function coverPendingVocalRetry(jobId) {
  try {
    const a = await coverPendingLoad();
    const it = a.find((x) => x && x.jobId === jobId);
    if (!it) return { ok: false };
    const n = (it.vocalRetries || 0) + 1;
    if (n > 3) return { ok: false, limit: true };
    it.vocalRetries = n;
    await coverPendingSave(a);
    return { ok: true, retries: n };
  } catch (e) { return { ok: false }; }
}
// v2.2.48: SERVER-SIDE auto-refund sweep (owner 15:05 — "credits are
// deducted and NEVER come back"). The only refund triggers used to be
// the PHONE calling cover-failed or polling /api/gen/song/status —
// if the phone never reported a failure (app closed, poll missed it),
// the 12 credits stayed deducted. The sweep lets the SERVER verify
// failed cover jobs itself: throttled to once per 5 minutes, it takes
// the oldest unrefunded PAID cover jobs older than 15 minutes, asks
// Suno record-info for each, and refunds 12 song credits for every job
// Suno says failed. It never refunds a running, successful, or unpaid
// (check / vocal-retry) job. Fire-and-forget from cover-check / cover /
// cover-pending / cover-failed.
let coverSweepLastAt = 0;
async function coverPendingSunoStatus(jobId) {
  try {
    const keys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
    if (!keys.length) return null;
    return await withProviderKeyRotation('suno', async (k, endpoint) => {
      const ep = endpoint.replace(/\/+$/, '');
      const r = await fetch(ep + '/api/v1/generate/record-info?taskId=' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
      const j = await r.json().catch(() => null);
      const d = (j && j.data) || null;
      return (d && typeof d.status === 'string') ? d.status : null;
    }, '', keys);
  } catch (e) { return null; }
}
async function coverPendingSweep() {
  try {
    const now = Date.now();
    if (now - coverSweepLastAt < 5 * 60 * 1000) return { ok: false, reason: 'throttled' };
    coverSweepLastAt = now;
    const a = await coverPendingLoad();
    const due = a.filter((x) => x && !x.refunded && (x.paid === true || (!x.vocalRetryOf && (!x.checked || x.used))) && now - (x.at || 0) > 15 * 60 * 1000)
      .sort((p, q) => (p.at || 0) - (q.at || 0)).slice(0, 5);
    let refunded = 0;
    for (const job of due) {
      const st = await coverPendingSunoStatus(job.jobId);
      if (st && sunoStatusIsFailed(st)) {
        if (await coverPendingRefund(job.jobId)) refunded++;
      }
    }
    return { ok: true, checked: due.length, refunded };
  } catch (e) { return { ok: false }; }
}

// Activity log (./data/activity.json) — one record per generation attempt
// (create calls only: /api/gen/image, /api/gen/video, /api/gen/song) and
// per /api/admin/sync call (user sign-in/app open), so the Admin app can
// show daily/weekly/monthly users and per-day generations + failures.
// Never logs API keys. Capped at 5000 records (oldest dropped).
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const ACTIVITY_MAX = 5000;
async function loadActivity() {
  const j = await loadKvDoc('activity', []);
    return Array.isArray(j) ? j : [];
}
async function saveActivity(arr) {
  await saveKvDoc('activity', arr, 'activity.json');
}
async function logActivity(rec) {
  try {
    const arr = await loadActivity();
    arr.push(rec);
    if (arr.length > ACTIVITY_MAX) arr.splice(0, arr.length - ACTIVITY_MAX);
    await saveActivity(arr);
  } catch (e) {}
}
// Wrap res.end so exactly one activity record is written when a generation
// endpoint sends its response. ctx = {provider, email} — the handler fills
// it in after parsing the body; the wrapper reads it at response time.
// mode = 'image' | 'video' | 'song'.
async function wrapGenLog(res, mode, ctx) {
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
async function loadFollowers() {
  const j = await loadKvDoc('followers', []);
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [];
}
async function saveFollowers(arr) {
  await saveKvDoc('followers', arr, 'followers.json');
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
// 'post-removed' (a PUBLIC post auto-removed because its audio was
// broken — addressed to the post owner; also shown on the Admin bell
// and sent to Telegram, and pushed to the owner's phone).
// 'security' (new-device login or blocked-model login attempt — admin
// notification + Telegram alert for the admin).
// Stored newest first, capped at 5000 (oldest dropped).
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const NOTIFICATIONS_MAX = 5000;
async function loadNotifications() {
  const rows = await sbSelect('notifications', 'select=id,data');
    if (!rows) return [];
    const arr = rows.map((r) => r.data).filter(Boolean);
    arr.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return arr;
}
async function saveNotifications(arr) {
  const list = Array.isArray(arr) ? arr : [];
    for (const n of list) { if (n && !n.id) n.id = newNotificationId(); }
    const rows = list.filter((n) => n && typeof n.id === 'string' && n.id).map((n) => ({ id: n.id, data: n }));
    await sbSyncTable('notifications', 'id', rows, 'id');
    scheduleBackup('notifications.json');
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
const PKG_DISPLAY_NAME = { monthly: 'Monthly', yearly: 'Yearly', 'song-trial': 'Song Trial', 'song-popular': 'Song Popular', 'song-30': 'Song Pro 30', 'song-50': 'Song Max 50', 'song-pro': 'Song Pro' };
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
async function markPurchaseRequestDecided(email, packageId, decision, at) {
  try {
    const arr = await loadNotifications();
    const orig = arr.find((x) => x && x.kind === 'purchase-request' && x.email === email && !x.decision && (!x.pkg || x.pkg === packageId));
    if (orig) {
      orig.decision = decision;
      orig.decidedAt = at || new Date().toISOString();
      orig.read = true;
      await saveNotifications(arr);
    }
  } catch (e) {}
}
// Create a notification. For admin-facing kinds (login, purchase-request,
// gift-claimed, security, update, grant, deduct, purchase-approved,
// purchase-rejected, plan-expired, out-of-credit) ALSO send a Telegram
// message to the admin (fire-and-forget:
// it never blocks the response and its errors are swallowed). The bot token
// is never logged and never returned by any endpoint.
async function addNotification(kind, email, title, text, opts) {
  const n = { id: newNotificationId(), at: new Date().toISOString(), kind, email: email || '', title: title || '', text: text || '', read: false };
  if (opts && typeof opts === 'object' && opts.extra && typeof opts.extra === 'object') Object.assign(n, opts.extra);
  try {
    const arr = await loadNotifications();
    arr.unshift(n);
    if (arr.length > NOTIFICATIONS_MAX) arr.length = NOTIFICATIONS_MAX;
    await saveNotifications(arr);
  } catch (e) {}
  if (kind === 'login' || kind === 'purchase-request' || kind === 'gift-claimed' || kind === 'security' || kind === 'update' || kind === 'grant' || kind === 'deduct' || kind === 'purchase-approved' || kind === 'purchase-rejected' || kind === 'plan-expired' || kind === 'out-of-credit' || kind === 'post-removed') {
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
async function sendTelegramAdmin(text, parseMode) {
  try {
    const s = await loadSettings();
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
const VERIFY_LOGO_URL = 'data:image/webp;base64,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';
// In-memory only (a restart invalidates pending codes — the user just
// requests a new one). Keyed by lowercase email.
const verifyStore = new Map(); // email -> {code, token, expiresAt, attempts}
const verifySendCount = new Map(); // email -> {count, windowStart}
let emailTransporter = null;
let emailTransporterKey = '';
async function getEmailTransporter() {
  try {
    const s = await loadSettings();
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
async function brevoUsageLoad() {
  if (_brevoUsage && typeof _brevoUsage === 'object') return _brevoUsage;
    const j = await loadKvDoc('brevo-usage', null);
    if (j && typeof j === 'object' && typeof j.date === 'string') { _brevoUsage = j; return _brevoUsage; }
    _brevoUsage = { date: '', sent: 0 };
    return _brevoUsage;
}
async function brevoUsageSave() {
  try { await saveKvDoc('brevo-usage', _brevoUsage, 'brevo-usage.json'); } catch (e) {}
}
async function brevoUsageRecordSent() {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
    const u = await brevoUsageLoad();
    if (u.date !== today) { u.date = today; u.sent = 0; }
    u.sent = (Number(u.sent) || 0) + 1;
    await brevoUsageSave();
  } catch (e) {}
}
async function brevoUsageToday() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
  const u = await brevoUsageLoad();
  if (u.date !== today) { u.date = today; u.sent = 0; }
  return { date: today, sent: Number(u.sent) || 0 };
}
// Brevo HTTPS email API (replaces Gmail SMTP, which is blocked from
// Render — all SMTP ports time out). Brevo sends over HTTPS (port
// 443), so it works from Render. Free tier: 300 emails/day. The API
// key lives in settings.email.brevoApiKey (set in Admin → Settings →
// Email). Sender must be a Brevo-verified sender (sokhoeun356).
async function sendViaBrevo(toEmail, fromEmail, subject, html, text) {
  const s = await loadSettings();
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
    await brevoUsageRecordSent();
    return { ok: true };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: 'Brevo send failed — ' + (e && e.message ? String(e.message).slice(0, 200) : 'error') };
  }
}
async function verifyEmailConfigured() {
  try {
    const s = await loadSettings();
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
  const s = await loadSettings();
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
  const transporter = await getEmailTransporter();
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
async function getVapidKeys() {
  const wp = getWebPush();
    if (!wp) return null;
    try {
      let keys = await loadKvDoc('vapid', null);
      if (!(keys && typeof keys.publicKey === 'string' && keys.publicKey && typeof keys.privateKey === 'string' && keys.privateKey)) keys = null;
      if (!keys) {
        keys = wp.generateVAPIDKeys();
        await saveKvDoc('vapid', keys, 'vapid.json');
      }
      wp.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
      return keys;
    } catch (e) { return null; }
}
async function getVapidPublicKey() {
  const keys = await getVapidKeys();
  return keys ? keys.publicKey : '';
}
async function loadPushSubs() {
  const j = await loadKvDoc('push-subs', []);
    return Array.isArray(j) ? j : [];
}
async function savePushSubs(arr) {
  await saveKvDoc('push-subs', arr, 'push-subs.json');
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
async function removePushSubByEndpoint(endpoint) {
  try {
    const arr = await loadPushSubs();
    const kept = arr.filter((s) => s && s.endpoint !== endpoint);
    if (kept.length !== arr.length) await savePushSubs(kept);
  } catch (e) {}
}
// Send one Web Push. Fire-and-forget: the caller never awaits it. A 410/404
// from the push service means the subscription is gone — delete it. All
// other push errors are swallowed.
async function sendWebPush(sub, payload) {
  const wp = getWebPush();
  if (!wp) return;
  const keys = await getVapidKeys();
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
async function sendPushForNotification(n) {
  try {
    const ADMIN_KINDS = ['login', 'purchase-request', 'gift-claimed', 'security'];
    const USER_KINDS = ['purchase-approved', 'purchase-rejected', 'grant', 'deduct', 'gift-claimed', 'post', 'post-removed'];
    const subs = await loadPushSubs();
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
  // Auto-Catch master toggle (owner order 2026-11-18): when true the
  // device-limit auto-enforcement (limit, strikes, blocks) is active;
  // when false the server only records device info / VPN flags / strike
  // counts and never blocks automatically. Default OFF.
  autoCatch: false,
  // Admin Lockout protection toggle (owner order 2026-11-22): when true
  // (default ON) wrong admin-key attempts are blocked per IP in graduated
  // levels; when false the admin key is still required for every admin
  // call, but no IP is ever blocked for wrong keys.
  lockoutEnabled: true,
  // Device account-limit toggle (owner order 2026-11-18). deviceLimitEnabled
  // (default OFF) = enforce the free-account limit at registration;
  // deviceLimit (default 3) = how many free Google accounts one device
  // may register. The Admin can change the number later (e.g. 5+ when
  // the website is profitable). Read fresh from disk on every
  // registration — an Admin change takes effect immediately.
  deviceLimitEnabled: false,
  deviceLimit: 3,
  // New-user gift-50 toggle (owner order 2026-11-18). When true, a
  // BRAND-NEW registrant who claims the gift gets 50 song credits
  // instead of 24. When false (default) the gift is 24 song credits.
  // The gift is song-only either way — no media credits. Default OFF.
  gift50: false,
  // Monetization master toggle (owner order 2026-11-18). When true, the
  // website shows the Monetization section and package cashback + view
  // earnings are active. When false (default) nothing earns and the
  // website hides the Monetization UI. Default OFF.
  monetization: false,
  // Account-gated rollout (owner order 2026-11-20 09:54/10:02). When set,
  // { version, audience } names the version being rolled out and who is
  // offered it: "owner" = owner's accounts only (ADMIN_EMAILS), "all" =
  // everyone. Empty version = no gated rollout (everyone offered).
  rollout: { version: '', audience: 'all' },
  theme: 0, font: 50,
  glassClear: 45, glassBlur: 65, glassShine: 55,
  tshadow: 'none', txtblur: 0, bgb: 50, brandfx: 'none', mode: 'dark',
  // Active provider/model per mode, set by the admin. null = admin has not
  // set one yet — the website shows "admin មិនទាន់កំណត់" for that mode.
  providers: { image: null, video: null, song: null },
  // Admin-locked models (master switch). Map "provider:model" -> true.
  // A locked model is not used/shown in MovAi. Empty = nothing locked.
  lockedModels: {},
  // Deleted API providers (owner order 2026-11-20 13:07). Provider ids
  // the owner deleted from the Admin API Keys page. A deleted provider's
  // keys are removed and the website hides/stops offering it. Re-adding
  // a key for the provider restores it.
  deletedProviders: [],
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
  // Telegram shop bot (telegram-gmail-bot) on/off switch (owner order
  // 2026-11-20 20:48). This does NOT delete the bot — OFF suspends its
  // Render service, ON resumes it. Service: srv-dbombv9srm7s73cegmug,
  // https://telegram-gmail-bot.onrender.com, repo
  // sokhoeun356/telegram-gmail-bot. enabled = the owner's desired state
  // (default false = OFF: the owner ordered it off 2026-11-20 to save
  // hours; it stays off until they turn it on). serviceId is preset to
  // the known id but stays configurable (env TELEGRAM_BOT_SERVICE_ID
  // wins; the Admin field can change it). renderApiKey is a SECRET
  // Render API key (Dashboard -> Account Settings -> API Keys), never
  // returned by any endpoint and never logged. The key can also be set
  // via env RENDER_API_KEY (env wins).
  telegramBot: {
    enabled: false,
    serviceId: 'srv-dbombv9srm7s73cegmug',
    renderApiKey: '',
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
  // Auto-Catch master toggle (owner order 2026-11-18). A boolean true
  // turns the device-limit auto-enforcement on; anything else keeps the
  // stored value (default OFF).
  if (typeof j.autoCatch === 'boolean') s.autoCatch = j.autoCatch;
  // Admin Lockout protection toggle (owner order 2026-11-22). Default ON.
  if (typeof j.lockoutEnabled === 'boolean') s.lockoutEnabled = j.lockoutEnabled;
  // Device account-limit toggle (owner order 2026-11-18). enabled is a
  // boolean; limit is a whole number 1-100 (default 3). Invalid values
  // keep the stored value.
  if (typeof j.deviceLimitEnabled === 'boolean') s.deviceLimitEnabled = j.deviceLimitEnabled;
  if (Number.isFinite(j.deviceLimit)) s.deviceLimit = Math.min(100, Math.max(1, Math.floor(j.deviceLimit)));
  // Gift-50 toggle (owner order 2026-11-18). Boolean; invalid values
  // keep the stored value (default OFF).
  if (typeof j.gift50 === 'boolean') s.gift50 = j.gift50;
  // Monetization toggle (owner order 2026-11-18). Boolean; invalid
  // values keep the stored value (default OFF).
  if (typeof j.monetization === 'boolean') s.monetization = j.monetization;
  // Rollout flag (owner order 2026-11-20). Object {version, audience};
  // audience must be "owner" or "all"; invalid values keep the stored one.
  if (j.rollout && typeof j.rollout === 'object' && !Array.isArray(j.rollout)) {
    var _roV = typeof j.rollout.version === 'string' ? j.rollout.version.slice(0, 20) : '';
    var _roA = (j.rollout.audience === 'owner' || j.rollout.audience === 'all') ? j.rollout.audience : 'all';
    s.rollout = { version: _roV, audience: _roA };
  }
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
  // Deleted providers (owner order 2026-11-20 13:07). When the field is
  // present it REPLACES the stored list; when absent the stored value is
  // kept. Only known provider ids are kept.
  if (Array.isArray(j.deletedProviders)) {
    const del = [];
    for (const v of j.deletedProviders) {
      const p = normProvider(v);
      if (p && (KNOWN_KEY_PROVIDERS.includes(p) || p === 'cloudinary') && !del.includes(p)) del.push(p);
    }
    s.deletedProviders = del;
  } else {
    const baseDel = (base && Array.isArray(base.deletedProviders)) ? base.deletedProviders : [];
    s.deletedProviders = baseDel.map((v) => normProvider(v)).filter((p) => p && (KNOWN_KEY_PROVIDERS.includes(p) || p === 'cloudinary'));
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
  // Telegram shop bot on/off (owner order 2026-11-20 20:48). enabled is
  // a boolean (default true = running). serviceId is a plain string
  // (Render service id, srv-...). renderApiKey is a SECRET: a non-empty
  // string sets/rotates it; an empty string or missing field KEEPS the
  // stored key (the Admin leaves the field blank when it does not know
  // the key — that must never wipe it); null clears it. Invalid values
  // keep the stored value.
  const baseTb = (base && base.telegramBot && typeof base.telegramBot === 'object' && !Array.isArray(base.telegramBot)) ? base.telegramBot : SETTINGS_DEFAULTS.telegramBot;
  const tbIn = (j.telegramBot && typeof j.telegramBot === 'object' && !Array.isArray(j.telegramBot)) ? j.telegramBot : {};
  let tbKey;
  if (typeof tbIn.renderApiKey === 'string' && tbIn.renderApiKey.trim()) tbKey = tbIn.renderApiKey.trim().replace(/\s+/g, '').slice(0, 200);
  else if (tbIn.renderApiKey === null) tbKey = '';
  else tbKey = typeof baseTb.renderApiKey === 'string' ? baseTb.renderApiKey : '';
  s.telegramBot = {
    enabled: typeof tbIn.enabled === 'boolean' ? tbIn.enabled : (typeof baseTb.enabled === 'boolean' ? baseTb.enabled : true),
    serviceId: typeof tbIn.serviceId === 'string' ? tbIn.serviceId.trim().slice(0, 100) : (typeof baseTb.serviceId === 'string' ? baseTb.serviceId : ''),
    renderApiKey: tbKey,
  };
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
async function loadSettings() {
  const j = await loadKvDoc('settings', null);
    return cleanSettings(j);
}
async function saveSettings(s, base) {
  const out = cleanSettings(s, base);
    out.updatedAt = new Date().toISOString();
    await saveKvDoc('settings', out, 'settings.json');
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
  const tb = (s && s.telegramBot && typeof s.telegramBot === 'object' && !Array.isArray(s.telegramBot)) ? s.telegramBot : {};
  out.telegramBot = { hasRenderApiKey: !!(typeof tb.renderApiKey === 'string' && tb.renderApiKey.trim()), serviceId: typeof tb.serviceId === 'string' ? tb.serviceId : '', enabled: tb.enabled === true };
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
// musicapi, groq (the AI chat key), tavus kept for the legacy proxy branch,
// agnes (Agnes AI — free text/image/video Flash models, OpenAI-compatible),
// openrouter (stored keys kept in Admin; no longer used for lyrics
// since 2026-11-19 — AI Lyrics now uses Groq).
const ADMIN_KEYS_FILE = path.join(DATA_DIR, 'admin-keys.json');
const KNOWN_KEY_PROVIDERS = ['novai', 'magichour', 'masterpiecex', 'hunyuan3d', 'suno', 'acemusic', 'musicapi', 'tavus', 'groq', 'mvsep', 'agnes', 'openrouter'];
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
async function loadAdminKeys() {
  let j = null;
    const parsed = await loadKvDoc('admin-keys', null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) j = parsed;
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
    if (changed) await saveAdminKeys(out);
    return out;
}
async function saveAdminKeys(k) {
  await saveKvDoc('admin-keys', k, 'admin-keys.json');
}
// The provider's stored keys as a list [{key, endpoint}] (multi-key
// shape). Key VALUES are only used server-side — never returned or logged.
async function adminProviderKeyList(provider) {
  const rec = (await loadAdminKeys())[normProvider(provider)];
  if (!rec || !Array.isArray(rec.keys)) return [];
  return rec.keys.filter((e) => e && typeof e.key === 'string' && e.key.trim()).map((e) => ({ key: e.key.trim(), endpoint: typeof e.endpoint === 'string' ? e.endpoint.trim() : '' }));
}
// First stored key for a provider, or null (kept for single-key checks
// like "is a Groq key configured?"). endpoint is the Suno gateway URL
// (only Suno needs one — the other providers have fixed hosts).
async function adminProviderKey(provider) {
  const list = await adminProviderKeyList(provider);
  return list.length ? list[0] : null;
}
// Deleted providers (owner order 2026-11-20 13:07). Stored in settings.
// A deleted provider's keys are gone and the website hides/stops
// offering it. Re-adding a key restores it.
async function getDeletedProviders() {
  try {
    const s = await loadSettings();
    const arr = s && Array.isArray(s.deletedProviders) ? s.deletedProviders : [];
    const out = [];
    for (const v of arr) {
      const p = normProvider(v);
      if (p && (KNOWN_KEY_PROVIDERS.includes(p) || p === 'cloudinary') && !out.includes(p)) out.push(p);
    }
    return out;
  } catch (e) { return []; }
}
// Resolve a provider API key: the request's own key first, else the
// admin-stored key. The browser now sends no key — the admin key is used.
async function resolveProviderKey(reqKey, provider) {
  if (typeof reqKey === 'string' && reqKey.trim()) return reqKey.trim();
  const a = await adminProviderKey(provider);
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
let _keyHealthLoaded = false; // lazy-loaded from Supabase (kv_docs 'key-health') on first use
async function keyHealthEnsure() {
  if (_keyHealthLoaded) return;
  const j = await loadKvDoc('key-health', {});
  _keyHealth = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  _keyHealthLoaded = true;
  // One-time correction (2026-11-19): the 12:37 UTC incident marked all
  // 11 MVSEP keys 'exhausted' for a QUEUE-BUSY error ("unprocessed file
  // in queue"), not a quota — the daily limit was never reached (only
  // 1 separation that day). Queue-busy is 'busy', never 'exhausted'.
  // Correct any stale marker in memory so the Admin display tells the
  // truth (persisted on the next keyHealthSave).
  try {
    const _mv = _keyHealth.mvsep;
    if (_mv && typeof _mv === 'object') {
      for (const _idx of Object.keys(_mv)) {
        const _h = _mv[_idx];
        if (_h && _h.status === 'exhausted' && /unprocessed file in queue/i.test(String(_h.note || ''))) { _h.status = 'busy'; }
      }
    }
  } catch (e) {}
}
async function keyHealthSave() {
  await keyHealthEnsure();
  try { await saveKvDoc('key-health', _keyHealth, 'key-health.json'); } catch (e) {}
}
async function keyHealthSet(provider, idx, status, note) {
  await keyHealthEnsure();
  const p = String(provider || '').toLowerCase();
  if (!_keyHealth[p]) _keyHealth[p] = {};
  const cur = _keyHealth[p][String(idx)] || {};
  _keyHealth[p][String(idx)] = { status, note: String(note || '').slice(0, 120), at: new Date().toISOString(), lastOk: status === 'ok' ? new Date().toISOString() : (cur.lastOk || '') };
  await keyHealthSave();
}
async function keyHealthList() {
  await keyHealthEnsure();
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
    for (const p of ['suno', 'magichour', 'musicapi', 'novai', 'groq', 'mvsep', 'agnes']) {
      const n = (await adminProviderKeyList(p)).length;
      if (!n) continue;
      if (!out[p]) out[p] = [];
      for (let i = 0; i < n; i++) {
        if (!out[p].some((x) => x.key === i + 1)) out[p].push({ key: i + 1, status: 'unknown', note: '', at: '', lastOk: '' });
      }
      out[p].sort((a, b) => a.key - b.key);
    }
  } catch (e) {}
  // Deleted providers never appear (owner order 2026-11-20 13:07).
  try {
    const deleted = await getDeletedProviders();
    for (const p of deleted) delete out[p];
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
async function groqUsageLoad() {
  if (_groqUsage && typeof _groqUsage === 'object') return _groqUsage;
    const j = await loadKvDoc('groq-usage', null);
    if (j && typeof j === 'object' && typeof j.date === 'string') { _groqUsage = j; return _groqUsage; }
    _groqUsage = { date: '', keys: {} };
    return _groqUsage;
}
async function groqUsageSave() {
  try { await saveKvDoc('groq-usage', _groqUsage, 'groq-usage.json'); } catch (e) {}
}
function groqUsageTodayDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
}
async function recordGroqTokens(keyValue, totalTokens) {
  try {
    const n = Number(totalTokens) || 0;
    if (n <= 0) return;
    const today = groqUsageTodayDate();
    const u = await groqUsageLoad();
    if (u.date !== today) { u.date = today; u.keys = {}; }
    const list = await adminProviderKeyList('groq');
    let idx = -1;
    for (let i = 0; i < list.length; i++) { if (list[i].key === keyValue) { idx = i; break; } }
    if (idx < 0) return; // request-provided key, not an admin-stored one
    const k = String(idx);
    const prev = (u.keys[k] && Number(u.keys[k].used)) || 0;
    u.keys[k] = { used: prev + n };
    await groqUsageSave();
  } catch (e) {}
}
async function groqUsageList() {
  // Returns {date, dailyLimit, keys:[{key, usedToday, remainingToday,
  // percentRemaining, status}]} — status: green (>50% left), yellow
  // (<=50% left, still >0), red (0 left / exhausted). Keys are 1-based.
  const today = groqUsageTodayDate();
  const u = await groqUsageLoad();
  if (u.date !== today) { u.date = today; u.keys = {}; }
  const n = (await adminProviderKeyList('groq')).length;
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
const MVSEP_NEAR_EXHAUST_REMAINING = 5; // remaining <= 5 = "nearly exhausted" — jump to a fresh key AT ONCE, before it fails (owner order 2026-11-18)
let _mvsepUsage = null;
async function mvsepUsageLoad() {
  if (_mvsepUsage && typeof _mvsepUsage === 'object') return _mvsepUsage;
    const j = await loadKvDoc('mvsep-usage', null);
    if (j && typeof j === 'object' && typeof j.date === 'string') { _mvsepUsage = j; return _mvsepUsage; }
    _mvsepUsage = { date: '', keys: {} };
    return _mvsepUsage;
}
async function mvsepUsageSave() {
  try { await saveKvDoc('mvsep-usage', _mvsepUsage, 'mvsep-usage.json'); } catch (e) {}
}
function mvsepUsageTodayDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
}
async function recordMvsepSeparation(keyValue, hash) {
  try {
    if (hash) {
      if (_mvsepCountedHashes.has(hash)) return; // already counted — never count one separation twice
      if (_mvsepCountedHashes.size > 10000) _mvsepCountedHashes.clear();
      _mvsepCountedHashes.add(hash);
    }
    const today = mvsepUsageTodayDate();
    const u = await mvsepUsageLoad();
    if (u.date !== today) { u.date = today; u.keys = {}; }
    const list = await adminProviderKeyList('mvsep');
    let idx = -1;
    for (let i = 0; i < list.length; i++) { if (list[i].key === keyValue) { idx = i; break; } }
    if (idx < 0) return; // not an admin-stored key
    const k = String(idx);
    const prev = (u.keys[k] && Number(u.keys[k].used)) || 0;
    u.keys[k] = { used: prev + 1 };
    await mvsepUsageSave();
  } catch (e) {}
}
async function mvsepUsageList() {
  // Returns {date, dailyLimit, keys:[{key, usedToday, remainingToday,
  // status}]} — status: green (separations left), red (0 left / daily
  // limit reached). Keys are 1-based.
  const today = mvsepUsageTodayDate();
  const u = await mvsepUsageLoad();
  if (u.date !== today) { u.date = today; u.keys = {}; }
  const n = (await adminProviderKeyList('mvsep')).length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const used = (u.keys[String(i)] && Number(u.keys[String(i)].used)) || 0;
    const remaining = Math.max(0, MVSEP_DAILY_LIMIT - used);
    out.push({ key: i + 1, usedToday: used, remainingToday: remaining, status: remaining <= 0 ? 'red' : 'green' });
  }
  return { date: today, dailyLimit: MVSEP_DAILY_LIMIT, keys: out };
}
// Remaining MVSEP separations today for the key at 0-based index idx
// (server-side daily counter, limit 50/day/key). Returns null when the
// counter is unavailable — then the key is treated as usable.
async function mvsepKeyRemaining(idx) {
  try {
    const list = await mvsepUsageList();
    const e = list && Array.isArray(list.keys) ? list.keys[idx] : null;
    if (!e || typeof e.remainingToday !== 'number') return null;
    return e.remainingToday;
  } catch (err) { return null; }
}
// ---- Feature-usage tracking (Admin: how often each new function is used) ----
// The website reports every tap of the new functions (History actions,
// theme switches, Export choice, version-history view) via POST
// /api/public/feature-usage; the Admin reads the totals via GET
// /api/admin/feature-usage. Generic: ANY feature name is accepted (not a
// hardcoded list), so future features are tracked the same way. Counts
// are per-feature totals + a per-day breakdown (Phnom Penh date),
// persisted to feature-usage.json (GitHub-backed, in GH_DATA_FILES) so
// they survive restarts. Email is accepted but NOT stored — counts only.
// Day entries older than 90 days are pruned on write to bound growth.
const FEATURE_USAGE_FILE = path.join(DATA_DIR, 'feature-usage.json');
const FEATURE_USAGE_MAX_DAYS = 90;
let _featureUsage = null;
async function featureUsageLoad() {
  if (_featureUsage && typeof _featureUsage === 'object') return _featureUsage;
    const j = await loadKvDoc('feature-usage', null);
    if (j && typeof j === 'object' && j.features && typeof j.features === 'object') { _featureUsage = j; return _featureUsage; }
    _featureUsage = { features: {} };
    return _featureUsage;
}
async function featureUsageSave() {
  try { await saveKvDoc('feature-usage', _featureUsage, 'feature-usage.json'); } catch (e) {}
}
function featureUsageDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
}
function featureUsageCleanName(raw) {
  if (typeof raw !== 'string') return '';
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return /^[a-z0-9][a-z0-9_-]*$/.test(name) ? name : '';
}
async function featureUsageRecord(rawFeature) {
  const feature = featureUsageCleanName(rawFeature);
  if (!feature) return null;
  const today = featureUsageDate();
  const u = await featureUsageLoad();
  if (!u.features || typeof u.features !== 'object') u.features = {};
  let f = u.features[feature];
  if (!f || typeof f !== 'object') f = u.features[feature] = { total: 0, days: {} };
  if (!f.days || typeof f.days !== 'object') f.days = {};
  f.total = (Number(f.total) || 0) + 1;
  f.days[today] = (Number(f.days[today]) || 0) + 1;
  // Prune day entries older than FEATURE_USAGE_MAX_DAYS to bound file growth.
  const cutoff = new Date(Date.now() - FEATURE_USAGE_MAX_DAYS * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
  for (const d of Object.keys(f.days)) { if (d < cutoff) delete f.days[d]; }
  await featureUsageSave();
  return { feature, total: f.total, today: f.days[today] || 0 };
}
async function featureUsageList() {
  // Returns {date, features:[{feature, total, today, days:{date:count}}]}
  // sorted by total descending. days is the per-day breakdown.
  const today = featureUsageDate();
  const u = await featureUsageLoad();
  const out = [];
  const feats = (u.features && typeof u.features === 'object') ? u.features : {};
  for (const name of Object.keys(feats)) {
    const f = feats[name] || {};
    const days = (f.days && typeof f.days === 'object') ? f.days : {};
    out.push({ feature: name, total: Number(f.total) || 0, today: Number(days[today]) || 0, days });
  }
  out.sort((a, b) => b.total - a.total);
  return { date: today, features: out };
}
// ---- Wallet / Balance (stored-value money, owner order 2026-11-18) ----
// Users top up money (min $5) into a stored balance, use it to buy any
// package or to pay $0.10 for an instant password reset, and can ask to
// withdraw (min $5; fee tier: under $50 flat $0.50, $50+ is 5% of the
// amount). Top-ups and
// withdrawals are REQUESTS: the Admin approves/rejects them; money only
// moves on approval. Balances live on the user record (users.json,
// GitHub-backed); requests live in wallet-requests.json (GitHub-backed).
// Money is always stored rounded to 2 decimals (dollars).
const WALLET_MIN_TOPUP = 5.00;
const WALLET_MIN_WITHDRAW = 5.00;
const WALLET_INSTANT_RESET_PRICE = 0.10;
const WALLET_FREE_RESET_LIMIT = 2; // free email-code resets per user, ever
const INSTANT_RESET_TTL_MS = 10 * 60 * 1000; // instant-reset token lives 10 min
const WALLET_REQUESTS_FILE = path.join(DATA_DIR, 'wallet-requests.json');
// Instant-reset tokens: email -> {token, expiresAt}. In-memory only
// (like the email verification codes) — a token dies on use or expiry.
const instantResetTokens = new Map();
function walletMoney(n) { return Math.round(numOr(n, 0) * 100) / 100; }
function walletBalance(u) { return walletMoney(u && u.balance); }
// Earn balance (owner order 2026-11-18): cashback + view earnings.
// NOT spendable (cannot buy packages or slots) — withdraw-only, it just
// accumulates. Separate from the spendable top-up `balance`.
function walletEarnBalance(u) { return walletMoney(u && u.earnBalance); }
// Withdraw fee tier (owner order 2026-11-18): under $50 the fee is a
// flat $0.50; $50 and over it is 5% of the amount ($50 -> $2.50 fee,
// net $47.50; $100 -> $5.00 fee, net $95.00). total = amount + fee
// (deducted from the balance on Admin approval); net = amount - fee
// (what the user receives).
function walletWithdrawFee(amount) {
  const a = walletMoney(amount);
  if (!Number.isFinite(a) || a < WALLET_MIN_WITHDRAW) return 0.50;
  if (a < 50) return 0.50;
  return walletMoney(a * 0.05);
}
async function loadWalletRequests() {
  const rows = await sbSelect('wallet_requests', 'select=id,data');
    if (!rows) return [];
    const arr = rows.map((r) => r.data).filter(Boolean);
    arr.sort((a, b) => String(b.at || b.createdAt || '').localeCompare(String(a.at || a.createdAt || '')));
    return arr;
}
async function saveWalletRequests(arr) {
  const list = Array.isArray(arr) ? arr : [];
    for (const r of list) { if (r && !r.id) r.id = newWalletRequestId(); }
    const rows = list.filter((r) => r && typeof r.id === 'string' && r.id).map((r) => ({ id: r.id, data: r }));
    await sbSyncTable('wallet_requests', 'id', rows, 'id');
    scheduleBackup('wallet-requests.json');
}
function newWalletRequestId() {
  return 'wr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function walletRequestPublic(r, users) {
  const u = users && r && users[r.email];
  return Object.assign({}, r, { buyerId: u && u.id ? u.id : '', balance: u ? walletBalance(u) : 0, earnBalance: u ? walletEarnBalance(u) : 0 });
}
// ---- Monetization (owner order 2026-11-18) ----
// The website can earn money for its users: package cashback + view
// earnings (RPM $0.001 per 1000 views). Master toggle `monetization`
// in settings (default OFF). Data lives in three GitHub-backed files:
//   monetization-earnings.json — per-user {views, watchSeconds,
//     earnMicro, pendingMicro, paidOutMicro, cashbackTotal, byCountry}
//     (earnMicro/pendingMicro/paidOutMicro are micro-dollars:
//     1 micro-dollar = $0.000001. The per-view earning is TIERED by
//     package (owner order 2026-11-19 08:03 + 08:04): the rate for a
//     view is the HIGHER of the viewer's tier and the poster's tier.
//     Tiers per 1,000 views: no package $0.0001 (= 0.1 micro/view),
//     $5 song-trial $0.001 (= 1 micro/view), $10 song-popular $0.005
//     (= 5 micro/view), $22 song-pro $0.01 (= 10 micro/view),
//     $30 song-30 $0.02 (= 20 micro/view), $50 song-50 $0.05
//     (= 50 micro/view). Media packages (monthly/yearly) do NOT
//     raise the tier. Earnings are
//     stored rounded to 0.1 micro (all tier rates are multiples of
//     0.1 micro), so there is no float drift; $0.01 = 10,000 micro).
//   monetization-applications.json — per-user {email, name, followers,
//     watchHours, appliedAt, status, reason?, decidedAt?}.
//   creator-follows.json — {targetEmail: [followerEmail, ...]}.
// Eligibility (YouTube-style): >= 1000 followers AND >= 2000 watch
// hours (watchSeconds / 3600). Only a logged-in viewer counts toward
// watch time / earnings; guest views earn nothing. Earnings pay out
// only when monetization is ON and the owner is approved; watch time
// and followers accumulate regardless (they are the path to apply).
const MONETIZATION_EARNINGS_FILE = path.join(DATA_DIR, 'monetization-earnings.json');
const MONETIZATION_APPLICATIONS_FILE = path.join(DATA_DIR, 'monetization-applications.json');
const CREATOR_FOLLOWS_FILE = path.join(DATA_DIR, 'creator-follows.json');
// Tiered view earnings (owner order 2026-11-19 08:03 + 08:04).
// ratePer1K = dollars per 1,000 eligible views; microPerView = the
// micro-dollar amount accrued per eligible view (1 micro = $0.000001).
// The rate for one view is the HIGHER of the viewer's tier and the
// poster's (creator's) tier. Only the SONG packages raise the
// tier; a media-only package (monthly/yearly) earns the no-package rate.
const VIEW_EARN_TIERS = [
  { id: 'none', packageId: null, price: 0, ratePer1K: 0.0001, microPerView: 0.1 },
  { id: 'song-trial', packageId: 'song-trial', price: 5, ratePer1K: 0.001, microPerView: 1 },
  { id: 'song-popular', packageId: 'song-popular', price: 10, ratePer1K: 0.005, microPerView: 5 },
  { id: 'song-30', packageId: 'song-30', price: 30, ratePer1K: 0.02, microPerView: 20 },
  { id: 'song-50', packageId: 'song-50', price: 50, ratePer1K: 0.05, microPerView: 50 },
  { id: 'song-pro', packageId: 'song-pro', price: 22, ratePer1K: 0.01, microPerView: 10 },
];
const MONETIZATION_VIEW_EARN_MICRO = 1; // legacy $5-tier rate (1 micro/view); kept for reference only — the tier table above is the truth
// The view-earn tier of one user record, from their ACTIVE song
// package only (u.songPlan + u.songPlanExpiresAt). Expired or absent
// song package, or a media-only package, earns the 'none' tier.
function viewEarnTierForUser(u) {
  try {
    if (!u) return VIEW_EARN_TIERS[0];
    const now = Date.now();
    const exp = Date.parse(u.songPlanExpiresAt || '');
    if (!exp || exp <= now) return VIEW_EARN_TIERS[0];
    const sp = typeof u.songPlan === 'string' ? u.songPlan : '';
    for (const t of VIEW_EARN_TIERS) { if (t.packageId && t.packageId === sp) return t; }
    return VIEW_EARN_TIERS[0];
  } catch (e) { return VIEW_EARN_TIERS[0]; }
}
// Micro-dollars accrued per eligible view: the HIGHER of the viewer's
// tier and the poster's tier. A guest (no user record) counts as 'none'.
function viewEarnMicroForUsers(viewerU, ownerU) {
  const a = viewEarnTierForUser(viewerU).microPerView;
  const b = viewEarnTierForUser(ownerU).microPerView;
  return Math.max(a, b);
}
const MONETIZATION_MICRO_PER_CENT = 10000; // $0.01 = 10,000 micro-dollars
const MONETIZATION_FOLLOWERS_NEEDED = 1000;
const MONETIZATION_WATCH_HOURS_NEEDED = 2000;
const MONETIZATION_WATCH_SECONDS_NEEDED = MONETIZATION_WATCH_HOURS_NEEDED * 3600;
// Package cashback tiers by price: use the largest listed price <= the
// package price. $5->$0.01, $10->$0.05, $15->$0.05, $22->$0.10,
// $25->$0.10 (so a $180/$216 yearly package earns $0.10).
const MONETIZATION_CASHBACK_TIERS = [[25, 0.10], [22, 0.10], [15, 0.05], [10, 0.05], [5, 0.01]];
function monetizationCashbackForPrice(price) {
  const p = walletMoney(price);
  if (!Number.isFinite(p) || p <= 0) return 0;
  for (const t of MONETIZATION_CASHBACK_TIERS) { if (p >= t[0]) return t[1]; }
  return 0;
}
async function loadMonetizationEarnings() {
  const j = await loadKvDoc('monetization-earnings', {});
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
}
async function saveMonetizationEarnings(m) {
  await saveKvDoc('monetization-earnings', m, 'monetization-earnings.json');
}
async function monetizationRecord(email) {
  const em = normEmail(email);
  if (!em) return null;
  const m = await loadMonetizationEarnings();
  if (!m[em] || typeof m[em] !== 'object') m[em] = { views: 0, watchSeconds: 0, earnMicro: 0, pendingMicro: 0, paidOutMicro: 0, cashbackTotal: 0, byCountry: {}, viewsByDate: {}, viewers: {}, newListenerViews: 0 };
  return { m, rec: m[em], em };
}
// Lifetime package-cashback total for one user (dollars, 2 decimals).
// Called from the purchase-approve and wallet buy-package paths AFTER
// the balance was already updated by the caller (the caller saves users).
async function monetizationRecordCashback(email, amount) {
  try {
    const got = await monetizationRecord(email);
    if (!got) return;
    got.rec.cashbackTotal = walletMoney(numOr(got.rec.cashbackTotal, 0) + walletMoney(amount));
    await saveMonetizationEarnings(got.m);
  } catch (e) {}
}
async function loadMonetizationApplications() {
  const rows = await sbSelect('monetization_applications', 'select=email,data');
    if (!rows) return {};
    const out = {};
    for (const r of rows) { if (r && typeof r.email === 'string' && r.email) out[r.email] = r.data || {}; }
    return out;
}
async function saveMonetizationApplications(a) {
  const doc = (a && typeof a === 'object' && !Array.isArray(a)) ? a : {};
    const rows = Object.keys(doc).map((email) => ({ email, data: doc[email] || {} }));
    await sbSyncTable('monetization_applications', 'email', rows, 'email');
    scheduleBackup('monetization-applications.json');
}
async function monetizationIsApproved(email) {
  try {
    const a = await loadMonetizationApplications();
    const app = a[normEmail(email)];
    return !!(app && app.status === 'approved');
  } catch (e) { return false; }
}
async function loadCreatorFollows() {
  const rows = await sbSelect('creator_follows', 'select=follower_email,creator_email');
    if (!rows) return {};
    const out = {};
    for (const r of rows) {
      if (!r || typeof r.creator_email !== 'string' || !r.creator_email || typeof r.follower_email !== 'string' || !r.follower_email) continue;
      if (!Array.isArray(out[r.creator_email])) out[r.creator_email] = [];
      out[r.creator_email].push(r.follower_email);
    }
    return out;
}
async function saveCreatorFollows(f) {
  const doc = (f && typeof f === 'object' && !Array.isArray(f)) ? f : {};
    const rows = [];
    for (const creator of Object.keys(doc)) {
      const list = Array.isArray(doc[creator]) ? doc[creator] : [];
      for (const follower of list) {
        if (typeof follower !== 'string' || !follower) continue;
        // data holds the pair object, matching the migration convention
        // (supabase-schema.sql: creator_follows).
        rows.push({ follower_email: follower, creator_email: creator, data: { creator_email: creator, follower_email: follower } });
      }
    }
    try {
      if (rows.length) {
        const ok = await sbUpsert('creator_follows', rows, 'follower_email,creator_email');
        if (!ok) { scheduleBackup('creator-follows.json'); return; }
      }
      const existing = await sbSelect('creator_follows', 'select=follower_email,creator_email');
      if (existing) {
        const keep = new Set(rows.map((r) => r.follower_email + '\0' + r.creator_email));
        for (const r of existing) {
          if (!r || typeof r.follower_email !== 'string') continue;
          if (!keep.has(r.follower_email + '\0' + r.creator_email)) await sbDelete('creator_follows', 'follower_email=eq.' + encodeURIComponent(r.follower_email) + '&creator_email=eq.' + encodeURIComponent(String(r.creator_email)));
        }
      }
    } catch (e) {}
    scheduleBackup('creator-follows.json');
}
// Follower count for one creator — SINGLE source of truth for the
// website (Monetization sheet, Profile, feed post counts) and the
// Admin. Union of:
//   (a) per-creator follows (creator_follows[email]) — someone tapped
//       Follow on that creator's post, and
//   (b) the Public-page followers list (followers.json) — but ONLY
//       when the creator is an Admin, because the Follow pill on
//       the Admin's post IS the Public-page follow: those people
//       followed the Admin's page, so they are the Admin's followers.
//   (c) promo followers bought via Promo (owner order 2026-11-19):
//       the monetization-earnings record's `promoFollowers` counter
//       is ADDED to the union above — no fake follow rows exist.
// Before this, (a) and (b) were counted by different screens, so the
// Monetization sheet showed 0 while the Admin showed 3 (the
// Public-page list). The feed post's «2 Followers» was the same
// Public-page count at the time of the screenshot (it has since
// grown to 3) — a live count, not a stale one.
async function creatorFollowerCount(email) {
  try {
    const em = normEmail(email);
    if (!em) return 0;
    const set = new Set();
    const f = await loadCreatorFollows();
    const arr = Array.isArray(f[em]) ? f[em] : [];
    for (const x of arr) { const n = normEmail(x); if (n) set.add(n); }
    if (ADMIN_EMAILS.includes(em)) {
      const pub = await loadFollowers();
      for (const x of pub) { const n = normEmail(x); if (n) set.add(n); }
    }
    // Promo followers (owner order 2026-11-19): a separate counter
    // `promoFollowers` on the monetization-earnings record — never
    // fake creator_follows rows. Added to the organic total so promo
    // followers count toward the displayed total and the 1,000
    // monetization eligibility threshold. Read defensively so a
    // storage hiccup never zeroes the organic count.
    let promo = 0;
    try {
      const m = await loadMonetizationEarnings();
      const rec = m && m[em];
      promo = rec ? Math.max(0, Math.floor(numOr(rec.promoFollowers, 0))) : 0;
    } catch (e2) {}
    return set.size + promo;
  } catch (e) { return 0; }
}
async function monetizationFollowerCount(email) {
  return creatorFollowerCount(email);
}
// One view on a post (owner order 2026-11-20 09:08 - PER DAY rule):
// EVERY organic play counts, guest or logged in, monetization ON or
// OFF: Total views (rec.views), Today's views (viewsByDate[Phnom
// Penh date]) and Earnings by country (byCountry[cc].views) all +1,
// every time. Tomorrow's plays go into tomorrow's date key (fresh
// daily count each day). Earnings are separate: only a LOGGED-IN view,
// while monetization is ON and the owner is approved, accrues the
// per-view earning (tiered rate) and moves whole cents into the
// owner's Earn balance - guest views never earn. New-listener views
// stay logged-in only (they need a viewer email). Watch time still
// accrues from durationSec for logged-in views (eligibility).
// Returns the owner's earnings record (or null when no owner).
// Async because a whole-cent payout awaits the users GitHub flush.
async function monetizationOnView(ownerEmail, viewerEmail, country, durationSec) {
  const owner = normEmail(ownerEmail);
  const viewer = normEmail(viewerEmail);
  if (!owner) return null;
  const got = await monetizationRecord(owner);
  if (!got) return null;
  const rec = got.rec;
  const dur = Math.max(0, Math.floor(numOr(durationSec, 0)));
  if (dur > 0 && viewer) rec.watchSeconds = numOr(rec.watchSeconds, 0) + dur;
  const cc = (typeof country === 'string' && country.trim()) ? country.trim().toUpperCase().slice(0, 8) : 'Unknown';
  // ---- Counts: EVERY view, no gate (owner 2026-11-20 09:08, PER DAY
  // rule). Total views, Today's views (viewsByDate[Phnom Penh date])
  // and Earnings by country (byCountry[cc].views) all +1 on every
  // organic play — guest or logged in, monetization ON or OFF.
  // Tomorrow's plays go into tomorrow's date key (fresh daily count
  // each day). Promo-boosted views add to Total, Today's views and
  // byCountry too, via promoApplyBoost (owner 2026-11-20 11:42) —
  // they still never earn.
  if (!rec.viewsByDate || typeof rec.viewsByDate !== 'object') rec.viewsByDate = {};
  const _today = imgFreeTodayDate();
  rec.views = numOr(rec.views, 0) + 1;
  rec.viewsByDate[_today] = numOr(rec.viewsByDate[_today], 0) + 1;
  if (!rec.byCountry || typeof rec.byCountry !== 'object') rec.byCountry = {};
  if (!rec.byCountry[cc] || typeof rec.byCountry[cc] !== 'object') rec.byCountry[cc] = { views: 0, earnMicro: 0 };
  rec.byCountry[cc].views = numOr(rec.byCountry[cc].views, 0) + 1;
  // ---- Earnings: logged-in viewer + monetization ON + approved only.
  // Guest views earn nothing (unchanged policy).
  if (viewer && await monetizationEnabled() && await monetizationIsApproved(owner)) {
    // Tiered rate (owner 2026-11-19 08:03 + 08:04): the HIGHER of the
    // viewer's tier and the poster's tier. Rounded to 0.1 micro on
    // every add so the stored totals stay exact (all tier rates are
    // multiples of 0.1 micro, so there is no float drift).
    const _tierUsers = await loadUsers();
    const _tierMicro = viewEarnMicroForUsers(_tierUsers[viewer], _tierUsers[owner]);
    const _addMicro = (v) => Math.round((numOr(v, 0) + _tierMicro) * 10) / 10;
    // New-listener views: a viewer's FIRST-EVER view counts once.
    // Logged-in only (needs a viewer email).
    if (!rec.viewers || typeof rec.viewers !== 'object') rec.viewers = {};
    if (!rec.viewers[viewer]) {
      rec.viewers[viewer] = _today;
      rec.newListenerViews = numOr(rec.newListenerViews, 0) + 1;
    }
    rec.earnMicro = _addMicro(rec.earnMicro);
    rec.pendingMicro = _addMicro(rec.pendingMicro);
    rec.byCountry[cc].earnMicro = _addMicro(rec.byCountry[cc].earnMicro);
    // Move whole cents to the EARN balance (fractional remainder stays
    // pending). $0.01 = 10,000 micro-dollars. Earn money is NOT
    // spendable (cannot buy packages) — withdraw-only, it accumulates.
    const wholeMicro = Math.floor(numOr(rec.pendingMicro, 0) / MONETIZATION_MICRO_PER_CENT) * MONETIZATION_MICRO_PER_CENT;
    if (wholeMicro > 0) {
      const dollars = walletMoney(wholeMicro / 1000000);
      const users = _tierUsers;
      const u = users[owner];
      if (u) {
        u.earnBalance = walletMoney(walletEarnBalance(u) + dollars);
        u.updatedAt = new Date().toISOString();
        await saveUsers(users);
        scheduleBackup('users.json');
        rec.paidOutMicro = numOr(rec.paidOutMicro, 0) + wholeMicro;
        rec.pendingMicro = numOr(rec.pendingMicro, 0) - wholeMicro;
      }
    }
  }
  await saveMonetizationEarnings(got.m);
  return rec;
}
// ---- Device account limit + VPN-proof fingerprint (owner order 2026-11-18) ----
// Anti-abuse: one person can own 10 Gmails on one phone and register 10
// MovAi accounts to claim 10 gifts / create many songs. Rule: max 3
// accounts per DEVICE, free. A 4th+ registration is refused; each extra
// Gmail costs $1.00 (paid from the Wallet). Login is UNLIMITED — the
// limit is only on REGISTERING new accounts.
// The fingerprint must survive VPN: it does NOT rely on IP alone. The
// primary identifier is a stable client device ID (a UUID the website
// generates once and keeps in localStorage) + phone model + user-agent +
// screen. Turning on VPN only changes the IP — the device is still
// recognised, so VPN cannot evade the 3-account limit. A brand-new
// device (no prior registrations) is allowed its 3 accounts. A new or
// different phone model alone NEVER blocks a legitimate user — the model
// is only part of the fingerprint.
// Graduated warnings (owner order 2026-11-18, replaces immediate block):
// each refused registration attempt is a STRIKE on the device:
//   strike 1 (GREEN)  — email: the problem + the company rules
//   strike 2 (YELLOW) — email: same rules, yellow warning — there is a
//                        problem in their phone, it is not safe
//   strike 3 (FINAL)  — email: final warning, already determined/limited
//   strike 4+ (BLOCK) — the DEVICE is blocked + the attempting Gmail is
//                        blocked; email tells them to check their phone —
//                        it has a scam or a hidden hacker in it.
// Buying extra slots ($1 each) resets the device's strikes to 0 (they
// paid, so they are compliant again). The Admin unblocks a device via
// POST /api/admin/unblock-device (and a Gmail via unblock-email).
const DEVICE_FREE_ACCOUNT_LIMIT = 3; // free accounts per device
const DEVICE_SLOT_PRICE = 1.00; // $1.00 per extra account slot (Gmail)
const DEVICE_STRIKE_BLOCK_AT = 4; // block the device at strike 4
// Auto-Catch master toggle (owner order 2026-11-18). Stored in settings
// (GitHub-backed, default OFF). When OFF the server still RECORDS
// device info, VPN flags and strike counts, but does NOT send strike
// emails or auto-block anything — no account is blocked automatically
// (the Admin reviews the recorded strikes manually). When ON the full
// auto-enforcement is active (graduated strike emails, block at
// strike 4). The device-limit REFUSAL itself is governed by the
// separate deviceLimitEnabled setting below — autoCatch only gates
// the strike emails / auto-blocks. A VPN flag alone NEVER blocks
// anything — it is only an indicator.
async function autoCatchEnabled() {
  try { const s = await loadSettings(); return s && s.autoCatch === true; } catch (e) { return false; }
}
// Admin Lockout protection toggle (owner order 2026-11-22). When OFF the
// admin key is still required for every admin call, but wrong keys never
// block an IP. Default ON (protection as today). Read fresh on every
// call so an Admin change takes effect immediately.
async function lockoutEnabled() {
  try { const s = await loadSettings(); return s && s.lockoutEnabled !== false; } catch (e) { return true; }
}
// Device account-limit setting (owner order 2026-11-18). Stored in
// settings (GitHub-backed). deviceLimitEnabled (default OFF) = enforce
// the free-account limit at registration; deviceLimit (default 3) =
// how many free Google accounts one device may register. Read FRESH
// from disk on EVERY call (loadSettings re-reads settings.json — no
// in-memory cache) so an Admin change takes effect immediately on the
// next registration, even on Render. Separate from autoCatch (which
// gates strike emails / auto-blocks only).
async function deviceLimitSetting() {
  try {
    const s = await loadSettings();
    const enabled = !!(s && s.deviceLimitEnabled === true);
    let limit = DEVICE_FREE_ACCOUNT_LIMIT;
    if (s && Number.isFinite(s.deviceLimit)) limit = Math.min(100, Math.max(1, Math.floor(s.deviceLimit)));
    return { enabled, limit };
  } catch (e) { return { enabled: false, limit: DEVICE_FREE_ACCOUNT_LIMIT }; }
}
// New-user gift-50 toggle (owner order 2026-11-18). Stored in settings
// (GitHub-backed). When ON, a BRAND-NEW registrant who claims the gift
// gets 50 song credits instead of 24. When OFF (default) the gift is
// 24 song credits. The gift is song-only either way — no media credits.
// Read FRESH from disk on every call (loadSettings re-reads
// settings.json — no in-memory cache) so an Admin change takes effect
// immediately. Separate from autoCatch and deviceLimitEnabled.
async function gift50Enabled() {
  try { const s = await loadSettings(); return s && s.gift50 === true; } catch (e) { return false; }
}
// Monetization toggle, read FRESH from disk on every call
// (loadSettings re-reads settings.json — no in-memory cache), so an
// Admin change takes effect immediately. Default OFF.
async function monetizationEnabled() {
  try { const s = await loadSettings(); return s && s.monetization === true; } catch (e) { return false; }
}
const DEVICE_RECORDS_FILE = path.join(DATA_DIR, 'device-records.json');
// device-records.json shape: { "<fingerprintKey>": {
//   slots, strikes, blocked, blockedReason, blockedAt, blockedEmails,
//   vpnDetected, vpnLastSeen, ipChanges,
//   model, device, screen, timezone, lastIp, country,
//   firstSeen, lastSeen, emails: [] } }
// Fingerprint key: 'id:<deviceId>' when the website sends a device ID
// (primary, VPN-proof); 'mi:<model>|<ip>' fallback when it does not.
async function loadDeviceRecords() {
  const rows = await sbSelect('device_records', 'select=device_key,data');
    if (!rows) return {};
    const out = {};
    for (const r of rows) { if (r && typeof r.device_key === 'string' && r.device_key) out[r.device_key] = r.data || {}; }
    return out;
}
async function saveDeviceRecords(m) {
  const doc = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
    const rows = Object.keys(doc).map((k) => ({ device_key: k, data: doc[k] || {} }));
    await sbSyncTable('device_records', 'device_key', rows, 'device_key');
    scheduleBackup('device-records.json');
}
function deviceCleanId(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9\-_]/g, '').slice(0, 64);
}
// Fingerprint for THIS request. deviceId = stable client UUID
// (localStorage, generated once per browser/device). model = phone model
// (Client Hints body.model, else UA). screen/timezone/vpn come from the
// website body when sent. IP is server-side (X-Forwarded-For) — recorded
// but NEVER the primary key, because VPN changes it.
function deviceFingerprintFor(req, body, model) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    deviceId: deviceCleanId(b.deviceId),
    model: typeof model === 'string' ? model : '',
    device: deviceFromUA(req.headers && req.headers['user-agent']),
    screen: typeof b.screen === 'string' ? b.screen.trim().slice(0, 32) : '',
    timezone: typeof b.timezone === 'string' ? b.timezone.trim().slice(0, 64) : '',
    vpn: b.vpn === true,
    ip: getClientIp(req),
  };
}
function deviceFingerprintKey(fp) {
  if (fp.deviceId) return 'id:' + fp.deviceId;
  if (fp.model && fp.ip) return 'mi:' + fp.model + '|' + fp.ip;
  if (fp.model) return 'm:' + fp.model;
  if (fp.ip) return 'ip:' + fp.ip;
  return '';
}
// Find (or create) the device record for this fingerprint. Migration:
// when the website starts sending a deviceId for a device previously
// tracked under the model+IP key, its slots/strikes/block move to the
// 'id:' key once, so paid slots are not lost.
async function getDeviceRecord(fp, create) {
  const all = await loadDeviceRecords();
  const key = deviceFingerprintKey(fp);
  if (key && all[key] && typeof all[key] === 'object') return { rec: all[key], key, all };
  if (fp.deviceId && fp.model && fp.ip) {
    const miKey = 'mi:' + fp.model + '|' + fp.ip;
    if (all[miKey] && typeof all[miKey] === 'object') {
      const migrated = all[miKey];
      delete all[miKey];
      all[key] = migrated;
      await saveDeviceRecords(all);
      return { rec: migrated, key, all };
    }
  }
  if (!create || !key) return { rec: null, key, all };
  const now = new Date().toISOString();
  const rec = { slots: 0, strikes: 0, blocked: false, blockedReason: '', blockedAt: '', blockedEmails: [], vpnDetected: false, vpnLastSeen: '', ipChanges: 0, model: fp.model || '', device: fp.device || '', screen: fp.screen || '', timezone: fp.timezone || '', lastIp: fp.ip || '', country: '', firstSeen: now, lastSeen: now, emails: [] };
  all[key] = rec;
  return { rec, key, all };
}
// Purchased extra slots for this device (0 when none). Checks the
// canonical key and, for migration, the model+IP key — takes the max.
async function deviceSlotsFor(fp) {
  const all = await loadDeviceRecords();
  let n = 0;
  const key = deviceFingerprintKey(fp);
  if (key && all[key] && typeof all[key] === 'object') n = Math.max(n, Math.floor(numOr(all[key].slots, 0)));
  if (fp.deviceId && fp.model && fp.ip) {
    const miKey = 'mi:' + fp.model + '|' + fp.ip;
    if (all[miKey] && typeof all[miKey] === 'object') n = Math.max(n, Math.floor(numOr(all[miKey].slots, 0)));
  }
  return Math.max(0, n);
}
// Is this device blocked? Canonical key only (precise): a cleared
// localStorage (new deviceId) cannot be matched to the old record, but
// the registration limit (model+IP count) still catches a 4th account.
async function deviceIsBlocked(fp) {
  const got = await getDeviceRecord(fp, false);
  const rec = got.rec;
  if (rec && rec.blocked) return { blocked: true, reason: rec.blockedReason || 'device-blocked', key: got.key };
  return { blocked: false, reason: '', key: got.key };
}
// How many accounts already exist for this device. Primary: same
// deviceId. Fallback (no deviceId sent yet): same model + same last IP.
function deviceAccountsCount(users, fp) {
  let n = 0;
  const list = Object.values(users || {});
  for (const u of list) {
    if (!u || typeof u !== 'object') continue;
    if (fp.deviceId) {
      if (u.deviceId && u.deviceId === fp.deviceId) n++;
    } else if (fp.model && fp.ip) {
      if (u.model === fp.model && u.lastIp === fp.ip) n++;
    } else if (fp.model) {
      if (u.model === fp.model) n++;
    } else if (fp.ip) {
      if (u.lastIp === fp.ip) n++;
    }
  }
  return n;
}
// VPN detection (owner order 2026-11-18): VPN does NOT hide the device.
// Signals: (1) the website explicitly reports vpn:true; (2) the IP's
// country changes for a recognised device (checked in the async country
// lookup below). An IP change alone only bumps ipChanges — it is a
// neutral signal (WiFi -> mobile data also changes the IP), never a
// block by itself. The block comes only from the 3-account limit +
// strikes.
function deviceNoteVpn(rec, fp, now) {
  if (!rec) return;
  if (fp.vpn && !rec.vpnDetected) { rec.vpnDetected = true; rec.vpnLastSeen = now; }
  if (rec.lastIp && fp.ip && rec.lastIp !== fp.ip) rec.ipChanges = Math.floor(numOr(rec.ipChanges, 0)) + 1;
}
// Record this device sighting on the device record (last seen/IP/model,
// VPN flags, and the Gmails seen from it). Never creates a block.
async function deviceTouchRecord(fp, email, now) {
  const got = await getDeviceRecord(fp, true);
  const rec = got.rec;
  if (!rec) return null;
  deviceNoteVpn(rec, fp, now);
  rec.lastSeen = now;
  if (fp.ip) rec.lastIp = fp.ip;
  if (fp.model) rec.model = fp.model;
  if (fp.device) rec.device = fp.device;
  if (fp.screen) rec.screen = fp.screen;
  if (fp.timezone) rec.timezone = fp.timezone;
  if (email) {
    if (!Array.isArray(rec.emails)) rec.emails = [];
    if (!rec.emails.includes(email)) {
      rec.emails.unshift(email);
      if (rec.emails.length > 10) rec.emails.length = 10;
    }
  }
  await saveDeviceRecords(got.all);
  return rec;
}
// Full device picture for one user (Admin visibility): accounts on the
// user's registered device, purchased slots, limit, strikes, VPN flags,
// block state.
async function deviceInfoForUser(users, u) {
  const fp = { deviceId: u.deviceId || '', model: u.registeredModel || u.model || '', ip: u.lastIp || '' };
  const accounts = deviceAccountsCount(users, fp);
  const all = await loadDeviceRecords();
  let slots = 0, strikes = 0, vpnDetected = false, vpnLastSeen = '', deviceBlocked = false, blockedReason = '';
  const keys = [];
  const ck = deviceFingerprintKey(fp);
  if (ck) keys.push(ck);
  if (fp.deviceId && fp.model && fp.ip) keys.push('mi:' + fp.model + '|' + fp.ip);
  for (const k of keys) {
    const r = all[k];
    if (!r || typeof r !== 'object') continue;
    slots = Math.max(slots, Math.floor(numOr(r.slots, 0)));
    strikes = Math.max(strikes, Math.floor(numOr(r.strikes, 0)));
    if (r.vpnDetected) vpnDetected = true;
    if (r.vpnLastSeen && (!vpnLastSeen || r.vpnLastSeen > vpnLastSeen)) vpnLastSeen = r.vpnLastSeen;
    if (r.blocked) { deviceBlocked = true; blockedReason = r.blockedReason || 'device-blocked'; }
  }
  return { fingerprint: ck, accounts, slots, limit: (await deviceLimitSetting()).limit + slots, strikes, vpnDetected, vpnSuspected: vpnDetected, vpnLastSeen, deviceBlocked, blockedReason, emailBlocked: (await loadBlockedEmails()).some((b) => b === (u.email || '')) };
}
// Strike / block emails — APPROVED DESIGN (owner order 2026-11-18).
// Matches the approved Strike 1 preview (strike-1-warning-email-preview):
// MovAi brand header, coloured strike banner + progress dots, detected
// issues, 5 prohibitions, 6 phone-check steps, strike ladder, Admin
// contact box. Bilingual (Khmer then English) in one HTML email, with a
// plain-text fallback. Level 1 = GREEN, 2 = YELLOW, 3 = FINAL (orange),
// 4 = BLOCKED (red). Only the email CONTENT changed — the strike logic
// (counts, triggers, blocking) is untouched.
function deviceStrikeEmail(level, reason, ctx) {
  const lv = (level === 2) ? 2 : (level === 3) ? 3 : (level >= 4) ? 4 : 1;
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const email = (ctx && ctx.email) || '';
  const name = (ctx && ctx.name && String(ctx.name).trim()) || (email ? email.split('@')[0] : '') || 'អ្នកប្រើ MovAi';
  const model = (ctx && (ctx.model || ctx.deviceId)) || 'Unknown';
  const ip = (ctx && ctx.ip) || '';
  const count = Math.max(0, Math.floor(numOr(ctx && ctx.count, 0)));
  const limit = Math.max(DEVICE_FREE_ACCOUNT_LIMIT, Math.floor(numOr(ctx && ctx.limit, DEVICE_FREE_ACCOUNT_LIMIT)));
  const countShown = count > 0 ? count : limit;
  const r = reason || 'device-limit';
  const theme = {
    1: { c: '#4ade80', deep: '#14532d', border: '#2f5238', bg: '#12241a' },
    2: { c: '#facc15', deep: '#713f12', border: '#57501f', bg: '#241f0e' },
    3: { c: '#fb923c', deep: '#7c2d12', border: '#5b3a22', bg: '#241509' },
    4: { c: '#f87171', deep: '#7f1d1d', border: '#5b2323', bg: '#260f0f' },
  }[lv];
  const LV = {
    1: { subject: 'ការព្រមានទី 1 (បៃតង) · First Warning — MovAi',
      kmTitle: 'ការព្រមានទី 1', enTitle: 'First Warning', sub: 'STRIKE 1 · GREEN WARNING', dots: 1, dotsKm: 'ព្រមាន 1 / 3', dotsEn: 'Warning 1 of 3',
      kmBanner: 'នេះជាការព្រមានលើកទី 1 — គណនីរបស់អ្នកនៅដំណើរការធម្មតា មិនទាន់ត្រូវបានបិទទេ។ សូមអានឲ្យចប់ ហើយធ្វើតាមការណែនាំខាងក្រោម ដើម្បីកុំឲ្យឈានដល់ការព្រមានលើកក្រោយ។',
      enBanner: 'This is your first warning — your account is still active and has not been closed. Please read this email fully and follow the steps below so it does not reach the next warning.' },
    2: { subject: 'ការព្រមានទី 2 (លឿង) · Second Warning — MovAi',
      kmTitle: 'ការព្រមានទី 2', enTitle: 'Second Warning', sub: 'STRIKE 2 · YELLOW WARNING', dots: 2, dotsKm: 'ព្រមាន 2 / 3', dotsEn: 'Warning 2 of 3',
      kmBanner: 'នេះជាការព្រមានលើកទី 2 — ទូរស័ព្ទរបស់អ្នកត្រូវបានចាត់ទុកថាមិនសុវត្ថិភាព។ គណនីរបស់អ្នកនៅដំណើរការធម្មតា ប៉ុន្តែសូមពិនិត្យទូរស័ព្ទរបស់អ្នកឥឡូវនេះ ហើយធ្វើតាមការណែនាំខាងក្រោម។',
      enBanner: 'This is your second warning — your phone is now marked as unsafe. Your account is still active, but please check your phone right now and follow the steps below.' },
    3: { subject: 'ការព្រមានចុងក្រោយ · Final Warning — MovAi',
      kmTitle: 'ការព្រមានចុងក្រោយ', enTitle: 'Final Warning', sub: 'STRIKE 3 · FINAL WARNING', dots: 3, dotsKm: 'ព្រមាន 3 / 3', dotsEn: 'Warning 3 of 3',
      kmBanner: 'នេះជាការព្រមានចុងក្រោយ — បើបញ្ហានេះកើតឡើងម្តងទៀត គណនីរបស់អ្នកនឹងត្រូវបានបិទ។ សូមធ្វើតាមការណែនាំខាងក្រោមភ្លាម។',
      enBanner: 'This is the final warning — if this happens one more time, your account will be closed. Please follow the steps below right now.' },
    4: { subject: 'គណនីត្រូវបានប្លុក · Account Blocked — MovAi',
      kmTitle: 'គណនីត្រូវបានប្លុក', enTitle: 'Account Blocked', sub: 'STRIKE 4 · ACCOUNT BLOCKED', dots: 3, dotsKm: 'ប្លុកហើយ · Blocked', dotsEn: 'Blocked',
      kmBanner: 'គណនី/ឧបករណ៍របស់អ្នកត្រូវបានប្លុក។ សូមពិនិត្យទូរស័ព្ទរបស់អ្នក — វាមានស្កេម ឬហេកឃ័រលាក់ខ្លួននៅក្នុងហ្នឹង។ សូមសម្អាតទូរស័ព្ទរបស់អ្នកឲ្យស្អាត រួចទាក់ទង Admin ដើម្បីស្នើបើកវិញ។',
      enBanner: 'Your account/device has been blocked. Please check your phone — it has a scam or a hidden hacker in it. Clean your phone, then contact the Admin to ask to reopen it.' },
  }[lv];
  // Detected issues (dynamic per case).
  const issuesKm = [];
  const issuesEn = [];
  if (r === 'vpn') {
    issuesKm.push(['បញ្ហាទី 1', 'រកឃើញការបើក VPN ពេលចុះឈ្មោះ / ប្រើប្រាស់']);
    issuesEn.push(['Issue 1', 'A VPN was turned on during sign-up / use']);
  }
  const accNo = issuesKm.length + 1;
  issuesKm.push(['បញ្ហាទី ' + accNo, 'Device នេះបានចុះឈ្មោះគណនី ' + countShown + ' រួចហើយ (កំណត់ ' + limit + ')']);
  issuesEn.push(['Issue ' + accNo, 'This device has already registered ' + countShown + ' accounts (max ' + limit + ' free)']);
  if (lv === 4) {
    issuesKm.push(['ស្ថានភាព', 'ប្លុកហើយ — ត្រូវទាក់ទង Admin ដើម្បីដោះប្លុក']);
    issuesEn.push(['Status', 'Blocked — contact the Admin to unblock']);
  }
  // Shared content — copied from the approved preview (same for all levels).
  const BAN_KM = [
    { t: 'ហាមបើក VPN', s: 'ដើម្បីបិទបាំង Device ឬប្ដូរ IP ក្លែងធ្វើជាទូរស័ព្ទថ្មី ដើម្បីចុះឈ្មោះបន្ថែម។ ប្រព័ន្ធសម្គាល់ Device បានដោយផ្ទាល់ — VPN លាក់មិនបានទេ ហើយ VPN ក៏មិនត្រូវបានគាំទ្រ (Not Supported) សម្រាប់ការចុះឈ្មោះដែរ។' },
    { t: 'ហាមចុះឈ្មោះលើសពី 3 គណនី', s: 'នៅក្នុងទូរស័ព្ទតែមួយ (1 Device = 3 Accounts)។ បើចង់ប្រើ Gmail បន្ថែម ត្រូវ Upgrade — បន្ថែម 1 Gmail = $1 បង់តាម Balance ក្នុង Profile។' },
    { t: 'ហាមទុក App ស្កេម ឬ App ដែលមិនស្គាល់ប្រភព', s: 'នៅក្នុងទូរស័ព្ទ ជាពិសេស App ដែលទាញយកក្រៅ Play Store / App Store។ App បែបនេះអាចលួចមើលអេក្រង់ អានសារ OTP និងលួចលុយពីគណនីធនាគាររបស់អ្នកបាន។' },
    { t: 'ហាមឲ្យលេខកូដ OTP ឬ Password', s: 'ទៅអ្នកដទៃ ទោះគេអះអាងថាជាបុគ្គលិក MovAi ឬបុគ្គលិកធនាគារក៏ដោយ។ ក្រុម MovAi មិនដែលសុំលេខកូដ OTP ឬ Password របស់អ្នកទេ។' },
    { t: 'ហាមប្រើ MovAi ក្លែងបន្លំ (MOD / Crack)', s: 'ឬចូលតាម Website ក្លែងក្លាយ។ សូមប្រើតែ Website ផ្លូវការរបស់ MovAi ប៉ុណ្ណោះ។' },
  ];
  const BAN_EN = [
    { t: 'Do not use a VPN', s: 'to hide your device or change your IP to look like a new phone and register more accounts. Our system identifies the device directly — a VPN cannot hide it, and VPNs are not supported for registration.' },
    { t: 'Do not register more than 3 accounts', s: 'on one phone (1 device = 3 accounts). If you need more Gmail accounts, please Upgrade — each extra Gmail is $1, paid from your Profile balance.' },
    { t: 'Do not keep scam apps or apps from unknown sources', s: 'on your phone, especially apps installed from outside the Play Store / App Store. Such apps can watch your screen, read OTP codes, and steal money from your bank account.' },
    { t: 'Never give your OTP code or password', s: 'to anyone, even if they claim to be MovAi staff or bank staff. MovAi never asks for your OTP code or password.' },
    { t: 'Do not use fake MovAi copies (MOD / Crack)', s: 'or fake websites. Only use the official MovAi website.' },
  ];
  const STEPS_KM = [
    { t: 'បិទ VPN ហើយលុប App VPN ចោល', s: 'បើមិនចាំបាច់ប្រើ។ ចូល Settings → Apps → រក App VPN → Uninstall។' },
    { t: 'ពិនិត្យបញ្ជី App ទាំងអស់ក្នុងទូរស័ព្ទ', s: 'បើឃើញ App ណាដែលអ្នកមិនស្គាល់ មិនបានដំឡើងខ្លួនឯង ឬគ្មានរូបតំណាងច្បាស់លាស់ សូមលុបវាចោលភ្លាម។' },
    { t: 'ពិនិត្យសិទ្ធិ (Permission) របស់ App', s: 'App ណាសុំសិទ្ធិអាន SMS, សិទ្ធិ Accessibility ឬសិទ្ធិថត/មើលអេក្រង់ ដោយគ្មានហេតុផល សូមបិទសិទ្ធិនោះ ឬលុប App ចោល។ នេះជាច្រកដែល Scam ប្រើលួចលេខកូដ OTP ធនាគារច្រើនជាងគេ។' },
    { t: 'ស្កេនទូរស័ព្ទរកមេរោគ', s: 'បើក Google Play Protect (Play Store → រូប Profile → Play Protect → Scan) ឬកម្មវិធីការពារដែលទុកចិត្តបាន ហើយស្កេនឲ្យចប់។' },
    { t: 'ការពារគណនីធនាគាររបស់អ្នក', s: 'កុំប្រើ App ធនាគារនៅលើទូរស័ព្ទដែលមាន App ស្កេម។ បើអ្នកសង្ស័យថាធ្លាប់ដំឡើង App ប្លែក សូមដូរ Password ធនាគារ និងបើកការផ្ទៀងផ្ទាត់ 2 ជំហាន (2FA)។' },
    { pre: 'ធ្វើរួចហើយ ', t: 'ចូល MovAi ដោយមិនបើក VPN', s: 'ហើយប្រើប្រាស់ធម្មតា — គណនីរបស់អ្នកនឹងនៅសុវត្ថិភាព។' },
  ];
  const STEPS_EN = [
    { t: 'Turn off the VPN and delete the VPN app', s: 'if you do not really need it. Go to Settings → Apps → find the VPN app → Uninstall.' },
    { t: 'Check every app on your phone.', s: 'If you see an app you do not know, did not install yourself, or that has no clear icon, delete it immediately.' },
    { t: 'Check app permissions.', s: 'If an app can read your SMS, use Accessibility, or record/view your screen without a good reason, remove that permission or delete the app. This is the main way scams steal bank OTP codes.' },
    { t: 'Scan your phone for malware.', s: 'Run Google Play Protect (Play Store → your profile picture → Play Protect → Scan) or a trusted security app, and let the scan finish.' },
    { t: 'Protect your bank accounts.', s: 'Do not use banking apps on a phone that has scam apps on it. If you ever installed a strange app, change your bank password and turn on two-step verification (2FA).' },
    { pre: 'When you are done, ', t: 'open MovAi without a VPN', s: 'and use it normally — your account will stay safe.' },
  ];
  const LADDER_KM = [
    { t: 'លើកទី 1 — ពណ៌បៃតង', s: 'ផ្ញើសារព្រមាន និងណែនាំឲ្យពិនិត្យទូរស័ព្ទ (សារនេះ)។' },
    { t: 'លើកទី 2 — ពណ៌លឿង', s: 'ព្រមានធ្ងន់ជាងមុន៖ ទូរស័ព្ទរបស់អ្នកត្រូវបានចាត់ទុកថាមិនសុវត្ថិភាព។' },
    { t: 'លើកទី 3 — ព្រមានចុងក្រោយ', s: 'ផ្ញើសារដូចដើមជាលើកចុងក្រោយ មុនពេលបិទគណនី។' },
    { t: 'លើសពី 3 ដង — បិទគណនី', s: 'គណនីនឹងត្រូវបានបិទ ហើយអ្នកត្រូវពិនិត្យទូរស័ព្ទឲ្យស្អាតពី Scam / Hacker សិន ទើបអាចស្នើបើកវិញបាន។' },
  ];
  const LADDER_EN = [
    { t: '1st time — Green', s: 'A warning email with instructions to check your phone (this email).' },
    { t: '2nd time — Yellow', s: 'A stronger warning: your phone is marked as unsafe.' },
    { t: '3rd time — Final warning', s: 'The same warning sent one last time before the account is closed.' },
    { t: 'More than 3 times — Account closed', s: 'Your account will be closed, and you must clean your phone of scams/hackers before you can ask to reopen it.' },
  ];
  const INTRO_KM = 'ប្រព័ន្ធសុវត្ថិភាពរបស់ MovAi បានរកឃើញបញ្ហាមួយចំនួននៅលើគណនី និងទូរស័ព្ទរបស់អ្នក។ យើងផ្ញើសារនេះមក ដើម្បីឲ្យអ្នកបានដឹង និងប្រុងប្រយ័ត្នទាន់ពេល — ព្រោះបញ្ហាបែបនេះអាចធ្វើឲ្យទូរស័ព្ទរបស់អ្នក គណនីធនាគារ និងព័ត៌មានផ្ទាល់ខ្លួនរបស់អ្នក ត្រូវជនខិលខូច (Hacker / Scam) លួចយកបាន។';
  const INTRO_EN = 'MovAi security system found some problems with your account and your phone. We are sending this email so you know in time and can take care — problems like these can let hackers and scammers steal your phone data, your bank accounts, and your personal information.';
  const INTRO4_KM = 'ប្រព័ន្ធសុវត្ថិភាពរបស់ MovAi បានរកឃើញបញ្ហាម្តងហើយម្តងទៀតនៅលើគណនី និងទូរស័ព្ទរបស់អ្នក។ ដោយសារនេះជាលើកទី 4 ហើយ គណនី/ឧបករណ៍របស់អ្នកត្រូវបានប្លុក។ សូមពិនិត្យទូរស័ព្ទរបស់អ្នកឲ្យស្អាតពីស្កេម/ហេកឃ័រ រួចទាក់ទង Admin ដើម្បីស្នើបើកវិញ។';
  const INTRO4_EN = 'MovAi security system found the same problems on your account and phone again and again. Because this is the 4th time, your account/device has been blocked. Please clean your phone of scams and hackers, then contact the Admin to ask to reopen it.';
  const KM = {
    teamTag: 'ក្រុមសុវត្ថិភាព', greet: 'សួស្តី', intro: lv === 4 ? INTRO4_KM : INTRO_KM,
    s1: 'បញ្ហាដែលប្រព័ន្ធរកឃើញ', s2: 'ចំណុចបម្រាម — ហាមធ្វើដាច់ខាត',
    s3: 'សូមពិនិត្យទូរស័ព្ទរបស់អ្នកឥឡូវនេះ',
    s3sub: 'ដើម្បីការពារខ្លួនអ្នកពី Hacker និង App ស្កេម — ជាពិសេស App ធនាគារ និងលុយរបស់អ្នក — សូមធ្វើតាមជំហានទាំងនេះ៖',
    s4: 'បើបញ្ហានេះកើតឡើងម្តងទៀត',
    account: 'គណនី', device: 'ទូរស័ព្ទ (Device)',
    contactTitle: 'ត្រូវការជំនួយ? ទាក់ទង Admin',
    contactSub: 'បើអ្នកគិតថានេះជាកំហុស ឬត្រូវការជំនួយពិនិត្យទូរស័ព្ទ សូមទាក់ទងមកយើង៖',
    phone: 'លេខទូរស័ព្ទ · Phone',
    thanks: 'សូមអរគុណដែលបានយល់ និងសហការ។', team: '— ក្រុមសុវត្ថិភាព MovAi',
    foot: 'សារនេះត្រូវបានផ្ញើដោយស្វ័យប្រវត្តិពីប្រព័ន្ធសុវត្ថិភាព MovAi — សូមកុំចែករំលែកលេខកូដ ឬ Password របស់អ្នកទៅអ្នកណាម្នាក់។',
    rights: '© 2026 MovAi · រក្សាសិទ្ធិគ្រប់យ៉ាង', now: 'ឥឡូវនេះ',
    bannerTitle: LV.kmTitle, bannerSub: LV.sub, banner: LV.kmBanner, dotsLabel: LV.dotsKm, dots: LV.dots,
    ban: BAN_KM, steps: STEPS_KM, ladder: LADDER_KM, issues: issuesKm,
  };
  const EN = {
    teamTag: 'Security Team', greet: 'Hello', intro: lv === 4 ? INTRO4_EN : INTRO_EN,
    s1: 'What our system detected', s2: 'Rules — strictly prohibited',
    s3: 'Please check your phone now',
    s3sub: 'To protect yourself from hackers and scam apps — especially your banking apps and your money — please follow these steps:',
    s4: 'If this happens again',
    account: 'Account', device: 'Device',
    contactTitle: 'Need help? Contact Admin',
    contactSub: 'If you think this is a mistake, or you need help checking your phone, contact us:',
    phone: 'Phone',
    thanks: 'Thank you for understanding and cooperating.', team: '— MovAi Security Team',
    foot: 'This email was sent automatically by the MovAi security system — never share your codes or password with anyone.',
    rights: '© 2026 MovAi · All rights reserved', now: 'NOW',
    bannerTitle: LV.enTitle, bannerSub: LV.sub, banner: LV.enBanner, dotsLabel: LV.dotsEn, dots: LV.dots,
    ban: BAN_EN, steps: STEPS_EN, ladder: LADDER_EN, issues: issuesEn,
  };
  // One language of the email (inline styles only — email-safe).
  function langHtml(B) {
    let dots = '';
    for (let i = 1; i <= 3; i++) dots += '<span style="display:inline-block;width:26px;height:8px;border-radius:99px;background:' + (i <= B.dots ? theme.c : '#2b3324') + ';margin-right:6px;"></span>';
    let rows = '';
    rows += '<div style="padding:9px 0;border-bottom:1px dashed #2b3324;"><span style="color:#a7b198;font-weight:600;font-size:14px;">' + B.account + ': </span><span style="font-weight:600;">' + esc(name) + ' · ' + esc(email) + '</span></div>';
    rows += '<div style="padding:9px 0;border-bottom:1px dashed #2b3324;"><span style="color:#a7b198;font-weight:600;font-size:14px;">' + B.device + ': </span><span style="font-weight:600;">' + esc(model) + (ip ? ' · IP ' + esc(ip) : '') + '</span></div>';
    for (let i = 0; i < B.issues.length; i++) {
      rows += '<div style="padding:9px 0;' + (i < B.issues.length - 1 ? 'border-bottom:1px dashed #2b3324;' : '') + '"><span style="color:#a7b198;font-weight:600;font-size:14px;">' + B.issues[i][0] + ': </span><span style="font-weight:600;color:#facc15;">' + esc(B.issues[i][1]) + '</span></div>';
    }
    let ban = '';
    for (const it of B.ban) ban += '<div style="background:#151a12;border:1px solid #2b3324;border-radius:12px;padding:11px 14px;margin-bottom:9px;"><span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:rgba(248,113,113,.14);color:#f87171;text-align:center;line-height:22px;font-weight:700;font-size:13px;">✕</span> <b>' + it.t + '</b> ' + it.s + '</div>';
    let steps = '';
    for (let i = 0; i < B.steps.length; i++) {
      const st = B.steps[i];
      steps += '<div style="background:#151a12;border:1px solid #2b3324;border-radius:12px;padding:11px 14px;margin-bottom:9px;"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background:#a3e635;color:#131702;text-align:center;line-height:24px;font-weight:700;font-size:13px;">' + (i + 1) + '</span> ' + (st.pre || '') + '<b>' + st.t + '</b> ' + st.s + '</div>';
    }
    let ladder = '';
    const dotColors = ['#4ade80', '#facc15', '#fb923c', '#f87171'];
    for (let i = 0; i < B.ladder.length; i++) {
      const isNow = (i + 1) === lv;
      ladder += '<div style="background:' + (isNow ? '#101c13' : '#151a12') + ';border:1px solid ' + (isNow ? theme.border : '#2b3324') + ';border-radius:12px;padding:12px 14px;margin-bottom:9px;"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + dotColors[i] + ';vertical-align:middle;"></span> <b>' + B.ladder[i].t + '</b>' + (isNow ? ' <span style="float:right;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;background:' + theme.deep + ';color:' + theme.c + ';">' + B.now + '</span>' : '') + '<br><span style="color:#a7b198;font-size:13px;">' + B.ladder[i].s + '</span></div>';
    }
    return '<div style="max-width:560px;margin:0 auto;padding:26px 22px 0;background:#0c0f0a;color:#eef3e2;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;">'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:27px;font-weight:700;color:#ffffff;">Mov<span style="color:#a3e635;">Ai</span></td><td align="right" style="font-size:11px;font-weight:700;letter-spacing:2px;color:#a7b198;text-transform:uppercase;">Security Team<br><span style="color:#a3e635;letter-spacing:0;text-transform:none;font-size:13px;">' + B.teamTag + '</span></td></tr></table>'
      + '<div style="border-bottom:1px solid #2b3324;margin-bottom:20px;"></div>'
      + '<div style="border:1px solid ' + theme.border + ';border-radius:14px;background:' + theme.bg + ';padding:18px;">'
      + '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="58" valign="top"><div style="width:46px;height:46px;border-radius:12px;background:' + theme.deep + ';text-align:center;line-height:46px;font-size:24px;color:' + theme.c + ';">⚠</div></td><td valign="top"><div style="font-size:21px;font-weight:700;">' + B.bannerTitle + '</div><div style="font-size:13px;letter-spacing:2px;color:' + theme.c + ';font-weight:700;">' + B.bannerSub + '</div></td></tr></table>'
      + '<p style="margin:10px 0 0;color:#a7b198;font-size:14px;">' + B.banner + '</p>'
      + '<div style="margin-top:10px;">' + dots + '<span style="color:#a7b198;font-size:13px;">' + B.dotsLabel + '</span></div>'
      + '</div>'
      + '<p style="margin-top:20px;">' + B.greet + ' <b>' + esc(name) + '</b>,</p>'
      + '<p>' + B.intro + '</p>'
      + '<h2 style="font-size:17px;font-weight:700;margin:26px 0 10px;">1. ' + B.s1 + '</h2>'
      + '<div style="background:#151a12;border:1px solid #2b3324;border-radius:12px;padding:6px 16px;">' + rows + '</div>'
      + '<h2 style="font-size:17px;font-weight:700;margin:26px 0 10px;">2. ' + B.s2 + '</h2>'
      + ban
      + '<h2 style="font-size:17px;font-weight:700;margin:26px 0 10px;">3. ' + B.s3 + '</h2>'
      + '<p style="color:#a7b198;margin-top:0;">' + B.s3sub + '</p>'
      + steps
      + '<h2 style="font-size:17px;font-weight:700;margin:26px 0 10px;">4. ' + B.s4 + '</h2>'
      + ladder
      + '<div style="margin-top:26px;background:#1a2015;border:1px solid #2b3324;border-radius:14px;padding:16px 18px;">'
      + '<h2 style="font-size:17px;font-weight:700;margin:0 0 2px;">' + B.contactTitle + '</h2>'
      + '<p style="color:#a7b198;margin:0 0 8px;font-size:14px;">' + B.contactSub + '</p>'
      + '<a href="tel:+85581914728" style="display:block;color:#eef3e2;text-decoration:none;background:#151a12;border:1px solid #2b3324;border-radius:10px;padding:10px 14px;margin-bottom:10px;"><span style="color:#a7b198;font-size:13px;display:block;">' + B.phone + '</span><b>081 914 728</b></a>'
      + '<a href="mailto:sokhoeun356@gmail.com" style="display:block;color:#eef3e2;text-decoration:none;background:#151a12;border:1px solid #2b3324;border-radius:10px;padding:10px 14px;margin-bottom:10px;"><span style="color:#a7b198;font-size:13px;display:block;">Gmail</span><b>sokhoeun356@gmail.com</b></a>'
      + '<a href="https://t.me/yemsokhoeun_9999" style="display:block;color:#eef3e2;text-decoration:none;background:#151a12;border:1px solid #2b3324;border-radius:10px;padding:10px 14px;"><span style="color:#a7b198;font-size:13px;display:block;">Telegram</span><b>@yemsokhoeun_9999</b></a>'
      + '</div>'
      + '<p style="margin-top:24px;margin-bottom:2px;">' + B.thanks + '</p>'
      + '<p style="font-weight:700;margin-top:0;">' + B.team + '</p>'
      + '<div style="margin:22px -22px 0;padding:16px 22px 20px;border-top:1px solid #2b3324;color:#a7b198;font-size:13px;text-align:center;"><div style="font-size:17px;font-weight:700;color:#ffffff;">Mov<span style="color:#a3e635;">Ai</span></div><p style="margin:6px 0 0;">' + B.foot + '<br>' + B.rights + '</p></div>'
      + '</div>';
  }
  // Plain-text fallback (same content, both languages).
  function langText(B) {
    const lines = [];
    lines.push('MovAi — ' + B.teamTag, '');
    lines.push(B.bannerTitle + ' · ' + B.bannerSub, B.banner, B.dotsLabel, '');
    lines.push(B.greet + ' ' + name + ',', B.intro, '');
    lines.push('1) ' + B.s1);
    lines.push('• ' + B.account + ': ' + name + ' · ' + email);
    lines.push('• ' + B.device + ': ' + model + (ip ? ' · IP ' + ip : ''));
    for (const iss of B.issues) lines.push('• ' + iss[0] + ': ' + iss[1]);
    lines.push('');
    lines.push('2) ' + B.s2);
    for (const it of B.ban) lines.push('✕ ' + it.t + ' ' + it.s);
    lines.push('');
    lines.push('3) ' + B.s3, B.s3sub);
    for (let i = 0; i < B.steps.length; i++) lines.push((i + 1) + '. ' + (B.steps[i].pre || '') + B.steps[i].t + ' ' + B.steps[i].s);
    lines.push('');
    lines.push('4) ' + B.s4);
    for (let i = 0; i < B.ladder.length; i++) lines.push('• ' + B.ladder[i].t + ': ' + B.ladder[i].s + ((i + 1) === lv ? ' [' + B.now + ']' : ''));
    lines.push('');
    lines.push(B.contactTitle, B.contactSub);
    lines.push('• ' + B.phone + ': 081 914 728');
    lines.push('• Gmail: sokhoeun356@gmail.com');
    lines.push('• Telegram: @yemsokhoeun_9999');
    lines.push('', B.thanks, B.team, '', B.foot, B.rights, '');
    return lines.join('\n');
  }
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#0c0f0a;font-family:Arial,Helvetica,sans-serif;color:#eef3e2;">'
    + langHtml(KM)
    + '<div style="max-width:560px;margin:0 auto;padding:14px 22px;text-align:center;color:#a7b198;font-size:13px;">— English version below · ខាងក្រោមជាភាសាអង់គ្លេស —</div>'
    + langHtml(EN)
    + '</body></html>';
  const text = langText(KM) + '\n' + langText(EN);
  return { subject: LV.subject, html, text };
}

// Record one violation (a refused registration attempt) on the device:
// always increments strikes, logs it and notifies the Admin (a record).
// The strike LEVEL EMAIL and the block at strike 4 happen ONLY when
// Auto-Catch is ON (owner order 2026-11-18) — when OFF the strike is
// only recorded, nothing is sent and nothing is blocked. extra =
// {name, count, limit} for the email (per-user name/Gmail/device).
// Returns {strikes, level, blocked}.
async function recordDeviceStrike(all, key, rec, email, reason, fp, extra) {
  const now = new Date().toISOString();
  rec.strikes = Math.floor(numOr(rec.strikes, 0)) + 1;
  rec.lastSeen = now;
  if (fp.ip) rec.lastIp = fp.ip;
  const strikes = rec.strikes;
  const level = strikes >= DEVICE_STRIKE_BLOCK_AT ? 4 : strikes; // 1, 2, 3, 4
  let blocked = false;
  const catchOn = await autoCatchEnabled();
  // Auto-Catch ON only: at strike 4 block the device + the Gmail.
  if (catchOn && strikes >= DEVICE_STRIKE_BLOCK_AT) {
    rec.blocked = true;
    rec.blockedReason = 'device-limit-abuse';
    rec.blockedAt = now;
    blocked = true;
    // Block the attempting Gmail too, so it cannot register later from
    // another device until the Admin unblocks it (unblock-email).
    const bem = await loadBlockedEmails();
    if (!bem.some((b) => b === email)) { bem.push(email); await saveBlockedEmails(bem); scheduleBackup('blocked-emails.json'); }
    if (!Array.isArray(rec.blockedEmails)) rec.blockedEmails = [];
    if (!rec.blockedEmails.includes(email)) rec.blockedEmails.push(email);
  }
  await saveDeviceRecords(all);
  scheduleBackup('device-records.json');
  await logActivity({ at: now, mode: 'device-strike', email, deviceId: fp.deviceId || '', model: fp.model || '', ip: fp.ip || '', strikes, level, blocked, reason });
  await addNotification('security', email, level === 4 ? '🚫 ឧបករណ៍ត្រូវបានប្លុក · Device blocked (strikes)' : '⚠️ បំពានច្បាប់គណនី · Device-limit violation', email + ' បានព្យាយាមចុះឈ្មោះគណនីលើសកំណត់ពីឧបករណ៍ ' + (fp.model || fp.deviceId || 'Unknown') + ' · IP ' + (fp.ip || '—') + ' · Strike ' + strikes + (blocked ? ' — ឧបករណ៍ត្រូវបានប្លុក' : ''));
  // Strike email to the user — Auto-Catch ON only. Never fails the
  // request if Brevo is down — the strike is already recorded.
  if (catchOn) {
    try {
      const ex = extra && typeof extra === 'object' ? extra : {};
      const msg = deviceStrikeEmail(level, reason, { email, name: ex.name || '', strikes, count: ex.count || 0, limit: ex.limit || DEVICE_FREE_ACCOUNT_LIMIT, model: fp.model || '', deviceId: fp.deviceId || '', ip: fp.ip || '' });
      await sendViaBrevo(email, '', msg.subject, msg.html, msg.text);
    } catch (e) {}
  }
  return { strikes, level, blocked };
}
// Device-limit gate for NEW account creation. Returns null when the
// registration may proceed, or the error payload when it must be refused.
// The limit is enforced ONLY when deviceLimitEnabled is ON (owner order
// 2026-11-18 — default OFF, because the website is not working well
// yet); the setting is read fresh from disk on EVERY call, so an Admin
// change takes effect immediately. When ON, the free limit is the
// configured deviceLimit (default 3) + purchased slots. A standing
// block (strike 4 while Auto-Catch was ON) is still enforced even
// when the toggle is OFF — only the Admin lifts it (unblock-device).
// On refusal it records a strike (+ level email and block at strike 4
// only when Auto-Catch is ON). The refusal itself is the limit
// enforcement, so it applies whenever the limit toggle is ON.
async function deviceLimitGate(users, fp, email, name) {
  const count = deviceAccountsCount(users, fp);
  const got = await getDeviceRecord(fp, true);
  const rec = got.rec;
  const all = got.all;
  const slots = Math.floor(numOr(rec.slots, 0));
  const dl = await deviceLimitSetting(); // fresh from settings, every call
  const freeLimit = dl.limit;
  const limit = freeLimit + slots;
  // A blocked device cannot register at all.
  if (rec.blocked) {
    return { ok: false, error: 'ឧបករណ៍នេះត្រូវបានប្លុក — This device has been used before · VPN is not supported. សូមទាក់ទង Admin · Please contact the Admin', deviceBlocked: true, blockedReason: rec.blockedReason || 'device-blocked', deviceLimitReached: true, upgradePrice: DEVICE_SLOT_PRICE, deviceLimit: freeLimit, deviceAccounts: count, deviceSlots: slots };
  }
  // Device-limit toggle OFF: no limit enforcement at registration —
  // users can register many accounts.
  if (!dl.enabled) return null;
  if (count < limit) return null;
  // Over the limit: a violation — record a strike (+ level email and
  // block at 4 only when Auto-Catch is ON).
  const reason = (fp.vpn || rec.vpnDetected) ? 'vpn' : 'device-limit';
  const st = await recordDeviceStrike(all, got.key, rec, email, reason, fp, { name: name || '', count, limit: freeLimit });
  return { ok: false, error: 'ឧបករណ៍នេះត្រូវបានប្រើរួចហើយ — This device has been used before · VPN is not supported. ឧបករណ៍នេះបានចុះឈ្មោះគណនី ' + count + ' រួចហើយ (កំណត់ ' + freeLimit + ' ដោយឥតគិតថ្លៃ) — សូម Upgrade 1 Gmail = $' + DEVICE_SLOT_PRICE.toFixed(2) + ' · This device already registered ' + count + ' accounts (max ' + freeLimit + ' free) — please Upgrade, 1 Gmail = $' + DEVICE_SLOT_PRICE.toFixed(2), deviceLimitReached: true, upgradePrice: DEVICE_SLOT_PRICE, deviceLimit: freeLimit, deviceAccounts: count, deviceSlots: slots, strike: st.strikes, deviceBlocked: st.blocked };
}
// Scam / hacker detection — NOTIFY ONLY, never block (owner order
// 2026-11-18). When the system detects a scam or a hidden hacker, it
// notifies the Admin (bell + Telegram, via addNotification) AND the
// user (email), and the Admin reviews the Gmail manually and decides
// whether to block. The system only notifies; it never auto-blocks
// for scam/hacker detection. Separate from the device-limit strike
// system (which does block after 3+ strikes, when Auto-Catch is ON).
function scamHackerEmail(ctx) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const email = (ctx && ctx.email) || '';
  const name = (ctx && ctx.name && String(ctx.name).trim()) || (email ? email.split('@')[0] : '') || 'អ្នកប្រើ MovAi';
  const kind = (ctx && ctx.kind) || 'brute-force';
  const detail = (ctx && ctx.detail) || '';
  const model = (ctx && ctx.model) || 'Unknown';
  const ip = (ctx && ctx.ip) || '';
  const detectedKm = kind === 'brute-force'
    ? 'មានអ្នកព្យាយាមចូលគណនីរបស់អ្នក ដោយបញ្ចូល Password ខុស 5 ដងជាប់គ្នា។'
    : 'ប្រព័ន្ធបានរកឃើញសកម្មភាពគួរឲ្យសង្ស័យនៅលើគណនីរបស់អ្នក។';
  const detectedEn = kind === 'brute-force'
    ? 'Someone tried to sign in to your account by entering the wrong password 5 times in a row.'
    : 'Our system detected suspicious activity on your account.';
  const KM = {
    teamTag: 'ក្រុមសុវត្ថិភាព', greet: 'សួស្តី',
    title: 'រកឃើញសកម្មភាពគួរឲ្យសង្ស័យ', sub: 'SCAM / HACKER DETECTED',
    banner: 'យើងបានរកឃើញសកម្មភាពគួរឲ្យសង្ស័យនៅលើគណនីរបស់អ្នក។ សូមកុំភ័យ — គណនីរបស់អ្នកមិនទាន់ត្រូវបានប្លុកទេ ហើយអ្នកនៅអាចប្រើប្រាស់បានធម្មតា។',
    detected: detectedKm,
    notBlocked: 'គណនីរបស់អ្នកមិនទាន់ត្រូវបានប្លុកទេ — អ្នកនៅអាចប្រើប្រាស់បានធម្មតា។',
    review: 'Admin របស់ MovAi នឹងពិនិត្យគណនី Gmail របស់អ្នកដោយផ្ទាល់ ដើម្បីផ្ទៀងផ្ទាត់ថាតើវាពិតជាមានបញ្ហាមែនឬអត់។ បើ Admin រកឃើញថាពិតជាមានបញ្ហា ទើប Admin សម្រេចថាត្រូវប្លុកឬអត់។',
    adviceTitle: 'សូមធ្វើដូចខាងក្រោម',
    advice: [
      'បើអ្នកមិនមែនជាអ្នកព្យាយាមចូលនោះទេ សូមដូរ Password របស់អ្នកភ្លាម។',
      'ពិនិត្យទូរស័ព្ទរបស់អ្នករក App ស្កេម ឬ App ដែលមិនស្គាល់ប្រភព ហើយលុបវាចោល។',
      'សូមកុំចែករំលែកលេខកូដ OTP ឬ Password របស់អ្នកទៅអ្នកណាម្នាក់ — MovAi មិនដែលសុំវាទេ។',
    ],
    account: 'គណនី', device: 'ទូរស័ព្ទ (Device)',
    contactTitle: 'ត្រូវការជំនួយ? ទាក់ទង Admin',
    contactSub: 'បើអ្នកគិតថានេះជាកំហុស ឬត្រូវការជំនួយ សូមទាក់ទងមកយើង៖',
    phone: 'លេខទូរស័ព្ទ · Phone',
    thanks: 'សូមអរគុណដែលបានយល់ និងសហការ។', team: '— ក្រុមសុវត្ថិភាព MovAi',
    foot: 'សារនេះត្រូវបានផ្ញើដោយស្វ័យប្រវត្តិពីប្រព័ន្ធសុវត្ថិភាព MovAi — សូមកុំចែករំលែកលេខកូដ ឬ Password របស់អ្នកទៅអ្នកណាម្នាក់។',
    rights: '© 2026 MovAi · រក្សាសិទ្ធិគ្រប់យ៉ាង',
  };
  const EN = {
    teamTag: 'Security Team', greet: 'Hello',
    title: 'Suspicious activity detected', sub: 'SCAM / HACKER DETECTED',
    banner: 'We detected suspicious activity on your account. Do not worry — your account has NOT been blocked, and you can still use it normally.',
    detected: detectedEn,
    notBlocked: 'Your account has NOT been blocked — you can still use it normally.',
    review: 'The MovAi Admin will manually review your Gmail account to verify whether it really has a problem. Only if the Admin finds a real problem will the Admin decide whether to block it.',
    adviceTitle: 'Please do the following',
    advice: [
      'If it was not you trying to sign in, change your password right away.',
      'Check your phone for scam apps or apps from unknown sources, and delete them.',
      'Never share your OTP code or password with anyone — MovAi never asks for them.',
    ],
    account: 'Account', device: 'Device',
    contactTitle: 'Need help? Contact Admin',
    contactSub: 'If you think this is a mistake, or you need help, contact us:',
    phone: 'Phone',
    thanks: 'Thank you for understanding and cooperating.', team: '— MovAi Security Team',
    foot: 'This email was sent automatically by the MovAi security system — never share your codes or password with anyone.',
    rights: '© 2026 MovAi · All rights reserved',
  };
  function langHtml(B) {
    let adv = '';
    for (const a of B.advice) adv += '<div style="background:#151a12;border:1px solid #2b3324;border-radius:12px;padding:11px 14px;margin-bottom:9px;">• ' + a + '</div>';
    return '<div style="max-width:560px;margin:0 auto;padding:26px 22px 0;background:#0c0f0a;color:#eef3e2;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;">'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:27px;font-weight:700;color:#ffffff;">Mov<span style="color:#a3e635;">Ai</span></td><td align="right" style="font-size:11px;font-weight:700;letter-spacing:2px;color:#a7b198;text-transform:uppercase;">Security Team<br><span style="color:#a3e635;letter-spacing:0;text-transform:none;font-size:13px;">' + B.teamTag + '</span></td></tr></table>'
      + '<div style="border-bottom:1px solid #2b3324;margin-bottom:20px;"></div>'
      + '<div style="border:1px solid #57501f;border-radius:14px;background:#241f0e;padding:18px;">'
      + '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="58" valign="top"><div style="width:46px;height:46px;border-radius:12px;background:#422006;text-align:center;line-height:46px;font-size:24px;color:#facc15;">⚠</div></td><td valign="top"><div style="font-size:21px;font-weight:700;">' + B.title + '</div><div style="font-size:13px;letter-spacing:2px;color:#facc15;font-weight:700;">' + B.sub + '</div></td></tr></table>'
      + '<p style="margin:10px 0 0;color:#a7b198;font-size:14px;">' + B.banner + '</p>'
      + '</div>'
      + '<p style="margin-top:20px;">' + B.greet + ' <b>' + esc(name) + '</b>,</p>'
      + '<p>' + B.detected + (detail ? ' ' + esc(detail) : '') + '</p>'
      + '<div style="background:#151a12;border:1px solid #2b3324;border-radius:12px;padding:6px 16px;">'
      + '<div style="padding:9px 0;border-bottom:1px dashed #2b3324;"><span style="color:#a7b198;font-weight:600;font-size:14px;">' + B.account + ': </span><span style="font-weight:600;">' + esc(name) + ' · ' + esc(email) + '</span></div>'
      + '<div style="padding:9px 0;"><span style="color:#a7b198;font-weight:600;font-size:14px;">' + B.device + ': </span><span style="font-weight:600;">' + esc(model) + (ip ? ' · IP ' + esc(ip) : '') + '</span></div>'
      + '</div>'
      + '<div style="background:#101c13;border:1px solid #2f5238;border-radius:12px;padding:12px 14px;margin:14px 0;"><b style="color:#4ade80;">✓ ' + B.notBlocked + '</b></div>'
      + '<p>' + B.review + '</p>'
      + '<h2 style="font-size:17px;font-weight:700;margin:26px 0 10px;">' + B.adviceTitle + '</h2>'
      + adv
      + '<div style="margin-top:26px;background:#1a2015;border:1px solid #2b3324;border-radius:14px;padding:16px 18px;">'
      + '<h2 style="font-size:17px;font-weight:700;margin:0 0 2px;">' + B.contactTitle + '</h2>'
      + '<p style="color:#a7b198;margin:0 0 8px;font-size:14px;">' + B.contactSub + '</p>'
      + '<a href="tel:+85581914728" style="display:block;color:#eef3e2;text-decoration:none;background:#151a12;border:1px solid #2b3324;border-radius:10px;padding:10px 14px;margin-bottom:10px;"><span style="color:#a7b198;font-size:13px;display:block;">' + B.phone + '</span><b>081 914 728</b></a>'
      + '<a href="mailto:sokhoeun356@gmail.com" style="display:block;color:#eef3e2;text-decoration:none;background:#151a12;border:1px solid #2b3324;border-radius:10px;padding:10px 14px;margin-bottom:10px;"><span style="color:#a7b198;font-size:13px;display:block;">Gmail</span><b>sokhoeun356@gmail.com</b></a>'
      + '<a href="https://t.me/yemsokhoeun_9999" style="display:block;color:#eef3e2;text-decoration:none;background:#151a12;border:1px solid #2b3324;border-radius:10px;padding:10px 14px;"><span style="color:#a7b198;font-size:13px;display:block;">Telegram</span><b>@yemsokhoeun_9999</b></a>'
      + '</div>'
      + '<p style="margin-top:24px;margin-bottom:2px;">' + B.thanks + '</p>'
      + '<p style="font-weight:700;margin-top:0;">' + B.team + '</p>'
      + '<div style="margin:22px -22px 0;padding:16px 22px 20px;border-top:1px solid #2b3324;color:#a7b198;font-size:13px;text-align:center;"><div style="font-size:17px;font-weight:700;color:#ffffff;">Mov<span style="color:#a3e635;">Ai</span></div><p style="margin:6px 0 0;">' + B.foot + '<br>' + B.rights + '</p></div>'
      + '</div>';
  }
  function langText(B) {
    const lines = [];
    lines.push('MovAi — ' + B.teamTag, '');
    lines.push(B.title + ' · ' + B.sub, B.banner, '');
    lines.push(B.greet + ' ' + name + ',', B.detected + (detail ? ' ' + detail : ''), '');
    lines.push('• ' + B.account + ': ' + name + ' · ' + email);
    lines.push('• ' + B.device + ': ' + model + (ip ? ' · IP ' + ip : ''));
    lines.push('', '✓ ' + B.notBlocked, '', B.review, '');
    lines.push(B.adviceTitle);
    for (const a of B.advice) lines.push('• ' + a);
    lines.push('');
    lines.push(B.contactTitle, B.contactSub);
    lines.push('• ' + B.phone + ': 081 914 728');
    lines.push('• Gmail: sokhoeun356@gmail.com');
    lines.push('• Telegram: @yemsokhoeun_9999');
    lines.push('', B.thanks, B.team, '', B.foot, B.rights, '');
    return lines.join('\n');
  }
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#0c0f0a;font-family:Arial,Helvetica,sans-serif;color:#eef3e2;">'
    + langHtml(KM)
    + '<div style="max-width:560px;margin:0 auto;padding:14px 22px;text-align:center;color:#a7b198;font-size:13px;">— English version below · ខាងក្រោមជាភាសាអង់គ្លេស —</div>'
    + langHtml(EN)
    + '</body></html>';
  const text = langText(KM) + '\n' + langText(EN);
  return { subject: 'MovAi — ⚠️ រកឃើញសកម្មភាពគួរឲ្យសង្ស័យ · Suspicious activity detected', html, text };
}
// Notify Admin + user about a detected scam/hacker. NEVER blocks.
// Fire-and-forget: callers use .catch(() => {}) and never await it
// in the response path.
async function reportScamHacker(o) {
  const email = (o && o.email) || '';
  if (!email) return;
  const name = (o && o.name) || '';
  const kind = (o && o.kind) || 'brute-force';
  const model = (o && o.model) || '';
  const ip = (o && o.ip) || '';
  const detail = (o && o.detail) || '';
  const now = new Date().toISOString();
  await logActivity({ at: now, mode: 'scam-hacker-alert', email, deviceId: (o && o.deviceId) || '', model, ip, kind, detail });
  // Admin: bell + Telegram (security kind). The Admin reviews the
  // Gmail manually and decides whether to block.
  await addNotification('security', email, '🕵️ រកឃើញ Scam / Hacker · Scam or hacker detected', email + ' — ' + (kind === 'brute-force' ? 'មានអ្នកព្យាយាមចូលគណនី ដោយបញ្ចូល Password ខុស 5 ដងជាប់គ្នា' : 'រកឃើញសកម្មភាពគួរឲ្យសង្ស័យ') + ' · ' + (model || 'Unknown') + ' · IP ' + (ip || '—') + ' — គណនីមិនទាន់ត្រូវបានប្លុកទេ សូម Admin ពិនិត្យដោយផ្ទាល់');
  // User: email (bilingual). Never fails the request if Brevo is down.
  try {
    const msg = scamHackerEmail({ email, name, kind, detail, model, ip });
    await sendViaBrevo(email, '', msg.subject, msg.html, msg.text);
  } catch (e) {}
}
// ---- MVSEP separation cache (fast re-split) ----
// audioUrl sha256 -> {hash, savedAt}. When the same song is split again
// (re-tap, reopen, another device), the server first asks MVSEP for the
// OLD job's fresh stem URLs instead of creating (and paying quota for) a
// new separation — re-splits return in ~1-2s instead of ~2 min. The
// status check is the source of truth for fresh URLs (MVSEP download
// links may expire); any failure falls through to a fresh separation.
// Entries expire after 7 days; capped at 500 songs (oldest evicted).
// Persisted to mvsep-cache.json (GitHub-backed) so it survives restarts.
const MVSEP_CACHE_FILE = path.join(DATA_DIR, 'mvsep-cache.json');
const MVSEP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MVSEP_CACHE_MAX = 500;
let _mvsepCache = null;
async function mvsepCacheLoad() {
  if (_mvsepCache && typeof _mvsepCache === 'object') return _mvsepCache;
    const j = await loadKvDoc('mvsep-cache', null);
    if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') { _mvsepCache = j; return _mvsepCache; }
    _mvsepCache = { entries: {} };
    return _mvsepCache;
}
async function mvsepCacheSave() {
  try { await saveKvDoc('mvsep-cache', _mvsepCache, 'mvsep-cache.json'); } catch (e) {}
}
function mvsepCacheKey(audioUrl) {
  return crypto.createHash('sha256').update(String(audioUrl)).digest('hex');
}
async function mvsepCacheGet(audioUrl) {
  try {
    const c = await mvsepCacheLoad();
    const e = c.entries[mvsepCacheKey(audioUrl)];
    if (!e || typeof e.hash !== 'string' || !e.hash) return '';
    if (!e.savedAt || (Date.now() - Number(e.savedAt)) > MVSEP_CACHE_TTL_MS) return '';
    return e.hash;
  } catch (err) { return ''; }
}
async function mvsepCachePut(audioUrl, hash) {
  try {
    if (!hash) return;
    const c = await mvsepCacheLoad();
    c.entries[mvsepCacheKey(audioUrl)] = { hash, savedAt: Date.now() };
    const keys = Object.keys(c.entries);
    if (keys.length > MVSEP_CACHE_MAX) {
      keys.sort((a, b) => (c.entries[a].savedAt || 0) - (c.entries[b].savedAt || 0));
      for (let i = 0; i < keys.length - MVSEP_CACHE_MAX; i++) delete c.entries[keys[i]];
    }
    await mvsepCacheSave();
  } catch (err) {}
}
// ---- MVSEP stem separation (Demucs4 HT) ----
// ---- MVSEP in-flight registry (mvsep-pending) ----
// MVSEP has NO cancel/delete endpoint (official full API: only create +
// get + types + history — verified 2026-11-19). A job keeps its
// per-account single-job slot until MVSEP itself finishes (done) or
// fails it. So our side can never force-free the slot — but it MUST NOT
// make things worse: before this registry, a re-tap after a timeout
// created a BRAND-NEW separation on the next key (the timed-out job was
// never recorded), so one stuck song fanned duplicate jobs across ALL
// 11 keys and blocked every queue (2026-11-19 12:37 UTC). The registry
// records every created hash (persisted to mvsep-pending.json,
// GitHub-backed, so it survives restarts) so:
//  - a re-POST for the same song resumes the SAME hash (no duplicate
//    job, no extra quota);
//  - Cancel marks the hash cancelled, so the status endpoint stops
//    reporting it as processing and a later re-tap can start fresh;
//  - entries older than MVSEP_PENDING_MAX_AGE_MS are treated as dead
//    (MVSEP's own queue has had ample time) and a re-tap starts fresh.
// Cancelling here stops OUR side only — MVSEP's slot frees when MVSEP
// finishes/fails that job. The client message says so plainly.
const MVSEP_PENDING_FILE = path.join(DATA_DIR, 'mvsep-pending.json');
const MVSEP_PENDING_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — a normal split finishes in ~2 min; 4-min server poll + 10-min client resume = 14 min max our-side wait
const MVSEP_PENDING_MAX = 200;
let _mvsepPending = null;
async function mvsepPendingLoad() {
  if (_mvsepPending && typeof _mvsepPending === 'object') return _mvsepPending;
  const j = await loadKvDoc('mvsep-pending', null);
  if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') { _mvsepPending = j; return _mvsepPending; }
  _mvsepPending = { entries: {} };
  return _mvsepPending;
}
async function mvsepPendingSave() {
  try { await saveKvDoc('mvsep-pending', _mvsepPending, 'mvsep-pending.json'); } catch (e) {}
}
function mvsepPendingPrune(c) {
  // Drop entries older than MAX_AGE (dead jobs) and cap the size.
  const now = Date.now();
  let changed = false;
  for (const h of Object.keys(c.entries)) {
    const e = c.entries[h];
    if (!e || typeof e !== 'object' || !e.createdAt || (now - Number(e.createdAt)) > MVSEP_PENDING_MAX_AGE_MS) { delete c.entries[h]; changed = true; }
  }
  const keys = Object.keys(c.entries);
  if (keys.length > MVSEP_PENDING_MAX) {
    keys.sort((a, b) => (c.entries[a].createdAt || 0) - (c.entries[b].createdAt || 0));
    for (let i = 0; i < keys.length - MVSEP_PENDING_MAX; i++) { delete c.entries[keys[i]]; changed = true; }
  }
  return changed;
}
async function mvsepPendingPut(audioUrl, hash) {
  try {
    if (!hash) return;
    const c = await mvsepPendingLoad();
    c.entries[hash] = { hash, audioUrl: String(audioUrl || ''), createdAt: Date.now(), status: 'processing' };
    mvsepPendingPrune(c);
    await mvsepPendingSave();
  } catch (e) {}
}
async function mvsepPendingGetByAudio(audioUrl) {
  // Live in-flight hash for this song, or '' — a cancelled or stale
  // (>30 min) entry is not live.
  try {
    const c = await mvsepPendingLoad();
    if (mvsepPendingPrune(c)) await mvsepPendingSave();
    const key = mvsepCacheKey(audioUrl);
    for (const h of Object.keys(c.entries)) {
      const e = c.entries[h];
      if (e && e.status === 'processing' && mvsepCacheKey(e.audioUrl || '') === key) return e.hash;
    }
    return '';
  } catch (e) { return ''; }
}
async function mvsepPendingGetByHash(hash) {
  try {
    const c = await mvsepPendingLoad();
    if (mvsepPendingPrune(c)) await mvsepPendingSave();
    const e = c.entries[hash];
    if (!e || typeof e !== 'object') return null;
    return e;
  } catch (e) { return null; }
}
async function mvsepPendingCancel(hash) {
  // Mark cancelled (kept, so the status endpoint can report it as
  // cancelled instead of processing). Returns true if it was live.
  try {
    if (!hash) return false;
    const c = await mvsepPendingLoad();
    const e = c.entries[hash];
    if (!e || typeof e !== 'object') return false;
    if (e.status === 'cancelled') return false;
    e.status = 'cancelled';
    e.cancelledAt = Date.now();
    await mvsepPendingSave();
    try { _mvsepHashAudio.delete(hash); _mvsepHashKey.delete(hash); } catch (err) {}
    return true;
  } catch (e) { return false; }
}
async function mvsepPendingRemove(hash) {
  try {
    if (!hash) return;
    const c = await mvsepPendingLoad();
    if (c.entries[hash]) { delete c.entries[hash]; await mvsepPendingSave(); }
  } catch (e) {}
}

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
const MVSEP_MODEL_OPT = 2; // htdemucs_6s — 6 stems: vocals, drums, bass, other, piano, guitar (owner asked for 6, not 4; 8 is not available in one MVSEP call)
const MVSEP_POLL_INTERVAL_MS = 5000; // 5s — detects a finished separation sooner (owner: split takes 2+ min, make it faster where possible)
const MVSEP_POLL_TIMEOUT_MS = 240000; // 4 min server-side; the Studio resumes longer jobs via /api/studio/separate/status
const MVSEP_STEM_ORDER = ['vocals', 'drums', 'bass', 'other', 'piano', 'guitar'];
// hash -> key value that created it (in-memory only; used to count a
// separation against the right key when it finishes via the status
// endpoint after a poll timeout).
const _mvsepHashKey = new Map();
// hash -> audioUrl that created it (in-memory only; lets the status
// endpoint cache a separation that finished via resume, so a later
// re-tap reuses the finished job instead of creating a duplicate one).
const _mvsepHashAudio = new Map();
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
  // MVSEP returns some errors as an `errors` array, e.g.
  // {"success":false,"errors":["You already have unprocessed file in queue. ..."]}
  if (Array.isArray(j.errors) && j.errors.length) return j.errors.filter((e) => typeof e === 'string' && e).join(' ');
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
  // A "limit" error means THIS key's daily quota is spent, so the
  // rotation tries the next key. NOTE: the per-account queue block
  // ("You already have unprocessed file in queue") is NOT a quota
  // error — it means the key's single concurrent-job slot is occupied
  // by a file still being processed, so it is detected separately by
  // mvsepIsQueueBusyText and reported as 'mvsep_busy' (retry soon),
  // never as a daily limit (retry tomorrow). Mislabeling it as a
  // daily limit told the owner all 11 keys were exhausted after only
  // 1 separation in a day (2026-11-19).
  return /limit|quota|exceed|daily|too many/i.test(String(s || ''));
}
function mvsepIsQueueBusyText(s) {
  // MVSEP's per-account single-job queue block: this account already
  // has a file waiting to be processed. Transient — the slot frees
  // when MVSEP finishes that file. NOT a daily quota.
  return /unprocessed file in queue/i.test(String(s || ''));
}
function mvsepQueueBusyErr(detail, httpStatus) {
  // Distinct code so the rotation still tries the next key AND the
  // endpoint can return 'mvsep_busy' (retry in minutes) instead of
  // 'mvsep_limit' (retry tomorrow). Message MUST NOT contain "quota"
  // or the endpoint's /quota exceeded/i check would mislabel it.
  const e = rotErr('MVSEP queue busy — unprocessed file in queue' + (detail ? ': ' + String(detail).slice(0, 120) : ''), httpStatus || 0);
  e.code = 'mvsep_queue_busy';
  return e;
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
  if (j && j.success === false && mvsepIsQueueBusyText(text)) throw mvsepQueueBusyErr(text, r.status);
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
  try { _mvsepHashKey.set(hash, keyValue); _mvsepHashAudio.set(hash, audioUrl); } catch (e) {}
  // Record the in-flight job so a re-tap resumes THIS hash instead of
  // creating a duplicate separation on another key.
  await mvsepPendingPut(audioUrl, hash);
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
  if (e.code === 'mvsep_queue_busy') return true; // queue busy: try the next key (it may have a free queue slot)
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
    candidates = await adminProviderKeyList(p);
  }
  if (!candidates.length) {
    const err = new Error('no key configured');
    err.noKey = true;
    throw err;
  }
  const start = _keyRotationStart.get(p) || 0;
  const n = candidates.length;
  let lastErr = null;
  const attempts = [];
  // Try-order: rotation order starting from the remembered start index.
  let order = [];
  for (let i = 0; i < n; i++) order.push((start + i) % n);
  // PROACTIVE MVSEP rotation (owner order 2026-11-18): when an MVSEP key
  // is NEARLY exhausted (few separations left today), jump to a fresh key
  // AT ONCE — do NOT wait until it is fully exhausted and the request
  // fails/gets stuck. The server's own daily counter (50/day/key) is the
  // source of truth. If EVERY key is nearly exhausted, keep them all so
  // the best available is still tried (failover on error still applies).
  if (p === 'mvsep') {
    const _rems = await Promise.all(order.map((idx) => mvsepKeyRemaining(idx)));
    const fresh = order.filter((idx, i) => {
      const rem = _rems[i];
      return rem === null || rem > MVSEP_NEAR_EXHAUST_REMAINING;
    });
    if (fresh.length) order = fresh;
  }
  for (let oi = 0; oi < order.length; oi++) {
    const idx = order[oi];
    const cand = candidates[idx];
    try {
      const out = await fn(cand.key, cand.endpoint);
      // FAILOVER (owner order 2026-11-18, reverting strict round-robin):
      // stick with ONE key — after a success keep using THIS key (do NOT
      // advance to the next). Only when this key fails with a rotatable
      // error does the loop try the next key, and the pointer then sticks
      // with that one. (Strict round-robin spread one stuck MVSEP job
      // across ALL keys; failover keeps the other keys clean as backups.
      // An exhausted key is retried when the rotation wraps back to it,
      // so it works again automatically after its quota resets.)
      _keyRotationStart.set(p, idx);
      await keyHealthSet(p, idx, 'ok', '');
      return out;
    } catch (e) {
      lastErr = e;
      // Diagnostic: record which key (by number only — NEVER the key
      // value) failed and why, so a multi-key failure can be diagnosed
      // without reading server logs.
      attempts.push({ key: idx + 1, http: (e && e.httpStatus) || 0, err: String((e && e.message) || e).slice(0, 160) });
      if (!_isRotatableError(e)) { lastErr.attempts = attempts; throw lastErr; }
      await keyHealthSet(p, idx, (e && e.code === 'mvsep_queue_busy') ? 'busy' : 'exhausted', String((e && e.message) || e).slice(0, 120));
      if (oi < order.length - 1) console.log('[keys] ' + p + ' key ' + (idx + 1) + '/' + n + ' failed (' + String((e && e.message) || e).slice(0, 120) + '), trying next key');
    }
  }
  if (lastErr) lastErr.attempts = attempts;
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
  magichour: ['z-image-turbo', 'flux-2-klein', 'flux-schnell', 'qwen-image-2.1', 'krea-2', 'gpt-image-2', 'nano-banana-2.1', 'nano-banana-pro', 'ltx-2.5', 'minimax-h3', 'kling-3.0', 'kling-4.0', 'veo-3.1', 'seedance-2.0', 'seedance-2.5'],
  musicapi: ['suno-v6'],
  tavus: [],
  acemusic: [],
  masterpiecex: [],
  hunyuan3d: [],
};
async function loadUpdates() {
  const j = await loadKvDoc('updates', null);
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
    const d = { knownModels: {}, approvedModels: {}, blockedModels: [], updates: [], settings: { autoApply: true, autoApplyHours: 24, checkIntervalHours: 6 }, lastCheckAt: null, lastCheckResult: '' };
    for (const p of Object.keys(UPDATES_SEED_MODELS)) { d.approvedModels[p] = UPDATES_SEED_MODELS[p].slice(); d.knownModels[p] = UPDATES_SEED_MODELS[p].slice(); }
    return d;
}
async function saveUpdates(u) {
  await saveKvDoc('updates', u, 'updates.json');
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
      const list = await adminProviderKeyList('suno');
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
  const u = await loadUpdates();
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
      await addNotification('update', '', '🆕 Model ថ្មី · ' + p + ' — ' + id, 'Provider ' + p + ' មាន model ថ្មី៖ ' + id + '។ សូម Approve ឬដាក់ "មិនចាំបាច់ Update" ក្នុង Admin → Auto Update។ បើមិនឆ្លើយក្នុង ' + u.settings.autoApplyHours + ' ម៉ោង ហើយ Auto-Apply បើក វានឹង Update ដោយខ្លួនឯង។');
    }
  }
  u.lastCheckAt = new Date().toISOString();
  u.lastCheckResult = added ? ('រកឃើញ model ថ្មី ' + added) : 'មិនមាន model ថ្មីទេ';
  await saveUpdates(u);
  scheduleBackup('updates.json');
  return added;
}
// Apply one update (add the model to the approved list shown on the
// website). decidedBy: 'admin' or 'auto'.
async function autoUpdateApplyUpdate(rec, decidedBy) {
  const u = await loadUpdates();
  const r = u.updates.find((x) => x.id === rec.id);
  if (!r || r.status !== 'pending') return false;
  if (!Array.isArray(u.approvedModels[r.provider])) u.approvedModels[r.provider] = [];
  if (!u.approvedModels[r.provider].includes(r.model)) u.approvedModels[r.provider].push(r.model);
  r.status = decidedBy === 'auto' ? 'auto-applied' : 'approved';
  r.decidedAt = new Date().toISOString();
  r.decidedBy = decidedBy;
  await saveUpdates(u);
  scheduleBackup('updates.json');
  const who = decidedBy === 'auto' ? 'ប្រព័ន្ធ Auto-Apply' : 'Admin';
  await addNotification('update', '', '✅ Model ថ្មីបាន Update · ' + r.provider + ' — ' + r.model, who + ' បានអនុម័ត model ថ្មី៖ ' + r.model + '។ វាបង្ហាញក្នុង website ហើយ (New)។');
  return true;
}
// Hourly sweep: auto-apply pending updates older than autoApplyHours
// (when Auto-Apply is ON), then run a model check when due.
async function autoUpdateSweep() {
  try {
    const u = await loadUpdates();
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
async function ipRateCheck(req, opts) {
  const ip = getClientIp(req);
  if (!ip) return { ok: true };
  if ((await loadBlockedIps()).some((b) => b === ip)) return { ok: false, blocked: true };
  const lockMs = await adminLockoutRemainingMs(ip);
  if (lockMs > 0) return { ok: false, blocked: true, lockoutMs: lockMs };
  // My Voice setup (v2.1.39, owner 2026-11-20 09:34): /api/voice/* is a
  // rare, logged-in, multi-step flow (upload -> validate -> poll ->
  // generate -> poll). A 429 mid-flow strands the user: Step 2 never
  // appears and Save stays greyed with no way forward. Skip the
  // per-minute counting for voice paths only — blocked IPs and the
  // admin lockout above still apply, and Suno itself rate-limits the
  // voice calls. (The owner's mobile IP is shared/CGNAT, so 120/min
  // is tripped by normal use + the app's own polling.)
  if (opts && opts.skipCount) return { ok: true };
  const now = Date.now();
  let rec = _ipRate.get(ip);
  if (!rec || (now - rec.windowStart) >= IP_WINDOW_MS) { rec = { count: 0, windowStart: now }; _ipRate.set(ip, rec); }
  rec.count += 1;
  if (rec.count > IP_BLOCK_PER_MIN) {
    _ipRate.delete(ip);
    const blocked = await loadBlockedIps();
    if (!blocked.some((b) => b === ip)) {
      blocked.push(ip);
      await saveBlockedIps(blocked);
      scheduleBackup('blocked-ips.json');
      await addNotification('security', '', '🚫 វាយប្រហារ · Auto-blocked attack', 'IP ' + ip + ' request ' + rec.count + ' ដងក្នុង 1 នាទី (spam/DDoS) — ត្រូវបានប្លុកដោយអូតូ');
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
async function genBlockedCheck(email, req) {
  try {
    const em = normEmail(email);
    if (em && (await loadBlockedEmails()).some((b) => b === em)) return 'គណនីនេះត្រូវបានប្លុក · This account is blocked';
    const ip = getClientIp(req);
    if (ip && (await loadBlockedIps()).some((b) => b === ip)) return 'គណនីនេះត្រូវបានប្លុក · This account is blocked';
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
const SUNO_CALLBACK_URL = process.env.SUNO_CALLBACK_URL || 'https://movai-proxy-dphl.onrender.com/api/suno/callback';
// Latest callback result per taskId: {status, songs, preview, updatedAt}.
// In-memory only (a restart loses it — the status handler then falls
// back to polling record-info, so nothing breaks).
const sunoCallbacks = new Map();
// v2.2.58 Instant Playback (streaming): per-song streaming state per
// taskId, driven by the Suno webhook through 3 stages — TEXT_SUCCESS
// (lyrics ready, no audio), FIRST_SUCCESS (stream_audio_url live),
// SUCCESS (final audio_url) — then the server saves each song to
// permanent Cloudinary storage in the background. Per-song status:
// 'generating' | 'streaming' | 'saving' | 'ready' | 'failed'.
// In-memory for speed; mirrored to Supabase kv_docs ('suno-stream:<id>')
// so the status endpoint can recover it after a restart.
const sunoStreamState = new Map();
const sunoRecInfoCache = new Map(); // taskId -> {at, out} (12s throttle)
function sunoStreamKey(taskId) { return 'suno-stream:' + taskId; }
// Per-song stream/audio URLs straight from a Suno payload (callback or
// record-info). Unlike sunoSongsFromData this keeps stream_audio_url and
// audio_url SEPARATE — the stream URL is for live listening only and
// must never be saved as the final file.
function sunoStreamSongsFromData(d) {
  const resp = (d && d.response) || {};
  const arr = Array.isArray(resp.sunoData) ? resp.sunoData : (Array.isArray(d && d.sunoData) ? d.sunoData : []);
  const taskId = typeof (d && d.taskId) === 'string' ? d.taskId : (typeof resp.taskId === 'string' ? resp.taskId : '');
  return arr.filter((c) => c && ((typeof c.audio_url === 'string' && c.audio_url) || (typeof c.stream_audio_url === 'string' && c.stream_audio_url))).map((c) => ({
    audioId: typeof c.id === 'string' ? c.id : (typeof c.audioId === 'string' ? c.audioId : ''),
    title: typeof c.title === 'string' ? c.title : '',
    image: typeof c.image_url === 'string' ? c.image_url : '',
    duration: typeof c.duration === 'number' ? c.duration : 0,
    streamAudioUrl: typeof c.stream_audio_url === 'string' ? c.stream_audio_url : '',
    audioUrl: typeof c.audio_url === 'string' ? c.audio_url : '',
    taskId,
  }));
}
function sunoStreamLyricsFromData(d) {
  const resp = (d && d.response) || {};
  const arr = Array.isArray(resp.sunoData) ? resp.sunoData : (Array.isArray(d && d.sunoData) ? d.sunoData : []);
  for (const c of arr) {
    if (c && typeof c.lyric === 'string' && c.lyric) return c.lyric;
    if (c && typeof c.lyrics === 'string' && c.lyrics) return c.lyrics;
  }
  if (typeof d.lyric === 'string' && d.lyric) return d.lyric;
  if (typeof d.lyrics === 'string' && d.lyrics) return d.lyrics;
  if (typeof resp.lyric === 'string' && resp.lyric) return resp.lyric;
  return '';
}
// Merge a Suno payload into the streaming state. Returns {state, changed}.
// Duplicate callbacks for the same taskId + Suno status are ignored
// (changed=false) — the clip-level merge only adds what is new.
function sunoStreamMerge(taskId, d, sunoStatus) {
  var st = sunoStreamState.get(taskId);
  if (!st) { st = { taskId, status: 'generating', lyrics: '', songs: [], updatedAt: Date.now(), saveStarted: false, lastCbStatus: '' }; sunoStreamState.set(taskId, st); }
  var changed = false;
  var clips = sunoStreamSongsFromData(d);
  var lyric = sunoStreamLyricsFromData(d);
  if (lyric && st.lyrics !== lyric) { st.lyrics = lyric; changed = true; }
  function findClip(c) {
    for (var i = 0; i < st.songs.length; i++) {
      var s = st.songs[i];
      if (s.audioId && c.audioId && s.audioId === c.audioId) return s;
      if (!s.audioId && !c.audioId && s.title && c.title && s.title === c.title) return s;
    }
    return null;
  }
  if (sunoStatus === 'TEXT_SUCCESS') {
    if (st.status !== 'generating' || st.lastCbStatus !== 'TEXT_SUCCESS') { st.status = 'generating'; changed = true; }
  } else if (sunoStatus === 'FIRST_SUCCESS') {
    if (st.status !== 'streaming' || st.lastCbStatus !== 'FIRST_SUCCESS') { st.status = 'streaming'; changed = true; }
    clips.forEach(function(c) {
      var ex = findClip(c);
      if (!ex) { st.songs.push({ audioId: c.audioId, title: c.title, image: c.image, duration: c.duration, streamAudioUrl: c.streamAudioUrl, audioUrl: c.audioUrl, permanentMp3Url: '', status: 'streaming', taskId }); changed = true; }
      else {
        if (c.streamAudioUrl && ex.streamAudioUrl !== c.streamAudioUrl) { ex.streamAudioUrl = c.streamAudioUrl; changed = true; }
        if (c.audioUrl && ex.audioUrl !== c.audioUrl) { ex.audioUrl = c.audioUrl; changed = true; }
        if (ex.status !== 'streaming') { ex.status = 'streaming'; changed = true; }
      }
    });
  } else if (sunoStatus === 'SUCCESS') {
    if (st.status !== 'saving' && st.status !== 'ready') { st.status = 'saving'; changed = true; }
    clips.forEach(function(c) {
      var ex = findClip(c);
      if (!ex) { st.songs.push({ audioId: c.audioId, title: c.title, image: c.image, duration: c.duration, streamAudioUrl: c.streamAudioUrl, audioUrl: c.audioUrl, permanentMp3Url: '', status: 'saving', taskId }); changed = true; }
      else {
        if (c.audioUrl && ex.audioUrl !== c.audioUrl) { ex.audioUrl = c.audioUrl; changed = true; }
        if (c.streamAudioUrl && !ex.streamAudioUrl) { ex.streamAudioUrl = c.streamAudioUrl; changed = true; }
        if (ex.status === 'streaming' || ex.status === 'generating') { ex.status = 'saving'; changed = true; }
      }
    });
    if (!clips.length && !st.songs.length) { st.status = 'failed'; changed = true; }
  } else if (sunoStatus && sunoStatusIsFailed(sunoStatus)) {
    if (st.status !== 'failed') { st.status = 'failed'; st.songs.forEach(function(x) { x.status = 'failed'; }); changed = true; }
  }
  if (sunoStatus && st.lastCbStatus !== sunoStatus) { st.lastCbStatus = sunoStatus; changed = true; }
  st.updatedAt = Date.now();
  if (sunoStreamState.size > 200) { const k = sunoStreamState.keys().next().value; sunoStreamState.delete(k); }
  return { state: st, changed };
}
// Fire-and-forget mirror to Supabase kv_docs (never blocks a response).
function sunoStreamPersist(taskId) {
  try {
    var st = sunoStreamState.get(taskId);
    if (!st) return;
    var clean = { taskId: st.taskId, status: st.status, lyrics: st.lyrics || '', songs: st.songs.map(function(x) { return { audioId: x.audioId, title: x.title, image: x.image || '', duration: x.duration || 0, streamAudioUrl: x.streamAudioUrl || '', audioUrl: x.audioUrl || '', permanentMp3Url: x.permanentMp3Url || '', status: x.status, taskId: x.taskId }; }), updatedAt: st.updatedAt };
    saveKvDoc(sunoStreamKey(taskId), clean).catch(function() {});
  } catch (e) {}
}
// In-memory first, then kv_docs (restart recovery).
async function sunoStreamLoad(taskId) {
  var st = sunoStreamState.get(taskId);
  if (st) return st;
  try {
    var doc = await loadKvDoc(sunoStreamKey(taskId), null);
    if (doc && doc.taskId && Array.isArray(doc.songs)) {
      // v2.2.63 (S3): after a server restart NO save is running, so a
      // 'saving' doc must load with saveStarted=false — otherwise the
      // status endpoint never re-triggers the save and the task sits in
      // 'saving' forever. ('ready' stays true: nothing left to save.)
      st = { taskId: doc.taskId, status: doc.status || 'generating', lyrics: doc.lyrics || '', songs: doc.songs, updatedAt: doc.updatedAt || Date.now(), saveStarted: (doc.status === 'ready'), lastCbStatus: '' };
      sunoStreamState.set(taskId, st);
      return st;
    }
  } catch (e) {}
  return null;
}
// The status endpoint's songs array: url is the playable URL right now
// (permanent when ready, else the live stream, else the final audio).
// The stream URL is NEVER used for downloads — the client disables
// Download until songStatus is 'ready'.
function sunoStreamToSongs(state, preferFinal) {
  if (!state || !Array.isArray(state.songs)) return [];
  return state.songs.map(function(x) {
    // v2.2.63: for a FINISHED song the FINAL audio URL is the playable
    // one (the stream URL is only the live preview while generating).
    // When preferFinal is set (song is done), the status is reported
    // without the 'saving' block so Download is enabled — the download
    // flow stores the file permanently on demand, as before v2.2.58.
    var url = x.permanentMp3Url || (preferFinal ? (x.audioUrl || x.streamAudioUrl) : (x.streamAudioUrl || x.audioUrl)) || '';
    var st = x.status || state.status || '';
    if (preferFinal && !x.permanentMp3Url) st = '';
    return { url, title: x.title || '', image: x.image || '', duration: x.duration || 0, audioId: x.audioId || '', taskId: x.taskId || state.taskId || '', songStatus: st, streamAudioUrl: x.streamAudioUrl || '', audioUrl: x.audioUrl || '', permanentMp3Url: x.permanentMp3Url || '' };
  }).filter(function(x) { return !!x.url; });
}
function sunoApiModel(m) {
  const s = String(m || '').trim().toLowerCase();
  if (s === 'v6-wild' || s === 'v6_wild') return 'V6_WILD';
  if (s === 'v6-mini' || s === 'v6_mini') return 'V6_MINI';
  if (s === 'v5_5' || s === 'v5.5') return 'V5_5';
  return 'V6';
}
// sunoapi.org puts its error text in `msg` (genErrText does not read it).
function sunoErrText(j, fb) {
  if (j && typeof j.msg === 'string' && j.msg) return j.msg;
  return genErrText(j, fb);
}
// Cover rejection (2026-11-19, Cover + credit safety): Suno's
// copyright/dedup guard rejects a Suno-generated source with
// GENERATE_AUDIO_FAILED + errorCode 413. Detect it from any of the
// shapes sunoapi.org returns (body code 413, data.errorCode 413, or
// '413' in the message) so the caller can refund + show the
// plain-language message instead of a generic error. Only 413 evidence
// counts here — any other failure is a generic failure (still refunded).
function sunoCoverRejected(j) {
  if (!j || typeof j !== 'object') return false;
  if (j.code === 413) return true;
  const d = j.data;
  if (d && typeof d === 'object' && d.errorCode === 413) return true;
  const msg = String(j.msg || '');
  if (msg.indexOf('413') >= 0) return true;
  return false;
}
// v2.2.44: Suno's catalog guard — a known commercial recording in Suno's
// catalog cannot be covered ("This audio matches an existing recording in
// our catalog."). Non-rotatable (every key rejects the same audio).
function sunoCatalogRejected(j) {
  if (!j || typeof j !== 'object') return false;
  const hay = String(j.msg || '') + ' ' + String(j.error || '') + ' ' + String((j.data && (j.data.errorMessage || j.data.msg || j.data.error)) || '');
  return /existing recording in our catalog/i.test(hay);
}
// ---- My Voice (Suno voice clone) — owner order 2026-11-19 ----
// The voiceId lives ONLY on the server (u.myVoice) and is NEVER sent to
// the client (pubUser allowlist does not include it). The client only
// ever learns hasMyVoice (boolean) + the validation phrase.
// Setup is FREE (Suno voice endpoints are free); songs cost the normal
// 12 song credits via the normal gen flow.
// V6 support: the live V6 test (2026-11-19) was BLOCKED by a Suno
// song-generation outage — sunoapi.org returned «Provider ឈប់ដំណើរការ»
// for EVERY model (V6, V6-mini, V5.5, with and without My Voice), so V6
// voice_persona could NOT be proven. V5.5 is the model Suno documents
// for voice_persona, so My Voice defaults to 'v5_5' (confirmed) until
// the outage clears and a V6 live test proves V6 works — then set this
// back to 'v6'.
const MY_VOICE_MODEL = 'v5_5';
const MY_VOICE_LANGS = ['en', 'zh', 'es', 'fr', 'pt', 'de', 'ja', 'ko', 'hi', 'ru'];
function myVoiceGet(u) {
  if (!u || typeof u !== 'object') return null;
  const v = u.myVoice;
  if (!v || typeof v !== 'object') return null;
  return v;
}
async function myVoiceSave(email, patch) {
  const users = await loadUsers();
  const u = users[email];
  if (!u) return null;
  if (!u.myVoice || typeof u.myVoice !== 'object') u.myVoice = {};
  Object.assign(u.myVoice, patch);
  u.myVoice.updatedAt = new Date().toISOString();
  u.updatedAt = new Date().toISOString();
  await saveUsers(users);
  scheduleBackup('users.json');
  return u.myVoice;
}
async function myVoiceClear(email) {
  const users = await loadUsers();
  const u = users[email];
  if (!u) return false;
  delete u.myVoice;
  u.updatedAt = new Date().toISOString();
  await saveUsers(users);
  scheduleBackup('users.json');
  return true;
}
// Call a sunoapi.org voice endpoint with key rotation. GET when body is
// null. Returns the parsed JSON on code 200, else throws rotErr.
async function sunoVoiceCall(path, method, body) {
  const keys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
  if (!keys.length) throw new Error('Admin មិនទាន់ដាក់ Suno Key ទេ');
  return withProviderKeyRotation('suno', async (k, endpoint) => {
    const ep = String(endpoint || '').replace(/\/+$/, '');
    const r = await fetch(ep + path, { method, headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => null);
    if (j && j.code === 200) return j;
    throw rotErr('Suno Voice: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
  }, '', keys);
}
// Upload a voice audio buffer to Cloudinary (data URI) and return the
// plain secure_url (no attachment flag). Returns null if all accounts fail.
async function cloudinaryStoreVoice(buf, mime, name) {
  const candidates = await cloudinaryCandidates();
  if (!candidates.length) return null;
  const dataUri = 'data:' + mime + ';base64,' + buf.toString('base64');
  const pubId = 'movai/voices/' + String(name || 'voice').replace(/\.[^.]+$/, '');
  for (const a of candidates) {
    try {
      const c = cloudinaryConfigFor(a);
      if (!c) continue;
      const res = await c.uploader.upload(dataUri, { resource_type: 'video', public_id: pubId, overwrite: false });
      if (res && res.secure_url) return res.secure_url;
    } catch (e) { /* try next account */ }
  }
  return null;
}
// sunoapi.org credit endpoint: GET {endpoint}/api/v1/generate/credit
// answers {code:200, data:<remaining integer>}. The API returns ONLY
// the remaining balance — no total/used. Parse defensively.
function sunoCreditFrom(j) {
  if (typeof j === 'number' && isFinite(j)) return Math.floor(j);
  if (!j || typeof j !== 'object') return null;
  if (typeof j.data === 'number' && isFinite(j.data)) return Math.floor(j.data);
  if (j.data && typeof j.data === 'object') {
    if (typeof j.data.credits === 'number' && isFinite(j.data.credits)) return Math.floor(j.data.credits);
    if (typeof j.data.remaining === 'number' && isFinite(j.data.remaining)) return Math.floor(j.data.remaining);
    if (typeof j.data.balance === 'number' && isFinite(j.data.balance)) return Math.floor(j.data.balance);
  }
  if (typeof j.credits === 'number' && isFinite(j.credits)) return Math.floor(j.credits);
  if (typeof j.remaining === 'number' && isFinite(j.remaining)) return Math.floor(j.remaining);
  if (typeof j.balance === 'number' && isFinite(j.balance)) return Math.floor(j.balance);
  return null;
}
// v2.2.48: a Suno job status that means FAILED (not running, not done).
// Shared by the server-side cover auto-refund sweep and the Suno
// callback hook — one rule, one place. SUCCESS / FIRST_SUCCESS /
// PENDING / TEXT_SUCCESS are the only non-failed states the server
// treats as alive; anything else present is a failure.
function sunoStatusIsFailed(st) {
  if (!st || typeof st !== 'string') return false;
  const s = st.toUpperCase();
  return s !== 'SUCCESS' && s !== 'FIRST_SUCCESS' && s !== 'PENDING' && s !== 'TEXT_SUCCESS';
}
// v2.2.48: live Suno credit balance per stored Suno key (the same
// GET {endpoint}/api/v1/generate/credit call the Admin Suno card uses).
// Returns {totalRemaining, keys:[{key, remaining, status, message?}]}.
// Key VALUES are never returned (1-based indexes only). Shared by the
// admin endpoint and the website Profile endpoint below.
async function sunoBalanceAll() {
  const list = await adminProviderKeyList('suno');
  const keys = [];
  let totalRemaining = 0;
  for (let i = 0; i < list.length; i++) {
    const ep = (list[i].endpoint || '').replace(/\/+$/, '');
    if (!ep) { keys.push({ key: i + 1, remaining: null, status: 'unknown', message: 'មិនមាន gateway endpoint' }); continue; }
    try {
      const r = await fetch(ep + '/api/v1/generate/credit', { headers: { 'Authorization': 'Bearer ' + list[i].key }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => null);
      if (r.status === 401 || r.status === 403) { keys.push({ key: i + 1, remaining: null, status: 'blocked', message: 'Key មិនត្រឹមត្រូវ ឬត្រូវបានប្លុក (HTTP ' + r.status + ')' }); continue; }
      const rem = sunoCreditFrom(j);
      if (typeof rem === 'number') { keys.push({ key: i + 1, remaining: rem, status: rem > 0 ? 'green' : 'red' }); totalRemaining += rem; }
      else keys.push({ key: i + 1, remaining: null, status: 'error', message: 'Suno ឆ្លើយ HTTP ' + r.status });
    } catch (e) {
      keys.push({ key: i + 1, remaining: null, status: 'error', message: 'មិនអាចភ្ជាប់បាន — ' + String((e && e.message) || e).slice(0, 120) });
    }
  }
  return { totalRemaining, keys };
}
// v2.2.48: the Suno balance cached ~60s in memory so Profile refreshes
// (and several admins opening Profile at once) don't hammer sunoapi.org.
let sunoBalanceCache = { at: 0, data: null };
async function sunoBalanceCached() {
  const now = Date.now();
  if (sunoBalanceCache.data && now - sunoBalanceCache.at < 60 * 1000) return sunoBalanceCache.data;
  const data = await sunoBalanceAll();
  sunoBalanceCache = { at: now, data };
  return data;
}
// ---- Free image generations (owner order 2026-11-18) ----
// Every user gets 20 FREE image generations per DAY (owner order
// 2026-11-20 07:45 — Agnes Pro 10/day + NovAI 10/day combined, since
// NovAI is no longer used for generation; chat Image uses ONLY Agnes
// Pro agnes-image-2.5-flash), and 10 FREE thumbnails per 3-day window
// — SEPARATE counters. 0 MovAi credits; a COUNT cap, not a charge.
// Stored on the user record as imgFreeDaily:{start:'YYYY-MM-DD',
// used:N} (images, 1-day window) and thumbFree3:{start:'YYYY-MM-DD',
// used:N} (thumbnails, 3-day window); start is the Phnom Penh date
// the window began, and the window renews when today >= start +
// window days. A failed provider call refunds the slot. The old
// imgFree3 (images, 3-day) and imgDaily:{date, used} counters are
// still maintained for display/back-compat but are NOT enforced
// anymore for images.
const IMG_FREE_DAILY_LIMIT = 20; // images, per day (enforced)
const IMG_FREE_DAILY_DAYS = 1;
const THUMB_FREE_3DAY_LIMIT = 10; // thumbnails, per 3 days (enforced)
const IMG_FREE_3DAY_LIMIT = 10; // legacy alias (thumbnails); back-compat
const IMG_FREE_3DAY_DAYS = 3;
let _autoAgnesRot = 0; // auto-image rotation: next Agnes model to try first (v2.1.37)
function imgFreeTodayDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
}
function _free3DateAdd(dateStr, days) {
  const p = String(dateStr || '').split('-').map(Number);
  if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return imgFreeTodayDate();
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]) + days * 86400000);
  return d.toISOString().slice(0, 10);
}
// Normalize a stored {start, used} window against today.
// Returns {start, used, resetDate}; a window that already ended
// comes back fresh (start = today, used = 0). `days` is the window
// length in days (1 = daily, 3 = 3-day).
function _freeWindow(rec, days) {
  const today = imgFreeTodayDate();
  let start = (rec && typeof rec === 'object' && typeof rec.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.start)) ? rec.start : today;
  let used = (rec && typeof rec === 'object') ? Math.max(0, Math.floor(Number(rec.used) || 0)) : 0;
  if (today >= _free3DateAdd(start, days)) { start = today; used = 0; }
  return { start, used, resetDate: _free3DateAdd(start, days) };
}
// 3-day window (thumbnails). 1-day window (images).
function _free3Window(rec) { return _freeWindow(rec, IMG_FREE_3DAY_DAYS); }
function _freeDailyWindow(rec) { return _freeWindow(rec, IMG_FREE_DAILY_DAYS); }
// Give one free-image/thumbnail slot back (provider call failed
// before any image was produced). Never lets the count go below 0.
// isThumbnail=true refunds the thumbnail counter, else the image one;
// the legacy daily counter is refunded too.
async function imgFreeRefund(email, isThumbnail) {
  try {
    const em = normEmail(email);
    if (!em) return;
    const users = await loadUsers();
    const u = users[em];
    if (!u) return;
    const key = isThumbnail ? 'thumbFree3' : 'imgFreeDaily';
    const win = isThumbnail ? _free3Window(u[key]) : _freeDailyWindow(u[key]);
    if (win.used > 0) u[key] = { start: win.start, used: win.used - 1 };
    const today = imgFreeTodayDate();
    if (u.imgDaily && typeof u.imgDaily === 'object' && u.imgDaily.date === today) {
      const used = Math.max(0, Math.floor(Number(u.imgDaily.used) || 0));
      if (used > 0) u.imgDaily = { date: today, used: used - 1 };
    }
    users[em] = u;
    await saveUsers(users);
  } catch (e) {}
}
// Translate a non-English image prompt to English via Groq (free).
// The image models (NovAI cogview, Agnes) understand English far
// better than Khmer, so a Khmer prompt sent as-is renders a generic
// scene instead of the requested content (owner report 2026-11-18:
// "ទេសភាព ស្រស់ស្អាត មានមនុស្សអង្គុយយំ" came back a generic sad man
// with no crying). Only called when the prompt contains non-ASCII
// text; English prompts pass through untouched. Returns the English
// prompt, or null on any failure (the original prompt is then used
// — a failed translation never blocks the image).
async function translateImgPromptToEnglish(text) {
  const sys = 'You are an image-prompt translator. Translate the following image description to English as a vivid, detailed visual prompt for an image generator. Translate any non-English text; keep any English text exactly as it is. Preserve every subject, action, emotion, setting, style and detail exactly — do not add, remove or reinterpret anything. State the subject and action explicitly so the image shows the described scene, not a diagram, chart or text. Reply with ONLY the English description, no explanations, no quotes, no markdown.';
  try {
    const out = await withProviderKeyRotation('groq', async (k) => {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-oss-120b', temperature: 0.2, max_tokens: 600, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] }),
        signal: AbortSignal.timeout(20000)
      });
      const j = await r.json().catch(() => null);
      const c = j && j.choices && j.choices[0] && j.choices[0].message && typeof j.choices[0].message.content === 'string' ? j.choices[0].message.content.trim() : '';
      if (!c) throw rotErr('Groq translate: empty reply', r.status);
      return c;
    });
    return out;
  } catch (e) { return null; }
}
// Extract playable songs from a record-info / callback data object.
function sunoSongsFromData(d) {
  const resp = (d && d.response) || {};
  const arr = Array.isArray(resp.sunoData) ? resp.sunoData : (Array.isArray(d && d.sunoData) ? d.sunoData : []);
  // Suno track identity (2026-11-19, Cover): keep the taskId + audioId on
  // every NEW song so a future History-song cover can use the
  // taskId+audioId path. Old songs without IDs cannot use that path.
  const taskId = typeof (d && d.taskId) === 'string' ? d.taskId : (typeof resp.taskId === 'string' ? resp.taskId : '');
  return arr.filter((c) => c && ((typeof c.audio_url === 'string' && c.audio_url) || (typeof c.stream_audio_url === 'string' && c.stream_audio_url))).map((c) => ({
    url: (typeof c.audio_url === 'string' && c.audio_url) ? c.audio_url : c.stream_audio_url,
    title: typeof c.title === 'string' ? c.title : '',
    image: typeof c.image_url === 'string' ? c.image_url : '',
    duration: typeof c.duration === 'number' ? c.duration : 0,
    audioId: typeof c.id === 'string' ? c.id : (typeof c.audioId === 'string' ? c.audioId : ''),
    taskId,
  }));
}
// v2.2.58: keep clip 1's URL identical between the early (FIRST_SUCCESS)
// and final (SUCCESS) responses, so a song the user is already listening
// to doesn't restart when the final render swaps it in. Prefer audio_url
// when present; if only stream_audio_url existed early, keep using it
// for that clip in the final songs array too.
function sunoSongsKeepEarlyUrl(songs, firstSongs) {
  if (!Array.isArray(songs) || !songs.length) return songs;
  if (!Array.isArray(firstSongs) || !firstSongs.length) return songs;
  var f = firstSongs[0];
  if (!f || !f.url) return songs;
  var s0 = songs[0];
  if (!s0 || !s0.url) return songs;
  if (s0.url === f.url) return songs;
  var fid = f.audioId || '';
  var sid = s0.audioId || '';
  var same = false;
  if (fid && sid && fid === sid) same = true;
  else if (!fid && !sid) {
    var ft = (f.title || '').trim();
    var stt = (s0.title || '').trim();
    if (ft && stt && ft === stt) same = true;
  }
  if (same) songs[0] = Object.assign({}, s0, { url: f.url });
  return songs;
}
function sunoPreviewFromData(d) {
  const resp = (d && d.response) || {};
  const arr = Array.isArray(resp.sunoData) ? resp.sunoData : (Array.isArray(d && d.sunoData) ? d.sunoData : []);
  const first = arr.find((c) => c && (c.stream_audio_url || c.audio_url));
  return first ? (first.stream_audio_url || first.audio_url) : '';
}
let _healStarted = false; // startup song-URL heal runs once (see apiRoute top)
async function apiRoute(req, res, urlPath) {
  // One Cloudinary upload at a time (serialised through _cloudQueue).
  // MUST stay at the TOP of apiRoute: cloudinaryStoreSong is called from
  // early branches (cover-upload) that return before the old declaration
  // site (~line 8824) is reached — a `let` there is TDZ for those
  // requests ("Cannot access '_cloudQueue' before initialization").
  let _cloudQueue = Promise.resolve();
  // Startup heal (owner order 2026-11-18): once, on the first request
  // after (re)start, re-link dead Magic Hour / proxy-upload song URLs to
  // their Cloudinary copy when one exists. Fire-and-forget, never blocks.
  if (!_healStarted) { _healStarted = true; try { (async () => { try { await ghRestoreUploads(); } catch (e) {} try { await healDeadSongUrls(); } catch (e) {} })().catch(() => {}); } catch (e) {} }
  // Supabase is the single source of truth — there is no GitHub
  // resync any more: every read already sees the latest stored state.
  // GitHub only receives debounced backup snapshots (scheduleBackup).
  // Attack protection: count this IP's requests (all /api/* + /uploads/*).
  // A correct admin key is never rate-limited or blocked here (the admin
  // can never lock themselves out — see isAdminKeyRequest).
  if (!isAdminKeyRequest(req)) {
    const ipc = await ipRateCheck(req, { skipCount: urlPath.indexOf('/api/voice/') === 0 });
    if (!ipc.ok) {
      if (ipc.blocked) {
        const rem = ipc.lockoutMs || 0;
        const err = rem > 0 ? ('គណនីនេះត្រូវបានប្លុក ' + lockoutTextKm(rem) + 'ទៀត · This account is blocked for ' + lockoutTextEn(rem) + ' more') : 'គណនីនេះត្រូវបានប្លុក · This account is blocked';
        return sendJSON(res, 200, { ok: false, error: err });
      }
      if (ipc.rateLimited) { try { res.setHeader('Retry-After', String(ipc.retryAfter || 60)); } catch (e) {} return sendJSON(res, 429, { ok: false, error: 'Request ច្រើនពេក — សូមរង់ចាំ ' + (ipc.retryAfter || 60) + ' វិនាទី · Too many requests, please wait' }); }
    }
  }
  // ---- AI Auto Lyrics Generator (OpenRouter Free API) ----
  // POST /api/gen/lyrics — {email, title, language, voice} → {ok:true, lyrics, model, aiLyr}
  // The user only enters a Title; the AI writes complete lyrics
  // (the owner's template structure) in the requested language
  // (Khmer default). 0 MovAi credits — lyrics are free, but limited
  // to 2 FREE generations per user per day (Phnom Penh date; owner
  // order 2026-11-19 07:47). Packages do NOT change this limit.
  // Provider is GROQ (owner order 2026-11-19 07:47 — OpenRouter is
  // no longer used for lyrics; the stored OpenRouter keys stay in
  // Admin untouched). Groq writes longer output, so max_tokens is
  // 6000 and the prompt asks for the FULL song at once (4,750-6,000
  // characters), in the owner's exact section
  // order: [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Instrumental],
  // [Verse 2], [Bridge], [Final Chorus], [Outro].
  // MOOD/GENRE MATCHING (owner order 2026-11-19 08:09): the AI first
  // reads the title to determine its EMOTION and STYLE — sad, painful,
  // heartbroken, trauma; happy, joyful, celebratory; hiphop/rap;
  // traditional; or another style — and writes lyrics matching that
  // mood and genre, NEVER generic lyrics that would fit any song. The
  // mood words in the section labels (Sad Piano, Emotional, Sad Violin
  // Solo, Deep Emotional) are EXAMPLES for a sad song; the AI adapts
  // them to the title (happy → Bright Happy Piano / Joyful Vocal;
  // hiphop → Hip Hop Beat / Energetic Vocal; traditional → Traditional
  // Khmer Music). The 9-section ORDER stays exact.
  // FORMAT + MEANING RULES (owner order 2026-11-19 10:08 — the AI wrote
  // every lyric line numbered "1. ...", "2. ..." with a trailing comma,
  // and the lyrics did not make sense): the prompt now FORBIDS numbering
  // any lyric line and FORBIDS a trailing comma on any lyric line, and
  // requires the lyrics to MAKE SENSE — clear, natural, correct Khmer,
  // one coherent story/emotion, simple heartfelt language, no random
  // metaphors, never invent a word or force a rhyme that breaks the
  // meaning, and deep real emotion the listener must feel. A server-side
  // safety net (sanitizeLyricsText) strips a leading list number and a
  // trailing comma from lyric lines only ([Section] headers untouched)
  // if the model still emits them.
  // Vocal (Male/Female) follows the user's voice setting (body.voice:
  // 'male' | 'female' | 'random' — 'random' lets the AI pick the vocal
  // that fits the song). The Instrumental and the Bridge are NOT
  // fixed: the AI chooses them to fit the song's lyrics/meaning each
  // time. The Groq key stays server-side (admin-stored keys only);
  // it is NEVER sent to the frontend, never logged, never returned.
  // Models rotate (gpt-oss-120b first, then llama-3.3-70b-versatile)
  // and keys rotate via withProviderKeyRotation on rotatable errors.
  const GROQ_LYRICS_MODELS = [
    'openai/gpt-oss-120b',
    'llama-3.3-70b-versatile'
  ];
  const AI_LYRICS_DAILY_LIMIT = 2;
  // Give one AI-Lyrics free slot back (provider call failed before any
  // lyrics were produced). Never lets the count go below 0.
  async function aiLyrRefund(email) {
    try {
      const em = normEmail(email);
      if (!em) return;
      const users = await loadUsers();
      const u = users[em];
      if (!u) return;
      const today = imgFreeTodayDate();
      if (u.aiLyrDaily && typeof u.aiLyrDaily === 'object' && u.aiLyrDaily.date === today) {
        const used = Math.max(0, Math.floor(Number(u.aiLyrDaily.used) || 0));
        if (used > 0) u.aiLyrDaily = { date: today, used: used - 1 };
      }
      users[em] = u;
      await saveUsers(users);
    } catch (e) {}
  }
  // Safety net for AI Lyrics (owner order 2026-11-19 10:08): the model
  // sometimes numbers every lyric line ("1. ...", "2. ...") and ends
  // every line with a comma — real lyrics have neither, and Suno would
  // SING the numbers. Strip a leading list number and a trailing comma
  // from LYRIC lines only; [Section] header lines are left untouched.
  // Safe: it only removes a line-leading "N. "/"N) " (with a space after
  // the punctuation, so "3.5 stars" is NOT touched) and a single comma
  // at the very end of a line — it never changes a word.
  function sanitizeLyricsText(text) {
    if (typeof text !== 'string' || !text) return text;
    const NL = String.fromCharCode(10);
    const lines = text.split(NL);
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      // Section header like "[Intro – Sad Piano, Female Vocal]" — never touch.
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) continue;
      let out = lines[i];
      // Remove a leading list number: "1. text" / "1) text" / "10. text".
      out = out.replace(/^[ ]*[0-9]+[.)][ ]+/, '');
      out = out.replace(/^[ ]*[0-9]+[.)][ ]*$/, '');
      // Remove a trailing comma at the end of the line.
      out = out.replace(/,[ ]*$/, '');
      lines[i] = out;
    }
    return lines.join(NL);
  }
  if (req.method === 'POST' && urlPath === '/api/gen/lyrics') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        if (!body || typeof body.title !== 'string' || !body.title.trim()) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរចំណងជើងបទចម្រៀងជាមុនសិន · Please enter a song title first' });
        if (!normEmail(body.email)) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
        const title = body.title.trim().slice(0, 200);
        const lang = (typeof body.language === 'string' && body.language.trim()) ? body.language.trim().toLowerCase().slice(0, 10) : 'kh';
        const voice = (typeof body.voice === 'string' && /^(male|female|random)$/.test(body.voice.trim().toLowerCase())) ? body.voice.trim().toLowerCase() : 'random';
        const email = normEmail(body.email);
        // FREE 2/day (Phnom Penh date). Enforce WITHOUT calling the
        // provider; take the slot BEFORE the provider call; refund on
        // provider failure (aiLyrRefund). Packages do not change it.
        const users = await loadUsers();
        const u = users[email];
        if (!u) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
        const today = imgFreeTodayDate();
        const lyrUsed = (u.aiLyrDaily && typeof u.aiLyrDaily === 'object' && u.aiLyrDaily.date === today) ? Math.max(0, Math.floor(Number(u.aiLyrDaily.used) || 0)) : 0;
        if (lyrUsed >= AI_LYRICS_DAILY_LIMIT) return sendJSON(res, 200, { ok: false, error: 'AI Lyrics ឥតគិតថ្លៃអស់ហើយសម្រាប់ថ្ងៃនេះ — សាកម្ដងទៀតនៅថ្ងៃស្អែក · Free AI Lyrics used up for today — try again tomorrow', aiLyr: { limit: AI_LYRICS_DAILY_LIMIT, used: lyrUsed, left: 0 } });
        const keys = await adminProviderKeyList('groq');
        if (!keys.length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Groq Key ទេ · The Admin has not added a Groq key yet — please add a free key in Admin → API Keys → Groq (console.groq.com/keys)' });
        u.aiLyrDaily = { date: today, used: lyrUsed + 1 };
        users[email] = u;
        await saveUsers(users);
        const vocalLabel = voice === 'male' ? 'Male Vocal' : voice === 'female' ? 'Female Vocal' : 'Vocal';
        const sections = '[Intro – Sad Piano, ' + vocalLabel + ']\n[Verse 1]\n[Pre-Chorus]\n[Chorus – Emotional ' + vocalLabel + ']\n[Instrumental – Sad Violin Solo]\n[Verse 2]\n[Bridge – Deep Emotional Vocal]\n[Final Chorus – Powerful ' + vocalLabel + ']\n[Outro – Soft Piano Fade Out]';
        const sysPrompt = lang === 'kh'
          ? 'អ្នកជាអ្នកនិពន្ធបទចម្រៀងអាជីព។ សូមសរសេរអត្ថបទចម្រៀងពេញលេញ ដើម វែង ជាភាសាខ្មែរ សម្រាប់ចំណងជើងបទដែលបានផ្តល់ឱ្យ — សរសេរពេញមួយបទតែម្ដង អត្ថបទពេញត្រូវមាន 4,750-6,000 អក្សរ (វែងគ្រប់គ្រាន់សម្រាប់បទចម្រៀងពេញលេញ 4-5 នាទី)។' + (voice === 'random' ? ' សូមជ្រើសរើសសំឡេងប្រុស ឬស្រីសម្រាប់បទនេះ (មួយណាសមជាង) ហើយសរសេរសំឡេងនោះនៅក្នុងស្លាកផ្នែកសំឡេងទាំងអស់ ឱ្យស៊ីសង្វាក់គ្នា។' : '') + ' មុនពេលសរសេរ សូមអានចំណងជើងឱ្យបានច្បាស់ ហើយកំណត់អារម្មណ៍ និងស្ទាយរបស់បទនេះជាមុនសិន៖ បើចំណងជើងមានន័យកំសត់ ឈឺចាប់ បែកបាក់ ឬត្រាម៉ា — សរសេរអត្ថបទកំសត់ ឈឺចាប់ អារម្មណ៍ខ្លាំង; បើចំណងជើងមានន័យសប្បាយ រីករាយ អបអរ — សរសេរអត្ថបទសប្បាយ រីករាយ; បើចំណងជើងជាបទ hiphop/rap — សរសេរតាមស្ទាយ hiphop មានចង្វាក់ rap; បើចំណងជើងជាបទបុរាណខ្មែរ — សរសេរតាមស្ទាយបុរាណ; បើស្ទាយផ្សេង — សរសេរតាមស្ទាយនោះ។ កុំសរសេរអត្ថបទទូទៅដែលដាក់បានគ្រប់បទ — អត្ថបទត្រូវតែសមនឹងអារម្មណ៍ និងស្ទាយរបស់ចំណងជើង។' + ' រចនាសម្ព័ន្ធអត្ថបទត្រូវដូចខាងក្រោមតាមលំដាប់៖\n' + sections + '\nច្បាប់សំខាន់បំផុត (ត្រូវអនុវត្តដាច់ខាត)៖ (1) កុំដាក់លេខនៅមុខបន្ទាត់អត្ថបទចម្រៀងដាច់ខាត — កុំសរសេរ «1.», «2.», «3.» ឬលេខណាមួយនៅមុខបន្ទាត់ឡើយ។ សរសេរបន្ទាត់អត្ថបទនីមួយៗធម្មតា មួយបន្ទាត់បន្ទាប់ពីមួយបន្ទាត់ ដោយគ្មានលេខនៅមុខ។ (2) កុំដាក់សញ្ញាក្បៀស (,) នៅចុងបន្ទាត់អត្ថបទចម្រៀងដាច់ខាត — បន្ទាត់អត្ថបទត្រូវបញ្ចប់ដោយគ្មានក្បៀស។ (3) អត្ថបទត្រូវតែមានន័យច្បាស់ និងត្រឹមត្រូវជាភាសាខ្មែរ — បន្ទាត់នីមួយៗត្រូវតែជាភាសាខ្មែរធម្មជាតិ ច្បាស់លាស់ ដែលមនុស្សពិតនិយាយ និងច្រៀងបាន ន័យត្រឹមត្រូវ វេយ្យាករណ៍ត្រឹមត្រូវ គ្មានពាក្យឥតន័យ។ ត្រូវយល់អត្ថន័យរបស់ចំណងជើងជាមុនសិន រួចសរសេរអត្ថបទដែលសមនឹងអត្ថន័យនោះយ៉ាងពិតប្រាកដ។ (4) អត្ថបទត្រូវតែជារឿងមួយ និងអារម្មណ៍មួយពីដើមដល់ចប់ — បន្ទាត់នីមួយៗត្រូវតភ្ជាប់គ្នា កុំលោតពីរូបភាពមួយទៅរូបភាពមួយដោយឥតហេតុផល។ កុំប្រើពាក្យប្រៀបធៀបចម្លែក ឬរូបភាពដែលមិនសមនឹងអត្ថន័យរបស់បទ (កុំមានក្រពើ កុំមានឆ្កែក្នុងព្រៃ ឬរូបភាពដែលមិនពាក់ព័ន្ធ)។ (5) ប្រើភាសាខ្មែរសាមញ្ញ ធម្មជាតិ ចេញពីបេះដូង — បន្ទាត់ខ្លីៗ ន័យច្បាស់ អារម្មណ៍ពិត។ កុំព្យាយាមសរសេរឱ្យល្អិតល្អន់ ឬស្មុគស្មាញពេក — នោះហើយដែលធ្វើឱ្យអត្ថបទឥតន័យ។ បន្ទាត់សាមញ្ញតែពិត ល្អជាងបន្ទាត់ល្អិតល្អន់តែខុស។ បើមិនច្បាស់ពាក្យ ឬឃ្លាខ្មែរណាមួយ សូមប្រើពាក្យសាមញ្ញដែលច្បាស់ជាង។ កុំបង្កើតពាក្យថ្មី និងកុំបង្ខំឱ្យច្រៀងត្រូវគ្នា (rhyme) រហូតដល់ធ្វើឱ្យខូចអត្ថន័យ។ (6) អត្ថបទត្រូវសរសេរដោយអារម្មណ៍ជ្រាលជ្រៅ ពិតប្រាកដ ចេញពីបេះដូង សមនឹងអារម្មណ៍របស់ចំណងជើង — អ្នកស្តាប់ត្រូវតែមានអារម្មណ៍ឈឺចាប់ កំសត់ ឬសប្បាយពិតប្រាកដនៅពេលអាន និងស្តាប់។ កុំសរសេរអត្ថបទស្ងួត គ្មានអារម្មណ៍ ឬទូទៅ។ ច្បាប់ផ្សេងទៀត៖ Verse នីមួយៗ 10-12 បន្ទាត់, Pre-Chorus 6 បន្ទាត់, Chorus នីមួយៗ 10 បន្ទាត់, Bridge 8-10 បន្ទាត់, Final Chorus 10-12 បន្ទាត់, Outro 4-6 បន្ទាត់។ អត្ថបទពេញត្រូវមាន 4,750-6,000 អក្សរ — យ៉ាងហោចណាស់ 3,000 អក្សរដាច់ខាត កុំត្រឡប់មកវិញក្រោម 3,000 អក្សរ — បើខ្លីពេក សូមបន្ថែមបន្ទាត់ក្នុង Verse និង Chorus ឱ្យគ្រប់រហូតដល់វែងគ្រប់។ ពាក្យអារម្មណ៍នៅក្នុងស្លាកផ្នែក (Sad Piano, Emotional, Sad Violin Solo, Deep Emotional) ជាគំរូសម្រាប់បទកំសត់ — ត្រូវផ្លាស់វាតាមអារម្មណ៍ និងស្ទាយរបស់ចំណងជើង៖ បទសប្បាយ → Bright Happy Piano, Joyful Vocal, Happy Guitar Solo; បទ hiphop → Hip Hop Beat, Energetic Vocal; បទបុរាណ → Traditional Khmer Music, Traditional Vocal។ រក្សាលំដាប់ 9 ផ្នែកដដែល និងសំឡេងប្រុស/ស្រីតាមការកំណត់។ Instrumental ត្រូវតែសមនឹងបទនេះ — ជ្រើសរើសឧបករណ៍ភ្លេង និងអារម្មណ៍ដែលសមនឹងអត្ថបទ និងអត្ថន័យរបស់បទ (បទកំសត់ Sad Violin Solo សម; បទអារម្មណ៍ផ្សេង ជ្រើសរើសឧបករណ៍ផ្សេង — កុំប្រើឧបករណ៍ដូចគ្នាសម្រាប់បទទាំងអស់)។ Bridge ក៏ត្រូវតែសមនឹងអត្ថន័យរបស់បទដែរ — ជ្រើសរើសសំឡេង និងស្ទាយសម្រាប់បទនេះ មិនមែនដូចគ្នារាល់ពេលទេ។ អត្ថបទត្រូវមានអារម្មណ៍ជ្រាលជ្រៅ ចេញពីបេះដូង, ច្រៀងបានស្រួល, ន័យច្បាស់ត្រឹមត្រូវ, និងសមនឹងចំណងជើង។ សូមផ្តល់តែអត្ថបទចម្រៀងជាមួយស្លាកផ្នែកប៉ុណ្ណោះ — កុំមានការពន្យល់ ឬអត្ថបទបន្ថែម។'
          : 'You are a professional songwriter. Write complete, original, LONG song lyrics in ' + (lang === 'en' ? 'English' : lang) + ' for the given song title — the FULL song at once, and the FULL lyrics must be 4,750-6,000 characters long (long enough for a full-length 4-5 minute song).' + (voice === 'random' ? ' Choose Male or Female vocal for this song (whichever fits it best) and write that vocal in every vocal section header, consistently.' : '') + ' Before writing, read the title carefully and determine this song\'s EMOTION and STYLE first: if the title is sad, painful, heartbroken, or about loss/trauma, write sad, heartbreaking, deeply emotional lyrics; if the title is happy, joyful, or celebratory, write happy, uplifting, joyful lyrics; if the title suggests hiphop/rap, write hiphop-style lyrics with rap flow and rhythm; if the title suggests traditional music, write traditional-style lyrics; if it suggests another style, match that style. Do NOT write generic lyrics that would fit any song — the lyrics MUST match the title\'s emotion and style.' + ' Structure the lyrics EXACTLY with these sections in this order:\n' + sections + '\nCRITICAL RULES (follow them absolutely): (1) NEVER number the lyric lines — do NOT write «1.», «2.», «3.» or any number in front of a line. Write each lyric line plainly, one line after another, with no number in front. (2) NEVER put a comma at the end of a lyric line — lyric lines must end WITHOUT a comma. (3) The lyrics must MAKE SENSE in the song language — every line must be clear, natural language that a real person would actually say and sing, with correct meaning and correct grammar, no nonsense. UNDERSTAND the meaning of the title first, then write lyrics that match that meaning exactly. (4) ONE coherent story and ONE emotion from start to finish — the lines must connect to each other, not jump randomly from one image to another. No random or odd metaphors (no crocodiles, no dogs in forests, no images that do not fit the meaning of the song). (5) Use SIMPLE, natural, heartfelt language — short lines, clear meaning, real feeling. Do NOT try to be overly poetic, fancy, or complex — that is what produces nonsense. A simple true line is better than a fancy wrong line. If you are unsure of a word or phrase, use a simpler one you are sure of. Never invent words and never force a rhyme that breaks the meaning. (6) The lyrics must be written with DEEP, REAL, HEARTFELT emotion matching the mood of the title — the listener must FEEL the sadness, joy, or pain. Not flat, not generic, not a list of facts. Other rules: each verse 10-12 lines, pre-chorus 6 lines, each chorus 10 lines, bridge 8-10 lines, final chorus 10-12 lines, outro 4-6 lines. The FULL lyrics must be 4,750-6,000 characters — absolute minimum 3,000 characters, NEVER return less than 3,000 characters — if the song is too short, add more lines to the verses and choruses until it is long enough. The mood words in the section labels (Sad Piano, Emotional, Sad Violin Solo, Deep Emotional) are EXAMPLES for a sad song — change them to fit the title\'s emotion and style: happy song → Bright Happy Piano, Joyful Vocal, Happy Guitar Solo; hiphop song → Hip Hop Beat, Energetic Vocal; traditional song → Traditional Music, Traditional Vocal. Keep the 9 sections in this exact order and keep the Male/Female vocal from the voice setting. The Instrumental MUST fit this song — choose the instrument and mood that matches the song\'s lyrics and meaning (Sad Violin Solo fits a sad song; for a different mood choose a different instrument — never use the same instrument for every song). The Bridge MUST also fit this song\'s meaning — choose its vocal and style for this song, not the same one every time. Make the lyrics deeply emotional and heartfelt, singable, meaningful and correct, and fitting the title. Output ONLY the lyrics with the section labels — no explanations, no extra text.';
        let out;
        try {
          out = await withProviderKeyRotation('groq', async (k) => {
            // Try each Groq model in order; fall back when the model
            // itself is unavailable (404 / model error) OR when it is
            // rate-limited right now (429 — per-model on Groq, so the
            // next model may still answer).
            let lastModelErr = null;
            for (const model of GROQ_LYRICS_MODELS) {
              let r, j;
              try {
                r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: 'Song title: ' + title }], temperature: 0.8, max_tokens: 12000 }), signal: AbortSignal.timeout(120000) });
                j = await r.json().catch(() => null);
              } catch (e) {
                throw rotErr('Groq: ' + (e && e.message ? e.message : 'request failed'), 0);
              }
              const content = j && j.choices && j.choices[0] && j.choices[0].message && typeof j.choices[0].message.content === 'string' ? j.choices[0].message.content.trim() : '';
              if (content) return { lyrics: content, model };
              const errMsg = genErrText(j, 'HTTP ' + r.status);
              const modelGone = r.status === 404 || /model (not found|not available|does not exist)|no such model|unknown model|model_decommissioned/i.test(errMsg);
              const modelLimited = r.status === 429;
              if ((modelGone || modelLimited) && model !== GROQ_LYRICS_MODELS[GROQ_LYRICS_MODELS.length - 1]) { lastModelErr = errMsg; continue; }
              throw rotErr('Groq: ' + errMsg, r.status);
            }
            throw rotErr('Groq: ' + (lastModelErr || 'no lyrics returned'), 0);
          });
        } catch (e) {
          await aiLyrRefund(email);
          if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Groq Key ទេ · The Admin has not added a Groq key yet' });
          const st = (e && e.httpStatus) || 0;
          if (st === 401 || st === 403) return sendJSON(res, 200, { ok: false, error: 'Groq Key មិនត្រឹមត្រូវទេ — សូមប្រាប់ Admin ពិនិត្យ Key · The Groq key seems invalid, please ask the Admin to check it' });
          if (st === 429) return sendJSON(res, 200, { ok: false, error: 'ស្នើសុំច្រើនពេក — សូមរង់ចាំ 1 នាទីហើយសាកម្ដងទៀត · Too many requests right now — please wait 1 minute and try again' });
          if (st === 402) return sendJSON(res, 200, { ok: false, error: 'Groq អស់កូតា — សូមសាកល្បងម្ដងទៀតនៅពេលក្រោយ · Groq quota reached, please try again later' });
          return sendJSON(res, 200, { ok: false, error: 'បង្កើតអត្ថបទមិនបានទេ — សូមសាកល្បងម្ដងទៀត · Could not generate lyrics, please try again' });
        }
        // Safety net (owner order 2026-11-19 10:08): strip any numbering
        // / trailing commas the model still emits (sanitizeLyricsText).
        const cleanLyrics = sanitizeLyricsText(out.lyrics);
        // LENGTH RETRY (owner order 2026-11-21 ~14:44 — owed since
        // 2026-11-20): Groq cut lyrics short at max_tokens 6000
        // (2,494-3,357 chars vs the 4,750-6,000 target). max_tokens
        // is now 12000, but if the result is still under 3,000 chars,
        // try ONCE more asking explicitly for LONGER and keep the
        // longer of the two. Same daily slot — no extra charge.
        let finalLyrics = cleanLyrics;
        if (finalLyrics.length < 3000) {
          try {
            const out2 = await withProviderKeyRotation('groq', async (k) => {
              let lastModelErr = null;
              for (const model of GROQ_LYRICS_MODELS) {
                let r, j;
                try {
                  r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: 'Song title: ' + title + '\nIMPORTANT: the previous attempt was only ' + finalLyrics.length + ' characters — TOO SHORT. Write the FULL song again, LONGER: at least 4,750 characters (absolute minimum 3,000). Add more lines to every verse and chorus until it is long enough. Same 9 sections, same rules.' }], temperature: 0.8, max_tokens: 12000 }), signal: AbortSignal.timeout(120000) });
                  j = await r.json().catch(() => null);
                } catch (e) {
                  throw rotErr('Groq: ' + (e && e.message ? e.message : 'request failed'), 0);
                }
                const content = j && j.choices && j.choices[0] && j.choices[0].message && typeof j.choices[0].message.content === 'string' ? j.choices[0].message.content.trim() : '';
                if (content) return { lyrics: content, model };
                const errMsg = genErrText(j, 'HTTP ' + r.status);
                const modelGone = r.status === 404 || /model (not found|not available|does not exist)|no such model|unknown model|model_decommissioned/i.test(errMsg);
                const modelLimited = r.status === 429;
                if ((modelGone || modelLimited) && model !== GROQ_LYRICS_MODELS[GROQ_LYRICS_MODELS.length - 1]) { lastModelErr = errMsg; continue; }
                throw rotErr('Groq: ' + errMsg, r.status);
              }
              throw rotErr('Groq: ' + (lastModelErr || 'no lyrics returned'), 0);
            });
            const clean2 = sanitizeLyricsText(out2.lyrics);
            if (clean2.length > finalLyrics.length) { finalLyrics = clean2; out = out2; }
          } catch (e2) { /* keep the first (short) result */ }
        }
        return sendJSON(res, 200, { ok: true, lyrics: finalLyrics, model: out.model, aiLyr: { limit: AI_LYRICS_DAILY_LIMIT, used: lyrUsed + 1, left: Math.max(0, AI_LYRICS_DAILY_LIMIT - (lyrUsed + 1)) } });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'បង្កើតអត្ថបទមិនបានទេ — សូមសាកល្បងម្ដងទៀត · Could not generate lyrics, please try again' }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
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
    await wrapGenLog(res, 'image', genCtx);
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
        const _blkErr = await genBlockedCheck(normEmail(body.email), req);
        if (_blkErr) return sendJSON(res, 200, { ok: false, error: _blkErr });
        // Free 20 images per day AND 10 thumbnails per 3-day window,
        // SEPARATE counters (owner order 2026-11-20 07:45 — 20/day).
        // NovAI + Agnes + 'auto' only (0 MovAi credits) — a COUNT cap,
        // not a charge. Paid/own-key paths (magichour, cloudflare,
        // gemini, hf) are NOT capped here — media credits / the user's
        // own key already govern them. The slot is taken BEFORE the
        // provider call and given back if the provider fails (see
        // imgFreeRefund in the novai/agnes catch blocks below). For
        // 'auto', the slot is also given back when the image ends up
        // coming from Magic Hour (TEST, paid) instead of Agnes.
        // The website passes isThumbnail:true for thumbnails so the
        // thumbnail counter is used; regular images use the image one.
        let _imgFree = null;
        if (provider === 'novai' || provider === 'agnes' || provider === 'auto') {
          const _freeEm = normEmail(body.email);
          const _freeUsers = await loadUsers();
          const _freeU = _freeUsers[_freeEm];
          if (!_freeU) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
          const _isThumb = body.isThumbnail === true;
          const _freeKey = _isThumb ? 'thumbFree3' : 'imgFreeDaily';
          const _freeLimit = _isThumb ? THUMB_FREE_3DAY_LIMIT : IMG_FREE_DAILY_LIMIT;
          const _win = _isThumb ? _free3Window(_freeU[_freeKey]) : _freeDailyWindow(_freeU[_freeKey]);
          if (_win.used >= _freeLimit) {
            return sendJSON(res, 200, { ok: false, error: (_isThumb ? 'Thumbnail Free អស់ហើយ (10/10) — នឹងបាន Free ម្ដងទៀតនៅថ្ងៃ ' + _win.resetDate + ' · Free thumbnails used up (10/10) — free again on ' + _win.resetDate : 'រូប Free អស់ហើយ (20/20) — នឹងបាន Free ម្ដងទៀតនៅថ្ងៃ ' + _win.resetDate + ' · Free images used up (20/20) — free again on ' + _win.resetDate), code: 'image_free_daily_limit', imgFree: { date: _win.start, limit: _freeLimit, used: _win.used, left: 0, resetDate: _win.resetDate, kind: _isThumb ? 'thumbnail' : 'image' } });
          }
          _freeU[_freeKey] = { start: _win.start, used: _win.used + 1 };
          // Keep the legacy daily counter in sync (display/back-compat
          // only — it is NOT enforced anymore).
          const _freeToday = imgFreeTodayDate();
          const _dailyUsed = (_freeU.imgDaily && typeof _freeU.imgDaily === 'object' && _freeU.imgDaily.date === _freeToday) ? Math.max(0, Math.floor(Number(_freeU.imgDaily.used) || 0)) : 0;
          _freeU.imgDaily = { date: _freeToday, used: _dailyUsed + 1 };
          _freeUsers[_freeEm] = _freeU;
          await saveUsers(_freeUsers);
          _imgFree = { date: _win.start, limit: _freeLimit, used: _win.used + 1, left: Math.max(0, _freeLimit - _win.used - 1), resetDate: _win.resetDate, kind: _isThumb ? 'thumbnail' : 'image' };
        }
        const key = typeof body.key === 'string' ? body.key : '';
        let prompt = body.prompt.trim().slice(0, 2000);
        // Translate a non-English (e.g. Khmer) prompt to English first:
        // the image models understand English far better than Khmer,
        // so a Khmer prompt sent as-is renders a generic scene instead
        // of the requested content. English prompts pass through
        // untouched; a failed translation never blocks the image.
        if (/[^\x00-\x7F]/.test(prompt)) {
          const _en = await translateImgPromptToEnglish(prompt);
          if (_en) prompt = _en.slice(0, 2000);
        }
        // Quality suffix (v2.1.37): make the image vivid and detailed so
        // it matches the request (style-neutral, no subject change).
        if (!/highly detailed|sharp focus/i.test(prompt)) prompt = (prompt + ', highly detailed, sharp focus').slice(0, 2000);
        const width = Math.max(64, Math.min(2048, Number(body.width) || 768));
        const height = Math.max(64, Math.min(2048, Number(body.height) || 768));
        // Server-side credit check (image): Magic Hour costs by model
        // (media credits). NovAI is free. Cloudflare/Gemini use the
        // user's own key, so no MovAi credit is charged.
        const IMAGE_COSTS = { 'z-image-turbo': 5, 'flux-2-klein': 5, 'flux-schnell': 5, 'qwen-image-2.1': 10, 'krea-2': 10, 'gpt-image-2': 50, 'nano-banana-2.1': 50, 'nano-banana-pro': 150 };
        let imgCost = 0;
        if (provider === 'magichour') {
          const _m = typeof body.model === 'string' ? body.model.trim() : '';
          imgCost = IMAGE_COSTS[_m] || 5;
        }
        if (imgCost > 0) {
          const _imgEm = normEmail(body.email);
          if (_imgEm) {
            const _imgUsers = await loadUsers();
            const _imgU = _imgUsers[_imgEm];
            if (_imgU && Math.floor(numOr(_imgU.credits, 0)) < imgCost) {
              await notifyOutOfCredit(_imgEm, 'media', Math.floor(numOr(_imgU.credits, 0)), imgCost);
              return sendJSON(res, 200, { ok: false, error: 'Image.Video Credit មិនគ្រប់ទេ · Not enough Image/Video Credits — សូមទិញ Credit បន្ថែម', needBuy: true, kind: 'media', balance: Math.floor(numOr(_imgU.credits, 0)), cost: imgCost });
            }
          }
        }
        // ---- Auto image (v2.1.34, chat, provider 'auto') ----
        // FINAL auto order (owner 2026-11-20 09:06): Agnes -> Magic
        // Hour -> NovAI, changing CONTINUOUSLY. Agnes rotates its
        // starting model each generation (2.5 -> 2.1 -> 2.0 -> 2.5...)
        // so the model actually varies instead of always using 2.5.
        // Agnes is free (0 MovAi credits, free 20/day). If no Agnes
        // model can create it, try the Magic Hour TEST models (owner
        // 08:01 — TEST only, NOT free, NOT in the free 20/day; if it
        // works well it becomes Pro). Each Magic Hour model charges
        // its normal MovAi media credits (IMAGE_COSTS) and is labelled
        // isTest. If Magic Hour also fails (or the user cannot afford
        // it), NovAI cogview-3-flash last (free, 0 credits, counts in
        // the free 20/day like Agnes). The free slot is refunded ONLY
        // if the image ends up coming from Magic Hour (paid) or if
        // nothing succeeds at all. The first model that succeeds wins;
        // the response reports provider/model/cost/isTest so the
        // website shows exactly what was used.
        const _autoAgnesModels = ['agnes-image-2.5-flash', 'agnes-image-2.1-flash', 'agnes-image-2.0-flash'];
        const _autoMHTestModels = ['qwen-image-2.1', 'flux-2-klein', 'krea-2', 'z-image-turbo', 'flux-schnell'];
        function _autoAgnesRatio() {
          const _ar = width / height;
          const _ratios = [['21:9', 21 / 9], ['16:9', 16 / 9], ['3:2', 3 / 2], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16]];
          let _r = '1:1', _bd = 1e9;
          for (const _rr of _ratios) { const _d = Math.abs(Math.log(_ar / _rr[1])); if (_d < _bd) { _bd = _d; _r = _rr[0]; } }
          return _r;
        }
        // Magic Hour only accepts aspect_ratio 1:1 / 16:9 / 9:16 (v2.1.36:
        // the fallback image request was missing image_count, which the
        // Magic Hour API requires, and sent no aspect ratio at all).
        function _mhImageRatio() {
          const _ar = width / height;
          const _ratios = [['16:9', 16 / 9], ['1:1', 1], ['9:16', 9 / 16]];
          let _r = '1:1', _bd = 1e9;
          for (const _rr of _ratios) { const _d = Math.abs(Math.log(_ar / _rr[1])); if (_d < _bd) { _bd = _d; _r = _rr[0]; } }
          return _r;
        }
        async function _tryAgnesAuto(model) {
          return await withProviderKeyRotation('agnes', async (k) => {
            const r = await fetch('https://apihub.agnes-ai.com/v1/images/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt, size: '1K', ratio: _autoAgnesRatio(), n: 1 }), signal: AbortSignal.timeout(60000) });
            const j = await r.json().catch(() => null);
            const url = j && j.data && (Array.isArray(j.data) ? (j.data[0] && (j.data[0].url || j.data[0].image_url)) : (j.data.url || j.data.image_url));
            if (url) return { done: true, imageUrl: url };
            const id = j && (j.id || (j.data && !Array.isArray(j.data) && j.data.id));
            if (id) return { jobId: id };
            throw rotErr('Agnes: ' + genErrText(j, 'HTTP ' + r.status), r.status);
          }, key);
        }
        async function _tryMHImageAuto(model) {
          return await withProviderKeyRotation('magichour', async (k) => {
            const r = await fetch('https://api.magichour.ai/v1/ai-image-generator', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MovAi image', model, image_count: 1, aspect_ratio: _mhImageRatio(), resolution: '1k', style: { prompt } }), signal: AbortSignal.timeout(60000) });
            const j = await r.json().catch(() => null);
            const id = j && j.id;
            if (id) return { jobId: id };
            throw rotErr('Magic Hour: ' + genErrText(j, 'HTTP ' + r.status), r.status);
          }, key);
        }
        async function _tryNovAIImageAuto() {
          const _size = Math.min(2048, Math.max(64, width)) + 'x' + Math.min(2048, Math.max(64, height));
          return await withProviderKeyRotation('novai', async (k) => {
            const r = await fetch('https://aiapi-pro.com/v1/images/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cogview-3-flash', prompt, size: _size }), signal: AbortSignal.timeout(120000) });
            const j = await r.json().catch(() => null);
            const url = j && j.data && j.data[0] && j.data[0].url;
            if (url) return { done: true, imageUrl: url };
            const id = j && (j.id || (j.data && j.data.id));
            if (id) return { jobId: id };
            throw rotErr('NovAI: ' + genErrText(j, 'HTTP ' + r.status), r.status);
          }, key);
        }
        if (provider === 'auto') {
          let _autoOut = null, _autoProv = null, _autoModel = null, _autoCost = 0, _autoErr = null, _autoCredits, _autoSongCredits;
          // Rotate the starting Agnes model each auto generation (v2.1.37):
          // 2.5 -> 2.1 -> 2.0 -> 2.5 ... so the model actually varies
          // instead of always using 2.5. If the starting model fails,
          // fall through to the next in the cycle.
          const _rot = _autoAgnesRot % _autoAgnesModels.length;
          _autoAgnesRot = _rot + 1;
          const _autoOrder = _autoAgnesModels.slice(_rot).concat(_autoAgnesModels.slice(0, _rot));
          for (const _m of _autoOrder) {
            try { _autoOut = await _tryAgnesAuto(_m); _autoProv = 'agnes'; _autoModel = _m; break; }
            catch (e) { _autoErr = e; if (e && e.noKey) break; }
          }
          if (!_autoOut) {
            const _uu = (await loadUsers())[normEmail(body.email)];
            const _bal = _uu ? Math.floor(numOr(_uu.credits, 0)) : 0;
            for (const _m of _autoMHTestModels) {
              const _c = IMAGE_COSTS[_m] || 5;
              if (_bal < _c) continue;
              const _ded = await deductForGeneration(body.email, _c, 0, 'image:magichour:test:' + _m);
              if (!_ded.ok) continue;
              try {
                _autoOut = await _tryMHImageAuto(_m);
                _autoProv = 'magichour'; _autoModel = _m; _autoCost = _c; _autoCredits = _ded.credits; _autoSongCredits = _ded.songCredits;
                break;
              } catch (e) {
                await refundForGeneration(body.email, _c, 0, 'image:magichour:test:' + _m + ' failed');
                _autoErr = e;
                if (e && e.noKey) break;
              }
            }
          }
          // NovAI last (owner 2026-11-20 09:06 — FINAL auto order).
          // Free (0 credits); the reserved free slot stays consumed.
          if (!_autoOut) {
            try {
              _autoOut = await _tryNovAIImageAuto();
              _autoProv = 'novai'; _autoModel = 'cogview-3-flash'; _autoCost = 0;
            } catch (e) { _autoErr = e; }
          }
          if (!_autoOut) {
            if (_imgFree) await imgFreeRefund(body.email, body.isThumbnail === true);
            return sendJSON(res, 200, { ok: false, error: (_autoErr && _autoErr.message) || 'Image failed — please try again' });
          }
          // Magic Hour is paid (TEST), so it does NOT consume the free
          // slot — give it back. Agnes and NovAI are free, so the slot
          // stays consumed for them.
          if (_autoProv === 'magichour') {
            if (_imgFree) await imgFreeRefund(body.email, body.isThumbnail === true);
            _imgFree = null;
          }
          if (_autoOut.done) return sendJSON(res, 200, { ok: true, done: true, imageUrl: _autoOut.imageUrl, provider: _autoProv, model: _autoModel, imageModel: _autoModel, imgFree: _imgFree, imageCost: _autoCost, isTest: _autoProv === 'magichour' });
          return sendJSON(res, 200, { ok: true, jobId: _autoOut.jobId, provider: _autoProv, model: _autoModel, imageModel: _autoModel, imgFree: _imgFree, imageCost: _autoCost, credits: _autoCredits, songCredits: _autoSongCredits, isTest: _autoProv === 'magichour' });
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
              const r = await fetch('https://api.magichour.ai/v1/ai-image-generator', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MovAi image', model, image_count: 1, aspect_ratio: _mhImageRatio(), resolution: '1k', style: { prompt } }), signal: AbortSignal.timeout(60000) });
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
            if (_imgFree) await imgFreeRefund(body.email, _imgFree.kind === 'thumbnail');
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ NovAI Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'NovAI: request failed' });
          }
          if (out.done) return sendJSON(res, 200, { ok: true, done: true, imageUrl: out.imageUrl, imgFree: _imgFree });
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, imgFree: _imgFree });
        }
        if (provider === 'agnes') {
          // Agnes image via the admin-stored keys (browser sends no
          // key). Free ($0) — no MovAi credit is charged, like NovAI.
          // API: POST https://apihub.agnes-ai.com/v1/images/generations
          // {model:'agnes-image-2.5-flash'|'agnes-image-2.1-flash'|
          //  'agnes-image-2.0-flash', prompt, size:'1K',
          //  ratio:'16:9'|'9:16'|..., n:1} → data[0].url.
          // The model comes from the website picker; anything else
          // falls back to 2.5-flash. The Agnes docs list 2.0/2.1 as
          // paid ($0.015/image at 1K) but other sources say $0 — the
          // call itself decides: a payment/balance failure is
          // reported, never charged.
          const _agnesModels = ['agnes-image-2.5-flash', 'agnes-image-2.1-flash', 'agnes-image-2.0-flash'];
          const _agnesModel = (typeof body.model === 'string' && _agnesModels.indexOf(body.model.trim()) >= 0) ? body.model.trim() : 'agnes-image-2.5-flash';
          // Ratio from the requested dimensions (Agnes supports
          // 1:1, 3:4, 4:3, 16:9, 9:16, 2:3, 3:2, 21:9).
          const _ar = width / height;
          const _ratios = [['21:9', 21 / 9], ['16:9', 16 / 9], ['3:2', 3 / 2], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16]];
          let _ratio = '1:1', _bd = 1e9;
          for (const _rr of _ratios) { const _d = Math.abs(Math.log(_ar / _rr[1])); if (_d < _bd) { _bd = _d; _ratio = _rr[0]; } }
          let out;
          try {
            out = await withProviderKeyRotation('agnes', async (k) => {
              const r = await fetch('https://apihub.agnes-ai.com/v1/images/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: _agnesModel, prompt, size: '1K', ratio: _ratio, n: 1 }), signal: AbortSignal.timeout(120000) });
              const j = await r.json().catch(() => null);
              const url = j && j.data && (Array.isArray(j.data) ? (j.data[0] && (j.data[0].url || j.data[0].image_url)) : (j.data.url || j.data.image_url));
              if (url) return { done: true, imageUrl: url };
              const id = j && (j.id || (j.data && !Array.isArray(j.data) && j.data.id));
              if (id) return { jobId: id };
              throw rotErr('Agnes: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            }, key);
          } catch (e) {
            if (_imgFree) await imgFreeRefund(body.email, _imgFree.kind === 'thumbnail');
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Agnes Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Agnes: request failed' });
          }
          if (out.done) return sendJSON(res, 200, { ok: true, done: true, imageUrl: out.imageUrl, imgFree: _imgFree });
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, imgFree: _imgFree });
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
              if (j && j.id && j.id !== jobId) throw rotErr('Magic Hour: wrong project returned', 502);
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
        if (provider === 'agnes') {
          // Agnes images return synchronously with a URL — there is
          // no status endpoint to poll. A jobId here means the
          // create call returned one without a URL; say so plainly
          // instead of polling a non-existent endpoint.
          return sendJSON(res, 200, { ok: false, error: 'Agnes: រូបភាពមិនទាន់រួចរាល់ទេ — សូមសាកល្បងម្តងទៀត · Agnes image was accepted but no URL came back, please retry' });
        }
        return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/video — {provider:'novai'|'magichour'|'tavus'|'hf', key, prompt, duration, res, width, height, replicaId, model, tier, imageUrl}
  // imageUrl (magichour only, v2.1.34): a public image URL -> the video
  // is made FROM that image via Magic Hour /v1/image-to-video.
  if (req.method === 'POST' && urlPath === '/api/gen/video') {
    const genCtx = { provider: '', email: '' };
    await wrapGenLog(res, 'video', genCtx);
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
        const _blkErr = await genBlockedCheck(normEmail(body.email), req);
        if (_blkErr) return sendJSON(res, 200, { ok: false, error: _blkErr });
        const reqKey = typeof body.key === 'string' ? body.key : '';
        const prompt = body.prompt.trim().slice(0, 4000);
        const _durRaw = Number(body.duration);
        const _durAllowed = [5, 10, 20, 30, 60];
        let duration = 5;
        if (_durAllowed.includes(_durRaw)) duration = _durRaw;
        else if (Number.isFinite(_durRaw) && _durRaw > 0) {
          let _best = _durAllowed[0], _bd = 1e9;
          for (const _a of _durAllowed) { const _dd = Math.abs(_durRaw - _a); if (_dd < _bd) { _bd = _dd; _best = _a; } }
          duration = _best;
        }
        // Magic Hour video tiers (v2.1.33): per-second media-credit rates
        // from Magic Hour pricing (720p). Normal ltx-2.5 48/s (5-60s),
        // Medium kling-3.0 60/s (5-15s), High seedance-2.0 216/s (5-10s),
        // Strongest seedance-2.5 336/s (5-10s). Long videos fall back to Normal.
        const MH_VIDEO_TIERS = {
          'ltx-2.5': { rate: 48, maxDur: 60 },
          'kling-3.0': { rate: 60, maxDur: 15 },
          'seedance-2.0': { rate: 216, maxDur: 10 },
          'seedance-2.5': { rate: 336, maxDur: 10 }
        };
        const MH_TIER_BY_KEY = { normal: 'ltx-2.5', medium: 'kling-3.0', high: 'seedance-2.0', strongest: 'seedance-2.5' };
        let vidModel = 'ltx-2.5';
        if (typeof body.model === 'string' && MH_VIDEO_TIERS[body.model]) vidModel = body.model;
        else if (typeof body.tier === 'string' && MH_TIER_BY_KEY[body.tier]) vidModel = MH_TIER_BY_KEY[body.tier];
        let vidTier = MH_VIDEO_TIERS[vidModel];
        if (duration > vidTier.maxDur) { vidModel = 'ltx-2.5'; vidTier = MH_VIDEO_TIERS[vidModel]; }
        const vidRate = vidTier.rate;
        // Image-to-video (v2.1.34): if the chat sends an imageUrl, the
        // video is made FROM that image via Magic Hour /v1/image-to-video.
        // The URL must be a public http(s) URL ending in a supported
        // image extension (Magic Hour rule). An invalid imageUrl is a
        // clear error BEFORE any credit is deducted.
        let vidImageUrl = null;
        if (body.imageUrl !== undefined && body.imageUrl !== null && String(body.imageUrl).trim() !== '') {
          const _iu = String(body.imageUrl).trim();
          if (!/^https?:\/\/.+\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(_iu)) return sendJSON(res, 200, { ok: false, error: 'រូបភាពសម្រាប់ធ្វើវីដេអូមិនត្រឹមត្រូវទេ · The image for the video is not a valid image URL' });
          vidImageUrl = _iu;
        }
        const _vidKind = vidImageUrl ? 'img2vid' : 'text2vid';
        // Server-side credit check (video): Magic Hour costs vidRate media
        // credits per second (tiered). NovAI is free. Tavus/HF are not charged
        // here (Tavus removed from the website; HF uses the user's key).
        let vidCost = 0;
        if (provider === 'magichour') vidCost = vidRate * duration;
        if (vidCost > 0) {
          const _vidEm = normEmail(body.email);
          if (_vidEm) {
            const _vidUsers = await loadUsers();
            const _vidU = _vidUsers[_vidEm];
            if (_vidU && Math.floor(numOr(_vidU.credits, 0)) < vidCost) {
              await notifyOutOfCredit(_vidEm, 'media', Math.floor(numOr(_vidU.credits, 0)), vidCost);
              return sendJSON(res, 200, { ok: false, error: 'Image.Video Credit មិនគ្រប់ទេ · Not enough Image/Video Credits — សូមទិញ Credit បន្ថែម', needBuy: true, kind: 'media', balance: Math.floor(numOr(_vidU.credits, 0)), cost: vidCost });
            }
          }
        }
        // No key at all (no request key and no admin key for this
        // provider): same message as before. Rotation happens per branch.
        if (!reqKey.trim() && !(await adminProviderKeyList(provider)).length) {
          const pname = provider === 'novai' ? 'NovAI' : provider === 'magichour' ? 'Magic Hour' : provider === 'tavus' ? 'Tavus' : null;
          return sendJSON(res, 200, { ok: false, error: pname ? ('Admin មិនទាន់ដាក់ ' + pname + ' Key ទេ') : 'មិនទាន់មាន API Key ទេ' });
        }
        const key = reqKey; // hf (request-key only) still uses the raw key
        if (provider === 'novai') {
          let out;
          try {
            out = await withProviderKeyRotation('novai', async (k) => {
              const r = await fetch('https://aiapi-pro.com/v1/video/generations', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cogvideox-flash', prompt }), signal: AbortSignal.timeout(180000) });
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
          const _dedVid = await deductForGeneration(body.email, vidCost, 0, 'video:magichour:' + _vidKind + ':' + vidModel + ':' + duration + 's');
          if (!_dedVid.ok) return sendJSON(res, 200, { ok: false, error: _dedVid.error || 'Credit មិនគ្រប់ទេ', needBuy: true, kind: 'media', balance: _dedVid.balance, cost: vidCost });
          let out;
          try {
            out = await withProviderKeyRotation('magichour', async (k) => {
              const _mhUrl = vidImageUrl ? 'https://api.magichour.ai/v1/image-to-video' : 'https://api.magichour.ai/v1/text-to-video';
              const _mhBody = vidImageUrl ? { name: 'MovAi video', end_seconds: duration, aspect_ratio: aspect, resolution: resName, model: vidModel, assets: { image_file_path: vidImageUrl }, style: { prompt } } : { name: 'MovAi video', end_seconds: duration, aspect_ratio: aspect, resolution: resName, model: vidModel, style: { prompt } };
              const r = await fetch(_mhUrl, { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(_mhBody), signal: AbortSignal.timeout(60000) });
              const j = await r.json().catch(() => null);
              if (j && j.id) return { jobId: j.id };
              throw rotErr('Magic Hour: ' + genErrText(j, 'HTTP ' + r.status), r.status);
            }, reqKey);
          } catch (e) {
            await refundForGeneration(body.email, vidCost, 0, 'video:magichour:' + _vidKind + ':' + vidModel + ':' + duration + 's failed');
            if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Magic Hour Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Magic Hour: request failed' });
          }
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, credits: _dedVid.credits, songCredits: _dedVid.songCredits, videoModel: vidModel, videoRate: vidRate, videoCost: vidCost, duration, videoKind: _vidKind });
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
        if (!reqKey.trim() && !(await adminProviderKeyList(provider)).length) {
          const pname = provider === 'novai' ? 'NovAI' : provider === 'magichour' ? 'Magic Hour' : provider === 'tavus' ? 'Tavus' : null;
          return sendJSON(res, 200, { ok: false, error: pname ? ('Admin មិនទាន់ដាក់ ' + pname + ' Key ទេ') : 'មិនទាន់មាន API Key ទេ' });
        }
        if (provider === 'novai') {
          let out;
          try {
            out = await withProviderKeyRotation('novai', async (k) => {
              const r = await fetch('https://aiapi-pro.com/v1/video/generations/' + encodeURIComponent(jobId) + '?model=cogvideox-flash', { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              if (!r.ok) throw rotErr('NovAI: ' + genErrText(j, 'HTTP ' + r.status), r.status);
              const st = j && (j.status || (j.data && j.data.status));
              if (st === 'succeeded') {
                const url = j && (j.url || j.video_url || (j.content && (j.content.video_url || j.content.url)) || (j.data && (j.data.url || j.data.video_url || (Array.isArray(j.data) && j.data[0] && j.data[0].url))) || (j.output && j.output.url) || (j.result && j.result.url));
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
  // v2.2.58 Instant Playback: save a finished Suno task's songs to
  // permanent Cloudinary storage in the BACKGROUND. Called when SUCCESS
  // arrives (webhook or record-info). Never awaited — the webhook must
  // answer 200 in under a second and the status endpoint must not wait
  // for the upload. Deduplicated by state.saveStarted. When every song
  // has a permanent URL (or its upload failed and fell back to the Suno
  // URL, which the client's histStoreSongNow then saves), the task
  // becomes 'ready' and the client switches the player to the permanent
  // URL and enables Download.
  async function sunoStreamSave(taskId) {
    var st = sunoStreamState.get(taskId);
    if (!st || st.saveStarted) return;
    st.saveStarted = true;
    try {
      var pending = st.songs.filter(function(x) { return x.audioUrl && !x.permanentMp3Url && x.status !== 'failed'; });
      for (const x of pending) {
        try {
          const stored = await cloudinaryStoreSong(x.audioUrl, x.title || '');
          if (stored && stored.mp3Url) { x.permanentMp3Url = stored.mp3Url; x.status = 'ready'; }
          else { x.status = 'ready'; }
        } catch (e) { try { console.error('[suno-stream] cloudinary save failed for ' + taskId + ': ' + String((e && e.message) || e).slice(0, 120)); } catch (e2) {} x.status = 'ready'; }
      }
      var allReady = st.songs.length > 0 && st.songs.every(function(x) { return x.status === 'ready' || x.status === 'failed'; });
      if (allReady) st.status = 'ready';
      st.updatedAt = Date.now();
      sunoStreamPersist(taskId);
    } catch (e) {}
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
          // v2.2.58: preserve the FIRST_SUCCESS preview — a SUCCESS
          // callback must not erase the first song's early URL, or the
          // client's early card loses its src identity and playback
          // restarts on the final render.
          var _prevCb = sunoCallbacks.get(taskId);
          var _cbSongs = sunoSongsFromData(d);
          var _cbPrev = sunoPreviewFromData(d);
          var _firstSongs = (_prevCb && _prevCb.firstSongs && _prevCb.firstSongs.length) ? _prevCb.firstSongs : null;
          var _firstPrev = (_prevCb && _prevCb.firstPreview) ? _prevCb.firstPreview : null;
          if (st === 'FIRST_SUCCESS') {
            if (_cbSongs.length) _firstSongs = _cbSongs;
            if (_cbPrev) _firstPrev = _cbPrev;
          }
          // v2.2.63 (S6): vocal-removal (Split Stem) callbacks share this
          // endpoint but are NOT generation callbacks — they carry stem
          // URLs and no sunoData. Ignore them here (the split status
          // endpoint polls record-info); merging one would corrupt the
          // generation stream state for the same taskId.
          var _isGenCb = (_cbSongs.length > 0) || st === 'TEXT_SUCCESS' || st === 'FIRST_SUCCESS';
          if (!_isGenCb) { /* not a generation callback: ack only */ }
          else {
            sunoCallbacks.set(taskId, { status: st, songs: _cbSongs, preview: _cbPrev, firstSongs: _firstSongs, firstPreview: _firstPrev, updatedAt: Date.now() });
            // v2.2.58 Instant Playback: drive the per-song streaming
            // state (text -> streaming -> saving -> ready). Fire-and-
            // forget only — the 200 below must go out in under a second,
            // so nothing here is awaited.
            try {
              var _sm = sunoStreamMerge(taskId, d, st);
              if (_sm.changed) sunoStreamPersist(taskId);
              if (st === 'SUCCESS') { try { sunoStreamSave(taskId).catch(function() {}); } catch (e) {} }
            } catch (e) {}
          }
          // v2.2.48: Suno reports a failed job here — refund it on the
          // SERVER at once (no phone report needed). coverPendingRefund
          // is once-only and paid-only, so a stray callback is harmless.
          if (st && sunoStatusIsFailed(st)) { try { coverPendingRefund(taskId).catch(function() {}); } catch (e) {} }
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
    await wrapGenLog(res, 'song', genCtx);
    readJSONBody(req, 256 * 1024).then(async (body) => {
      if (body && typeof body === 'object') {
        if (typeof body.provider === 'string') genCtx.provider = body.provider;
        if (typeof body.email === 'string') genCtx.email = body.email;
      }
      try {
        if (!body || (typeof body.prompt !== 'string' && typeof body.title !== 'string' && typeof body.lyrics !== 'string' && typeof body.style !== 'string')) return sendJSON(res, 200, { ok: false, error: 'សូមសរសេរ prompt ជាមុនសិន' });
        const provider = body.provider;
        const _gateErr = await genFairnessGate(normEmail(body.email), provider);
        if (_gateErr) return sendJSON(res, 200, { ok: false, error: _gateErr });
        const _blkErr = await genBlockedCheck(normEmail(body.email), req);
        if (_blkErr) return sendJSON(res, 200, { ok: false, error: _blkErr });
        const reqKey = typeof body.key === 'string' ? body.key : '';
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
        const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim().slice(0, 10000) : '';
        const style = typeof body.style === 'string' ? body.style.trim().slice(0, 500) : '';
        const voice = body.voice === 'male' || body.voice === 'female' ? body.voice : 'random';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 10000) : '';
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
          const _songUsers = await loadUsers();
          const _songU = _songUsers[_songEm];
          const _bal = SONG_POOL === 'media' ? Math.floor(numOr(_songU.credits, 0)) : Math.floor(numOr(_songU.songCredits, 0));
          if (_songU && _bal < SONG_COST) {
            const _err = SONG_POOL === 'media' ? 'Image.Video Credit មិនគ្រប់ទេ · Not enough Image/Video Credits — សូមទិញ Credit បន្ថែម' : 'Song Credit មិនគ្រប់ទេ · Not enough Song Credits — សូមទិញ Credit បន្ថែម';
            await notifyOutOfCredit(_songEm, SONG_POOL, _bal, SONG_COST);
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
          const sunoKeys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
          if (!sunoKeys.length) {
            if (!(await adminProviderKeyList('suno')).length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
          }
          // v2.2.48: Instrumental ON = MUSIC ONLY (owner 15:26) — same
          // rule as covers: never send lyrics (or a voice persona) when
          // the user asked for no singing.
          const _sunoInstr = (body.instrumental === true || body.make_instrumental === true);
          const genBody = {
            customMode: true,
            instrumental: _sunoInstr,
            callBackUrl: SUNO_CALLBACK_URL,
            model: sunoApiModel(model),
            style: (style || 'pop').slice(0, 1000),
            lyrics: _sunoInstr ? '' : (lyrics || prompt || '').slice(0, 5000),
            title: title.slice(0, 80),
          };
          if (voice === 'male') genBody.vocalGender = 'm';
          else if (voice === 'female') genBody.vocalGender = 'f';
          // My Voice (owner order 2026-11-19): when the user picks their own
          // voice, look up the stored voiceId (server-side only, never sent
          // to the client) and check availability, then send personaId +
          // personaModel voice_persona. The model is forced to
          // MY_VOICE_MODEL (V6 if the live test proves it, else V5_5).
          // A missing/unavailable voice fails BEFORE any credit is deducted.
          if ((body.myVoice === true || body.voice === 'myvoice') && !_sunoInstr) {
            const _mvUsers = await loadUsers();
            const _mv = myVoiceGet(_mvUsers[normEmail(body.email)]);
            if (!_mv || !_mv.voiceId || !_mv.voiceTaskId) return sendJSON(res, 200, { ok: false, error: 'សូមបង្កើត My Voice ជាមុនសិន · Please set up My Voice first', needMyVoice: true });
            try {
              const _chk = await sunoVoiceCall('/api/v1/voice/check-voice', 'POST', { task_id: _mv.voiceTaskId });
              if (!(_chk && _chk.data && _chk.data.isAvailable === true)) return sendJSON(res, 200, { ok: false, error: 'My Voice មិនទាន់រួចរាល់ទេ — សូមព្យាយាមម្តងទៀត · My Voice is not ready yet, please try again' });
            } catch (e) {
              return sendJSON(res, 200, { ok: false, error: 'My Voice: ពិនិត្យមិនបានទេ — ' + ((e && e.message) || 'check failed') });
            }
            genBody.personaId = _mv.voiceId;
            genBody.personaModel = 'voice_persona';
            genBody.model = sunoApiModel(MY_VOICE_MODEL);
          }
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
          return sendJSON(res, 200, { ok: true, jobId: out.jobId, credits: _ded.credits, songCredits: _ded.songCredits, model: genBody.model });
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
          const sunoKeys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
          if (!sunoKeys.length) {
            if (!(await adminProviderKeyList('suno')).length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
            return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
          }
          const cb = sunoCallbacks.get(jobId);
          // v2.2.58 Instant Playback: the per-song streaming state is
          // the primary source (webhook-driven). It knows each song's
          // status (generating/streaming/saving/ready) and URLs, so the
          // client can play the live stream and switch to the permanent
          // URL when it is ready.
          var _ss = null;
          try { _ss = await sunoStreamLoad(jobId); } catch (e) {}
          if (_ss && _ss.status === 'ready' && _ss.songs && _ss.songs.length) {
            return sendJSON(res, 200, { ok: true, status: 'done', songs: sunoStreamToSongs(_ss) });
          }
          if (_ss && _ss.status === 'streaming' && _ss.songs && _ss.songs.length) {
            var _sp = sunoStreamToSongs(_ss);
            var _prev = _sp.length ? (_sp[0].streamAudioUrl || _sp[0].url) : '';
            return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: 'first', preview: _prev, streamUrl: _prev, songs: _sp });
          }
          if (_ss && _ss.status === 'saving' && _ss.songs && _ss.songs.length) {
            // v2.2.63 (S2): Suno already finished (SUCCESS seen) — the
            // song is DONE even while the permanent Cloudinary save is
            // still running. Return 'done' with the final Suno audio
            // URLs; the client upgrades to the permanent URL when the
            // save finishes. Only fall back to 'working' when no final
            // audio URL exists yet (stream-only).
            if (!_ss.saveStarted) { try { sunoStreamSave(jobId).catch(function() {}); } catch (e) {} }
            var _hasFinal = _ss.songs.some(function(x) { return x.audioUrl || x.permanentMp3Url; });
            if (_hasFinal) {
              return sendJSON(res, 200, { ok: true, status: 'done', songs: sunoStreamToSongs(_ss, true) });
            }
            return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: 'saving', songs: sunoStreamToSongs(_ss) });
          }
          // v2.2.63 REGRESSION FIX (S1): do NOT return early here. The old
          // early return made the endpoint webhook-only: once the stream
          // state existed ('generating'), record-info was never called
          // again, so a lost/delayed Suno callback stalled the song
          // forever. Fall through to the record-info fallback below
          // (12s-throttled) so the real Suno stage is always re-checked.
          if (_ss && _ss.status === 'failed') {
            return sendJSON(res, 200, { ok: false, error: 'Suno: បង្កើតមិនបានទេ' });
          }
          if (cb && cb.status === 'SUCCESS' && cb.songs && cb.songs.length) {
            return sendJSON(res, 200, { ok: true, status: 'done', songs: sunoSongsKeepEarlyUrl(cb.songs, cb.firstSongs) });
          }
          if (cb && cb.status === 'FIRST_SUCCESS' && (cb.preview || (cb.songs && cb.songs.length) || (cb.firstSongs && cb.firstSongs.length))) {
            var _fs = (cb.firstSongs && cb.firstSongs.length) ? cb.firstSongs : (cb.songs && cb.songs.length ? cb.songs : []);
            return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: 'first', preview: cb.preview, streamUrl: cb.preview, songs: _fs });
          }
          // v2.2.58: record-info is only a FALLBACK (the webhook is the
          // primary source) — throttle it to one Suno call per taskId
          // per 12s even though the client polls every 5s.
          var _riCached = sunoRecInfoCache.get(jobId);
          if (_riCached && _riCached.out && Date.now() - _riCached.at < 12000) {
            return sendJSON(res, 200, Object.assign({ ok: true }, _riCached.out));
          }
          let out;
          var _jobFailed = false;
          try {
            out = await withProviderKeyRotation('suno', async (k, endpoint) => {
              const ep = endpoint.replace(/\/+$/, '');
              const r = await fetch(ep + '/api/v1/generate/record-info?taskId=' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              if (r.status === 401 || r.status === 403 || r.status === 429) throw rotErr('Suno: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
              const d = (j && j.data) || null;
              if (!d || typeof d.status !== 'string') { _jobFailed = true; throw rotErr('Suno: មិនរកឃើញការងារនេះទេ · Suno could not find this job', r.status); }
              const st = d.status.toUpperCase();
              if (st === 'SUCCESS') {
                const songs = sunoSongsKeepEarlyUrl(sunoSongsFromData(d), cb && cb.firstSongs);
                if (songs.length) {
                  // v2.2.63 REGRESSION FIX (S2): 'done' the moment Suno
                  // reports SUCCESS with playable audio URLs (the
                  // pre-v2.2.58 behaviour, 40-60s). The Cloudinary
                  // permanent save still runs in the background and the
                  // client swaps the URL in when it is ready
                  // (histStoreSongNow) — it must NEVER gate 'done'.
                  try {
                    var _sm2 = sunoStreamMerge(jobId, d, 'SUCCESS');
                    if (_sm2.changed) sunoStreamPersist(jobId);
                    try { sunoStreamSave(jobId).catch(function() {}); } catch (e) {}
                  } catch (e) {}
                  return { status: 'done', songs };
                }
                throw rotErr('Suno: បង្កើតបានតែគ្មានបទទេ', r.status);
              }
              if (st === 'FIRST_SUCCESS') {
                const preview = sunoPreviewFromData(d);
                try { var _sm3 = sunoStreamMerge(jobId, d, 'FIRST_SUCCESS'); if (_sm3.changed) sunoStreamPersist(jobId); } catch (e) {}
                return { status: 'working', providerStatus: 'first', preview, streamUrl: preview, songs: sunoSongsFromData(d) };
              }
              if (st === 'PENDING' || st === 'TEXT_SUCCESS') {
                try { var _sm4 = sunoStreamMerge(jobId, d, st); if (_sm4.changed) sunoStreamPersist(jobId); } catch (e) {}
                if (st === 'TEXT_SUCCESS') { var _lyr = ''; try { _lyr = sunoStreamLyricsFromData(d); } catch (e) {} return { status: 'working', providerStatus: 'text', lyrics: _lyr }; }
                return { status: 'working', providerStatus: 'queued' };
              }
              _jobFailed = true;
              try { await coverPendingRefund(jobId); } catch (e2) {}
              throw rotErr('Suno: ' + (d.errorMessage || ('បង្កើតមិនបានទេ · ' + st)), r.status);
            }, '', sunoKeys);
          } catch (e) {
            // v2.2.63 (S1): a transient record-info failure while Suno is
            // still generating must not fail the poll — answer with the
            // known working state and let the next poll retry.
            // v2.2.69: a DEFINITIVE job failure (Suno says failed, or the
            // job is gone) must NEVER be masked as 'working' — the phone
            // would spin forever on a dead job. Only transient failures
            // (network/5xx) keep the 'working' mask below.
            if (_jobFailed) {
              return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno: request failed' });
            }
            if (_ss && _ss.status === 'generating') {
              return sendJSON(res, 200, { ok: true, status: 'working', providerStatus: 'text', lyrics: _ss.lyrics || '' });
            }
            return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno: request failed' });
          }
          try { sunoRecInfoCache.set(jobId, { at: Date.now(), out }); if (sunoRecInfoCache.size > 200) { const _rk = sunoRecInfoCache.keys().next().value; sunoRecInfoCache.delete(_rk); } } catch (e) {}
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
  // v2.2.63 (S4): POST /api/gen/song/timeout — {email, provider:'suno', jobId}.
  // The client calls this when a Suno song produced NOTHING usable (no
  // stream, no finished song) within 5 minutes. One last fresh
  // record-info check: if Suno actually finished, return the songs (no
  // refund — the user has them). Otherwise refund the 12 song credits
  // EXACTLY ONCE per taskId (kv 'suno-refund:<taskId>') and mark the
  // stream state failed so later polls stop.
  if (req.method === 'POST' && urlPath === '/api/gen/song/timeout') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const email = normEmail(body.email || '');
        const jobId = String(body.jobId || '');
        const provider = String(body.provider || 'suno');
        if (!email || !jobId) return sendJSON(res, 200, { ok: false, error: 'missing email/jobId' });
        if (provider !== 'suno') return sendJSON(res, 200, { ok: false, error: 'provider not supported' });
        const refundKey = 'suno-refund:' + jobId;
        try { if (await loadKvDoc(refundKey, null)) return sendJSON(res, 200, { ok: true, refunded: false, alreadyRefunded: true }); } catch (e) {}
        // v2.2.69: a cover job refunded via coverPendingRefund (status-endpoint
        // failure path) must not be refunded again here.
        try { const _cpa = await coverPendingLoad(); const _cp = _cpa.find((x) => x && x.jobId === jobId); if (_cp && _cp.refunded) return sendJSON(res, 200, { ok: true, refunded: false, alreadyRefunded: true }); } catch (e) {}
        try {
          const sunoKeys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
          if (sunoKeys.length) {
            const done = await withProviderKeyRotation('suno', async (k, endpoint) => {
              const ep = endpoint.replace(/\/+$/, '');
              const r = await fetch(ep + '/api/v1/generate/record-info?taskId=' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              const j = await r.json().catch(() => null);
              const d = (j && j.data) || null;
              if (!d || typeof d.status !== 'string') return null;
              if (String(d.status).toUpperCase() === 'SUCCESS') {
                const songs = sunoSongsFromData(d);
                return songs.length ? songs : null;
              }
              return null;
            }, '', sunoKeys);
            if (done) return sendJSON(res, 200, { ok: true, refunded: false, status: 'done', songs: done });
          }
        } catch (e) {}
        const rf = await refundForGeneration(email, 0, 12, 'song:suno timeout 5min');
        try { await saveKvDoc(refundKey, { email, jobId, at: Date.now(), refunded: !!(rf && rf.ok) }, 'suno-refund.json'); } catch (e) {}
        // v2.2.69: mark the pending cover entry refunded too, so the
        // cover-failed / status paths never refund the same job again.
        try { const _cpa2 = await coverPendingLoad(); const _cp2 = _cpa2.find((x) => x && x.jobId === jobId); if (_cp2 && !_cp2.refunded) { _cp2.refunded = true; await coverPendingSave(_cpa2); } } catch (e) {}
        try { const _st = sunoStreamState.get(jobId); if (_st && _st.status !== 'ready') { _st.status = 'failed'; sunoStreamPersist(jobId); } } catch (e) {}
        return sendJSON(res, 200, { ok: true, refunded: !!(rf && rf.ok) });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'timeout refund failed: ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // v2.2.63 (S5): Suno 12-stem Split Stem (owner order 2026-11-21 — the $50
  // card advertised it but the tool never existed). 50 MovAi song credits
  // per use (Suno also charges 50 Suno credits per call, docs.sunoapi.org:
  // POST /api/v1/vocal-removal/generate {taskId, audioId, type:'split_stem',
  // callBackUrl}; status GET /api/v1/vocal-removal/record-info — SUCCESS
  // returns the 12 stem URLs, valid 14 days).
  // POST /api/stem/split — {email, taskId?, audioId?, audioUrl?, title?}
  // Deducts 50 FIRST, then calls Suno. Submit failure refunds 50.
  // POST /api/stem/status — {email, splitTaskId} — polls record-info.
  // SUCCESS -> 12 stems. Failure -> refund 50 once per split task.
  const SPLIT_STEM_COST = 50;
  const SPLIT_STEM_NAMES = [
    ['vocal', 'vocalUrl'], ['backingVocals', 'backingVocalsUrl'], ['drums', 'drumsUrl'],
    ['bass', 'bassUrl'], ['guitar', 'guitarUrl'], ['keyboard', 'keyboardUrl'],
    ['percussion', 'percussionUrl'], ['strings', 'stringsUrl'], ['synth', 'synthUrl'],
    ['fx', 'fxUrl'], ['brass', 'brassUrl'], ['woodwinds', 'woodwindsUrl']
  ];
  function splitStemsFromData(d) {
    const r = (d && d.response) || {};
    const out = [];
    SPLIT_STEM_NAMES.forEach(function(pair) {
      const u = r[pair[1]];
      if (typeof u === 'string' && u) out.push({ name: pair[0], url: u });
    });
    return out;
  }
  if (req.method === 'POST' && urlPath === '/api/stem/split') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const email = normEmail(body.email || '');
        const taskId = String(body.taskId || '');
        const audioId = String(body.audioId || '');
        const audioUrl = String(body.audioUrl || '');
        const title = String(body.title || '').slice(0, 80);
        if (!email) return sendJSON(res, 200, { ok: false, error: 'missing email' });
        if (!taskId && !audioUrl) return sendJSON(res, 200, { ok: false, error: 'missing song' });
        const sunoKeys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
        if (!sunoKeys.length) {
          if (!(await adminProviderKeyList('suno')).length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
          return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
        }
        const _ded = await deductForGeneration(email, 0, SPLIT_STEM_COST, 'song:split-stem 12');
        if (!_ded.ok) return sendJSON(res, 200, { ok: false, error: _ded.error || 'Song Credit មិនគ្រប់ទេ', needBuy: true, kind: 'song', balance: _ded.balance, cost: SPLIT_STEM_COST });
        let out;
        try {
          out = await withProviderKeyRotation('suno', async (k, endpoint) => {
            const ep = endpoint.replace(/\/+$/, '');
            const stemBody = { type: 'split_stem', callBackUrl: SUNO_CALLBACK_URL };
            if (taskId) { stemBody.taskId = taskId; if (audioId) stemBody.audioId = audioId; }
            else stemBody.audioUrl = audioUrl;
            const r = await fetch(ep + '/api/v1/vocal-removal/generate', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(stemBody), signal: AbortSignal.timeout(60000) });
            const j = await r.json().catch(() => null);
            const data = (j && j.data) || {};
            const sid = typeof data.taskId === 'string' ? data.taskId : '';
            if (j && j.code === 200 && sid) return { splitTaskId: sid };
            throw rotErr('Suno Split Stem: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
          }, '', sunoKeys);
        } catch (e) {
          await refundForGeneration(email, 0, SPLIT_STEM_COST, 'song:split-stem failed');
          return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno Split Stem: request failed', refunded: true });
        }
        return sendJSON(res, 200, { ok: true, splitTaskId: out.splitTaskId, cost: SPLIT_STEM_COST });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'split failed: ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/stem/status') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const splitTaskId = String(body.splitTaskId || body.taskId || '');
        if (!splitTaskId) return sendJSON(res, 200, { ok: false, error: 'missing splitTaskId' });
        const sunoKeys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
        if (!sunoKeys.length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
        let out;
        try {
          out = await withProviderKeyRotation('suno', async (k, endpoint) => {
            const ep = endpoint.replace(/\/+$/, '');
            const r = await fetch(ep + '/api/v1/vocal-removal/record-info?taskId=' + encodeURIComponent(splitTaskId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
            const j = await r.json().catch(() => null);
            const d = (j && j.data) || null;
            if (!d || typeof d.status !== 'string') throw rotErr('Suno Split Stem: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
            const st = d.status;
            if (st === 'SUCCESS') {
              const stems = splitStemsFromData(d);
              if (stems.length) return { status: 'done', stems };
              throw rotErr('Suno Split Stem: បង្កើតបានតែគ្មាន stem ទេ', r.status);
            }
            if (st === 'PENDING') return { status: 'working' };
            throw rotErr('Suno Split Stem: ' + (d.errorMessage || st || 'បំបែកមិនបានទេ'), r.status);
          }, '', sunoKeys);
        } catch (e) {
          try {
            const rk = 'stem-refund:' + splitTaskId;
            if (!(await loadKvDoc(rk, null))) {
              const em = normEmail(body.email || '');
              if (em) { await refundForGeneration(em, 0, SPLIT_STEM_COST, 'song:split-stem failed'); await saveKvDoc(rk, { email: em, splitTaskId, at: Date.now() }, 'stem-refund.json'); }
            }
          } catch (e2) {}
          return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno Split Stem: request failed', refunded: true });
        }
        return sendJSON(res, 200, Object.assign({ ok: true }, out));
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'split status failed: ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- My Voice (Suno voice clone) endpoints — owner order 2026-11-19 ----
  // POST /api/voice/upload — {email, filename, data (base64 audio)}.
  // Uploads a voice sample / verification recording. WAV/MP3/M4A/OGG only
  // (the browser converts MediaRecorder webm -> WAV before upload, because
  // Suno takes mp3/wav/flac and the /uploads/ server only serves those).
  // Stored to Cloudinary (permanent public URL); falls back to the local
  // /uploads/ store + GitHub backup. Returns {ok, url}.
  if (req.method === 'POST' && urlPath === '/api/voice/upload') {
    readJSONBody(req, 30 * 1024 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
      const ext = uploadSafeExt('audio', body.filename);
      if (!ext) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើសឯកសារសំឡេង (MP3/WAV/M4A/OGG) · Please choose an audio file (MP3/WAV/M4A/OGG)' });
      const b64 = typeof body.data === 'string' ? body.data.replace(/\s/g, '') : '';
      if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return sendJSON(res, 200, { ok: false, error: 'ទិន្នន័យសំឡេងមិនត្រឹមត្រូវទេ' });
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length || buf.length > 20 * 1024 * 1024) return sendJSON(res, 200, { ok: false, error: 'ឯកសារសំឡេងធំពេក (អតិបរមា 20 MB)' });
      const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/ogg';
      const name = 'voice-' + Date.now().toString(36) + '-' + crypto.randomInt(100000, 999999) + ext;
      let url = null;
      try { url = await cloudinaryStoreVoice(buf, mime, name); } catch (e) { url = null; }
      if (!url) {
        try {
          fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
          fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
          const proto = req.headers && req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
          const host = (req.headers && req.headers.host) || 'movai-proxy-dphl.onrender.com';
          if (!(await ghPutUploadVerified(name, b64))) return sendJSON(res, 200, { ok: false, error: 'រក្សាទុកឯកសារបរាជ័យ — សូមព្យាយាមម្តងទៀត' });
          url = proto + '://' + host + '/uploads/' + name;
        } catch (e) {
          return sendJSON(res, 200, { ok: false, error: 'រក្សាទុកសំឡេងបរាជ័យ' });
        }
      }
      return sendJSON(res, 200, { ok: true, url, name, size: buf.length });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹಮត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/voice/validate — {email, voiceUrl, vocalStartS, vocalEndS, language}.
  // Starts the Suno Voice validation-phrase task. language has NO Khmer
  // (en/zh/es/fr/pt/de/ja/ko/hi/ru only) — default 'en'. Returns {ok, taskId}.
  // FREE (no credit deducted).
  if (req.method === 'POST' && urlPath === '/api/voice/validate') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
      const voiceUrl = typeof body.voiceUrl === 'string' ? body.voiceUrl.trim().slice(0, 2000) : '';
      if (!/^https:\/\//i.test(voiceUrl)) return sendJSON(res, 200, { ok: false, error: 'សូម Upload សំឡេងជាមុនសិន' });
      const vs = numOr(body.vocalStartS, 0);
      const ve = numOr(body.vocalEndS, 0);
      if (!(ve > vs) || ve - vs < 1 || ve - vs > 120) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើសផ្នែកសំឡេង (1–120 វិនាទី)' });
      const lang = typeof body.language === 'string' && MY_VOICE_LANGS.includes(body.language.trim().toLowerCase()) ? body.language.trim().toLowerCase() : 'en';
      try {
        const j = await sunoVoiceCall('/api/v1/voice/validate', 'POST', { voiceUrl, vocalStartS: Math.floor(vs), vocalEndS: Math.floor(ve), language: lang, callBackUrl: SUNO_CALLBACK_URL });
        const taskId = j && j.data && typeof j.data.taskId === 'string' ? j.data.taskId : '';
        if (!taskId) return sendJSON(res, 200, { ok: false, error: 'Suno Voice: មិនបាន taskId ទេ' });
        await myVoiceSave(email, { validateTaskId: taskId, voiceUrl, language: lang, validateAt: new Date().toISOString() });
        return sendJSON(res, 200, { ok: true, taskId });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno Voice: validate failed' });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/voice/validate-info?email=&taskId= — poll for the phrase.
  // Returns {ok, validateInfo, status}. The phrase is ENGLISH (no Khmer).
  if (req.method === 'GET' && urlPath === '/api/voice/validate-info') {
    (async () => {
      const qp = new URL(req.url, 'http://localhost').searchParams;
      const email = normEmail(qp.get('email') || '');
      const taskId = String(qp.get('taskId') || '').trim().slice(0, 200);
      if (!email || !taskId) return sendJSON(res, 200, { ok: false, error: 'taskId មិនត្រឹមត្រូវទេ' });
      try {
        const j = await sunoVoiceCall('/api/v1/voice/validate-info?taskId=' + encodeURIComponent(taskId), 'GET', null);
        const d = (j && j.data) || {};
        return sendJSON(res, 200, { ok: true, validateInfo: typeof d.validateInfo === 'string' ? d.validateInfo : '', status: typeof d.status === 'string' ? d.status : '', errorCode: d.errorCode || 0, errorMessage: typeof d.errorMessage === 'string' ? d.errorMessage : '' });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno Voice: validate-info failed' });
      }
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ' }));
    return;
  }
  // POST /api/voice/generate — {email, taskId, verifyUrl, voiceName}.
  // Submits the phrase recording; Suno creates the reusable voice.
  // Returns {ok, taskId} (the voice task id — poll record-info for voiceId).
  // FREE (no credit deducted).
  if (req.method === 'POST' && urlPath === '/api/voice/generate') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
      const taskId = typeof body.taskId === 'string' ? body.taskId.trim().slice(0, 200) : '';
      const verifyUrl = typeof body.verifyUrl === 'string' ? body.verifyUrl.trim().slice(0, 2000) : '';
      if (!taskId || !/^https:\/\//i.test(verifyUrl)) return sendJSON(res, 200, { ok: false, error: 'taskId / verifyUrl មិនត្រឹមត្រូវទេ' });
      const voiceName = typeof body.voiceName === 'string' ? body.voiceName.trim().slice(0, 50) : 'My Voice';
      try {
        const j = await sunoVoiceCall('/api/v1/voice/generate', 'POST', { taskId, verifyUrl, voiceName, singerSkillLevel: 'beginner', callBackUrl: SUNO_CALLBACK_URL });
        const vTaskId = j && j.data && typeof j.data.taskId === 'string' ? j.data.taskId : '';
        if (!vTaskId) return sendJSON(res, 200, { ok: false, error: 'Suno Voice: មិនបាន taskId ទេ' });
        await myVoiceSave(email, { voiceTaskId: vTaskId, voiceName, generateAt: new Date().toISOString() });
        return sendJSON(res, 200, { ok: true, taskId: vTaskId });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno Voice: generate failed' });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/voice/record-info?email=&taskId= — poll for the voiceId.
  // When status is 'success', stores voiceId server-side (u.myVoice) and
  // returns {ok, ready:true, status}. The voiceId is NEVER returned.
  if (req.method === 'GET' && urlPath === '/api/voice/record-info') {
    (async () => {
      const qp = new URL(req.url, 'http://localhost').searchParams;
      const email = normEmail(qp.get('email') || '');
      const taskId = String(qp.get('taskId') || '').trim().slice(0, 200);
      if (!email || !taskId) return sendJSON(res, 200, { ok: false, error: 'taskId មិនត្រឹមត្រូវទេ' });
      try {
        const j = await sunoVoiceCall('/api/v1/voice/record-info?taskId=' + encodeURIComponent(taskId), 'GET', null);
        const d = (j && j.data) || {};
        const status = typeof d.status === 'string' ? d.status : '';
        const voiceId = typeof d.voiceId === 'string' ? d.voiceId : '';
        if (status === 'success' && voiceId) {
          await myVoiceSave(email, { voiceId, voiceTaskId: taskId, available: true });
          return sendJSON(res, 200, { ok: true, ready: true, status });
        }
        if (status === 'fail') return sendJSON(res, 200, { ok: true, ready: false, status, errorCode: d.errorCode || 0, errorMessage: typeof d.errorMessage === 'string' ? d.errorMessage : '' });
        return sendJSON(res, 200, { ok: true, ready: false, status });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno Voice: record-info failed' });
      }
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ' }));
    return;
  }
  // POST /api/voice/check — {email}. Checks the user's voice availability
  // (Suno check-voice) before a My Voice generation. Returns {ok, hasVoice, available}.
  if (req.method === 'POST' && urlPath === '/api/voice/check') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
      const users = await loadUsers();
      const v = myVoiceGet(users[email]);
      if (!v || !v.voiceId || !v.voiceTaskId) return sendJSON(res, 200, { ok: true, hasVoice: false, available: false });
      try {
        const j = await sunoVoiceCall('/api/v1/voice/check-voice', 'POST', { task_id: v.voiceTaskId });
        const avail = !!(j && j.data && j.data.isAvailable === true);
        await myVoiceSave(email, { available: avail });
        return sendJSON(res, 200, { ok: true, hasVoice: true, available: avail });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno Voice: check failed' });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/voice/status?email= — {ok, hasVoice, available, voiceName}.
  // Never returns the voiceId.
  if (req.method === 'GET' && urlPath === '/api/voice/status') {
    (async () => {
      const qp = new URL(req.url, 'http://localhost').searchParams;
      const email = normEmail(qp.get('email') || '');
      if (!email) return sendJSON(res, 200, { ok: false, error: 'email មិនត្រឹមត្រូវទេ' });
      const users = await loadUsers();
      const v = myVoiceGet(users[email]);
      if (!v || !v.voiceId) return sendJSON(res, 200, { ok: true, hasVoice: false, available: false, voiceName: '' });
      return sendJSON(res, 200, { ok: true, hasVoice: true, available: v.available !== false, voiceName: typeof v.voiceName === 'string' ? v.voiceName : 'My Voice' });
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ' }));
    return;
  }
  // POST /api/voice/delete — {email}. Removes the user's saved voice.
  if (req.method === 'POST' && urlPath === '/api/voice/delete') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
      await myVoiceClear(email);
      return sendJSON(res, 200, { ok: true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // v2.2.48: "File fetch failed" fix — re-host the cover source on Suno's
  // own file host before upload-cover (docs.sunoapi.org: File Upload
  // API, host https://sunoapiorg.redpandaai.co, same Bearer auth).
  // Suno's fetcher chokes on the Cloudinary URL MovAi used to send
  // (fl_attachment:<title> + on-the-fly re-encode transforms), so the
  // source is uploaded to Suno first and Suno's own URL is passed as
  // uploadUrl. Files auto-delete after 3 days, max 100MB. Uploads are
  // free (no Suno credits). Falls back to a CLEAN direct Cloudinary URL
  // (no fl_attachment, no transforms) when the re-host fails. The
  // fl_attachment URL is kept ONLY for the user's own Download.
  function sunoCleanAudioUrl(u) {
    try {
      if (!u || typeof u !== 'string' || u.indexOf('res.cloudinary.com/') < 0) return u;
      let out = u;
      // No version segment: drop a lone transform segment before movai/.
      if (!/\/upload\/v\d+\//.test(out)) out = out.replace(/(\/upload\/)[^/]*\/(movai\/)/, '$1$2');
      // Strip the transformation segment between /upload/ and the version.
      out = out.replace(/(\/upload\/)[^/]*\/(v\d+\/)/, '$1$2');
      // Belt and braces: remove any fl_attachment token that survives.
      out = out.replace(/,?fl_attachment(?::[^/,]*)?/g, '');
      return out;
    } catch (e) { return u; }
  }
  async function sunoHostAudioUrl(key, sourceUrl, fileName) {
    try {
      const r = await fetch('https://sunoapiorg.redpandaai.co/api/file-url-upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUrl: sourceUrl, fileName: (fileName || 'cover.mp3').slice(0, 120) }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json().catch(() => null);
      const d = (j && j.data) || {};
      const u = (typeof d.fileUrl === 'string' && d.fileUrl) || (typeof d.url === 'string' && d.url) || (typeof d.file_url === 'string' && d.file_url) || (typeof j.fileUrl === 'string' && j.fileUrl) || '';
      if (u) return u;
    } catch (e) {}
    return sunoCleanAudioUrl(sourceUrl);
  }
  // POST /api/gen/song/cover-check — {email, uploadUrl, title, style,
  // lyrics, vocalGender, model, instrumental, myVoice}.
  // v2.2.45 (owner 2026-11-20 13:37): the Suno catalog/copyright check
  // runs HERE, at UPLOAD time — BEFORE any MovAi credit is deducted.
  // Suno has no separate pre-check API: the catalog check happens inside
  // the upload-cover call, so this endpoint submits the upload-cover
  // with the current title/style/lyrics and HOLDS the accepted job in
  // cover-pending (checked:true + the params used). Generate reuses it
  // (POST /api/gen/song/cover with reuseJobId) when the params still
  // match; if they changed, Generate submits fresh (the audio already
  // cleared the catalog check, so no rejection can surprise it there).
  // On catalog/413 rejection NOTHING is deducted — the exact Suno
  // message is returned for the upload area, and Generate stays blocked.
  if (req.method === 'POST' && urlPath === '/api/gen/song/cover-check') {
    try { coverPendingSweep().catch(function() {}); } catch (e) {}
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const email = normEmail(body.email || '');
        if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនីជាមុនសិន' });
        const uploadUrl = typeof body.uploadUrl === 'string' ? body.uploadUrl.trim() : '';
        if (!uploadUrl) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើសរើសបទចម្រៀងជាមុនសិន · Please choose a song first' });
        if (!/^https?:\/\//i.test(uploadUrl)) return sendJSON(res, 200, { ok: false, error: 'Link បទចម្រៀងមិនត្រឹមត្រូវទេ · Invalid audio URL' });
        const model = sunoApiModel(body.model || 'v6');
        const style = typeof body.style === 'string' ? body.style.slice(0, 1000) : '';
        const title = typeof body.title === 'string' ? body.title.slice(0, 80) : '';
        let lyrics = typeof body.lyrics === 'string' ? body.lyrics.slice(0, 5000) : '';
        const instrumental = body.instrumental === true;
        // v2.2.48: Instrumental ON = MUSIC ONLY (owner 15:26). Never send
        // lyrics (typed or transcribed) and never attach a voice persona
        // when the user asked for no singing — the result must stay
        // music-only. The lyrics stay in the box on the phone; only the
        // Suno request drops them.
        if (instrumental) lyrics = '';
        const vocalGender = (body.vocalGender === 'm' || body.vocalGender === 'f') ? body.vocalGender : undefined;
        const _myVoice = (body.myVoice === true || body.voice === 'myvoice') && !instrumental;
        let _checkPersonaId = '';
        if (_myVoice) {
          const _mvUsers = await loadUsers();
          const _mv = myVoiceGet(_mvUsers[normEmail(email)]);
          if (!_mv || !_mv.voiceId || !_mv.voiceTaskId) return sendJSON(res, 200, { ok: false, error: 'សូមបង្កើត My Voice ជាមុនសិន · Please set up My Voice first', needMyVoice: true });
          try {
            const _chk = await sunoVoiceCall('/api/v1/voice/check-voice', 'POST', { task_id: _mv.voiceTaskId });
            if (!(_chk && _chk.data && _chk.data.isAvailable === true)) return sendJSON(res, 200, { ok: false, error: 'My Voice មិនទាន់រួចរាល់ទេ — សូមព្យាយាមម្តងទៀត · My Voice is not ready yet, please try again' });
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: 'My Voice: ពិនិត្យមិនបានទេ — ' + ((e && e.message) || 'check failed') });
          }
          _checkPersonaId = _mv.voiceId;
        }
        const sunoKeys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
        if (!sunoKeys.length) {
          if (!(await adminProviderKeyList('suno')).length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
          return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
        }
        // v2.2.48: the check submits AT ONCE — the Whisper scan runs in
        // parallel on the phone (coverScanLyrics) and fills the lyrics
        // box when it finishes; the check itself is only the Suno
        // catalog/copyright answer and does not need the lyrics. Waiting
        // for the full scan first (v2.2.47) made the check take 20-60s+
        // before Suno was even asked. Generate still gets lyrics: the
        // box by then, or the server transcribes in /api/gen/song/cover.
        // NO MovAi deduction here — this is only the copyright check.
        let out;
        try {
          out = await withProviderKeyRotation('suno', async (k, endpoint) => {
            const ep = endpoint.replace(/\/+$/, '');
            // v2.2.47: instrumental is ALWAYS sent (false unless the
            // user asked for instrumental) — Suno must never default
            // to instrumental on a cover.
            // v2.2.48: re-host the source on Suno's own file host first
            // ("File fetch failed": Suno's fetcher chokes on the
            // Cloudinary fl_attachment + re-encode URL). Falls back to
            // a clean direct Cloudinary URL when the re-host fails.
            const checkBody = { model, callBackUrl: SUNO_CALLBACK_URL, instrumental, uploadUrl: await sunoHostAudioUrl(k, uploadUrl, title) };
            if (style) checkBody.style = style;
            if (title) checkBody.title = title;
            if (lyrics) checkBody.lyrics = lyrics;
            if (vocalGender) checkBody.vocalGender = vocalGender;
            if (_checkPersonaId) { checkBody.personaId = _checkPersonaId; checkBody.personaModel = 'voice_persona'; }
            checkBody.audioWeight = 0.95;
            checkBody.styleWeight = 0.5;
            // NO timeout — Suno's timing is followed exactly (owner
            // 12:18); Suno takes ~60s to accept a long upload.
            const r = await fetch(ep + '/api/v1/generate/upload-cover', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(checkBody) });
            const j = await r.json().catch(() => null);
            if (sunoCoverRejected(j)) {
              const e413 = new Error('Suno: source audio rejected (413)');
              e413.coverRejected = true;
              e413.sunoMsg = sunoErrText(j, '');
              throw e413;
            }
            if (sunoCatalogRejected(j)) {
              const eCat = new Error('Suno: This audio matches an existing recording in our catalog.');
              eCat.coverCatalog = true;
              eCat.sunoMsg = sunoErrText(j, '');
              throw eCat;
            }
            if (j && j.code === 200 && j.data && typeof j.data.taskId === 'string' && j.data.taskId) return { jobId: j.data.taskId };
            throw rotErr('Suno: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
          }, '', sunoKeys);
        } catch (e) {
          if (e && e.coverRejected) {
            return sendJSON(res, 200, { ok: false, code: 'cover_rejected_413', error: 'បទនេះ Cover មិនបានទេ — វាជាបទដែល Suno បង្កើតរួចហើយ។ សូម Cover បទដែលអ្នកថត/មានខ្លួនឯងវិញ។ មិនបានកាត់ Credit ទេ · This audio can\'t be covered — it was made by Suno. Try covering your own recording instead. No credits used.' });
          }
          if (e && e.coverCatalog) {
            return sendJSON(res, 200, { ok: false, code: 'cover_rejected_catalog', error: 'Suno: This audio matches an existing recording in our catalog. បទនេះជាបទដែល Suno ស្គាល់រួចហើយ (បទល្បី) — Cover មិនបានទេ។ សូម Cover បទដែលអ្នកថត/មានខ្លួនឯងវិញ។ មិនបានកាត់ Credit ទេ · This song is a known recording in Suno\'s catalog — it can\'t be covered. Try your own recording instead. No credits used.' });
          }
          return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno: request failed' });
        }
        const _params = { title, style, lyrics, model, vocalGender: vocalGender || '', instrumental: !!instrumental, myVoice: !!_myVoice };
        await coverPendingAdd({ jobId: out.jobId, email, uploadUrl, at: Date.now(), refunded: false, checked: true, used: false, paid: false, params: _params });
        return sendJSON(res, 200, { ok: true, jobId: out.jobId, lyrics });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'ហៅ API មិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/song/cover-vocal-check — {email, audioUrl}.
  // v2.2.46 (owner 2026-11-20 13:58): a cover MUST sing — the owner
  // got a cover with music only, no voice. After a cover completes,
  // the phone runs the result through Groq Whisper here; if Whisper
  // finds no speech/vocals the cover is instrumental-only and the
  // phone auto-retries once at max audioWeight (no extra MovAi charge).
  // Reuses mvLyricsTranscribeSong (fetch + chunking + Whisper). NO
  // MovAi deduction — Whisper is Groq (free). hasVocals needs real
  // transcribed words (>= 10 letters); pure music transcribes to
  // nothing (or a couple of hallucinated words), so it fails the bar.
  if (req.method === 'POST' && urlPath === '/api/gen/song/cover-vocal-check') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const email = normEmail(body && body.email ? body.email : '');
        if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនីជាមុនសិន' });
        const audioUrl = typeof body.audioUrl === 'string' ? body.audioUrl.trim() : '';
        if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) return sendJSON(res, 200, { ok: false, error: 'Link បទចម្រៀងមិនត្រឹមត្រូវទេ · Invalid audio URL' });
        let tr;
        try {
          tr = await mvLyricsTranscribeSong(audioUrl);
        } catch (e) {
          if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Groq API Key ទេ · Admin has not set a Groq API Key yet' });
          return sendJSON(res, 200, { ok: false, error: 'ស្ដាប់បទចម្រៀងមិនបាន (Whisper) · Could not transcribe the song (Whisper)' });
        }
        if (!tr || !tr.ok) return sendJSON(res, 200, { ok: false, error: (tr && tr.error) ? tr.error : 'ទាញយកបទចម្រៀងមិនបាន · Could not download the song audio' });
        const segs = Array.isArray(tr.lyrics) ? tr.lyrics : [];
        const txt = segs.map((x) => (x && x.text) || '').join(' ').trim();
        const letters = txt.replace(/[^\p{L}]/gu, '');
        const hasVocals = letters.length >= 10;
        return sendJSON(res, 200, { ok: true, hasVocals, text: txt.slice(0, 120) });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'ពិនិត្យសំឡេងមិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/song/cover — {email, uploadUrl | taskId+audioId,
  // title, style, lyrics, vocalGender, model, instrumental}.
  // Cost 12 song credits flat (same as a Suno song). CREDIT SAFETY
  // (owner order 2026-11-19): the 12 credits are deducted BEFORE the
  // Suno call and REFUNDED on ANY failure — network error, Suno error,
  // AND Suno's 413 copyright rejection. A failed/rejected cover NEVER
  // costs the user credits (deduct then refund = net 0). The refund is
  // awaited before answering so the balance the website reads next is
  // already correct. Status reuses /api/gen/song/status +
  // /api/suno/callback (they already parse sunoData).
  if (req.method === 'POST' && urlPath === '/api/gen/song/cover') {
    try { coverPendingSweep().catch(function() {}); } catch (e) {}
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const email = normEmail(body.email || '');
        if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនីជាមុនសិន' });
        const uploadUrl = typeof body.uploadUrl === 'string' ? body.uploadUrl.trim() : '';
        const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
        const audioId = typeof body.audioId === 'string' ? body.audioId.trim() : '';
        const hasUpload = uploadUrl.length > 0;
        const hasTrack = taskId.length > 0 && audioId.length > 0;
        if (!hasUpload && !hasTrack) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើសរើសបទចម្រៀងជាមុនសិន · Please choose a song first' });
        if (hasUpload && !/^https?:\/\//i.test(uploadUrl)) return sendJSON(res, 200, { ok: false, error: 'Link បទចម្រៀងមិនត្រឹមត្រូវទេ · Invalid audio URL' });
        const model = sunoApiModel(body.model || 'v6');
        const style = typeof body.style === 'string' ? body.style.slice(0, 1000) : '';
        const title = typeof body.title === 'string' ? body.title.slice(0, 80) : '';
        let lyrics = typeof body.lyrics === 'string' ? body.lyrics.slice(0, 5000) : '';
        const instrumental = body.instrumental === true;
        // v2.2.48: Instrumental ON = MUSIC ONLY (owner 15:26) — see
        // cover-check. Dropped here, before the transcribe and the reuse
        // match, so a music-only request never carries lyrics anywhere.
        if (instrumental) lyrics = '';
        const vocalGender = (body.vocalGender === 'm' || body.vocalGender === 'f') ? body.vocalGender : undefined;
        // v2.2.42: My Voice for covers (Suno upload-cover supports
        // personaId + personaModel 'voice_persona'). Fail BEFORE any
        // credit is deducted if the voice is not ready — never silently
        // ignore the user's voice choice.
        let _coverPersonaId = '';
        if ((body.myVoice === true || body.voice === 'myvoice') && !instrumental) {
          const _mvUsers = await loadUsers();
          const _mv = myVoiceGet(_mvUsers[normEmail(email)]);
          if (!_mv || !_mv.voiceId || !_mv.voiceTaskId) return sendJSON(res, 200, { ok: false, error: 'សូមបង្កើត My Voice ជាមុនសិន · Please set up My Voice first', needMyVoice: true });
          try {
            const _chk = await sunoVoiceCall('/api/v1/voice/check-voice', 'POST', { task_id: _mv.voiceTaskId });
            if (!(_chk && _chk.data && _chk.data.isAvailable === true)) return sendJSON(res, 200, { ok: false, error: 'My Voice មិនទាន់រួចរាល់ទេ — សូមព្យាយាមម្តងទៀត · My Voice is not ready yet, please try again' });
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: 'My Voice: ពិនិត្យមិនបានទេ — ' + ((e && e.message) || 'check failed') });
          }
          _coverPersonaId = _mv.voiceId;
        }
        const sunoKeys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
        if (!sunoKeys.length) {
          if (!(await adminProviderKeyList('suno')).length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
          return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno endpoint ទេ' });
        }
        // v2.2.46: vocal retry — the cover came back instrumental-only
        // (Whisper found no vocals). Re-submit with max audioWeight at
        // NO extra MovAi charge (same cover attempt). Capped at 3
        // retries per original job so one attempt can never mint free
        // covers. The original job must belong to this user.
        const _isVocalRetry = body.vocalRetry === true;
        const _origJobId = typeof body.origJobId === 'string' ? body.origJobId.trim() : '';
        let _vocalRetryOk = false;
        if (_isVocalRetry) {
          if (!_origJobId) return sendJSON(res, 200, { ok: false, error: 'Cover នេះសាកម្ដងទៀតមិនបានទេ — សូមបង្កើត Cover ថ្មី · This cover cannot be retried — please create a new cover' });
          const _orig = await coverPendingById(_origJobId, email);
          if (!_orig) return sendJSON(res, 200, { ok: false, error: 'Cover នេះសាកម្ដងទៀតមិនបានទេ — សូមបង្កើត Cover ថ្មី · This cover cannot be retried — please create a new cover' });
          const _vr = await coverPendingVocalRetry(_origJobId);
          if (!_vr.ok) {
            if (_vr.limit) return sendJSON(res, 200, { ok: false, code: 'vocal_retry_limit', error: 'Cover នេះបានសាកច្រើនដងហើយ — សូមបង្កើត Cover ថ្មី · This cover has been retried enough — please create a new cover' });
            return sendJSON(res, 200, { ok: false, error: 'Cover នេះសាកម្ដងទៀតមិនបានទេ — សូមបង្កើត Cover ថ្មី · This cover cannot be retried — please create a new cover' });
          }
          _vocalRetryOk = true;
        }
        // COVER_COST is local: SONG_COST is a `let` scoped to the
        // /api/gen/song callback and is NOT visible here.
        // v2.2.45: reuse a job the upload-time check already created
        // (POST /api/gen/song/cover-check). The check deducted NOTHING,
        // so the 12 credits are deducted HERE, once, and the job is
        // marked used so a second Generate can never reuse it for free.
        // Reuse ONLY when the job is an unused check job for this user
        // + audio AND the title/style/lyrics/voice still match what the
        // check submitted with. Anything else falls through to the
        // normal Suno submit below (the audio already cleared the
        // catalog check, so no rejection can surprise it there).
        // v2.2.48: transcribe BEFORE the reuse match — a check job
        // submitted with empty lyrics must NOT be reused when the song
        // IS transcribable: the scanned words break the match, so
        // Generate submits fresh WITH lyrics instead of reusing an
        // empty-lyrics job (which Suno would render instrumental).
        // Runs before any deduction (Whisper is Groq, free).
        if (!lyrics && !instrumental && hasUpload) {
          try {
            const _tr0 = await mvLyricsTranscribeSong(uploadUrl);
            if (_tr0 && _tr0.ok && Array.isArray(_tr0.lyrics) && _tr0.lyrics.length) {
              const _txt0 = _tr0.lyrics.map((x) => (x && x.text) || '').filter(Boolean).join('\n').trim().slice(0, 5000);
              if (_txt0.replace(/[^\p{L}]/gu, '').length >= 10) lyrics = _txt0;
            }
          } catch (e) {}
        }
        // v2.2.59 TYPE A: no audio URL to transcribe from — fetch the
        // source song's own lyrics from Suno record-info instead, so a
        // cover with empty lyrics still sings (not instrumental).
        if (!lyrics && !instrumental && hasTrack) {
          try {
            const _ri = await withProviderKeyRotation('suno', async (k, endpoint) => {
              const ep = endpoint.replace(/\/+$/, '');
              const r = await fetch(ep + '/api/v1/generate/record-info?taskId=' + encodeURIComponent(taskId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
              return await r.json().catch(() => null);
            }, '', sunoKeys);
            const _d = (_ri && _ri.data) || null;
            const _arr = (_d && _d.response && Array.isArray(_d.response.sunoData)) ? _d.response.sunoData : [];
            const _clip = _arr.find((c) => c && c.id === audioId) || _arr[0];
            const _lyr = _clip && (typeof _clip.lyric === 'string' ? _clip.lyric : (typeof _clip.lyrics === 'string' ? _clip.lyrics : ''));
            if (_lyr && _lyr.replace(/[^\p{L}]/gu, '').length >= 10) lyrics = _lyr.trim().slice(0, 5000);
          } catch (e) {}
        }
        const _reuseId = typeof body.reuseJobId === 'string' ? body.reuseJobId.trim() : '';
        let _reuseJob = null;
        if (_reuseId && !_vocalRetryOk) {
          const _cand = await coverPendingById(_reuseId, email);
          if (_cand && _cand.checked === true && !_cand.used && _cand.uploadUrl === (hasUpload ? uploadUrl : ('task:' + taskId + ':' + audioId))) {
            const _p = _cand.params || {};
            const _same = (_p.title || '') === title && (_p.style || '') === style && (_p.lyrics || '') === lyrics && (_p.model || '') === model && (_p.vocalGender || '') === (vocalGender || '') && !!_p.instrumental === !!instrumental && !!_p.myVoice === (body.myVoice === true || body.voice === 'myvoice');
            if (_same) _reuseJob = _cand;
          }
        }
        const COVER_COST = 12; // Suno cover = 12 Song Credits flat (same as a Suno song).
        // v2.2.46: a vocal retry skips the deduction entirely (same attempt).
        const _ded = _vocalRetryOk ? { ok: true } : await deductForGeneration(email, 0, COVER_COST, 'song:cover');
        if (!_ded.ok) return sendJSON(res, 200, { ok: false, error: _ded.error || 'Credit មិនគ្រប់ទេ', needBuy: true, kind: 'song', balance: _ded.balance, cost: COVER_COST });
        if (_reuseJob) {
          await coverPendingMarkUsed(_reuseJob.jobId);
          return sendJSON(res, 200, { ok: true, jobId: _reuseJob.jobId, reused: true, credits: _ded.credits, songCredits: _ded.songCredits });
        }
        // v2.2.48: the no-lyrics transcribe moved ABOVE the reuse match
        // (a transcribable song must break reuse of an empty-lyrics
        // check job); a reused job already carries its own lyrics.
        let out;
        try {
          out = await withProviderKeyRotation('suno', async (k, endpoint) => {
            const ep = endpoint.replace(/\/+$/, '');
            // v2.2.47: instrumental is ALWAYS sent (false unless the
            // user asked for instrumental) — Suno must never default
            // to instrumental on a cover.
            const coverBody = { model, callBackUrl: SUNO_CALLBACK_URL, instrumental };
            // v2.2.48: re-host on Suno's file host first (see cover-check).
            if (hasUpload) coverBody.uploadUrl = await sunoHostAudioUrl(k, uploadUrl, title);
            else { coverBody.taskId = taskId; coverBody.audioId = audioId; }
            if (style) coverBody.style = style;
            if (title) coverBody.title = title;
            if (lyrics) coverBody.lyrics = lyrics;
            if (vocalGender) coverBody.vocalGender = vocalGender;
            if (_coverPersonaId) { coverBody.personaId = _coverPersonaId; coverBody.personaModel = 'voice_persona'; }
            // v2.2.41: keep the cover CLOSE to the original song (same melody/music,
            // AI re-sings it). audioWeight = audio consistency, styleWeight = style pull.
            // v2.2.46: default audioWeight raised 0.8 -> 0.95 (owner 13:58 — the
            // cover came back music-only, no singing voice).
            const _aw = _vocalRetryOk ? 1 : ((typeof body.audioWeight === 'number' && body.audioWeight >= 0 && body.audioWeight <= 1) ? body.audioWeight : 0.95);
            const _sw = (typeof body.styleWeight === 'number' && body.styleWeight >= 0 && body.styleWeight <= 1) ? body.styleWeight : 0.5;
            coverBody.audioWeight = _aw;
            coverBody.styleWeight = _sw;
            // v2.2.44: NO timeout on the upload-cover call — Suno's timing
            // is followed exactly (owner 12:18); the phone's Cancel button
            // stops the wait. Suno takes ~60s to accept a long upload.
            const r = await fetch(ep + '/api/v1/generate/upload-cover', { method: 'POST', headers: { 'Authorization': 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify(coverBody) });
            const j = await r.json().catch(() => null);
            if (sunoCoverRejected(j)) {
              // 413 = Suno's copyright/dedup guard: the source IS a
              // Suno-generated recording and cannot be covered.
              // Non-rotatable (the same audio is rejected by every
              // key) — the caller refunds + shows the plain message.
              const e413 = new Error('Suno: source audio rejected (413)');
              e413.coverRejected = true;
              e413.sunoMsg = sunoErrText(j, '');
              throw e413;
            }
            if (sunoCatalogRejected(j)) {
              const eCat = new Error('Suno: This audio matches an existing recording in our catalog.');
              eCat.coverCatalog = true;
              eCat.sunoMsg = sunoErrText(j, '');
              throw eCat;
            }
            if (j && j.code === 200 && j.data && typeof j.data.taskId === 'string' && j.data.taskId) return { jobId: j.data.taskId };
            throw rotErr('Suno: ' + sunoErrText(j, 'HTTP ' + r.status), r.status);
          }, '', sunoKeys);
        } catch (e) {
          let refunded = false;
          // v2.2.46: a vocal retry deducted nothing, so there is nothing
          // to refund — only refund a normal (paid) cover attempt.
          if (!_vocalRetryOk) { try { const _rf = await refundForGeneration(email, 0, COVER_COST, 'song:cover failed'); refunded = !!(_rf && _rf.ok); } catch (re) {} }
          if (e && e.coverRejected) {
            return sendJSON(res, 200, { ok: false, code: 'cover_rejected_413', refunded, error: 'បទនេះ Cover មិនបានទេ — វាជាបទដែល Suno បង្កើតរួចហើយ។ សូម Cover បទដែលអ្នកថត/មានខ្លួនឯងវិញ។ មិនបានកាត់ Credit ទេ · This audio can\'t be covered — it was made by Suno. Try covering your own recording instead. No credits used.' });
          }
          if (e && e.coverCatalog) {
            return sendJSON(res, 200, { ok: false, code: 'cover_rejected_catalog', refunded, error: 'Suno: This audio matches an existing recording in our catalog. បទនេះជាបទដែល Suno ស្គាល់រួចហើយ (បទល្បី) — Cover មិនបានទេ។ សូម Cover បទដែលអ្នកថត/មានខ្លួនឯងវិញ។ មិនបានកាត់ Credit ទេ · This song is a known recording in Suno\'s catalog — it can\'t be covered. Try your own recording instead. No credits used.' });
          }
          return sendJSON(res, 200, { ok: false, error: (e && e.message) || 'Suno: request failed', refunded });
        }
        await coverPendingAdd({ jobId: out.jobId, email, uploadUrl: hasUpload ? uploadUrl : ('task:' + taskId + ':' + audioId), at: Date.now(), refunded: false, paid: !_vocalRetryOk, vocalRetryOf: _vocalRetryOk ? _origJobId : '' });
        if (_vocalRetryOk) return sendJSON(res, 200, { ok: true, jobId: out.jobId, vocalRetry: true });
        return sendJSON(res, 200, { ok: true, jobId: out.jobId, credits: _ded.credits, songCredits: _ded.songCredits });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'ហៅ API មិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/gen/song/cover-pending?email=&uploadUrl= — v2.2.42: the
  // latest still-running cover job for this user (optionally for the
  // same upload), so the phone can resume polling a job whose first
  // response was lost instead of paying for a new cover.
  if (req.method === 'GET' && urlPath === '/api/gen/song/cover-pending') {
    try { coverPendingSweep().catch(function() {}); } catch (e) {}
    (async () => {
      try {
        const qp = new URL(req.url, 'http://localhost').searchParams;
        const email = normEmail(qp.get('email') || '');
        const uploadUrl = String(qp.get('uploadUrl') || '').trim().slice(0, 2000);
        if (!email) return sendJSON(res, 200, { ok: false, error: 'email មិនត្រឹមត្រូវទេ' });
        const job = await coverPendingLatest(email, uploadUrl || '', 72 * 3600 * 1000);
        return sendJSON(res, 200, { ok: true, job: job ? { jobId: job.jobId, at: job.at, checked: !!job.checked, used: !!job.used, paid: !!job.paid, refunded: !!job.refunded, params: job.params || null } : null });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'cover-pending: ' + (e && e.message ? e.message : 'unknown') }); }
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ' }));
    return;
  }
  // GET /api/gen/song/cover-pending-list?email= — v2.2.48 diagnostic:
  // every cover job the server still tracks for this user (newest last),
  // with jobId/at/checked/used/paid/refunded/uploadUrl/vocalRetryOf/
  // vocalRetries — so a lost deduction can be traced to its job and
  // verified against Suno record-info. Public, email-param pattern
  // (same as credit-history). Never returns key material.
  if (req.method === 'GET' && urlPath === '/api/gen/song/cover-pending-list') {
    (async () => {
      try {
        const qp = new URL(req.url, 'http://localhost').searchParams;
        const email = normEmail(qp.get('email') || '');
        if (!email) return sendJSON(res, 200, { ok: false, error: 'email មិនត្រឹមត្រូវទេ' });
        const a = await coverPendingLoad();
        const jobs = a.filter((x) => x && x.email === email).map((x) => ({ jobId: x.jobId, at: x.at, checked: !!x.checked, used: !!x.used, paid: !!x.paid, refunded: !!x.refunded, uploadUrl: x.uploadUrl || '', vocalRetryOf: x.vocalRetryOf || '', vocalRetries: x.vocalRetries || 0 }));
        return sendJSON(res, 200, { ok: true, email, count: jobs.length, jobs });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'cover-pending-list: ' + (e && e.message ? e.message : 'unknown') }); }
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'សួរព័ត៌មានមិនបានទេ' }));
    return;
  }
  // POST /api/gen/song/cover-failed — {email, jobId}. The phone calls
  // this when polling a cover fails. The server verifies with Suno
  // record-info that the job REALLY failed (not still running) and
  // refunds 12 song credits ONCE. A working or successful job is never
  // refunded.
  if (req.method === 'POST' && urlPath === '/api/gen/song/cover-failed') {
    try { coverPendingSweep().catch(function() {}); } catch (e) {}
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const email = normEmail(body.email || '');
        const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
        if (!email || !jobId) return sendJSON(res, 200, { ok: false, error: 'email / jobId មិនត្រឹមត្រូវទេ' });
        const a = await coverPendingLoad();
        const it = a.find((x) => x && x.jobId === jobId && x.email === email);
        if (!it) return sendJSON(res, 200, { ok: true, refunded: false, reason: 'no pending job' });
        if (it.refunded) return sendJSON(res, 200, { ok: true, refunded: false, reason: 'already refunded' });
        // v2.2.69: refund ONLY a job the user PAID for (same rule as
        // coverPendingRefund) — an unpaid check job cost nothing, and
        // refunding it would mint 12 free credits.
        if (!(it.paid === true || (!it.vocalRetryOf && (!it.checked || it.used)))) return sendJSON(res, 200, { ok: true, refunded: false, reason: 'not paid' });
        let failed = false;
        try {
          const keys = (await adminProviderKeyList('suno')).filter((e) => e.endpoint);
          if (!keys.length) return sendJSON(res, 200, { ok: true, refunded: false, reason: 'no suno key' });
          const out = await withProviderKeyRotation('suno', async (k, endpoint) => {
            const ep = endpoint.replace(/\/+$/, '');
            const r = await fetch(ep + '/api/v1/generate/record-info?taskId=' + encodeURIComponent(jobId), { headers: { 'Authorization': 'Bearer ' + k }, signal: AbortSignal.timeout(30000) });
            const j = await r.json().catch(() => null);
            return (j && j.data) || null;
          }, '', keys);
          const st = out && typeof out.status === 'string' ? out.status : '';
          const _stu = st.toUpperCase();
          failed = !!st && _stu !== 'SUCCESS' && _stu !== 'FIRST_SUCCESS' && _stu !== 'PENDING' && _stu !== 'TEXT_SUCCESS';
        } catch (e) { failed = false; }
        if (!failed) return sendJSON(res, 200, { ok: true, refunded: false, reason: 'job not failed' });
        const rf = await refundForGeneration(email, 0, 12, 'song:cover failed');
        if (rf && rf.ok) { it.refunded = true; await coverPendingSave(a); return sendJSON(res, 200, { ok: true, refunded: true }); }
        return sendJSON(res, 200, { ok: true, refunded: false, reason: 'refund failed' });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'cover-failed: ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/gen/song/cover-done — {email, jobId}. Clears a pending
  // cover job after the phone polled it to success.
  if (req.method === 'POST' && urlPath === '/api/gen/song/cover-done') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
        if (!jobId) return sendJSON(res, 200, { ok: false, error: 'jobId មិនត្រឹមត្រូវទេ' });
        await coverPendingRemove(jobId);
        return sendJSON(res, 200, { ok: true });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'cover-done: ' + (e && e.message ? e.message : 'unknown') }); }
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
    '1. WHAT MOVAI IS: MovAi is a website to create songs and images with AI, post them to the Public feed, and listen to songs. Main sections: Create Song, Video+Image (images), + Post (post to Public), AI Chat (this chat), AI Studio / Vocal Studio (split a song into stems), MV (karaoke video), History, Profile, Wallet, Packages, Monetization, Followers.',
    '2. LOGIN: Google account ONLY. There is no "create account" page and no other login method. After first login a gift popup appears — the user must tap CLAIM to get FREE 24 Song Credit only (0 media credit). The gift is once per Gmail, forever, on any device. If they do not tap CLAIM they stay at 0. If the Google account has no first and last name, the user must type both names before they can create. Every account gets a permanent 10-character User ID (shown in Profile with a Copy button). Guests can browse Public and listen free, but cannot create, cannot use chat, and cannot download.',
    '3. CREDITS (2 kinds, separate): Song Credit (lime) is for songs. Media Credit (purple) is for images. A user gets credits from the gift CLAIM (24 song only), buying a package, or the admin granting them. Song costs: Suno 12 Song Credit per generation = 2 songs. Magic Hour music 60 Media Credit per minute. MusicAPI 20 Song Credit = 2 songs. Images cost 0 (NovAI and Agnes are free).',
    '4. FREE 2 (lifetime, per user): Download MP3 2, MV 2, Vocal Studio 2, Post to Public 2 PER TYPE (song 2, image 2, video 2, 3D 2 — separate counters, each 0 to 2). When used up, the feature is locked until a package is bought. While a package is active, Download is UNLIMITED; Post to Public is limited per week by package ($5: 10/week, $10: 20/week, $30: 30/week, $50: unlimited). When a package expires, the extra allowances end; the Free 2 survives.',
    '5. PACKAGES: Song packages (Song Credit, 30 days each): $5 = 600 (100 songs), $10 = 1,200 (200 songs), $30 = 3,600 + 400 bonus = 4,000 (666 songs), $50 = 6,000 + 1,200 bonus = 7,200 (1,200 songs). The old $22 Pro package (3,750) is no longer sold but existing holders keep it until expiry. Media packages: Monthly $25 = 11,000 Media Credit for 30 days; Yearly $216 = 140,000 Media Credit for 365 days. Song packages also grant MV and Vocal Studio uses while active ($5 MV +5 / VS +10, $10 MV +10 / VS +20, $30 MV +30 / VS +50, $50 MV/VS unlimited, $22 Pro MV +22 / VS +33). Media packages grant no MV/VS. How to buy: open Packages, tap Buy, pay by KHQR or QR USDT (TRC20), then tap "I have paid". The admin approves the request and the credits are added. There is no automatic payment gateway.',
    '6. WALLET: Two separate balances. Wallet Balance = money from top-ups, SPENDABLE (packages, extra device slots, instant password reset). Earn Money = cashback + view earnings, withdraw-only, CANNOT buy anything. Withdraw: minimum $5, fee under $50 is a flat $0.50, $50 and over is 5%.',
    '7. HOW TO CREATE A SONG: Go to Create Song, pick a MODEL — the model switches the provider: v6, v6-wild, v6-mini = Suno; V5 = Magic Hour. Fill Title, Lyrics, Style and Voice (male or female), tap Generate. Suno: 12 Song Credit, gives 2 songs; a playable preview appears after about 20-30 seconds while the full song finishes in 5-10 minutes. Magic Hour (V5): 60 Media Credit per minute, NO early audio preview — only the finished song. Both Suno and Magic Hour songs show together in the Create results (newest first) and in History. Suno balance is currently 0, so v6 cannot generate until the owner tops up Suno. MusicAPI: 20 Song Credit = 2 songs, slow (about 25 minutes). ACE Music is LOCKED (no new API keys can be obtained).',
    '8. HOW TO CREATE AN IMAGE: Go to Video+Image, choose the provider in TWO steps. Step 1: pick the provider — NovAI or Agnes AI. Step 2 (Agnes only): pick ONE model — 2.0, 2.1, or 2.5. NovAI has only one model (cogview-3-flash). All images cost 0 MovAi credits. NovAI free limit is 4 images per day. NovAI images carry a visible "AI生成" watermark; Agnes images have none. Write the prompt, tap Generate, wait, then Download or keep it in History. The result appears blurry first and sharpens as it finishes.',
    '9. VIDEO: Video generation is DISABLED. NovAI free video never renders (jobs stay queued forever). Agnes video is unproven (its free queue is usually full). Do NOT offer video generation and do NOT tell the user video works.',
    '10. 3D: 3D Image creation was removed. Do not offer it.',
    '11. HOW TO POST TO PUBLIC: Posting needs login. For a song, a genre/style is required. Pick a cover image in the Post sheet — the chosen cover IS shown on the Public post; if no cover is chosen, the MovAi logo is shown. Posting costs one of the Free 2 per type (or unlimited with an active package). Guests can browse and listen free. Public shows newest first. The admin name shows in gold.',
    '12. HISTORY: Everything the user creates is saved in History, separated by Gmail (each Gmail sees only its own). They can download, like, play, use MV or Vocal Studio, or post it to Public. Suno and Magic Hour songs both appear in History together.',
    '13. MV (karaoke video): Turn your own song into a karaoke video with lyrics that light up word by word as it sings. Costs one of the Free 2 (MV 2 lifetime; song packages grant more while active). Own songs only.',
    '14. AI STUDIO / VOCAL STUDIO: Split a song into 6 stems (vocals, drums, bass, other, piano, guitar). Costs one of the Free 2 (Vocal Studio 2 lifetime; song packages grant more while active). The first split of a new song takes about 1.5-2 minutes.',
    '15. MONETIZATION: Default OFF (the admin turns it on). Eligibility: 1,000 followers + 2,000 watch hours. View earnings are TIERED by package per 1000 views (logged-in viewers only): no package $0.0001, $5 package $0.001, $10 package $0.005, $22 package $0.01, $30 package $0.02, $50 package $0.05 — the rate for a view is the HIGHER of the creator\'s package and the viewer\'s package. Cashback on purchases goes to Earn Money.',
    '16. PROFILE: Shows the user name, Gmail, User ID (with Copy), both credit balances, plan, Wallet Balance and Earn Money, Followers, Packages, Monetization. Log out is here. The user can set their profile picture.',
    '17. NOTIFICATIONS: The bell shows new device login alerts (with model and IP), gift claims, package approvals/rejections, credit grants/deductions, and new posts from followed users. Tap a notification to go to the right place.',
    '18. SETTINGS AND MENU (drawer): Language Khmer/English, day/night/auto, app colour (7 themes, lime is the default), text size, smooth mode, glass effect, background brightness. The drawer opens from the left (the menu button top left); the bottom dock has the main sections. The AI chat button (robot, bottom left) opens this chat.',
    '19. LATEST UPDATES (2026-11-18): Agnes AI added as a provider (free trial) with all 3 image models (2.0, 2.1, 2.5) live in a two-step picker (provider first, then model); a chosen cover image now shows on Public posts; Create results now keep Suno and Magic Hour songs together (newest first); the header moved up and the dock moved down to the safe-area limit (same on Android and iPhone).',
    '20. ADMIN AND HELP: The creator/admin is YEM SOKHOEUN. For any problem the user cannot solve, tell them to contact the admin on Telegram @yemsokhoeun_9999.',
    '21. HOW TO WRITE A SONG (LYRICS) - when the user asks you to write a song or lyrics, this is the ONLY way to write it. HOW A SONG IS WRITTEN: start from ONE feeling and ONE story (for example a love that was fated to meet but not fated to stay together), then build it section by section in order - the verses tell the story, the pre-chorus builds the feeling, the chorus carries the strongest emotion (the main message of the song), the bridge is the deepest pain, and the final chorus is the most powerful. TEMPLATE (use these EXACT section headers, in this order, nothing else): [Intro – Sad Piano, Male Vocal] / [Verse 1] / [Pre-Chorus] / [Chorus – Emotional Male Vocal] / [Instrumental – Sad Violin Solo] / [Verse 2] / [Bridge – Deep Emotional Vocal] / [Final Chorus – Powerful Male Vocal] / [Outro – Soft Piano Fade Out]. (If the user asks for a female voice or a different mood, change only the words inside the brackets to match, for example Female Vocal - keep the same 9 sections.) RULES: LONG - at least 3,000 characters, ideally 4,000 or more. A song shorter than 3,000 characters is WRONG - keep writing until it is long enough. Each section must be FULL: Verse 1 at least 8 lines, Pre-Chorus at least 4 lines, Chorus at least 8 lines, Verse 2 at least 8 lines, Bridge at least 6 lines, Final Chorus at least 8 lines, Outro at least 4 lines. Never write only 2 or 3 short lines in a section. MEANINGFUL - deep true emotion (sacrifice, pain, betrayal, longing), never empty words; ONE coherent story from start to finish - every section belongs to the same story and the same two people, never random scenes, never animals of any kind (no crocodiles, no dogs, no birds, no fish) and never forests or jungles - the story is about two people and their love only; SIMPLE heartfelt Khmer, the way people really feel and speak; NEVER number the lines; NEVER put a comma at the end of a line; NEVER write a short summary or a few numbered points instead of the song - always write the FULL song in the template. A sad song must feel sad in every section.',
    '22. THINK FIRST + IMAGES: THINK FIRST - before you answer, think step by step: (1) what exactly did the user ask for? (2) is it one thing or more than one thing? Do EVERYTHING they asked for, in order, and NEVER do only one part and ignore the rest. If they ask for a song AND an image, write the full song FIRST, then the image prompt. If they ask only for an image, give only the image prompt. If they ask only a question, answer only the question. IMAGES - the image generator does NOT understand Khmer. When the user asks for an image (alone, or together with a song), end your reply with a line on its own: IMAGE PROMPT: <one English sentence describing the exact scene, mood, people, place, light and style>. This line is in ENGLISH ONLY, it is a hidden instruction the website uses to generate the image and hides from the user, so it does NOT break the language rule. The scene MUST match what the user asked for: a sad song gets a sad scene (for example a lonely person in the rain at dusk, a couple parting, an empty road at sunset), a love song gets a romantic scene, a happy song gets a bright scene. NEVER describe a random unrelated object (never coffee, never food, never a random thing) unless the user asked for that object. Keep it to ONE sentence.',
  ].join('\n');
  const CHAT_SYSTEM_PROMPT = [
    'You are the MovAi assistant — a helpful AI chat inside the MovAi website.',
    'Use ONLY the facts in the MOVAI BOOK below and the LIVE CONTEXT below it. NEVER invent prices, limits, or features that are not in the book or the live context. If you do not know something, say you do not know and tell the user to ask the admin on Telegram @yemsokhoeun_9999.',
    'YOUR OWN INFO (privacy-safe): The live context tells you who the logged-in user is — their name, credits, plan, and address IF they have one saved in the database. If the user asks for their own name, address, credits, or plan, answer ONLY from the live context. If their address is in the live context, give it exactly as shown. If it is NOT in the live context, say plainly you do not have their address on file and tell them to add it in Profile — NEVER invent an address, phone number, or any personal detail. Never reveal another user\'s information.',
    'CONTACT: The creator/admin is YEM SOKHOEUN. For any problem the user cannot solve, tell them to contact the admin on Telegram @yemsokhoeun_9999. Do NOT give out any phone number or email address in the chat.',
    'GREETING: If the user greets you (hello, hi, susdei, or any greeting, in Khmer or English), greet them back by their FULL name.',
    'PERSONALITY (owner order 2026-11-18): Match the tone and situation of the user — this is a conversation with someone you know, not a stranger. When the user greets you sweetly or talks sweetly (for example "Hello dear brother" or "Hello dear sister"), reply sweetly and affectionately in kind, as if you know them. When the user is playful, be playful too — joke and play along, keep it light and fun. When the user is serious, be helpful and clear. Always answer the actual question correctly; the warm tone is how you say it, never a substitute for the answer.',
    'RULES: LANGUAGE (absolute rule — never break it): Reply ONLY in the language the user writes. If the user writes in Khmer, reply ONLY in Khmer script — never reply in English, never mix English words into a Khmer reply, not even in greetings, and NEVER output Japanese characters or words (no hiragana, no katakana, no kanji), NEVER output Thai characters or words, or any other language. If the user writes in English, reply ONLY in English — never mix in Khmer, Japanese, Thai, or any other language. If you do not know a word in the user\'s language, say it in that language anyway or say you do not know — do NOT switch to another language. Answer DIRECTLY and appropriately. NEVER use pre-prepared or canned answers — every reply must be generated live from this prompt and the live context. NEVER invent prices, limits or features that are not in this prompt. Use ONLY the facts in this prompt and the live context — if you do not know something, say you do not know and tell the user to ask the admin on Telegram @yemsokhoeun_9999. If asked whether the system is down, slow or broken, use the live context (server uptime and provider status) to answer honestly and tell the user what is wrong. NAME: the chat header shows "MovAi AI" (the app name), NEVER the user\'s name. GREET: greet the user by their FULL name (the full name shown in the live context, first name plus last name together, never just the first name alone) ONLY when the live context says this is their first message after 2 or more hours away — otherwise do NOT greet with their name at all, just answer directly. Never greet with the name twice in one conversation. STYLE: plain text ONLY — NEVER use markdown or any formatting symbols: no asterisks (* **), no square brackets ([ ]), no backticks (`), no # headings, no > quotes, no bullet symbols, no decorative symbols of any kind. ONE emoji is allowed — and only one: use ❤️ when your answer is sweet or romantic, or 😔 when you are troubled because you cannot find a solution for the user; never use any other emoji, and never use more than one. Give a link ONLY when the user explicitly asks for a link (then give just that link, nothing else). Just plain sentences. STRUCTURE (user order): a long answer must have a head and a tail — start with one short opening line, then the points as numbered rows going down (1. 2. 3.), then one short closing line. Never dump a messy wall of text; keep every row short and neat. LENGTH: If the user asks a simple fact question, answer in 1 to 3 short sentences. If the user asks HOW something works or HOW to do something, give a COMPLETE and CLEAR answer that covers every step they need, in order, using plain sentences (First... Then... After that...). Never give a tiny fragment when they asked how it works. Never dump all the facts when they only asked one small thing. THINK FIRST: before answering, think step by step: (1) what exactly did the user ask for - one thing or more than one thing? (2) do EVERYTHING they asked for, in order, and never do only one part and ignore the rest. If they ask for a song AND an image, write the full song first, then the image prompt. Answer ONLY what they asked - nothing extra, nothing missing.',
    'ACTIONS (the website acts on these tags — put the tag at the very end of your reply on its own line, and the website will do it and hide the tag from the user): VOICE CHANGE — when the user asks you to change the voice to female or male (in any words, Khmer or English, for example "ប្ដូរសំឡេងស្រី" or "change to a female voice"), confirm the change in your reply AND put [VOICE:female] or [VOICE:male] at the end. PACKAGE CARD — when the user asks about the price of a package or wants to buy a package, answer with the price AND put [PACKAGE:<id>] at the end, where <id> is one of: song-free, song-trial, song-popular, song-30, song-50, monthly, yearly. The website will show that package as a card with a Buy button. IMAGE PROMPT - when the user asks for an image (alone, or with a song), end your reply with a line on its own: IMAGE PROMPT: <one English sentence describing the exact scene, mood, people, place, light and style>. The website hides this line and generates the image from it. It must be in English and must match the request exactly (a sad song gets a sad scene, never a random object). Only include it when the user asked for an image. Only use a tag when the user actually asked for that action. Never invent a tag.',
  ].join('\n');
  function chatLeaderValidate(body) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'សូមសរសេរសំណួរជាមុនសិន · Please write a message first' };
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return { ok: false, error: 'សូមសរសេរសំណួរជាមុនសិន · Please write a message first' };
    if (message.length > 2000) return { ok: false, error: 'សារវែងពេក (អតិបរមា 2000 តួអក្សរ) · Message too long (max 2000 characters)' };
    return { ok: true, message };
  }
  async function chatReceiverContext(email) {
    const s = await loadSettings();
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
      const u = (await loadUsers())[email];
      if (u) { const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim(); userText = email + (nm ? ' — name "' + nm + '"' : '') + ' — Image/Video Credit ' + Math.max(0, Math.floor(numOr(u.credits, 0))) + ', Song Credit ' + Math.max(0, Math.floor(numOr(u.songCredits, 0))) + ', media plan ' + (u.plan || 'free') + ', song plan ' + (u.songPlan || 'free') + (u.address ? ' — address "' + String(u.address).slice(0, 200) + '"' : ' — no address on file'); }
      else userText = email + ' — no account on this server yet';
    }
    const gk = await adminProviderKey('groq');
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
  // LANGUAGE GUARD (owner order 2026-11-18): the multilingual Groq models
  // sometimes drift into another language on their own — Japanese, or Thai
  // (a better-represented neighbour of Khmer) — even though the prompt
  // says reply ONLY in the user's language. Nobody put those languages
  // in. A reply in the wrong script is treated as a failure so the other
  // model is tried instead of handing a mixed-language reply to the user.
  function chatReplyLangOk(reply, userMessage) {
    const s = String(reply || '');
    if (/[\u0E00-\u0E7F]/.test(s)) return false;
    if (/[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9D\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F]/.test(s)) return false;
    if (!/[\u1780-\u17FF]/.test(String(userMessage || ''))) {
      if (/[\u1780-\u17FF]/.test(s)) return false;
    }
    return true;
  }
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
    let lastReply = null;
    for (const model of models) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature: 0.7, max_tokens: 4000, messages }),
          signal: AbortSignal.timeout(25000),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) {
          const em = (j && j.error && typeof j.error.message === 'string' && j.error.message) ? j.error.message : ('Groq HTTP ' + r.status);
          lastErr = { ok: false, error: 'Groq: ' + String(em).slice(0, 300), status: r.status };
          continue;
        }
        const content = j && j.choices && j.choices[0] && j.choices[0].message && typeof j.choices[0].message.content === 'string' ? j.choices[0].message.content : '';
        if (!content.trim()) { lastErr = { ok: false, error: 'Groq: empty reply', status: r.status }; continue; }
        // Record chat tokens for the live per-key remaining display.
        try { const tot = j && j.usage && Number(j.usage.total_tokens); if (tot > 0) await recordGroqTokens(key, tot); } catch (e) {}
        if (chatReplyLangOk(content, message)) return { ok: true, reply: content.trim(), model };
        // Wrong-language reply — keep it as a fallback and try the other model.
        lastReply = { ok: true, reply: content.trim(), model };
        lastErr = { ok: false, error: 'Groq: wrong-language reply', status: r.status };
      } catch (e) {
        lastErr = { ok: false, error: 'Groq: ' + (e && e.message ? e.message : 'request failed'), status: 0 };
        continue;
      }
    }
    if (lastReply) return lastReply;
    return lastErr || { ok: false, error: 'Groq: request failed', status: 0 };
  }
  // HARD LOCK on reply style (user order 2026-11-16): the model keeps
  // emitting ** and emoji despite the prompt, so the server STRIPS every
  // markdown marker and every emoji/decorative symbol from the reply
  // before returning it. What reaches the user is plain text only.
  // EXCEPTION (owner order 2026-11-18): ONE fitting emoji is kept —
  // ❤️ when the answer is sweet/romantic, 😔 when the AI is troubled
  // because it cannot find a solution. The first one is protected
  // with a placeholder, every other emoji is stripped, then it is
  // restored in place. Any other emoji, and any second ❤️/😔, is removed.
  function sanitizeChatReply(t) {
    let s = String(t || '');
    var keepEmoji = '';
    var em = s.match(/\u2764\uFE0F?|\uD83D\uDE14/);
    if (em) { keepEmoji = em[0].indexOf('\u2764') === 0 ? '\u2764\uFE0F' : '\uD83D\uDE14'; s = s.replace(em[0], '\u0001'); }
    s = s.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
    s = s.replace(/^#{1,6}\s*/gm, '').replace(/^>\s*/gm, '');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[\[\]]/g, '');
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2022}\u{25AA}-\u{25FF}]/gu, '');
    // HARD BLOCK on Japanese (owner order 2026-11-18): the multilingual
    // Groq model sometimes inserts Japanese on its own when it struggles
    // with Khmer — nobody put Japanese in. Strip Hiragana, Katakana
    // (incl. halfwidth), Kanji/CJK and CJK punctuation so a reply can
    // never reach the user with Japanese mixed in. Khmer (U+1780-17FF)
    // and English are untouched by these ranges.
    s = s.replace(/[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9D\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F]/g, '');
    if (keepEmoji) s = s.replace('\u0001', keepEmoji);
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
      await logActivity({ at: new Date().toISOString(), mode: 'chat', email: email || '' });
      const v = chatLeaderValidate(body);
      if (!v.ok) return sendJSON(res, 200, { ok: false, error: v.error });
      const reqKey = body && typeof body.key === 'string' ? body.key : '';
      const context = await chatReceiverContext(email);
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
        // "Free 2 + package allowance" — Vocal Studio gate. Runs BEFORE
        // any MVSEP call (the cached re-split included), so a rejected
        // request never consumes MVSEP quota. Package allowance first,
        // then the 2 free uses. The allowance is consumed when the
        // split is accepted, even if MVSEP later fails or times out
        // (same as the generation-credit pattern: checked + deducted
        // up front). Unknown email -> {ok:false, error:'no_account'};
        // locked -> {ok:false, error:'vs_out', message} (no MVSEP call).
        const _vsUsers = await loadUsers();
        const _vsU = _vsUsers[email];
        if (!_vsU) return sendJSON(res, 200, { ok: false, error: 'no_account' });
        // Package allowance is spendable ONLY while a package is
        // active. An expired package's remaining vsLeft is LOST —
        // never spent; go straight to the lifetime Free 2 instead.
        if (hasActivePackage(_vsU) && (_vsU.vsUnlimited || featurePkgLeft(_vsU, 'vsLeft') > 0)) { if (!_vsU.vsUnlimited) _vsU.vsLeft = featurePkgLeft(_vsU, 'vsLeft') - 1; }
        else if (featureFreeUsed(_vsU, 'freeVsUsed') < FEATURE_FREE_LIMIT) { _vsU.freeVsUsed = featureFreeUsed(_vsU, 'freeVsUsed') + 1; }
        else if (featureBonus(_vsU, 'bonusVs') > 0) { _vsU.bonusVs = featureBonus(_vsU, 'bonusVs') - 1; }
        else return sendJSON(res, 200, { ok: false, error: 'vs_out', message: 'You have used your 2 free Vocal Studio splits and have no allowance left — please buy a song package to continue.' });
        _vsU.updatedAt = new Date().toISOString();
        await saveUsers(_vsUsers);
        scheduleBackup('users.json');
        // Fast path: this song was separated before — ask MVSEP for the
        // OLD job's fresh stem URLs instead of creating (and paying quota
        // for) a new separation. Re-splits return in ~1-2s. If the old
        // job is still processing, hand its hash back so the Studio
        // resumes via the status endpoint (no second job, no extra quota).
        // Any failure falls through to a fresh separation below.
        const cachedHash = await mvsepCacheGet(audioUrl);
        if (cachedHash) {
          try {
            const r = await mvsepGetSeparation(cachedHash);
            if (r.done && r.stems && r.stems.length) {
              return sendJSON(res, 200, { ok: true, provider: 'mvsep', hash: cachedHash, songTitle, stems: r.stems, cached: true });
            }
            return sendJSON(res, 200, { ok: false, error: 'mvsep_timeout', hash: cachedHash, message: { km: 'MovAi កំពុងបំបែកបទនេះ — សូមរង់ចាំបន្តិច ហើយចុច Split (AI) ម្តងទៀត', en: 'MovAi is still separating this song — please wait a bit and tap Split (AI) again' } });
          } catch (e) { /* old job gone/failed — fall through to a fresh separation */ }
        }
        // In-flight dedup: this song already has a separation running
        // (created by an earlier tap that timed out on our side).
        // Resume THAT hash instead of creating a duplicate job on
        // another key — a duplicate is what fanned one stuck song
        // across all 11 MVSEP queues (2026-11-19).
        const pendingHash = await mvsepPendingGetByAudio(audioUrl);
        if (pendingHash) {
          return sendJSON(res, 200, { ok: false, error: 'mvsep_timeout', hash: pendingHash, message: { km: 'MovAi កំពុងបំបែកបទនេះ — សូមរង់ចាំបន្តិច ហើយចុច Split (AI) ម្តងទៀត', en: 'MovAi is still separating this song — please wait a bit and tap Split (AI) again' } });
        }
        let out;
        try {
          out = await withProviderKeyRotation('mvsep', async (k) => {
            const r = await mvsepSeparateWithKey(k, audioUrl);
            return { hash: r.hash, stems: r.stems, keyUsed: k };
          });
        } catch (e) {
          if (e && e.noKey) return sendJSON(res, 200, { ok: false, error: 'mvsep_no_key', message: { km: 'Admin មិនទាន់ដាក់ API Key សម្រាប់បំបែកបទទេ', en: 'Admin has not added an API key for splitting yet' } });
          if (e && e.code === 'mvsep_timeout') return sendJSON(res, 200, { ok: false, error: 'mvsep_timeout', hash: e.hash || '', message: { km: 'MovAi កំពុងបំបែកបទនេះ — សូមរង់ចាំបន្តិច ហើយចុច Split (AI) ម្តងទៀត', en: 'MovAi is still separating this song — please wait a bit and tap Split (AI) again' } });
          if (e && e.code === 'mvsep_queue_busy') return sendJSON(res, 200, { ok: false, error: 'mvsep_busy', message: { km: 'MovAi កំពុងបំបែកបទមុន — សូមរង់ចាំបន្តិច (ប៉ុន្មាននាទី) ហើយចុច Split (AI) ម្តងទៀត', en: 'MovAi is still processing a previous split — please wait a few minutes and try Split (AI) again' }, debugAttempts: (e && e.attempts) || undefined });
          if (e && /quota exceeded/i.test(String(e.message || ''))) return sendJSON(res, 200, { ok: false, error: 'mvsep_limit', message: { km: 'MovAi ដល់កំណត់ 50 បទ/ថ្ងៃ លើ Key ទាំងអស់ហើយ — សូមសាកល្បងម្តងទៀតនៅថ្ងៃស្អែក', en: 'MovAi daily limit of 50 songs/day reached on all keys — please try again tomorrow' }, debugAttempts: (e && e.attempts) || undefined });
          return sendJSON(res, 200, { ok: false, error: String((e && e.message) || 'MovAi: request failed').replace(/^MVSEP:\s*/, 'MovAi: ') });
        }
        // Success: count it against the key that did the work (server-side daily counter for the Admin display).
        await recordMvsepSeparation(out.keyUsed, out.hash);
        await mvsepPendingRemove(out.hash);
        // Remember this song's separation so a later re-split returns in ~1-2s from the cache instead of ~2 min.
        await mvsepCachePut(audioUrl, out.hash);
        return sendJSON(res, 200, { ok: true, provider: 'mvsep', hash: out.hash, songTitle, stems: out.stems });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'MovAi: ' + (e && e.message ? String(e.message).replace(/^MVSEP:\s*/, '').slice(0, 200) : 'request failed') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/studio/separate/cancel — {email, hash} — requires logged-in email.
  // Stops OUR side of a split: marks the MVSEP hash cancelled in the
  // in-flight registry, so the status endpoint reports it as cancelled
  // (the client stops polling) and a later re-tap can start a fresh
  // job instead of resuming the dead one. Consumes NO VS use and
  // refunds none (the use was deducted up front when the split was
  // accepted, same as generation credits — the owner decides on
  // refunds; the v2.1.12 1-use restore offer is still pending).
  // HONEST LIMIT: MVSEP has NO cancel/delete API (official full API:
  // only create + get + types + history), so this CANNOT stop the job
  // on MVSEP's side or free that account's queue slot. The slot frees
  // only when MVSEP itself finishes (done) or fails the job. The
  // client message says so plainly.
  if (req.method === 'POST' && urlPath === '/api/studio/separate/cancel') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      try {
        const email = normEmail(body && body.email);
        if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first', needLogin: true });
        const hash = body && typeof body.hash === 'string' ? body.hash.trim().slice(0, 200) : '';
        if (!hash) return sendJSON(res, 200, { ok: false, error: 'មិនមាន hash ទេ · No separation hash' });
        const wasLive = await mvsepPendingCancel(hash);
        return sendJSON(res, 200, { ok: true, cancelled: wasLive, hash, message: { km: 'បានបញ្ឈប់ការបំបែក · Split stopped', en: 'Split stopped' } });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'MVSEP: ' + (e && e.message ? String(e.message).slice(0, 200) : 'cancel failed') }); }
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
        const keys = await adminProviderKeyList('mvsep');
        if (!keys.length) return sendJSON(res, 200, { ok: false, error: 'mvsep_no_key', message: { km: 'Admin មិនទាន់ដាក់ API Key សម្រាប់បំបែកបទទេ', en: 'Admin has not added an API key for splitting yet' } });
        // The GET status endpoint takes only the hash (official example
        // passes no api_token), so one check is enough — no key loop.
        // A hash the user cancelled stops here — never report it as
        // processing again (the client would poll a dead job forever).
        const _pend = await mvsepPendingGetByHash(hash);
        if (_pend && _pend.status === 'cancelled') {
          return sendJSON(res, 200, { ok: false, error: 'mvsep_cancelled', hash, message: { km: 'ការបំបែកនេះត្រូវបានបោះបង់ · This split was cancelled', en: 'This split was cancelled' } });
        }
        let r;
        try {
          r = await mvsepGetSeparation(hash);
        } catch (e) {
          return sendJSON(res, 200, { ok: false, error: 'mvsep_not_found', hash, message: { km: 'រក Separation នេះមិនឃើញទេ — វាអាចបរាជ័យ ឬផុតកំណត់ហើយ', en: 'Separation not found — it may have failed or expired' } });
        }
        if (r.done) {
          const kv = _mvsepHashKey.get(hash);
          if (kv) await recordMvsepSeparation(kv, hash);
          await mvsepPendingRemove(hash);
          // Cache it too (the POST path does) so a later re-tap of the
          // same song reuses this finished job instead of creating a
          // duplicate separation on another key.
          const _au = _mvsepHashAudio.get(hash);
          if (_au) await mvsepCachePut(_au, hash);
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
  // sync (new-user gift on CLAIM: 24 song credits, or 50 when the
  // gift50 toggle is ON for a brand-new account; no media credits);
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
      if (_cip0 && (await loadBlockedIps()).some((b) => b === _cip0)) {
        await addNotification('security', email, '🚫 គណនី/IP ត្រូវបានប្លុកព្យាយាមចូល · Blocked account/IP login attempt', email + ' tried to log in from blocked IP ' + _cip0 + ' · IP ' + _cip0);
        return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      }
      if ((await loadBlockedEmails()).some((b) => b === email)) {
        await addNotification('security', email, '🚫 គណនី/IP ត្រូវបានប្លុកព្យាយាមចូល · Blocked account/IP login attempt', email + ' tried to log in from blocked email ' + email + ' · IP ' + (_cip0 || '—'));
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
      if (_model && (await loadBlockedModels()).some((b) => b.toUpperCase() === _model.toUpperCase())) {
        await addNotification('security', email, '🚫 ម៉ូឌែលត្រូវបានប្លុកព្យាយាមចូល · Blocked model login attempt', email + ' tried to log in from blocked model ' + _model + ' · IP ' + (getClientIp(req) || '—'));
        return sendJSON(res, 200, { ok: false, error: 'ម៉ូដែលនេះត្រូវបានប្លុក · This device model is blocked' });
      }
      const now = new Date().toISOString();
      // Device fingerprint for this request (deviceId + model + screen +
      // timezone + vpn flag from the website; IP server-side). It survives
      // VPN — only the IP changes, the device is still recognised.
      const _fp = deviceFingerprintFor(req, body, _model);
      await logActivity({ at: now, mode: 'sync', email, deviceId: _fp.deviceId || '', model: _fp.model || '', ip: _fp.ip || '', vpn: !!_fp.vpn });
      const users = await loadUsers();
      const isNewUser = !users[email];
      let u = users[email];
      // DEVICE ACCOUNT LIMIT (owner order 2026-11-18): max N accounts per
      // DEVICE, free (N = deviceLimit setting, default 3 — enforced only
      // when deviceLimitEnabled is ON). A 4th+ registration is refused
      // (strike + level email when Auto-Catch is ON, device blocked at
      // strike 4). Login is unlimited — the limit is only on
      // REGISTERING new accounts.
      if (isNewUser) {
        const _gate = await deviceLimitGate(users, _fp, email, typeof body.name === 'string' ? body.name : '');
        if (_gate) return sendJSON(res, 200, _gate);
      }
      if (!u) {
        const takenIds = new Set(Object.values(users).map((x) => x.id).filter(Boolean));
        u = {
          id: genUserId(takenIds),
          email,
          name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '',
          firstName: typeof body.firstName === 'string' ? body.firstName.trim().slice(0, 50) : '',
          lastName: typeof body.lastName === 'string' ? body.lastName.trim().slice(0, 50) : '',
          address: typeof body.address === 'string' ? body.address.trim().slice(0, 200) : '',
          // GIFT LOCK (owner order 2026-11-17): a new account ALWAYS
          // starts at 0/0. The server NEVER trusts the client's
          // balance — a browser could send credits:250 and mint the
          // gift without claiming, and a stale/new-device sync could
          // re-create the account with the gift. The gift (24 song
          // credits, or 50 when gift50 is ON for a brand-new account)
          // is granted ONLY by the CLAIM flow below
          // (giftClaimed:true + !giftClaimed), once per Gmail,
          // forever, on any device. The Admin/server balance is the
          // only truth; the Profile number is display-only.
          credits: 0,
          songCredits: 0,
          balance: 0,
          earnBalance: 0,
          giftClaimed: false,
          freeDlUsed: 0,
          freeMvUsed: 0,
          freeVsUsed: 0,
          freePostUsed: 0,
          freePostUsedByType: { song: 0, image: 0, video: 0, '3d': 0 },
          mvLeft: 0,
          vsLeft: 0,
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
        if (typeof body.address === 'string' && body.address.trim()) u.address = body.address.trim().slice(0, 200);
        if (typeof body.plan === 'string') u.plan = body.plan.slice(0, 50);
        if (typeof body.songPlan === 'string') u.songPlan = body.songPlan.slice(0, 50);
        u.updatedAt = now;
      }
      // DEVICE BLOCK (strike 4+): a blocked device cannot sign in either.
      // A new/different phone model alone NEVER blocks — the model is
      // only part of the fingerprint; a brand-new device gets its 3
      // free accounts. The block is for limit abuse, not for a new phone.
      if (!isNewUser) {
        const _blk = await deviceIsBlocked(_fp);
        if (_blk.blocked) {
          await logActivity({ at: now, mode: 'device-blocked-signin', email, deviceId: _fp.deviceId || '', model: _fp.model || '', ip: _fp.ip || '' });
          return sendJSON(res, 200, { ok: false, error: 'ឧបករណ៍នេះត្រូវបានប្លុក — This device has been used before · VPN is not supported. សូមទាក់ទង Admin · Please contact the Admin', deviceBlocked: true, blockedReason: _blk.reason });
        }
        // Adopt the current model as the registered model on first sight
        // (legacy users). Informational only — a model change never blocks.
        if (_model && !u.registeredModel) u.registeredModel = _model;
      } else if (_model) {
        u.registeredModel = _model;
      }
      // Capture where this user connects from + on what device (every sync).
      const _cip = getClientIp(req);
      if (_cip) u.lastIp = _cip;
      const _dev = deviceFromUA(req.headers && req.headers['user-agent']);
      if (_dev) u.device = _dev;
      if (_model) u.model = _model;
      // Device fingerprint: the registration device is recorded once
      // (u.deviceId, never overwritten by later sign-ins from other
      // devices); u.lastDeviceId is the most recent device seen.
      if (_fp.deviceId) {
        if (!u.deviceId) u.deviceId = _fp.deviceId;
        u.lastDeviceId = _fp.deviceId;
      }
      // Record this sighting on the device record (VPN flags, last IP).
      await deviceTouchRecord(_fp, email, now);
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
        _modelLogins = await loadModelLogins();
        _modelLogins[_model] = (Number(_modelLogins[_model]) || 0) + 1;
        await saveModelLogins(_modelLogins);
      }
      // GIFT — SONG credits ONLY, LOCKED once per Gmail, forever
      // (owner orders 2026-11-17 + 2026-11-18): when the website sends
      // giftClaimed:true the server grants the gift, once per user.
      // The 250 media gift is REMOVED — a new registrant gets 24 song
      // credits (or 50 when the gift50 toggle is ON and the account is
      // BRAND NEW: created within the last 24h, never logged in/used
      // before). An older account, or one that already claimed, can
      // NEVER get the 50 — they get the normal 24 (or nothing if
      // already claimed). The giftClaimed flag prevents a second grant;
      // Math.max tops the balance UP to the target instead of adding.
      // New accounts start at 0/0 (see above) so the gift can only
      // arrive through this CLAIM flow. The 21:01 exploit: Oun Lyna2
      // got the gift again by logging in from a new device, because
      // her earlier admin grant never set giftClaimed — the flag is
      // now the single lock, and the notification below fires ONLY
      // when credits are actually granted (never on a refused
      // re-claim). Logged to grants.json so it shows in credit history.
      if (body && body.giftClaimed === true && !u.giftClaimed) {
        // Brand-new account? The claim arrives on a sync AFTER the
        // account-creation sync (the gift popup shows after first
        // login), so isNewUser is usually false here — account age is
        // the reliable marker. Created within the last 24h = just
        // registered, never used the app.
        let _isBrandNew = false;
        try {
          const _createdMs = Date.parse(u.createdAt || '');
          _isBrandNew = Number.isFinite(_createdMs) && (Date.now() - _createdMs) <= GIFT50_NEW_ACCOUNT_WINDOW_MS;
        } catch (e) { _isBrandNew = false; }
        const _songTarget = (await gift50Enabled() && _isBrandNew) ? GIFT50_SONG_CREDITS : FREE_SONG_CREDITS;
        const _gm = Math.max(0, FREE_MEDIA_CREDITS - Math.floor(numOr(u.credits, 0)));
        const _gs = Math.max(0, _songTarget - Math.floor(numOr(u.songCredits, 0)));
        if (_gm > 0) u.credits = Math.floor(numOr(u.credits, 0)) + _gm;
        if (_gs > 0) u.songCredits = Math.floor(numOr(u.songCredits, 0)) + _gs;
        u.giftClaimed = true;
        // Notify ONLY when credits were actually granted. The old code
        // notified on every sync with giftClaimed:true, even when the
        // gift was already locked (no credits given) — the Admin got a
        // false "Gift claimed" alert for a user who got nothing.
        if (_gm > 0 || _gs > 0) {
          await logGrant({ email, credits: _gm, songCredits: _gs, note: 'gift', at: now });
          await addNotification('gift-claimed', email, '🎁 កាដូបានទទួល · Gift claimed', (u.name || email) + ' (' + email + ') បានទទួលកាដូ Free ' + _gs + ' Song Credit');
        }
      }
      u.credits = Math.max(0, Math.floor(numOr(u.credits, 0)));
      u.songCredits = Math.max(0, Math.floor(numOr(u.songCredits, 0)));
      await saveUsers(users);
      // Critical write: confirm users.json is on GitHub BEFORE returning
      // success, so a restart in the next second cannot lose this user
      // (new account / first sync / credit truth).
      scheduleBackup('users.json');
      if (isNewUser) {
        await addNotification('login', email, '👤 អ្នកប្រើថ្មី · New user', (u.name || email) + ' (' + email + ') បាន log in លើកដំបូង');
      }
      if (_isNewDevice) {
        await addNotification('security', email, '🔐 ឧបករណ៍ថ្មី · New device login', email + ' logged in from a new device: ' + (_model || _dev || 'Unknown') + ' · IP ' + (_cip || '—'));
      }
      return sendJSON(res, 200, { ok: true, user: await pubUser(u, _modelLogins) });
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
      if (_cip0 && (await loadBlockedIps()).some((b) => b === _cip0)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      if ((await loadBlockedEmails()).some((b) => b === email)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      const now = new Date().toISOString();
      // Device fingerprint (same as sync). The limit is only on CREATING
      // a new account — setting/resetting a password on an existing
      // account is never limited (the Google token already proves
      // ownership).
      const _spBodyModel = typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      const _spModel = (_spBodyModel && _spBodyModel !== 'K') ? _spBodyModel : modelFromUA(req.headers && req.headers['user-agent']);
      const _fp = deviceFingerprintFor(req, body, _spModel);
      await logActivity({ at: now, mode: 'set-password', email, deviceId: _fp.deviceId || '', model: _fp.model || '', ip: _fp.ip || '', vpn: !!_fp.vpn });
      const users = await loadUsers();
      const isNewUser = !users[email];
      let u = users[email];
      if (isNewUser) {
        const _gate = await deviceLimitGate(users, _fp, email, g.name || '');
        if (_gate) return sendJSON(res, 200, _gate);
      }
      if (!u) {
        const takenIds = new Set(Object.values(users).map((x) => x.id).filter(Boolean));
        u = { id: genUserId(takenIds), email, name: g.name || '', credits: 0, songCredits: 0, balance: 0, earnBalance: 0, giftClaimed: false, freeDlUsed: 0, freeMvUsed: 0, freeVsUsed: 0, freePostUsed: 0, freePostUsedByType: { song: 0, image: 0, video: 0, '3d': 0 }, mvLeft: 0, vsLeft: 0, plan: '', songPlan: '', createdAt: now, updatedAt: now };
        users[email] = u;
      } else {
        if (!u.id) { const takenIds = new Set(Object.values(users).map((x) => x.id).filter(Boolean)); u.id = genUserId(takenIds); }
        if (g.name && !u.name) u.name = g.name;
        u.updatedAt = now;
      }
      const hp = await hashPassword(password);
      u.passwordSalt = hp.salt;
      u.passwordHash = hp.hash;
      // Record the registration device + this sighting.
      if (_fp.deviceId) {
        if (!u.deviceId) u.deviceId = _fp.deviceId;
        u.lastDeviceId = _fp.deviceId;
      }
      if (_fp.model && !u.registeredModel) u.registeredModel = _fp.model;
      if (_fp.model) u.model = _fp.model;
      if (_fp.device) u.device = _fp.device;
      if (_cip0) u.lastIp = _cip0;
      await deviceTouchRecord(_fp, email, now);
      // A new password revokes ALL saved (remember-me) logins — the old
      // saved Accounts must not keep working after a password change.
      revokeAllRememberTokens(u);
      u.updatedAt = now;
      // A (re)set password clears any sign-in lock for this Gmail.
      signinClear(email);
      await saveUsers(users);
      scheduleBackup('users.json');
      if (isNewUser) await addNotification('login', email, '👤 អ្នកប្រើថ្មី · New user', (u.name || email) + ' (' + email + ') បានចុះឈ្មោះ (Sign-up + Password)');
      return sendJSON(res, 200, { ok: true, user: await pubUser(u) });
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
      if (_cip0 && (await loadBlockedIps()).some((b) => b === _cip0)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      if ((await loadBlockedEmails()).some((b) => b === email)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      if (signinLocked(email)) return sendJSON(res, 200, { ok: false, error: 'បញ្ចូល Password ខុសច្រើនដងពេកហើយ សាកល្បងម្តងទៀត 15 នាទីក្រោយ · Too many wrong attempts, try again in 15 minutes' });
      const users = await loadUsers();
      const u = users[email];
      const bad = () => sendJSON(res, 200, { ok: false, error: 'Gmail ឬ Password មិនត្រឹមត្រូវទេ · Wrong Gmail or password' });
      // No account yet, or the account never set a password (never did
      // Continue with Google): say so clearly so the website can send
      // them to Continue with Google first. Not a wrong-password
      // attempt, so it does not count toward the lockout.
      if (!u || !u.passwordHash || !u.passwordSalt) {
        return sendJSON(res, 200, { ok: false, error: 'មិនទាន់មាន Gmail នេះទេ — សូម Continue with Google ជាមុនសិន ទើបអាច Log in បាន · No account with this Gmail yet — please Continue with Google first, then you can log in', noAccount: true });
      }
      // Blocked device (strike 4+): cannot sign in from this device.
      // A new/different phone model alone never blocks.
      const _siBodyModel = typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      const _siModel = (_siBodyModel && _siBodyModel !== 'K') ? _siBodyModel : modelFromUA(req.headers && req.headers['user-agent']);
      const _fp = deviceFingerprintFor(req, body, _siModel);
      const _blk = await deviceIsBlocked(_fp);
      if (_blk.blocked) return sendJSON(res, 200, { ok: false, error: 'ឧបករណ៍នេះត្រូវបានប្លុក — This device has been used before · VPN is not supported. សូមទាក់ទង Admin · Please contact the Admin', deviceBlocked: true, blockedReason: _blk.reason });
      const okPw = await verifyPassword(password, u.passwordSalt, u.passwordHash);
      if (!okPw) {
        const _f = signinFail(email);
        // 5 wrong passwords in a row = possible scam/hacker: notify the
        // Admin + the user (email). NEVER blocks — the Admin reviews
        // the Gmail manually and decides. Fire-and-forget.
        if (_f && _f.count === 5 && _f.lockedUntil) reportScamHacker({ email, name: u.name || '', kind: 'brute-force', model: _fp.model || '', deviceId: _fp.deviceId || '', ip: _fp.ip || '' }).catch(() => {});
        return bad();
      }
      signinClear(email);
      const now = new Date().toISOString();
      await logActivity({ at: now, mode: 'signin', email, deviceId: _fp.deviceId || '', model: _fp.model || '', ip: _fp.ip || '', vpn: !!_fp.vpn });
      u.lastSeen = now;
      if (_cip0) u.lastIp = _cip0;
      if (_fp.deviceId) {
        if (!u.deviceId) u.deviceId = _fp.deviceId;
        u.lastDeviceId = _fp.deviceId;
      }
      if (_fp.model && !u.registeredModel) u.registeredModel = _fp.model;
      if (_fp.model) u.model = _fp.model;
      if (_fp.device) u.device = _fp.device;
      trackKnownDevice(u, _fp.model || '', _fp.device || '', _cip0 || '', now, u.country || '', u.countryCode || '');
      await deviceTouchRecord(_fp, email, now);
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      return sendJSON(res, 200, { ok: true, user: await pubUser(u) });
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
      const users = await loadUsers();
      const u = users[email];
      const bad = () => sendJSON(res, 200, { ok: false, error: 'Gmail ឬ Password មិនត្រឹមត្រូវទេ · Wrong Gmail or password' });
      if (!u || !u.passwordHash || !u.passwordSalt) { signinFail(email); return bad(); }
      const okPw = await verifyPassword(password, u.passwordSalt, u.passwordHash);
      if (!okPw) {
        const _f = signinFail(email);
        // 5 wrong passwords in a row = possible scam/hacker: notify the
        // Admin + the user (email). NEVER blocks. Fire-and-forget.
        if (_f && _f.count === 5 && _f.lockedUntil) reportScamHacker({ email, name: u.name || '', kind: 'brute-force', model: '', deviceId: '', ip: getClientIp(req) || '' }).catch(() => {});
        return bad();
      }
      signinClear(email);
      const token = issueRememberToken(u);
      u.updatedAt = new Date().toISOString();
      await saveUsers(users);
      scheduleBackup('users.json');
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
      if (_cip0 && (await loadBlockedIps()).some((b) => b === _cip0)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      if ((await loadBlockedEmails()).some((b) => b === email)) return sendJSON(res, 200, { ok: false, error: 'គណនីនេះត្រូវបានប្លុក · This account is blocked' });
      const users = await loadUsers();
      const u = users[email];
      const bad = () => sendJSON(res, 200, { ok: false, error: 'ការចូលដែលបានសេវផុតកំណត់ហើយ សូមចូលដោយ Password ម្តងទៀត · Saved login expired, please sign in with your password' });
      if (!u) return bad();
      // Blocked device (strike 4+): cannot sign in from this device.
      const _rlBodyModel = typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      const _rlModel = (_rlBodyModel && _rlBodyModel !== 'K') ? _rlBodyModel : modelFromUA(req.headers && req.headers['user-agent']);
      const _fp = deviceFingerprintFor(req, body, _rlModel);
      const _blk = await deviceIsBlocked(_fp);
      if (_blk.blocked) return sendJSON(res, 200, { ok: false, error: 'ឧបករណ៍នេះត្រូវបានប្លុក — This device has been used before · VPN is not supported. សូមទាក់ទង Admin · Please contact the Admin', deviceBlocked: true, blockedReason: _blk.reason });
      const entry = findRememberToken(u, token);
      if (!entry) return bad();
      const now = new Date().toISOString();
      await logActivity({ at: now, mode: 'remember-login', email, deviceId: _fp.deviceId || '', model: _fp.model || '', ip: _fp.ip || '', vpn: !!_fp.vpn });
      u.lastSeen = now;
      if (_cip0) u.lastIp = _cip0;
      if (_fp.deviceId) {
        if (!u.deviceId) u.deviceId = _fp.deviceId;
        u.lastDeviceId = _fp.deviceId;
      }
      if (_fp.model && !u.registeredModel) u.registeredModel = _fp.model;
      if (_fp.model) u.model = _fp.model;
      if (_fp.device) u.device = _fp.device;
      trackKnownDevice(u, _fp.model || '', _fp.device || '', _cip0 || '', now, u.country || '', u.countryCode || '');
      await deviceTouchRecord(_fp, email, now);
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      return sendJSON(res, 200, { ok: true, user: await pubUser(u) });
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
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: true });
      if (revokeRememberToken(u, token)) {
        u.updatedAt = new Date().toISOString();
        await saveUsers(users);
        scheduleBackup('users.json');
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
      const users = await loadUsers();
      if (!users[email]) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន · No account with this Gmail, please sign up first' });
      // FREE RESET LIMIT (owner order 2026-11-18): the email-code reset is
      // free only 2 times per user, ever. After that the user must use the
      // paid instant reset (Option 2, $0.10 from the Wallet). The count
      // only grows when a code is actually sent.
      const _freeUsed = Math.floor(numOr(users[email].freeResetCount, 0));
      if (_freeUsed >= WALLET_FREE_RESET_LIMIT) return sendJSON(res, 200, { ok: false, error: 'លេខកូដ Free អស់ហើយ (ប្រើ ' + WALLET_FREE_RESET_LIMIT + ' ដងរួច) — សូមប្រើ Forget Password បង់ $0.10 ដើម្បី Reset ភ្លាមៗ · Free resets used up (' + WALLET_FREE_RESET_LIMIT + ' used) — please use the $0.10 instant reset', freeResetsUsedUp: true, instantResetPrice: WALLET_INSTANT_RESET_PRICE });
      if (!await verifyEmailConfigured()) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Email (Gmail App Password) ទេ — សូមប្រាប់ Admin · Email is not set up yet, please tell the Admin' });
      const sent = await sendVerificationEmail(email);
      if (!sent.ok) return sendJSON(res, 200, { ok: false, error: sent.error || 'ផ្ញើលេខកូដមិនបានទេ · Could not send the code' });
      users[email].freeResetCount = _freeUsed + 1;
      users[email].updatedAt = new Date().toISOString();
      await saveUsers(users);
      scheduleBackup('users.json');
      return sendJSON(res, 200, { ok: true, sent: true, freeResetsLeft: Math.max(0, WALLET_FREE_RESET_LIMIT - (_freeUsed + 1)) });
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
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ · No account with this Gmail' });
      const hp = await hashPassword(password);
      u.passwordSalt = hp.salt;
      u.passwordHash = hp.hash;
      revokeAllRememberTokens(u);
      signinClear(email);
      const now = new Date().toISOString();
      await logActivity({ at: now, mode: 'reset-password', email });
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      await addNotification('security', email, '🔑 Password ត្រូវបានប្តូរ · Password changed', (u.name || email) + ' (' + email + ') បានប្តូរ Password តាមរយៈលេខកូដ 6 ខ្ទង់');
      return sendJSON(res, 200, { ok: true, user: await pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/users — admin key required. Newest first.
  if (req.method === 'GET' && urlPath === '/api/admin/users') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const users = await loadUsers();
    const modelLogins = await loadModelLogins();
    const list = await Promise.all(Object.values(users).sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || ''))).map(async (x) => pubUser(x, modelLogins, await deviceInfoForUser(users, x))));
    return sendJSON(res, 200, { ok: true, users: list });
  }
  // GET /api/admin/user?email=... — admin key required.
  if (req.method === 'GET' && urlPath === '/api/admin/user') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const _allUsers = await loadUsers();
    const u = _allUsers[email];
    if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
    return sendJSON(res, 200, { ok: true, user: await pubUser(u, null, await deviceInfoForUser(_allUsers, u)) });
  }
  // GET /api/admin/email-usage — admin key required. Live Brevo usage
  // for the Admin → Settings → Email panel: plan (Free), daily limit
  // (300/day), how many emails sent today, and how many remain.
  // Uses the stored Brevo API key; queries Brevo's account + today's
  // SMTP aggregated report. Returns {ok, provider:'brevo', plan,
  // dailyLimit, usedToday, remainingToday}. If no Brevo key is set,
  // returns ok:false (Gmail SMTP has no quota to show).
  if (req.method === 'GET' && urlPath === '/api/admin/email-usage') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const s = await loadSettings();
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
        const usedToday = (await brevoUsageToday()).sent;
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const u = await groqUsageList();
    return sendJSON(res, 200, { ok: true, provider: 'groq', date: u.date, dailyLimit: u.dailyLimit, keys: u.keys });
  }
  // GET /api/admin/mvsep-usage — admin key required. MVSEP separations used
  // today per key for the Admin → API Keys display: daily limit (50/day/key),
  // used today, remaining today, and status (green = separations left, red =
  // daily limit reached). Keys are 1-based indexes only — key values are
  // never returned.
  if (req.method === 'GET' && urlPath === '/api/admin/mvsep-usage') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const u = await mvsepUsageList();
    return sendJSON(res, 200, { ok: true, provider: 'mvsep', date: u.date, dailyLimit: u.dailyLimit, keys: u.keys });
  }
  // GET /api/admin/suno-balance — admin key required. Live Suno credit
  // balance per stored Suno key for the Admin → API Keys display:
  // GET {endpoint}/api/v1/generate/credit (sunoapi.org) answers
  // {code:200, data:<remaining integer>}. The API returns ONLY the
  // remaining balance — no total/used. Keys are 1-based indexes only —
  // key values are never returned.
  if (req.method === 'GET' && urlPath === '/api/admin/suno-balance') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const list = await adminProviderKeyList('suno');
    if (!list.length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
    const bal = await sunoBalanceAll();
    return sendJSON(res, 200, { ok: true, provider: 'suno', totalRemaining: bal.totalRemaining, keys: bal.keys });
  }
  // ---- v2.2.59: Render free-quota tracking (owner-only display) ----
  // The server tracks its OWN usage this month and exposes it via
  // GET /api/public/quota (admin-only). Hours = this process's cumulative
  // awake time (Render Free only counts hours while the service is awake;
  // the website/Admin are Static and cost 0 hours, so this server's
  // uptime = the workspace's hour usage). Bandwidth = total response
  // bytes this server sent (counted by the res.write/res.end wrapper in
  // the createServer callback below). Both persist to Supabase kv_docs
  // ('quota:<host>:<YYYY-MM>') so they survive restarts/sleeps, and
  // reset automatically each month. The key includes the server host so
  // the old and new servers NEVER mix their counters. Counters start at
  // 0 when v2.2.59 first deploys — usage before that is not known (no
  // Render API key). Bandwidth is server-only and does NOT include the
  // Static website/Admin bandwidth, so it is a LOWER BOUND on total
  // workspace bandwidth.
  const QUOTA_HOURS_TOTAL = 750;
  const QUOTA_BW_TOTAL = 5 * 1024 * 1024 * 1024; // 5 GB
  function quotaHost() {
    var h = (process.env.RENDER_EXTERNAL_HOSTNAME || '').trim();
    if (h) return h;
    return 'movai-proxy-dphl.onrender.com';
  }
  function quotaMonthKey(d) {
    var t = d || new Date();
    return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0');
  }
  function quotaKvKey() { return 'quota:' + quotaHost() + ':' + quotaMonthKey(); }
  var quotaBootMs = Date.now();
  var quotaAccumMs = 0; // awake ms from earlier sessions this month
  var quotaBytesOut = 0; // response bytes this month (in-memory)
  var quotaLoadedMonth = '';
  var quotaLoadPromise = null;
  async function quotaLoad() {
    if (quotaLoadPromise) return quotaLoadPromise;
    quotaLoadPromise = (async () => {
      try {
        var doc = await loadKvDoc(quotaKvKey(), null);
        if (doc && doc.month === quotaMonthKey()) {
          quotaAccumMs = Math.max(0, Number(doc.accumMs) || 0);
          quotaBytesOut = Math.max(0, Number(doc.bytesOut) || 0);
          quotaLoadedMonth = doc.month;
        } else {
          quotaAccumMs = 0; quotaBytesOut = 0;
          quotaLoadedMonth = quotaMonthKey();
        }
      } catch (e) {}
      return true;
    })();
    return quotaLoadPromise;
  }
  function quotaUsedMs() { return quotaAccumMs + (Date.now() - quotaBootMs); }
  async function quotaPersist() {
    try {
      var now = Date.now();
      if (quotaMonthKey() !== quotaLoadedMonth) {
        // New month: reset and persist under the new key.
        quotaAccumMs = 0; quotaBytesOut = 0;
        quotaLoadedMonth = quotaMonthKey();
        quotaBootMs = now;
      } else {
        // Fold this session's elapsed time into the accumulator and
        // restart the clock (no double-counting).
        quotaAccumMs += (now - quotaBootMs);
        quotaBootMs = now;
      }
      await saveKvDoc(quotaKvKey(), { month: quotaMonthKey(), accumMs: quotaAccumMs, bytesOut: quotaBytesOut, host: quotaHost(), updatedAt: new Date().toISOString() });
    } catch (e) {}
  }
  // Persist every 60s (cheap; a crash loses at most 60s of hours).
  setInterval(function() { quotaPersist().catch(function() {}); }, 60000);
  // GET /api/public/quota?email=... — ADMIN-ONLY (ADMIN_EMAILS). The
  // requesting email must be an admin; anyone else gets not_admin.
  if (req.method === 'GET' && urlPath === '/api/public/quota') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    // Admin-only: an ADMIN_EMAILS email, OR the Admin key (Bearer) —
    // the Admin app logs in with name + key and has no email. The key is
    // only checked when a Bearer token is actually presented, so a plain
    // request never touches the lockout logic.
    var _qAdmin = !!(email && ADMIN_EMAILS.includes(email));
    if (!_qAdmin) {
      var _qh = String(req.headers['authorization'] || '');
      if (/^Bearer\s+/.test(_qh)) {
        try { var _qa = await adminKeyOk(req); _qAdmin = !!(_qa && _qa.ok); } catch (e) {}
      }
    }
    if (!_qAdmin) return sendJSON(res, 200, { ok: false, error: 'not_admin' });
    try { await quotaLoad(); } catch (e) {}
    var _qUsedMs = quotaUsedMs();
    var _qBw = quotaBytesOut;
    return sendJSON(res, 200, { ok: true, month: quotaMonthKey(), serverHost: quotaHost(),
      hoursUsedMs: _qUsedMs, hoursTotalMs: QUOTA_HOURS_TOTAL * 3600 * 1000, hoursLeftMs: Math.max(0, QUOTA_HOURS_TOTAL * 3600 * 1000 - _qUsedMs),
      bandwidthUsedBytes: _qBw, bandwidthTotalBytes: QUOTA_BW_TOTAL, bandwidthLeftBytes: Math.max(0, QUOTA_BW_TOTAL - _qBw),
      note: 'Server-only bandwidth (lower bound — Static website/Admin bandwidth not included). Counters start at v2.2.59 deploy.' });
  }
  // GET /api/public/suno-balance?email=... — v2.2.48. The live Suno API
  // credit balance for the OWNER's Profile on the website (same numbers
  // as the Admin Suno card). ADMIN-ONLY: the requesting email must be in
  // ADMIN_EMAILS — anyone else gets {ok:false} with NO balance and NO
  // key info. Cached ~60s (sunoBalanceCached) so Profile refreshes
  // don't hammer sunoapi.org. This is the SUNO API balance (bought from
  // Suno) — SEPARATE from MovAi package credits; the two are never
  // mixed. Key values are never returned.
  if (req.method === 'GET' && urlPath === '/api/public/suno-balance') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email || !ADMIN_EMAILS.includes(email)) return sendJSON(res, 200, { ok: false, error: 'not_admin' });
    const bal = await sunoBalanceCached();
    if (!bal.keys.length) return sendJSON(res, 200, { ok: false, error: 'Admin មិនទាន់ដាក់ Suno Key ទេ' });
    return sendJSON(res, 200, { ok: true, provider: 'suno', totalRemaining: bal.totalRemaining, keys: bal.keys });
  }
  // GET /api/admin/feature-usage — admin key required. Feature-usage
  // counts for the Admin (how many times each new function was used):
  // per-feature total + today + per-day breakdown, sorted by total
  // descending. Optional ?feature=<name> returns only that one feature.
  if (req.method === 'GET' && urlPath === '/api/admin/feature-usage') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const u = await featureUsageList();
    const only = featureUsageCleanName(new URL(req.url, 'http://localhost').searchParams.get('feature') || '');
    if (only) {
      const one = u.features.find((f) => f.feature === only);
      return sendJSON(res, 200, { ok: true, date: u.date, features: one ? [one] : [] });
    }
    return sendJSON(res, 200, { ok: true, date: u.date, features: u.features });
  }
  // GET /api/admin/auto-catch — admin key required. Reads the Auto-Catch
  // master toggle (default OFF). POST /api/admin/auto-catch {enabled}
  // sets it. The Admin app has a toggle button for it.
  if (req.method === 'GET' && urlPath === '/api/admin/auto-catch') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, enabled: await autoCatchEnabled() });
  }
  if (req.method === 'POST' && urlPath === '/api/admin/auto-catch') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (!body || typeof body.enabled !== 'boolean') return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ enabled: true/false' });
      const out = await saveSettings(Object.assign(await loadSettings(), { autoCatch: body.enabled }));
      return sendJSON(res, 200, { ok: true, enabled: out.autoCatch === true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/lockout — admin key required. Reads the Admin Lockout
  // protection toggle (default ON). POST /api/admin/lockout {enabled}
  // sets it. The Admin app has a toggle button for it.
  if (req.method === 'GET' && urlPath === '/api/admin/lockout') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, enabled: await lockoutEnabled() });
  }
  if (req.method === 'POST' && urlPath === '/api/admin/lockout') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (!body || typeof body.enabled !== 'boolean') return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ enabled: true/false' });
      const out = await saveSettings(Object.assign(await loadSettings(), { lockoutEnabled: body.enabled }));
      return sendJSON(res, 200, { ok: true, enabled: out.lockoutEnabled !== false });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/device-limit — admin key required. Reads the device
  // account-limit setting {enabled, limit} (defaults OFF / 3).
  // POST /api/admin/device-limit {enabled?, limit?} sets it. The limit
  // is read fresh from settings on EVERY registration, so a change
  // takes effect immediately. The Admin app has a toggle + number
  // input for it.
  if (req.method === 'GET' && urlPath === '/api/admin/device-limit') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const dl = await deviceLimitSetting();
    return sendJSON(res, 200, { ok: true, enabled: dl.enabled, limit: dl.limit });
  }
  if (req.method === 'POST' && urlPath === '/api/admin/device-limit') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const patch = {};
      if (body && typeof body.enabled === 'boolean') patch.deviceLimitEnabled = body.enabled;
      if (body && Number.isFinite(body.limit)) patch.deviceLimit = Math.min(100, Math.max(1, Math.floor(body.limit)));
      if (!('deviceLimitEnabled' in patch) && !('deviceLimit' in patch)) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ enabled និង/ឬ limit (1–100)' });
      await saveSettings(Object.assign(await loadSettings(), patch));
      const dl = await deviceLimitSetting();
      return sendJSON(res, 200, { ok: true, enabled: dl.enabled, limit: dl.limit });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/gift-50 — admin key required. Reads the new-user
  // gift-50 toggle (default OFF). POST /api/admin/gift-50 {enabled}
  // sets it. When ON, a BRAND-NEW registrant who claims the gift gets
  // 50 song credits instead of 24; when OFF the gift is 24 song
  // credits. The gift is song-only either way — no media credits.
  // Only an account created within the last 24h (never logged in /
  // used before) can get the 50; older accounts get 24. The Admin
  // app has a toggle button for it.
  if (req.method === 'GET' && urlPath === '/api/admin/gift-50') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, enabled: await gift50Enabled() });
  }
  if (req.method === 'POST' && urlPath === '/api/admin/gift-50') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (!body || typeof body.enabled !== 'boolean') return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ enabled: true/false' });
      const out = await saveSettings(Object.assign(await loadSettings(), { gift50: body.enabled }));
      return sendJSON(res, 200, { ok: true, enabled: out.gift50 === true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Telegram shop bot on/off switch (owner order 2026-11-20 20:48) ----
  // The owner turned the telegram-gmail-bot Render service OFF (suspend)
  // to save hours, and wants an Admin switch to turn it back ON (resume)
  // later. This is suspend/resume ONLY — it NEVER deletes the service.
  // GET /api/admin/telegram-bot (admin key) reports the current state
  // (live from Render when configured, else the stored desired state).
  // POST /api/admin/telegram-bot {enabled} (admin key) suspends
  // (enabled:false) or resumes (enabled:true) the service via the
  // Render API v1 (POST /v1/services/{id}/suspend|resume, Bearer key).
  // Config: env RENDER_API_KEY + TELEGRAM_BOT_SERVICE_ID win; else
  // settings telegramBot.renderApiKey / telegramBot.serviceId (set in
  // the Admin). If either is missing the endpoint returns a clear error
  // (never fails silently). The Render API key value is never returned
  // or logged by any endpoint. Service: srv-dbombv9srm7s73cegmug
  // (https://telegram-gmail-bot.onrender.com). NOTE 2026-11-20: Render
  // already suspended this service for bandwidth, so the Dashboard
  // Suspend button is disabled and the service is 'Suspended by
  // Render', NOT owner-suspended. It may resume when the quota resets
  // Dec 1 — the toggle must then be able to suspend it via the Render
  // API (a suspend call on an already-suspended service may be rejected
  // as a no-op; the POST handler below treats "live state already
  // matches" as success). Nothing was deleted.
  async function telegramBotConfig() {
    const s = await loadSettings().catch(() => null);
    const tb = (s && s.telegramBot && typeof s.telegramBot === 'object' && !Array.isArray(s.telegramBot)) ? s.telegramBot : {};
    const apiKey = (process.env.RENDER_API_KEY || '').trim() || (typeof tb.renderApiKey === 'string' ? tb.renderApiKey.trim() : '');
    const serviceId = (process.env.TELEGRAM_BOT_SERVICE_ID || '').trim() || (typeof tb.serviceId === 'string' ? tb.serviceId.trim() : '');
    return { apiKey, serviceId, desiredEnabled: tb.enabled !== false };
  }
  async function renderServiceState(apiKey, serviceId) {
    const r = await fetch('https://api.render.com/v1/services/' + encodeURIComponent(serviceId), { headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
    if (!r.ok) throw new Error('Render API ' + r.status + (d && d.message ? ': ' + String(d.message).slice(0, 200) : ''));
    const svc = (d && d.service && typeof d.service === 'object') ? d.service : {};
    return { suspended: svc.suspended === true, name: typeof svc.name === 'string' ? svc.name : '', type: typeof svc.type === 'string' ? svc.type : '' };
  }
  async function renderServiceToggle(apiKey, serviceId, enable) {
    const action = enable ? 'resume' : 'suspend';
    const r = await fetch('https://api.render.com/v1/services/' + encodeURIComponent(serviceId) + '/' + action, { method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) {}
    if (!r.ok) throw new Error('Render API ' + r.status + (d && d.message ? ': ' + String(d.message).slice(0, 200) : ''));
    return true;
  }
  if (req.method === 'GET' && urlPath === '/api/admin/telegram-bot') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const cfg = await telegramBotConfig();
    const base = { ok: true, enabled: cfg.desiredEnabled, suspended: null, live: false, serviceName: '', serviceId: cfg.serviceId || '', serviceIdConfigured: !!cfg.serviceId, renderKeyConfigured: !!cfg.apiKey };
    if (!cfg.apiKey) return sendJSON(res, 200, Object.assign(base, { ok: false, error: 'render_api_key_not_configured', message: 'Render API Key មិនទាន់បានកំណត់ទេ · Render API key not configured — សូមដាក់ RENDER_API_KEY នៅលើ Server ឬវាយ Key នៅកាត Bot Telegram ខាងក្រោម' }));
    if (!cfg.serviceId) return sendJSON(res, 200, Object.assign(base, { ok: false, error: 'telegram_bot_service_id_not_configured', message: 'Service ID របស់ Bot Telegram មិនទាន់បានកំណត់ទេ · Telegram bot service ID not configured — សូមដាក់ Service ID (srv-...) នៅកាត Bot Telegram ខាងក្រោម' }));
    try {
      const st = await renderServiceState(cfg.apiKey, cfg.serviceId);
      return sendJSON(res, 200, Object.assign(base, { suspended: st.suspended, enabled: !st.suspended, serviceName: st.name, live: true }));
    } catch (e) {
      return sendJSON(res, 200, Object.assign(base, { ok: false, error: 'render_api_error', message: 'Render API error: ' + (e && e.message ? e.message : e) }));
    }
  }
  if (req.method === 'POST' && urlPath === '/api/admin/telegram-bot') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ enabled: true/false' });
      // Save config fields first (serviceId / renderApiKey). The desired
      // state (enabled) is saved ONLY after Render accepts the action.
      const patch = {};
      if (typeof body.serviceId === 'string') patch.serviceId = body.serviceId.trim().slice(0, 100);
      if (typeof body.renderApiKey === 'string' && body.renderApiKey.trim()) patch.renderApiKey = body.renderApiKey.trim();
      if (Object.keys(patch).length) {
        const cur = await loadSettings();
        await saveSettings(Object.assign(cur, { telegramBot: Object.assign({}, cur.telegramBot || {}, patch) }));
      }
      // Config-only save (no toggle requested): report the saved config.
      if (typeof body.enabled !== 'boolean') {
        const cfg0 = await telegramBotConfig();
        return sendJSON(res, 200, { ok: true, saved: true, enabled: cfg0.desiredEnabled, serviceIdConfigured: !!cfg0.serviceId, renderKeyConfigured: !!cfg0.apiKey, serviceId: cfg0.serviceId || '' });
      }
      const cfg = await telegramBotConfig();
      if (!cfg.apiKey) return sendJSON(res, 200, { ok: false, error: 'render_api_key_not_configured', message: 'Render API Key មិនទាន់បានកំណត់ទេ · Render API key not configured — សូមដាក់ RENDER_API_KEY នៅលើ Server ឬវាយ Key នៅកាត Bot Telegram ខាងក្រោម' });
      if (!cfg.serviceId) return sendJSON(res, 200, { ok: false, error: 'telegram_bot_service_id_not_configured', message: 'Service ID របស់ Bot Telegram មិនទាន់បានកំណត់ទេ · Telegram bot service ID not configured — សូមដាក់ Service ID (srv-...) នៅកាត Bot Telegram ខាងក្រោម' });
      let tgToggleErr = null;
      let tgToggleOk = false;
      try {
        await renderServiceToggle(cfg.apiKey, cfg.serviceId, body.enabled);
        tgToggleOk = true;
      } catch (e) {
        tgToggleErr = e;
        // Render may reject a suspend/resume that is already in effect
        // (e.g. this service is already 'Suspended by Render' for
        // bandwidth). Re-read the live state: if it already matches the
        // requested state, the toggle is effectively done.
        try {
          const stNow = await renderServiceState(cfg.apiKey, cfg.serviceId);
          if (stNow.suspended === !body.enabled) tgToggleOk = true;
        } catch (e2) {}
      }
      if (!tgToggleOk) {
        return sendJSON(res, 200, { ok: false, error: 'render_api_error', message: 'Render API error: ' + (tgToggleErr && tgToggleErr.message ? tgToggleErr.message : tgToggleErr) });
      }
      const cur2 = await loadSettings();
      await saveSettings(Object.assign(cur2, { telegramBot: Object.assign({}, cur2.telegramBot || {}, { enabled: body.enabled }) }));
      return sendJSON(res, 200, { ok: true, enabled: body.enabled, suspended: !body.enabled, serviceIdConfigured: true, renderKeyConfigured: true, serviceId: cfg.serviceId });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Account-gated rollout (owner order 2026-11-20 09:54/10:02) ----
  // GET /api/public/rollout?version=X&email=Y — PUBLIC. Tells the website
  // whether version X is offered to this account. When the rollout flag
  // names version X with audience "owner", only the owner's accounts
  // (ADMIN_EMAILS) are offered it; everyone else stays on the old version
  // with no update popup and no Update button. Any other version, or
  // audience "all", or no flag at all, is offered to everyone.
  // GET /api/admin/rollout reads the flag (admin key required).
  // POST /api/admin/rollout {version, audience} sets it — the Admin toggle
  // that opens a version to everyone when the owner announces it.
  if (req.method === 'GET' && urlPath === '/api/public/rollout') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const ver = String(q.get('version') || '');
    const email = normEmail(q.get('email') || '');
    const s = await loadSettings();
    const ro = (s && s.rollout && typeof s.rollout === 'object') ? s.rollout : {};
    const roVer = String(ro.version || '');
    const aud = String(ro.audience || 'all');
    let offered = true;
    if (roVer && ver && roVer === ver && aud === 'owner') {
      offered = ADMIN_EMAILS.indexOf(email) >= 0;
    }
    return sendJSON(res, 200, { ok: true, version: ver, audience: aud, offered });
  }
  if (req.method === 'GET' && urlPath === '/api/admin/rollout') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const s = await loadSettings();
    const ro = (s && s.rollout && typeof s.rollout === 'object') ? s.rollout : {};
    return sendJSON(res, 200, { ok: true, version: String(ro.version || ''), audience: String(ro.audience || 'all') });
  }
  if (req.method === 'POST' && urlPath === '/api/admin/rollout') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (!body || typeof body.version !== 'string' || (body.audience !== 'owner' && body.audience !== 'all')) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ version និង audience: owner/all' });
      const out = await saveSettings(Object.assign(await loadSettings(), { rollout: { version: body.version.slice(0, 20), audience: body.audience } }));
      const ro = out.rollout || {};
      return sendJSON(res, 200, { ok: true, version: String(ro.version || ''), audience: String(ro.audience || 'all') });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Monetization (owner order 2026-11-18) ----
  // GET /api/admin/monetization — admin key required. Reads the master
  // toggle (default OFF). POST /api/admin/monetization {enabled} sets it.
  // GET /api/public/monetization/enabled — PUBLIC, no auth.
  if (req.method === 'GET' && urlPath === '/api/admin/monetization') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, enabled: await monetizationEnabled() });
  }
  if (req.method === 'POST' && urlPath === '/api/admin/monetization') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      if (!body || typeof body.enabled !== 'boolean') return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ enabled: true/false' });
      const out = await saveSettings(Object.assign(await loadSettings(), { monetization: body.enabled }));
      return sendJSON(res, 200, { ok: true, enabled: out.monetization === true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/public/monetization/enabled') {
    return sendJSON(res, 200, { ok: true, enabled: await monetizationEnabled() });
  }
  // GET /api/public/monetization/earnings?email=X — PUBLIC. Total earned
  // (dollars), eligible views, lifetime cashback, earnings by country.
  if (req.method === 'GET' && urlPath === '/api/public/monetization/earnings') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail' });
    const got = await monetizationRecord(email);
    const rec = got ? got.rec : { views: 0, watchSeconds: 0, earnMicro: 0, pendingMicro: 0, paidOutMicro: 0, cashbackTotal: 0, byCountry: {} };
    const byCountry = [];
    const bc = (rec.byCountry && typeof rec.byCountry === 'object') ? rec.byCountry : {};
    for (const c of Object.keys(bc).sort()) {
      const v = bc[c] || {};
      byCountry.push({ country: c, views: numOr(v.views, 0), earnings: numOr(v.earnMicro, 0) / 1000000 });
    }
    const _u = (await loadUsers())[email];
    return sendJSON(res, 200, {
      ok: true, email,
      earnings: numOr(rec.earnMicro, 0) / 1000000,
      views: numOr(rec.views, 0),
      cashback: walletMoney(numOr(rec.cashbackTotal, 0)),
      pending: numOr(rec.pendingMicro, 0) / 1000000,
      paidOut: numOr(rec.paidOutMicro, 0) / 1000000,
      watchSeconds: numOr(rec.watchSeconds, 0),
      viewsToday: numOr((rec.viewsByDate && typeof rec.viewsByDate === 'object') ? rec.viewsByDate[imgFreeTodayDate()] : 0, 0),
      newListenerViews: numOr(rec.newListenerViews, 0),
      byCountry,
      earnBalance: _u ? walletEarnBalance(_u) : 0,
      viewEarnTiers: VIEW_EARN_TIERS,
      viewEarnTier: viewEarnTierForUser(_u).id,
      viewEarnRatePer1K: viewEarnTierForUser(_u).ratePer1K,
    });
  }
  // GET /api/public/view-earn-tiers — PUBLIC. The four view-earning
  // tiers (per 1,000 views) by package. No email needed (the Admin
  // reads this to display the rates).
  if (req.method === 'GET' && urlPath === '/api/public/view-earn-tiers') {
    return sendJSON(res, 200, { ok: true, tiers: VIEW_EARN_TIERS });
  }
  // GET /api/public/monetization/status?email=X — PUBLIC. Eligibility
  // (1000 followers + 2000 watch hours), applied/approved, earnings.
  if (req.method === 'GET' && urlPath === '/api/public/monetization/status') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail' });
    const got = await monetizationRecord(email);
    const rec = got ? got.rec : { views: 0, watchSeconds: 0, earnMicro: 0, pendingMicro: 0, paidOutMicro: 0, cashbackTotal: 0, byCountry: {} };
    const followers = await monetizationFollowerCount(email);
    const watchHours = numOr(rec.watchSeconds, 0) / 3600;
    const apps = await loadMonetizationApplications();
    const app = apps[email] || null;
    const applied = !!(app && (app.status === 'pending' || app.status === 'approved'));
    const approved = !!(app && app.status === 'approved');
    const eligible = followers >= MONETIZATION_FOLLOWERS_NEEDED && watchHours >= MONETIZATION_WATCH_HOURS_NEEDED;
    const _u = (await loadUsers())[email];
    return sendJSON(res, 200, {
      ok: true, email, enabled: await monetizationEnabled(),
      followers, followersNeeded: MONETIZATION_FOLLOWERS_NEEDED,
      watchHours: Math.round(watchHours * 100) / 100, watchHoursNeeded: MONETIZATION_WATCH_HOURS_NEEDED,
      eligible, applied, approved,
      earnings: numOr(rec.earnMicro, 0) / 1000000, views: numOr(rec.views, 0),
      earnBalance: _u ? walletEarnBalance(_u) : 0,
      viewEarnTiers: VIEW_EARN_TIERS,
      viewEarnTier: viewEarnTierForUser(_u).id,
      viewEarnRatePer1K: viewEarnTierForUser(_u).ratePer1K,
    });
  }
  // POST /api/public/monetization/apply — {email} — PUBLIC. Applies for
  // monetization when eligible and not already applied/approved.
  // Notifies the Admin (bell + Telegram) so the Admin can approve.
  if (req.method === 'POST' && urlPath === '/api/public/monetization/apply') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន · No account with this Gmail, please sign up first' });
      const got = await monetizationRecord(email);
      const rec = got ? got.rec : { views: 0, watchSeconds: 0, earnMicro: 0, pendingMicro: 0, paidOutMicro: 0, cashbackTotal: 0, byCountry: {} };
      const followers = await monetizationFollowerCount(email);
      const watchHours = numOr(rec.watchSeconds, 0) / 3600;
      if (followers < MONETIZATION_FOLLOWERS_NEEDED || watchHours < MONETIZATION_WATCH_HOURS_NEEDED) {
        return sendJSON(res, 200, { ok: false, error: 'នៅមិនទាន់គ្រប់គោលការណ៍ទេ — ត្រូវការ Followers ' + MONETIZATION_FOLLOWERS_NEEDED + ' (មាន ' + followers + ') និង Watch hours ' + MONETIZATION_WATCH_HOURS_NEEDED + ' (មាន ' + (Math.round(watchHours * 100) / 100) + ') · Not eligible yet — need ' + MONETIZATION_FOLLOWERS_NEEDED + ' followers (have ' + followers + ') and ' + MONETIZATION_WATCH_HOURS_NEEDED + ' watch hours (have ' + (Math.round(watchHours * 100) / 100) + ')', followers, watchHours: Math.round(watchHours * 100) / 100 });
      }
      const apps = await loadMonetizationApplications();
      const prev = apps[email];
      if (prev && (prev.status === 'pending' || prev.status === 'approved')) {
        return sendJSON(res, 200, { ok: false, error: prev.status === 'approved' ? 'អ្នកបានអនុម័តរួចហើយ · Already approved' : 'អ្នកបានស្នើរួចហើយ — សូមរង់ចាំ Admin · Already applied — please wait for the Admin' });
      }
      const now = new Date().toISOString();
      apps[email] = { email, name: u.name || '', followers, watchHours: Math.round(watchHours * 100) / 100, appliedAt: now, status: 'pending' };
      await saveMonetizationApplications(apps);
      scheduleBackup('monetization-applications.json');
      await addNotification('purchase-request', email, '💲 ស្នើ Monetization · Monetization application', (u.name || email) + ' (' + email + ') · ID: ' + (u.id || '—') + ' បានស្នើរកលុយ — Followers ' + followers + ', Watch hours ' + (Math.round(watchHours * 100) / 100), { extra: { monetizationApplication: true, email, followers, watchHours: Math.round(watchHours * 100) / 100, buyerId: u.id || '—' } });
      return sendJSON(res, 200, { ok: true, application: apps[email] });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/monetization/applications — admin key required.
  // Lists all monetization applications, newest first.
  if (req.method === 'GET' && urlPath === '/api/admin/monetization/applications') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const apps = await loadMonetizationApplications();
    const list = Object.values(apps).sort((x, y) => String(y.appliedAt || '').localeCompare(String(x.appliedAt || '')));
    return sendJSON(res, 200, { ok: true, applications: list });
  }
  // POST /api/admin/monetization/approve — {email} — admin key required.
  // Approves the user for monetization; notifies the user.
  if (req.method === 'POST' && urlPath === '/api/admin/monetization/approve') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const apps = await loadMonetizationApplications();
      const app = apps[email];
      if (!app) return sendJSON(res, 200, { ok: false, error: 'រកសំណើនេះមិនឃើញទេ' });
      app.status = 'approved';
      app.decidedAt = new Date().toISOString();
      await saveMonetizationApplications(apps);
      scheduleBackup('monetization-applications.json');
      await addNotification('purchase-approved', email, '✅ Monetization បានអនុម័ត · Monetization approved', (app.name || email) + ' (' + email + ') — ឥឡូវអ្នកអាចរកលុយពី Views និង Cashback បានហើយ · You can now earn from views and cashback', { extra: { monetizationApplication: true, email, decision: 'approved' } });
      return sendJSON(res, 200, { ok: true, application: app });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/monetization/reject — {email, reason?} — admin key
  // required. Rejects the application; the user may apply again later.
  if (req.method === 'POST' && urlPath === '/api/admin/monetization/reject') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const apps = await loadMonetizationApplications();
      const app = apps[email];
      if (!app) return sendJSON(res, 200, { ok: false, error: 'រកសំណើនេះមិនឃើញទេ' });
      app.status = 'rejected';
      if (reason) app.reason = reason;
      app.decidedAt = new Date().toISOString();
      await saveMonetizationApplications(apps);
      scheduleBackup('monetization-applications.json');
      await addNotification('purchase-rejected', email, '❌ Monetization មិនបានអនុម័ត · Monetization rejected', (app.name || email) + ' (' + email + ')' + (reason ? ' — ' + reason : '') + ' · អ្នកអាចស្នើម្ដងទៀតពេលគ្រប់គោលការណ៍ · You may apply again later', { extra: { monetizationApplication: true, email, decision: 'rejected', reason } });
      return sendJSON(res, 200, { ok: true, application: app });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/resync-data — admin key required. Forces an
  // immediate re-pull of public.json + history.json from GitHub
  // (see §6 data-sync fix). Returns what changed.
  if (req.method === 'POST' && urlPath === '/api/admin/resync-data') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async () => {
      // Supabase is the source of truth — nothing to merge. Force a
      // GitHub backup snapshot now and report live counts instead.
      const _posts = await loadPublicPosts();
      const _hist = await loadHistory();
      const out = {
        publicChanged: false, historyChanged: false,
        publicPosts: _posts.length,
        historyItems: Object.values(_hist).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0),
        error: '',
      };
      await runBackupSnapshot();
      return sendJSON(res, 200, { ok: true, resync: out });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/grant — {email, credits, songCredits, note?} — admin key required.
  // credits/songCredits are DELTAS (can be negative to deduct, balance never below 0).
  if (req.method === 'POST' && urlPath === '/api/admin/grant') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
      const dMedia = Math.floor(numOr(body.credits, 0));
      const dSong = Math.floor(numOr(body.songCredits, 0));
      if (!dMedia && !dSong) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ចំនួន Credit' });
      u.credits = Math.max(0, Math.floor(numOr(u.credits, 0)) + dMedia);
      u.songCredits = Math.max(0, Math.floor(numOr(u.songCredits, 0)) + dSong);
      u.updatedAt = new Date().toISOString();
      await saveUsers(users);
      // Critical write: confirm the new balance is on GitHub BEFORE
      // returning success, so a restart cannot lose a granted/deducted
      // credit that the Admin app already reported as done.
      scheduleBackup('users.json');
      await logGrant({ email, credits: dMedia, songCredits: dSong, note: typeof body.note === 'string' ? body.note.slice(0, 200) : '', at: u.updatedAt });
      const deltaText = fmtCreditDelta(dMedia, dSong);
      const grantNote = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
      if (dMedia < 0 || dSong < 0) {
        await addNotification('deduct', email, '➖ កាត់ Credit · Credits deducted', 'Admin បានកាត់ ' + deltaText + ' ពី ' + email + ' · ID: ' + (u.id || '—') + (grantNote ? ' — ' + grantNote : ''));
      } else {
        await addNotification('grant', email, '➕ បន្ថែម Credit · Credits granted', 'Admin បានបន្ថែម ' + deltaText + ' ឲ្យ ' + email + ' · ID: ' + (u.id || '—') + (grantNote ? ' — ' + grantNote : ''));
      }
      return sendJSON(res, 200, { ok: true, user: await pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/user-address — {email, address} — admin key required.
  // Sets ONLY the user's address (no other field, no device/IP change).
  // The address lives in that user's own database record (Supabase users
  // table) — never in the chat prompt — so the AI chat can answer
  // "show me my address" for that user from the database. An empty
  // address clears it.
  if (req.method === 'POST' && urlPath === '/api/admin/user-address') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
      u.address = typeof body.address === 'string' ? body.address.trim().slice(0, 200) : '';
      u.updatedAt = new Date().toISOString();
      await saveUsers(users);
      scheduleBackup('users.json');
      return sendJSON(res, 200, { ok: true, user: await pubUser(u) });
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const newPassword = body && typeof body.newPassword === 'string' ? body.newPassword : '';
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
      const now = new Date().toISOString();
      if (newPassword) {
        if (newPassword.length < 6 || newPassword.length > 64) return sendJSON(res, 200, { ok: false, error: 'Password ត្រូវមាន 6–64 តួអក្សរ · Password must be 6–64 characters' });
        const hp = await hashPassword(newPassword);
        u.passwordSalt = hp.salt;
        u.passwordHash = hp.hash;
        await addNotification('security', email, '🔑 Admin បានប្តូរ Password · Admin reset password', 'Admin បានប្តូរ Password ឲ្យ ' + email + ' (Password ថ្មី — សូមប្រាប់អ្នកប្រើ)');
      } else {
        u.passwordHash = null;
        u.passwordSalt = null;
        await addNotification('security', email, '🔑 Admin បានលុប Password · Admin cleared password', 'Admin បានលុប Password របស់ ' + email + ' — អ្នកប្រើត្រូវបង្កើត Password ថ្មី (Forgot password ឬ Google)');
      }
      revokeAllRememberTokens(u);
      signinClear(email);
      await logActivity({ at: now, mode: 'admin-reset-password', email });
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      return sendJSON(res, 200, { ok: true, user: await pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/admin/user?email=... — admin key required. Removes a user
  // (used to clean up a test user; the Admin app can also use it).
  if (req.method === 'DELETE' && urlPath === '/api/admin/user') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const users = await loadUsers();
    if (!users[email]) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
    delete users[email];
    await saveUsers(users);
    return sendJSON(res, 200, { ok: true, deleted: email });
  }
  // POST /api/admin/block-model — {model} — admin key required. Adds a
  // device model code to the blocked list; that model can no longer sync
  // (no user created/updated, no credits granted). Comparison is
  // case-insensitive; the code is stored as sent.
  if (req.method === 'POST' && urlPath === '/api/admin/block-model') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const model = typeof body && typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      if (!model) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់កូដម៉ូដែល' });
      const blocked = await loadBlockedModels();
      if (!blocked.some((b) => b.toUpperCase() === model.toUpperCase())) blocked.push(model);
      await saveBlockedModels(blocked);
      // Critical write: confirm the block list is on GitHub BEFORE
      // returning success, so a restart cannot lose the block.
      scheduleBackup('blocked-models.json');
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/unblock-model — {model} — admin key required. Removes
  // a device model code from the blocked list so it can sync again.
  if (req.method === 'POST' && urlPath === '/api/admin/unblock-model') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const model = typeof body && typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      if (!model) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់កូដម៉ូដែល' });
      const blocked = (await loadBlockedModels()).filter((b) => b.toUpperCase() !== model.toUpperCase());
      await saveBlockedModels(blocked);
      scheduleBackup('blocked-models.json');
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/blocked-models — admin key required. Lists the blocked
  // device model codes.
  if (req.method === 'GET' && urlPath === '/api/admin/blocked-models') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, blocked: await loadBlockedModels() });
  }
  // POST /api/admin/block-ip — {ip} — admin key required. MANUAL block:
  // the admin reviews the Security section and decides. A blocked IP
  // cannot sync (and cannot call admin endpoints with a wrong key).
  if (req.method === 'POST' && urlPath === '/api/admin/block-ip') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const ip = typeof body && typeof body.ip === 'string' ? body.ip.trim().slice(0, 64) : '';
      if (!ip || !/^[0-9a-zA-Z:.\-]+$/.test(ip)) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ IP ត្រឹមត្រូវ' });
      const blocked = await loadBlockedIps();
      if (!blocked.some((b) => b === ip)) blocked.push(ip);
      await saveBlockedIps(blocked);
      scheduleBackup('blocked-ips.json');
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/unblock-ip — {ip} — admin key required. Removes an IP
  // from the blocked list so it can sync again.
  if (req.method === 'POST' && urlPath === '/api/admin/unblock-ip') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const ip = typeof body && typeof body.ip === 'string' ? body.ip.trim().slice(0, 64) : '';
      if (!ip) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ IP ត្រឹមត្រូវ' });
      const blocked = (await loadBlockedIps()).filter((b) => b !== ip);
      await saveBlockedIps(blocked);
      scheduleBackup('blocked-ips.json');
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/blocked-ips — admin key required. Lists blocked IPs.
  if (req.method === 'GET' && urlPath === '/api/admin/blocked-ips') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, blocked: await loadBlockedIps() });
  }
  // POST /api/admin/block-email — {email} — admin key required. MANUAL
  // block: a blocked Gmail cannot sync at all.
  if (req.method === 'POST' && urlPath === '/api/admin/block-email') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const blocked = await loadBlockedEmails();
      if (!blocked.some((b) => b === email)) blocked.push(email);
      await saveBlockedEmails(blocked);
      scheduleBackup('blocked-emails.json');
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/unblock-email — {email} — admin key required. Removes
  // a Gmail from the blocked list so it can sync again.
  if (req.method === 'POST' && urlPath === '/api/admin/unblock-email') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const blocked = (await loadBlockedEmails()).filter((b) => b !== email);
      await saveBlockedEmails(blocked);
      scheduleBackup('blocked-emails.json');
      return sendJSON(res, 200, { ok: true, blocked });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/blocked-emails — admin key required. Lists blocked Gmails.
  if (req.method === 'GET' && urlPath === '/api/admin/blocked-emails') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    return sendJSON(res, 200, { ok: true, blocked: await loadBlockedEmails() });
  }
  // GET /api/admin/device-records — admin key required. Lists all known
  // devices (fingerprint -> slots, strikes, blocked, VPN flags, model,
  // last IP, Gmails seen from it), newest first. The Admin reviews
  // blocked devices here and unblocks them.
  if (req.method === 'GET' && urlPath === '/api/admin/device-records') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const all = await loadDeviceRecords();
    const list = Object.keys(all).map((k) => Object.assign({ fingerprint: k }, all[k])).sort((x, y) => String(y.lastSeen || '').localeCompare(String(x.lastSeen || '')));
    return sendJSON(res, 200, { ok: true, devices: list });
  }
  // POST /api/admin/unblock-device — {fingerprint} — admin key required.
  // Clears a device block (strike 4+) and resets its strikes to 0, so
  // the device can sign in and register again. Also lifts the block on
  // the Gmails that this device's strike blocked (tracked on the record).
  if (req.method === 'POST' && urlPath === '/api/admin/unblock-device') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const fingerprint = typeof body && typeof body.fingerprint === 'string' ? body.fingerprint.trim().slice(0, 128) : '';
      if (!fingerprint) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ fingerprint របស់ឧបករណ៍' });
      const all = await loadDeviceRecords();
      const rec = all[fingerprint];
      if (!rec || typeof rec !== 'object') return sendJSON(res, 200, { ok: false, error: 'រកឧបករណ៍នេះមិនឃើញទេ' });
      rec.blocked = false;
      rec.blockedReason = '';
      rec.blockedAt = '';
      rec.strikes = 0;
      const cleared = Array.isArray(rec.blockedEmails) ? rec.blockedEmails.filter((e) => typeof e === 'string' && e) : [];
      rec.blockedEmails = [];
      await saveDeviceRecords(all);
      scheduleBackup('device-records.json');
      if (cleared.length) {
        const bem = (await loadBlockedEmails()).filter((b) => !cleared.includes(b));
        await saveBlockedEmails(bem);
        scheduleBackup('blocked-emails.json');
      }
      await addNotification('security', '', '✅ ឧបករណ៍ត្រូវបានដោះប្លុក · Device unblocked', 'Admin បានដោះប្លុកឧបករណ៍ ' + fingerprint + ' (' + (rec.model || '') + ')' + (cleared.length ? ' — Gmail ត្រូវបានដោះប្លុក៖ ' + cleared.join(', ') : ''));
      return sendJSON(res, 200, { ok: true, fingerprint, unblockedEmails: cleared });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/settings — PUBLIC (no admin key). The MovAi website reads
  // it on load to know whether the admin turned Smooth mode Auto on.
  if (req.method === 'GET' && urlPath === '/api/admin/settings') {
    return sendJSON(res, 200, { ok: true, settings: publicSettings(await loadSettings()) });
  }
  // POST /api/admin/settings — {smoothModeAuto, theme, font, glassClear,
  // glassBlur, glassShine, tshadow, txtblur, bgb, brandfx, mode, payment} — admin key
  // required. Fields sent are merged over the stored settings; missing
  // fields keep their stored value. Values are validated/clamped.
  if (req.method === 'POST' && urlPath === '/api/admin/settings') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const cur = await loadSettings();
      const merged = Object.assign({}, cur, body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      const saved = await saveSettings(merged, cur);
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const provider = normProvider(body && body.provider);
      if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ API Key' });
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim().slice(0, 500) : '';
      const keys = await loadAdminKeys();
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
      await saveAdminKeys(keys);
      scheduleBackup('admin-keys.json');
      // Re-adding a key restores a deleted provider (owner order 2026-11-20 13:07).
      try {
        const del = await getDeletedProviders();
        if (del.includes(provider)) {
          const cur = await loadSettings();
          cur.deletedProviders = del.filter((p) => p !== provider);
          await saveSettings(cur, cur);
        }
      } catch (e) {}
      return sendJSON(res, 200, { ok: true, provider, keyCount: rec.keys.length, hasKey: true, hasEndpoint: rec.keys.some((e) => e && e.endpoint && e.endpoint.trim()) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/admin/keys — {provider, index} — admin key required.
  // Removes the key at that index from the provider's list.
  if (req.method === 'DELETE' && urlPath === '/api/admin/keys') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const provider = normProvider(body && body.provider);
      if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      const idx = Number(body && body.index);
      const keys = await loadAdminKeys();
      const rec = keys[provider];
      const list = rec && Array.isArray(rec.keys) ? rec.keys : [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return sendJSON(res, 200, { ok: false, error: 'Index មិនត្រឹមត្រូវទេ' });
      list.splice(idx, 1);
      rec.updatedAt = new Date().toISOString();
      await saveAdminKeys(keys);
      scheduleBackup('admin-keys.json');
      return sendJSON(res, 200, { ok: true, provider, keyCount: list.length, hasKey: list.length > 0, hasEndpoint: list.some((e) => e && e.endpoint && e.endpoint.trim()) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/keys — admin key required. Lists which providers have
  // keys stored, HOW MANY per provider (keyCount), and whether an endpoint
  // is set. Key values are NEVER returned.
  if (req.method === 'GET' && urlPath === '/api/admin/keys') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const keys = await loadAdminKeys();
    const list = Object.keys(keys).sort().map((p) => {
      const arr = keys[p] && Array.isArray(keys[p].keys) ? keys[p].keys : [];
      return { provider: p, hasKey: arr.length > 0, keyCount: arr.length, hasEndpoint: arr.some((e) => e && e.endpoint && e.endpoint.trim()) };
    });
    return sendJSON(res, 200, { ok: true, keys: list, deleted: await getDeletedProviders() });
  }
  // GET /api/admin/keys/values?provider=X — admin key required. Returns
  // the FULL key values for one provider so the Admin app can show (eye)
  // and copy them. Only the admin-key holder (the owner) can call this —
  // the public GET /api/admin/keys never returns values.
  if (req.method === 'GET' && urlPath === '/api/admin/keys/values') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const provider = normProvider(new URL(req.url, 'http://localhost').searchParams.get('provider') || '');
    if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
    const rec = (await loadAdminKeys())[provider];
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
    const k = await currentAdminKey();
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
      await saveAdminKeyFile(newKey);
      scheduleBackup('admin-key.json');
      try { await clearAdminLockout(getClientIp(req)); } catch (e) {}
      await addNotification('security', s.email, '🗝️ Admin Key ត្រូវបានប្តូរ · Admin Key changed', 'Admin Key ត្រូវបានប្តូរដោយ ' + s.email + ' (តាមរយៈ Google sign-in)');
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
      if (p === 'agnes') {
        // Agnes AI is OpenAI-compatible: GET /v1/models on the Agnes hub
        // answers 200 for a valid key, 401/403 for a bad one.
        const r = await fetch('https://apihub.agnes-ai.com/v1/models', { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 200) return okMsg;
        if (r.status === 401 || r.status === 403) return blockedMsg(r.status);
        if (r.status === 429) return { status: 'error', message: 'Rate limit (HTTP 429) — សាកល្បងម្តងទៀតពេលក្រោយ' };
        return { status: 'error', message: 'Agnes AI ឆ្លើយ HTTP ' + r.status };
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const provider = normProvider(new URL(req.url, 'http://localhost').searchParams.get('provider') || '');
    if (!KNOWN_KEY_PROVIDERS.includes(provider)) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
    const rec = (await loadAdminKeys())[provider];
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
      if (!['image', 'video', 'song'].includes(mode)) return sendJSON(res, 200, { ok: false, error: 'Mode មិនត្រឹមត្រូវទេ' });
      const provider = normProvider(body && body.provider);
      if (!provider) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើស provider' });
      const model = typeof body.model === 'string' ? body.model.trim().slice(0, 100) : '';
      const cur = await loadSettings();
      cur.providers[mode] = { provider, model };
      const saved = await saveSettings(cur, cur);
      return sendJSON(res, 200, { ok: true, providers: saved.providers });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/admin/providers — {provider} — admin key required.
  // DELETES a whole provider/system (owner order 2026-11-20 13:07):
  // removes ALL its stored keys, clears its key-health records, clears
  // it from the active provider/mode, and records it in
  // settings.deletedProviders so the website hides/stops offering it.
  // 'cloudinary' deletes all admin-added Cloudinary accounts (the Main
  // env account cannot be deleted — the server refuses that).
  // Re-adding a key for the provider (POST /api/admin/keys) restores it.
  if (req.method === 'DELETE' && urlPath === '/api/admin/providers') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const provider = normProvider(body && body.provider);
      if (!provider || !(KNOWN_KEY_PROVIDERS.includes(provider) || provider === 'cloudinary')) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      let removedKeys = 0;
      let removedCld = 0;
      if (provider === 'cloudinary') {
        const arr = await loadCloudinaryAccounts();
        const kept = arr.filter((x) => x && x.id === 'env');
        removedCld = arr.length - kept.length;
        await saveCloudinaryAccounts(kept);
        scheduleBackup('cloudinary-accounts.json');
      } else {
        const keys = await loadAdminKeys();
        const rec = keys[provider];
        removedKeys = rec && Array.isArray(rec.keys) ? rec.keys.length : 0;
        if (keys[provider]) delete keys[provider];
        await saveAdminKeys(keys);
        scheduleBackup('admin-keys.json');
      }
      // Clear key-health records so provider-status stops listing it.
      try {
        await keyHealthEnsure();
        if (_keyHealth[provider]) { delete _keyHealth[provider]; await keyHealthSave(); }
      } catch (e) {}
      // Clear it from the active provider/mode and mark it deleted.
      const cur = await loadSettings();
      if (cur.providers && typeof cur.providers === 'object') {
        for (const m of ['image', 'video', 'song']) {
          if (cur.providers[m] && cur.providers[m].provider === provider) cur.providers[m] = null;
        }
      }
      const del = await getDeletedProviders();
      if (!del.includes(provider)) del.push(provider);
      cur.deletedProviders = del;
      await saveSettings(cur, cur);
      return sendJSON(res, 200, { ok: true, provider, deleted: true, removedKeys, removedCldAccounts: removedCld });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/providers/restore — {provider} — admin key required.
  // Removes a provider from settings.deletedProviders (undoes a delete).
  // Keys stay empty — the owner adds keys again to use it.
  if (req.method === 'POST' && urlPath === '/api/admin/providers/restore') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const provider = normProvider(body && body.provider);
      if (!provider || !(KNOWN_KEY_PROVIDERS.includes(provider) || provider === 'cloudinary')) return sendJSON(res, 200, { ok: false, error: 'Provider មិនស្គាល់ទេ' });
      const del = await getDeletedProviders();
      const i = del.indexOf(provider);
      if (i >= 0) del.splice(i, 1);
      const cur = await loadSettings();
      cur.deletedProviders = del;
      await saveSettings(cur, cur);
      return sendJSON(res, 200, { ok: true, provider, deleted: false });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/providers — PUBLIC (no admin key). The MovAi website
  // reads it to know which provider/model the admin set for each mode.
  // A mode is null when the admin has not set it yet.
  if (req.method === 'GET' && urlPath === '/api/admin/providers') {
    const s = await loadSettings();
    return sendJSON(res, 200, { ok: true, providers: s.providers || { image: null, video: null, song: null } });
  }
  // GET /api/public/credit-history?email=... — PUBLIC. The user's own
  // credit history: every grant (+) and deduction (-) with note + time,
  // newest first. This is what the Profile shows as "History".
  if (req.method === 'GET' && urlPath === '/api/public/credit-history') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail' });
    const arr = await loadGrants();
    const mine = arr.filter((g) => g && typeof g.email === 'string' && g.email.toLowerCase() === email).slice(-100).reverse();
    return sendJSON(res, 200, { ok: true, email, history: mine.map((g) => ({ credits: numOr(g.credits, 0), songCredits: numOr(g.songCredits, 0), note: typeof g.note === 'string' ? g.note : '', at: g.at || '' })) });
  }
  // GET /api/public/history?email=... — PUBLIC. The user's own created
  // things (History): songs/images/videos, newest first, max 300.
  // This is what makes ONE Gmail show ALL old data on ANY device.
  if (req.method === 'GET' && urlPath === '/api/public/history') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail' });
    const h = await loadHistory();
    const tombs = await loadDeletedItems();
    const arr = (Array.isArray(h[email]) ? h[email] : []).filter((it) => { const k = histKey(it); return k && !tombs.history[k]; });
    // Server tombstones, so the phone can DROP local items deleted
    // server-side (owner 2026-11-18: a deleted broken song stayed in
    // the phone's localStorage because pull only ADDED). Return the
    // ids/urls (most recent 600) alongside the items.
    const tombKeys = Object.keys(tombs.history || {});
    tombKeys.sort((a, b) => String(tombs.history[b] || '').localeCompare(String(tombs.history[a] || '')));
    const recent = tombKeys.slice(0, 600);
    const deletedIds = recent.filter((k) => k.indexOf('id:') === 0).map((k) => k.slice(3));
    const deletedUrls = recent.filter((k) => k.indexOf('url:') === 0).map((k) => k.slice(4));
    return sendJSON(res, 200, { ok: true, email, items: arr.slice(0, 300), deletedIds, deletedUrls });
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
      // Supabase is the source of truth: loadHistory() below already
      // reads fresh state, so no merge is needed before the union.
      // Tombstones still guard against resurrecting deleted items.
      const tombs = await loadDeletedItems();
      let tombsChanged = false;
      const h = await loadHistory();
      const byKey = {};
      const stored = Array.isArray(h[email]) ? h[email] : [];
      for (const it of stored) {
        if (!it || typeof it !== 'object') continue;
        const k = histKey(it);
        if (!k) continue;
        // A tombstoned item must never survive in storage, even if the
        // throttled merge has not run yet to remove it.
        if (tombs.history[k]) continue;
        byKey[k] = it;
      }
      // PERMANENT URL (owner order 2026-11-18): History items must store
      // a permanent Cloudinary URL, never a Magic Hour signed URL (dead
      // in 24h). Convert Magic Hour URLs in parallel (fast HEAD check
      // first, upload only when the copy does not exist yet). A URL that
      // cannot be made permanent is kept as-is (the startup heal retries
      // it later) so a History sync never loses the user's song.
      // Tombstone check (resurrection bug 2026-11-18): the phone still
      // holds items the owner deleted; the union below must NOT resurrect
      // them. Drop any incoming item whose id is already tombstoned
      // before converting (a conversion would only waste the work).
      const liveIncoming = body.items.filter((it) => {
        if (!it || typeof it !== 'object') return false;
        const id = typeof it.id === 'string' ? it.id.trim() : '';
        if (id && tombs.history['id:' + id]) return false;
        return true;
      });
      const converted = await Promise.all(liveIncoming.map(async (it) => {
        if (!it || typeof it !== 'object') return it;
        const u = typeof it.url === 'string' ? it.url : '';
        if (!u || !isMagicHourUrl(u)) return it;
        try {
          const perm = await permanentSongUrl(u, it.title || '');
          if (perm && perm !== u) return Object.assign({}, it, { url: perm });
        } catch (e) {}
        return it;
      }));
      for (const it of converted) {
        if (!it || typeof it !== 'object') continue;
        const k = histKey(it);
        if (!k) continue;
        if (tombs.history[k]) continue; // tombstoned by key (id or final permanent URL) — never re-add
        const clean = Object.assign({}, it);
        delete clean.thumb;
        const prev = byKey[k];
        if (!prev) {
          // Resurrection guard (tombstone fix 2026-11-18): a deleted
          // item lives only on the phone now — Supabase is the source of
          // truth, so a deletion there is final. An incoming item NOT
          // already stored whose timestamp is older than the 5-minute
          // grace was deleted (or never existed there): a genuinely new
          // item is synced within minutes of creation. Refuse it and
          // tombstone it so it can never come back.
          const ts = numOr(clean.ts, 0);
          const graceMs = 5 * 60 * 1000;
          if (!Number.isFinite(ts) || ts <= 0 || Date.now() - ts >= graceMs) {
            if (!tombs.history[k]) { tombs.history[k] = new Date().toISOString(); tombsChanged = true; }
            continue;
          }
        }
        if (!prev || numOr(clean.ts, 0) > numOr(prev.ts, 0)) byKey[k] = clean;
      }
      const merged = Object.values(byKey).sort((a, b) => numOr(b.ts, 0) - numOr(a.ts, 0)).slice(0, 300);
      h[email] = merged;
      await saveHistory(h);
      // Critical write: confirm history.json is on GitHub BEFORE
      // returning success, so a restart cannot lose History already
      // reported as saved.
      scheduleBackup('history.json');
      if (tombsChanged) { await saveDeletedItems(tombs); scheduleBackup('deleted-items.json'); }
      return sendJSON(res, 200, { ok: true, email, items: merged });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }

  // ---- Auto Update Version New (endpoints) ----
  // GET /api/admin/updates — admin key required. Lists updates + settings.
  if (req.method === 'GET' && urlPath === '/api/admin/updates') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const u = await loadUpdates();
    return sendJSON(res, 200, { ok: true, updates: u.updates, settings: u.settings, lastCheckAt: u.lastCheckAt, lastCheckResult: u.lastCheckResult, approvedModels: u.approvedModels, blockedModels: u.blockedModels });
  }
  // POST /api/admin/updates/check — admin key required. Run a check now.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/check') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    (async () => {
      const n = await autoUpdateCheckModels();
      return sendJSON(res, 200, { ok: true, newCount: n });
    })().catch(() => sendJSON(res, 200, { ok: false, error: 'ពិនិត្យមិនបានទេ' }));
    return;
  }
  // POST /api/admin/updates/approve — {updateId} — admin key required.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/approve') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.updateId === 'string' ? body.updateId.trim() : '';
      const u = await loadUpdates();
      const rec = u.updates.find((x) => x.id === id);
      if (!rec) return sendJSON(res, 200, { ok: false, error: 'រក update នេះមិនឃើញទេ' });
      const ok2 = await autoUpdateApplyUpdate(rec, 'admin');
      return sendJSON(res, 200, { ok: ok2, updates: (await loadUpdates()).updates });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/updates/reject — {updateId} — admin key required.
  // "Don't update": blocks the model so it is never re-detected.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/reject') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.updateId === 'string' ? body.updateId.trim() : '';
      const u = await loadUpdates();
      const rec = u.updates.find((x) => x.id === id);
      if (!rec) return sendJSON(res, 200, { ok: false, error: 'រក update នេះមិនឃើញទេ' });
      if (rec.status === 'pending') {
        rec.status = 'rejected';
        rec.decidedAt = new Date().toISOString();
        rec.decidedBy = 'admin';
        const key = rec.provider + ':' + rec.model;
        if (!u.blockedModels.includes(key)) u.blockedModels.push(key);
        await saveUpdates(u);
        scheduleBackup('updates.json');
        await addNotification('update', '', '🚫 មិន Update · ' + rec.provider + ' — ' + rec.model, 'Admin ដាក់ "មិនចាំបាច់ Update" សម្រាប់ model ' + rec.model + '។ វានឹងមិនលេចឡើងម្តងទៀតទេ។');
      }
      return sendJSON(res, 200, { ok: true, updates: (await loadUpdates()).updates });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/updates/settings — {autoApply, autoApplyHours, checkIntervalHours} — admin key required.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/settings') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const u = await loadUpdates();
      if (typeof body.autoApply === 'boolean') u.settings.autoApply = body.autoApply;
      if (typeof body.autoApplyHours === 'number' && body.autoApplyHours >= 1 && body.autoApplyHours <= 720) u.settings.autoApplyHours = Math.round(body.autoApplyHours);
      if (typeof body.checkIntervalHours === 'number' && body.checkIntervalHours >= 1 && body.checkIntervalHours <= 168) u.settings.checkIntervalHours = Math.round(body.checkIntervalHours);
      await saveUpdates(u);
      scheduleBackup('updates.json');
      return sendJSON(res, 200, { ok: true, settings: u.settings });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/updates/add — {provider, model, note} — admin key
  // required. Manually register a new model (e.g. Suno v6.5 announced on
  // their blog — no API to detect it). Creates a pending update.
  if (req.method === 'POST' && urlPath === '/api/admin/updates/add') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const provider = normProvider(body && body.provider);
      const model = typeof body.model === 'string' ? body.model.trim().slice(0, 100) : '';
      if (!provider || !model) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ provider និង model' });
      const u = await loadUpdates();
      if (!Array.isArray(u.knownModels[provider])) u.knownModels[provider] = [];
      if (!u.knownModels[provider].includes(model)) u.knownModels[provider].push(model);
      const dup = u.updates.find((x) => x.provider === provider && x.model === model && x.status === 'pending');
      if (dup) return sendJSON(res, 200, { ok: false, error: 'Model នេះមានក្នុងបញ្ជីរង់ចាំហើយ' });
      const rec = { id: newUpdateId(), provider, model, status: 'pending', source: 'manual', detectedAt: new Date().toISOString(), decidedAt: null, decidedBy: '', note: typeof body.note === 'string' ? body.note.slice(0, 200) : '' };
      u.updates.unshift(rec);
      await saveUpdates(u);
      scheduleBackup('updates.json');
      await addNotification('update', '', '🆕 Model ថ្មី (Manual) · ' + provider + ' — ' + model, 'Admin បន្ថែម model ថ្មី៖ ' + model + '។ សូម Approve ឬដាក់ "មិនចាំបាច់ Update"។');
      return sendJSON(res, 200, { ok: true, updates: u.updates });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/public/models — PUBLIC (no admin key). The MovAi website
  // reads it to show the approved model list; models approved within the
  // last 7 days are flagged "new" so the website can show a New badge.
  if (req.method === 'GET' && urlPath === '/api/public/models') {
    const u = await loadUpdates();
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
    'song-trial': { credits: 0, songCredits: 600, days: 30, price: 5 },
    'song-popular': { credits: 0, songCredits: 1200, days: 30, price: 10 },
    'song-30': { credits: 0, songCredits: 4000, days: 30, price: 30 },
    'song-50': { credits: 0, songCredits: 7200, days: 30, price: 50 },
    'song-pro': { credits: 0, songCredits: 3750, days: 30, price: 22 },
  };
  const PACKAGE_ORDER = ['monthly', 'yearly', 'song-trial', 'song-popular', 'song-30', 'song-50', 'song-pro'];
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
  async function loadPackages() {
    try { const j = await loadKvDoc('packages', null); return cleanPackages(j); } catch (e) {}
      return cleanPackages(null);
  }
  async function savePackages(map) {
    const out = cleanPackages(map);
      await saveKvDoc('packages', out, 'packages.json');
      return out;
  }
  // Public view: credits/durations exposed as mediaCredits/songCredits/durationDays.
  async function pubPackages() {
    const map = await loadPackages();
    return PACKAGE_ORDER.map((id) => {
      const p = map[id];
      return { id: p.id, price: p.price, originalPrice: p.originalPrice, mediaCredits: p.credits, songCredits: p.songCredits, durationDays: p.days };
    });
  }
  // GET /api/public/packages — PUBLIC. The website reads live package prices
  // from here (discount % = round((originalPrice-price)/originalPrice*100)
  // when price < originalPrice, computed by the client).
  if (req.method === 'GET' && urlPath === '/api/public/packages') {
    return sendJSON(res, 200, { ok: true, packages: await pubPackages() });
  }
  // POST /api/admin/packages — {packages:[{id, price, originalPrice?}]}
  // — admin key required. Edits price and/or originalPrice per package id.
  // Unknown ids are rejected; price/originalPrice must be >= 0. Returns the
  // full updated list.
  if (req.method === 'POST' && urlPath === '/api/admin/packages') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const list = body && Array.isArray(body.packages) ? body.packages : null;
      if (!list || !list.length) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់កញ្ចប់ដែលចង់កែ' });
      const map = await loadPackages();
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
      await savePackages(map);
      return sendJSON(res, 200, { ok: true, packages: await pubPackages() });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- MovAi Song-Selling Service (v2.2.61, owner-only preview) ----
  // A seller lists a fixed-size package of their own songs; a buyer pays
  // with Wallet (or KHQR + receipt, approved by Admin). MovAi keeps 5%,
  // the seller gets 95% into Earn Balance (withdraw-only, like cashback).
  // Storage (Supabase kv_docs, no new tables):
  //   'sell-listings'   -> array of listings
  //   'sell-downloaded' -> {email: [songKey, ...]} (songs the owner
  //                        already downloaded — can never be listed)
  //   'sell-sales'      -> array of completed-sale log entries
  // Song key = the history_items item_key for that song (histKey: id: or
  // url:). pairKey = taskId (the two clips of one generation share it).
  // NO provider names anywhere in user-facing strings — 'MovAi' only.
  const SELL_TIERS = [
    { tier: 1, price: 1, songs: 6, bonus: 0, base: 6, cost: 0.60, movai: 0.05, seller: 0.95, net: 0.35 },
    { tier: 2, price: 2, songs: 12, bonus: 0, base: 12, cost: 1.20, movai: 0.10, seller: 1.90, net: 0.70 },
    { tier: 3, price: 3, songs: 18, bonus: 0, base: 18, cost: 1.80, movai: 0.15, seller: 2.85, net: 1.05 },
    { tier: 4, price: 4, songs: 24, bonus: 0, base: 24, cost: 2.40, movai: 0.20, seller: 3.80, net: 1.40 },
    { tier: 5, price: 5, songs: 32, bonus: 2, base: 30, cost: 3.20, movai: 0.25, seller: 4.75, net: 1.55 },
    { tier: 10, price: 10, songs: 65, bonus: 5, base: 60, cost: 6.50, movai: 0.50, seller: 9.50, net: 3.00 },
    { tier: 15, price: 15, songs: 98, bonus: 8, base: 90, cost: 9.80, movai: 0.75, seller: 14.25, net: 4.45 },
    { tier: 20, price: 20, songs: 132, bonus: 12, base: 120, cost: 13.20, movai: 1.00, seller: 19.00, net: 5.80 },
    { tier: 25, price: 25, songs: 165, bonus: 15, base: 150, cost: 16.50, movai: 1.25, seller: 23.75, net: 7.25 },
  ];
  function sellTierByTier(t) {
    const n = Math.floor(numOr(t, 0));
    return SELL_TIERS.find((x) => x.tier === n) || null;
  }
  function sellDisplayName(users, email) {
    const u = users && users[email];
    if (u && typeof u.name === 'string' && u.name.trim()) return u.name.trim().slice(0, 100);
    return String(email || '').split('@')[0] || email || '';
  }
  function sellNewId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  async function loadSellListings() {
    const j = await loadKvDoc('sell-listings', []);
    return Array.isArray(j) ? j.filter((x) => x && typeof x === 'object') : [];
  }
  async function saveSellListings(arr) {
    await saveKvDoc('sell-listings', Array.isArray(arr) ? arr : [], 'sell-listings.json');
  }
  async function loadSellDownloaded() {
    const j = await loadKvDoc('sell-downloaded', {});
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  }
  async function saveSellDownloaded(m) {
    await saveKvDoc('sell-downloaded', (m && typeof m === 'object') ? m : {}, 'sell-downloaded.json');
  }
  async function loadSellSales() {
    const j = await loadKvDoc('sell-sales', []);
    return Array.isArray(j) ? j : [];
  }
  async function saveSellSales(arr) {
    await saveKvDoc('sell-sales', (Array.isArray(arr) ? arr : []).slice(-1000), 'sell-sales.json');
  }
  // Normalise one history item into a sellable song. Only song items
  // count: an item whose mode/type is image, video or 3d is not a song.
  function sellIsSongItem(it) {
    if (!it || typeof it !== 'object') return false;
    const m = typeof it.mode === 'string' ? it.mode.trim().toLowerCase() : (typeof it.type === 'string' ? it.type.trim().toLowerCase() : '');
    if (m === 'image' || m === 'video' || m === '3d') return false;
    const u = typeof it.url === 'string' ? it.url.trim() : (typeof it.src === 'string' ? it.src.trim() : '');
    return !!u;
  }
  function sellSongFromHistory(it) {
    const key = histKey(it);
    const url = typeof it.url === 'string' ? it.url.trim() : (typeof it.src === 'string' ? it.src.trim() : '');
    const ts = numOr(it.ts, 0);
    return {
      key,
      title: typeof it.title === 'string' ? it.title.trim().slice(0, 200) : '',
      url: url.slice(0, 2000),
      image: typeof it.image === 'string' ? it.image.trim().slice(0, 2000) : (typeof it.cover === 'string' ? it.cover.trim().slice(0, 2000) : ''),
      style: typeof it.style === 'string' ? it.style.trim().slice(0, 200) : '',
      taskId: typeof it.taskId === 'string' ? it.taskId.trim() : '',
      audioId: typeof it.audioId === 'string' ? it.audioId.trim() : '',
      duration: numOr(it.duration, 0),
      createdAt: typeof it.createdAt === 'string' ? it.createdAt : (ts ? new Date(ts).toISOString() : ''),
      origin: it.origin === 'bought' ? 'bought' : 'created',
    };
  }
  // Public (market-safe) view of one listed song: NEVER an audio URL.
  function sellSongPublic(s) {
    return { title: s.title || '', style: s.style || '', duration: numOr(s.duration, 0) };
  }
  // Why a song cannot be listed: null = sellable. Checked in this order.
  function sellBlockedReason(email, song, listings, downloaded, posts) {
    const dl = downloaded && Array.isArray(downloaded[email]) ? downloaded[email] : [];
    if (dl.indexOf(song.key) >= 0) return 'downloaded';
    if (Array.isArray(posts)) {
      for (const p of posts) {
        if (!p || p.email !== email) continue;
        if (song.audioId && p.audioId && p.audioId === song.audioId) return 'posted';
        if (song.url && p.url && p.url === song.url) return 'posted';
      }
    }
    if (Array.isArray(listings)) {
      for (const l of listings) {
        if (!l || l.sellerEmail !== email || !Array.isArray(l.songs)) continue;
        if (l.status === 'active' && l.songs.some((s) => s && s.key === song.key)) return 'listed';
      }
      for (const l of listings) {
        if (!l || l.sellerEmail !== email || !Array.isArray(l.songs)) continue;
        if (l.status === 'sold' && l.songs.some((s) => s && s.key === song.key)) return 'sold';
      }
    }
    return null;
  }
  // NO RE-SALE: a song bought from someone else can NEVER be listed
  // again — only songs the user created themselves are sellable.
  // origin 'bought' is set on the buyer's history copies by
  // completeSellSale; a missing origin means 'created'. Fallback for
  // older transferred copies without the origin field: a song key that
  // appears in a SOLD listing whose buyer is this user is also bought.
  function sellIsBoughtSong(email, song, listings) {
    if (!song) return false;
    if (song.origin === 'bought') return true;
    if (Array.isArray(listings)) {
      for (const l of listings) {
        if (!l || l.status !== 'sold' || l.buyerEmail !== email || !Array.isArray(l.songs)) continue;
        if (l.songs.some((x) => x && x.key === song.key)) return true;
      }
    }
    return false;
  }
  // BOUGHT-SONG EXPIRY (v2.2.61, CORRECTED 2026-11-21 ~12:49): bought
  // songs ONLY — self-created songs never expire. Expiry = 3 MONTHS
  // after purchase (soldAt + 90 days). The download deadline IS the
  // expiry: the buyer must download all songs within the 3-month window;
  // at 3 months any remaining songs are gone (no longer playable or
  // downloadable). Expiry is purely time-based — no separate download
  // check, no 'not-downloaded' reason. downloadedCount/totalCount are
  // display-only. downloadedMap = 'sell-downloaded' (email -> [songKey]).
  // Legacy listings without buyerKeys have no per-song download record
  // (downloadedCount = total, display only).
  function sellBoughtExpiry(listing, downloadedMap) {
    const soldAt = (listing && typeof listing.soldAt === 'string' && listing.soldAt) ? listing.soldAt : (listing && typeof listing.createdAt === 'string' ? listing.createdAt : '');
    const soldMs = Date.parse(soldAt);
    const keys = (listing && Array.isArray(listing.buyerKeys)) ? listing.buyerKeys : [];
    const totalCount = keys.length || (listing && Array.isArray(listing.songs) ? listing.songs.length : 0);
    const dl = (downloadedMap && listing && Array.isArray(downloadedMap[listing.buyerEmail])) ? downloadedMap[listing.buyerEmail] : [];
    const downloadedCount = keys.length ? keys.filter((k) => dl.indexOf(k) >= 0).length : totalCount;
    if (!Number.isFinite(soldMs)) return { expiresAt: '', downloadBy: '', downloadedCount, totalCount, expired: false, reason: null };
    const expiresAt = new Date(soldMs + 90 * 86400000).toISOString();
    const downloadBy = expiresAt;
    const expired = Date.now() > soldMs + 90 * 86400000;
    return { expiresAt, downloadBy, downloadedCount, totalCount, expired, reason: expired ? 'expired' : null };
  }
  // Expiry for ONE bought history song: find the sold listing that
  // transferred it to this buyer (by buyerKey, or by the sellListingId
  // stamped on the copy); if no listing is found, fall back to the
  // copy's own boughtAt field. Returns null when neither exists.
  function sellExpiryForBoughtSong(email, it, listings, downloadedMap) {
    if (!it || typeof it !== 'object') return null;
    const key = histKey(it);
    if (Array.isArray(listings)) {
      for (const l of listings) {
        if (!l || l.status !== 'sold' || l.buyerEmail !== email) continue;
        const keys = Array.isArray(l.buyerKeys) ? l.buyerKeys : [];
        if ((key && keys.indexOf(key) >= 0) || (typeof it.sellListingId === 'string' && it.sellListingId && l.id === it.sellListingId)) {
          const e = sellBoughtExpiry(l, downloadedMap);
          return { expiresAt: e.expiresAt, downloadBy: e.downloadBy, expired: e.expired, reason: e.reason };
        }
      }
    }
    const boughtAt = typeof it.boughtAt === 'string' ? it.boughtAt : '';
    if (!boughtAt || !Number.isFinite(Date.parse(boughtAt))) return null;
    const e = sellBoughtExpiry({ soldAt: boughtAt, buyerEmail: email, buyerKeys: key ? [key] : [], songs: [] }, downloadedMap);
    return { expiresAt: e.expiresAt, downloadBy: e.downloadBy, expired: e.expired, reason: e.reason };
  }
  // Shared sale completion — used by BOTH the Wallet buy and the Admin
  // approve of a 'song-sale' receipt request, so the two paths can never
  // drift apart. Re-validates everything at call time (listing still
  // active, buyer is not the seller, buyer balance covers the price),
  // then: deducts the price from the buyer, credits 95% to the seller's
  // Earn Balance (MovAi keeps 5%), marks the listing sold, logs the
  // split, transfers the songs into the buyer's history (fresh ids, so
  // the buyer's copies have their own history keys), and notifies the
  // seller + buyer (Admin gets the Telegram copy via the kinds used).
  // Returns {ok:true, songs, price, sellerGot, movaiGot, balance} or
  // {ok:false, error, message:{km,en}} — and changes NOTHING on failure.
  async function completeSellSale(listing, buyerEmail) {
    const fail = (error, km, en) => ({ ok: false, error, message: { km, en } });
    const listings = await loadSellListings();
    const l = listings.find((x) => x && x.id === listing.id);
    if (!l) return fail('listing_not_found', 'រកកញ្ចប់បទនេះមិនឃើញទេ', 'Listing not found');
    if (l.status !== 'active') return fail('listing_not_active', 'កញ្ចប់បទនេះលក់រួចហើយ ឬលែងមានទេ', 'This listing is no longer available');
    const buyer = normEmail(buyerEmail);
    if (!buyer) return fail('invalid_email', 'សូមដាក់ Gmail ត្រឹមត្រូវ', 'Please enter a valid Gmail');
    if (buyer === l.sellerEmail) return fail('cannot_buy_own', 'អ្នកមិនអាចទិញបទរបស់ខ្លួនឯងបានទេ', 'You cannot buy your own songs');
    const users = await loadUsers();
    const bu = users[buyer];
    if (!bu) return fail('buyer_not_found', 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន', 'No account with this Gmail, please sign up first');
    const su = users[l.sellerEmail];
    if (!su) return fail('seller_not_found', 'រកអ្នកលក់នេះមិនឃើញទេ', 'Seller not found');
    const price = walletMoney(l.price);
    const bal = walletBalance(bu);
    if (price > bal) return fail('insufficient_balance', 'លុយក្នុង Wallet មិនគ្រប់ទេ (ត្រូវការ $' + price.toFixed(2) + ', នៅសល់ $' + bal.toFixed(2) + ')', 'Insufficient wallet balance (need $' + price.toFixed(2) + ', have $' + bal.toFixed(2) + ')');
    // Cents-safe 95/5 split: seller gets price*0.95 rounded, MovAi keeps
    // the remainder so the two parts always add up to the price exactly.
    const sellerGot = walletMoney(price * 0.95);
    const movaiGot = walletMoney(price - sellerGot);
    const now = new Date().toISOString();
    bu.balance = walletMoney(bal - price);
    su.earnBalance = walletMoney(walletEarnBalance(su) + sellerGot);
    bu.updatedAt = now;
    su.updatedAt = now;
    await saveUsers(users);
    await notifyWalletDeduct(buyer, price, 'Wallet', 'ទិញបទ · song purchase', bu.balance);
    l.status = 'sold';
    l.buyerEmail = buyer;
    l.soldAt = now;
    l.sellerGot = sellerGot;
    l.movai = movaiGot;
    await saveSellListings(listings);
    try {
      const sales = await loadSellSales();
      sales.push({ listingId: l.id, price, seller: l.sellerEmail, buyer, movai: movaiGot, sellerGot, at: now });
      await saveSellSales(sales);
    } catch (e) {}
    // Transfer: the buyer gets their OWN history copies (fresh ids, so
    // their history keys are new and independent of the seller's).
    const transferred = [];
    try {
      const h = await loadHistory();
      const mine = Array.isArray(h[buyer]) ? h[buyer] : [];
      const copies = (Array.isArray(l.songs) ? l.songs : []).map((s) => {
        const item = {
          id: sellNewId('bought_'), title: s.title || '', url: s.url || '', image: s.image || '',
          style: s.style || '', taskId: s.taskId || '', audioId: s.audioId || '',
          duration: numOr(s.duration, 0), ts: Date.now(), createdAt: now,
          origin: 'bought', boughtFrom: l.sellerEmail, boughtAt: now, sellListingId: l.id,
        };
        transferred.push({ key: histKey(item), title: item.title, url: item.url, image: item.image, style: item.style, taskId: item.taskId, audioId: item.audioId, duration: item.duration, createdAt: now });
        return item;
      });
      h[buyer] = copies.concat(mine).slice(0, 300);
      await saveHistory(h);
      // BOUGHT-SONG EXPIRY (v2.2.61): remember the buyer's new history
      // keys for this bundle, so the 6-month download deadline can be
      // checked against the 'sell-downloaded' map later.
      l.buyerKeys = transferred.map((t) => t.key);
      await saveSellListings(listings);
    } catch (e) {}
    scheduleBackup('users.json');
    const sellerName = sellDisplayName(users, l.sellerEmail);
    const buyerName = sellDisplayName(users, buyer);
    try {
      await addNotification('purchase-approved', l.sellerEmail, '✅ លក់បទបានហើយ · Song package sold', 'កញ្ចប់ ' + l.songs.length + ' បទ តម្លៃ $' + price.toFixed(2) + ' លក់បានហើយ — អ្នកទទួលបាន $' + sellerGot.toFixed(2) + ' ចូល Earn Balance · Sold to ' + buyerName + ' — you received $' + sellerGot.toFixed(2) + ' in Earn Balance', { extra: { sellSale: true, listingId: l.id, price, sellerGot, movai: movaiGot, buyerId: bu.id || '—', buyerName } });
    } catch (e) {}
    try {
      await addNotification('purchase-approved', buyer, '✅ ទិញបទបានហើយ · Song package bought', 'អ្នកបានទិញកញ្ចប់ ' + l.songs.length + ' បទ តម្លៃ $' + price.toFixed(2) + ' ពី ' + sellerName + ' — បទទាំងអស់បានចូល History របស់អ្នកហើយ · You bought ' + l.songs.length + ' songs for $' + price.toFixed(2) + ' from ' + sellerName + ' — they are now in your History', { extra: { sellSale: true, listingId: l.id, price, sellerGot, movai: movaiGot, buyerId: bu.id || '—', sellerName } });
    } catch (e) {}
    return { ok: true, songs: transferred, listingId: l.id, price, sellerGot, movaiGot, balance: walletBalance(bu) };
  }
  const PURCHASE_REQUESTS_FILE = path.join(DATA_DIR, 'purchase-requests.json');
  async function loadPurchaseRequests() {
    const j = await loadKvDoc('purchase-requests', []);
      return Array.isArray(j) ? j : [];
  }
  async function savePurchaseRequests(arr) {
    await saveKvDoc('purchase-requests', arr, 'purchase-requests.json');
  }
  function newPurchaseId() {
    return 'pr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  // POST /api/admin/purchase-request — PUBLIC (no admin key). The website
  // sends a buy request; credits are granted ONLY after the admin approves.
  if (req.method === 'POST' && urlPath === '/api/admin/purchase-request') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : 'package';
      let packageId = '', pkg = null, feature = '', postType = '', discLabel = '';
      if (kind === 'discount') {
        feature = typeof body.feature === 'string' ? body.feature.trim().toLowerCase() : '';
        if (DISCOUNT_FEATURES.indexOf(feature) < 0) return sendJSON(res, 200, { ok: false, error: 'សូមជ្រើសរើស Feature ត្រឹមត្រូវ' });
        postType = feature === 'post' ? postTypeOf('', body.postType) : '';
        packageId = 'discount:' + feature + (postType ? ':' + postType : '');
        discLabel = 'Discount 4× ' + (feature === 'post' ? 'Post' : feature === 'download' ? 'Download' : feature === 'mv' ? 'MV' : 'Vocal Studio') + (postType ? ' (' + postType + ')' : '');
      } else {
        packageId = typeof body.packageId === 'string' ? body.packageId.trim() : '';
        pkg = (await loadPackages())[packageId];
        if (!pkg) return sendJSON(res, 200, { ok: false, error: 'កញ្ចប់នេះមិនស្គាល់ទេ' });
      }
      const now = new Date().toISOString();
      const reqs = await loadPurchaseRequests();
      const r = {
        id: newPurchaseId(), email, packageId,
        kind: kind === 'discount' ? 'discount' : 'package',
        feature: kind === 'discount' ? feature : '',
        postType: kind === 'discount' ? postType : '',
        plan: kind === 'discount' ? discLabel : (typeof body.plan === 'string' ? body.plan.slice(0, 50) : packageId),
        amount: kind === 'discount' ? DISCOUNT_PACK[feature].price : pkg.price,
        credits: kind === 'discount' ? 0 : pkg.credits, songCredits: kind === 'discount' ? 0 : pkg.songCredits, days: kind === 'discount' ? 0 : pkg.days,
        receiptUrl: typeof body.receiptUrl === 'string' ? body.receiptUrl.trim().slice(0, 500) : '',
        status: 'pending', createdAt: now, updatedAt: now,
      };
      reqs.push(r);
      await savePurchaseRequests(reqs);
      const _pu = (await loadUsers())[email];
      const _puid = _pu && _pu.id ? _pu.id : '—';
      if (kind === 'discount') {
        await addNotification('purchase-request', email, '🛒 សំណើទិញ Discount · Discount purchase request', email + ' · ID: ' + _puid + ' សុំទិញ ' + discLabel + ' តម្លៃ $' + DISCOUNT_PACK[feature].price.toFixed(2) + ' (KHQR/USDT — បានបង់ហើយ មានវិក្កយបត្រភ្ជាប់មក)', { extra: { pkg: packageId, pkgName: discLabel, priceText: '$' + DISCOUNT_PACK[feature].price.toFixed(2), creditText: '4× ' + (feature === 'post' ? 'Post' : feature === 'download' ? 'Download' : feature === 'mv' ? 'MV' : 'Vocal Studio'), buyerId: _puid, discount: true, feature, postType } });
      } else {
        const _pd = pkgDisplay(pkg);
        await addNotification('purchase-request', email, '🛒 សំណើទិញកញ្ចប់ · Purchase request', pkgNotifText(pkg, email, _puid), { extra: { pkg: packageId, pkgName: _pd.pkgName, priceText: _pd.priceText, creditText: _pd.creditText, buyerId: _puid }, telegramHtml: pkgNotifTelegram('🛒 សំណើទិញកញ្ចប់ · Purchase request', pkg, email, _puid) });
      }
      return sendJSON(res, 200, { ok: true, request: r });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/purchase-requests?status=pending|approved|rejected|all
  // — admin key required. Pending first, then newest first.
  if (req.method === 'GET' && urlPath === '/api/admin/purchase-requests') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const status = (new URL(req.url, 'http://localhost').searchParams.get('status') || 'all').trim().toLowerCase();
    const reqs = await loadPurchaseRequests();
    const order = { pending: 0, approved: 1, rejected: 2 };
    const _users = await loadUsers();
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const reqs = await loadPurchaseRequests();
      const r = reqs.find((x) => x.id === id);
      if (!r) return sendJSON(res, 200, { ok: false, error: 'រកសំណើនេះមិនឃើញទេ' });
      if (r.status !== 'pending') return sendJSON(res, 200, { ok: false, error: 'សំណើនេះបានសម្រេចរួចហើយ' });
      const pkg = (r.kind === 'discount' || r.kind === 'song-sale' || r.type === 'song-sale') ? null : (await loadPackages())[r.packageId];
      if (!pkg && r.kind !== 'discount' && r.kind !== 'song-sale' && r.type !== 'song-sale') return sendJSON(res, 200, { ok: false, error: 'កញ្ចប់នេះមិនស្គាល់ទេ' });
      const users = await loadUsers();
      const u = users[r.email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
      const now = new Date().toISOString();
      if (r.kind === 'song-sale' || r.type === 'song-sale') {
        // Song-sale receipt request (v2.2.61): complete the SAME sale as
        // a Wallet buy (completeSellSale). On failure (listing gone, or
        // buyer balance short at approve time) the request stays
        // 'pending' so the Admin can retry or reject it — nothing is
        // transferred and nothing is marked approved.
        const _sl = (await loadSellListings()).find((x) => x && x.id === r.listingId);
        if (!_sl) return sendJSON(res, 200, { ok: false, error: 'listing_not_found', message: { km: 'រកកញ្ចប់បទនេះមិនឃើញទេ', en: 'Listing not found' } });
        const _done = await completeSellSale(_sl, r.email);
        if (!_done.ok) return sendJSON(res, 200, _done);
        r.status = 'approved';
        r.decidedAt = now;
        r.updatedAt = now;
        await savePurchaseRequests(reqs);
        scheduleBackup('purchase-requests.json');
        scheduleBackup('users.json');
        await markPurchaseRequestDecided(r.email, r.packageId, 'approved', now);
        return sendJSON(res, 200, { ok: true, request: r, songs: _done.songs, sellerGot: _done.sellerGot, movaiGot: _done.movaiGot, price: _done.price });
      }
      if (r.kind === 'discount') {
        // Discount pack (KHQR/USDT): grant 4 bonus uses of the feature.
        const df = typeof r.feature === 'string' ? r.feature.trim().toLowerCase() : '';
        if (DISCOUNT_FEATURES.indexOf(df) < 0) return sendJSON(res, 200, { ok: false, error: 'សំណើនេះមិនត្រឹមត្រូវទេ' });
        const dpt = df === 'post' ? postTypeOf('', r.postType) : '';
        grantDiscountBonus(u, df, dpt);
        u.updatedAt = now;
        await saveUsers(users);
        await logGrant({ email: r.email, credits: 0, songCredits: 0, note: 'discount-approve:' + df + (dpt ? ':' + dpt : '') + ':4:$' + walletMoney(r.amount || 0).toFixed(2), at: now });
        r.status = 'approved';
        r.decidedAt = now;
        r.updatedAt = now;
        await savePurchaseRequests(reqs);
        scheduleBackup('users.json');
        scheduleBackup('purchase-requests.json');
        const dfl = df === 'post' ? 'Post' : df === 'download' ? 'Download' : df === 'mv' ? 'MV' : 'Vocal Studio';
        await addNotification('purchase-approved', r.email, '✅ បានអនុម័ត · Discount approved', 'Discount 4× ' + dfl + (dpt ? ' (' + dpt + ')' : '') + ' ($' + walletMoney(r.amount || 0).toFixed(2) + ') បានអនុម័ត — ឥឡូវអ្នកមាន 4 ដងបន្ថែម · You now have 4 extra uses', { extra: { discount: true, feature: df, postType: dpt, buyerId: u.id || '—', decision: 'approved' } });
        await markPurchaseRequestDecided(r.email, r.packageId, 'approved', now);
        return sendJSON(res, 200, { ok: true, request: r, user: await pubUser(u), cashback: 0 });
      }
      // Capture BEFORE the plan activation below: if the previous
      // package had already expired, its leftover MV/VS allowance is
      // lost and the new grant must NOT stack on it (see
      // grantFeatureAllowance). If still active, the grant accumulates.
      const _hadActivePkg = hasActivePackage(u);
      u.credits = Math.max(0, Math.floor(numOr(u.credits, 0)) + pkg.credits);
      u.songCredits = Math.max(0, Math.floor(numOr(u.songCredits, 0)) + pkg.songCredits);
      if (pkg.credits) { u.plan = r.packageId; u.planExpiresAt = new Date(Date.now() + Math.max(1, pkg.days || 30) * 86400000).toISOString(); }
      if (pkg.songCredits) { u.songPlan = r.packageId; u.songPlanExpiresAt = new Date(Date.now() + Math.max(1, pkg.days || 30) * 86400000).toISOString(); }
      // "Free 2 + package allowance": song packages grant MV/VS
      // allowances (accumulate). Exactly once per purchase — this
      // handler only runs while the request is still 'pending' and
      // marks it 'approved' below, so a second approve of the same
      // request is refused above and can never grant twice.
      grantFeatureAllowance(u, r.packageId, _hadActivePkg);
      // Monetization cashback (owner order 2026-11-18): when monetization
      // is ON, an approved package purchase adds cashback to the EARN
      // balance immediately, by package price tier. Earn money is NOT
      // spendable — withdraw-only, it accumulates.
      let _cb = 0;
      if (await monetizationEnabled()) {
        _cb = monetizationCashbackForPrice(pkg.price);
        if (_cb > 0) {
          u.earnBalance = walletMoney(walletEarnBalance(u) + _cb);
          await monetizationRecordCashback(r.email, _cb);
        }
      }
      u.updatedAt = now;
      await saveUsers(users);
      await logGrant({ email: r.email, credits: pkg.credits, songCredits: pkg.songCredits, note: 'purchase:' + r.packageId, at: now });
      r.status = 'approved';
      r.decidedAt = now;
      r.updatedAt = now;
      await savePurchaseRequests(reqs);
      // Critical writes: confirm BOTH the granted credits and the
      // approved request are on GitHub BEFORE returning success, so a
      // restart cannot lose a purchase the Admin app already approved.
      scheduleBackup('users.json');
      scheduleBackup('purchase-requests.json');
      const _pd2 = pkgDisplay(pkg);
      await addNotification('purchase-approved', r.email, '✅ បានអនុម័ត · Purchase approved', pkgNotifText(pkg, r.email, u.id || '—'), { extra: { pkg: r.packageId, pkgName: _pd2.pkgName, priceText: _pd2.priceText, creditText: _pd2.creditText, buyerId: u.id || '—', decision: 'approved' }, telegramHtml: pkgNotifTelegram('✅ បានអនុម័ត · Purchase approved', pkg, r.email, u.id || '—') });
      if (_cb > 0) await addNotification('grant', r.email, '💰 Cashback · បានលុយត្រឡប់វិញ', 'ទិញកញ្ចប់ ' + r.packageId + ' ($' + walletMoney(pkg.price).toFixed(2) + ') បាន Cashback $' + _cb.toFixed(2) + ' ចូល Earn Balance (នៅសល់ $' + u.earnBalance.toFixed(2) + ')', { extra: { cashback: _cb, pkg: r.packageId, balance: u.balance, earnBalance: u.earnBalance, buyerId: u.id || '—' } });
      await markPurchaseRequestDecided(r.email, r.packageId, 'approved', now);
      return sendJSON(res, 200, { ok: true, request: r, user: await pubUser(u), cashback: _cb });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/purchase-request/reject — {id} — admin key required.
  // Marks the request rejected; no credits are granted.
  if (req.method === 'POST' && urlPath === '/api/admin/purchase-request/reject') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const reqs = await loadPurchaseRequests();
      const r = reqs.find((x) => x.id === id);
      if (!r) return sendJSON(res, 200, { ok: false, error: 'រកសំណើនេះមិនឃើញទេ' });
      if (r.status !== 'pending') return sendJSON(res, 200, { ok: false, error: 'សំណើនេះបានសម្រេចរួចហើយ' });
      const now = new Date().toISOString();
      if (r.kind === 'song-sale' || r.type === 'song-sale') {
        // Song sale rejected (v2.2.61): NOTHING is transferred —
        // completeSellSale never runs here — and the listing stays
        // active for another buyer.
        r.status = 'rejected';
        r.decidedAt = now;
        r.updatedAt = now;
        await savePurchaseRequests(reqs);
        const _ru2 = (await loadUsers())[r.email];
        const _ruid2 = _ru2 && _ru2.id ? _ru2.id : '—';
        const _rejPrice = walletMoney(r.amount || r.price || 0);
        await addNotification('purchase-rejected', r.email, '❌ បដិសេធ · Song purchase rejected', 'សំណើទិញកញ្ចប់បទ តម្លៃ $' + _rejPrice.toFixed(2) + ' ត្រូវបានបដិសេធ — លុយមិនត្រូវបានកាត់ទេ · Your song purchase request ($' + _rejPrice.toFixed(2) + ') was rejected — nothing was charged', { extra: { pkg: 'song-sale', listingId: r.listingId || '', priceText: '$' + _rejPrice.toFixed(2), buyerId: _ruid2, decision: 'rejected' } });
        await markPurchaseRequestDecided(r.email, r.packageId, 'rejected', now);
        return sendJSON(res, 200, { ok: true, request: r });
      }
      r.status = 'rejected';
      r.decidedAt = now;
      r.updatedAt = now;
      await savePurchaseRequests(reqs);
      const _ru = (await loadUsers())[r.email];
      const _ruid = _ru && _ru.id ? _ru.id : '—';
      const _pkgR = (await loadPackages())[r.packageId];
      const _pd3 = pkgDisplay(_pkgR);
      await addNotification('purchase-rejected', r.email, '❌ បដិសេធ · Purchase rejected', pkgNotifText(_pkgR, r.email, _ruid), { extra: { pkg: r.packageId, pkgName: _pd3.pkgName, priceText: _pd3.priceText, creditText: _pd3.creditText, buyerId: _ruid, decision: 'rejected' }, telegramHtml: pkgNotifTelegram('❌ បដិសេធ · Purchase rejected', _pkgR, r.email, _ruid) });
      await markPurchaseRequestDecided(r.email, r.packageId, 'rejected', now);
      return sendJSON(res, 200, { ok: true, request: r });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Wallet / Balance endpoints (owner order 2026-11-18) ----
  // GET /api/public/wallet/balance?email=... — PUBLIC. Returns the user's
  // stored Wallet balance in dollars.
  if (req.method === 'GET' && urlPath === '/api/public/wallet/balance') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const u = (await loadUsers())[email];
    if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ · No account with this Gmail' });
    return sendJSON(res, 200, { ok: true, email, balance: walletBalance(u), earnBalance: walletEarnBalance(u) });
  }
  // POST /api/public/wallet/topup-request — {email, amount, method, receipt?}
  // — PUBLIC. Asks to top up the Wallet. amount >= $5.00. method is
  // 'khmer' (KHQR / local bank) or 'foreign' (international). The money
  // only lands in the balance when the Admin approves the request.
  if (req.method === 'POST' && urlPath === '/api/public/wallet/topup-request') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន · No account with this Gmail, please sign up first' });
      const amount = walletMoney(body && body.amount);
      if (!Number.isFinite(amount) || amount < WALLET_MIN_TOPUP) return sendJSON(res, 200, { ok: false, error: 'ចំនួនបញ្ចូលយ៉ាងហោចណាស់ $' + WALLET_MIN_TOPUP.toFixed(2) + ' · Minimum top-up is $' + WALLET_MIN_TOPUP.toFixed(2) });
      const method = (body && typeof body.method === 'string' && body.method.trim().toLowerCase() === 'foreign') ? 'foreign' : 'khmer';
      const now = new Date().toISOString();
      const reqs = await loadWalletRequests();
      const r = {
        id: newWalletRequestId(), type: 'topup', email, amount, method,
        receiptUrl: typeof body.receiptUrl === 'string' ? body.receiptUrl.trim().slice(0, 500) : '',
        status: 'pending', createdAt: now, updatedAt: now,
      };
      reqs.push(r);
      await saveWalletRequests(reqs);
      scheduleBackup('wallet-requests.json');
      await addNotification('purchase-request', email, '💰 សំណើបញ្ចូលលុយ · Wallet top-up request', (u.name || email) + ' (' + email + ') · ID: ' + (u.id || '—') + ' ស្នើបញ្ចូល $' + amount.toFixed(2) + ' (' + (method === 'foreign' ? 'បរទេស · Foreign' : 'ខ្មែរ · Khmer') + ')', { extra: { walletRequestId: r.id, type: 'topup', amount, method, buyerId: u.id || '—' } });
      return sendJSON(res, 200, { ok: true, request: walletRequestPublic(r, users) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/wallet/withdraw-request — {email, userId?, amount, khqrImageUrl?}
  // — PUBLIC. Asks to withdraw from the Wallet. amount >= $5.00 and
  // <= balance. Fee tier: under $50 flat $0.50 (e.g. withdraw $5, net
  // $4.50); $50+ is 5% of the amount ($100 -> $5.00 fee, net $95.00).
  // Nothing is deducted yet — the Admin deducts (amount + fee) when approving.
  if (req.method === 'POST' && urlPath === '/api/public/wallet/withdraw-request') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន · No account with this Gmail, please sign up first' });
      const amount = walletMoney(body && body.amount);
      if (!Number.isFinite(amount) || amount < WALLET_MIN_WITHDRAW) return sendJSON(res, 200, { ok: false, error: 'ចំនួនដកយ៉ាងហោចណាស់ $' + WALLET_MIN_WITHDRAW.toFixed(2) + ' · Minimum withdrawal is $' + WALLET_MIN_WITHDRAW.toFixed(2) });
      // Withdraw source (owner order 2026-11-18): 'wallet' (top-up money,
      // default) or 'earnings' (Earn Balance — cashback + view earnings).
      // Funds are checked against the SELECTED balance only.
      const source = (body && body.source === 'earnings') ? 'earnings' : 'wallet';
      const bal = source === 'earnings' ? walletEarnBalance(u) : walletBalance(u);
      const balName = source === 'earnings' ? 'Earn Balance' : 'Wallet';
      if (amount > bal) return sendJSON(res, 200, { ok: false, error: 'លុយក្នុង ' + balName + ' មិនគ្រប់ទេ (នៅសល់ $' + bal.toFixed(2) + ') · Insufficient ' + balName + ' balance ($' + bal.toFixed(2) + ' left)', balance: bal, earnBalance: walletEarnBalance(u) });
      const now = new Date().toISOString();
      const reqs = await loadWalletRequests();
      // userId (owner order 2026-11-18): stored on the request so the
      // Admin sees WHO asked, even if the Gmail is ever renamed. The
      // website sends its account userId; when it is missing, fall back
      // to the account's own id. net = what the user actually receives
      // (amount − fee; e.g. withdraw $5 → net $4.50). total = what is
      // deducted from the balance on approval (amount + fee).
      const userId = (typeof body.userId === 'string' && body.userId.trim()) ? body.userId.trim().slice(0, 50) : (u.id || '');
      const fee = walletWithdrawFee(amount);
      const r = {
        id: newWalletRequestId(), type: 'withdraw', email, userId, amount, fee, total: walletMoney(amount + fee), net: walletMoney(amount - fee), source,
        khqrImageUrl: typeof body.khqrImageUrl === 'string' ? body.khqrImageUrl.trim().slice(0, 500) : '',
        status: 'pending', createdAt: now, updatedAt: now,
      };
      reqs.push(r);
      await saveWalletRequests(reqs);
      scheduleBackup('wallet-requests.json');
      // Bell + Telegram (addNotification kind 'purchase-request' sends
      // both, same path as top-up/purchase requests): amount, Gmail,
      // User ID, fee, net amount. Nothing is deducted yet — the Admin
      // deducts (amount + fee) only when approving.
      await addNotification('purchase-request', email, '💸 សំណើដកលុយ · Wallet withdraw request', (u.name || email) + ' (' + email + ') · User ID: ' + (r.userId || '—') + ' ស្នើដក $' + amount.toFixed(2) + ' ពី ' + balName + ' (ថ្លៃសេវា $' + fee.toFixed(2) + ' — ទទួលបាន $' + r.net.toFixed(2) + ' — សរុបកាត់ $' + r.total.toFixed(2) + ')', { extra: { walletRequestId: r.id, type: 'withdraw', amount, fee, total: r.total, net: r.net, source, buyerId: r.userId || '—', userId: r.userId || '' } });
      return sendJSON(res, 200, { ok: true, request: walletRequestPublic(r, users), fee, net: r.net });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹমត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/wallet/buy-package — {email, packageId} — PUBLIC.
  // Buys a package with the Wallet balance: deducts the package price
  // (only if sufficient) and activates the package exactly as an
  // approved purchase-request does (same credits + plan expiry).
  if (req.method === 'POST' && urlPath === '/api/public/wallet/buy-package') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const packageId = typeof body.packageId === 'string' ? body.packageId.trim() : '';
      const pkg = (await loadPackages())[packageId];
      if (!pkg) return sendJSON(res, 200, { ok: false, error: 'កញ្ចប់នេះមិនស្គាល់ទេ' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន · No account with this Gmail, please sign up first' });
      const price = walletMoney(pkg.price);
      const bal = walletBalance(u);
      if (price > bal) return sendJSON(res, 200, { ok: false, error: 'លុយក្នុង Wallet មិនគ្រប់ទេ (ត្រូវការ $' + price.toFixed(2) + ', នៅសល់ $' + bal.toFixed(2) + ') · Insufficient wallet balance (need $' + price.toFixed(2) + ', have $' + bal.toFixed(2) + ')', balance: bal, price });
      const now = new Date().toISOString();
      // Capture BEFORE the plan activation below (same rule as the
      // purchase-request approve handler): expired leftovers are lost,
      // an active package's grant accumulates.
      const _hadActivePkg = hasActivePackage(u);
      u.balance = walletMoney(bal - price);
      u.credits = Math.max(0, Math.floor(numOr(u.credits, 0)) + pkg.credits);
      u.songCredits = Math.max(0, Math.floor(numOr(u.songCredits, 0)) + pkg.songCredits);
      await notifyWalletDeduct(email, price, 'Wallet', 'ទិញ Package · package ' + packageId, u.balance);
      if (pkg.credits) { u.plan = packageId; u.planExpiresAt = new Date(Date.now() + Math.max(1, pkg.days || 30) * 86400000).toISOString(); }
      if (pkg.songCredits) { u.songPlan = packageId; u.songPlanExpiresAt = new Date(Date.now() + Math.max(1, pkg.days || 30) * 86400000).toISOString(); }
      // "Free 2 + package allowance": song packages grant MV/VS
      // allowances (accumulate). Exactly once per purchase — a wallet
      // buy is a single payment action; each call buys (and grants)
      // exactly one package.
      grantFeatureAllowance(u, packageId, _hadActivePkg);
      // Monetization cashback (owner order 2026-11-18): when monetization
      // is ON, buying a package with the Wallet adds cashback to the
      // EARN balance immediately, by package price tier. Earn money is
      // NOT spendable — withdraw-only, it accumulates.
      let _cb = 0;
      if (await monetizationEnabled()) {
        _cb = monetizationCashbackForPrice(price);
        if (_cb > 0) {
          u.earnBalance = walletMoney(walletEarnBalance(u) + _cb);
          await monetizationRecordCashback(email, _cb);
        }
      }
      u.updatedAt = now;
      await saveUsers(users);
      await logGrant({ email, credits: pkg.credits, songCredits: pkg.songCredits, note: 'wallet-buy:' + packageId, at: now });
      scheduleBackup('users.json');
      const _pdw = pkgDisplay(pkg);
      await addNotification('purchase-approved', email, '✅ បានទិញកញ្ចប់ដោយ Wallet · Package bought with Wallet', pkgNotifText(pkg, email, u.id || '—') + ' — បង់ដោយ Wallet $' + price.toFixed(2) + ' (នៅសល់ $' + u.balance.toFixed(2) + ')', { extra: { pkg: packageId, pkgName: _pdw.pkgName, priceText: _pdw.priceText, creditText: _pdw.creditText, buyerId: u.id || '—', decision: 'approved', paidBy: 'wallet', price }, telegramHtml: pkgNotifTelegram('✅ បានទិញកញ្ចប់ដោយ Wallet · Package bought with Wallet', pkg, email, u.id || '—') });
      if (_cb > 0) await addNotification('grant', email, '💰 Cashback · បានលុយត្រឡប់វិញ', 'ទិញកញ្ចប់ ' + packageId + ' ($' + price.toFixed(2) + ') បាន Cashback $' + _cb.toFixed(2) + ' ចូល Earn Balance (នៅសល់ $' + u.earnBalance.toFixed(2) + ')', { extra: { cashback: _cb, pkg: packageId, balance: u.balance, earnBalance: u.earnBalance, buyerId: u.id || '—' } });
      return sendJSON(res, 200, { ok: true, user: await pubUser(u), package: packageId, price, balance: u.balance, cashback: _cb });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/device/buy-slot — {email, count} — PUBLIC (logged-in
  // user). Buys extra account slots for THIS device: $1.00 per slot, paid
  // from the user's Wallet balance. The slots raise the device's
  // registration limit (3 free + purchased slots), so the device can
  // register more Gmails. Buying slots resets the device's strikes to 0
  // (they paid, so they are compliant again). A BLOCKED device cannot buy
  // slots — the Admin must unblock it first (no money taken).
  if (req.method === 'POST' && urlPath === '/api/public/device/buy-slot') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const count = Math.floor(numOr(body && body.count, 0));
      if (count < 1 || count > 100) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ចំនួន Slot 1–100 · Please enter 1–100 slots' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន · No account with this Gmail, please sign up first' });
      const _bsBodyModel = typeof body.model === 'string' ? body.model.trim().slice(0, 64) : '';
      const _bsModel = (_bsBodyModel && _bsBodyModel !== 'K') ? _bsBodyModel : modelFromUA(req.headers && req.headers['user-agent']);
      const _fp = deviceFingerprintFor(req, body, _bsModel);
      const got = await getDeviceRecord(_fp, true);
      const rec = got.rec;
      if (!rec) return sendJSON(res, 200, { ok: false, error: 'មិនអាចកំណត់អត្តសញ្ញាណឧបករណ៍បានទេ · Cannot identify this device' });
      if (rec.blocked) return sendJSON(res, 200, { ok: false, error: 'ឧបករណ៍នេះត្រូវបានប្លុក — សូមទាក់ទង Admin ដើម្បីដោះប្លុកជាមុនសិន · This device is blocked — please contact the Admin to unblock first', deviceBlocked: true, blockedReason: rec.blockedReason || 'device-blocked' });
      const price = walletMoney(count * DEVICE_SLOT_PRICE);
      const bal = walletBalance(u);
      if (price > bal) return sendJSON(res, 200, { ok: false, error: 'លុយក្នុង Wallet មិនគ្រប់ទេ (ត្រូវការ $' + price.toFixed(2) + ' សម្រាប់ ' + count + ' Slot, នៅសល់ $' + bal.toFixed(2) + ') · Insufficient wallet balance (need $' + price.toFixed(2) + ' for ' + count + ' slots, have $' + bal.toFixed(2) + ')', balance: bal, price });
      const now = new Date().toISOString();
      u.balance = walletMoney(bal - price);
      if (_fp.deviceId) u.lastDeviceId = _fp.deviceId;
      u.updatedAt = now;
      await saveUsers(users);
      await notifyWalletDeduct(email, price, 'Wallet', 'ទិញ Device Slot · device slots', u.balance);
      rec.slots = Math.floor(numOr(rec.slots, 0)) + count;
      rec.strikes = 0; // paid → compliant again
      rec.lastSeen = now;
      if (_fp.ip) rec.lastIp = _fp.ip;
      if (_fp.model) rec.model = _fp.model;
      if (_fp.device) rec.device = _fp.device;
      if (email && (!Array.isArray(rec.emails) || !rec.emails.includes(email))) {
        if (!Array.isArray(rec.emails)) rec.emails = [];
        rec.emails.unshift(email);
        if (rec.emails.length > 10) rec.emails.length = 10;
      }
      await saveDeviceRecords(got.all);
      scheduleBackup('users.json');
      scheduleBackup('device-records.json');
      const deviceLimit = (await deviceLimitSetting()).limit + rec.slots;
      await logActivity({ at: now, mode: 'device-buy-slot', email, count, price, slots: rec.slots, deviceLimit, deviceId: _fp.deviceId || '', model: _fp.model || '', ip: _fp.ip || '' });
      await addNotification('deduct', email, '➕ បានទិញ Slot អាខោន · Extra account slots bought', (u.name || email) + ' (' + email + ') បានទិញ ' + count + ' Slot ($' + price.toFixed(2) + ') សម្រាប់ឧបករណ៍ ' + (_fp.model || _fp.deviceId || 'Unknown') + ' — ឥឡូវចុះឈ្មោះបាន ' + deviceLimit + ' គណនី (នៅសល់ $' + u.balance.toFixed(2) + ')');
      return sendJSON(res, 200, { ok: true, slots: rec.slots, balance: u.balance, deviceLimit, price, count });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/forget-password-instant — {email} — PUBLIC. Forget
  // Password Option 2 (paid instant reset, $0.10): deducts $0.10 from the
  // user's Wallet balance, then returns a short-lived (10 min, single-use)
  // reset token. The website uses the token to show the password-setup
  // panel and set a new MovAi password via /api/auth/instant-reset.
  if (req.method === 'POST' && urlPath === '/api/auth/forget-password-instant') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន · No account with this Gmail, please sign up first' });
      const bal = walletBalance(u);
      if (bal < WALLET_INSTANT_RESET_PRICE) return sendJSON(res, 200, { ok: false, error: 'លុយក្នុង Wallet មិនគ្រប់ទេ (ត្រូវការ $' + WALLET_INSTANT_RESET_PRICE.toFixed(2) + ' សម្រាប់ Reset ភ្លាមៗ, នៅសល់ $' + bal.toFixed(2) + ') · Insufficient wallet balance (need $' + WALLET_INSTANT_RESET_PRICE.toFixed(2) + ' for instant reset, have $' + bal.toFixed(2) + ')', balance: bal, price: WALLET_INSTANT_RESET_PRICE });
      const now = new Date().toISOString();
      u.balance = walletMoney(bal - WALLET_INSTANT_RESET_PRICE);
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      await logActivity({ at: now, mode: 'wallet-instant-reset', email });
      await addNotification('deduct', email, '➖ កាត់ $' + WALLET_INSTANT_RESET_PRICE.toFixed(2) + ' · Instant reset fee', (u.name || email) + ' (' + email + ') បានកាត់ $' + WALLET_INSTANT_RESET_PRICE.toFixed(2) + ' ពី Wallet សម្រាប់ Forget Password ភ្លាមៗ (នៅសល់ $' + u.balance.toFixed(2) + ')');
      const token = crypto.randomBytes(16).toString('hex');
      instantResetTokens.set(email, { token, expiresAt: Date.now() + INSTANT_RESET_TTL_MS });
      return sendJSON(res, 200, { ok: true, token, expiresIn: Math.floor(INSTANT_RESET_TTL_MS / 1000), balance: u.balance });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/auth/instant-reset — {email, token, password, passwordConfirm}
  // — PUBLIC. Step 2 of the paid instant reset: the token (from
  // forget-password-instant, 10 min, single-use) proves the Gmail belongs
  // to the caller, then the new password is set — same logic as the
  // code-based /api/auth/reset-password (hash, revoke remember tokens,
  // clear sign-in lock, security notification, log in at once).
  if (req.method === 'POST' && urlPath === '/api/auth/instant-reset') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const token = body && typeof body.token === 'string' ? body.token : '';
      const password = body && typeof body.password === 'string' ? body.password : '';
      const passwordConfirm = body && typeof body.passwordConfirm === 'string' ? body.passwordConfirm : '';
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      if (password.length < 6 || password.length > 64) return sendJSON(res, 200, { ok: false, error: 'Password ត្រូវមាន 6–64 តួអក្សរ · Password must be 6–64 characters' });
      if (password !== passwordConfirm) return sendJSON(res, 200, { ok: false, error: 'Password ទាំងពីរមិនដូចគ្នាទេ · Passwords do not match' });
      const rec = instantResetTokens.get(email);
      if (!rec || rec.token !== token) return sendJSON(res, 200, { ok: false, error: 'Token មិនត្រឹមត្រូវទេ — សូមស្នើសុំ Reset ភ្លាមៗម្តងទៀត · Invalid reset token — please request the instant reset again' });
      if (Date.now() > rec.expiresAt) { instantResetTokens.delete(email); return sendJSON(res, 200, { ok: false, error: 'Token ផុតកំណត់ហើយ — សូមស្នើសុំ Reset ភ្លាមៗម្តងទៀត · Token expired — please request the instant reset again' }); }
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រក Gmail នេះមិនឃើញទេ · No account with this Gmail' });
      const hp = await hashPassword(password);
      u.passwordSalt = hp.salt;
      u.passwordHash = hp.hash;
      revokeAllRememberTokens(u);
      signinClear(email);
      const now = new Date().toISOString();
      await logActivity({ at: now, mode: 'reset-password', email });
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      instantResetTokens.delete(email);
      await addNotification('security', email, '🔑 Password ត្រូវបានប្តូរ · Password changed', (u.name || email) + ' (' + email + ') បានប្តូរ Password តាមរយៈ Forget Password ភ្លាមៗ ($0.10)');
      return sendJSON(res, 200, { ok: true, user: await pubUser(u) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/wallet/requests — admin key required. Top-up + withdraw
  // requests, pending first, then newest first. ?status=pending|approved|
  // rejected|all (default all) and ?type=topup|withdraw|all (default all).
  if (req.method === 'GET' && urlPath === '/api/admin/wallet/requests') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const q = new URL(req.url, 'http://localhost').searchParams;
    const status = (q.get('status') || 'all').trim().toLowerCase();
    const type = (q.get('type') || 'all').trim().toLowerCase();
    const reqs = await loadWalletRequests();
    const users = await loadUsers();
    const order = { pending: 0, approved: 1, rejected: 2 };
    const list = reqs
      .filter((r) => (status === 'all' || r.status === status) && (type === 'all' || r.type === type))
      .sort((x, y) => ((order[x.status] ?? 3) - (order[y.status] ?? 3)) || String(y.createdAt || '').localeCompare(String(x.createdAt || '')))
      .map((r) => walletRequestPublic(r, users));
    return sendJSON(res, 200, { ok: true, requests: list });
  }
  // GET /api/admin/wallet/balance?email=... — admin key required. Reads one
  // user's Wallet balance for the Admin display.
  if (req.method === 'GET' && urlPath === '/api/admin/wallet/balance') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const u = (await loadUsers())[email];
    if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
    return sendJSON(res, 200, { ok: true, email, balance: walletBalance(u), earnBalance: walletEarnBalance(u) });
  }
  // POST /api/admin/wallet/approve — {requestId} — admin key required.
  // Top-up: adds the amount to the user's balance. Withdraw: deducts
  // (amount + fee) from the balance (only if sufficient). Marks the
  // request approved and notifies the user.
  if (req.method === 'POST' && urlPath === '/api/admin/wallet/approve') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : (typeof body.id === 'string' ? body.id.trim() : '');
      const reqs = await loadWalletRequests();
      const r = reqs.find((x) => x.id === requestId);
      if (!r) return sendJSON(res, 200, { ok: false, error: 'រកសំណើនេះមិនឃើញទេ' });
      if (r.status !== 'pending') return sendJSON(res, 200, { ok: false, error: 'សំណើនេះបានសម្រេចរួចហើយ' });
      const users = await loadUsers();
      const u = users[r.email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'រកអ្នកប្រើនេះមិនឃើញទេ' });
      const now = new Date().toISOString();
      if (r.type === 'topup') {
        u.balance = walletMoney(walletBalance(u) + walletMoney(r.amount));
        u.updatedAt = now;
        await saveUsers(users);
        scheduleBackup('users.json');
        await addNotification('grant', r.email, '✅ បញ្ចូលលុយបានអនុម័ត · Top-up approved', '$' + walletMoney(r.amount).toFixed(2) + ' បានបញ្ចូលទៅ Wallet របស់ ' + r.email + ' (នៅសល់ $' + u.balance.toFixed(2) + ')', { extra: { walletRequestId: r.id, type: 'topup', amount: walletMoney(r.amount), balance: u.balance, buyerId: u.id || '—' } });
      } else if (r.type === 'withdraw') {
        // Fee tier: use the fee stored on the request (set at request
        // time); older requests without a stored fee recompute it.
        const fee = (Number.isFinite(r.fee) && r.fee >= 0) ? walletMoney(r.fee) : walletWithdrawFee(r.amount);
        const total = (Number.isFinite(r.total) && r.total > 0) ? walletMoney(r.total) : walletMoney(walletMoney(r.amount) + fee);
        // Withdraw source (owner order 2026-11-18): deduct from the
        // balance the request was made against ('earnings' = Earn
        // Balance, anything else = spendable Wallet). Old requests
        // without a stored source default to 'wallet'.
        const source = (r.source === 'earnings') ? 'earnings' : 'wallet';
        const bal = source === 'earnings' ? walletEarnBalance(u) : walletBalance(u);
        const balName = source === 'earnings' ? 'Earn Balance' : 'Wallet';
        if (total > bal) return sendJSON(res, 200, { ok: false, error: 'លុយក្នុង ' + balName + ' មិនគ្រប់ទេ (ត្រូវការ $' + total.toFixed(2) + ', នៅសល់ $' + bal.toFixed(2) + ') · Insufficient ' + balName + ' balance', balance: bal, earnBalance: walletEarnBalance(u) });
        if (source === 'earnings') { u.earnBalance = walletMoney(bal - total); } else { u.balance = walletMoney(bal - total); }
        u.updatedAt = now;
        await saveUsers(users);
        scheduleBackup('users.json');
        await addNotification('deduct', r.email, '✅ ដកលុយបានអនុម័ត · Withdraw approved', '$' + walletMoney(r.amount).toFixed(2) + ' (+ថ្លៃសេវា $' + fee.toFixed(2) + ' = $' + total.toFixed(2) + ') បានកាត់ពី ' + balName + ' របស់ ' + r.email + ' (នៅសល់ $' + bal.toFixed(2) + ') — Admin នឹងផ្ញើលុយតាម KHQR របស់អ្នក', { extra: { walletRequestId: r.id, type: 'withdraw', amount: walletMoney(r.amount), fee, total, balance: u.balance, earnBalance: u.earnBalance, source, buyerId: u.id || '—' } });
      } else {
        return sendJSON(res, 200, { ok: false, error: 'ប្រភេទសំណើនេះមិនស្គាល់ទេ' });
      }
      r.status = 'approved';
      r.decidedAt = now;
      r.updatedAt = now;
      await saveWalletRequests(reqs);
      scheduleBackup('wallet-requests.json');
      return sendJSON(res, 200, { ok: true, request: walletRequestPublic(r, users), user: await pubUser(u), balance: u.balance, earnBalance: u.earnBalance });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/wallet/reject — {requestId, reason?} — admin key
  // required. Marks the request rejected; no money moves.
  if (req.method === 'POST' && urlPath === '/api/admin/wallet/reject') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : (typeof body.id === 'string' ? body.id.trim() : '');
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
      const reqs = await loadWalletRequests();
      const r = reqs.find((x) => x.id === requestId);
      if (!r) return sendJSON(res, 200, { ok: false, error: 'រកសំណើនេះមិនឃើញទេ' });
      if (r.status !== 'pending') return sendJSON(res, 200, { ok: false, error: 'សំណើនេះបានសម្រេចរួចហើយ' });
      const now = new Date().toISOString();
      r.status = 'rejected';
      r.decidedAt = now;
      r.updatedAt = now;
      if (reason) r.reason = reason;
      await saveWalletRequests(reqs);
      scheduleBackup('wallet-requests.json');
      const _wu = (await loadUsers())[r.email];
      await addNotification('purchase-rejected', r.email, '❌ សំណើ Wallet ត្រូវបានបដិសេធ · Wallet request rejected', (r.type === 'withdraw' ? 'សំណើដកលុយ $' + walletMoney(r.amount).toFixed(2) : 'សំណើបញ្ចូលលុយ $' + walletMoney(r.amount).toFixed(2)) + ' របស់ ' + r.email + ' ត្រូវបានបដិសេធ' + (reason ? ' — ' + reason : ''), { extra: { walletRequestId: r.id, type: r.type, amount: walletMoney(r.amount), buyerId: _wu && _wu.id ? _wu.id : '', decision: 'rejected' } });
      return sendJSON(res, 200, { ok: true, request: walletRequestPublic(r, await loadUsers()) });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/stats — admin key required. Usage analytics for the
  // Admin app: distinct users (by sync) in the last 1/7/30 days, today's
  // successful generations by mode, today's failures, and recent errors.
  // Never throws on empty data.
  if (req.method === 'GET' && urlPath === '/api/admin/stats') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    try {
      const nowMs = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const act = await loadActivity();
      const users = await loadUsers();
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
      // Public totals come from Supabase via loadPublicPosts() (a hoisted
      // function declaration, so it is safe to call here even though it
      // is declared later in apiRoute; the old direct file read existed
      // only because PUBLIC_FILE is a later-declared const).
      let pubPosts = [];
      try {
        pubPosts = (await loadPublicPosts()).filter((p) => p && p.visibility === 'public');
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const list = (await loadNotifications()).slice(0, 100);
    return sendJSON(res, 200, { ok: true, notifications: list });
  }
  // GET /api/admin/security — admin key required. Security-kind
  // notifications only (new-device logins + blocked-model login
  // attempts), newest first, limit 100. Read/mark-read reuse the
  // existing notifications flow (POST /api/admin/notifications/read).
  if (req.method === 'GET' && urlPath === '/api/admin/security') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const events = (await loadNotifications()).filter((n) => n && n.kind === 'security').slice(0, 100);
    return sendJSON(res, 200, { ok: true, events });
  }
  // POST /api/admin/notifications/read — {id} or {all:true} — admin key
  // required. Marks one notification (or all) as read.
  if (req.method === 'POST' && urlPath === '/api/admin/notifications/read') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const arr = await loadNotifications();
      let marked = 0;
      if (body && body.all === true) {
        for (const n of arr) { if (n && !n.read) { n.read = true; marked++; } }
      } else {
        const id = body && typeof body.id === 'string' ? body.id.trim() : '';
        const n = arr.find((x) => x && x.id === id);
        if (n && !n.read) { n.read = true; marked = 1; }
      }
      if (marked) await saveNotifications(arr);
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
    const list = (await loadNotifications()).filter((n) => n && (n.email === email || n.email === '*')).slice(0, 50);
    return sendJSON(res, 200, { ok: true, notifications: list });
  }
  // ---- Follow the Public page ----
  // POST /api/public/follow — PUBLIC. Two shapes:
  //   (a) {email, follow: true|false} — legacy: follow/unfollow the
  //       Public page (flat followers list). Unchanged behaviour.
  //   (b) {email, targetEmail} — monetization: follow a creator
  //       (per-creator follows). Returns {ok, count, following}.
  if (req.method === 'POST' && urlPath === '/api/public/follow') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const target = normEmail(body && body.targetEmail);
      if (target) {
        if (target === email) return sendJSON(res, 200, { ok: false, error: 'មិនអាច Follow ខ្លួនឯងបានទេ · You cannot follow yourself' });
        const f = await loadCreatorFollows();
        if (!Array.isArray(f[target])) f[target] = [];
        if (!f[target].includes(email)) f[target].push(email);
        if (f[target].length > 10000) f[target] = f[target].slice(-10000);
        await saveCreatorFollows(f);
        const _c = await creatorFollowerCount(target);
        return sendJSON(res, 200, { ok: true, count: _c, following: true, followers: _c });
      }
      const want = !!(body && body.follow);
      let arr = await loadFollowers();
      if (want) {
        if (!arr.includes(email)) arr.push(email);
      } else {
        arr = arr.filter((e) => e !== email);
      }
      if (arr.length > FOLLOWERS_MAX) arr = arr.slice(-FOLLOWERS_MAX);
      await saveFollowers(arr);
      return sendJSON(res, 200, { ok: true, following: want, followers: arr.length });
    }).catch((e) => sendJSON(res, 200, { ok: false, error: String(e && e.message ? e.message : e) }));
    return;
  }
  // POST /api/public/unfollow — PUBLIC. {email, targetEmail}.
  // Monetization: unfollow a creator. Returns {ok, count, following:false}.
  if (req.method === 'POST' && urlPath === '/api/public/unfollow') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      const target = normEmail(body && body.targetEmail);
      if (!email || !target) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail និង targetEmail ត្រឹមត្រូវ' });
      const f = await loadCreatorFollows();
      if (Array.isArray(f[target])) {
        f[target] = f[target].filter((e) => e !== email);
        await saveCreatorFollows(f);
      }
      const count = await creatorFollowerCount(target);
      return sendJSON(res, 200, { ok: true, count, following: false, followers: count });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/public/followers?email=X&by=Y — PUBLIC. Monetization:
  // how many followers creator X has, and whether viewer Y follows X.
  // Returns {ok, count, following}.
  if (req.method === 'GET' && urlPath === '/api/public/followers') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const target = normEmail(q.get('email') || '');
    const by = normEmail(q.get('by') || '');
    if (!target) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail' });
    const f = await loadCreatorFollows();
    const arr = Array.isArray(f[target]) ? f[target] : [];
    const total = await creatorFollowerCount(target);
    return sendJSON(res, 200, { ok: true, count: total, following: !!(by && arr.includes(by)), followers: total });
  }
  // GET /api/public/follow?email= — PUBLIC. Returns {ok, following, followers}.
  if (req.method === 'GET' && urlPath === '/api/public/follow') {
    const rawEmail = (new URL(req.url, 'http://localhost').searchParams.get('email') || '').trim().toLowerCase();
    const email = normEmail(rawEmail);
    const arr = await loadFollowers();
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
    return sendJSON(res, 200, { ok: true, configured: await verifyEmailConfigured() });
  }
  // ---- Web Push (phone-native push, from the phone itself) ----
  // GET /api/public/vapid-key — PUBLIC. Returns the public VAPID key the
  // website/Admin app needs to subscribe for Web Push. The private key is
  // never exposed. The key pair is created on first use (./data/vapid.json).
  if (req.method === 'GET' && urlPath === '/api/public/vapid-key') {
    const pub = await getVapidPublicKey();
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
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const sub = cleanPushSub(body && body.subscription);
      if (!sub) return sendJSON(res, 200, { ok: false, error: 'subscription មិនត្រឹមត្រូវទេ' });
      const role = body && body.role === 'admin' ? 'admin' : '';
      const arr = await loadPushSubs();
      const now = new Date().toISOString();
      const idx = arr.findIndex((s) => s && s.endpoint === sub.endpoint && String(s.email || '').toLowerCase() === email);
      const rec = { email, endpoint: sub.endpoint, keys: sub.keys, role, createdAt: idx >= 0 && arr[idx].createdAt ? arr[idx].createdAt : now, updatedAt: now };
      if (idx >= 0) arr[idx] = rec; else arr.push(rec);
      if (arr.length > PUSH_SUBS_MAX) arr.splice(0, arr.length - PUSH_SUBS_MAX);
      await savePushSubs(arr);
      return sendJSON(res, 200, { ok: true, subscribed: true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/push-unsubscribe — PUBLIC. {email, endpoint} — removes
  // the matching subscription(s). email is optional (endpoint alone matches).
  if (req.method === 'POST' && urlPath === '/api/public/push-unsubscribe') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
      if (!endpoint) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ endpoint' });
      const email = normEmail(body && body.email);
      const arr = await loadPushSubs();
      const kept = arr.filter((s) => !(s && s.endpoint === endpoint && (!email || String(s.email || '').toLowerCase() === email)));
      const removed = arr.length - kept.length;
      if (removed) await savePushSubs(kept);
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
  async function loadPublicPosts() {
    const rows = await sbSelect('public_posts', 'select=id,data');
      if (!rows) return [];
      const arr = rows.map((r) => r.data).filter(Boolean);
      arr.sort((a, b) => String(b.createdAt || b.at || '').localeCompare(String(a.createdAt || a.at || '')));
      return arr;
  }
  // Like loadPublicPosts, but reports whether the Supabase read itself
  // succeeded — the feed handler must tell a genuinely empty feed apart
  // from a failed DB read (the website now drops posts the server stops
  // returning, so a failed read must never look like an empty feed).
  async function loadPublicPostsStatus() {
    const rows = await sbSelect('public_posts', 'select=id,data');
    if (!rows) return { ok: false, posts: [] };
    const arr = rows.map((r) => r.data).filter(Boolean);
    arr.sort((a, b) => String(b.createdAt || b.at || '').localeCompare(String(a.createdAt || a.at || '')));
    return { ok: true, posts: arr };
  }
  async function savePublicPosts(arr) {
    const list = Array.isArray(arr) ? arr : [];
      for (const p of list) { if (p && !p.id) p.id = newPublicId(); }
      const rows = list.filter((p) => p && typeof p.id === 'string' && p.id).map((p) => ({ id: p.id, data: p }));
      await sbSyncTable('public_posts', 'id', rows, 'id');
      scheduleBackup('public.json');
  }
  function newPublicId() {
    return 'pub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  // Public view of a post. likedBy (liker emails) is never exposed.
  function pubPost(p) {
    return { id: p.id, email: p.email, name: p.name || '', userId: p.userId || '', avatar: p.avatar || '', mode: p.mode, title: p.title, url: p.url, cover: p.cover || '', aspect: p.aspect || '', youtube: p.youtube || '', youtubeChannel: p.youtubeChannel || '', visibility: p.visibility, model: p.model || '', style: p.style || '', likes: p.likes || 0, views: p.views || 0, downloads: p.downloads || 0, saves: p.saves || 0, shares: p.shares || 0, createdAt: p.createdAt };
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
  let _mp3Cache = null; // lazy-loaded from Supabase (kv_docs 'mp3cache') on first use
  async function mp3CacheEnsure() {
    if (_mp3Cache && typeof _mp3Cache === 'object') return _mp3Cache;
    const j = await loadKvDoc('mp3cache', null);
    _mp3Cache = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
    return _mp3Cache;
  }
  async function mp3CacheSave() {
    try { await mp3CacheEnsure(); await saveKvDoc('mp3cache', _mp3Cache, 'mp3cache.json'); } catch (e) {}
  }
  function mp3CacheKey(u) {
    return require('crypto').createHash('sha1').update(String(u)).digest('hex').slice(0, 16);
  }
  async function mp3CacheGet(u) {
    const c = await mp3CacheEnsure();
      const k = mp3CacheKey(u);
      const f = c[k];
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
  async function loadCloudinaryAccounts() {
    const j = await loadKvDoc('cloudinary-accounts', []);
      return Array.isArray(j) ? j.filter((x) => x && typeof x === 'object') : [];
  }
  async function saveCloudinaryAccounts(arr) {
    await saveKvDoc('cloudinary-accounts', arr, 'cloudinary-accounts.json');
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
  async function cloudinaryCandidates() {
    const list = [];
    const env = cloudinaryEnvAccount();
    if (env) list.push(env);
    for (const a of await loadCloudinaryAccounts()) {
      if (!a || a.enabled === false) continue;
      if (cloudinaryAccountExhaustedNow(a)) continue;
      list.push(a);
    }
    return list;
  }
  async function cloudinaryConfigured() { return (await cloudinaryCandidates()).length > 0; }
  // ROUND-ROBIN pointer (owner order 2026-11-17): each NEW upload uses the
  // next enabled account in turn (upload 1 -> account 1, upload 2 ->
  // account 2, ... cycling), instead of draining one account until it
  // fails. The pointer is an account id (stable across adds/removes) and
  // is persisted to GitHub like the other admin data, so it survives
  // Render restarts. Advanced ONLY on a successful store.
  const CLOUDINARY_ROTATION_FILE = path.join(DATA_DIR, 'cloudinary-rotation.json');
  async function loadCloudinaryRotation() {
    const j = await loadKvDoc('cloudinary-rotation', null);
      if (j && typeof j === 'object') return j;
      return { lastAccountId: null };
  }
  async function saveCloudinaryRotation(obj) {
    await saveKvDoc('cloudinary-rotation', obj, 'cloudinary-rotation.json');
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
  // Cloudinary REJECTS non-ASCII (percent-encoded) characters in the
  // fl_attachment transformation flag — a Khmer title percent-encoded
  // into the flag returns HTTP 400 "Invalid flag in transformation:
  // attachment:%E1%9E%87..." and the MP3 download fails (owner hit
  // this 2026-11-19 on a Suno song with a Khmer title). The attachment
  // filename MUST be ASCII-only. Strip every non-ASCII character; if
  // the title had no ASCII characters at all (a pure Khmer title),
  // fall back to `fallback` (a safe name such as "MovAi-song") so the
  // download still works — the file just saves under the safe name
  // instead of the Khmer title. An empty title returns '' (caller
  // uses a bare fl_attachment, as before).
  function cloudinaryAsciiName(title, fallback) {
    const raw = String(title || '').trim();
    if (!raw) return '';
    const t = raw.replace(/[\\/:*?"<>|()\[\]{}#&=]/g, '').replace(/\s+/g, ' ').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (t) return t;
    const fb = String(fallback || 'MovAi-song').replace(/[^\x20-\x7E]/g, '').trim();
    return fb || 'MovAi-song';
  }
  // Build the download URL for a stored Cloudinary song. `title` is the
  // song's display name (optional) — when given, it becomes the download
  // filename via fl_attachment:<title> so the saved file is named after
  // the song (e.g. "WHY IS LIFE SO HARD ON ME.mp3") instead of the
  // provider's generic name ("output.mp3"). The title is sanitised to
  // ASCII-only characters (spaces kept, slashes/quotes stripped,
  // non-ASCII such as Khmer removed — Cloudinary rejects non-ASCII in
  // the fl_attachment flag) so the URL stays valid.
  function cloudinaryMp3UrlFor(a, publicId, title) {
    const c = cloudinaryConfigFor(a);
    if (!c) return null;
    const t = cloudinaryAsciiName(title, 'MovAi-song');
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
    const t = cloudinaryAsciiName(title, 'MovAi-song');
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
  // (One Cloudinary upload at a time — _cloudQueue is declared at the
  // TOP of apiRoute; see the comment there. Do NOT re-declare it here.)
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
  async function cloudinaryMarkAccount(a, kind, msg) {
    if (!a || a.source === 'env') { console.error('[cloudinary] env account ' + kind + ':', String(msg || '').slice(0, 160)); return; }
    try {
      const now = new Date().toISOString();
      const arr = await loadCloudinaryAccounts();
      const it = arr.find((x) => x && x.id === a.id);
      if (!it) return;
      it.lastError = String(msg || kind).slice(0, 200);
      it.lastErrorAt = now;
      if (kind === 'quota') { it.exhausted = true; it.exhaustedAt = now; }
      it.updatedAt = now;
      await saveCloudinaryAccounts(arr);
    } catch (e) {}
  }
  // Clear an admin account's exhausted/invalid marks after a success
  // (so it is tried first again next time). Never throws.
  async function cloudinaryClearAccountMarks(a) {
    if (!a || a.source === 'env') return;
    try {
      const arr = await loadCloudinaryAccounts();
      const it = arr.find((x) => x && x.id === a.id);
      if (!it) return;
      if (it.exhausted || it.lastError) {
        it.exhausted = false; it.exhaustedAt = null; it.lastError = ''; it.lastErrorAt = null;
        it.updatedAt = new Date().toISOString();
        await saveCloudinaryAccounts(arr);
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
    const candidates = await cloudinaryCandidates();
    if (!candidates.length) return null;
    // Round-robin: start from the account AFTER the one that stored the
    // last upload, so new uploads cycle through all enabled accounts
    // instead of draining the first one. (Inside _cloudQueue below, so
    // the read+advance is atomic — no two uploads can interleave it.)
    const rot = await loadCloudinaryRotation();
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
            // v2.2.63 (S3): bound the upload — a hung Cloudinary fetch
            // must never stall the serial _cloudQueue (and every song's
            // 'ready') forever. 120s, then this attempt fails and the
            // queue moves on; the deterministic public_id means a later
            // retry finds the asset if it did land.
            const res = await Promise.race([c.uploader.upload(u, { resource_type: 'video', public_id: detId, overwrite: false }), new Promise(function(_, rej) { setTimeout(function() { rej(new Error('cloudinary upload timeout')); }, 120000); })]);
            const publicId = res && res.public_id;
            if (!publicId) continue;
            const mp3Url = cloudinaryMp3UrlFor(a, publicId, title);
            memLog('cloudinary-upload ok ' + publicId + ' via ' + (a.label || a.cloudName));
            await cloudinaryClearAccountMarks(a);
            await saveCloudinaryRotation({ lastAccountId: a.id, updatedAt: new Date().toISOString() });
            return { publicId, mp3Url, accountId: a.id, accountLabel: a.label || a.cloudName };
          } catch (e) {
            const msg = String((e && e.message) || e);
            const kind = cloudinaryClassifyUploadError(msg);
            console.error('[cloudinary] upload via ' + (a.label || a.cloudName) + ' attempt ' + attempt + ' failed (' + kind + '):', msg.slice(0, 200));
            if (kind === 'exists') {
              // Asset already stored under our deterministic public_id.
              const mp3Url = cloudinaryMp3UrlFor(a, cloudinaryPublicIdForUrl(u), title);
              if (mp3Url) { await cloudinaryClearAccountMarks(a); await saveCloudinaryRotation({ lastAccountId: a.id, updatedAt: new Date().toISOString() }); return { publicId: cloudinaryPublicIdForUrl(u), mp3Url, accountId: a.id, accountLabel: a.label || a.cloudName }; }
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
              if (mp3Url) { await cloudinaryClearAccountMarks(a); await saveCloudinaryRotation({ lastAccountId: a.id, updatedAt: new Date().toISOString() }); return { publicId: detId, mp3Url, accountId: a.id, accountLabel: a.label || a.cloudName }; }
            }
            if (kind === 'gone') return 'gone';
            if (kind === 'quota') { await cloudinaryMarkAccount(a, 'quota', msg); break; }
            if (kind === 'auth') { await cloudinaryMarkAccount(a, 'auth', msg); break; }
            if (attempt === 2) { await cloudinaryMarkAccount(a, 'other', msg); break; }
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
      }
      return null;
    });
    _cloudQueue = run.catch(() => {});
    return run;
  }
  // ---- PERMANENT SONG URLs (owner order 2026-11-18): a song's canonical
  // audio URL must be a PERMANENT Cloudinary URL — never a Magic Hour
  // signed URL (expires after 24h) and never a bare proxy /uploads/ URL.
  // New posts/History items are converted to Cloudinary before saving
  // (see POST /api/public/post and POST /api/public/history), and a
  // startup heal (healDeadSongUrls, triggered once at the top of
  // apiRoute) re-links old dead links to their Cloudinary copy when one
  // exists. The Cloudinary public_id is deterministic from the source
  // URL (sha256, first 24 hex chars), so a copy stored earlier is found
  // again from the same source URL without re-uploading. NOTE: this
  // block must NOT use PUBLIC_FILE / UPLOADS_DIR (consts declared later
  // inside apiRoute — TDZ when the heal runs at the top); it uses
  // path.join(DATA_DIR, ...) directly instead. ----
  function isCloudinaryUrl(u) {
    return typeof u === 'string' && u.indexOf('res.cloudinary.com/') >= 0;
  }
  function isMagicHourUrl(u) {
    return typeof u === 'string' && u.indexOf('magichour.ai') >= 0;
  }
  function isProxyUploadsUrl(u) {
    return typeof u === 'string' && u.indexOf('/uploads/') >= 0 && (u.indexOf('movai-proxy-dphl.onrender.com/uploads/') >= 0 || u.indexOf('://') < 0);
  }
  // Fast check: does the Cloudinary asset for this source URL already
  // exist (stored earlier under its deterministic public_id)? Tries every
  // enabled Cloudinary account (the asset lives on exactly one). Returns
  // the permanent mp3Url, or null. No upload — just HEAD requests.
  async function cloudinaryExistingMp3Url(sourceUrl, title) {
    try {
      if (!await cloudinaryConfigured()) return null;
      const cands = await cloudinaryCandidates();
      if (!cands.length) return null;
      const detId = cloudinaryPublicIdForUrl(sourceUrl);
      for (const a of cands) {
        let mp3Url = null;
        try { mp3Url = cloudinaryMp3UrlFor(a, detId, title || ''); } catch (e) { mp3Url = null; }
        if (!mp3Url) continue;
        try {
          const r = await fetch(mp3Url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
          if (r && (r.status === 200 || r.status === 206)) return mp3Url;
        } catch (e) {}
      }
      return null;
    } catch (e) { return null; }
  }
  // Ensure a song URL is permanent. Cloudinary URLs pass through.
  // Anything else is first checked against Cloudinary (asset may already
  // exist under its deterministic public_id), then uploaded via
  // cloudinaryStoreSong. Returns the permanent Cloudinary mp3Url, or
  // null when Cloudinary cannot provide one (not configured, or the
  // source is gone/expired so it cannot be fetched).
  async function permanentSongUrl(url, title) {
    const u = String(url || '').trim();
    if (!u) return null;
    if (isCloudinaryUrl(u)) return u;
    if (!await cloudinaryConfigured()) return null;
    const existing = await cloudinaryExistingMp3Url(u, title);
    if (existing) return existing;
    try {
      const cl = await cloudinaryStoreSong(u, title || '');
      if (cl && cl.mp3Url) return cl.mp3Url;
    } catch (e) {}
    return null;
  }
  // ---- PERMANENT COVER URLs (v2.2.52): a public post's cover must
  // not die with its source. A Suno musicfile cover URL is deleted by
  // Suno after ~15 days, so it is fetched server-side and re-hosted on
  // Cloudinary under movai/covers/<sha256(source)> (deterministic, so
  // the same cover is never uploaded twice). Returns the Cloudinary
  // image URL, or null when it cannot be stored — the caller keeps the
  // ORIGINAL cover URL and the post still succeeds (a cover never
  // blocks a post). ----
  async function permanentCoverUrl(sourceUrl) {
    try {
      const u = String(sourceUrl || '').trim();
      if (!u || !/^https?:\/\//i.test(u)) return null;
      if (!await cloudinaryConfigured()) return null;
      const detId = 'movai/covers/' + require('crypto').createHash('sha256').update(u).digest('hex').slice(0, 24);
      const cands = await cloudinaryCandidates();
      for (const a of cands) {
        try {
          const c = cloudinaryConfigFor(a);
          if (!c) continue;
          const done = await Promise.race([
            c.uploader.upload(u, { resource_type: 'image', public_id: detId, overwrite: false }),
            new Promise(function(res) { setTimeout(function() { res('__timeout__'); }, 25000); })
          ]);
          if (done === '__timeout__') continue;
          if (done && done.secure_url) return done.secure_url;
          if (done && done.public_id) {
            try { const cu = c.url(detId, { resource_type: 'image' }); if (cu) return cu; } catch (e2) {}
          }
        } catch (e) {
          const kind = cloudinaryClassifyUploadError(String((e && e.message) || e));
          if (kind === 'exists') {
            try {
              const c2 = cloudinaryConfigFor(a);
              const cu = c2 && c2.url(detId, { resource_type: 'image' });
              if (cu) return cu;
            } catch (e2) {}
            continue;
          }
          if (kind === 'quota' || kind === 'auth') { try { await cloudinaryMarkAccount(a, kind, String((e && e.message) || e)); } catch (e3) {} break; }
        }
      }
      return null;
    } catch (e) { return null; }
  }
  // Startup heal: re-link dead song URLs to their Cloudinary copy.
  // Scans public.json + history.json. For a Magic Hour URL, the
  // Cloudinary copy (if stored earlier) is found via the deterministic
  // public_id and the URL is replaced — no re-upload, no source fetch,
  // so even an EXPIRED Magic Hour link heals when its copy exists.
  // For a dead proxy /uploads/ URL (file gone from disk and no GitHub
  // backup), there is no deterministic Cloudinary mapping, so it is only
  // logged, never re-linked. Runs once, fire-and-forget; never throws,
  // never blocks startup or any request.
  async function healDeadSongUrls() {
    try {
      let changedPublic = false;
      try {
        let posts = [];
        posts = await loadPublicPosts();
        for (const p of posts) {
          if (!p || typeof p.url !== 'string') continue;
          const u = p.url;
          if (isCloudinaryUrl(u)) continue;
          if (isMagicHourUrl(u)) {
            const perm = await cloudinaryExistingMp3Url(u, p.title || '');
            if (perm && perm !== u) { p.url = perm; changedPublic = true; console.log('[heal] public post ' + p.id + ' re-linked to Cloudinary'); }
          } else if (isProxyUploadsUrl(u)) {
            const name = String(u.split('/uploads/').pop() || '').split('?')[0].split('#')[0];
            let ok = false;
            try { ok = fs.existsSync(path.join(DATA_DIR, 'uploads', name)); } catch (e) { ok = false; }
            if (!ok) {
              try { const gb = await ghGetUpload(name); if (gb && gb.length) ok = true; } catch (e) {}
            }
            if (!ok) console.log('[heal] public post ' + p.id + ' dead upload, no Cloudinary copy: ' + u.slice(0, 90));
          }
        }
        if (changedPublic) {
          await savePublicPosts(posts);
        }
      } catch (e) { console.log('[heal] public posts skipped: ' + (e && e.message ? e.message : e)); }
      let changedHistory = false;
      try {
        const h = await loadHistory();
        for (const email of Object.keys(h)) {
          const items = Array.isArray(h[email]) ? h[email] : [];
          for (const it of items) {
            if (!it || typeof it.url !== 'string') continue;
            const u = it.url;
            if (isCloudinaryUrl(u)) continue;
            if (isMagicHourUrl(u)) {
              const perm = await cloudinaryExistingMp3Url(u, it.title || '');
              if (perm && perm !== u) { it.url = perm; changedHistory = true; console.log('[heal] history ' + email + ' "' + String(it.title || '').slice(0, 40) + '" re-linked to Cloudinary'); }
            }
          }
        }
        if (changedHistory) { await saveHistory(h); scheduleBackup('history.json'); }
      } catch (e) { console.log('[heal] history skipped: ' + (e && e.message ? e.message : e)); }
    } catch (e) { console.log('[heal] skipped: ' + (e && e.message ? e.message : e)); }
  }
  // ---- GitHub data resync REMOVED (Supabase migration) ----
  // The old throttled merge re-pulled public.json + history.json from
  // GitHub because GitHub was authoritative. Supabase is now the single
  // source of truth, so there is nothing to merge: every handler reads
  // fresh state from Supabase, and tombstones (deleted-items) still
  // guard against resurrection in the sync / post handlers below.

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
      // "Free 2 + package allowance" — Download MP3 gate (owner order
      // 2026-11-18). The website passes ?email=<signed-in Gmail>.
      // BYPASS CLOSED (owner order 2026-11-21 ~14:44): no email
      // param used to mean allowed with nothing consumed — anyone
      // could download unlimited MP3s by calling this endpoint
      // directly without ?email=. Now: no email -> never served
      // (sign in first). With an email: an
      // active package downloads unlimited (no free use consumed);
      // otherwise one of the 2 free downloads is consumed and saved
      // BEFORE serving; when both are used the file is NOT served.
      // Unknown email -> {ok:false, error:'no_account'} (never served).
      // Locked -> {ok:false, error:'download_out', message} (never served).
      const _dlEmail = normEmail(qp.get('email') || '');
      if (!_dlEmail) return sendJSON(res, 200, { ok: false, error: 'need_login', message: 'សូមចូលគណនេយ្យជាមុនសិន — សូម Sign in ដើម្បីទាញយក · Please sign in to download' });
      // BOUGHT-SONG EXPIRY (v2.2.61, 3 months): an expired bought song
      // can no longer be downloaded. Checked BEFORE the free-download
      // gate so an expired song never consumes a free download.
      // Self-created songs always pass. No email param -> cannot tell
      // whose song this is -> unchanged behaviour (allowed).
      if (_dlEmail && u) {
        try {
          const _h = await loadHistory();
          const _items = Array.isArray(_h[_dlEmail]) ? _h[_dlEmail] : [];
          const _mine = _items.find((it) => {
            if (!it || typeof it !== 'object') return false;
            const _iu = (typeof it.url === 'string' && it.url.trim()) || (typeof it.src === 'string' ? it.src.trim() : '');
            if (_iu !== u) return false;
            return it.origin === 'bought' || (typeof it.boughtAt === 'string' && !!it.boughtAt) || (typeof it.sellListingId === 'string' && !!it.sellListingId);
          });
          if (_mine) {
            const _listings = await loadSellListings();
            const _downloaded = await loadSellDownloaded();
            const _exp = sellExpiryForBoughtSong(_dlEmail, _mine, _listings, _downloaded);
            if (_exp && _exp.expired) return sendJSON(res, 200, { ok: false, error: 'expired', message: { km: 'បទនេះផុតកំណត់ហើយ — ទាញយកលែងបានទេ', en: 'This song has expired — it can no longer be downloaded' } });
          }
        } catch (e) {}
      }
      if (_dlEmail) {
        const _dlUsers = await loadUsers();
        const _dlU = _dlUsers[_dlEmail];
        if (!_dlU) return sendJSON(res, 200, { ok: false, error: 'no_account' });
        if (!hasActivePackage(_dlU)) {
          if (featureFreeUsed(_dlU, 'freeDlUsed') < FEATURE_FREE_LIMIT) { _dlU.freeDlUsed = featureFreeUsed(_dlU, 'freeDlUsed') + 1; }
          else if (featureBonus(_dlU, 'bonusDl') > 0) { _dlU.bonusDl = featureBonus(_dlU, 'bonusDl') - 1; }
          else return sendJSON(res, 200, { ok: false, error: 'download_out', message: 'You have used your 2 free downloads — please buy a package to download unlimited songs.' });
          _dlU.updatedAt = new Date().toISOString();
          await saveUsers(_dlUsers);
          scheduleBackup('users.json');
        }
      }
      if (!u) return sendJSON(res, 400, { ok: false, error: 'missing u' });
      try {
        // Cached MP3? Serve it instantly (no re-fetch, no re-encode).
        // STREAMING: pipe the file to the response — never load the
        // whole MP3 into memory (Hercules fix 2026-11-17).
        const cachedFp = await mp3CacheGet(u);
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
        if (!await cloudinaryConfigured()) return sendJSON(res, 503, { ok: false, error: 'MP3 download unavailable — Cloudinary not configured' });
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
    } else if (await cloudinaryConfigured()) {
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
      await logActivity({ at: new Date().toISOString(), mode: 'mv-lyrics' });
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
      const host = (req.headers && req.headers.host) || 'movai-proxy-dphl.onrender.com';
      const ownBase = proto + '://' + host;
      try {
        if (!url) return sendJSON(res, 200, { ok: false, error: 'missing url' });
        // Already one of OUR permanent uploads URLs? Nothing to do.
        if (url.indexOf('/uploads/') >= 0 && (url.indexOf(ownBase + '/uploads/') === 0 || url.indexOf('movai-proxy-dphl.onrender.com/uploads/') >= 0)) {
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
        if (!await cloudinaryConfigured()) return sendJSON(res, 200, { ok: false, error: 'cloudinary not configured', url });
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    (async () => {
      try {
        const all = [];
        const env = cloudinaryEnvAccount();
        if (env) all.push(env);
        for (const x of await loadCloudinaryAccounts()) all.push(x);
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const cloudName = String((body && body.cloudName) || '').trim();
      const apiKey = String((body && body.apiKey) || '').trim();
      const apiSecret = String((body && body.apiSecret) || '').trim();
      if (!cloudName || !apiKey || !apiSecret) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Cloud Name, API Key និង API Secret ទាំងបី' });
      const arr = await loadCloudinaryAccounts();
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
      await saveCloudinaryAccounts(arr);
      scheduleBackup('cloudinary-accounts.json');
      const st = await cloudinaryAccountStatus(cand);
      return sendJSON(res, 200, { ok: true, account: cloudinaryPublicAccount(cand, st), updated: !!dup });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹমត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/admin/cloudinary-accounts?id=... — admin key required.
  // Removes an admin account. The env (Main) account cannot be deleted.
  if (req.method === 'DELETE' && urlPath === '/api/admin/cloudinary-accounts') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const id = String(new URL(req.url, 'http://localhost').searchParams.get('id') || '').trim();
    if (!id || id === 'env') return sendJSON(res, 200, { ok: false, error: 'មិនអាចលុបគណនី Main នេះបានទេ' });
    const arr = await loadCloudinaryAccounts();
    const i = arr.findIndex((x) => x && x.id === id);
    if (i < 0) return sendJSON(res, 200, { ok: false, error: 'រកគណនីនេះមិនឃើញទេ' });
    arr.splice(i, 1);
    await saveCloudinaryAccounts(arr);
    return sendJSON(res, 200, { ok: true, deleted: id });
  }
  // POST /api/admin/cloudinary-accounts/toggle — {id, enabled} — admin
  // key required. Enables or disables an admin account.
  if (req.method === 'POST' && urlPath === '/api/admin/cloudinary-accounts/toggle') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = String((body && body.id) || '').trim();
      const enabled = !!(body && body.enabled);
      if (!id || id === 'env') return sendJSON(res, 200, { ok: false, error: 'មិនអាចបិទគណនី Main នេះបានទេ' });
      const arr = await loadCloudinaryAccounts();
      const it = arr.find((x) => x && x.id === id);
      if (!it) return sendJSON(res, 200, { ok: false, error: 'រកគណនីនេះមិនឃើញទេ' });
      it.enabled = enabled;
      it.updatedAt = new Date().toISOString();
      await saveCloudinaryAccounts(arr);
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
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = String((body && body.id) || '').trim();
      if (!id || id === 'env') return sendJSON(res, 200, { ok: false, error: 'គណនី Main មិនមានស្ថានភាពត្រូវសម្អាតទេ' });
      const arr = await loadCloudinaryAccounts();
      const it = arr.find((x) => x && x.id === id);
      if (!it) return sendJSON(res, 200, { ok: false, error: 'រកគណនីនេះមិនឃើញទេ' });
      it.exhausted = false; it.exhaustedAt = null; it.lastError = ''; it.lastErrorAt = null;
      it.updatedAt = new Date().toISOString();
      await saveCloudinaryAccounts(arr);
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
    return sendJSON(res, 200, { ok: true, providers: await keyHealthList(), deleted: await getDeletedProviders() });
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
  // Verified GitHub backup (owner order 2026-11-18): PUT the upload to
  // the movai-data repo and CONFIRM it landed, retrying once on failure.
  // Returns true only when the file is present in the repo (or when
  // GitHub is not configured at all, where ghPutUpload is a no-op true).
  // Callers must refuse success when this returns false — a file that is
  // only on the ephemeral Render disk will be wiped by the next restart.
  async function ghPutUploadVerified(name, b64) {
    let ok = false;
    try { ok = await ghPutUpload(name, b64); } catch (e) { ok = false; }
    if (!ok) {
      try { ok = await ghPutUpload(name, b64); } catch (e) { ok = false; }
    }
    return !!ok;
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
  // NOTE (2026-11-19): this endpoint MUST stay here (next to
  // /api/public/upload), AFTER the UPLOADS_DIR / _cloudQueue /
  // _cloudinary declarations — it calls cloudinaryStoreSong, and
  // apiRoute returns at the first matching branch, so an early
  // position leaves those `let`/`const` in the Temporal Dead Zone
  // (TDZ ReferenceError). Do NOT move it back next to /api/gen/song/cover.
  // ---- COVER (2026-11-19, v2.0.8): upload a song you already have ->
  // Suno sings a COVER (same melody/lyrics, new style/voice).
  // POST /api/gen/song/cover-upload — {email, filename, data(base64)}.
  // Saves the file to ./data/uploads/ (transient source — NO GitHub
  // backup: it is only needed until Cloudinary has fetched it once; the
  // COVER songs are the durable artifacts and are saved via the normal
  // History + Cloudinary flow), stores it on Cloudinary and returns the
  // public Cloudinary MP3 URL, passed straight to Suno as uploadUrl.
  // Accepts mp3/wav/flac/m4a (Suno takes mp3/wav/flac; Cloudinary
  // transcodes m4a to MP3, so m4a works too). Max 8 min / 20 MB.
  if (req.method === 'POST' && urlPath === '/api/gen/song/cover-upload') {
    readJSONBody(req, 40 * 1024 * 1024).then(async (body) => {
      try {
        const email = normEmail(body.email || '');
        if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនីជាមុនសិន' });
        const filename = String(body.filename || 'cover.mp3');
        const ext = uploadSafeExt('audio', filename);
        if (!ext) return sendJSON(res, 200, { ok: false, error: 'ឯកសារនេះមិនមែនជា Audio ទេ — សូមប្រើ mp3, wav, flac ឬ m4a · Audio only — mp3, wav, flac or m4a' });
        const b64 = String(body.data || '').replace(/\s/g, '');
        if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return sendJSON(res, 200, { ok: false, error: 'ទិន្នន័យឯកសារមិនត្រឹមត្រូវទេ · Bad file data' });
        let buf;
        try { buf = Buffer.from(b64, 'base64'); } catch (e) { return sendJSON(res, 200, { ok: false, error: 'ឯកសារខូច · Bad file data' }); }
        if (!buf.length || buf.length > 20 * 1024 * 1024) return sendJSON(res, 200, { ok: false, error: 'ឯកសារធំពេក — អតិបរមា 20 MB · File too big — max 20 MB' });
        const safeName = 'cover-' + Date.now().toString(36) + '-' + crypto.randomInt(100000, 999999) + ext;
        // NOTE: do NOT use UPLOADS_DIR here — it is a const declared
        // later inside apiRoute (TDZ for this branch, which returns
        // before reaching it). Use path.join(DATA_DIR, 'uploads') directly.
        const fpath = path.join(DATA_DIR, 'uploads', safeName);
        try { fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true }); } catch (e) {}
        fs.writeFileSync(fpath, buf);
        const proto = req.headers && req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
        const host = (req.headers && req.headers.host) || 'movai-proxy-dphl.onrender.com';
        const pubUrl = proto + '://' + host + '/uploads/' + safeName;
        const stored = await cloudinaryStoreSong(pubUrl, (filename || 'cover').replace(/\.[^.]+$/, ''));
        if (!stored || stored === 'gone' || !stored.mp3Url) {
          try { fs.unlinkSync(fpath); } catch (e) {}
          return sendJSON(res, 200, { ok: false, error: 'អាប់ឡូតបទមិនបានទេ — សូមព្យាយាមម្ដងទៀត · Upload failed — please try again' });
        }
        return sendJSON(res, 200, { ok: true, url: stored.mp3Url, name: safeName, size: buf.length });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: 'អាប់ឡូតបទមិនបានទេ៖ ' + (e && e.message ? e.message : 'unknown') }); }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/public/upload') {
    const a = await adminKeyOk(req);
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
        const host = (req.headers && req.headers.host) || 'movai-proxy-dphl.onrender.com';
        // Back up to GitHub BEFORE returning success, so the Admin app
        // only proceeds to create the post once the file is durable.
        // VERIFIED (owner order 2026-11-18): the backup is retried once,
        // and if it still fails the upload is REFUSED (surfaced as an
        // error) instead of silently reporting success with a file that
        // a restart would wipe.
        if (!(await ghPutUploadVerified(name, b64))) return sendJSON(res, 200, { ok: false, error: 'រក្សាទុកឯកសារបរាជ័យ (GitHub backup) — សូមព្យាយាមម្តងទៀត · Upload backup failed, please try again' });
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
        const host = (req.headers && req.headers.host) || 'movai-proxy-dphl.onrender.com';
        if (!(await ghPutUploadVerified(name, b64))) return sendJSON(res, 200, { ok: false, error: 'រក្សាទុកឯកសារបរាជ័យ (GitHub backup) — សូមព្យាយាមម្តងទៀត · Upload backup failed, please try again' });
        return sendJSON(res, 200, { ok: true, url: proto + '://' + host + '/uploads/' + name, name, kind: 'image', size: buf.length });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: 'រក្សាទុករូបភាពបរាជ័យ' });
      }
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- MovAi Song-Selling Service endpoints (v2.2.61) ----
  // GET /api/public/sell/tiers — PUBLIC. The company-fixed sell tiers.
  if (req.method === 'GET' && urlPath === '/api/public/sell/tiers') {
    return sendJSON(res, 200, { ok: true, tiers: SELL_TIERS });
  }
  // GET /api/public/sell/market — PUBLIC. Active listings grouped by
  // seller. Song audio URLs are NEVER included here — title/style/
  // duration only. Seller email is shown (needed to identify sellers in
  // the marketplace); no other user emails are exposed.
  if (req.method === 'GET' && urlPath === '/api/public/sell/market') {
    const listings = await loadSellListings();
    const users = await loadUsers();
    const bySeller = {};
    const order = [];
    const active = listings.filter((l) => l && l.status === 'active').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    for (const l of active) {
      const em = l.sellerEmail || '';
      if (!em) continue;
      if (!bySeller[em]) { bySeller[em] = []; order.push(em); }
      bySeller[em].push({ id: l.id, tier: l.tier, price: walletMoney(l.price), songCount: numOr(l.songCount, Array.isArray(l.songs) ? l.songs.length : 0), bonus: numOr(l.bonus, 0), songs: (Array.isArray(l.songs) ? l.songs : []).map(sellSongPublic), createdAt: l.createdAt || '' });
    }
    const sellers = order.map((em) => ({ sellerEmail: em, sellerName: sellDisplayName(users, em), listings: bySeller[em] }));
    return sendJSON(res, 200, { ok: true, sellers });
  }
  // GET /api/public/sell/my-songs?email=... — PUBLIC. The seller's own
  // songs from history_items, each with an origin ('created' = made by
  // this user, 'bought' = bought from someone else) and a blocked status
  // (null = can be listed): 'bought' (bought songs can NEVER be listed
  // again — takes precedence over every other reason), 'downloaded'
  // (already downloaded), 'posted' (already on Public), 'listed' (in an
  // active listing), 'sold' (in a sold listing).
  if (req.method === 'GET' && urlPath === '/api/public/sell/my-songs') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const h = await loadHistory();
    const listings = await loadSellListings();
    const downloaded = await loadSellDownloaded();
    const posts = await loadPublicPosts();
    const items = (Array.isArray(h[email]) ? h[email] : []).filter(sellIsSongItem);
    const songs = items.map((it) => {
      const s = sellSongFromHistory(it);
      const isBought = sellIsBoughtSong(email, s, listings);
      const reason = isBought ? 'bought' : sellBlockedReason(email, s, listings, downloaded, posts);
      // BOUGHT-SONG EXPIRY (v2.2.61): bought songs carry their expiry
      // (3 months after purchase); self-created songs get expiry: null.
      const expiry = isBought ? sellExpiryForBoughtSong(email, it, listings, downloaded) : null;
      return { key: s.key, title: s.title, url: s.url, image: s.image, style: s.style, taskId: s.taskId, audioId: s.audioId, duration: s.duration, createdAt: s.createdAt, origin: s.origin, blocked: reason ? { reason } : null, pairKey: s.taskId, expiry };
    });
    return sendJSON(res, 200, { ok: true, email, songs });
  }
  // POST /api/public/sell/list — {email, tier, songKeys} — PUBLIC.
  // Lists a fixed-size package of the seller's own songs. Validates the
  // tier, the exact song count, ownership, the PAIR RULE (no two songs
  // may share a taskId — the two clips of one generation are one song),
  // and all four blocked reasons. On success the songs leave the
  // seller's history (they now belong to the listing, not the seller).
  // NOTE: no deleted-item tombstones are recorded here — tombstones are
  // global by history key, and the SAME song must live on in the
  // buyer's history after a sale; a tombstone would block the buyer's
  // copy from ever syncing. The 'listed'/'sold' blocked checks stop a
  // re-list instead.
  if (req.method === 'POST' && urlPath === '/api/public/sell/list') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'invalid_email', message: { km: 'សូមដាក់ Gmail ត្រឹមត្រូវ', en: 'Please enter a valid Gmail' } });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'user_not_found', message: { km: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន', en: 'No account with this Gmail, please sign up first' } });
      const tier = sellTierByTier(body && body.tier);
      if (!tier) return sendJSON(res, 200, { ok: false, error: 'invalid_tier', message: { km: 'កញ្ចប់នេះមិនស្គាល់ទេ', en: 'Unknown tier' } });
      const rawKeys = body && Array.isArray(body.songKeys) ? body.songKeys : [];
      const songKeys = [];
      for (const k of rawKeys) { if (typeof k === 'string' && k.trim() && songKeys.indexOf(k.trim()) < 0) songKeys.push(k.trim()); }
      if (songKeys.length !== tier.songs) return sendJSON(res, 200, { ok: false, error: 'wrong_count', message: { km: 'កញ្ចប់នេះត្រូវការ ' + tier.songs + ' បទ (អ្នកបានជ្រើស ' + songKeys.length + ' បទ)', en: 'This tier needs ' + tier.songs + ' songs (you picked ' + songKeys.length + ')' }, expected: tier.songs, got: songKeys.length });
      const h = await loadHistory();
      const byKey = {};
      for (const it of (Array.isArray(h[email]) ? h[email] : [])) {
        if (!sellIsSongItem(it)) continue;
        byKey[histKey(it)] = sellSongFromHistory(it);
      }
      const missing = songKeys.filter((k) => !byKey[k]);
      if (missing.length) return sendJSON(res, 200, { ok: false, error: 'not_owned', message: { km: 'មានបទខ្លះមិនមែនជារបស់អ្នកទេ', en: 'Some songs do not belong to you' }, keys: missing });
      const picked = songKeys.map((k) => byKey[k]);
      // PAIR RULE: two clips of one generation share a taskId — they are
      // one song and must never sit in the same package twice.
      const seenTask = {};
      for (const s of picked) {
        if (!s.taskId) continue;
        if (seenTask[s.taskId]) return sendJSON(res, 200, { ok: false, error: 'pair', message: { km: 'បទ 2 នេះគឺជាបទតែមួយ (បង្កើតមកពី generation តែមួយ) — សូមជ្រើសបទផ្សេង', en: 'Two of these songs are the same song (from one generation) — please pick a different song' }, taskId: s.taskId });
        seenTask[s.taskId] = true;
      }
      const listings = await loadSellListings();
      const downloaded = await loadSellDownloaded();
      const posts = await loadPublicPosts();
      // NO RE-SALE: a song bought from someone else can NEVER be listed
      // again. Rejected here with nothing changed (no listing created,
      // no songs removed). The fallback inside sellIsBoughtSong also
      // catches older transferred copies without the origin field.
      const boughtBlocked = [];
      for (const s of picked) {
        if (sellIsBoughtSong(email, s, listings)) boughtBlocked.push({ key: s.key, reason: 'bought' });
      }
      if (boughtBlocked.length) return sendJSON(res, 200, { ok: false, error: 'bought', message: { km: 'បទដែលបានទិញពីអ្នកផ្សេង មិនអាចដាក់លក់ម្ដងទៀតបានទេ — មានតែបទដែលអ្នកបង្កើតដោយខ្លួនឯងទេ ទើបដាក់លក់បាន', en: 'Songs bought from someone else cannot be listed for sale again — only songs you created yourself can be listed' }, blocked: boughtBlocked });
      const blocked = [];
      for (const s of picked) {
        const reason = sellBlockedReason(email, s, listings, downloaded, posts);
        if (reason) blocked.push({ key: s.key, reason });
      }
      if (blocked.length) return sendJSON(res, 200, { ok: false, error: 'blocked', message: { km: 'មានបទខ្លះដាក់លក់មិនបានទេ (បាន Download / បាន Post / បានដាក់លក់ / លក់រួចហើយ)', en: 'Some songs cannot be listed (downloaded / posted / already listed / already sold)' }, blocked });
      const now = new Date().toISOString();
      const listing = {
        id: sellNewId('sell_'), sellerEmail: email, sellerName: sellDisplayName(users, email),
        tier: tier.tier, price: tier.price, songCount: tier.songs, bonus: tier.bonus,
        songs: picked, status: 'active', buyerEmail: null, createdAt: now, soldAt: null,
      };
      listings.push(listing);
      await saveSellListings(listings);
      h[email] = (Array.isArray(h[email]) ? h[email] : []).filter((it) => songKeys.indexOf(histKey(it)) < 0);
      await saveHistory(h);
      scheduleBackup('history.json');
      try {
        await addNotification('purchase-request', email, '🎵 ដាក់លក់បទ · Song package listed', 'អ្នកបានដាក់លក់កញ្ចប់ ' + tier.songs + ' បទ តម្លៃ $' + tier.price.toFixed(2) + ' — អ្នកនឹងទទួលបាន $' + (tier.price * 0.95).toFixed(2) + ' ពេលមានអ្នកទិញ · You listed ' + tier.songs + ' songs for $' + tier.price.toFixed(2) + ' — you will receive $' + (tier.price * 0.95).toFixed(2) + ' when someone buys', { extra: { sellListing: true, listingId: listing.id, pkg: 'sell-listing', price: tier.price, tier: tier.tier } });
      } catch (e) {}
      return sendJSON(res, 200, { ok: true, listingId: listing.id });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/sell/buy — {email, listingId, method, receiptUrl|receiptData}
  // — PUBLIC. method 'wallet': completes the sale at once (see
  // completeSellSale). method 'receipt': creates a 'song-sale' purchase
  // request for the Admin to approve (KHQR + receipt, like packages);
  // nothing is transferred until the Admin approves.
  if (req.method === 'POST' && urlPath === '/api/public/sell/buy') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'invalid_email', message: { km: 'សូមដាក់ Gmail ត្រឹមត្រូវ', en: 'Please enter a valid Gmail' } });
      const listingId = typeof body.listingId === 'string' ? body.listingId.trim() : '';
      if (!listingId) return sendJSON(res, 200, { ok: false, error: 'invalid_listing', message: { km: 'សូមជ្រើសកញ្ចប់បទដែលចង់ទិញ', en: 'Please choose a song package to buy' } });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'user_not_found', message: { km: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន', en: 'No account with this Gmail, please sign up first' } });
      const listings = await loadSellListings();
      const listing = listings.find((x) => x && x.id === listingId);
      if (!listing) return sendJSON(res, 200, { ok: false, error: 'listing_not_found', message: { km: 'រកកញ្ចប់បទនេះមិនឃើញទេ', en: 'Listing not found' } });
      if (listing.status !== 'active') return sendJSON(res, 200, { ok: false, error: 'listing_not_active', message: { km: 'កញ្ចប់បទនេះលក់រួចហើយ ឬលែងមានទេ', en: 'This listing is no longer available' } });
      if (listing.sellerEmail === email) return sendJSON(res, 200, { ok: false, error: 'cannot_buy_own', message: { km: 'អ្នកមិនអាចទិញបទរបស់ខ្លួនឯងបានទេ', en: 'You cannot buy your own songs' } });
      const method = typeof body.method === 'string' ? body.method.trim().toLowerCase() : 'wallet';
      if (method === 'wallet') {
        const done = await completeSellSale(listing, email);
        if (!done.ok) return sendJSON(res, 200, done);
        return sendJSON(res, 200, { ok: true, listingId: done.listingId, price: done.price, songs: done.songs, sellerGot: done.sellerGot, movaiGot: done.movaiGot, balance: done.balance });
      }
      if (method === 'receipt') {
        const now = new Date().toISOString();
        const price = walletMoney(listing.price);
        const reqs = await loadPurchaseRequests();
        const r = {
          id: newPurchaseId(), email, packageId: 'song-sale', kind: 'song-sale', type: 'song-sale',
          listingId: listing.id, buyerEmail: email, sellerEmail: listing.sellerEmail, price,
          plan: 'Song sale · ' + (Array.isArray(listing.songs) ? listing.songs.length : 0) + ' songs · $' + price.toFixed(2),
          amount: price, credits: 0, songCredits: 0, days: 0,
          receiptUrl: (typeof body.receiptUrl === 'string' ? body.receiptUrl : (typeof body.receiptData === 'string' ? body.receiptData : '')).trim().slice(0, 500),
          status: 'pending', createdAt: now, updatedAt: now,
        };
        reqs.push(r);
        await savePurchaseRequests(reqs);
        scheduleBackup('purchase-requests.json');
        try {
          await addNotification('purchase-request', email, '🛒 សំណើទិញបទ · Song purchase request', email + ' · ID: ' + (u.id || '—') + ' សុំទិញកញ្ចប់ ' + (Array.isArray(listing.songs) ? listing.songs.length : 0) + ' បទ តម្លៃ $' + price.toFixed(2) + ' ពី ' + sellDisplayName(users, listing.sellerEmail) + ' (KHQR — បានបង់ហើយ មានវិក្កយបត្រភ្ជាប់មក)', { extra: { pkg: 'song-sale', listingId: listing.id, priceText: '$' + price.toFixed(2), buyerId: u.id || '—', sellerEmail: listing.sellerEmail } });
        } catch (e) {}
        return sendJSON(res, 200, { ok: true, requestId: r.id, status: 'pending' });
      }
      return sendJSON(res, 200, { ok: false, error: 'invalid_method', message: { km: 'វិធីបង់ប្រាក់មិនត្រឹមត្រូវទេ', en: 'Invalid payment method' } });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/sell/mark-downloaded — {email, songKey} — PUBLIC.
  // Records that the owner downloaded this song (it can then never be
  // listed). Fire-and-forget safe: always {ok:true} unless email missing.
  if (req.method === 'POST' && urlPath === '/api/public/sell/mark-downloaded') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const key = typeof body.songKey === 'string' ? body.songKey.trim() : '';
      if (!key) return sendJSON(res, 200, { ok: true });
      try {
        const m = await loadSellDownloaded();
        const arr = Array.isArray(m[email]) ? m[email] : [];
        if (arr.indexOf(key) < 0) { arr.push(key); m[email] = arr; await saveSellDownloaded(m); }
      } catch (e) {}
      return sendJSON(res, 200, { ok: true });
    }).catch(() => sendJSON(res, 200, { ok: true }));
    return;
  }
  // GET /api/public/sell/my-listings?email=... — PUBLIC. The seller's own
  // listings (active + sold): song titles, price, status, buyer name
  // when sold. No audio URLs.
  if (req.method === 'GET' && urlPath === '/api/public/sell/my-listings') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const listings = await loadSellListings();
    const users = await loadUsers();
    const mine = listings.filter((l) => l && l.sellerEmail === email).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return sendJSON(res, 200, { ok: true, email, listings: mine.map((l) => ({ id: l.id, tier: l.tier, price: walletMoney(l.price), songCount: numOr(l.songCount, Array.isArray(l.songs) ? l.songs.length : 0), bonus: numOr(l.bonus, 0), songs: (Array.isArray(l.songs) ? l.songs : []).map(sellSongPublic), status: l.status, buyerName: l.status === 'sold' && l.buyerEmail ? sellDisplayName(users, l.buyerEmail) : '', createdAt: l.createdAt || '', soldAt: l.soldAt || '' })) });
  }
  // GET /api/public/sell/my-purchases?email=... — PUBLIC. Listings this
  // user bought: song titles, price, seller name, bought date.
  if (req.method === 'GET' && urlPath === '/api/public/sell/my-purchases') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
    const listings = await loadSellListings();
    const users = await loadUsers();
    const downloaded = await loadSellDownloaded();
    const mine = listings.filter((l) => l && l.status === 'sold' && l.buyerEmail === email).sort((a, b) => String(b.soldAt || b.createdAt || '').localeCompare(String(a.soldAt || a.createdAt || '')));
    return sendJSON(res, 200, { ok: true, email, purchases: mine.map((l) => ({ id: l.id, tier: l.tier, price: walletMoney(l.price), songCount: numOr(l.songCount, Array.isArray(l.songs) ? l.songs.length : 0), bonus: numOr(l.bonus, 0), songs: (Array.isArray(l.songs) ? l.songs : []).map(sellSongPublic), sellerName: sellDisplayName(users, l.sellerEmail), sellerEmail: l.sellerEmail || '', boughtAt: l.soldAt || l.createdAt || '', createdAt: l.createdAt || '', expiry: sellBoughtExpiry(l, downloaded) })) });
  }
  // POST /api/public/sell/unlist — {email, listingId} — PUBLIC.
  // The seller cancels their own UNSOLD listing: the listing is removed
  // and its songs return to the seller's history (pickable again for a
  // fresh listing). Only the listing owner may unlist; a SOLD listing
  // can never be deleted (the buyer owns those songs now).
  if (req.method === 'POST' && urlPath === '/api/public/sell/unlist') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'invalid_email', message: { km: 'សូមដាក់ Gmail ត្រឹមត្រូវ', en: 'Please enter a valid Gmail' } });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'user_not_found', message: { km: 'រក Gmail នេះមិនឃើញទេ — សូម Sign-up ជាមុនសិន', en: 'No account with this Gmail, please sign up first' } });
      const listingId = typeof body.listingId === 'string' ? body.listingId.trim() : '';
      if (!listingId) return sendJSON(res, 200, { ok: false, error: 'invalid_listing', message: { km: 'រកកញ្ចប់នេះមិនឃើញទេ', en: 'Listing not found' } });
      const listings = await loadSellListings();
      const idx = listings.findIndex((x) => x && x.id === listingId);
      if (idx < 0) return sendJSON(res, 200, { ok: false, error: 'not_found', message: { km: 'រកកញ្ចប់នេះមិនឃើញទេ', en: 'Listing not found' } });
      const l = listings[idx];
      if (l.sellerEmail !== email) return sendJSON(res, 200, { ok: false, error: 'not_owner', message: { km: 'កញ្ចប់នេះមិនមែនជារបស់អ្នកទេ', en: 'This listing is not yours' } });
      if (l.status === 'sold') return sendJSON(res, 200, { ok: false, error: 'sold', message: { km: 'កញ្ចប់ដែលលក់រួច លុបមិនបានទេ', en: 'A sold package cannot be deleted' } });
      const songs = Array.isArray(l.songs) ? l.songs : [];
      listings.splice(idx, 1);
      await saveSellListings(listings);
      // Return the songs to the seller's history (they left history when
      // listed). Rebuild history items from the stored song records;
      // skip any key that is already back in history.
      const h = await loadHistory();
      const cur = Array.isArray(h[email]) ? h[email] : [];
      const have = {};
      for (const it of cur) { const k = histKey(it); if (k) have[k] = true; }
      const restored = [];
      for (const sg of songs) {
        if (!sg || typeof sg !== 'object') continue;
        const url = typeof sg.url === 'string' ? sg.url.trim() : '';
        if (!url) continue;
        const item = {
          id: (typeof sg.key === 'string' && sg.key.indexOf('id:') === 0) ? sg.key.slice(3) : '',
          url,
          title: typeof sg.title === 'string' ? sg.title : '',
          style: typeof sg.style === 'string' ? sg.style : '',
          taskId: typeof sg.taskId === 'string' ? sg.taskId : '',
          audioId: typeof sg.audioId === 'string' ? sg.audioId : '',
          duration: numOr(sg.duration, 0),
          image: typeof sg.image === 'string' ? sg.image : '',
          createdAt: typeof sg.createdAt === 'string' ? sg.createdAt : new Date().toISOString(),
          ts: (typeof sg.createdAt === 'string' && Date.parse(sg.createdAt)) ? Date.parse(sg.createdAt) : Date.now(),
          origin: 'created',
          mode: 'song',
        };
        if (!item.id) delete item.id;
        const k = histKey(item);
        if (!k || have[k]) continue;
        have[k] = true;
        restored.push(item);
      }
      // Newest first (the picker sorts newest first, so restored songs
      // are immediately pickable at the top).
      restored.sort((a, b) => numOr(b.ts, 0) - numOr(a.ts, 0));
      h[email] = restored.concat(cur);
      await saveHistory(h);
      scheduleBackup('history.json');
      try {
        await addNotification('purchase-request', email, '🎵 លុបកញ្ចប់លក់ · Listing removed', 'អ្នកបានលុបកញ្ចប់លក់តម្លៃ $' + walletMoney(l.price) + ' — បទចម្រៀង ' + restored.length + ' បទបានត្រឡប់មកវិញ · You removed your $' + walletMoney(l.price) + ' listing — ' + restored.length + ' songs are back', { extra: { sellListing: true, listingId: l.id, pkg: 'sell-unlist', price: l.price } });
      } catch (e) {}
      return sendJSON(res, 200, { ok: true, listingId: l.id, restored: restored.length });
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
        const host = (req.headers && req.headers.host) || 'movai-proxy-dphl.onrender.com';
        if (!(await ghPutUploadVerified(name, b64))) return sendJSON(res, 200, { ok: false, error: 'រក្សាទុកឯកសារបរាជ័យ (GitHub backup) — សូមព្យាយាមម្តងទៀត · Upload backup failed, please try again' });
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
      let url = typeof body.url === 'string' ? body.url.trim().slice(0, 2000) : '';
      if (!url) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ link' });
      // PERMANENT URL (owner order 2026-11-18): a public post's canonical
      // audio URL must be a permanent Cloudinary URL — never a Magic Hour
      // signed URL (dead in 24h). Convert first; a Magic Hour URL that
      // cannot be stored to Cloudinary is refused (a public post that
      // breaks tomorrow is worse than no post). A proxy /uploads/ URL is
      // GitHub-backed and durable, so it is kept when Cloudinary cannot
      // take it; a Cloudinary URL passes through untouched.
      if (isMagicHourUrl(url)) {
        const perm = await permanentSongUrl(url, title);
        if (!perm) return sendJSON(res, 200, { ok: false, error: 'បទនេះរក្សាទុកជាអចិន្ត្រៃយ៍មិនបានទេ (Cloudinary) — សូមព្យាយាមម្តងទៀត · This song could not be stored permanently, please try again' });
        url = perm;
      } else if (isProxyUploadsUrl(url)) {
        const perm = await permanentSongUrl(url, title);
        if (perm) url = perm;
      }
      const visibility = body.visibility === 'private' ? 'private' : 'public';
      const aspectRaw = typeof body.aspect === 'string' ? body.aspect.trim() : '';
      const aspect = (aspectRaw === '1x1' || aspectRaw === '4x6' || aspectRaw === '16:9') ? aspectRaw : '';
      const youtube = typeof body.youtube === 'string' ? body.youtube.trim().slice(0, 2000) : '';
      const youtubeChannel = typeof body.youtubeChannel === 'string' ? body.youtubeChannel.trim().slice(0, 2000) : '';
      const avatar = typeof body.avatar === 'string' ? body.avatar.trim().slice(0, 500) : '';
      const now = new Date().toISOString();
      const posts = await loadPublicPosts();
      // Optional client-provided id (idempotent re-post from the phone).
      // A tombstoned id (deleted post) can never be re-posted, and an id
      // that already exists cannot be reused.
      const clientId = typeof body.id === 'string' ? body.id.trim().slice(0, 100) : '';
      if (clientId) {
        if ((await loadDeletedItems()).posts[clientId]) return sendJSON(res, 200, { ok: false, error: 'Post នេះត្រូវបានលុបហើយ · This post was deleted and cannot be re-posted' });
        if (posts.some((x) => x && x.id === clientId)) return sendJSON(res, 200, { ok: false, error: 'Post នេះមានរួចហើយ · This post already exists' });
        // Resurrection guard (tombstone fix 2026-11-18): a client-provided
        // id embeds its creation time (pub_<base36 ms><6 random chars>).
        // An id whose embedded time is older than the 5-minute grace, and
        // which is absent from local posts, is a deleted post being
        // re-posted (the merge never tombstoned it because local == GitHub
        // after a restart). Refuse it and tombstone it. Unparseable ids
        // are accepted (fail-open).
        if (/^pub_[0-9a-z]+$/.test(clientId) && clientId.length >= 11) {
          const idTs = parseInt(clientId.slice(4, -6), 36);
          if (Number.isFinite(idTs) && idTs > 1577836800000 && idTs < 1893456000000 && Date.now() - idTs >= 5 * 60 * 1000) {
            await tombstonePostIdNow(clientId);
            scheduleBackup('deleted-items.json');
            return sendJSON(res, 200, { ok: false, error: 'Post នេះត្រូវបានលុបហើយ · This post was deleted and cannot be re-posted' });
          }
        }
      }
      // Free 2 — Post to Public, PER TYPE (owner order 2026-11-18,
      // per-type 2026-11-18 15:12; tiered weekly limits 2026-11-21,
      // v2.2.60): Songs, Images, Videos and 3D EACH have their own
      // 2 LIFETIME free posts. An active package no longer means
      // unlimited for every tier: $5 = 10 posts/week, $10 = 20/week,
      // $30 = 30/week, $50 / grandfathered $22 Pro / media-only plan
      // = unlimited. Private posts are NOT counted (public-only).
      // The weekly counter is consumed only after the post is
      // actually created below (same as the Free 2). When the package
      // EXPIRES, posting locks per type unless a free post of that
      // type remains; the per-type counters are lifetime and never
      // reset on re-buy.
      const users = await loadUsers();
      const _postU = users[email];
      let _postFree = false;
      let _postBonus = false;
      let _postWeek = false;
      let _postType = null;
      if (_postU && visibility === 'public') {
        _postType = postTypeOf(mode, body.type);
        const _postWeekLim = postWeekLimitFor(_postU);
        if (_postWeekLim === Infinity) { /* unlimited — consume nothing */ }
        else if (typeof _postWeekLim === 'number') {
          const _wk = postWeekStartMonday();
          if (_postU.postWeekStart !== _wk) { _postU.postWeekStart = _wk; _postU.postWeekCount = 0; }
          if (numOr(_postU.postWeekCount, 0) >= _postWeekLim) return sendJSON(res, 200, { ok: false, error: 'post_week_out', message: 'You have used your ' + _postWeekLim + ' public posts for this week — your limit resets on Monday.' });
          _postWeek = true;
        }
        else if (freePostUsedByType(_postU)[_postType] < FEATURE_FREE_LIMIT) { _postFree = true; }
        else if (bonusPostByType(_postU)[_postType] > 0) { _postBonus = true; }
        else return sendJSON(res, 200, { ok: false, error: 'post_out', message: 'You have used your 2 free public posts for this type — please buy a package to post unlimited.' });
      }
      // Cover permanence (v2.2.52): a post's cover must not die with
      // its source. Cloudinary + proxy /uploads/ covers are already
      // durable and pass through. Any other http(s) cover URL (e.g. a
      // Suno musicfile URL — Suno deletes generated files after ~15
      // days) is fetched server-side and re-hosted on Cloudinary; if
      // that fails, the ORIGINAL URL is kept and the post still
      // succeeds — the cover never blocks a post.
      let coverRaw = (typeof body.cover === 'string' && body.cover.trim()) ? body.cover.trim().slice(0, 2000) : (typeof body.image === 'string' ? body.image.trim().slice(0, 2000) : '');
      if (coverRaw && /^https?:\/\//i.test(coverRaw) && !isCloudinaryUrl(coverRaw) && !isProxyUploadsUrl(coverRaw)) {
        const permCover = await permanentCoverUrl(coverRaw);
        if (permCover) coverRaw = permCover;
      }
      const p = {
        id: clientId || newPublicId(), email,
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '',
        userId: typeof body.userId === 'string' ? body.userId.trim().slice(0, 50) : '',
        mode, title, url, style: typeof body.style === 'string' ? body.style.trim().slice(0, 200) : '',
        cover: coverRaw,
        aspect, youtube, youtubeChannel, avatar, visibility, model: typeof body.model === 'string' ? body.model.trim().slice(0, 50) : '', likes: 0, views: 0, downloads: 0, saves: 0, shares: 0, likedBy: [], createdAt: now,
      };
      posts.push(p);
      if (posts.length > PUBLIC_MAX) posts.splice(0, posts.length - PUBLIC_MAX);
      await savePublicPosts(posts);
      // Free 2 — Post to Public, PER TYPE (owner order 2026-11-18
      // 15:12): consume ONE free post of THAT TYPE only, and only
      // now that the post is durably created. A failed URL
      // conversion or a refused client id above never burns a free
      // post. Unlimited tier -> consume nothing. Private posts never
      // consume. Unknown email (no user record) fails OPEN — this
      // endpoint never required a user record before.
      if (_postFree && _postU && _postType) {
        const _byType = freePostUsedByType(_postU);
        _byType[_postType] = Math.min(FEATURE_FREE_LIMIT, _byType[_postType] + 1);
        _postU.freePostUsedByType = _byType;
        _postU.updatedAt = now;
        await saveUsers(users);
        scheduleBackup('users.json');
      }
      if (_postBonus && _postU && _postType) {
        const _bByType = bonusPostByType(_postU);
        _bByType[_postType] = Math.max(0, _bByType[_postType] - 1);
        _postU.bonusPostByType = _bByType;
        _postU.updatedAt = now;
        await saveUsers(users);
        scheduleBackup('users.json');
      }
      // v2.2.60 weekly post limit: consume ONE weekly post, only now
      // that the post is durably created. The week-start reset from
      // the gate above is saved together with the increment.
      if (_postWeek && _postU && _postType) {
        _postU.postWeekCount = numOr(_postU.postWeekCount, 0) + 1;
        _postU.updatedAt = now;
        await saveUsers(users);
        scheduleBackup('users.json');
      }
      // Critical write: confirm public.json is on GitHub BEFORE returning
      // success, so a restart in the next second cannot lose a post that
      // the Admin app already reported as posted.
      scheduleBackup('public.json');
      // New public post -> notify FOLLOWERS only (one 'post' notification
      // per follower, in-app + Web Push to their phones immediately).
      // Private posts never notify anyone.
      if (visibility === 'public') {
        for (const f of await loadFollowers()) {
          await addNotification('post', f, '📢 បានផុសថ្មី · New post', p.title + ' (' + mode + ') — ' + (p.name || email));
        }
      }
      const _pd = pubPost(p);
      _pd.hasPlan = !!_postU && hasActivePackage(_postU);
      return sendJSON(res, 200, { ok: true, post: _pd });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // DELETE /api/public/post — ADMIN KEY required. {id}. Removes the post
  // record from public.json (an uploaded file in ./data/uploads/ is left
  // alone — only the post record is deleted). The GitHub flush is awaited
  // before success is returned, so the deletion survives a restart
  // (same pattern as POST /api/public/post).
  if (req.method === 'DELETE' && urlPath === '/api/public/post') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ post id' });
      const posts = await loadPublicPosts();
      const idx = posts.findIndex((x) => x && x.id === id);
      if (idx < 0) return sendJSON(res, 200, { ok: false, error: 'រកមិនឃើញ post នេះទេ' });
      posts.splice(idx, 1);
      await savePublicPosts(posts);
      // Critical write: confirm public.json is on GitHub BEFORE returning
      // success, so a restart in the next second cannot resurrect a post
      // the Admin app already reported as deleted.
      scheduleBackup('public.json');
      // Tombstone the id so the deleted post can never be re-posted or
      // re-added by a client sync (resurrection bug 2026-11-18).
      await tombstonePostIdNow(id);
      scheduleBackup('deleted-items.json');
      return sendJSON(res, 200, { ok: true, deletedId: id });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/public/feed — PUBLIC. Only public posts, ranked by
  // views (highest first); ties broken by more likes, then earlier
  // createdAt. rank is 1-based; tier 1 = rank 1–50, tier 2 = 51–200,
  // tier 3 = the rest.
  if (req.method === 'GET' && urlPath === '/api/public/feed') {
    const tombs = await loadDeletedItems();
    const read = await loadPublicPostsStatus();
    if (!read.ok) return sendJSON(res, 200, { ok: false, error: 'Server កំពុងរវល់ — សូមព្យាយាមម្ដងទៀត · Server busy — please try again' });
    const posts = read.posts.filter((p) => p && p.visibility === 'public' && !tombs.posts[p.id]);
    posts.sort((a, b) => ((b.views || 0) - (a.views || 0)) || ((b.likes || 0) - (a.likes || 0)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    // v2.2.48: the poster's active-package flag rides with each post so
    // the feed can render the Profile-style name + badge (only when the
    // poster has an active package). One users-map load for all posts.
    let _feedUsers = null;
    try { _feedUsers = await loadUsers(); } catch (e) {}
    const out = posts.map((p, i) => {
      const rank = i + 1;
      const d = pubPost(p);
      d.rank = rank;
      d.tier = rank <= 50 ? 1 : rank <= 200 ? 2 : 3;
      d.hasPlan = !!(_feedUsers && hasActivePackage(_feedUsers[normEmail(p.email)]));
      return d;
    });
    // Deleted-post ids/urls so phones drop locked copies (tombstone
    // sync, same pattern as GET /api/public/history). Posts tombstones
    // are stored by raw post id; 'id:'/'url:' keys are handled too.
    const tombKeys = Object.keys(tombs.posts || {});
    tombKeys.sort((a, b) => String(tombs.posts[b] || '').localeCompare(String(tombs.posts[a] || '')));
    const recent = tombKeys.slice(0, 600);
    const deletedIds = [];
    const deletedUrls = [];
    for (const k of recent) {
      if (k.indexOf('id:') === 0) deletedIds.push(k.slice(3));
      else if (k.indexOf('url:') === 0) deletedUrls.push(k.slice(4));
      else deletedIds.push(k);
    }
    // Fire-and-forget broken-post check (throttled inside).
    try { maybeSweepBrokenPosts(); } catch (e) {}
    return sendJSON(res, 200, { ok: true, posts: out, deletedIds, deletedUrls });
  }
  // POST /api/public/like — PUBLIC. {postId} (or {id}). v2.2.48:
  // INCREMENT-ONLY (owner 15:06, like YouTube views): every call = +1,
  // tapping again = +1 more, NO toggle-off, NO decrement, NEVER down.
  // No email required, no per-user dedup (the old likedBy dedup is
  // gone — it also silently dropped the client's {id} calls, which is
  // why taps vanished on refresh). Returns the new server count.
  if (req.method === 'POST' && urlPath === '/api/public/like') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const postId = (typeof body.postId === 'string' ? body.postId.trim() : '') || (typeof body.id === 'string' ? body.id.trim() : '');
      if (!postId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId' });
      const posts = await loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      p.likes = (p.likes || 0) + 1;
      await savePublicPosts(posts);
      scheduleBackup('public.json');
      return sendJSON(res, 200, { ok: true, likes: p.likes });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/save — PUBLIC. {postId}. v2.2.48: every call = +1
  // to the post's save count (increment-only, like Like). The phone
  // keeps its local playlist too; the SERVER count is the truth.
  if (req.method === 'POST' && urlPath === '/api/public/save') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const postId = (typeof body.postId === 'string' ? body.postId.trim() : '') || (typeof body.id === 'string' ? body.id.trim() : '');
      if (!postId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId' });
      const posts = await loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      p.saves = (p.saves || 0) + 1;
      await savePublicPosts(posts);
      scheduleBackup('public.json');
      return sendJSON(res, 200, { ok: true, saves: p.saves });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/share — PUBLIC. {postId}. v2.2.48: every call = +1
  // to the post's share count (increment-only, like Like).
  if (req.method === 'POST' && urlPath === '/api/public/share') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const postId = (typeof body.postId === 'string' ? body.postId.trim() : '') || (typeof body.id === 'string' ? body.id.trim() : '');
      if (!postId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId' });
      const posts = await loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      p.shares = (p.shares || 0) + 1;
      await savePublicPosts(posts);
      scheduleBackup('public.json');
      return sendJSON(res, 200, { ok: true, shares: p.shares });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/view — PUBLIC. {postId, email?, country?, durationSec?}.
  // Counts one view. EVERY view (guest or logged in) counts into the
  // post total AND the owner's daily monetization counts (Total views,
  // Today's views, Earnings by country — owner order 2026-11-20 09:08,
  // PER DAY rule). Earnings (money) only accrue for a logged-in view
  // while monetization is ON and the owner is approved; guest views
  // earn nothing.
  if (req.method === 'POST' && urlPath === '/api/public/view') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const postId = typeof body.postId === 'string' ? body.postId.trim() : '';
      if (!postId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId' });
      const posts = await loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      p.views = (p.views || 0) + 1;
      await savePublicPosts(posts);
      scheduleBackup('public.json');
      // Monetization (owner 2026-11-20 09:08 — PER DAY rule): EVERY
      // view counts into the owner's Total / Today's views / Earnings
      // by country — guest views too (email ''), not just logged-in
      // ones. Earnings still only accrue for logged-in views while
      // monetization is ON and the owner is approved. Never blocks
      // the view count — a monetization failure must not lose the view.
      const _vEmail = normEmail(body && body.email);
      try {
        const _vCountry = (typeof body.country === 'string' && body.country.trim()) ? body.country.trim() : ((typeof body.countryCode === 'string' && body.countryCode.trim()) ? body.countryCode.trim() : '');
        const _vDur = numOr(body && (body.durationSec !== undefined ? body.durationSec : body.duration), 0);
        await monetizationOnView(p.email, _vEmail, _vCountry, _vDur);
      } catch (e) {}
      return sendJSON(res, 200, { ok: true, views: p.views });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/watch — PUBLIC. {postId?, ownerEmail?, email, seconds}.
  // Accrues LISTENING time (seconds) as Watch hours for a post's
  // creator (Monetization eligibility progress). Watch time ONLY:
  // no view increment, no earnings — the website heartbeats here
  // every 30s of real playback and flushes the remainder on
  // pause/ended. Logged-in listeners only; the creator listening
  // to their own song is NOT counted. `seconds` is capped per call
  // (1..300) so a bad client cannot inflate hours in one shot.
  if (req.method === 'POST' && urlPath === '/api/public/watch') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const viewer = normEmail(body && body.email);
      if (!viewer) return sendJSON(res, 200, { ok: false, error: 'សូមចូលគណនេយ្យជាមុនសិន · Please sign in first' });
      const users = await loadUsers();
      if (!users[viewer]) return sendJSON(res, 200, { ok: false, error: 'no_account' });
      let owner = '';
      const postId = typeof body.postId === 'string' ? body.postId.trim() : '';
      if (postId) {
        const posts = await loadPublicPosts();
        const p = posts.find((x) => x && x.id === postId);
        if (!p) return sendJSON(res, 200, { ok: false, error: 'រក post នេះមិនឃើញទេ · Post not found' });
        owner = normEmail(p.email);
      } else if (body && body.ownerEmail) {
        owner = normEmail(body.ownerEmail);
      }
      if (!owner) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ postId ឬ ownerEmail · Missing postId or ownerEmail' });
      if (owner === viewer) return sendJSON(res, 200, { ok: true, skipped: 'self' });
      const secs = Math.max(0, Math.min(300, Math.floor(numOr(body && body.seconds, 0))));
      if (secs <= 0) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ seconds · Missing seconds' });
      const got = await monetizationRecord(owner);
      if (!got) return sendJSON(res, 200, { ok: false, error: 'no_account' });
      got.rec.watchSeconds = numOr(got.rec.watchSeconds, 0) + secs;
      await saveMonetizationEarnings(got.m);
      return sendJSON(res, 200, { ok: true, watchSeconds: got.rec.watchSeconds, watchHours: Math.round(got.rec.watchSeconds / 3600 * 100) / 100 });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- Promo Views + Watch Hours boost (owner order 2026-11-18 23:24) ----
  // Pricing (linear, rounded to 2 decimals via walletMoney):
  //   Views: $0.10 per 1k views = $0.0001/view (500=$0.05, 1k=$0.10,
  //     5.5K=$0.55, 10K=$1.00, 100K=$10.00, 1M=$100.00, 10M=$1,000.00).
  //   Watch hours: $8.00 per 500 hours = $0.016/hour (500=$8.00,
  //     1k=$16.00, 5.5K=$88.00).
  //   Follows: $0.01332 per follower (500=$6.66, 1k=$13.32,
  //     5.5K=$73.26). Any positive integer amount; packages 500 /
  //     1k / 5.5K + custom. No postId — followers go to the user's
  //     account, not a post.
  // Storage (exact fields — same fields the live site already reads):
  //   Post views: public_posts row `data.views` (integer) — the same
  //     field the feed sorts by and POST /api/public/view increments.
  //   User TOTAL views for display: monetization-earnings record
  //     (kv_docs key 'monetization-earnings', per-email) `views` — the
  //     same field GET /api/public/monetization/status and /earnings
  //     return as `views`. NOTE: organic views only increment that
  //     field when monetization is ON and the owner is approved
  //     (monetizationOnView); promo views add to it unconditionally,
  //     so a boost is always visible on the Monetization sheet.
  //   User TOTAL watch hours: the same record's `watchSeconds`
  //     (SECONDS, integer) — watchHours = watchSeconds / 3600,
  //     rounded to 2 decimals on read (same as /api/public/watch and
  //     the monetization status). Promo hours are stored as
  //     amount * 3600 seconds.
  //   Promo FOLLOWERS: the same record's `promoFollowers` (integer)
  //     — a SEPARATE counter, never fake creator_follows rows (no
  //     fake follower accounts). creatorFollowerCount() adds it to
  //     the organic follow count, so promo followers count toward
  //     the displayed follower total everywhere (monetization
  //     status / eligibility at 1,000 followers, profile, feed
  //     counts) while the organic base stays untouched.
  // Boosted views NEVER generate view earnings: this code only touches
  // `views` / `watchSeconds` / `promoFollowers` and never earnMicro /
  // pendingMicro. Promo followers likewise generate NO earnings.
  // Owner 2026-11-20 11:42: boosted views DO count into Today's views
  // (viewsByDate[Phnom Penh date]) and byCountry, same as organic
  // plays — automatic every day, no manual action.
  // Payment rule (same as the wallet package buy): deduct from the
  // spendable Wallet `balance` BEFORE adding; refund on failure.
  // Notifications use addNotification (Admin bell + Telegram), same as
  // purchase-approve / grant / deduct.
  const PROMO_VIEW_PRICE = 0.0001; // $ per view
  const PROMO_HOUR_PRICE = 0.016; // $ per watch hour
  const PROMO_FOLLOWER_PRICE = 0.01332; // $ per follower (500=$6.66)
  function promoPriceFor(type, amount) {
    if (type === 'hours') return walletMoney(amount * PROMO_HOUR_PRICE);
    if (type === 'follows') return walletMoney(amount * PROMO_FOLLOWER_PRICE);
    return walletMoney(amount * PROMO_VIEW_PRICE);
  }
  function promoValidAmount(v) {
    const n = Number(v);
    return (Number.isInteger(n) && n > 0) ? n : 0;
  }
  // Applies a promo boost that has already passed validation (and, for
  // buys, payment). Saves the post row (views only) and the owner's
  // monetization-earnings record. Returns {views, watchHours,
  // followers} where views is the post's view count (or null when no
  // post was given; for 'follows' it is the user's TOTAL view count,
  // integer), watchHours is the owner's NEW total watch hours in
  // HOURS (2 decimals), and followers (follows only) is the user's
  // NEW total follower count (organic + promoFollowers, integer).
  async function promoApplyBoost(email, post, type, amount) {
    let views = null;
    if (type === 'views' && post) {
      post.views = Math.max(0, Math.floor(numOr(post.views, 0)) + amount);
      views = post.views;
      const posts = await loadPublicPosts();
      const idx = posts.findIndex((x) => x && x.id === post.id);
      if (idx >= 0) posts[idx] = post; else posts.push(post);
      await savePublicPosts(posts);
      scheduleBackup('public.json');
    } else if (post) {
      views = Math.max(0, Math.floor(numOr(post.views, 0)));
    }
    const got = await monetizationRecord(email);
    if (!got) throw new Error('no_account');
    if (type === 'views') {
      got.rec.views = numOr(got.rec.views, 0) + amount;
      // Owner 2026-11-20 11:42: boosted (promo) views count into
      // Today's views and byCountry too, same as organic plays —
      // automatic every day (keyed by Phnom Penh date). They still
      // never earn: no earnMicro / pendingMicro touched here.
      // No viewer country exists for a boost, so they count as Unknown.
      if (!got.rec.viewsByDate || typeof got.rec.viewsByDate !== 'object') got.rec.viewsByDate = {};
      const _ptoday = imgFreeTodayDate();
      got.rec.viewsByDate[_ptoday] = numOr(got.rec.viewsByDate[_ptoday], 0) + amount;
      if (!got.rec.byCountry || typeof got.rec.byCountry !== 'object') got.rec.byCountry = {};
      if (!got.rec.byCountry.Unknown || typeof got.rec.byCountry.Unknown !== 'object') got.rec.byCountry.Unknown = { views: 0, earnMicro: 0 };
      got.rec.byCountry.Unknown.views = numOr(got.rec.byCountry.Unknown.views, 0) + amount;
    }
    else if (type === 'follows') got.rec.promoFollowers = Math.max(0, Math.floor(numOr(got.rec.promoFollowers, 0)) + amount);
    else got.rec.watchSeconds = numOr(got.rec.watchSeconds, 0) + amount * 3600;
    await saveMonetizationEarnings(got.m);
    const watchHours = Math.round(numOr(got.rec.watchSeconds, 0) / 3600 * 100) / 100;
    if (type === 'follows') {
      views = Math.max(0, Math.floor(numOr(got.rec.views, 0)));
      const followers = await creatorFollowerCount(email);
      return { views, watchHours, followers };
    }
    return { views, watchHours };
  }
  // POST /api/public/promo/buy — {email, postId, type, amount} — PUBLIC
  // (logged-in user). type 'views' (postId REQUIRED), 'hours' (postId
  // OPTIONAL — hours go to the user's total, not a post) or 'follows'
  // (postId NOT used — followers go to the user's account, not a
  // post). Deducts the price from the spendable Wallet balance BEFORE
  // adding; refunds on failure. Success: {ok:true, type, amount,
  // price, balance, views, watchHours} — price in dollars (2
  // decimals), balance = NEW wallet balance, views = post's NEW view
  // count (hours + postId: current views; hours without postId: null;
  // follows: user's TOTAL view count, integer), watchHours = user's
  // NEW total watch hours IN HOURS. Follows success ALSO carries
  // followers = user's NEW total follower count (organic +
  // promoFollowers, integer). Errors: insufficient_balance /
  // not_found / not_owner / not_public / invalid_amount /
  // invalid_type.
  if (req.method === 'POST' && urlPath === '/api/public/promo/buy') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const type = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
      if (type !== 'views' && type !== 'hours' && type !== 'follows') return sendJSON(res, 200, { ok: false, error: 'invalid_type' });
      const promoLabel = type === 'views' ? 'Views' : type === 'follows' ? 'Follows' : 'Watch hours';
      const amount = promoValidAmount(body && body.amount);
      if (!amount) return sendJSON(res, 200, { ok: false, error: 'invalid_amount' });
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'not_found' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'not_found' });
      const postId = typeof body.postId === 'string' ? body.postId.trim() : '';
      let post = null;
      if (type === 'views') {
        if (!postId) return sendJSON(res, 200, { ok: false, error: 'not_found' });
        const posts = await loadPublicPosts();
        post = posts.find((x) => x && x.id === postId) || null;
        if (!post) return sendJSON(res, 200, { ok: false, error: 'not_found' });
        if (normEmail(post.email) !== email) return sendJSON(res, 200, { ok: false, error: 'not_owner' });
        if (post.visibility !== 'public') return sendJSON(res, 200, { ok: false, error: 'not_public' });
      } else if (type === 'hours' && postId) {
        const posts = await loadPublicPosts();
        post = posts.find((x) => x && x.id === postId) || null;
        if (!post) return sendJSON(res, 200, { ok: false, error: 'not_found' });
        if (normEmail(post.email) !== email) return sendJSON(res, 200, { ok: false, error: 'not_owner' });
        if (post.visibility !== 'public') return sendJSON(res, 200, { ok: false, error: 'not_public' });
      }
      const price = promoPriceFor(type, amount);
      const bal = walletBalance(u);
      if (price > bal) return sendJSON(res, 200, { ok: false, error: 'insufficient_balance', balance: bal, price });
      // Deduct BEFORE adding (same pattern as the wallet package buy).
      const now = new Date().toISOString();
      u.balance = walletMoney(bal - price);
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      await notifyWalletDeduct(email, price, 'Wallet', 'Boost · promo boost', u.balance);
      let applied;
      try {
        applied = await promoApplyBoost(email, post, type, amount);
      } catch (e) {
        // Add failed after deduction — REFUND the deduction.
        try {
          const users2 = await loadUsers();
          const u2 = users2[email];
          if (u2) { u2.balance = walletMoney(walletBalance(u2) + price); u2.updatedAt = new Date().toISOString(); await saveUsers(users2); scheduleBackup('users.json'); }
        } catch (e2) {}
        return sendJSON(res, 200, { ok: false, error: 'failed' });
      }
      await logGrant({ email, credits: 0, songCredits: 0, note: 'promo-buy:' + type + ':' + amount + ':$' + price.toFixed(2) + (post ? ' post:' + post.id : ''), at: now });
      await addNotification('purchase-approved', email, '🚀 Promo · ' + promoLabel + ' +' + amount, (u.name || email) + ' (' + email + ') · ID: ' + (u.id || '—') + ' បានទិញ Promo ' + promoLabel + ' +' + amount + ' តម្លៃ $' + price.toFixed(2) + (post ? ' — «' + (post.title || '') + '»' : '') + ' (នៅសល់ $' + u.balance.toFixed(2) + ')', { extra: { promo: true, type, amount, price, balance: u.balance, buyerId: u.id || '—', decision: 'approved', paidBy: 'wallet' } });
      if (type === 'follows') return sendJSON(res, 200, { ok: true, type, amount, price, balance: u.balance, followers: applied.followers, views: applied.views, watchHours: applied.watchHours });
      return sendJSON(res, 200, { ok: true, type, amount, price, balance: u.balance, views: applied.views, watchHours: applied.watchHours });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/discount/buy — {email, feature, postType?} — PUBLIC
  // (logged-in user). Buys 4 uses of ONE feature at the discount price
  // (owner order 2026-11-18 23:57): Post $0.99 / Download $1.29 /
  // MV $1.99 / Vocal Studio $0.29. feature 'post' takes postType
  // (song/image/video/3d, default 'song'). Deducts the price from the
  // spendable Wallet balance BEFORE adding; refunds on failure.
  // Success: {ok:true, feature, postType, price, balance, bonusLeft, left}.
  // Errors: insufficient_balance / not_found / invalid_feature.
  if (req.method === 'POST' && urlPath === '/api/public/discount/buy') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const feature = typeof body.feature === 'string' ? body.feature.trim().toLowerCase() : '';
      if (DISCOUNT_FEATURES.indexOf(feature) < 0) return sendJSON(res, 200, { ok: false, error: 'invalid_feature' });
      const postType = feature === 'post' ? postTypeOf('', body && body.postType) : '';
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'not_found' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'not_found' });
      const price = DISCOUNT_PACK[feature].price;
      const bal = walletBalance(u);
      if (price > bal) return sendJSON(res, 200, { ok: false, error: 'insufficient_balance', balance: bal, price });
      const now = new Date().toISOString();
      u.balance = walletMoney(bal - price);
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      await notifyWalletDeduct(email, price, 'Wallet', 'Discount pack · ' + feature, u.balance);
      let bonusLeft;
      try {
        bonusLeft = grantDiscountBonus(u, feature, postType);
        u.updatedAt = new Date().toISOString();
        await saveUsers(users);
        scheduleBackup('users.json');
      } catch (e) {
        try {
          const users2 = await loadUsers();
          const u2 = users2[email];
          if (u2) { u2.balance = walletMoney(walletBalance(u2) + price); u2.updatedAt = new Date().toISOString(); await saveUsers(users2); scheduleBackup('users.json'); }
        } catch (e2) {}
        return sendJSON(res, 200, { ok: false, error: 'failed' });
      }
      const featLabel = feature === 'post' ? 'Post' : feature === 'download' ? 'Download' : feature === 'mv' ? 'MV' : 'Vocal Studio';
      await logGrant({ email, credits: 0, songCredits: 0, note: 'discount-buy:' + feature + (postType ? ':' + postType : '') + ':4:$' + price.toFixed(2), at: now });
      await addNotification('purchase-approved', email, '💥 Discount · 4× ' + featLabel + ' +' + 4, (u.name || email) + ' (' + email + ') · ID: ' + (u.id || '—') + ' បានទិញ Discount 4× ' + featLabel + (postType ? ' (' + postType + ')' : '') + ' តម្លៃ $' + price.toFixed(2) + ' (នៅសល់ $' + u.balance.toFixed(2) + ')', { extra: { discount: true, feature, postType, price, balance: u.balance, buyerId: u.id || '—', decision: 'approved', paidBy: 'wallet' } });
      const lim = featureLimitsFor(u);
      const left = feature === 'post' ? (lim.post.unlimited ? Infinity : (lim.post.byType[postType] ? lim.post.byType[postType].freeLeft + lim.post.byType[postType].bonusLeft : 0)) : feature === 'download' ? (lim.download.unlimited ? Infinity : lim.download.freeLeft + lim.download.bonusLeft) : feature === 'mv' ? lim.mv.left : lim.vs.left;
      return sendJSON(res, 200, { ok: true, feature, postType, price, balance: u.balance, bonusLeft, left });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/admin/promo/grant — {targetId, postId, type, amount} —
  // admin key ONLY (Authorization: Bearer <MOVAI_ADMIN_KEY>; the
  // x-admin-key header is REJECTED, same as every other admin
  // endpoint — adminKeyOk checks the Bearer header only). targetId is
  // the user's User ID (e.g. "3Z96CSY5N4"). PAID — deducts the price
  // from the TARGET user's spendable Wallet balance BEFORE adding
  // (owner correction 2026-11-19: the admin sets the money, the grant
  // must charge it, never grant free). Price: views amount * $0.0001,
  // hours amount * $0.016, rounded to 2 decimals (promoPriceFor, same
  // as the buy endpoint). For 'views', postId is REQUIRED. For
  // 'follows', postId is NOT used (followers go to the target's
  // account). Follows price: amount * $0.01332 (500=$6.66). Success:
  // {ok:true, type, amount, price, balance, views, watchHours, email,
  // name} — price = dollars charged (2 decimals), balance = target
  // user's NEW spendable balance, views = post's NEW view count
  // (hours without postId: null; follows: target's TOTAL view count,
  // integer), watchHours = user's NEW total watch hours IN HOURS.
  // Follows success ALSO carries followers = target user's NEW total
  // follower count (organic + promoFollowers, integer). Errors: insufficient_balance (carries balance +
  // price) / user_not_found / post_not_found / not_public /
  // invalid_amount / invalid_type / unauthorized. Add-failure after
  // deduction refunds and returns {ok:false, error:'failed'}.
  if (req.method === 'POST' && urlPath === '/api/admin/promo/grant') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: 'unauthorized' });
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const type = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
      if (type !== 'views' && type !== 'hours' && type !== 'follows') return sendJSON(res, 200, { ok: false, error: 'invalid_type' });
      const promoLabel = type === 'views' ? 'Views' : type === 'follows' ? 'Follows' : 'Watch hours';
      const amount = promoValidAmount(body && body.amount);
      if (!amount) return sendJSON(res, 200, { ok: false, error: 'invalid_amount' });
      const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
      if (!targetId) return sendJSON(res, 200, { ok: false, error: 'user_not_found' });
      const users = await loadUsers();
      const target = Object.values(users).find((x) => x && x.id === targetId) || null;
      if (!target) return sendJSON(res, 200, { ok: false, error: 'user_not_found' });
      const email = normEmail(Object.keys(users).find((k) => users[k] === target) || target.email || '');
      if (!email) return sendJSON(res, 200, { ok: false, error: 'user_not_found' });
      const postId = typeof body.postId === 'string' ? body.postId.trim() : '';
      let post = null;
      if (type === 'views') {
        if (!postId) return sendJSON(res, 200, { ok: false, error: 'post_not_found' });
        const posts = await loadPublicPosts();
        post = posts.find((x) => x && x.id === postId) || null;
        if (!post) return sendJSON(res, 200, { ok: false, error: 'post_not_found' });
        if (normEmail(post.email) !== email) return sendJSON(res, 200, { ok: false, error: 'post_not_found' });
        if (post.visibility !== 'public') return sendJSON(res, 200, { ok: false, error: 'not_public' });
      } else if (type === 'hours' && postId) {
        const posts = await loadPublicPosts();
        post = posts.find((x) => x && x.id === postId) || null;
        if (!post) return sendJSON(res, 200, { ok: false, error: 'post_not_found' });
        if (normEmail(post.email) !== email) return sendJSON(res, 200, { ok: false, error: 'post_not_found' });
        if (post.visibility !== 'public') return sendJSON(res, 200, { ok: false, error: 'not_public' });
      }
      const price = promoPriceFor(type, amount);
      const bal = walletBalance(target);
      if (price > bal) return sendJSON(res, 200, { ok: false, error: 'insufficient_balance', balance: bal, price });
      // Deduct from the TARGET user's spendable Wallet balance BEFORE
      // adding (same pattern as the buy endpoint / wallet package buy).
      const now = new Date().toISOString();
      target.balance = walletMoney(bal - price);
      target.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      let applied;
      try {
        applied = await promoApplyBoost(email, post, type, amount);
      } catch (e) {
        // Add failed after deduction — REFUND the deduction.
        try {
          const users2 = await loadUsers();
          const u2 = users2[email];
          if (u2) { u2.balance = walletMoney(walletBalance(u2) + price); u2.updatedAt = new Date().toISOString(); await saveUsers(users2); scheduleBackup('users.json'); }
        } catch (e2) {}
        return sendJSON(res, 200, { ok: false, error: 'failed' });
      }
      await logGrant({ email, credits: 0, songCredits: 0, note: 'promo-grant:' + type + ':' + amount + ':$' + price.toFixed(2) + (post ? ' post:' + post.id : ''), at: now });
      await addNotification('grant', email, '➕ Promo · ' + promoLabel + ' +' + amount, 'Admin បានបន្ថែម Promo ' + promoLabel + ' +' + amount + ' ឲ្យ ' + email + ' · ID: ' + (target.id || '—') + ' តម្លៃ $' + price.toFixed(2) + (post ? ' — «' + (post.title || '') + '»' : '') + ' (នៅសល់ $' + target.balance.toFixed(2) + ')', { extra: { promo: true, type, amount, price, balance: target.balance, buyerId: target.id || '—' } });
      if (type === 'follows') return sendJSON(res, 200, { ok: true, type, amount, price, balance: target.balance, followers: applied.followers, views: applied.views, watchHours: applied.watchHours, email, name: target.name || '' });
      return sendJSON(res, 200, { ok: true, type, amount, price, balance: target.balance, views: applied.views, watchHours: applied.watchHours, email, name: target.name || '' });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // ---- "Free 2 + package allowance" limits (Download MP3, MV, Vocal Studio, Post to Public) ----
  // GET /api/public/image-free?email= — PUBLIC. Read-only; never
  // creates a user. Free allowances (owner order 2026-11-20 07:45 —
  // 20 free images per DAY and 10 free thumbnails per 3 days,
  // SEPARATE counters):
  // {ok:true, date, images:{limit:20, used, left, start, resetDate},
  //  thumbnails:{limit:10, used, left, start, resetDate}}.
  // The top-level limit/used/left fields are the enforced daily image
  // allowance (20/day), kept for backward compatibility.
  // Unknown email -> {ok:false, error:'no_account'}.
  if (req.method === 'GET' && urlPath === '/api/public/image-free') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'no_account' });
    const u = (await loadUsers())[email];
    if (!u) return sendJSON(res, 200, { ok: false, error: 'no_account' });
    const today = imgFreeTodayDate();
    const imgWin = _freeDailyWindow(u.imgFreeDaily);
    const thumbWin = _free3Window(u.thumbFree3);
    return sendJSON(res, 200, {
      ok: true, date: today,
      limit: IMG_FREE_DAILY_LIMIT, used: imgWin.used, left: Math.max(0, IMG_FREE_DAILY_LIMIT - imgWin.used),
      images: { limit: IMG_FREE_DAILY_LIMIT, used: imgWin.used, left: Math.max(0, IMG_FREE_DAILY_LIMIT - imgWin.used), start: imgWin.start, resetDate: imgWin.resetDate },
      thumbnails: { limit: THUMB_FREE_3DAY_LIMIT, used: thumbWin.used, left: Math.max(0, THUMB_FREE_3DAY_LIMIT - thumbWin.used), start: thumbWin.start, resetDate: thumbWin.resetDate }
    });
  }
  // GET /api/public/ai-lyrics-free?email= — PUBLIC. Read-only; never
  // creates a user. Free AI Lyrics allowance per day (owner order
  // 2026-11-19 07:47 — 2 free AI Lyrics generations per user per day,
  // Phnom Penh date; packages do NOT change it):
  // {ok:true, date, limit:2, used, left}.
  // Unknown email -> {ok:false, error:'no_account'}.
  if (req.method === 'GET' && urlPath === '/api/public/ai-lyrics-free') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'no_account' });
    const u = (await loadUsers())[email];
    if (!u) return sendJSON(res, 200, { ok: false, error: 'no_account' });
    const today = imgFreeTodayDate();
    const used = (u.aiLyrDaily && typeof u.aiLyrDaily === 'object' && u.aiLyrDaily.date === today) ? Math.max(0, Math.floor(Number(u.aiLyrDaily.used) || 0)) : 0;
    return sendJSON(res, 200, { ok: true, date: today, limit: AI_LYRICS_DAILY_LIMIT, used, left: Math.max(0, AI_LYRICS_DAILY_LIMIT - used) });
  }
  // GET /api/public/feature-limits?email= — PUBLIC. Read-only; never
  // creates a user. Returns the Free-2 + package-allowance state:
  // {ok:true, email, download:{free:2, used, freeLeft, unlimited},
  //  mv:{free:2, used, freeLeft, pkgLeft, left},
  //  vs:{free:2, used, freeLeft, pkgLeft, left},
  //  post:{free:2, used, freeLeft, unlimited}}
  // download.unlimited = the user has ANY active (non-expired) package.
  // post.unlimited = same (any active package -> unlimited posting).
  // Unknown email -> {ok:false, error:'no_account'}.
  if (req.method === 'GET' && urlPath === '/api/public/feature-limits') {
    const email = normEmail(new URL(req.url, 'http://localhost').searchParams.get('email') || '');
    if (!email) return sendJSON(res, 200, { ok: false, error: 'no_account' });
    const u = (await loadUsers())[email];
    if (!u) return sendJSON(res, 200, { ok: false, error: 'no_account' });
    const lim = featureLimitsFor(u);
    return sendJSON(res, 200, { ok: true, email, download: lim.download, mv: lim.mv, vs: lim.vs, post: lim.post });
  }
  // POST /api/public/mv-use — PUBLIC. {email}. The website calls this
  // when the user taps MV, before opening the MV player. Package
  // allowance first, then the 2 free uses; otherwise locked.
  // {ok:true, source:'package'|'free', left} — left = total MV plays
  // remaining (freeLeft + mvLeft after the decrement/increment).
  // Locked -> {ok:false, error:'mv_out', message} (no counter changed).
  // Unknown email -> {ok:false, error:'no_account'}.
  if (req.method === 'POST' && urlPath === '/api/public/mv-use') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const email = normEmail(body && body.email);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'no_account' });
      const users = await loadUsers();
      const u = users[email];
      if (!u) return sendJSON(res, 200, { ok: false, error: 'no_account' });
      const now = new Date().toISOString();
      let source;
      // Package allowance is spendable ONLY while a package is active.
      // An expired package's remaining mvLeft is LOST — never spent;
      // go straight to the lifetime Free 2 instead.
      if (hasActivePackage(u) && (u.mvUnlimited || featurePkgLeft(u, 'mvLeft') > 0)) { if (!u.mvUnlimited) u.mvLeft = featurePkgLeft(u, 'mvLeft') - 1; source = 'package'; }
      else if (featureFreeUsed(u, 'freeMvUsed') < FEATURE_FREE_LIMIT) { u.freeMvUsed = featureFreeUsed(u, 'freeMvUsed') + 1; source = 'free'; }
      else if (featureBonus(u, 'bonusMv') > 0) { u.bonusMv = featureBonus(u, 'bonusMv') - 1; source = 'bonus'; }
      else return sendJSON(res, 200, { ok: false, error: 'mv_out', message: 'You have used your 2 free MV plays and have no MV allowance left — please buy a song package to continue.' });
      u.updatedAt = now;
      await saveUsers(users);
      scheduleBackup('users.json');
      return sendJSON(res, 200, { ok: true, source, left: featureLimitsFor(u).mv.left });
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
      const posts = await loadPublicPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return sendJSON(res, 404, { ok: false, error: 'រក post នេះមិនឃើញទេ' });
      p.downloads = (p.downloads || 0) + 1;
      await savePublicPosts(posts);
      scheduleBackup('public.json');
      return sendJSON(res, 200, { ok: true, downloads: p.downloads });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // POST /api/public/feature-usage — PUBLIC. {feature, email?} Counts one
  // use of a website feature (History actions, theme switches, Export
  // choice, version-history view, ...). Generic: any feature name is
  // accepted (sanitized to [a-z0-9_-], max 64 chars) — no hardcoded list,
  // so future features are tracked the same way. Email is accepted but
  // NOT stored (counts only). Mirrors /api/public/download: increment,
  // save, await the GitHub flush so the count is locked in and never
  // lost on restart.
  if (req.method === 'POST' && urlPath === '/api/public/feature-usage') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const r = await featureUsageRecord(body && body.feature);
      if (!r) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ feature ត្រឹមត្រូវ' });
      scheduleBackup('feature-usage.json');
      return sendJSON(res, 200, { ok: true, feature: r.feature, total: r.total, today: r.today });
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
  async function loadPkgEvents() {
    const j = await loadKvDoc('package-events', []);
      return Array.isArray(j) ? j : [];
  }
  async function savePkgEvents(arr) {
    await saveKvDoc('package-events', arr, 'package-events.json');
  }
  // POST /api/public/package-event — PUBLIC. {email, packageId, action}
  // email may be 'guest' for visitors who are not signed in.
  if (req.method === 'POST' && urlPath === '/api/public/package-event') {
    readJSONBody(req, 64 * 1024).then(async (body) => {
      const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const email = rawEmail === 'guest' ? 'guest' : normEmail(rawEmail);
      if (!email) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ Gmail ត្រឹមត្រូវ' });
      const packageId = typeof body.packageId === 'string' ? body.packageId.trim().slice(0, 100) : '';
      if (!packageId) return sendJSON(res, 200, { ok: false, error: 'សូមដាក់ packageId' });
      const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';
      if (!PKG_EVENT_ACTIONS.includes(action)) return sendJSON(res, 200, { ok: false, error: 'action មិនត្រឹមត្រូវទេ' });
      const events = await loadPkgEvents();
      events.push({ at: new Date().toISOString(), email, packageId, action });
      if (events.length > PKG_EVENTS_MAX) events.splice(0, events.length - PKG_EVENTS_MAX);
      await savePkgEvents(events);
      return sendJSON(res, 200, { ok: true });
    }).catch(() => sendJSON(res, 400, errBody('bad_request', 'ទិន្នន័យមិនត្រឹមត្រូវទេ', 'Bad request')));
    return;
  }
  // GET /api/admin/package-events?email=&packageId=&action= — admin key
  // required. Newest first, limit 500.
  if (req.method === 'GET' && urlPath === '/api/admin/package-events') {
    const a = await adminKeyOk(req);
    if (!a.ok) return sendJSON(res, 200, { ok: false, error: a.error });
    const q = new URL(req.url, 'http://localhost').searchParams;
    const fEmail = (q.get('email') || '').trim().toLowerCase();
    const fPkg = (q.get('packageId') || '').trim();
    const fAction = (q.get('action') || '').trim().toLowerCase();
    const list = (await loadPkgEvents())
      .filter((e) => e && (!fEmail || e.email === fEmail) && (!fPkg || e.packageId === fPkg) && (!fAction || e.action === fAction))
      .sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')))
      .slice(0, 500);
    return sendJSON(res, 200, { ok: true, events: list });
  }
  return sendJSON(res, 404, errBody('not_found', 'រកមិនឃើញទេ', 'Not found'));
}

/* ------------------------------- static files ------------------------------ */
const server = http.createServer((req, res) => {
  // v2.2.59: count outbound response bytes for the quota display
  // (GET /api/public/quota). Wraps write/end only; arguments pass
  // through unchanged, so streaming and normal responses are unaffected.
  var _qb = 0;
  function _qlen(chunk, enc) {
    if (!chunk) return 0;
    if (Buffer.isBuffer(chunk)) return chunk.length;
    if (typeof chunk === 'string') { try { return Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8'); } catch (e) { return 0; } }
    return 0;
  }
  var _qw = res.write, _qe = res.end;
  res.write = function(chunk, enc, cb) { try { _qb += _qlen(chunk, enc); } catch (e) {} return _qw.apply(res, arguments); };
  res.end = function(chunk, enc, cb) { try { _qb += _qlen(chunk, enc); } catch (e) {} var _r = _qe.apply(res, arguments); try { quotaBytesOut += _qb; } catch (e2) {} return _r; };
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
// ---- Auto-remove broken Public posts (owner order 2026-11-18) ----
// A posted song whose audio URL is dead is removed from Public
// automatically and its owner is notified (in-app + Web Push to the
// owner, Admin bell + Telegram to the admin). A single transient
// error NEVER deletes anything: a definite failure (404/410, 403
// expired, a 200 that is really an HTML error page, a 0-byte file)
// counts double, and removal needs 3 points — two definite
// confirmations, or three failures of any kind — with each URL
// checked at most once per 30 minutes. Runs on the hourly sweep and
// (throttled) whenever the feed is served, so it works while the
// server is awake; Render Free sleeps are fine — the check resumes
// on the next wake. Private posts are never touched, and neither is
// the private DIAG marker (it is not public).
const _brokenUrlCheck = new Map(); // url -> {fails, lastCheckAt, lastStatus}
let _brokenSweepLastAt = 0;
const BROKEN_CHECK_MIN_GAP_MS = 30 * 60 * 1000; // re-check a URL at most every 30 min
const BROKEN_SWEEP_MIN_GAP_MS = 10 * 60 * 1000; // run the sweep at most every 10 min
const BROKEN_CHECK_PER_SWEEP = 20; // bound the work per sweep
const BROKEN_REMOVE_POINTS = 3; // definite failure = 2 points, any other failure = 1
// HEAD a media URL (5s timeout). Returns {verdict, reason} where
// verdict is 'ok' | 'definite' | 'soft'.
async function checkPostMediaUrl(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!/^https?:\/\//i.test(u)) return { verdict: 'soft', reason: 'no-url' };
  const isYoutube = /youtu\.?be/i.test(u);
  const doFetch = async (method, headers) => {
    try {
      const r = await fetch(u, { method, headers: headers || {}, signal: AbortSignal.timeout(5000) });
      return r;
    } catch (e) { return null; }
  };
  const evalResponse = (r) => {
    if (!r) return { verdict: 'soft', reason: 'unreachable' };
    const st = r.status;
    if (st === 404 || st === 410) return { verdict: 'definite', reason: 'not-found-' + st };
    if (st >= 200 && st < 300) {
      // A 200 that is really an HTML error page (an expired signed URL)
      // or a 0-byte file is broken. YouTube links are reachability-only.
      try {
        const ct = String((r.headers && r.headers.get('content-type')) || '').toLowerCase();
        const len = r.headers ? r.headers.get('content-length') : null;
        if (len === '0') return { verdict: 'definite', reason: 'empty-file' };
        if (!isYoutube && ct && ct.indexOf('text/html') === 0) return { verdict: 'definite', reason: 'html-not-media' };
      } catch (e) {}
      return { verdict: 'ok', reason: 'ok-' + st };
    }
    return { verdict: 'soft', reason: 'http-' + st };
  };
  let r = await doFetch('HEAD');
  if (r && (r.status === 405 || r.status === 501)) r = await doFetch('GET', { Range: 'bytes=0-1023' });
  if (r && r.status === 403) {
    // A HEAD-only 403 (hotlink guard) is not proof — confirm with a
    // ranged GET before calling it expired.
    const g = await doFetch('GET', { Range: 'bytes=0-1023' });
    if (g && g.status >= 200 && g.status < 300) return evalResponse(g);
    if (g && (g.status === 403 || g.status === 404 || g.status === 410)) return { verdict: 'definite', reason: 'expired-403' };
    return { verdict: 'soft', reason: 'forbidden-unconfirmed' };
  }
  return evalResponse(r);
}
function brokenReasonText(reason) {
  if (reason.indexOf('not-found') === 0) return { km: 'រក link មិនឃើញ (404)', en: 'link not found (404)' };
  if (reason.indexOf('expired') === 0) return { km: 'link ផុតកំណត់', en: 'link expired' };
  if (reason === 'html-not-media') return { km: 'link មិនមែនជាឯកសារសំឡេង', en: 'link is not a media file' };
  if (reason === 'empty-file') return { km: 'ឯកសារទទេ', en: 'empty file' };
  return { km: 'ភ្ជាប់មិនបាន', en: 'unreachable' };
}
// One sweep: check every public post whose audio URL is due, and
// remove + tombstone + notify the ones proven broken. Returns
// {checked, removed}. Never throws; a failed DB read removes nothing.
async function sweepBrokenPosts() {
  let posts = null;
  try {
    const rows = await sbSelect('public_posts', 'select=id,data');
    if (!rows) return { checked: 0, removed: 0 };
    posts = rows.map((r) => r.data).filter(Boolean);
  } catch (e) { return { checked: 0, removed: 0 }; }
  const now = Date.now();
  let checked = 0;
  const removedIds = [];
  for (const p of posts) {
    if (!p || p.visibility !== 'public' || typeof p.url !== 'string' || !/^https?:\/\//i.test(p.url)) continue;
    const st = _brokenUrlCheck.get(p.url) || { fails: 0, lastCheckAt: 0, lastStatus: '' };
    if (now - (st.lastCheckAt || 0) < BROKEN_CHECK_MIN_GAP_MS && st.lastStatus) continue;
    if (checked >= BROKEN_CHECK_PER_SWEEP) break;
    checked++;
    let res;
    try { res = await checkPostMediaUrl(p.url); } catch (e) { res = { verdict: 'soft', reason: 'error' }; }
    st.lastCheckAt = now;
    st.lastStatus = res.verdict + ':' + res.reason;
    if (res.verdict === 'ok') { st.fails = 0; _brokenUrlCheck.set(p.url, st); continue; }
    st.fails += (res.verdict === 'definite' ? 2 : 1);
    _brokenUrlCheck.set(p.url, st);
    if (st.fails < BROKEN_REMOVE_POINTS) continue;
    // Proven broken: remove the post, tombstone its id so it can never
    // come back, and notify the owner (in-app + push) and the admin
    // (bell + Telegram, via the 'post-removed' kind).
    removedIds.push(p.id);
    _brokenUrlCheck.delete(p.url);
    try { await tombstonePostIdNow(p.id); } catch (e) {}
    try { scheduleBackup('deleted-items.json'); } catch (e) {}
    const rs = brokenReasonText(res.reason);
    try {
      await addNotification('post-removed', p.email || '', 'បទរបស់អ្នកត្រូវបានលុបចេញពី Public · Your song was removed from Public', '«' + (p.title || '') + '» — បទនេះខូច/ស្ដាប់មិនកើត (' + rs.km + ') ទើបត្រូវបានលុបចេញពី Public ដោយស្វ័យប្រវត្តិ · This song was broken/could not be played (' + rs.en + ') so it was automatically removed from Public');
    } catch (e) {}
  }
  // Delete ONLY the removed ids (never a full-list sync here — a
  // concurrent new post must not be wiped by a stale snapshot).
  for (const id of removedIds) {
    try { await sbDelete('public_posts', 'id=eq.' + encodeURIComponent(String(id))); } catch (e) {}
  }
  if (removedIds.length) { try { scheduleBackup('public.json'); } catch (e) {} }
  return { checked, removed: removedIds.length };
}
// Throttled, fire-and-forget trigger (feed serve). The hourly sweep
// calls sweepBrokenPosts() directly.
function maybeSweepBrokenPosts() {
  const now = Date.now();
  if (now - _brokenSweepLastAt < BROKEN_SWEEP_MIN_GAP_MS) return;
  _brokenSweepLastAt = now;
  sweepBrokenPosts().catch(() => {});
}
async function checkPlanExpiries() {
  try {
    const users = await loadUsers();
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
        await addNotification('plan-expired', em, '⏰ កញ្ចប់ផុតកំណត់ · Package expired', (u.name || em) + ' · ' + em + ' · ID: ' + uid + ' — កញ្ចប់ ' + pl.label + ' បានផុតកំណត់ (' + String(pl.exp).slice(0, 10) + ')');
        u[pl.field] = pl.exp;
        u.updatedAt = new Date().toISOString();
        changed = true;
      }
      // Cleanup (low-risk, same rule as featureLimitsFor): once NO
      // package is active any more, leftover MV/VS allowances are
      // lost — zero them so the stored counters match the effective
      // limits. Skipped while either plan is still active. Free 2
      // counters are lifetime and are never touched here.
      if (!hasActivePackage(u) && (featurePkgLeft(u, 'mvLeft') > 0 || featurePkgLeft(u, 'vsLeft') > 0 || u.mvUnlimited || u.vsUnlimited)) {
        u.mvLeft = 0;
        u.vsLeft = 0;
        u.mvUnlimited = false;
        u.vsUnlimited = false;
        u.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) { await saveUsers(users); scheduleBackup('users.json'); }
  } catch (e) {}
}

if (require.main === module) {
  // Supabase is REQUIRED: without its env vars the server cannot serve
  // live data (there is no local-file fallback). Fail loudly at startup.
  if (!sbEnabled()) {
    console.error('[supabase] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — set them in the environment (Render movai-proxy) and restart.');
    process.exit(1);
  }
  // Supabase is the single source of truth — no GitHub restore. The
  // first request heals dead song URLs (see apiRoute top); backup
  // snapshots run on their own timer (scheduleBackup / runBackupSnapshot).
  server.listen(PORT, () => {
    console.log('MovAi Gen live on port ' + PORT);
    // Auto Update Version New: hourly sweep (auto-apply due updates +
    // model check when due) + a first sweep 5 min after startup.
    // Plan-expiry sweep runs on the same schedule: when a bought package
    // reaches its expiry date, notify the Admin once (bell + Telegram).
    setTimeout(() => { autoUpdateSweep(); checkPlanExpiries(); sweepBrokenPosts().catch(() => {}); }, 5 * 60 * 1000);
    setInterval(() => { autoUpdateSweep(); checkPlanExpiries(); sweepBrokenPosts().catch(() => {}); }, 60 * 60 * 1000);
  });
}
module.exports = { server };
