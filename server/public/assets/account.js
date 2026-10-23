/* SHELTER /account — личный кабинет пользователя. Vanilla JS (CSP: script-src 'self'). */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var state = { user: null, subscription: null, plans: [], view: 'subscription', orders: [], sessions: [] };

  var TITLES = {
    subscription: ['Подписка', 'Статус SHELTER Premium, проверенный сервером'],
    orders: ['История заказов', 'Все ваши заказы и оплаты'],
    sessions: ['Устройства', 'Активные сессии и их отзыв'],
    profile: ['Профиль', 'Ваши данные и удаление аккаунта'],
  };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(minor, currency) {
    var n = Number(minor || 0) / 100;
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ' + (currency === 'RUB' || !currency ? '₽' : currency);
  }
  function date(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function badge(v) { return '<span class="badge badge--' + esc(v || 'none') + '">' + esc(v || 'none') + '</span>'; }
  function toast(msg, kind) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 4200);
  }
  async function api(path, opts) {
    var o = opts || {};
    var init = { method: o.method || 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' };
    if (o.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(o.body); }
    var res = await fetch(path, init);
    var text = await res.text();
    var data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) {
      var err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  function show(screen) {
    ['screen-auth', 'screen-app'].forEach(function (id) { $('#' + id).hidden = id !== screen; });
  }

  // ---------------------------------------------------------------- bootstrap
  async function boot() {
    var session = null;
    try { session = await api('/api/v1/auth/session'); } catch (e) { session = null; }
    if (!session || !session.authenticated) {
      state.user = null;
      await renderAuth();
      show('screen-auth');
      return;
    }
    state.user = session.user;
    show('screen-app');
    $('#side-user').textContent = session.user.email || session.user.name || 'Аккаунт';
    $('#admin-link').hidden = session.user.role !== 'admin';

    try {
      var [sub, plans] = await Promise.all([api('/api/v1/me/subscription'), api('/api/v1/plans')]);
      state.subscription = sub;
      state.plans = (plans && plans.plans) || [];
    } catch (e) {
      state.subscription = { active: false, status: 'none', reason: 'verification_failed' };
      state.plans = [];
    }
    updateStatusPill();
    await navigate(state.view);
  }

  function updateStatusPill() {
    var pill = $('#pill-status');
    var s = state.subscription || {};
    if (s.active) {
      pill.textContent = 'Premium активен';
      pill.className = 'pill';
    } else {
      pill.textContent = 'Premium не активен';
      pill.className = 'pill pill--warn';
    }
  }

  async function renderAuth() {
    var host = $('#auth-providers');
    var errorEl = $('#auth-error');
    errorEl.hidden = true;
    host.innerHTML = '<div class="skeleton" style="height:46px"></div>';
    var cfg = null;
    try { cfg = await api('/api/v1/auth/providers'); } catch (e) { cfg = null; }
    var providers = (cfg && cfg.providers) || [];
    var redirect = encodeURIComponent('/account');

    if (!providers.length && !(cfg && cfg.devLogin)) {
      host.innerHTML = '<p class="auth__hint">Способы входа не настроены на сервере.</p>';
    } else {
      host.innerHTML = providers.map(function (p) {
        var icon = p.name === 'google'
          ? '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4Z"/><path fill="#34A853" d="M12 22c2.7 0 4.9-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.7-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.4 3-4.1 5.6-4.1Z"/></svg>'
          : '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10" fill="#FC3F1D"/><path fill="#fff" d="M13.6 6.5h-1.9c-1.6 0-2.6.9-2.6 2.2 0 1.5 1 2.1 2.2 2.6l.4.2-2.6 4.9h2l2.2-4.4v4.4h1.7V6.5Zm-1.7 3.4c-.7-.3-1.2-.6-1.2-1.2 0-.5.4-.8 1-.8h.2v2Z"/></svg>';
        return '<a class="auth__provider" href="' + esc(p.startUrl) + '?redirect=' + redirect + '">' + icon +
          '<span>Продолжить через ' + esc(p.label) + '</span></a>';
      }).join('');
    }

    var devForm = $('#dev-form');
    if (cfg && cfg.devLogin) {
      devForm.hidden = false;
      devForm.onsubmit = async function (ev) {
        ev.preventDefault();
        errorEl.hidden = true;
        try {
          await api('/api/v1/auth/dev-login', { method: 'POST', body: { email: $('#dev-email').value.trim() } });
          await boot();
        } catch (e) { errorEl.textContent = e.message; errorEl.hidden = false; }
      };
    } else { devForm.hidden = true; }
  }

  // ---------------------------------------------------------------- navigation
  async function navigate(view) {
    state.view = view;
    $$('.side__link').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === view); });
    var t = TITLES[view] || ['—', ''];
    $('#view-title').textContent = t[0];
    $('#view-subtitle').textContent = t[1];
    var host = $('#view');
    host.innerHTML = '<div class="panel"><div class="skeleton" style="height:18px;width:40%"></div></div>';
    try {
      if (view === 'subscription') await viewSubscription(host);
      else if (view === 'orders') await viewOrders(host);
      else if (view === 'sessions') await viewSessions(host);
      else if (view === 'profile') await viewProfile(host);
    } catch (e) {
      host.innerHTML = '<div class="panel"><p class="panel__hint">Ошибка: ' + esc(e.message) + '</p></div>';
      if (e.status === 401) { await boot(); }
    }
  }

  function daysLeft(iso) {
    if (!iso) return 0;
    var ms = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86400000));
  }

  async function viewSubscription(host) {
    var s = state.subscription || { active: false, status: 'none', reason: 'no_subscription' };
    var reasonText = {
      paid: 'Доступ подтверждён оплаченной подпиской.',
      granted: 'Доступ выдан администратором (не является оплатой).',
      no_subscription: 'Подписка ещё не оформлена.',
      expired: 'Срок подписки истёк. Продлите, чтобы вернуть доступ.',
      cancelled: 'Подписка отменена.',
      refunded: 'По подписке оформлен возврат — доступ закрыт.',
      revoked: 'Доступ отозван администратором.',
      invalid_data: 'Данные подписки повреждены. Доступ не подтверждён.',
      verification_failed: 'Сервер не смог подтвердить подписку. Доступ не выдан (fail-closed).',
      unauthenticated: 'Требуется вход.',
    }[s.reason] || '';

    var statusHtml =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Статус Premium</h3>' +
        (s.active ? '<span class="pill">активен</span>' : '<span class="pill pill--warn">не активен</span>') +
      '</div><div class="detail">' +
        row('Решение сервера', s.active ? '<b style="color:var(--green)">доступ подтверждён</b>' : '<b style="color:var(--red)">доступ не подтверждён</b>') +
        row('Статус', badge(s.status)) +
        row('Причина', esc(reasonText) + ' <span class="mono">(' + esc(s.reason || '—') + ')</span>') +
        row('Тариф', s.plan && s.plan.title ? esc(s.plan.title) + ' <span class="mono">(' + esc(s.planId) + ')</span>' : '—') +
        row('Действует до', s.expiresAt ? date(s.expiresAt) + ' <span class="mono">(осталось ' + daysLeft(s.expiresAt) + ' дн.)</span>' : '—') +
        row('Проверено', '<span class="mono">' + date(s.checkedAt) + '</span>') +
      '</div>' +
      '<p class="panel__hint">Это ответ серверного метода <span class="mono">premium.status</span>. ' +
        'Значения, сохранённые в браузере, доказательством подписки не являются.</p></div>';

    var plansHtml =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">' +
        (s.active ? 'Продлить подписку' : 'Оформить подписку') + '</h3>' +
        '<span class="pill pill--mute">оплата на стороне провайдера</span></div>' +
        (state.plans.length
          ? '<div class="cards">' + state.plans.map(function (p) {
              var featured = p.id === 'yearly';
              return '<div class="card"><div class="card__label">' + esc(p.title) + (p.badge ? ' · ' + esc(p.badge) : '') + '</div>' +
                '<div class="card__value">' + money(p.amountMinor, p.currency) + '</div>' +
                '<div class="card__meta">' + p.days + ' дн. доступа' +
                  (p.compareAtMinor ? ' · вместо <s>' + money(p.compareAtMinor, p.currency) + '</s>' : '') + '</div>' +
                '<div style="margin-top:14px"><button class="btn ' + (featured ? 'btn--primary' : 'btn--ghost') +
                  ' btn--md" data-buy="' + esc(p.id) + '">' + (s.active ? 'Продлить' : 'Оплатить') + '</button></div></div>';
            }).join('') + '</div>'
          : '<div class="empty">Каталог тарифов недоступен</div>') +
        '<p class="panel__hint">Автопродления нет: доступ действует ровно оплаченный срок. ' +
          'После оплаты провайдер отправит уведомление на сервер, и статус обновится автоматически.</p></div>';

    host.innerHTML = statusHtml + plansHtml;

    $$('[data-buy]', host).forEach(function (b) {
      b.addEventListener('click', function () { void checkout(b.dataset.buy, b); });
    });
  }

  function row(k, v) {
    return '<div class="detail__row"><div class="detail__k">' + esc(k) + '</div><div class="detail__v">' + v + '</div></div>';
  }

  async function checkout(planId, btn) {
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = 'Создаём заказ…';
    try {
      var order = await api('/api/v1/checkout', { method: 'POST', body: { planId: planId } });
      if (order.checkoutUrl) {
        toast('Заказ создан: ' + order.orderId, 'ok');
        window.location.href = order.checkoutUrl;
        return;
      }
      throw new Error('Сервер не вернул ссылку на оплату');
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  async function viewOrders(host) {
    var data = await api('/api/v1/me/orders');
    state.orders = data.orders || [];
    host.innerHTML =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Заказы</h3>' +
        '<span class="pill pill--mute">' + state.orders.length + '</span></div>' +
        (state.orders.length
          ? '<div class="table-wrap"><table><thead><tr><th>Заказ</th><th>Тариф</th><th>Сумма</th><th>Дней</th><th>Статус</th><th>Создан</th><th>Оплачен</th></tr></thead><tbody>' +
            state.orders.map(function (o) {
              return '<tr><td class="mono" style="font-size:11.5px">' + esc(o.id) + '</td>' +
                '<td>' + esc(o.planId) + '</td><td class="mono">' + esc(o.amount) + '</td>' +
                '<td class="mono">' + esc(o.days) + '</td><td>' + badge(o.status) + '</td>' +
                '<td class="mono">' + esc(date(o.createdAt)) + '</td><td class="mono">' + esc(date(o.paidAt)) + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty">Заказов пока нет</div>') + '</div>';
  }

  async function viewSessions(host) {
    var data = await api('/api/v1/me/sessions');
    state.sessions = data.sessions || [];
    host.innerHTML =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Устройства и сессии</h3>' +
        '<button class="btn btn--danger btn--sm" id="revoke-all">Отозвать все</button></div>' +
        (state.sessions.length
          ? '<div class="table-wrap"><table><thead><tr><th>Создана</th><th>Активность</th><th>Истекает</th><th>Статус</th><th></th></tr></thead><tbody>' +
            state.sessions.map(function (ss) {
              var active = !ss.revokedAt && new Date(ss.expiresAt) > new Date();
              return '<tr><td class="mono">' + esc(date(ss.createdAt)) + '</td>' +
                '<td class="mono">' + esc(date(ss.lastSeenAt)) + '</td>' +
                '<td class="mono">' + esc(date(ss.expiresAt)) + '</td>' +
                '<td>' + badge(ss.revokedAt ? 'revoked' : active ? 'active' : 'expired') +
                  (ss.current ? ' <span class="pill pill--info">это устройство</span>' : '') + '</td>' +
                '<td class="td-actions">' + (active && !ss.current
                  ? '<button class="btn btn--ghost btn--sm" data-revoke="' + esc(ss.id) + '">Отозвать</button>' : '') + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty">Сессий нет</div>') + '</div>';

    $$('[data-revoke]', host).forEach(function (b) {
      b.addEventListener('click', async function () {
        try {
          await api('/api/v1/me/sessions/revoke', { method: 'POST', body: { sessionId: b.dataset.revoke } });
          toast('Сессия отозвана', 'ok');
          await viewSessions(host);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    $('#revoke-all').addEventListener('click', async function () {
      try {
        var res = await api('/api/v1/me/sessions/revoke', { method: 'POST', body: {} });
        toast('Отозвано сессий: ' + res.revoked, 'ok');
        setTimeout(function () { window.location.href = '/account'; }, 800);
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  async function viewProfile(host) {
    var me = await api('/api/v1/me');
    var u = me.user;
    host.innerHTML =
      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Профиль</h3>' + badge(u.role) + '</div>' +
        '<div class="field"><label for="p-name">Имя</label>' +
          '<input class="input" id="p-name" maxlength="120" value="' + esc(u.name || '') + '" /></div>' +
        '<div class="modal__actions" style="justify-content:flex-start">' +
          '<button class="btn btn--primary btn--md" id="p-save">Сохранить</button>' +
        '</div>' +
        '<div class="detail" style="margin-top:18px">' +
          row('ID', '<span class="mono">' + esc(u.id) + '</span>') +
          row('Email', esc(u.email || '—')) +
          row('Аккаунт создан', date(u.createdAt)) +
          row('Оплачено заказов', '<span class="mono">' + esc((me.billing || {}).paidOrderCount || 0) + '</span>') +
          row('Первый платёж', date((me.billing || {}).firstPaymentAt)) +
        '</div></div>' +

      '<div class="panel"><div class="panel__head"><h3 class="panel__title">Удаление данных</h3>' +
        '<span class="pill pill--warn">необратимо</span></div>' +
        '<p class="panel__hint">Запрос <span class="mono">DELETE /api/v1/me</span> анонимизирует профиль, ' +
        'удаляет связи с OAuth-провайдерами, отзывает все сессии и закрывает доступ к Premium. ' +
        'Обезличенная бухгалтерия заказов сохраняется.</p>' +
        '<div class="modal__actions" style="justify-content:flex-start">' +
          '<button class="btn btn--danger btn--md" id="p-delete">Удалить аккаунт</button>' +
        '</div></div>';

    $('#p-save').addEventListener('click', async function (ev) {
      ev.currentTarget.disabled = true;
      try {
        await api('/api/v1/me', { method: 'PATCH', body: { name: $('#p-name').value.trim() || null } });
        toast('Профиль сохранён', 'ok');
        await boot();
      } catch (e) { toast(e.message, 'error'); ev.currentTarget.disabled = false; }
    });

    $('#p-delete').addEventListener('click', function () {
      if (!window.confirm('Удалить аккаунт и закрыть доступ? Действие необратимо.')) return;
      void (async function () {
        try {
          await api('/api/v1/me', { method: 'DELETE' });
          toast('Аккаунт удалён', 'ok');
          setTimeout(function () { window.location.href = '/'; }, 900);
        } catch (e) { toast(e.message, 'error'); }
      })();
    });
  }

  function bindGlobal() {
    $$('.side__link').forEach(function (b) { b.addEventListener('click', function () { void navigate(b.dataset.view); }); });
    $('#refresh').addEventListener('click', function () { void boot(); });
    $('#logout').addEventListener('click', async function () {
      try { await api('/api/v1/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
      window.location.href = '/account';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindGlobal();
    var params = new URLSearchParams(window.location.search);
    var wanted = params.get('plan');
    void boot().then(function () {
      if (wanted && state.user) {
        navigate('subscription').then(function () {
          var btn = document.querySelector('[data-buy="' + wanted + '"]');
          if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    });
  });
})();
