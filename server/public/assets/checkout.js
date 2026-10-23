/* SHELTER /checkout/* — симуляция оплаты (dev) и страница подтверждения. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var params = new URLSearchParams(window.location.search);
  var orderId = params.get('order') || '';
  var returnUrl = params.get('return') || '/checkout/success?order=' + encodeURIComponent(orderId);

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
  function row(k, v) {
    return '<div class="detail__row"><div class="detail__k">' + esc(k) + '</div><div class="detail__v">' + v + '</div></div>';
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

  async function loadOrder() {
    if (!orderId) return null;
    try { return await api('/api/v1/checkout/' + encodeURIComponent(orderId)); }
    catch (e) { return null; }
  }

  function renderOrder(data) {
    if (!data || !data.order) {
      return row('Заказ', 'не найден или нет доступа');
    }
    var o = data.order;
    var s = data.subscription || {};
    return row('Заказ', '<span class="mono">' + esc(o.id) + '</span>') +
      row('Тариф', esc(o.planId)) +
      row('Сумма', '<span class="mono">' + esc(money(o.amountMinor, o.currency)) + '</span>') +
      row('Статус заказа', badge(o.status)) +
      row('Создан', esc(date(o.createdAt))) +
      row('Оплачен', esc(date(o.paidAt))) +
      row('Premium', s.active
        ? '<b style="color:var(--green)">подтверждён сервером</b> до ' + esc(date(s.expiresAt))
        : '<b style="color:var(--red)">не подтверждён</b> <span class="mono">(' + esc(s.reason || s.status) + ')</span>');
  }

  // ------------------------------------------------------------- mock-оплата
  async function initMock() {
    var details = $('#details');
    var hint = $('#hint');
    var pay = $('#pay');
    details.innerHTML = '<div class="skeleton" style="height:80px"></div>';

    var data = await loadOrder();
    if (!data) {
      details.innerHTML = row('Заказ', 'не найден, или вы не вошли в аккаунт');
      pay.disabled = true;
      hint.textContent = 'Откройте /account, войдите и создайте заказ заново.';
      return;
    }
    details.innerHTML = renderOrder(data);
    if (data.order.status === 'paid') {
      pay.disabled = true;
      pay.textContent = 'Уже оплачен';
      hint.textContent = 'Заказ оплачен. Статус Premium виден в личном кабинете.';
      return;
    }
    hint.textContent = 'Симуляция помечает заказ оплаченным на сервере и продлевает подписку на срок тарифа.';

    pay.addEventListener('click', async function () {
      pay.disabled = true;
      pay.textContent = 'Обрабатываем…';
      try {
        await api('/api/v1/mock/payments/' + encodeURIComponent(orderId) + '/succeed', { method: 'POST', body: {} });
        var fresh = await loadOrder();
        details.innerHTML = renderOrder(fresh);
        hint.textContent = 'Готово. Перенаправляем…';
        setTimeout(function () { window.location.href = returnUrl || '/account'; }, 900);
      } catch (e) {
        pay.disabled = false;
        pay.textContent = 'Оплатить (симуляция)';
        hint.textContent = 'Ошибка: ' + e.message;
      }
    });
  }

  // ------------------------------------------------------- страница успеха
  async function initSuccess() {
    var title = $('#title');
    var details = $('#details');
    var recheck = $('#recheck');
    var attempts = 0;

    async function poll() {
      var data = await loadOrder();
      details.innerHTML = renderOrder(data);
      var sub = data && data.subscription;
      if (sub && sub.active) {
        title.textContent = 'Оплата подтверждена';
        recheck.hidden = true;
        return true;
      }
      if (data && data.order && data.order.status === 'paid') {
        title.textContent = 'Платёж получен, обновляем статус…';
      } else {
        title.textContent = 'Ожидание подтверждения';
      }
      return false;
    }

    var done = await poll();
    if (!done) {
      // Уведомление от провайдера может прийти позже возврата пользователя.
      var timer = setInterval(async function () {
        attempts++;
        var ok = await poll();
        if (ok || attempts >= 10) clearInterval(timer);
      }, 2000);
    }

    recheck.addEventListener('click', async function () {
      recheck.disabled = true;
      await poll();
      recheck.disabled = false;
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if ($('#pay')) void initMock();
    else if ($('#recheck')) void initSuccess();
  });
})();
