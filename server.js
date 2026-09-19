const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const ROOT = __dirname;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Не заданы SUPABASE_URL и SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const DB_ROW_ID = 'main';
const STORAGE_BUCKET = 'images';

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
  } catch (e) { return false; }
}

function defaultDb() {
  return { adminPasswordHash: null, polls: {}, memories: {} };
}

function normalizeDb(db) {
  if (!db || typeof db !== 'object') db = defaultDb();
  if (typeof db.polls !== 'object' || db.polls === null) db.polls = {};
  if (typeof db.memories !== 'object' || db.memories === null) db.memories = {};
  if (typeof db.adminPasswordHash !== 'string') db.adminPasswordHash = null;
  Object.keys(db.polls).forEach(t => {
    const p = db.polls[t];
    if (!Array.isArray(p.votes)) p.votes = [];
    if (!Array.isArray(p.options)) p.options = [];
    if (!Array.isArray(p.groups)) p.groups = [];
    if (!Array.isArray(p.declinedVotes)) p.declinedVotes = [];
  });
  return db;
}

async function loadDb() {
  const { data, error } = await supabase
    .from('app_db')
    .select('data')
    .eq('id', DB_ROW_ID)
    .maybeSingle();

  if (error) {
    console.error('❌ Ошибка чтения из Supabase:', error.message);
    throw new Error('Не удалось прочитать данные');
  }
  if (!data || !data.data) return defaultDb();
  return normalizeDb(data.data);
}

async function saveDb(db) {
  const { error } = await supabase
    .from('app_db')
    .upsert(
      { id: DB_ROW_ID, data: db, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );

  if (error) {
    console.error('❌ Ошибка записи в Supabase:', error.message);
    throw new Error('Не удалось сохранить данные');
  }
  console.log('💾 База сохранена');
}

(async function ensureInitialPassword() {
  try {
    const db = await loadDb();
    if (!db.adminPasswordHash) {
      db.adminPasswordHash = hashPassword(INITIAL_ADMIN_PASSWORD);
      await saveDb(db);
      console.log('✅ Установлен начальный пароль: ' + INITIAL_ADMIN_PASSWORD);
    } else {
      console.log('✅ База загружена');
    }
  } catch (err) {
    console.error('❌ Не удалось инициализировать базу:', err.message);
  }
})();

function getPhase(poll) {
  if (!poll.isOpen) return 'closed';
  const now = Date.now();
  const sEnd = poll.suggestEndsAt ? new Date(poll.suggestEndsAt).getTime() : null;
  const vEnd = poll.voteEndsAt ? new Date(poll.voteEndsAt).getTime() : null;
  if (sEnd && now < sEnd) return 'suggest';
  if (vEnd && now >= vEnd) return 'closed';
  return 'vote';
}

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

function absoluteUrl(u, base) {
  try { return new URL(u, base).toString(); } catch { return null; }
}

function collectAllImages(html, baseUrl) {
  const found = new Map();
  function push(url, w, h, source) {
    const abs = absoluteUrl(url, baseUrl);
    if (!abs) return;
    if (!/^https?:/i.test(abs)) return;
    if (abs.startsWith('data:')) return;
    if (/\.svg(\?|$)/i.test(abs)) return;
    if (found.has(abs)) {
      const cur = found.get(abs);
      if (!cur.width && w) cur.width = w;
      if (!cur.height && h) cur.height = h;
      return;
    }
    found.set(abs, { url: abs, width: w || 0, height: h || 0, size: 0, source: source || 'img' });
  }
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const attrs = m[1];
    const src = (attrs.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    const srcset = (attrs.match(/\bsrcset=["']([^"']+)["']/i) || [])[1];
    const width = Number((attrs.match(/\bwidth=["']?(\d+)/i) || [])[1]) || 0;
    const height = Number((attrs.match(/\bheight=["']?(\d+)/i) || [])[1]) || 0;
    if (src) push(decodeEntities(src), width, height, 'img');
    if (srcset) {
      const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
      let best = null;
      parts.forEach(p => {
        const [u, d] = p.split(/\s+/);
        const w = d && /(\d+)w/.test(d) ? Number(d.match(/(\d+)w/)[1]) : 0;
        if (!best || w > best.w) best = { u, w };
      });
      if (best && best.u) push(decodeEntities(best.u), best.w, 0, 'srcset');
    }
    const lazy = (attrs.match(/\bdata-(?:src|original|lazy-src)=["']([^"']+)["']/i) || [])[1];
    if (lazy && /^https?:|^\//.test(lazy)) push(decodeEntities(lazy), width, height, 'lazy');
  }
  const sourceRe = /<source\b([^>]*)>/gi;
  while ((m = sourceRe.exec(html)) !== null) {
    const attrs = m[1];
    const srcset = (attrs.match(/\bsrcset=["']([^"']+)["']/i) || [])[1];
    if (!srcset) continue;
    const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
    let best = null;
    parts.forEach(p => {
      const [u, d] = p.split(/\s+/);
      const w = d && /(\d+)w/.test(d) ? Number(d.match(/(\d+)w/)[1]) : 0;
      if (!best || w > best.w) best = { u, w };
    });
    if (best && best.u) push(decodeEntities(best.u), best.w, 0, 'source');
  }
  const list = [...found.values()];
  list.sort((a, b) => {
    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    if (areaA && areaB) return areaB - areaA;
    if (areaA && !areaB) return -1;
    if (!areaA && areaB) return 1;
    return 0;
  });
  return list.slice(0, 30);
}

function parseMeta(html, baseUrl) {
  let title = getMeta(html, 'og:title') || getMeta(html, 'twitter:title') ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  title = title ? decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  let desc = getMeta(html, 'og:description') || getMeta(html, 'twitter:description') || getMeta(html, 'description');
  desc = desc ? decodeEntities(desc).replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
  let mainImg = getMeta(html, 'og:image:secure_url') || getMeta(html, 'og:image:url') ||
    getMeta(html, 'og:image') || getMeta(html, 'twitter:image') || getMeta(html, 'twitter:image:src');
  mainImg = absoluteUrl(mainImg, baseUrl);
  const allImages = collectAllImages(html, baseUrl);
  if (mainImg && !allImages.some(x => x.url === mainImg)) {
    allImages.unshift({ url: mainImg, size: 0, width: 0, height: 0, source: 'og' });
  }
  return {
    title,
    description: desc,
    image: mainImg || (allImages[0] ? allImages[0].url : null),
    images: allImages
  };
}

function extractFilenameFromUrl(url) {
  if (!url) return null;
  const marker = '/storage/v1/object/public/' + STORAGE_BUCKET + '/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.substring(idx + marker.length));
}

function collectUsedImages(db) {
  const used = new Set();
  Object.values(db.polls || {}).forEach(p => {
    (p.options || []).forEach(o => {
      const fn = extractFilenameFromUrl(o.image);
      if (fn) used.add(fn);
    });
  });
  Object.values(db.memories || {}).forEach(m => {
    const fn = extractFilenameFromUrl(m.cover);
    if (fn) used.add(fn);
  });
  return used;
}

async function removeImagesFromStorage(filenames) {
  if (!filenames || !filenames.length) return 0;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(filenames);
  if (error) return 0;
  return filenames.length;
}

async function listAllImages() {
  const all = [];
  const pageSize = 100;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list('', { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) break;
    if (!data || !data.length) break;
    data.forEach(f => all.push({ name: f.name, size: Number((f.metadata && f.metadata.size) || 0) }));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Только изображения'))
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(ROOT, { dotfiles: 'ignore', index: 'index.html' }));

async function adminAuth(req, res, next) {
  try {
    const pass = req.headers['x-admin-password'] || req.query.password;
    if (!pass) return res.status(401).json({ error: 'Требуется пароль' });
    const db = await loadDb();
    if (!verifyPassword(pass, db.adminPasswordHash)) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function normalizeName(n) {
  return String(n || '').trim().replace(/\s+/g, ' ').slice(0, 100);
}

app.get('/api/ping', (req, res) => res.json({ ok: true, server: 'beeline-surveys', storage: 'supabase' }));

app.post('/api/admin/login', async (req, res) => {
  try {
    const pass = req.body && req.body.password;
    if (!pass) return res.status(400).json({ error: 'Пароль обязателен' });
    const db = await loadDb();
    if (!verifyPassword(pass, db.adminPasswordHash)) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/change-password', adminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Укажите текущий и новый пароль' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Новый пароль не короче 6 символов' });
    }
    const db = await loadDb();
    if (!verifyPassword(currentPassword, db.adminPasswordHash)) {
      return res.status(401).json({ error: 'Текущий пароль неверен' });
    }
    db.adminPasswordHash = hashPassword(newPassword);
    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/upload', adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
    const filename = crypto.randomBytes(16).toString('hex') + ext;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) return res.status(500).json({ error: 'Не удалось загрузить картинку' });
    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filename);
    res.json({ url: urlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/fetch-link', adminAuth, (req, res) => {
  const url = (req.body && req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  fetchHtml(url, 5)
    .then(r => res.json(parseMeta(r.html, r.baseUrl)))
    .catch(err => res.status(400).json({ error: err.message || 'Не удалось загрузить' }));
});

app.post('/api/admin/fetch-album-preview', adminAuth, (req, res) => {
  const url = (req.body && req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  fetchHtml(url, 5)
    .then(r => {
      const meta = parseMeta(r.html, r.baseUrl);
      res.json({ title: meta.title, description: meta.description, image: meta.image, images: meta.images || [] });
    })
    .catch(err => res.status(400).json({ error: err.message || 'Не удалось получить превью' }));
});

app.post('/api/admin/polls', adminAuth, async (req, res) => {
  try {
    const { title, description, options } = req.body;
    if (!title || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ error: 'Нужны название и минимум 2 варианта' });
    }
    const token = crypto.randomBytes(6).toString('hex');
    const db = await loadDb();
    const groups = Array.isArray(req.body.groups)
      ? req.body.groups.map(g => String(g || '').trim().slice(0, 100)).filter(Boolean)
      : [];
    const suggestHours = Math.max(0, Number(req.body.suggestHours) || 0);
    const voteDays = Math.max(0, Number(req.body.voteDays) || 0);
    const now = Date.now();
    const suggestEndsAt = suggestHours > 0 ? new Date(now + suggestHours * 3600 * 1000).toISOString() : null;
    const voteEndsAt = voteDays > 0 ? new Date(now + (suggestHours * 3600 + voteDays * 86400) * 1000).toISOString() : null;

    db.polls[token] = {
      token,
      title: String(title).slice(0, 200),
      description: String(description || '').slice(0, 2000),
      askGroup: req.body.askGroup !== false,
      groups,
      suggestHours,
      voteDays,
      suggestEndsAt,
      voteEndsAt,
      options: options.map((o, i) => ({
        id: 'opt_' + i,
        title: String(o.title || '').slice(0, 200),
        description: String(o.description || '').slice(0, 1000),
        type: o.type === 'check' ? 'check' : 'deposit',
        budget: Number(o.budget) || 0,
        image: o.image || null,
        sourceUrl: o.sourceUrl || null
      })),
      votes: [],
      declinedVotes: [],
      createdAt: new Date().toISOString(),
      isOpen: true
    };
    await saveDb(db);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/polls', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    res.json(Object.values(db.polls).map(p => ({
      token: p.token,
      title: p.title,
      description: p.description,
      createdAt: p.createdAt,
      isOpen: p.isOpen,
      phase: getPhase(p),
      suggestEndsAt: p.suggestEndsAt || null,
      voteEndsAt: p.voteEndsAt || null,
      totalVotes: (p.votes || []).reduce((s, v) => s + (typeof v.weight === 'number' ? v.weight : (v.plusOne ? 2 : 1)), 0),
      optionsCount: (p.options || []).filter(o => !o.pending).length,
      pendingCount: (p.options || []).filter(o => o.pending).length
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/polls/:token', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });

    const { title, description, options, isOpen } = req.body;
    if (title !== undefined) poll.title = String(title).slice(0, 200);
    if (description !== undefined) poll.description = String(description || '').slice(0, 2000);
    if (typeof isOpen === 'boolean') poll.isOpen = isOpen;
    if (typeof req.body.askGroup === 'boolean') poll.askGroup = req.body.askGroup;

    if (Array.isArray(req.body.groups)) {
      poll.groups = req.body.groups.map(g => String(g || '').trim().slice(0, 100)).filter(Boolean);
    }

    if (req.body.suggestHours !== undefined || req.body.voteDays !== undefined) {
      const sh = Math.max(0, Number(req.body.suggestHours ?? poll.suggestHours ?? 0) || 0);
      const vd = Math.max(0, Number(req.body.voteDays ?? poll.voteDays ?? 0) || 0);
      poll.suggestHours = sh;
      poll.voteDays = vd;
      const base = poll.createdAt ? new Date(poll.createdAt).getTime() : Date.now();
      poll.suggestEndsAt = sh > 0 ? new Date(base + sh * 3600 * 1000).toISOString() : null;
      poll.voteEndsAt = vd > 0 ? new Date(base + (sh * 3600 + vd * 86400) * 1000).toISOString() : null;
    }

    if (Array.isArray(options) && options.length >= 2) {
      const oldOptions = poll.options || [];
      poll.options = options.map((o, i) => {
        const old = oldOptions.find(x => x.id === o.id) || oldOptions[i];
        return {
          id: (old && old.id) || ('opt_' + i),
          title: String(o.title || '').slice(0, 200),
          description: String(o.description || '').slice(0, 1000),
          type: o.type === 'check' ? 'check' : 'deposit',
          budget: Number(o.budget) || 0,
          image: o.image || null,
          sourceUrl: o.sourceUrl || null
        };
      });
      const validIds = new Set(poll.options.map(o => o.id));
      poll.votes = (poll.votes || []).filter(v => validIds.has(v.optionId));
    }

    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/polls/:token', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    if (typeof req.body.isOpen === 'boolean') poll.isOpen = req.body.isOpen;
    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/polls/:token', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Не найдено' });
    const pollImages = new Set();
    (poll.options || []).forEach(o => {
      const fn = extractFilenameFromUrl(o.image);
      if (fn) pollImages.add(fn);
    });
    delete db.polls[req.params.token];
    const stillUsed = collectUsedImages(db);
    const orphans = [...pollImages].filter(fn => !stillUsed.has(fn));
    await saveDb(db);
    const removed = await removeImagesFromStorage(orphans);
    res.json({ ok: true, removedImages: removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/polls/:token/votes', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    const votes = (poll.votes || []).map((v, idx) => {
      const opt = (poll.options || []).find(o => o.id === v.optionId);
      return {
        index: idx,
        name: v.name,
        group: v.group || '',
        plusOne: !!v.plusOne,
        label: (v.name + (v.group ? ' · ' + v.group : '') + (v.plusOne ? ' +1' : '')),
        weight: typeof v.weight === 'number' ? v.weight : (v.plusOne ? 2 : 1),
        optionId: v.optionId,
        optionTitle: opt ? opt.title : '(удалено)',
        at: v.at,
        addedByAdmin: !!v.addedByAdmin
      };
    });
    res.json({ votes, options: poll.options });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/polls/:token/votes', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    const name = normalizeName(req.body && req.body.name);
    const group = normalizeName(req.body && req.body.group);
    const optionId = req.body && req.body.optionId;
    const plusOne = !!(req.body && req.body.plusOne);
    if (!name) return res.status(400).json({ error: 'Укажите фамилию' });
    if (!optionId) return res.status(400).json({ error: 'Выберите вариант' });
    if (!poll.options.some(o => o.id === optionId)) {
      return res.status(400).json({ error: 'Такого варианта нет' });
    }
    if (poll.askGroup !== false) {
      const available = Array.isArray(poll.groups) ? poll.groups : [];
      if (!group) return res.status(400).json({ error: 'Выберите группу' });
      if (available.length && !available.includes(group)) {
        return res.status(400).json({ error: 'Такой группы нет' });
      }
    }
    if (!Array.isArray(poll.votes)) poll.votes = [];
    const lower = name.toLowerCase();
    if (poll.votes.some(v => String(v.name || '').toLowerCase() === lower)) {
      return res.status(409).json({ error: 'Эта фамилия уже голосовала' });
    }
    poll.votes.push({
      name, group: group || '', optionId, plusOne,
      weight: plusOne ? 2 : 1,
      at: new Date().toISOString(),
      addedByAdmin: true
    });
    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/polls/:token/votes/:name', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    const target = decodeURIComponent(req.params.name).toLowerCase();
    const idx = (poll.votes || []).findIndex(v => String(v.name || '').toLowerCase() === target);
    if (idx === -1) return res.status(404).json({ error: 'Голос не найден' });
    const removed = poll.votes[idx];
    if (!Array.isArray(poll.declinedVotes)) poll.declinedVotes = [];
    poll.declinedVotes.push({
      name: removed.name,
      group: removed.group || '',
      optionId: removed.optionId,
      plusOne: !!removed.plusOne,
      weight: typeof removed.weight === 'number' ? removed.weight : (removed.plusOne ? 2 : 1),
      votedAt: removed.at || null,
      declinedAt: new Date().toISOString(),
      reason: (req.body && req.body.reason) || 'отказ'
    });
    poll.votes.splice(idx, 1);
    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/polls/:token/reset', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Не найдено' });
    poll.votes = [];
    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/polls/:token/declines', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    res.json((poll.declinedVotes || []).slice().reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/polls/:token/suggest', async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    const phase = getPhase(poll);
    if (phase !== 'suggest') {
      return res.status(403).json({ error: phase === 'vote' ? 'Приём предложений завершён' : 'Опрос закрыт' });
    }
    const title = String((req.body && req.body.title) || '').trim().slice(0, 200);
    const description = String((req.body && req.body.description) || '').trim().slice(0, 1000);
    const budget = Number((req.body && req.body.budget) || 0) || 0;
    const sourceUrl = String((req.body && req.body.sourceUrl) || '').trim().slice(0, 1000);
    const image = String((req.body && req.body.image) || '').trim().slice(0, 1000);
    const author = normalizeName((req.body && req.body.author) || '');
    const type = (req.body && req.body.type) === 'check' ? 'check' : 'deposit';
    if (!title) return res.status(400).json({ error: 'Укажите название' });
    if (!sourceUrl) return res.status(400).json({ error: 'Укажите ссылку' });
    if (!Array.isArray(poll.options)) poll.options = [];
    const id = 'opt_' + crypto.randomBytes(4).toString('hex');
    poll.options.push({
      id, title, description, type, budget,
      image: image || null,
      sourceUrl,
      pending: true,
      suggestedBy: author || 'Сотрудник',
      suggestedAt: new Date().toISOString()
    });
    await saveDb(db);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/polls/:token/suggestions', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    res.json((poll.options || []).filter(o => o.pending));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/polls/:token/suggestions/:id/approve', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    const opt = (poll.options || []).find(o => o.id === req.params.id);
    if (!opt) return res.status(404).json({ error: 'Не найдено' });
    delete opt.pending;
    delete opt.suggestedBy;
    delete opt.suggestedAt;
    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/polls/:token/suggestions/:id', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    const idx = (poll.options || []).findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
    const opt = poll.options[idx];
    const imageFn = extractFilenameFromUrl(opt.image);
    poll.options.splice(idx, 1);
    poll.votes = (poll.votes || []).filter(v => v.optionId !== req.params.id);
    await saveDb(db);
    if (imageFn) {
      const stillUsed = collectUsedImages(db);
      if (!stillUsed.has(imageFn)) await removeImagesFromStorage([imageFn]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/polls/:token', async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    const pollDefaultType = poll.type === 'check' ? 'check' : 'deposit';
    const phase = getPhase(poll);
    res.json({
      token: poll.token,
      title: poll.title,
      description: poll.description,
      options: (poll.options || []).filter(o => !o.pending).map(o => ({
        ...o,
        type: o.type === 'check' ? 'check' : (o.type === 'deposit' ? 'deposit' : pollDefaultType)
      })),
      isOpen: poll.isOpen,
      phase,
      suggestEndsAt: poll.suggestEndsAt || null,
      voteEndsAt: poll.voteEndsAt || null,
      serverNow: new Date().toISOString(),
      askGroup: poll.askGroup !== false,
      groups: Array.isArray(poll.groups) ? poll.groups : [],
      totalVotes: (poll.votes || []).reduce((s, v) => s + (typeof v.weight === 'number' ? v.weight : (v.plusOne ? 2 : 1)), 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/polls/:token/vote', async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    const phase = getPhase(poll);
    if (phase === 'suggest') return res.status(403).json({ error: 'Голосование ещё не открыто' });
    if (phase === 'closed') return res.status(403).json({ error: 'Опрос закрыт' });

    const { optionId } = req.body || {};
    const name = normalizeName(req.body && req.body.name);
    const group = normalizeName(req.body && req.body.group);
    const plusOne = !!(req.body && req.body.plusOne);

    if (!name) return res.status(400).json({ error: 'Укажите фамилию' });
    if (poll.askGroup !== false) {
      const available = Array.isArray(poll.groups) ? poll.groups : [];
      if (!group) return res.status(400).json({ error: 'Выберите группу' });
      if (available.length && !available.includes(group)) {
        return res.status(400).json({ error: 'Такой группы нет' });
      }
    }
    if (!poll.options.some(o => o.id === optionId)) {
      return res.status(400).json({ error: 'Неверный вариант' });
    }
    if (!Array.isArray(poll.votes)) poll.votes = [];
    const lower = name.toLowerCase();
    if (poll.votes.some(v => String(v.name || '').toLowerCase() === lower)) {
      return res.status(409).json({ error: 'Эта фамилия уже голосовала' });
    }
    poll.votes.push({
      name, group: group || '', optionId, plusOne,
      weight: plusOne ? 2 : 1,
      at: new Date().toISOString()
    });
    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/polls/:token/results', async (req, res) => {
  try {
    const db = await loadDb();
    const poll = db.polls[req.params.token];
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });

    const votes = Array.isArray(poll.votes) ? poll.votes : [];
    function weightOf(v) {
      if (typeof v.weight === 'number' && v.weight > 0) return v.weight;
      return v.plusOne ? 2 : 1;
    }
    const totalPeople = votes.reduce((s, v) => s + weightOf(v), 0);
    const totalRecords = votes.length;
    const pollDefaultType = poll.type === 'check' ? 'check' : 'deposit';

    const results = poll.options.filter(o => !o.pending).map(o => {
      const optVotes = votes.filter(v => v.optionId === o.id);
      const people = optVotes.reduce((s, v) => s + weightOf(v), 0);
      const optType = o.type === 'check' ? 'check' : (o.type === 'deposit' ? 'deposit' : pollDefaultType);
      let perPerson = 0, total = 0;
      if (optType === 'check') {
        perPerson = Number(o.budget) || 0;
        total = people * perPerson;
      } else {
        total = Number(o.budget) || 0;
        perPerson = people > 0 ? Math.round(total / people) : 0;
      }
      return Object.assign({}, o, {
        type: optType,
        votes: people,
        records: optVotes.length,
        perPerson,
        total,
        voters: optVotes.map(v => ({
          name: v.name,
          group: v.group || '',
          plusOne: !!v.plusOne,
          weight: weightOf(v),
          label: (v.name + (v.group ? ' · ' + v.group : '') + (v.plusOne ? ' +1' : ''))
        }))
      });
    }).sort((a, b) => b.votes - a.votes);

    const winner = results[0] && results[0].votes > 0 ? results[0] : null;

    const groupStats = {};
    votes.forEach(v => {
      const g = v.group || 'Без группы';
      const w = weightOf(v);
      if (!groupStats[g]) groupStats[g] = { group: g, people: 0, records: 0 };
      groupStats[g].people += w;
      groupStats[g].records += 1;
    });
    const groups = Object.values(groupStats).sort((a, b) => b.people - a.people);

    res.json({
      title: poll.title,
      description: poll.description,
      totalVotes: totalPeople,
      totalRecords,
      results,
      winner,
      isOpen: poll.isOpen,
      phase: getPhase(poll),
      suggestEndsAt: poll.suggestEndsAt || null,
      voteEndsAt: poll.voteEndsAt || null,
      serverNow: new Date().toISOString(),
      groups
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memories', async (req, res) => {
  try {
    const db = await loadDb();
    const memories = Object.values(db.memories || {}).sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')));
    res.json(memories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/memories', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const memories = Object.values(db.memories || {}).sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')));
    res.json(memories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/memories', adminAuth, async (req, res) => {
  try {
    const { title, date, description, albumUrl, cover } = req.body || {};
    if (!title || !date) return res.status(400).json({ error: 'Укажите название и дату' });
    const id = crypto.randomBytes(6).toString('hex');
    const db = await loadDb();
    if (!db.memories) db.memories = {};
    db.memories[id] = {
      id,
      title: String(title).slice(0, 200),
      date: String(date).slice(0, 20),
      description: String(description || '').slice(0, 2000),
      albumUrl: String(albumUrl || '').slice(0, 1000),
      cover: String(cover || '').slice(0, 1000) || null,
      createdAt: new Date().toISOString()
    };
    await saveDb(db);
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/memories/:id', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const m = (db.memories || {})[req.params.id];
    if (!m) return res.status(404).json({ error: 'Не найдено' });
    const { title, date, description, albumUrl, cover } = req.body || {};
    if (title !== undefined) m.title = String(title).slice(0, 200);
    if (date !== undefined) m.date = String(date).slice(0, 20);
    if (description !== undefined) m.description = String(description || '').slice(0, 2000);
    if (albumUrl !== undefined) m.albumUrl = String(albumUrl || '').slice(0, 1000);
    if (cover !== undefined) m.cover = String(cover || '').slice(0, 1000) || null;
    await saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/memories/:id', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    if (!db.memories || !db.memories[req.params.id]) {
      return res.status(404).json({ error: 'Не найдено' });
    }
    const mem = db.memories[req.params.id];
    const coverFn = extractFilenameFromUrl(mem.cover);
    delete db.memories[req.params.id];
    let removed = 0;
    if (coverFn) {
      const stillUsed = collectUsedImages(db);
      if (!stillUsed.has(coverFn)) removed = await removeImagesFromStorage([coverFn]);
    }
    await saveDb(db);
    res.json({ ok: true, removedImages: removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/cleanup-images', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    const used = collectUsedImages(db);
    const all = await listAllImages();
    const orphans = all.filter(f => !used.has(f.name)).map(f => f.name);
    if (!orphans.length) {
      return res.json({ ok: true, removed: 0, total: all.length, message: 'Мусора нет' });
    }
    const removed = await removeImagesFromStorage(orphans);
    res.json({ ok: true, removed, total: all.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/storage-stats', adminAuth, async (req, res) => {
  try {
    const all = await listAllImages();
    const totalBytes = all.reduce((s, f) => s + f.size, 0);
    const db = await loadDb();
    const used = collectUsedImages(db);
    const orphanFiles = all.filter(f => !used.has(f.name));
    const orphanBytes = orphanFiles.reduce((s, f) => s + f.size, 0);

    const dbJson = JSON.stringify(db);
    const dbSizeBytes = Buffer.byteLength(dbJson, 'utf-8');

    const DB_LIMIT_BYTES = 500 * 1024 * 1024;
    const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;

    const dbFree = Math.max(0, DB_LIMIT_BYTES - dbSizeBytes);
    const storageFree = Math.max(0, STORAGE_LIMIT_BYTES - totalBytes);
    const totalUsed = dbSizeBytes + totalBytes;
    const totalLimit = DB_LIMIT_BYTES + STORAGE_LIMIT_BYTES;
    const totalFree = Math.max(0, totalLimit - totalUsed);

    const pct = (u, l) => l > 0 ? Math.min(100, Math.round(u / l * 1000) / 10) : 0;
    const fmtBytes = (b) => {
      if (b < 1024) return b + ' Б';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' КБ';
      if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' МБ';
      return (b / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
    };

    const votesCount = Object.values(db.polls).reduce((s, p) =>
      s + (p.votes || []).reduce((a, v) => a + (typeof v.weight === 'number' ? v.weight : (v.plusOne ? 2 : 1)), 0), 0);

    const allGroups = new Set();
    Object.values(db.polls).forEach(p => {
      (p.votes || []).forEach(v => { if (v.group) allGroups.add(v.group); });
    });

    res.json({
      storage: {
        totalFiles: all.length,
        usedFiles: all.length - orphanFiles.length,
        orphanFiles: orphanFiles.length,
        usedBytes: totalBytes,
        usedPretty: fmtBytes(totalBytes),
        orphanBytes,
        orphanPretty: fmtBytes(orphanBytes),
        limitBytes: STORAGE_LIMIT_BYTES,
        limitPretty: fmtBytes(STORAGE_LIMIT_BYTES),
        freeBytes: storageFree,
        freePretty: fmtBytes(storageFree),
        percent: pct(totalBytes, STORAGE_LIMIT_BYTES)
      },
      database: {
        usedBytes: dbSizeBytes,
        usedPretty: fmtBytes(dbSizeBytes),
        limitBytes: DB_LIMIT_BYTES,
        limitPretty: fmtBytes(DB_LIMIT_BYTES),
        freeBytes: dbFree,
        freePretty: fmtBytes(dbFree),
        percent: pct(dbSizeBytes, DB_LIMIT_BYTES),
        pollsCount: Object.keys(db.polls).length,
        votesCount,
        memoriesCount: Object.keys(db.memories || {}).length,
        groupsCount: allGroups.size
      },
      total: {
        usedBytes: totalUsed,
        usedPretty: fmtBytes(totalUsed),
        limitBytes: totalLimit,
        limitPretty: fmtBytes(totalLimit),
        freeBytes: totalFree,
        freePretty: fmtBytes(totalFree),
        percent: pct(totalUsed, totalLimit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/backup', adminAuth, async (req, res) => {
  try {
    const db = await loadDb();
    res.setHeader('Content-Disposition', 'attachment; filename="db-backup-' + Date.now() + '.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(db, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('🚀 Сервер: http://localhost:' + PORT);
  console.log('📦 Хранилище: Supabase');
});
