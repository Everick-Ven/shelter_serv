/* Просмотр HTML из папки: только интерфейс, без сервера и реальных прав доступа. */
(function () {
  'use strict';
  if (window.location.protocol !== 'file:') return;
  var role = /\/manage\//.test(window.location.pathname) ? 'admin' : 'user';
  var user = { id: 'local-preview', role: role, name: role === 'admin' ? 'Администратор · локальный просмотр' : 'Пользователь · локальный просмотр', email: null, createdAt: null };
  window.shelterLocalPreview = async function (path, opts) {
    if (opts && opts.method && opts.method !== 'GET') {
      throw new Error('Без сервера изменения, оплата и управление аккаунтами недоступны.');
    }
    var route = path.split('?')[0];
    if (route === '/api/v1/auth/session') return { authenticated: true, user: user };
    if (route === '/api/v1/auth/providers') return { providers: [], devLogin: false, adminLogin: { demoLogin: false } };
    if (route === '/manage/api/overview') return { metrics: {}, payments: { provider: 'недоступен без сервера' }, updates: { enabled: false } };
    if (route === '/manage/api/users' || route === '/manage/api/orders') return { items: [], total: 0 };
    if (route === '/manage/api/updates') return { releases: [], enabled: false, repo: 'недоступен без сервера', channel: 'stable' };
    if (route === '/api/v1/me') return { user: user, subscription: { status: 'none' }, billing: { paidOrderCount: 0, firstPaymentAt: null } };
    if (route === '/api/v1/me/orders') return { orders: [] };
    if (route === '/api/v1/me/sessions') return { sessions: [] };
    if (route === '/api/v1/plans') return { plans: [] };
    throw new Error('Данные недоступны без сервера.');
  };
  document.addEventListener('DOMContentLoaded', function () {
    var banner = document.createElement('p');
    banner.textContent = 'Локальный просмотр интерфейса. Сервер не подключён: данные и показатели не загружены, изменения недоступны.';
    banner.style.cssText = 'margin:0;padding:12px 20px;background:#242424;color:#eee;font:14px/1.5 system-ui;position:relative;z-index:10';
    document.body.prepend(banner);
    var logout = document.querySelector('#logout');
    if (logout) logout.hidden = true;
    if (role === 'user') {
      document.querySelector('#cab-sub').textContent = 'Локальный просмотр. Данные аккаунта доступны только при подключении к серверу.';
    }
  });
})();
