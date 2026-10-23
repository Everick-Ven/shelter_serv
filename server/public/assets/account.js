/* SHELTER — кабинет пользователя: одна страница, секции фактов.
   Чистый JS без сборки (CSP: script-src 'self'). */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(minor, currency) {
    var v = (minor / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    return v + ' ' + (currency === 'RUB' ? '₽' : currency || '');
  }
  function date(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function datetime(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function daysLeft(iso) {
    if (!iso) return null;
    var ms = new Date(iso).getTime() - Date.now();
    return ms > 0 ? Math.ceil(ms / 86400000) : 0;
  }

  function toast(msg, kind) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'utoast' + (kind === 'bad' ? ' utoast--bad' : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 4200);
  }

  async function api(path, opts) {
    if (window.shelterLocalPreview) return window.shelterLocalPreview(path, opts);
    var res = await fetch(path, Object.assign({
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    }, opts || {}));
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      var err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  var state = { user: null, plans: [] };

  function show(screen) {
    ['screen-auth', 'screen-app'].forEach(function (id) {
      $('#' + id).hidden = id !== screen;
    });
  }

  // ---------------------------------------------------------------- bootstrap
  async function boot() {
    var session = null;
    try { session = await api('/api/v1/auth/session'); } catch (e) { session = null; }
    // Отдельный демо-пользователь; административная роль сюда не переносится.
    var cfg = null;
    try { cfg = await api('/api/v1/auth/providers'); } catch (e) { /* fail closed */ }
    if (cfg && cfg.devLogin && cfg.adminLogin && cfg.adminLogin.demoLogin &&
        (!session || !session.authenticated || session.user.role === 'admin')) {
      try {
        var demo = await api('/api/v1/auth/dev-login', {
          method: 'POST', body: JSON.stringify({ email: 'preview-user@shelter.local', name: 'Демо-пользователь' }),
        });
        session = { authenticated: true, user: demo.user };
      } catch (e) {
        show('screen-auth');
        $('#auth-providers').textContent = 'Не удалось открыть демо-кабинет: ' + e.message;
        $('#dev-form').hidden = true;
        return;
      }
    }
    if (!session || !session.authenticated) {
      await renderGate();
      show('screen-auth');
      return;
    }
    state.user = session.user;
    show('screen-app');
    $('#top-user').textContent = session.user.email || session.user.name || session.user.id;
    if (session.user.role === 'admin') $('#admin-link').hidden = false;
    $('#cab-title').textContent = (session.user.name || session.user.email || 'Аккаунт');
    try {
      state.plans = (await api('/api/v1/plans')).plans || [];
    } catch (e) { state.plans = []; }
    await Promise.all([renderSubscription(), renderOrders(), renderSessions(), renderProfile()]);
  }

  // ---------------------------------------------------------------- вход
  async function renderGate() {
    var errorEl = $('#auth-error');
    errorEl.hidden = true;
    var cfg = null;
    try { cfg = await api('/api/v1/auth/providers'); } catch (e) { cfg = null; }
    var providers = cfg && cfg.providers ? cfg.providers.filter(function (p) { return p.name !== 'dev'; }) : [];
    var host = $('#auth-providers');
    var redirect = encodeURIComponent('/account');

    if (providers.length) {
      host.innerHTML = providers.map(function (p) {
        return '<a class="gate__provider" href="' + esc(p.startUrl) + '?redirect=' + redirect + '">' +
          esc('Войти через ' + p.label) + '</a>';
      }).join('');
    } else {
      host.innerHTML = '<p class="gate__hint">Вход через Google и Yandex не настроен на этом сервере.</p>';
    }

    var devForm = $('#dev-form');
    if (cfg && cfg.devLogin) {
      devForm.hidden = false;
      devForm.onsubmit = async function (ev) {
        ev.preventDefault();
        errorEl.hidden = true;
        try {
          await api('/api/v1/auth/dev-login', { method: 'POST', body: JSON.stringify({ email: $('#dev-email').value.trim() }) });
          await boot();
        } catch (e) {
          errorEl.textContent = e.message;
          errorEl.hidden = false;
        }
      };
    } else {
      devForm.hidden = true;
    }
  }

  // ---------------------------------------------------------------- подписка
  async function renderSubscription() {
    var body = $('#sub-body');
    var pill = $('#sub-status');
    var sub = null;
    var me = null;
    try {
      var results = await Promise.all([api('/api/v1/me/subscription'), api('/api/v1/me')]);
      sub = results[0];
      me = results[1];
    } catch (e) {
      pill.textContent = 'ошибка проверки';
      pill.className = 'status';
      body.innerHTML = '<p class="muted">Сервер проверки подписки недоступен: доступ не подтверждается.</p>';
      return;
    }

    pill.textContent = sub.active ? 'активна' : 'не активна';
    pill.className = 'status' + (sub.active ? ' status--active' : ' status--none');

    var left = daysLeft(sub.expiresAt);
    var rows =
      '<dl class="facts">' +
      '<div><dt>Статус с сервера</dt><dd>' + (sub.active ? 'доступ подтверждён' : 'доступ не подтверждён') + '</dd></div>' +
      '<div><dt>Причина</dt><dd>' + esc(sub.reason || '—') + '</dd></div>' +
      '<div><dt>Тариф</dt><dd>' + esc(sub.planId || '—') + '</dd></div>' +
      '<div><dt>Действует до</dt><dd>' + (sub.expiresAt ? date(sub.expiresAt) + (left != null ? ' (' + left + ' дн.)' : '') : '—') + '</dd></div>' +
      '<div><dt>Оплачено заказов</dt><dd>' + (me && me.billing ? me.billing.paidOrderCount : '—') + '</dd></div>' +
      '<div><dt>Первый платёж</dt><dd>' + (me && me.billing ? date(me.billing.firstPaymentAt) : '—') + '</dd></div>' +
      '</dl>' +
      '<p class="blk__text" style="margin:14px 0 0">Статус выдаёт сервер после собственной проверки оплаты. ' +
      'Записи на этом устройстве не являются доказательством подписки.</p>';

    if (state.plans.length) {
      rows += '<div class="uplans">' + state.plans.map(function (p) {
        var current = sub.active && sub.planId === p.id;
        var per = p.days >= 365 ? 'в год' : 'в месяц';
        return '<div class="uplan' + (current ? ' uplan--current' : '') + '">' +
          '<h3>' + esc(p.title) + (current ? ' · текущий' : '') + '</h3>' +
          '<div class="price">' + money(p.amountMinor, p.currency) + '</div>' +
          '<p class="per">' + per + ' · ' + p.days + ' дн. доступа</p>' +
          '<ul>' + (p.features || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
          '<button class="ubtn" type="button" data-buy="' + esc(p.id) + '"' + (current ? ' disabled' : '') + '>' +
          (current ? 'Оплачен' : 'Оформить') + '</button>' +
          '</div>';
      }).join('') + '</div>';
    }

    body.innerHTML = rows;
    Array.prototype.forEach.call(body.querySelectorAll('[data-buy]'), function (b) {
      b.addEventListener('click', function () { void checkout(b.dataset.buy, b); });
    });
  }

  async function checkout(planId, btn) {
    btn.disabled = true;
    try {
      var order = await api('/api/v1/checkout', { method: 'POST', body: JSON.stringify({ planId: planId }) });
      // Оплата открывается во внешней вкладке; возврат на сайт премиум не включает.
      window.open(order.checkoutUrl, '_blank', 'noopener');
      toast('Заказ создан: ' + order.amount + '. Оплата открыта в новой вкладке.');
      setTimeout(function () { void renderSubscription(); }, 2500);
    } catch (e) {
      toast(e.message, 'bad');
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- заказы
  async function renderOrders() {
    var body = $('#orders-body');
    var data = null;
    try { data = await api('/api/v1/me/orders'); } catch (e) {
      body.innerHTML = '<p class="muted">Не удалось загрузить заказы.</p>';
      return;
    }
    var orders = data.orders || [];
    if (!orders.length) {
      body.innerHTML = '<p class="muted">Заказов пока нет.</p>';
      return;
    }
    body.innerHTML =
      '<table class="utbl"><thead><tr>' +
      '<th>Дата</th><th>Тариф</th><th class="num">Сумма</th><th>Статус</th>' +
      '</tr></thead><tbody>' +
      orders.map(function (o) {
        return '<tr>' +
          '<td>' + datetime(o.createdAt) + '</td>' +
          '<td>' + esc(o.planId) + ' · ' + o.days + ' дн.</td>' +
          '<td class="num">' + money(o.amountMinor, o.currency) + '</td>' +
          '<td><span class="status status--' + esc(o.status) + '">' + esc(o.status) + '</span></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  // ---------------------------------------------------------------- сессии
  async function renderSessions() {
    var body = $('#sessions-body');
    var data = null;
    try { data = await api('/api/v1/me/sessions'); } catch (e) {
      body.innerHTML = '<p class="muted">Не удалось загрузить сессии.</p>';
      return;
    }
    var sessions = (data.sessions || []).filter(function (s) { return !s.revokedAt; });
    if (!sessions.length) {
      body.innerHTML = '<p class="muted">Активных сессий нет.</p>';
      return;
    }
    body.innerHTML = '<div class="usess">' + sessions.map(function (s) {
      return '<div class="usess__row' + (s.current ? ' usess__row--current' : '') + '">' +
        '<div class="usess__meta">' +
        '<div class="usess__ua">' + esc(s.userAgent || 'Неизвестное устройство') + (s.current ? ' · это устройство' : '') + '</div>' +
        '<div class="usess__when">вход ' + datetime(s.createdAt) + ' · до ' + date(s.expiresAt) + '</div>' +
        '</div>' +
        (s.current ? '' : '<button class="ubtn ubtn--quiet ubtn--sm" type="button" data-revoke="' + esc(s.id) + '">Завершить</button>') +
        '</div>';
    }).join('') + '</div>';
    Array.prototype.forEach.call(body.querySelectorAll('[data-revoke]'), function (b) {
      b.addEventListener('click', async function () {
        try {
          await api('/api/v1/me/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId: b.dataset.revoke }) });
          toast('Сессия завершена.');
          await renderSessions();
        } catch (e) { toast(e.message, 'bad'); }
      });
    });
  }

  // ---------------------------------------------------------------- профиль
  async function renderProfile() {
    var body = $('#profile-body');
    var me = null;
    try { me = await api('/api/v1/me'); } catch (e) {
      body.innerHTML = '<p class="muted">Не удалось загрузить профиль.</p>';
      return;
    }
    var u = me.user;
    body.innerHTML =
      '<form class="uform" id="profile-form">' +
      '<label>Email<input name="email" value="' + esc(u.email || '') + '" disabled /></label>' +
      '<label>Имя<input name="name" value="' + esc(u.name || '') + '" maxlength="120" placeholder="Как вас называть" /></label>' +
      '<div class="uform__actions">' +
      '<button class="ubtn" type="submit">Сохранить</button>' +
      '</div>' +
      '</form>';
    $('#profile-form', body).addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var name = $('#profile-form [name="name"]', body).value.trim();
      try {
        await api('/api/v1/me', { method: 'PATCH', body: JSON.stringify({ name: name || null }) });
        toast('Профиль сохранён.');
        await boot();
      } catch (e) { toast(e.message, 'bad'); }
    });
  }

  // ---------------------------------------------------------------- события
  function wire() {
    $('#logout').addEventListener('click', async function () {
      try { await api('/api/v1/auth/logout', { method: 'POST', body: '{}' }); } catch (e) { /* не важно */ }
      window.location.reload();
    });
    $('#orders-refresh').addEventListener('click', function () { void renderOrders(); });
    $('#sessions-revoke-all').addEventListener('click', async function () {
      if (!window.confirm('Завершить все сессии, кроме текущей?')) return;
      try {
        await api('/api/v1/me/sessions/revoke', { method: 'POST', body: '{}' });
        toast('Другие сессии завершены.');
        await renderSessions();
      } catch (e) { toast(e.message, 'bad'); }
    });
    $('#delete-me').addEventListener('click', async function () {
      if (!window.confirm('Удалить аккаунт и все персональные данные? Действие необратимо.')) return;
      try {
        await api('/api/v1/me', { method: 'DELETE', body: '{}' });
        window.location.href = '/';
      } catch (e) { toast(e.message, 'bad'); }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    wire();
    void boot();
  });
})();
