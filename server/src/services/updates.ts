import type { Env } from '../config.js';
import type { ReleaseChannel, ReleaseRow, Store } from '../db/types.js';
import { compareVersions, isBelowMinimum, isNewer, isValidVersion, parseVersion } from '../domain/versions.js';

const GITHUB_API = 'https://api.github.com';

export interface GitHubRelease {
  id: number | string;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url?: string | null;
  published_at?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  assets?: { name: string; browser_download_url?: string; url?: string; size?: number; content_type?: string }[];
}

export interface UpdateCheckInput {
  currentVersion: string;
  channel?: ReleaseChannel | 'auto';
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  channel: ReleaseChannel;
  currentVersion: string | null;
  latestVersion: string | null;
  release: {
    version: string;
    tagName: string;
    name: string | null;
    htmlUrl: string | null;
    publishedAt: string | null;
    notes: string | null;
    assets: { name: string; url: string; size: number }[];
  } | null;
  /** Принудительное обновление: текущая версия ниже минимально поддерживаемой. */
  forceUpdate: boolean;
  minSupportedVersion: string | null;
  /** Клиент только показывает уведомление и ссылку; автоустановка запрещена. */
  autoInstall: false;
  checkedAt: string;
}

/**
 * Канал обновлений на GitHub Releases (P1).
 *
 * Правила:
 *  - принимаются только числовые версии X.Y.Z / vX.Y.Z;
 *  - draft-релизы игнорируются;
 *  - prerelease попадает только в канал beta;
 *  - клиент НЕ устанавливает обновления автоматически: ответ содержит лишь
 *    уведомление + ссылку на страницу релиза.
 */
export class UpdatesService {
  private cache: { at: number; channel: ReleaseChannel; release: ReleaseRow | null } | null = null;
  private fetchImpl: typeof fetch;

  constructor(
    private readonly store: Store,
    private readonly env: Env,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async getChannel(): Promise<ReleaseChannel> {
    const stored = await this.store.settingsGet('updates_channel');
    if (stored === 'beta' || stored === 'stable') return stored;
    return this.env.UPDATES_CHANNEL;
  }

  async setChannel(channel: ReleaseChannel): Promise<ReleaseChannel> {
    await this.store.settingsSet('updates_channel', channel);
    this.cache = null;
    return channel;
  }

  async getMinSupportedVersion(): Promise<string | null> {
    const stored = await this.store.settingsGet('updates_min_client_version');
    const value = stored?.trim() || this.env.UPDATES_MIN_CLIENT_VERSION?.trim() || '';
    return value && isValidVersion(value) ? (parseVersion(value)!.canonical) : null;
  }

  async setMinSupportedVersion(version: string | null): Promise<string | null> {
    if (version !== null && version !== '' && !isValidVersion(version)) {
      throw new Error(`Invalid version format: ${version}. Expected X.Y.Z or vX.Y.Z`);
    }
    await this.store.settingsSet('updates_min_client_version', version ? parseVersion(version)!.canonical : '');
    this.cache = null;
    return version ? parseVersion(version)!.canonical : null;
  }

  /** Загрузка релизов из GitHub Releases и обновление кэша в БД. */
  async refreshFromGitHub(limit = 15): Promise<{ fetched: number; releases: ReleaseRow[] }> {
    const url = `${GITHUB_API}/repos/${this.env.GITHUB_REPO}/releases?per_page=${limit}`;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'shelter-server',
      'x-github-api-version': '2022-11-28',
    };
    if (this.env.GITHUB_TOKEN) headers.authorization = `Bearer ${this.env.GITHUB_TOKEN}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch {
      return { fetched: 0, releases: await this.store.releasesList({ limit }) };
    }
    if (!res.ok) {
      return { fetched: 0, releases: await this.store.releasesList({ limit }) };
    }

    let payload: GitHubRelease[];
    try {
      payload = (await res.json()) as GitHubRelease[];
    } catch {
      return { fetched: 0, releases: await this.store.releasesList({ limit }) };
    }
    if (!Array.isArray(payload)) return { fetched: 0, releases: await this.store.releasesList({ limit }) };

    let fetched = 0;
    for (const r of payload) {
      const parsed = parseVersion(r?.tag_name);
      if (!parsed) continue; // только числовые версии
      if (r.draft) continue;
      const channel: ReleaseChannel = r.prerelease ? 'beta' : 'stable';
      await this.store.releaseUpsert({
        id: String(r.id),
        tagName: r.tag_name,
        version: parsed.canonical,
        channel,
        name: r.name ?? null,
        body: r.body ?? null,
        htmlUrl: r.html_url ?? null,
        publishedAt: r.published_at ?? null,
        isPrerelease: Boolean(r.prerelease),
        isDraft: false,
        assets: (r.assets ?? []).map((a) => ({
          name: a.name,
          url: a.browser_download_url ?? a.url ?? '',
          size: Number(a.size ?? 0),
          contentType: a.content_type ?? undefined,
        })),
      });
      fetched++;
    }
    this.cache = null;
    return { fetched, releases: await this.store.releasesList({ limit }) };
  }

  /** Последний релиз канала: кэш в памяти -> БД -> (опционально) GitHub. */
  async latestForChannel(channel: ReleaseChannel, allowFetch = true): Promise<ReleaseRow | null> {
    const ttl = this.env.UPDATES_CACHE_TTL_SECONDS * 1000;
    if (this.cache && this.cache.channel === channel && Date.now() - this.cache.at < ttl) {
      return this.cache.release;
    }
    let releases = await this.store.releasesList({ channel, limit: 20 });
    if ((!releases.length || Date.now() - new Date(releases[0].fetchedAt).getTime() > ttl) && allowFetch) {
      const refreshed = await this.refreshFromGitHub();
      if (refreshed.fetched > 0) releases = await this.store.releasesList({ channel, limit: 20 });
    }
    const valid = releases
      .filter((r) => !r.isDraft && isValidVersion(r.version))
      .sort((a, b) => {
        try {
          return compareVersions(b.version, a.version);
        } catch {
          return 0;
        }
      });
    const release = valid[0] ?? null;
    this.cache = { at: Date.now(), channel, release };
    return release;
  }

  /**
   * Проверка обновлений. Любой сбой => «обновлений нет» (мы не подталкиваем
   * клиента к установке неизвестной версии).
   */
  async check(input: UpdateCheckInput): Promise<UpdateCheckResult> {
    const checkedAt = new Date().toISOString();
    const currentValid = isValidVersion(input.currentVersion)
      ? parseVersion(input.currentVersion)!.canonical
      : null;

    const channel: ReleaseChannel =
      input.channel === 'beta' || input.channel === 'stable' ? input.channel : await this.getChannel();
    const minSupportedVersion = await this.getMinSupportedVersion();

    const base: UpdateCheckResult = {
      updateAvailable: false,
      channel,
      currentVersion: currentValid,
      latestVersion: null,
      release: null,
      forceUpdate: false,
      minSupportedVersion,
      autoInstall: false,
      checkedAt,
    };

    if (!currentValid) {
      // Версия клиента нераспознана — ничего не предлагаем.
      return base;
    }

    let latest: ReleaseRow | null = null;
    try {
      latest = await this.latestForChannel(channel);
    } catch {
      latest = null;
    }
    if (!latest) return base;

    base.latestVersion = latest.version;
    base.release = {
      version: latest.version,
      tagName: latest.tagName,
      name: latest.name,
      htmlUrl: latest.htmlUrl,
      publishedAt: latest.publishedAt,
      notes: latest.body,
      assets: (latest.assets ?? []).map((a) => ({ name: a.name, url: a.url, size: a.size })),
    };
    base.updateAvailable = isNewer(latest.version, currentValid);
    base.forceUpdate = isBelowMinimum(currentValid, minSupportedVersion);
    return base;
  }

  invalidateCache(): void {
    this.cache = null;
  }
}
