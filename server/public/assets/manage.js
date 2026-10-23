/* SHELTER /manage — панель управления. Vanilla JS, без сборки (CSP: script-src 'self'). */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var state = {
    user: null,
    view: 'overview',
    users: { q: '', limit: 25, offset: 0, total: 0, items: [] },
    orders: { status: '', limit: 25, offset: 0, total: 0, items: [] },
    overview: null,
    updates: null,
  };

  var TITLES = {
    overview: ['Обзор', 'Сводка по аккаунтам, подпискам и платежам'],
    users: ['Пользователи', 'Аккаунты, подписки и история оплат'],
    orders: ['Заказы', 'Заказы и платежи по всем пользователям'],
    updates: ['Обновления', 'Канал релизов и минимальная поддерживаемая версия'],
    account: ['Аккаунт', 'Ваш профиль и данные'],
  };

  // ------------------------------------------------------------- helpers
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(minor, currency) {
    var n = Number(minor || 0) / 100;
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ' + (currency === 'RUB' || !currency ? '₽' : currency);
  }
  function moneyShort(minor) {
    var n = Number(minor || 0) / 100;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + ' млн ₽';
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + ' тыс ₽';
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
  }
  function date(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function badge(v) {
    var cls = 'badge badge--' + String(v || 'none');
    return '<span class="' + cls + '">' + esc(v || 'none') + '</span>';
  }
  function toast(message, kind) {
    var el = $('#toast');
    el.textContent = message;
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 4200);
  }

  async function api(path, opts) {
    var options = opts || {};
    var init = {
      method: options.method || 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    };
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    var res = await fetch(path, init);
    var text = await res.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    }
    if (!res.ok) {
      var err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
      err.status = res.status;
      err.code = data && data.error ? data.error.code : 'error';
      err.data = data;
      throw err;
    }
    return data;
  }

  function show(screen) {
    ['screen-auth', 'screen-denied', 'screen-app'].forEach(function (id) {
      var el = $('#' + id);
      el.hidden = id !== screen;
    });
  }

  function modal(title, bodyHtml, actions) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    var wrap = document.createElement('div');
    wrap.className = 'modal__actions';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'btn ' + (a.kind === 'danger' ? 'btn--danger' : a.kind === 'primary' ? 'btn--primary' : 'btn--ghost') + ' btn--md';
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', function () { a.onClick(b); });
      wrap.appendChild(b);
    });
    $('#modal-body').appendChild(wrap);
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }

  // ------------------------------------------------------------- bootstrap
  async function boot() {
    var session;
    try {
      session = await api('/api/v1/auth/session');
    } catch (e) {
      session = null;
    }
    if (!session || !session.authenticated) {
      state.user = null;
      await renderAuth();
      show('screen-auth');
      return;
    }
    state.user = session.user;
    if (session.user.role !== 'admin') {
      show('screen-denied');
      return;
    }
    show('screen-app');
    $('#side-user').textContent = session.user.email || session.user.name || session.user.id;
    void loadOverviewMeta();
    await navigate('overview');
  }

  async function renderAuth() {
    var host = $('#auth-providers');
    var errorEl = $('#auth-error');
    errorEl.hidden = true;
    host.innerHTML = '<div class="skeleton" style="height:46px"></div>';

    var cfg = null;
    try { cfg = await api('/api/v1/auth/providers'); } catch (e) { cfg = null; }
    var providers = cfg && cfg.providers ? cfg.providers : [];
    var redirect = encodeURIComponent('/manage');

    if (!providers.length && !(cfg && cfg.devLogin)) {
      host.innerHTML =
        '<p class="auth__hint">OAuth-провайдеры не настроены. Задайте GOOGLE_CLIENT_ID / ' +
        'YANDEX_CLIENT_ID в окружении сервера или включите DEV_LOGIN_ENABLED для локальной разработки.</p>';
    } else {
      host.innerHTML = providers.map(function (p) {
        var icon = p.name === 'google'
          ? '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4Z"/><path fill="#34A853" d="M12 22c2.7 0 4.9-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.7-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.4 3-4.1 5.6-4.1Z"/></svg>'
          : '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10" fill="#FC3F1D"/><path fill="#fff" d="M13.6 6.5h-1.9c-1.6 0-2.6.9-2.6 2.2 0 1.5 1 2.1 2.2 2.6l.4.2-2.6 4.9h2l2.2-4.4v4.4h1.7V6.5Zm-1.7 3.4c-.7-.3-1.2-.6-1.2-1.2 0-.5.4-.8 1-.8h.2v2Z"/></svg>';
        return '<a class="auth__provider" href="' + esc(p.startUrl) + '?redirect=' + redirect + '">' +
          icon + '<span>Войти через ' + esc(p.label) + '</span></a>';
      }).join('');
    }

    var devForm = $('#dev-form');
    if (cfg && cfg.devLogin) {
      devForm.hidden = false;
      devForm.onsubmit = async function (ev) {
        ev.preventDefault();
        errorEl.hidden = true;
        var email = $('#dev-email').value.trim();
        try {
          await api('/api/v1/auth/dev-login', { method: 'POST', body: { email: email } });
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

  async function loadOverviewMeta() {
    try {
      var data = await api('/manage/api/overview');
      state.overview = data;
      $('#pill-store').textContent = 'store: ok';
      var pay = data.payments || {};
      var pill = $('#pill-payments');
      pill.textContent = 'payments: ' + (pay.provider || '—');
      pill.className = 'pill' + (pay.mock ? ' pill--warn' : '');
      if (data.updates) $('#pill-store').title = 'repo: ' + data.updates.repo;
    } catch (e) {
      $('#pill-store').textContent = 'store: error';
    }
  }

  // ------------------------------------------------------------- navigation
  async function navigate(view) {
    state.view = view;
    $$('.side__link').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === view); });
    var t = TITLES[view] || ['—', ''];
    $('#view-title').textContent = t[0];
    $('#view-subtitle').textContent = t[1];
    var host = $('#view');
    host.innerHTML = '<div class="panel"><div class="skeleton" style="height:18px;width:40%"></div><div class="skeleton" style="height:14px;width:70%;margin-top:12px"></div></div>';
    try {
      if (view === 'overview') await viewOverview(host);
      else if (view === 'users') await viewUsers(host);
      else if (view === 'orders') await viewOrders(host);
      else if (view === 'updates') await viewUpdates(host);
      else if (view === 'account') await viewAccount(host);
    } catch (e) {
      host.innerHTML = '<div class="panel"><p class="panel__hint">Не удалось загрузить данные: ' + esc(e.message) + '</p></div>';
      if (e.status === 401 || e.status === 403) toast(e.message, 'error');
    }
  }

  // ------------------------------------------------------------- overview
  async function viewOverview(host) {
    var data = state.overview || (state.overview = await api('/manage/api/overview'));
    var m = data.metrics || {};
    var sub = m.subscriptions || {};

    var cards = [
      ['Пользователи', m.usersTotal || 0, 'за 7 дней активны: ' + (m.usersActive7d || 0)],
      ['Активные сессии', m.sessionsActive || 0, 'не отозванные cookie-сессии'],
      ['Активные подписки', sub.activeSubscriptions || 0, 'истекают в течение 7 дней: ' + (sub.expiringWithin7Days || 0)],
      ['Оплачено заказов', m.paidOrderCount || 0, 'платящих пользователей: ' + (m.payingUsers || 0)],
      ['Выручка', moneyShort(m.revenueMinor), 'за 30 дней: ' + moneyShort(m.revenueLast30dMinor)],
      ['Первый платёж', m.firstPaymentAt ? new Date(m.firstPaymentAt).toLocaleDateString('ru-RU') : '—', 'последний: ' + (m.lastPaymentAt ? new Date(m.lastPaymentAt).toLocaleDateString('ru-RU') : '—')],
    ];

    var byStatus = m.ordersByStatus || {};
    var statusRows = Object.keys(byStatus).length
      ? Object.keys(byStatus).sort().map(function (k) {
          return '<tr><td>' + badge(k) + '</td><td class="mono">' + esc(byStatus[k]) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="2" class="empty">Заказов пока нет</td></tr>';

    var byPlan = m.revenueByPlanFormatted || {};
    var planRows = Object.keys(byPlan).length
      ? Object.keys(byPlan).sort().map(function (k) {
          var v = byPlan[k];
          return '<tr><td>' + esc(k) + '</td><td class="mono">' + esc(v.count) + '</td><td class="mono">' + esc(v.revenue) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="3" class="empty">Оплат пока нет</td></tr>';

    var events = m.eventsByType7d || {};
    var eventRows = Object.keys(events).length
      ? Object.keys(events).sort(function (a, b) { return events[b] - events[a]; }).slice(0, 12).map(function (k) {
          return '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + esc(events[k]) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="2" class="empty">Событий за 7 дней нет</td></tr>';

    host.innerHTML =
      '<div class="cards">' + cards.map(function (c) {
        return '<div class="card"><div class="card__label">' + esc(c[0]) + '</div>' +
          '<div class="card__value">' + esc(c[1]) + '</div>' +
          '<div class="card__meta">' + esc(c[2]) + '</div></div>';
      }).join('') + '</div>' +

      '<div class="grid-2">' +
        '<div class="panel"><div class="panel__head"><h3 class="panel__title">Выручка по тарифам</h3>' +
          '<span class="pill pill--mute">status = paid</span></div>' +
          '<div class="table-wrap"><table><thead><tr><th>Тариф</th><th>Оплат</th><th>Сумма</th></tr></thead>' +
          '<tbody>' + planRows + '</tbody></table></div>' +
          '<p class="panel__hint">Показатели считаются из таблицы orders (COUNT / MIN / SUM при status = paid) и не дублируются в subscriptions.</p></div>' +

        '<div class="panel"><div class="panel__head"><h3 class="panel__title">Заказы по статусам</h3></div>' +
          '<div class="table-wrap"><table><thead><tr><th>Статус</th><th>Количество</th></tr></thead>' +
          '<tbody>' + statusRows + '</tbody></table></div>' +
          '<p class="panel__hint">Подписки: активных ' + esc(sub.activeSubscriptions || 0) +
          ', истекших ' + esc(sub.expired || 0) + ', отменённых ' + esc(sub.cancelled || 0) +
          ', отозванных ' + esc(sub.revoked || 0) + '.</p></div>' +
      '</div>' +

      '<div class="panel"><div class="panel__head"><h3 class="panel__title">События за 7 дней</h3>' +
        '<span class="pill pill--mute">аудит</span></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Тип события</th><th>Количество</th></tr></thead>' +
        '<tbody>' + eventRows + '</tbody></table></div></div>' +

      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Инфраструктура</h3></div>' +
        '<div class="detail">' +
          row('Платёжный провайдер', esc((data.payments || {}).provider || '—') + ((data.payments || {}).mock ? ' <span class="pill pill--warn">mock — только dev</span>' : '')) +
          row('Канал обновлений', esc((data.updates || {}).enabled ? (data.updates || {}).repo : 'выключен')) +
          row('Поддержка', esc(data.supportEmail || '—')) +
        '</div></div>';
  }

  function row(k, v) {
    return '<div class="detail__row"><div class="detail__k">' + esc(k) + '</div><div class="detail__v">' + v + '</div></div>';
  }

  // ------------------------------------------------------------- users
  async function viewUsers(host) {
    var s = state.users;
    host.innerHTML =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Пользователи</h3>' +
        '<div class="toolbar">' +
          '<input class="input" id="users-q" placeholder="Поиск: email, имя или id" value="' + esc(s.q) + '" />' +
          '<button class="btn btn--ghost btn--sm" id="users-search">Найти</button>' +
        '</div></div>' +
        '<div id="users-table"></div></div>';

    $('#users-search').addEventListener('click', function () {
      s.q = $('#users-q').value.trim(); s.offset = 0; void loadUsers();
    });
    $('#users-q').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { s.q = ev.target.value.trim(); s.offset = 0; void loadUsers(); }
    });
    await loadUsers();
  }

  async function loadUsers() {
    var s = state.users;
    var box = $('#users-table');
    box.innerHTML = '<div class="skeleton" style="height:200px"></div>';
    var qs = new URLSearchParams({ limit: String(s.limit), offset: String(s.offset) });
    if (s.q) qs.set('q', s.q);
    var data = await api('/manage/api/users?' + qs.toString());
    s.items = data.items || [];
    s.total = data.total || 0;

    if (!s.items.length) {
      box.innerHTML = '<div class="empty">Ничего не найдено</div>';
      return;
    }

    box.innerHTML =
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Пользователь</th><th>Подписка</th><th>До</th><th>Оплачено</th><th>Первый платёж</th><th>Роль</th><th></th>' +
      '</tr></thead><tbody>' +
      s.items.map(function (u) {
        var sub = u.subscription || null;
        return '<tr class="is-clickable" data-user="' + esc(u.id) + '">' +
          '<td><div>' + esc(u.email || '(анонимизирован)') + '</div><div class="mono" style="color:var(--fg-mute);font-size:11.5px">' + esc(u.id) + '</div></td>' +
          '<td>' + badge(sub ? sub.status : 'none') + '</td>' +
          '<td class="mono">' + esc(sub && sub.expiresAt ? new Date(sub.expiresAt).toLocaleDateString('ru-RU') : '—') + '</td>' +
          '<td class="mono">' + esc(u.paidOrderCount) + ' · ' + esc(u.lifetime) + '</td>' +
          '<td class="mono">' + esc(u.firstPaymentAt ? new Date(u.firstPaymentAt).toLocaleDateString('ru-RU') : '—') + '</td>' +
          '<td>' + badge(u.role) + '</td>' +
          '<td class="td-actions"><button class="btn btn--ghost btn--sm" data-open="' + esc(u.id) + '">Открыть</button></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>' + pager(s, loadUsers);

    bindPager(s, loadUsers, box);
    $$('[data-open], tr.is-clickable', box).forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var id = el.dataset.open || el.dataset.user;
        if (id) void openUser(id);
      });
    });
  }

  function pager(s, reload) {
    void reload;
    var from = s.total ? s.offset + 1 : 0;
    var to = Math.min(s.offset + s.limit, s.total);
    return '<div class="pager"><span>' + esc(from) + '–' + esc(to) + ' из ' + esc(s.total) + '</span>' +
      '<button class="btn btn--ghost btn--sm" data-prev ' + (s.offset === 0 ? 'disabled' : '') + '>Назад</button>' +
      '<button class="btn btn--ghost btn--sm" data-next ' + (to >= s.total ? 'disabled' : '') + '>Вперёд</button></div>';
  }

  function bindPager(s, reload, box) {
    var prev = $('[data-prev]', box);
    var next = $('[data-next]', box);
    if (prev) prev.addEventListener('click', function () { s.offset = Math.max(0, s.offset - s.limit); void reload(); });
    if (next) next.addEventListener('click', function () { s.offset += s.limit; void reload(); });
  }

  async function openUser(id) {
    var data;
    try { data = await api('/manage/api/users/' + encodeURIComponent(id)); }
    catch (e) { toast(e.message, 'error'); return; }

    var u = data.user;
    var sub = data.subscription;
    var orders = data.orders || [];
    var sessions = data.sessions || [];

    var body =
      '<div class="detail">' +
        row('ID', '<span class="mono">' + esc(u.id) + '</span>') +
        row('Email', esc(u.email || '(удалён)')) +
        row('Имя', esc(u.name || '—')) +
        row('Роль', badge(u.role)) +
        row('Провайдеры', (u.identities || []).length ? (u.identities || []).map(function (i) { return badge(i.provider); }).join(' ') : '—') +
        row('Создан', date(u.createdAt)) +
        row('Последний вход', date(u.lastLoginAt)) +
        row('Удалён', u.deletedAt ? date(u.deletedAt) : '—') +
        row('Подписка', sub ? badge(sub.status) + ' <span class="mono">' + esc(sub.planId || '—') + '</span>' : badge('none')) +
        row('Действует до', sub && sub.expiresAt ? date(sub.expiresAt) : '—') +
        row('Источник права', sub && sub.source ? esc(sub.source) : '—') +
        row('Оплачено заказов', '<span class="mono">' + esc(data.billing.paidOrderCount) + '</span>') +
        row('Первый платёж', date(data.billing.firstPaymentAt)) +
        row('Сумма оплат', '<span class="mono">' + esc(data.billing.lifetime) + '</span>') +
      '</div>' +

      '<div class="modal__actions" style="justify-content:flex-start;margin-top:20px">' +
        '<button class="btn btn--primary btn--md" id="u-grant">Выдать подписку</button>' +
        '<button class="btn btn--danger btn--md" id="u-revoke">Отозвать доступ</button>' +
        '<button class="btn btn--ghost btn--md" id="u-role">' + (u.role === 'admin' ? 'Снять администратора' : 'Сделать администратором') + '</button>' +
      '</div>' +

      '<h4 style="margin:26px 0 10px;font-size:15px">Заказы (' + orders.length + ')</h4>' +
      (orders.length
        ? '<div class="table-wrap"><table><thead><tr><th>Заказ</th><th>Тариф</th><th>Сумма</th><th>Статус</th><th>Создан</th><th>Оплачен</th></tr></thead><tbody>' +
          orders.map(function (o) {
            return '<tr><td class="mono" style="font-size:11.5px">' + esc(o.id) + '</td>' +
              '<td>' + esc(o.planId) + '</td><td class="mono">' + esc(o.amount) + '</td>' +
              '<td>' + badge(o.status) + '</td><td class="mono">' + esc(date(o.createdAt)) + '</td>' +
              '<td class="mono">' + esc(date(o.paidAt)) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty">Заказов нет</div>') +

      '<h4 style="margin:26px 0 10px;font-size:15px">Сессии (' + sessions.length + ')</h4>' +
      (sessions.length
        ? '<div class="table-wrap"><table><thead><tr><th>Создана</th><th>Последняя активность</th><th>Истекает</th><th>Статус</th></tr></thead><tbody>' +
          sessions.slice(0, 10).map(function (ss) {
            var st = ss.revokedAt ? 'revoked' : new Date(ss.expiresAt) > new Date() ? 'active' : 'expired';
            return '<tr><td class="mono">' + esc(date(ss.createdAt)) + '</td><td class="mono">' + esc(date(ss.lastSeenAt)) + '</td>' +
              '<td class="mono">' + esc(date(ss.expiresAt)) + '</td><td>' + badge(st) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty">Сессий нет</div>');

    modal(u.email || u.name || 'Пользователь', body, [{ label: 'Закрыть', onClick: closeModal }]);

    $('#u-grant').addEventListener('click', function () { openGrant(u.id, u.email); });
    $('#u-revoke').addEventListener('click', function () { void revokeSubscription(u.id, u.email); });
    $('#u-role').addEventListener('click', function () { void changeRole(u.id, u.role === 'admin' ? 'user' : 'admin'); });
  }

  function openGrant(userId, email) {
    var plans = (state.overview && state.overview.plans) || [{ id: 'monthly', title: 'Месяц' }, { id: 'yearly', title: 'Год' }];
    var body =
      '<div class="field"><label for="g-plan">Тариф</label><select class="select" id="g-plan">' +
        plans.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.title) + ' (' + esc(p.id) + ')</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label for="g-note">Комментарий (в аудит)</label>' +
        '<input class="input" id="g-note" maxlength="200" placeholder="Например: компенсация за сбой" /></div>' +
      '<p class="panel__hint">Grant помечается источником <span class="mono">admin_grant</span> и оплатой не считается. ' +
        'Пользователь: ' + esc(email || userId) + '</p>';

    modal('Выдать подписку', body, [
      { label: 'Отмена', onClick: function () { void openUser(userId); } },
      {
        label: 'Выдать', kind: 'primary', onClick: async function (btn) {
          btn.disabled = true;
          try {
            await api('/manage/api/users/' + encodeURIComponent(userId) + '/subscription/grant', {
              method: 'POST',
              body: { planId: $('#g-plan').value, note: $('#g-note').value || undefined },
            });
            closeModal();
            toast('Подписка выдана', 'ok');
            state.overview = null;
            await navigate(state.view);
          } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
        },
      },
    ]);
  }

  async function revokeSubscription(userId, email) {
    modal('Отозвать доступ', '<p>Доступ пользователя <b>' + esc(email || userId) + '</b> будет закрыт немедленно ' +
      '(статус <span class="mono">revoked</span>). Действие попадает в аудит.</p>', [
      { label: 'Отмена', onClick: closeModal },
      {
        label: 'Отозвать', kind: 'danger', onClick: async function (btn) {
          btn.disabled = true;
          try {
            await api('/manage/api/users/' + encodeURIComponent(userId) + '/subscription/revoke', {
              method: 'POST', body: { note: 'manual revoke from /manage' },
            });
            closeModal(); toast('Доступ отозван', 'ok');
            state.overview = null; await navigate(state.view);
          } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
        },
      },
    ]);
  }

  async function changeRole(userId, role) {
    try {
      await api('/manage/api/users/' + encodeURIComponent(userId), { method: 'PATCH', body: { role: role } });
      toast('Роль обновлена: ' + role, 'ok');
      state.overview = null;
      closeModal();
      await navigate(state.view);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ------------------------------------------------------------- orders
  async function viewOrders(host) {
    var s = state.orders;
    host.innerHTML =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Заказы</h3>' +
        '<div class="toolbar"><select class="select" id="orders-status">' +
          ['', 'created', 'pending', 'paid', 'failed', 'expired', 'refunded'].map(function (v) {
            return '<option value="' + esc(v) + '"' + (s.status === v ? ' selected' : '') + '>' + esc(v || 'все статусы') + '</option>';
          }).join('') +
        '</select><button class="btn btn--ghost btn--sm" id="orders-apply">Применить</button></div></div>' +
        '<div id="orders-table"></div></div>';

    $('#orders-apply').addEventListener('click', function () {
      s.status = $('#orders-status').value; s.offset = 0; void loadOrders();
    });
    await loadOrders();
  }

  async function loadOrders() {
    var s = state.orders;
    var box = $('#orders-table');
    box.innerHTML = '<div class="skeleton" style="height:200px"></div>';
    var qs = new URLSearchParams({ limit: String(s.limit), offset: String(s.offset) });
    if (s.status) qs.set('status', s.status);
    var data = await api('/manage/api/orders?' + qs.toString());
    s.items = data.items || [];
    s.total = data.total || 0;

    if (!s.items.length) { box.innerHTML = '<div class="empty">Заказов нет</div>'; return; }

    box.innerHTML =
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Заказ</th><th>Пользователь</th><th>Тариф</th><th>Сумма</th><th>Дней</th><th>Статус</th><th>Провайдер</th><th>Создан</th><th></th>' +
      '</tr></thead><tbody>' +
      s.items.map(function (o) {
        return '<tr>' +
          '<td class="mono" style="font-size:11.5px">' + esc(o.id) + '</td>' +
          '<td>' + esc(o.userEmail || o.userName || '—') + '<div class="mono" style="color:var(--fg-mute);font-size:11px">' + esc(o.userId) + '</div></td>' +
          '<td>' + esc(o.planId) + '</td>' +
          '<td class="mono">' + esc(o.amount) + '</td>' +
          '<td class="mono">' + esc(o.days) + '</td>' +
          '<td>' + badge(o.status) + '</td>' +
          '<td>' + esc(o.provider) + '</td>' +
          '<td class="mono">' + esc(date(o.createdAt)) + '</td>' +
          '<td class="td-actions">' +
            (o.status === 'paid'
              ? '<button class="btn btn--danger btn--sm" data-refund="' + esc(o.id) + '">Возврат</button>'
              : '<button class="btn btn--ghost btn--sm" data-user-open="' + esc(o.userId) + '">Пользователь</button>') +
          '</td></tr>';
      }).join('') + '</tbody></table></div>' + pager(s, loadOrders);

    bindPager(s, loadOrders, box);
    $$('[data-refund]', box).forEach(function (b) {
      b.addEventListener('click', function () { void refundOrder(b.dataset.refund); });
    });
    $$('[data-user-open]', box).forEach(function (b) {
      b.addEventListener('click', function () { void openUser(b.dataset.userOpen); });
    });
  }

  async function refundOrder(orderId) {
    modal('Оформить возврат', '<p>Заказ <span class="mono">' + esc(orderId) + '</span> получит статус ' +
      '<span class="mono">refunded</span>, а подписка пользователя будет закрыта (доступ прекращается немедленно).</p>', [
      { label: 'Отмена', onClick: closeModal },
      {
        label: 'Оформить возврат', kind: 'danger', onClick: async function (btn) {
          btn.disabled = true;
          try {
            await api('/manage/api/orders/' + encodeURIComponent(orderId) + '/refund', { method: 'POST', body: {} });
            closeModal(); toast('Возврат оформлен', 'ok');
            state.overview = null; await loadOrders();
          } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
        },
      },
    ]);
  }

  // ------------------------------------------------------------- updates
  async function viewUpdates(host) {
    var data = await api('/manage/api/updates');
    state.updates = data;
    var releases = data.releases || [];

    host.innerHTML =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Канал обновлений</h3>' +
        '<div class="toolbar">' +
          '<button class="btn btn--ghost btn--sm" id="u-refresh">Обновить из GitHub</button>' +
        '</div></div>' +
        '<div class="grid-2">' +
          '<div class="field"><label for="u-channel">Канал</label>' +
            '<select class="select" id="u-channel">' +
              '<option value="stable"' + (data.channel === 'stable' ? ' selected' : '') + '>stable</option>' +
              '<option value="beta"' + (data.channel === 'beta' ? ' selected' : '') + '>beta</option>' +
            '</select></div>' +
          '<div class="field"><label for="u-min">Минимальная поддерживаемая версия (X.Y.Z)</label>' +
            '<input class="input mono" id="u-min" value="' + esc(data.minSupportedVersion || '') + '" placeholder="1.0.0" /></div>' +
        '</div>' +
        '<div class="modal__actions" style="justify-content:flex-start">' +
          '<button class="btn btn--primary btn--md" id="u-save">Сохранить</button>' +
          '<span class="pill pill--mute">repo: ' + esc(data.repo) + '</span>' +
          '<span class="pill ' + (data.enabled ? '' : 'pill--warn') + '">updates: ' + esc(data.enabled ? 'on' : 'off') + '</span>' +
        '</div>' +
        '<p class="panel__hint">Клиент получает только уведомление и ссылку на страницу релиза. ' +
          'Автоустановка запрещена: поле <span class="mono">autoInstall</span> всегда <span class="mono">false</span>. ' +
          'Принимаются только числовые версии <span class="mono">X.Y.Z</span> / <span class="mono">vX.Y.Z</span>.</p></div>' +

      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Релизы в кэше</h3>' +
        '<span class="pill pill--mute">' + releases.length + '</span></div>' +
        (releases.length
          ? '<div class="table-wrap"><table><thead><tr><th>Тег</th><th>Версия</th><th>Канал</th><th>Название</th><th>Опубликован</th><th>Ассетов</th><th></th></tr></thead><tbody>' +
            releases.map(function (r) {
              return '<tr><td class="mono">' + esc(r.tagName) + '</td><td class="mono">' + esc(r.version) + '</td>' +
                '<td>' + badge(r.channel) + '</td><td>' + esc(r.name || '—') + '</td>' +
                '<td class="mono">' + esc(date(r.publishedAt)) + '</td><td class="mono">' + esc(r.assets) + '</td>' +
                '<td class="td-actions">' + (r.htmlUrl ? '<a class="btn btn--ghost btn--sm" href="' + esc(r.htmlUrl) + '" target="_blank" rel="noopener noreferrer">Открыть</a>' : '') + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty">Релизы ещё не загружены. Нажмите «Обновить из GitHub».</div>') +
      '</div>';

    $('#u-refresh').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Загружаем…';
      try {
        var res = await api('/manage/api/updates/refresh', { method: 'POST', body: {} });
        toast('Загружено релизов: ' + res.fetched, 'ok');
        await viewUpdates(host);
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false; btn.textContent = 'Обновить из GitHub';
      }
    });

    $('#u-save').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true;
      try {
        var min = $('#u-min').value.trim();
        await api('/manage/api/updates', {
          method: 'PATCH',
          body: { channel: $('#u-channel').value, minSupportedVersion: min === '' ? null : min },
        });
        toast('Настройки канала сохранены', 'ok');
        await viewUpdates(host);
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------- account
  async function viewAccount(host) {
    var me = await api('/api/v1/me');
    var u = me.user;
    host.innerHTML =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Ваш аккаунт</h3>' +
        '<span class="pill pill--info">' + esc(u.role) + '</span></div>' +
        '<div class="detail">' +
          row('ID', '<span class="mono">' + esc(u.id) + '</span>') +
          row('Email', esc(u.email || '—')) +
          row('Имя', esc(u.name || '—')) +
          row('Создан', date(u.createdAt)) +
          row('Подписка', badge((me.subscription || {}).status)) +
          row('Оплачено заказов', '<span class="mono">' + esc((me.billing || {}).paidOrderCount || 0) + '</span>') +
        '</div>' +
        '<div class="modal__actions" style="justify-content:flex-start">' +
          '<a class="btn btn--ghost btn--md" href="/">На витрину</a>' +
          '<button class="btn btn--danger btn--md" id="a-delete">Удалить мой аккаунт</button>' +
        '</div>' +
        '<p class="panel__hint">Удаление (DELETE /api/v1/me) анонимизирует профиль, отзывает все сессии и закрывает доступ. ' +
          'Заказы остаются в бухгалтерии в обезличенном виде.</p></div>';

    $('#a-delete').addEventListener('click', function () {
      modal('Удалить аккаунт', '<p>Профиль будет анонимизирован, все сессии отозваны, доступ закрыт. ' +
        'Действие необратимо.</p>', [
        { label: 'Отмена', onClick: closeModal },
        {
          label: 'Удалить', kind: 'danger', onClick: async function (btn) {
            btn.disabled = true;
            try {
              await api('/api/v1/me', { method: 'DELETE' });
              closeModal();
              toast('Аккаунт удалён', 'ok');
              setTimeout(function () { window.location.href = '/'; }, 900);
            } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
          },
        },
      ]);
    });
  }

  // ------------------------------------------------------------- events
  function bindGlobal() {
    $$('.side__link').forEach(function (b) {
      b.addEventListener('click', function () { void navigate(b.dataset.view); });
    });
    $('#refresh').addEventListener('click', async function () {
      state.overview = null;
      await loadOverviewMeta();
      await navigate(state.view);
    });
    $('#logout').addEventListener('click', async function () {
      try { await api('/api/v1/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
      window.location.href = '/manage';
    });
    $('#denied-logout').addEventListener('click', async function () {
      try { await api('/api/v1/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
      window.location.href = '/manage';
    });
    $$('#modal [data-close]').forEach(function (el) { el.addEventListener('click', closeModal); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('#modal').hidden) closeModal();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindGlobal();
    void boot();
  });
})();
