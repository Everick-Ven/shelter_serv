import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../public/assets/local-preview.js', import.meta.url), 'utf8');
function preview(protocol: string, panel: string) {
  const window: any = { location: { protocol, pathname: `/public/${panel}/index.html` } };
  vm.runInNewContext(source, { window, document: { addEventListener() {} } });
  return window.shelterLocalPreview;
}
describe('просмотр панелей из папки без сервера', () => {
  it.each(['manage', 'account'])('%s: локальный интерфейс без сетевого входа', async (panel) => {
    const api = preview('file:', panel);
    const session = await api('/api/v1/auth/session');
    expect(session.authenticated).toBe(true);
    expect(session.user.role).toBe(panel === 'manage' ? 'admin' : 'user');
    await expect(api('/api/v1/me/subscription')).rejects.toThrow('без сервера');
    await expect(api('/api/v1/checkout', { method: 'POST' })).rejects.toThrow('недоступны');
    const html = readFileSync(new URL(`../../public/${panel}/index.html`, import.meta.url), 'utf8');
    expect(html).toContain('../assets/local-preview.js');
    expect(html).not.toContain('src="/assets/');
  });
  it('HTTP(S) не получает локальную имитацию сессии', () => {
    expect(preview('https:', 'manage')).toBeUndefined();
    expect(preview('http:', 'account')).toBeUndefined();
  });
});
