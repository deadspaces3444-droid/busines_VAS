/* ============================================================
   Абстракция хранилища: GitHub Pages (localStorage) или сервер.
   v4: голосующий указывает фамилию, голоса хранятся как записи.
   + смена пароля администратора.
   ============================================================ */
(function (global) {
  'use strict';

  var LS_DB = 'beeline_surveys_db_v4';
  var LS_ADMIN_DEFAULT = 'beeline_admin_pass_local';
  var DEFAULT_ADMIN_PASSWORD = 'admin123';

  var mode = null;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function loadLocal() {
    try {
      var db = JSON.parse(localStorage.getItem(LS_DB)) || { polls: {} };
      Object.keys(db.polls || {}).forEach(function (t) {
        var p = db.polls[t];
        if (!Array.isArray(p.votes)) p.votes = [];
      });
      return db;
    } catch (e) { return { polls: {} }; }
  }
  function saveLocal(db) { localStorage.setItem(LS_DB, JSON.stringify(db)); }

  async function detectMode() {
    if (mode) return mode;
    try {
      var r = await fetch('api/ping');
      if (r.ok) {
        var data = await r.json().catch(function () { return {}; });
        if (data && data.ok) { mode = 'server'; return mode; }
      }
    } catch (e) {}
    mode = 'local';
    return mode;
  }

  function getAdminPassword() { return sessionStorage.getItem('adminPassword') || ''; }
  function setAdminPassword(p) { sessionStorage.setItem('adminPassword', p); }
  function clearAdminPassword() { sessionStorage.removeItem('adminPassword'); }

  // ============================================================
  // Вход администратора
  // ============================================================
  async function adminLogin(password) {
    if (mode === 'server') {
      var r = await fetch('api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      });
      if (!r.ok) {
        var err = await r.json().catch(function () { return {}; });
        throw new Error(err.error || 'Неверный пароль');
      }
      setAdminPassword(password);
      return true;
    }
    var saved = localStorage.getItem(LS_ADMIN_DEFAULT) || DEFAULT_ADMIN_PASSWORD;
    if (password !== saved) throw new Error('Неверный пароль');
    setAdminPassword(password);
    return true;
  }

  // ============================================================
  // Смена пароля администратора
  // ============================================================
  async function changeAdminPassword(currentPassword, newPassword) {
    if (mode === 'server') {
      var r = await fetch('api/admin/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': getAdminPassword()
        },
        body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data.error || 'Ошибка');
      setAdminPassword(newPassword);
      return true;
    }
    var saved = localStorage.getItem(LS_ADMIN_DEFAULT) || DEFAULT_ADMIN_PASSWORD;
    if (currentPassword !== saved) throw new Error('Текущий пароль неверен');
    if (String(newPassword).length < 6) throw new Error('Новый пароль должен быть не короче 6 символов');
    localStorage.setItem(LS_ADMIN_DEFAULT, newPassword);
    setAdminPassword(newPassword);
    return true;
  }

  function adminFetch(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {}, {
      'x-admin-password': getAdminPassword()
    });
    return fetch(path, options);
  }

  async function listPolls() {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls');
      if (!r.ok) throw new Error('Unauthorized');
      return r.json();
    }
    var db = loadLocal();
    return Object.values(db.polls).map(function (p) {
      return {
        token: p.token,
        title: p.title,
        createdAt: p.createdAt,
        isOpen: p.isOpen,
        totalVotes: (p.votes || []).length
      };
    }).sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
  }

  async function createPoll(data) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!r.ok) {
        var err = await r.json().catch(function () { return {}; });
        throw new Error(err.error || 'Ошибка');
      }
      return r.json();
    }
    var db = loadLocal();
    var token = uid();
    db.polls[token] = {
      token: token,
      title: String(data.title).slice(0, 200),
      description: String(data.description || '').slice(0, 2000),
      options: data.options.map(function (o, i) {
        return {
          id: 'opt_' + i,
          title: String(o.title || '').slice(0, 200),
          description: String(o.description || '').slice(0, 1000),
          budget: Number(o.budget) || 0,
          image: o.image || null,
          sourceUrl: o.sourceUrl || null
        };
      }),
      votes: [],
      createdAt: new Date().toISOString(),
      isOpen: true
    };
    saveLocal(db);
    return { token: token };
  }

  async function deletePoll(token) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + token, { method: 'DELETE' });
      if (!r.ok) throw new Error('Ошибка');
      return true;
    }
    var db = loadLocal();
    delete db.polls[token];
    saveLocal(db);
    return true;
  }

  async function togglePoll(token, isOpen) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isOpen: isOpen })
      });
      if (!r.ok) throw new Error('Ошибка');
      return true;
    }
    var db = loadLocal();
    if (db.polls[token]) db.polls[token].isOpen = isOpen;
    saveLocal(db);
    return true;
  }

  async function resetVotes(token) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + token + '/reset', { method: 'POST' });
      if (!r.ok) throw new Error('Ошибка');
      return true;
    }
    var db = loadLocal();
    if (db.polls[token]) db.polls[token].votes = [];
    saveLocal(db);
    return true;
  }

  async function getPoll(token) {
    if (mode === 'server') {
      var r = await fetch('api/polls/' + encodeURIComponent(token));
      if (!r.ok) {
        var err = await r.json().catch(function () { return {}; });
        throw new Error(err.error || 'Опрос не найден');
      }
      return r.json();
    }
    var db = loadLocal();
    var p = db.polls[token];
    if (!p) throw new Error('Опрос не найден');
    return {
      token: p.token,
      title: p.title,
      description: p.description,
      options: p.options,
      isOpen: p.isOpen,
      totalVotes: (p.votes || []).length
    };
  }

  function normalizeName(n) {
    return String(n || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  }

  async function vote(token, optionId, name) {
    name = normalizeName(name);
    if (!name) throw new Error('Укажите фамилию');

    if (mode === 'server') {
      var r = await fetch('api/polls/' + encodeURIComponent(token) + '/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: optionId, name: name })
      });
      if (!r.ok) {
        var err = await r.json().catch(function () { return {}; });
        throw new Error(err.error || 'Ошибка');
      }
      return r.json();
    }

    var db = loadLocal();
    var p = db.polls[token];
    if (!p) throw new Error('Опрос не найден');
    if (!p.isOpen) throw new Error('Опрос закрыт');
    if (!p.options.some(function (o) { return o.id === optionId; })) {
      throw new Error('Неверный вариант');
    }
    var lower = name.toLowerCase();
    var exists = (p.votes || []).some(function (v) {
      return String(v.name || '').toLowerCase() === lower;
    });
    if (exists) throw new Error('Эта фамилия уже голосовала');

    p.votes.push({ name: name, optionId: optionId, at: new Date().toISOString() });
    saveLocal(db);
    return { ok: true };
  }

  function calcResults(p) {
    var votes = Array.isArray(p.votes) ? p.votes : [];
    var totalVotes = votes.length;

    var results = p.options.map(function (o) {
      var optVotes = votes.filter(function (v) { return v.optionId === o.id; });
      var cnt = optVotes.length;
      return Object.assign({}, o, {
        votes: cnt,
        perPerson: cnt > 0 ? Math.round(o.budget / cnt) : 0,
        voters: optVotes.map(function (v) { return v.name; })
      });
    }).sort(function (a, b) { return b.votes - a.votes; });

    var winner = results[0] && results[0].votes > 0 ? results[0] : null;

    return {
      title: p.title,
      description: p.description,
      totalVotes: totalVotes,
      results: results,
      winner: winner,
      isOpen: p.isOpen
    };
  }

  async function getResults(token) {
    if (mode === 'server') {
      var r = await fetch('api/polls/' + encodeURIComponent(token) + '/results');
      if (!r.ok) {
        var err = await r.json().catch(function () { return {}; });
        throw new Error(err.error || 'Опрос не найден');
      }
      return r.json();
    }
    var db = loadLocal();
    var p = db.polls[token];
    if (!p) throw new Error('Опрос не найден');
    return calcResults(p);
  }

  async function uploadImage(file) {
    if (mode === 'server') {
      var fd = new FormData();
      fd.append('image', file);
      var r = await adminFetch('api/admin/upload', { method: 'POST', body: fd });
      if (!r.ok) {
        var err = await r.json().catch(function () { return {}; });
        throw new Error(err.error || 'Ошибка загрузки');
      }
      var data = await r.json();
      return data.url;
    }
    if (file.size > 600 * 1024) {
      throw new Error('Файл слишком большой для локального режима (макс. ~600 КБ). Используйте ссылку.');
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Ошибка чтения файла')); };
      reader.readAsDataURL(file);
    });
  }

  async function fetchLink(url) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/fetch-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data.error || 'Ошибка');
      return data;
    }
    throw new Error(
      'Автозагрузка по ссылке работает только в серверном режиме (CORS). ' +
      'Введите название и картинку вручную.'
    );
  }

  function voteUrl(token) {
    var base = location.href.replace(/[^/]*(\?.*)?(#.*)?$/, '');
    return base + 'vote.html?t=' + encodeURIComponent(token);
  }
  function resultsUrl(token) {
    var base = location.href.replace(/[^/]*(\?.*)?(#.*)?$/, '');
    return base + 'results.html?t=' + encodeURIComponent(token);
  }

  global.Storage = {
    init: detectMode,
    getMode: function () { return mode; },
    isServer: function () { return mode === 'server'; },
    adminLogin: adminLogin,
    changeAdminPassword: changeAdminPassword,
    getAdminPassword: getAdminPassword,
    clearAdminPassword: clearAdminPassword,
    listPolls: listPolls,
    createPoll: createPoll,
    deletePoll: deletePoll,
    togglePoll: togglePoll,
    resetVotes: resetVotes,
    getPoll: getPoll,
    vote: vote,
    getResults: getResults,
    uploadImage: uploadImage,
    fetchLink: fetchLink,
    voteUrl: voteUrl,
    resultsUrl: resultsUrl,
    normalizeName: normalizeName
  };
})(window);
