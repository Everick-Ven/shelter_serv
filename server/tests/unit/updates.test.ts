import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore, type MemoryStore } from '../../src/db/memory.js';
import { UpdatesService } from '../../src/services/updates.js';
import { testEnv } from '../helpers/app.js';
import type { Env } from '../../src/config.js';

function githubResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.ok === false ? (init.status ?? 500) : 200,
    headers: { 'content-type': 'application/json' },
  });
}

const RELEASES = [
  {
    id: 3,
    tag_name: 'v1.2.0',
    name: 'SHELTER 1.2.0',
    body: 'Исправления и ускорение запуска.',
    html_url: 'https://github.com/Everick-Ven/shelter/releases/tag/v1.2.0',
    published_at: '2026-01-10T10:00:00Z',
    prerelease: false,
    draft: false,
    assets: [{ name: 'shelter-1.2.0-setup.exe', browser_download_url: 'https://example.com/setup.exe', size: 1024 }],
  },
  {
    id: 2,
    tag_name: '1.1.0',
    name: 'SHELTER 1.1.0',
    body: 'Премиум-проверка на сервере.',
    html_url: 'https://github.com/Everick-Ven/shelter/releases/tag/1.1.0',
    published_at: '2025-12-01T10:00:00Z',
    prerelease: false,
    draft: false,
    assets: [],
  },
  {
    id: 4,
    tag_name: 'v1.3.0-beta.1',
    name: 'Beta',
    body: 'Не числовая версия — должна игнорироваться.',
    html_url: 'https://github.com/Everick-Ven/shelter/releases/tag/v1.3.0-beta.1',
    published_at: '2026-01-12T10:00:00Z',
    prerelease: true,
    draft: false,
    assets: [],
  },
  {
    id: 5,
    tag_name: 'v1.2.5',
    name: 'Beta 1.2.5',
    body: 'Предрелиз с числовой версией — попадает только в beta.',
    html_url: 'https://github.com/Everick-Ven/shelter/releases/tag/v1.2.5',
    published_at: '2026-01-11T10:00:00Z',
    prerelease: true,
    draft: false,
    assets: [],
  },
  {
    id: 6,
    tag_name: 'v1.9.0',
    name: 'Draft',
    body: 'Черновик — никогда не публикуется клиентам.',
    published_at: '2026-02-01T10:00:00Z',
    prerelease: false,
    draft: true,
    assets: [],
  },
];

let store: MemoryStore;
let env: Env;
let fetchImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = createMemoryStore();
  env = testEnv({ UPDATES_CACHE_TTL_SECONDS: 0 });
  fetchImpl = vi.fn(async () => githubResponse(RELEASES));
});

function service() {
  return new UpdatesService(store, env, fetchImpl as unknown as typeof fetch);
}

describe('загрузка релизов из GitHub Releases', () => {
  it('сохраняет только числовые версии и пропускает черновики', async () => {
    const result = await service().refreshFromGitHub();
    expect(result.fetched).toBe(3); // v1.2.0, 1.1.0, v1.2.5 (beta.1 и draft отброшены)
    const tags = (await store.releasesList({ limit: 20 })).map((r) => r.tagName).sort();
    expect(tags).toEqual(['1.1.0', 'v1.2.0', 'v1.2.5']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('сообщает причины пропуска: нечисловой тег и черновик', async () => {
    const result = await service().refreshFromGitHub();
    expect(result.skipped).toEqual([
      { tagName: 'v1.3.0-beta.1', reason: 'non_numeric_tag' },
      { tagName: 'v1.9.0', reason: 'draft' },
    ]);
  });

  it('реальный кейс: единственный релиз v0.1.0-beta.1 => канал пуст, причина видна', async () => {
    const realWorld = new UpdatesService(store, env, (async () =>
      githubResponse([
        {
          id: 401371891,
          tag_name: 'v0.1.0-beta.1',
          name: 'SHELTER 0.1.0 beta 1',
          html_url: 'https://github.com/Everick-Ven/shelter/releases/tag/v0.1.0-beta.1',
          published_at: '2026-10-01T21:31:46Z',
          prerelease: true,
          draft: false,
          assets: [{ name: 'shelter-setup.exe', browser_download_url: 'https://example.com/a', size: 10 }],
        },
      ])) as unknown as typeof fetch);

    const result = await realWorld.refreshFromGitHub();
    expect(result.fetched).toBe(0);
    expect(result.skipped).toEqual([{ tagName: 'v0.1.0-beta.1', reason: 'non_numeric_tag' }]);
    expect(await store.releasesList({ limit: 10 })).toEqual([]);

    // Клиенту ничего не предлагается — и это корректное fail-safe поведение.
    const check = await realWorld.check({ currentVersion: '0.0.9' });
    expect(check.updateAvailable).toBe(false);
    expect(check.release).toBeNull();
    expect(check.autoInstall).toBe(false);
  });

  it('нормализует vX.Y.Z до X.Y.Z', async () => {
    await service().refreshFromGitHub();
    const stable = await store.releasesList({ channel: 'stable', limit: 5 });
    expect(stable.map((r) => r.version)).toContain('1.2.0');
  });

  it('предрелизы попадают в канал beta, релизы — в stable', async () => {
    await service().refreshFromGitHub();
    const stable = await store.releasesList({ channel: 'stable', limit: 5 });
    const beta = await store.releasesList({ channel: 'beta', limit: 5 });
    expect(stable.map((r) => r.version).sort()).toEqual(['1.1.0', '1.2.0']);
    expect(beta.map((r) => r.version)).toEqual(['1.2.5']);
  });

  it('сбой сети не ломает сервис: отдаётся кэш и сообщается причина', async () => {
    await service().refreshFromGitHub();
    const failing = new UpdatesService(store, env, (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch);
    const result = await failing.refreshFromGitHub();
    expect(result.fetched).toBe(0);
    expect(result.error).toBe('network_error');
    expect(result.releases.length).toBeGreaterThan(0);
    // Ошибка видна оператору в панели
    expect(failing.lastError?.error).toBe('network_error');
  });

  it('HTTP-ошибка GitHub: причина и статус доступны, исключения нет', async () => {
    const failing = new UpdatesService(store, env, (async () =>
      githubResponse({ message: 'rate limited' }, { ok: false, status: 403 })) as unknown as typeof fetch);
    const result = await failing.refreshFromGitHub();
    expect(result.fetched).toBe(0);
    expect(result.error).toBe('http_error');
    expect(result.errorStatus).toBe(403);
    expect(failing.lastError).toMatchObject({ error: 'http_error', status: 403 });
  });

  it('нечитаемый ответ GitHub помечается как invalid_payload', async () => {
    const broken = new UpdatesService(store, env, (async () =>
      new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch);
    const result = await broken.refreshFromGitHub();
    expect(result.error).toBe('invalid_payload');
    expect(result.fetched).toBe(0);
  });

  it('успешная загрузка сбрасывает предыдущую ошибку', async () => {
    const failing = new UpdatesService(store, env, (async () =>
      githubResponse({}, { ok: false, status: 500 })) as unknown as typeof fetch);
    await failing.refreshFromGitHub();
    expect(failing.lastError?.error).toBe('http_error');

    const ok = service();
    const result = await ok.refreshFromGitHub();
    expect(result.error).toBeNull();
    expect(ok.lastError).toBeNull();
  });
});

describe('app.checkUpdates — проверка обновлений', () => {
  it('предлагает обновление, если есть более новая версия', async () => {
    await service().refreshFromGitHub();
    const r = await service().check({ currentVersion: '1.1.0' });
    expect(r.updateAvailable).toBe(true);
    expect(r.latestVersion).toBe('1.2.0');
    expect(r.release?.htmlUrl).toContain('/releases/tag/v1.2.0');
    expect(r.autoInstall).toBe(false);
    expect(r.channel).toBe('stable');
  });

  it('на актуальной версии обновлений нет', async () => {
    await service().refreshFromGitHub();
    const r = await service().check({ currentVersion: '1.2.0' });
    expect(r.updateAvailable).toBe(false);
    expect(r.latestVersion).toBe('1.2.0');
  });

  it('версия клиента новее релиза — обновлений нет', async () => {
    await service().refreshFromGitHub();
    const r = await service().check({ currentVersion: '9.9.9' });
    expect(r.updateAvailable).toBe(false);
  });

  it('нечитаемая версия клиента => ничего не предлагаем', async () => {
    await service().refreshFromGitHub();
    for (const bad of ['latest', '1.0', 'v1.0.0-beta', '']) {
      const r = await service().check({ currentVersion: bad });
      expect(r.updateAvailable).toBe(false);
      expect(r.currentVersion).toBeNull();
      expect(r.autoInstall).toBe(false);
    }
  });

  it('канал beta видит предрелизы, stable — нет', async () => {
    await service().refreshFromGitHub();
    const beta = await service().check({ currentVersion: '1.2.0', channel: 'beta' });
    expect(beta.channel).toBe('beta');
    expect(beta.latestVersion).toBe('1.2.5');
    expect(beta.updateAvailable).toBe(true);

    const stable = await service().check({ currentVersion: '1.2.0', channel: 'stable' });
    expect(stable.updateAvailable).toBe(false);
    expect(stable.latestVersion).toBe('1.2.0');
  });

  it('channel=auto берёт канал из настроек сервера', async () => {
    await service().refreshFromGitHub();
    await store.settingsSet('updates_channel', 'beta');
    const r = await service().check({ currentVersion: '1.2.0', channel: 'auto' });
    expect(r.channel).toBe('beta');
    expect(r.updateAvailable).toBe(true);
  });

  it('минимальная поддерживаемая версия включает forceUpdate', async () => {
    await service().refreshFromGitHub();
    await store.settingsSet('updates_min_client_version', '1.2.0');
    const old = await service().check({ currentVersion: '1.1.0' });
    expect(old.forceUpdate).toBe(true);
    expect(old.minSupportedVersion).toBe('1.2.0');

    const fresh = await service().check({ currentVersion: '1.2.0' });
    expect(fresh.forceUpdate).toBe(false);
  });

  it('пустой список релизов => updateAvailable=false, без исключений', async () => {
    const offline = new UpdatesService(store, env, (async () =>
      githubResponse({ message: 'not found' }, { ok: false, status: 404 })) as unknown as typeof fetch);
    const r = await offline.check({ currentVersion: '1.0.0' });
    expect(r.updateAvailable).toBe(false);
    expect(r.release).toBeNull();
    expect(r.autoInstall).toBe(false);
  });

  it('ответ всегда содержит autoInstall=false (автоустановка запрещена)', async () => {
    await service().refreshFromGitHub();
    const r = await service().check({ currentVersion: '1.0.0' });
    expect(r.autoInstall).toBe(false);
    expect(typeof r.checkedAt).toBe('string');
  });
});

describe('управление каналом', () => {
  it('setChannel/getChannel сохраняют значение в БД', async () => {
    const s = service();
    expect(await s.getChannel()).toBe('stable');
    await s.setChannel('beta');
    expect(await s.getChannel()).toBe('beta');
    expect(await store.settingsGet('updates_channel')).toBe('beta');
  });

  it('setMinSupportedVersion принимает только X.Y.Z / vX.Y.Z', async () => {
    const s = service();
    await s.setMinSupportedVersion('v1.4.0');
    expect(await s.getMinSupportedVersion()).toBe('1.4.0');
    await expect(s.setMinSupportedVersion('1.4.0-beta')).rejects.toThrow(/Invalid version/);
    await s.setMinSupportedVersion(null);
    expect(await s.getMinSupportedVersion()).toBeNull();
  });
});
