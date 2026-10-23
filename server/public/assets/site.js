/* SHELTER — витрина. Чистый JS без сборки (CSP: script-src 'self'). */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  // ---------------------------------------------------------- scroll reveal
  function initReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    items.forEach(function (el, i) {
      el.style.transitionDelay = Math.min(i % 6, 5) * 60 + 'ms';
      io.observe(el);
    });
  }

  function initNav() {
    var nav = $('#nav');
    var onScroll = function () {
      if (window.scrollY > 12) nav.classList.add('is-scrolled');
      else nav.classList.remove('is-scrolled');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
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

  // ------------------------------------------------------------- тарифы
  function money(minor, currency) {
    var v = (minor / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    return v + ' ' + (currency === 'RUB' ? '₽' : currency);
  }

  async function renderPlans() {
    var host = $('#plans');
    var data = await api('/api/v1/plans');
    if (!data || !Array.isArray(data.plans) || !data.plans.length) {
      host.innerHTML = '<div class="plans__loading">Тарифы временно недоступны. Попробуйте позже.</div>';
      return;
    }
    var order = { yearly: 0, monthly: 1 };
    var plans = data.plans.slice().sort(function (a, b) {
      return (order[a.id] === undefined ? 9 : order[a.id]) - (order[b.id] === undefined ? 9 : order[b.id]);
    });

    host.innerHTML = plans.map(function (p) {
      var featured = p.id === 'yearly';
      var per = p.days >= 365 ? 'в год' : p.days >= 28 ? 'в месяц' : 'за ' + p.days + ' дн.';
      var compare = p.compareAtMinor
        ? '<s>' + money(p.compareAtMinor, p.currency) + '</s>'
        : '';
      return '' +
        '<article class="plan' + (featured ? ' plan--featured' : '') + '">' +
          (p.badge ? '<span class="plan__badge">' + escapeHtml(p.badge) + '</span>' : '') +
          '<h3 class="plan__title">' + escapeHtml(p.title) + '</h3>' +
          '<div class="plan__price"><b>' + money(p.amountMinor, p.currency) + '</b>' + compare + '</div>' +
          '<p class="plan__per">' + per + ' · ' + p.days + ' дн. доступа</p>' +
          '<ul class="plan__features">' +
            (p.features || []).map(function (f) { return '<li>' + escapeHtml(f) + '</li>'; }).join('') +
          '</ul>' +
          '<a class="btn ' + (featured ? 'btn--primary' : 'btn--ghost') + ' btn--md" href="/account?plan=' + encodeURIComponent(p.id) + '" data-plan="' + escapeHtml(p.id) + '">Оформить подписку</a>' +
        '</article>';
    }).join('');
  }

  // ------------------------------------------------------ канал обновлений
  async function renderRelease() {
    var data = await api('/api/v1/updates/latest');
    var versionEl = $('#hero-version .mono');
    var channelEl = $('#release-channel');
    var versionTag = $('#release-version');
    var nameEl = $('#release-name');
    var notesEl = $('#release-notes');
    var linkEl = $('#release-link');
    var downloadBtn = $('#download-btn');
    var downloadMeta = $('#download-meta');

    if (!data || !data.available || !data.release) {
      if (notesEl) notesEl.textContent = 'Список релизов пока пуст. Как только появится публикация в GitHub Releases, она отобразится здесь.';
      return;
    }

    var r = data.release;
    var windowsAsset = (r.assets || []).find(function (a) {
      return /\.(exe|msi|zip)$/i.test(a.name || '');
    });
    var assetUrl = windowsAsset ? windowsAsset.url : r.htmlUrl;

    if (versionEl) versionEl.textContent = r.version;
    if (channelEl) channelEl.textContent = data.channel;
    if (versionTag) versionTag.textContent = 'v' + r.version;
    if (nameEl) nameEl.textContent = r.name || ('Релиз ' + r.version);
    if (notesEl) notesEl.textContent = (r.notes || 'Описание релиза не заполнено.').trim().slice(0, 900);
    if (linkEl && r.htmlUrl) { linkEl.href = r.htmlUrl; linkEl.removeAttribute('aria-disabled'); }
    if (downloadBtn) {
      if (assetUrl) {
        downloadBtn.href = assetUrl;
        downloadBtn.target = '_blank';
        downloadBtn.rel = 'noopener noreferrer';
      } else {
        downloadBtn.href = '#updates';
      }
    }
    if (downloadMeta) {
      downloadMeta.textContent = 'версия ' + r.version +
        (r.publishedAt ? ' · ' + new Date(r.publishedAt).toLocaleDateString('ru-RU') : '');
    }
  }

  // ------------------------------------------------------------- аккаунт
  async function renderAccount() {
    var cfg = await api('/api/v1/config');
    var yearEl = $('#year');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());
    var footerEnv = $('#footer-env');
    if (footerEnv && cfg) footerEnv.textContent = 'server · ' + (cfg.payments && cfg.payments.provider ? cfg.payments.provider : '—');
    var support = $('#footer-support');
    if (support && cfg && cfg.supportEmail) support.href = 'mailto:' + cfg.supportEmail;

    var navAccount = $('#nav-account');
    if (!navAccount) return;
    var session = await api('/api/v1/auth/session');
    if (session && session.authenticated && session.user) {
      var name = session.user.name || session.user.email || 'Аккаунт';
      navAccount.textContent = name.length > 22 ? name.slice(0, 21) + '…' : name;
      navAccount.href = '/account';
      navAccount.title = 'Личный кабинет';
    } else {
      navAccount.textContent = 'Войти';
      navAccount.href = '/account';
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  document.addEventListener('DOMContentLoaded', function () {
    initReveal();
    initNav();
    void renderPlans();
    void renderRelease();
    void renderAccount();
  });
})();
