// MSHI Course Selection Simulator server. No dependencies; requires Node 18+.
//
// Env:
//   PORT               default 3000
//   HOST               default 127.0.0.1 (put a reverse proxy in front)
//   FACULTY_PASSWORD   required for faculty sign-in
//   COOKIE_SECURE=1    set when served over HTTPS
//   DATA_DIR           default ./data (base.json + overrides.json)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { clientIp } from './client-ip.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const BASE_FILE = path.join(DATA_DIR, 'base.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.FACULTY_PASSWORD || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_MS = 8 * 60 * 60 * 1000;

const base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'));
let overrides = loadOverrides();

function loadOverrides() {
  try {
    const o = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    return { terms: o.terms || {}, patterns: o.patterns || {}, courses: o.courses || {}, updatedAt: o.updatedAt || null };
  } catch {
    return { terms: {}, patterns: {}, courses: {}, updatedAt: null };
  }
}

function saveOverrides() {
  overrides.updatedAt = new Date().toISOString();
  const tmp = OVERRIDES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(overrides, null, 1));
  fs.renameSync(tmp, OVERRIDES_FILE);
}

// ---------- sessions ----------
const sessions = new Map(); // token -> expiry
const attempts = new Map(); // ip -> [timestamps]

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isFaculty(req) {
  const tok = parseCookies(req).fsid;
  const exp = tok && sessions.get(tok);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(tok); return false; }
  return true;
}

function cookie(value, maxAgeSec) {
  return `fsid=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${COOKIE_SECURE ? '; Secure' : ''}`;
}

function passwordMatches(given) {
  if (!PASSWORD || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}

// ---------- validation ----------
const FORMATS = new Set(['on-ground', 'hybrid', 'online']);
const TERM_RE = /^20\d\d-(SP|SU|FA)$/;
const knownCode = c => typeof c === 'string' && (c in base.courses || c in base.external);

function validTermOfferings(body) {
  if (!body || typeof body.offerings !== 'object' || Array.isArray(body.offerings)) return null;
  const out = {};
  for (const [code, formats] of Object.entries(body.offerings)) {
    if (!(code in base.courses) || !Array.isArray(formats)) return null;
    if (!formats.every(f => FORMATS.has(f))) return null;
    out[code] = [...new Set(formats)].sort();
  }
  return out;
}

// { from: '2027-FA', seasons: { SP: [formats], FA: [formats] } } — seasons left out are not offered.
function validPattern(body) {
  if (!body || !TERM_RE.test(body.from) || typeof body.seasons !== 'object' || Array.isArray(body.seasons)) return null;
  const seasons = {};
  for (const [season, formats] of Object.entries(body.seasons)) {
    if (!['SP', 'SU', 'FA'].includes(season) || !Array.isArray(formats) || !formats.every(f => FORMATS.has(f))) return null;
    if (formats.length) seasons[season] = [...new Set(formats)].sort();
  }
  return { from: body.from, seasons };
}

function validCourseEdit(body) {
  if (!body) return null;
  const credits = Number(body.credits);
  if (!Number.isInteger(credits) || credits < 0 || credits > 12) return null;
  const prereqs = body.prereqs;
  if (!Array.isArray(prereqs) || !prereqs.every(g => Array.isArray(g) && g.length && g.every(knownCode))) return null;
  return { credits, prereqs };
}

// ---------- http helpers ----------
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return reject(new Error('json required'));
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 200_000) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
  });
}

// Mutating requests must come from this origin (SameSite cookies cover most of this; this covers the rest).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const PAGES = { '/': 'index.html', '/faculty': 'faculty.html' };

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- routes ----------
async function handleApi(req, res, pathname) {
  const method = req.method;
  const ip = clientIp(req.headers, req.socket.remoteAddress);

  if (method === 'GET' && pathname === '/api/data') return send(res, 200, { base, overrides });
  if (method === 'GET' && pathname === '/api/session') return send(res, 200, { faculty: isFaculty(req), configured: !!PASSWORD });

  if (method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Bad origin' });

  if (method === 'POST' && pathname === '/api/login') {
    if (!PASSWORD) return send(res, 503, { error: 'Faculty sign-in is not configured on this server.' });
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request' }); }
    if (!passwordMatches(body.password)) {
      attempts.get(ip).push(Date.now());
      return send(res, 401, { error: 'Incorrect password.' });
    }
    const tok = crypto.randomBytes(32).toString('hex');
    sessions.set(tok, Date.now() + SESSION_MS);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(tok, SESSION_MS / 1000) });
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const tok = parseCookies(req).fsid;
    if (tok) sessions.delete(tok);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }

  if (!isFaculty(req)) return send(res, 401, { error: 'Sign in required.' });

  let m;
  if ((m = pathname.match(/^\/api\/terms\/([^/]+)$/)) && TERM_RE.test(m[1])) {
    const term = m[1];
    if (method === 'DELETE') {
      delete overrides.terms[term];
      saveOverrides();
      return send(res, 200, { overrides });
    }
    if (method === 'PUT') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request' }); }
      const offerings = validTermOfferings(body);
      if (!offerings) return send(res, 400, { error: 'Invalid offerings.' });
      if (Object.keys(offerings).length) overrides.terms[term] = offerings;
      else delete overrides.terms[term];
      saveOverrides();
      return send(res, 200, { overrides });
    }
  }

  if ((m = pathname.match(/^\/api\/patterns\/([A-Z]{2,4}%20\d{4}|[A-Z]{2,4} \d{4})$/))) {
    const code = decodeURIComponent(m[1]);
    if (!(code in base.courses)) return send(res, 404, { error: 'Unknown course.' });
    if (method === 'DELETE') {
      delete overrides.patterns[code];
      saveOverrides();
      return send(res, 200, { overrides });
    }
    if (method === 'PUT') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request' }); }
      const pattern = validPattern(body);
      if (!pattern) return send(res, 400, { error: 'Invalid schedule.' });
      overrides.patterns[code] = pattern;
      saveOverrides();
      return send(res, 200, { overrides });
    }
  }

  if ((m = pathname.match(/^\/api\/courses\/([A-Z]{2,4}%20\d{4}|[A-Z]{2,4} \d{4})$/))) {
    const code = decodeURIComponent(m[1]);
    if (!(code in base.courses)) return send(res, 404, { error: 'Unknown course.' });
    if (method === 'DELETE') {
      delete overrides.courses[code];
      saveOverrides();
      return send(res, 200, { overrides });
    }
    if (method === 'PUT') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request' }); }
      const edit = validCourseEdit(body);
      if (!edit) return send(res, 400, { error: 'Invalid course settings.' });
      overrides.courses[code] = edit;
      saveOverrides();
      return send(res, 200, { overrides });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MSHI simulator on http://${HOST}:${PORT}`);
  if (!PASSWORD) console.warn('FACULTY_PASSWORD is not set; faculty sign-in is disabled.');
});
