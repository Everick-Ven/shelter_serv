/* SHELTER — витрина. Чистый JS без сборки (CSP: script-src 'self'). */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function api(path) {
    try {
      var res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // одно движение появления блоков
  function initReveal() {
    var items = document.querySelectorAll('section .wrap, .hero__grid > *');
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
    items.forEach(function (el) {
      el.classList.add('reveal');
      io.observe(el);
    });
  }

  // счётчик блокировок в фрагменте интерфейса
  function initBlockedCounter() {
    var el = $('#blocked-count');
    if (!el) return;
    var target = parseInt(el.getAttribute('data-target') || '0', 10) || 0;
    var started = false;
    var run = function () {
      if (started) return;
      started = true;
      var t0 = null;
      var dur = 1200;
      var step = function (ts) {
        if (!t0) t0 = ts;
        var k = Math.min(1, (ts - t0) / dur);
        var eased = 1 - Math.pow(1 - k, 3);
        el.textContent = Math.round(target * eased).toLocaleString('ru-RU');
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (!('IntersectionObserver' in window)) { run(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { run(); io.disconnect(); }
      });
    }, { threshold: 0.4 });
    io.observe(el);
  }

  function money(minor, currency) {
    var v = (minor / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    return v + ' ' + (currency === 'RUB' ? '₽' : currency);
  }

  async function renderPlans() {
    var host = $('#plans');
    if (!host) return;
    var data = await api('/api/v1/plans');
    if (!data || !Array.isArray(data.plans) || !data.plans.length) {
      host.innerHTML = '<p class="plans__loading">Тарифы временно недоступны.</p>';
      return;
    }
    var order = { yearly: 0, monthly: 1 };
    var plans = data.plans.slice().sort(function (a, b) {
      return (order[a.id] === undefined ? 9 : order[a.id]) - (order[b.id] === undefined ? 9 : order[b.id]);
    });
    host.innerHTML = plans.map(function (p) {
      var featured = p.id === 'yearly';
      var per = p.days >= 365 ? 'в год · ' + p.days + ' дн. доступа' : 'в месяц · ' + p.days + ' дн. доступа';
      return '<article class="plan' + (featured ? ' plan--featured' : '') + '">' +
        '<div class="plan__title">' + escapeHtml(p.title) + '</div>' +
        '<div class="plan__price">' + money(p.amountMinor, p.currency) +
          (p.compareAtMinor ? '<s>' + money(p.compareAtMinor, p.currency) + '</s>' : '') + '</div>' +
        '<div class="plan__per">' + per + '</div>' +
        '<ul class="plan__features">' +
          (p.features || []).map(function (f) { return '<li>' + escapeHtml(f) + '</li>'; }).join('') +
        '</ul>' +
        '<a class="cta" href="/account?plan=' + encodeURIComponent(p.id) + '">Оформить</a>' +
        '</article>';
    }).join('');
  }

  async function renderRelease() {
    var data = await api('/api/v1/updates/latest');
    var channelEl = $('#release-channel');
    var versionTag = $('#release-version');
    var nameEl = $('#release-name');
    var notesEl = $('#release-notes');
    var linkEl = $('#release-link');
    var downloadBtn = $('#download-btn');
    var downloadMeta = $('#download-meta');

    if (!data || !data.available || !data.release) return;

    var r = data.release;
    var asset = (r.assets || []).find(function (a) { return /\.(exe|msi|zip|dmg)$/i.test(a.name || ''); });
    if (channelEl) channelEl.textContent = data.channel;
    if (versionTag) versionTag.textContent = 'v' + r.version;
    if (nameEl) nameEl.textContent = r.name || ('Релиз ' + r.version);
    if (notesEl) notesEl.textContent = (r.notes || 'Описание релиза не заполнено.').trim().slice(0, 600);
    if (linkEl && r.htmlUrl) linkEl.href = r.htmlUrl;
    if (downloadBtn && asset) {
      downloadBtn.href = asset.url;
    }
    if (downloadMeta) {
      downloadMeta.textContent = 'версия ' + r.version +
        (r.publishedAt ? ' · ' + new Date(r.publishedAt).toLocaleDateString('ru-RU') : '');
    }
  }

  async function renderAccount() {
    var yearEl = $('#year');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    var navAccount = $('#nav-account');
    if (!navAccount) return;
    var session = await api('/api/v1/auth/session');
    if (session && session.authenticated && session.user) {
      var name = session.user.name || session.user.email || 'Кабинет';
      navAccount.textContent = name.length > 20 ? name.slice(0, 19) + '…' : name;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    initReveal();
    initBlockedCounter();
    void renderPlans();
    void renderRelease();
    void renderAccount();
  });
})();
