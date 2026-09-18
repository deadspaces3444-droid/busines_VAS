const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, '.data');
const UPLOAD_DIR = path.join(ROOT, '.uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============================================================
// Хеширование пароля (scrypt, встроенный в crypto)
// ============================================================
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

// ============================================================
// База данных (JSON-файл, атомарная запись)
// ============================================================
function defaultDb() {
  return {
    adminPasswordHash: null,
    polls: {}
  };
}

function loadDb() {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    db = defaultDb();
  }
  if (!db || typeof db !== 'object') db = defaultDb();
  if (typeof db.polls !== 'object' || db.polls === null) db.polls = {};
  if (typeof db.adminPasswordHash !== 'string') db.adminPasswordHash = null;

  // миграция: votes должен быть массивом записей
  Object.keys(db.polls).forEach(t => {
    const p = db.polls[t];
    if (!Array.isArray(p.votes)) p.votes = [];
    if (!Array.isArray(p.options)) p.options = [];
  });
  return db;
}

function saveDb(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// Первый запуск: задаём начальный пароль, если хеша ещё нет
(function ensureInitialPassword() {
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    db.adminPasswordHash = hashPassword(INITIAL_ADMIN_PASSWORD);
    saveDb(db);
    console.log('Инициализирована база, пароль администратора: ' + INITIAL_ADMIN_PASSWORD);
    return;
  }
  const db = loadDb();
  if (!db.adminPasswordHash) {
    db.adminPasswordHash = hashPassword(INITIAL_ADMIN_PASSWORD);
    saveDb(db);
    console.log('Установлен начальный пароль администратора: ' + INITIAL_ADMIN_PASSWORD);
  }
})();

// ============================================================
// SSRF-защита и парсинг ссылок
// ============================================================
function isPrivateHost(host) {
  host = String(host || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^0\./.test(host)) return true;
  return false;
}

function fetchHtml(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Неверный URL')); }
    if (!/^https?:$/.test(parsed.protocol)) return reject(new Error('Только http/https'));
    if (isPrivateHost(parsed.hostname)) return reject(new Error('Недопустимый адрес'));

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SurveyBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8'
      }
    }, resp => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        if (!redirectsLeft) return reject(new Error('Слишком много редиректов'));
        let next;
        try { next = new URL(resp.headers.location, url).toString(); }
        catch { return reject(new Error('Некорректный редирект')); }
        return resolve(fetchHtml(next, redirectsLeft - 1));
      }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('HTTP ' + resp.statusCode)); }
      const ctype = resp.headers['content-type'] || '';
      if (ctype && !/html|xml/i.test(ctype)) { resp.resume(); return reject(new Error('Не HTML')); }
      let data = '', size = 0;
      const MAX = 2 * 1024 * 1024;
      resp.setEncoding('utf-8');
      resp.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > MAX) { req.destroy(); reject(new Error('Страница слишком большая')); return; }
        data += chunk;
      });
      resp.on('end', () => resolve({ html: data, baseUrl: url }));
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут')));
    req.on('error', reject);
  });
}

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function getMeta(html, prop) {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + p + '["\'][^>]*?content=["\']([^"\']*)["\']', 'i');
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*?(?:property|name)=["\']' + p + '["\']', 'i');
  let m = html.match(re1); if (m) return decodeEntities(m[1]);
  m = html.match(re2); if (m) return decodeEntities(m[1]);
  return null;
}
function absoluteUrl(u, base) { try { return new URL(u, base).toString(); } catch { return null; } }

function parseMeta(html, baseUrl) {
  let title = getMeta(html, 'og:title') || getMeta(html, 'twitter:title') ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  title = title ? decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 200) : '';

  let desc = getMeta(html, 'og:description') || getMeta(html, 'twitter:description') || getMeta(html, 'description');
  desc = desc ? decodeEntities(desc).replace(/\s+/g, ' ').trim().slice(0, 1000) : '';

  let img = getMeta(html, 'og:image:secure_url') || getMeta(html, 'og:image:url') ||
    getMeta(html, 'og:image') || getMeta(html, 'twitter:image') || getMeta(html, 'twitter:image:src');
  if (!img) {
    const m = html.match(/<img[^>]+src=["\']([^"\']+)["\']/i);
    if (m) img = decodeEntities(m[1]);
  }
  return { title, description: desc, image: absoluteUrl(img, baseUrl) };
}

// ============================================================
// Multer (загрузка картинок)
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});
const upload = multer({
  storage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Только изображения'))
});

// ============================================================
// Middleware
// ============================================================
app.use(express.json({ limit: '2mb' }));
app.use('/api/uploads', express.static(UPLOAD_DIR));
app.use(express.static(ROOT, { dotfiles: 'ignore', index: 'index.html' }));

function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.password;
  if (!pass) return res.status(401).json({ error: 'Требуется пароль' });
  const db = loadDb();
  if (!verifyPassword(pass, db.adminPasswordHash)) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  next();
}

function normalizeName(n) {
  return String(n || '').trim().replace(/\s+/g, ' ').slice(0, 100);
}

// ============================================================
// Ping (для определения режима клиентом)
// ============================================================
app.get('/api/ping', (req, res) => res.json({ ok: true, server: 'beeline-surveys' }));

// ============================================================
// Проверка пароля (для входа админа)
// ============================================================
app.post('/api/admin/login', (req, res) => {
  const pass = req.body && req.body.password;
  if (!pass) return res.status(400).json({ error: 'Пароль обязателен' });
  const db = loadDb();
  if (!verifyPassword(pass, db.adminPasswordHash)) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  res.json({ ok: true });
});

// ============================================================
// Смена пароля администратора
// ============================================================
app.post('/api/admin/change-password', adminAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Укажите текущий и новый пароль' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });
  }
  const db = loadDb();
  if (!verifyPassword(currentPassword, db.adminPasswordHash)) {
    return res.status(401).json({ error: 'Текущий пароль неверен' });
  }
  db.adminPasswordHash = hashPassword(newPassword);
  saveDb(db);
  res.json({ ok: true });
});

// ============================================================
// Загрузка картинок
// ============================================================
app.post('/api/admin/upload', adminAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: 'api/uploads/' + req.file.filename });
});

// ============================================================
// Парсинг ссылки
// ============================================================
app.post('/api/admin/fetch-link', adminAuth, (req, res) => {
  const url = (req.body && req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  fetchHtml(url, 5)
    .then(r => res.json(parseMeta(r.html, r.baseUrl)))
    .catch(err => res.status(400).json({ error: err.message || 'Не удалось загрузить' }));
});

// ============================================================
// CRUD опросов
// ============================================================
app.post('/api/admin/polls', adminAuth, (req, res) => {
  const { title, description, options } = req.body;
  if (!title || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'Нужны название и минимум 2 варианта' });
  }
  const token = crypto.randomBytes(6).toString('hex');
  const db = loadDb();
  db.polls[token] = {
    token,
    title: String(title).slice(0, 200),
    description: String(description || '').slice(0, 2000),
    options: options.map((o, i) => ({
      id: 'opt_' + i,
      title: String(o.title || '').slice(0, 200),
      description: String(o.description || '').slice(0, 1000),
      budget: Number(o.budget) || 0,
      image: o.image || null,
      sourceUrl: o.sourceUrl || null
    })),
    votes: [],
    createdAt: new Date().toISOString(),
    isOpen: true
  };
  saveDb(db);
  res.json({ token });
});

app.get('/api/admin/polls', adminAuth, (req, res) => {
  const db = loadDb();
  res.json(Object.values(db.polls).map(p => ({
    token: p.token,
    title: p.title,
    createdAt: p.createdAt,
    isOpen: p.isOpen,
    totalVotes: (p.votes || []).length
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.delete('/api/admin/polls/:token', adminAuth, (req, res) => {
  const db = loadDb();
  if (!db.polls[req.params.token]) return res.status(404).json({ error: 'Не найдено' });
  delete db.polls[req.params.token];
  saveDb(db);
  res.json({ ok: true });
});

app.patch('/api/admin/polls/:token', adminAuth, (req, res) => {
  const db = loadDb();
  const poll = db.polls[req.params.token];
  if (!poll) return res.status(404).json({ error: 'Не найдено' });
  if (typeof req.body.isOpen === 'boolean') poll.isOpen = req.body.isOpen;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/polls/:token/reset', adminAuth, (req, res) => {
  const db = loadDb();
  const poll = db.polls[req.params.token];
  if (!poll) return res.status(404).json({ error: 'Не найдено' });
  poll.votes = [];
  saveDb(db);
  res.json({ ok: true });
});

// ============================================================
// Публичное: опрос и голосование
// ============================================================
app.get('/api/polls/:token', (req, res) => {
  const db = loadDb();
  const poll = db.polls[req.params.token];
  if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
  res.json({
    token: poll.token,
    title: poll.title,
    description: poll.description,
    options: poll.options,
    isOpen: poll.isOpen,
    totalVotes: (poll.votes || []).length
  });
});

app.post('/api/polls/:token/vote', (req, res) => {
  const db = loadDb();
  const poll = db.polls[req.params.token];
  if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
  if (!poll.isOpen) return res.status(403).json({ error: 'Опрос закрыт' });

  const { optionId } = req.body || {};
  const name = normalizeName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Укажите фамилию' });
  if (!poll.options.some(o => o.id === optionId)) {
    return res.status(400).json({ error: 'Неверный вариант' });
  }
  if (!Array.isArray(poll.votes)) poll.votes = [];

  const lower = name.toLowerCase();
  if (poll.votes.some(v => String(v.name || '').toLowerCase() === lower)) {
    return res.status(409).json({ error: 'Эта фамилия уже голосовала' });
  }

  poll.votes.push({ name, optionId, at: new Date().toISOString() });
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/polls/:token/results', (req, res) => {
  const db = loadDb();
  const poll = db.polls[req.params.token];
  if (!poll) return res.status(404).json({ error: 'Опрос не найден' });

  const votes = Array.isArray(poll.votes) ? poll.votes : [];
  const totalVotes = votes.length;

  const results = poll.options.map(o => {
    const optVotes = votes.filter(v => v.optionId === o.id);
    const cnt = optVotes.length;
    return Object.assign({}, o, {
      votes: cnt,
      perPerson: cnt > 0 ? Math.round(o.budget / cnt) : 0,
      voters: optVotes.map(v => v.name)
    });
  }).sort((a, b) => b.votes - a.votes);

  const winner = results[0] && results[0].votes > 0 ? results[0] : null;

  res.json({
    title: poll.title,
    description: poll.description,
    totalVotes,
    results,
    winner,
    isOpen: poll.isOpen
  });
});

app.listen(PORT, () => {
  console.log('Сервер запущен: http://localhost:' + PORT);
  console.log('Данные: ' + DATA_DIR);
  console.log('Загрузки: ' + UPLOAD_DIR);
});
