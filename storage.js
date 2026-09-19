/* ============================================================
   Слой доступа к данным: сервер (Supabase) или localStorage
   ============================================================ */
(function (global) {
  'use strict';

  var LS_DB = 'beeline_surveys_db_v5';
  var LS_ADMIN_DEFAULT = 'beeline_admin_pass_local';
  var DEFAULT_ADMIN_PASSWORD = 'admin123';

  var mode = null;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function loadLocal() {
    try {
      var db = JSON.parse(localStorage.getItem(LS_DB)) || { polls: {}, memories: {} };
      if (!db.polls) db.polls = {};
      if (!db.memories) db.memories = {};
      Object.keys(db.polls).forEach(function (t) {
        var p = db.polls[t];
        if (!Array.isArray(p.votes)) p.votes = [];
        if (!Array.isArray(p.options)) p.options = [];
        if (!Array.isArray(p.groups)) p.groups = [];
        if (!Array.isArray(p.declinedVotes)) p.declinedVotes = [];
      });
      return db;
    } catch (e) { return { polls: {}, memories: {} }; }
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

  function adminFetch(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {}, {
      'x-admin-password': getAdminPassword()
    });
    return fetch(path, options);
  }

  function weightOf(v) {
    if (typeof v.weight === 'number' && v.weight > 0) return v.weight;
    return v.plusOne ? 2 : 1;
  }

  function calcPhase(p) {
    if (!p.isOpen) return 'closed';
    var now = Date.now();
    var sEnd = p.suggestEndsAt ? new Date(p.suggestEndsAt).getTime() : null;
    var vEnd = p.voteEndsAt ? new Date(p.voteEndsAt).getTime() : null;
    if (sEnd && now < sEnd) return 'suggest';
    if (vEnd && now >= vEnd) return 'closed';
    return 'vote';
  }

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
    if (String(newPassword).length < 6) throw new Error('Новый пароль не короче 6 символов');
    localStorage.setItem(LS_ADMIN_DEFAULT, newPassword);
    setAdminPassword(newPassword);
    return true;
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
        phase: calcPhase(p),
        suggestEndsAt: p.suggestEndsAt || null,
        voteEndsAt: p.voteEndsAt || null,
        totalVotes: (p.votes || []).reduce(function (s, v) { return s + weightOf(v); }, 0),
        optionsCount: (p.options || []).filter(function (o) { return !o.pending; }).length,
        pendingCount: (p.options || []).filter(function (o) { return o.pending; }).length
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
    var groups = Array.isArray(data.groups)
      ? data.groups.map(function (g) { return String(g || '').trim().slice(0, 100); }).filter(Boolean)
      : [];
    var suggestHours = Math.max(0, Number(data.suggestHours) || 0);
    var voteDays = Math.max(0, Number(data.voteDays) || 0);
    var now = Date.now();
    var suggestEndsAt = suggestHours > 0 ? new Date(now + suggestHours * 3600 * 1000).toISOString() : null;
    var voteEndsAt = voteDays > 0
      ? new Date(now + (suggestHours * 3600 + voteDays * 86400) * 1000).toISOString() : null;

    db.polls[token] = {
      token: token,
      title: String(data.title).slice(0, 200),
      description: String(data.description || '').slice(0, 2000),
      askGroup: data.askGroup !== false,
      groups: groups,
      suggestHours: suggestHours,
      voteDays: voteDays,
      suggestEndsAt: suggestEndsAt,
      voteEndsAt: voteEndsAt,
      options: data.options.map(function (o, i) {
        return {
          id: 'opt_' + i,
          title: String(o.title || '').slice(0, 200),
          description: String(o.description || '').slice(0, 1000),
          type: o.type === 'check' ? 'check' : 'deposit',
          budget: Number(o.budget) || 0,
          image: o.image || null,
          sourceUrl: o.sourceUrl || null
        };
      }),
      votes: [],
      declinedVotes: [],
      createdAt: new Date().toISOString(),
      isOpen: true
    };
    saveLocal(db);
    return { token: token };
  }

  async function updatePoll(token, data) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + encodeURIComponent(token), {
        method: 'PUT',
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
    var poll = db.polls[token];
    if (!poll) throw new Error('Не найдено');
    if (data.title !== undefined) poll.title = String(data.title).slice(0, 200);
    if (data.description !== undefined) poll.description = String(data.description || '').slice(0, 2000);
    if (typeof data.isOpen === 'boolean') poll.isOpen = data.isOpen;
    if (typeof data.askGroup === 'boolean') poll.askGroup = data.askGroup;
    if (Array.isArray(data.groups)) {
      poll.groups = data.groups.map(function (g) { return String(g || '').trim().slice(0, 100); }).filter(Boolean);
    }
    if (data.suggestHours !== undefined || data.voteDays !== undefined) {
      var sh = Math.max(0, Number(data.suggestHours != null ? data.suggestHours : poll.suggestHours) || 0);
      var vd = Math.max(0, Number(data.voteDays != null ? data.voteDays : poll.voteDays) || 0);
      poll.suggestHours = sh;
      poll.voteDays = vd;
      var base = poll.createdAt ? new Date(poll.createdAt).getTime() : Date.now();
      poll.suggestEndsAt = sh > 0 ? new Date(base + sh * 3600 * 1000).toISOString() : null;
      poll.voteEndsAt = vd > 0 ? new Date(base + (sh * 3600 + vd * 86400) * 1000).toISOString() : null;
    }
    if (Array.isArray(data.options) && data.options.length >= 2) {
      var oldOptions = poll.options || [];
      poll.options = data.options.map(function (o, i) {
        var old = oldOptions.find(function (x) { return x.id === o.id; }) || oldOptions[i];
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
      var validIds = {};
      poll.options.forEach(function (o) { validIds[o.id] = true; });
      poll.votes = (poll.votes || []).filter(function (v) { return validIds[v.optionId]; });
    }
    saveLocal(db);
    return { ok: true };
  }

  async function deletePoll(token) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + encodeURIComponent(token), { method: 'DELETE' });
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
      var r = await adminFetch('api/admin/polls/' + encodeURIComponent(token), {
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
      var r = await adminFetch('api/admin/polls/' + encodeURIComponent(token) + '/reset', { method: 'POST' });
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
    var pollDefaultType = p.type === 'check' ? 'check' : 'deposit';
    return {
      token: p.token,
      title: p.title,
      description: p.description,
      options: (p.options || []).filter(function (o) { return !o.pending; }).map(function (o) {
        return Object.assign({}, o, {
          type: o.type === 'check' ? 'check' : (o.type === 'deposit' ? 'deposit' : pollDefaultType)
        });
      }),
      isOpen: p.isOpen,
      phase: calcPhase(p),
      suggestEndsAt: p.suggestEndsAt || null,
      voteEndsAt: p.voteEndsAt || null,
      serverNow: new Date().toISOString(),
      askGroup: p.askGroup !== false,
      groups: Array.isArray(p.groups) ? p.groups : [],
      totalVotes: (p.votes || []).reduce(function (s, v) { return s + weightOf(v); }, 0)
    };
  }

  function normalizeName(n) {
    return String(n || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  }

  async function vote(token, optionId, name, plusOne, group) {
    name = normalizeName(name);
    group = normalizeName(group);
    plusOne = !!plusOne;
    if (!name) throw new Error('Укажите фамилию');
    if (mode === 'server') {
      var r = await fetch('api/polls/' + encodeURIComponent(token) + '/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: optionId, name: name, plusOne: plusOne, group: group })
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
    var phase = calcPhase(p);
    if (phase === 'suggest') throw new Error('Голосование ещё не открыто');
    if (phase === 'closed') throw new Error('Опрос закрыт');
    if (p.askGroup !== false) {
      var available = Array.isArray(p.groups) ? p.groups : [];
      if (!group) throw new Error('Выберите группу');
      if (available.length && available.indexOf(group) === -1) throw new Error('Такой группы нет');
    }
    if (!p.options.some(function (o) { return o.id === optionId; })) throw new Error('Неверный вариант');
    var lower = name.toLowerCase();
    if ((p.votes || []).some(function (v) { return String(v.name || '').toLowerCase() === lower; })) {
      throw new Error('Эта фамилия уже голосовала');
    }
    if (!Array.isArray(p.votes)) p.votes = [];
    p.votes.push({
      name: name,
      group: group || '',
      optionId: optionId,
      plusOne: plusOne,
      weight: plusOne ? 2 : 1,
      at: new Date().toISOString()
    });
    saveLocal(db);
    return { ok: true };
  }

  function calcResults(p) {
    var votes = Array.isArray(p.votes) ? p.votes : [];
    var totalPeople = votes.reduce(function (s, v) { return s + weightOf(v); }, 0);
    var totalRecords = votes.length;
    var pollDefaultType = p.type === 'check' ? 'check' : 'deposit';

    var results = p.options.filter(function (o) { return !o.pending; }).map(function (o) {
      var optVotes = votes.filter(function (v) { return v.optionId === o.id; });
      var people = optVotes.reduce(function (s, v) { return s + weightOf(v); }, 0);
      var optType = o.type === 'check' ? 'check' : (o.type === 'deposit' ? 'deposit' : pollDefaultType);
      var perPerson = 0, total = 0;
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
        perPerson: perPerson,
        total: total,
        voters: optVotes.map(function (v) {
          return {
            name: v.name,
            group: v.group || '',
            plusOne: !!v.plusOne,
            weight: weightOf(v),
            label: (v.name + (v.group ? ' · ' + v.group : '') + (v.plusOne ? ' +1' : ''))
          };
        })
      });
    }).sort(function (a, b) { return b.votes - a.votes; });

    var winner = results[0] && results[0].votes > 0 ? results[0] : null;

    var groupStats = {};
    votes.forEach(function (v) {
      var g = v.group || 'Без группы';
      var w = weightOf(v);
      if (!groupStats[g]) groupStats[g] = { group: g, people: 0, records: 0 };
      groupStats[g].people += w;
      groupStats[g].records += 1;
    });
    var groups = Object.keys(groupStats).map(function (k) { return groupStats[k]; })
      .sort(function (a, b) { return b.people - a.people; });

    return {
      title: p.title,
      description: p.description,
      totalVotes: totalPeople,
      totalRecords: totalRecords,
      results: results,
      winner: winner,
      isOpen: p.isOpen,
      phase: calcPhase(p),
      suggestEndsAt: p.suggestEndsAt || null,
      voteEndsAt: p.voteEndsAt || null,
      serverNow: new Date().toISOString(),
      groups: groups
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
      throw new Error('Файл слишком большой (макс. ~600 КБ в локальном режиме)');
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
    throw new Error('Автозагрузка доступна только в серверном режиме');
  }

  async function fetchAlbumPreview(url) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/fetch-album-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data.error || 'Ошибка');
      return data;
    }
    throw new Error('Доступно только в серверном режиме');
  }

  async function addVoteManual(token, data) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + encodeURIComponent(token) + '/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      var out = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(out.error || 'Ошибка');
      return out;
    }
    var db = loadLocal();
    var p = db.polls[token];
    if (!p) throw new Error('Опрос не найден');
    var name = normalizeName(data.name);
    var group = normalizeName(data.group);
    if (!name) throw new Error('Укажите фамилию');
    if (!data.optionId) throw new Error('Выберите вариант');
    if (!p.options.some(function (o) { return o.id === data.optionId; })) throw new Error('Нет такого варианта');
    if (p.askGroup !== false) {
      var available = Array.isArray(p.groups) ? p.groups : [];
      if (!group) throw new Error('Выберите группу');
      if (available.length && available.indexOf(group) === -1) throw new Error('Нет такой группы');
    }
    if (!Array.isArray(p.votes)) p.votes = [];
    var lower = name.toLowerCase();
    if (p.votes.some(function (v) { return String(v.name || '').toLowerCase() === lower; })) {
      throw new Error('Эта фамилия уже голосовала');
    }
    p.votes.push({
      name: name,
      group: group || '',
      optionId: data.optionId,
      plusOne: !!data.plusOne,
      weight: data.plusOne ? 2 : 1,
      at: new Date().toISOString(),
      addedByAdmin: true
    });
    saveLocal(db);
    return { ok: true };
  }

  async function removeVote(token, name, reason) {
    if (mode === 'server') {
      var r = await adminFetch(
        'api/admin/polls/' + encodeURIComponent(token) + '/votes/' + encodeURIComponent(name),
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason || 'отказ' })
        }
      );
      var out = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(out.error || 'Ошибка');
      return out;
    }
    var db = loadLocal();
    var p = db.polls[token];
    if (!p) throw new Error('Опрос не найден');
    var target = String(name || '').toLowerCase();
    var idx = (p.votes || []).findIndex(function (v) {
      return String(v.name || '').toLowerCase() === target;
    });
    if (idx === -1) throw new Error('Голос не найден');
    var removed = p.votes[idx];
    if (!Array.isArray(p.declinedVotes)) p.declinedVotes = [];
    p.declinedVotes.push({
      name: removed.name,
      group: removed.group || '',
      optionId: removed.optionId,
      plusOne: !!removed.plusOne,
      weight: weightOf(removed),
      votedAt: removed.at || null,
      declinedAt: new Date().toISOString(),
      reason: reason || 'отказ'
    });
    p.votes.splice(idx, 1);
    saveLocal(db);
    return { ok: true };
  }

  async function suggestPlace(token, data) {
    if (mode === 'server') {
      var r = await fetch('api/polls/' + encodeURIComponent(token) + '/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      var out = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(out.error || 'Ошибка');
      return out;
    }
    var db = loadLocal();
    var p = db.polls[token];
    if (!p) throw new Error('Опрос не найден');
    var phase = calcPhase(p);
    if (phase !== 'suggest') {
      throw new Error(phase === 'vote' ? 'Приём предложений завершён' : 'Опрос закрыт');
    }
    if (!data.title) throw new Error('Укажите название');
    if (!data.sourceUrl) throw new Error('Укажите ссылку');
    if (!Array.isArray(p.options)) p.options = [];
    var id = 'opt_' + Math.random().toString(36).slice(2, 10);
    p.options.push({
      id: id,
      title: String(data.title || '').slice(0, 200),
      description: String(data.description || '').slice(0, 1000),
      type: data.type === 'check' ? 'check' : 'deposit',
      budget: Number(data.budget) || 0,
      image: data.image || null,
      sourceUrl: String(data.sourceUrl || '').slice(0, 1000),
      pending: true,
      suggestedBy: data.author || 'Сотрудник',
      suggestedAt: new Date().toISOString()
    });
    saveLocal(db);
    return { ok: true, id: id };
  }

  async function listSuggestions(token) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + encodeURIComponent(token) + '/suggestions');
      if (!r.ok) throw new Error('Ошибка');
      return r.json();
    }
    var db = loadLocal();
    var p = db.polls[token];
    if (!p) throw new Error('Опрос не найден');
    return (p.options || []).filter(function (o) { return o.pending; });
  }

  async function approveSuggestion(token, id) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + encodeURIComponent(token) + '/suggestions/' + encodeURIComponent(id) + '/approve', { method: 'POST' });
      if (!r.ok) throw new Error('Ошибка');
      return true;
    }
    var db = loadLocal();
    var p = db.polls[token];
    var opt = (p.options || []).find(function (o) { return o.id === id; });
    if (!opt) throw new Error('Не найдено');
    delete opt.pending;
    delete opt.suggestedBy;
    delete opt.suggestedAt;
    saveLocal(db);
    return true;
  }

  async function rejectSuggestion(token, id) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/polls/' + encodeURIComponent(token) + '/suggestions/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!r.ok) throw new Error('Ошибка');
      return true;
    }
    var db = loadLocal();
    var p = db.polls[token];
    p.options = (p.options || []).filter(function (o) { return o.id !== id; });
    p.votes = (p.votes || []).filter(function (v) { return v.optionId !== id; });
    saveLocal(db);
    return true;
  }

  async function listMemories() {
    if (mode === 'server') {
      var r = await fetch('api/memories');
      if (!r.ok) throw new Error('Ошибка');
      return r.json();
    }
    var db = loadLocal();
    return Object.values(db.memories || {}).sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
  }

  async function listMemoriesAdmin() {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/memories');
      if (!r.ok) throw new Error('Unauthorized');
      return r.json();
    }
    return listMemories();
  }

  async function createMemory(data) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      var out = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(out.error || 'Ошибка');
      return out;
    }
    var db = loadLocal();
    if (!db.memories) db.memories = {};
    var id = uid();
    db.memories[id] = {
      id: id,
      title: String(data.title || '').slice(0, 200),
      date: String(data.date || '').slice(0, 20),
      description: String(data.description || '').slice(0, 2000),
      albumUrl: String(data.albumUrl || '').slice(0, 1000),
      cover: String(data.cover || '').slice(0, 1000) || null,
      createdAt: new Date().toISOString()
    };
    saveLocal(db);
    return { id: id };
  }

  async function updateMemory(id, data) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/memories/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error('Ошибка');
      return r.json();
    }
    var db = loadLocal();
    var m = (db.memories || {})[id];
    if (!m) throw new Error('Не найдено');
    Object.assign(m, data);
    saveLocal(db);
    return { ok: true };
  }

  async function deleteMemory(id) {
    if (mode === 'server') {
      var r = await adminFetch('api/admin/memories/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!r.ok) throw new Error('Ошибка');
      return true;
    }
    var db = loadLocal();
    if (db.memories) delete db.memories[id];
    saveLocal(db);
    return true;
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
    updatePoll: updatePoll,
    deletePoll: deletePoll,
    togglePoll: togglePoll,
    resetVotes: resetVotes,

    getPoll: getPoll,
    vote: vote,
    getResults: getResults,

    uploadImage: uploadImage,
    fetchLink: fetchLink,
    fetchAlbumPreview: fetchAlbumPreview,

    addVoteManual: addVoteManual,
    removeVote: removeVote,

    suggestPlace: suggestPlace,
    listSuggestions: listSuggestions,
    approveSuggestion: approveSuggestion,
    rejectSuggestion: rejectSuggestion,

    listMemories: listMemories,
    listMemoriesAdmin: listMemoriesAdmin,
    createMemory: createMemory,
    updateMemory: updateMemory,
    deleteMemory: deleteMemory,

    voteUrl: voteUrl,
    resultsUrl: resultsUrl,
    normalizeName: normalizeName
  };
})(window);
