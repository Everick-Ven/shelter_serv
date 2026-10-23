import { OAuthError, type AuthProvider, type OAuthProfile } from './types.js';
import { decodeFakeCode } from './google.js';

export interface YandexProviderOptions {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';
const USERINFO_URL = 'https://login.yandex.ru/info?format=json';

/**
 * Yandex ID (OAuth 2.0). Профиль берём из /info; access token используется
 * только на сервере и наружу никогда не отдаётся.
 */
export class YandexProvider implements AuthProvider {
  readonly name = 'yandex' as const;
  readonly enabled = true;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: YandexProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.opts.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'login:email login:info');
    return url.toString();
  }

  async exchangeCode({ code }: { code: string; redirectUri: string }): Promise<OAuthProfile> {
    // Yandex сверяет redirect_uri с настройками OAuth-приложения, в запросе он не нужен.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
      });
    } catch {
      throw new OAuthError('upstream_unavailable', 'Yandex token endpoint is unreachable', 503);
    }

    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    if (!res.ok || !json.access_token) {
      throw new OAuthError(
        'token_exchange_failed',
        `Yandex token exchange failed: ${json?.error_description ?? json?.error ?? res.status}`,
        400,
      );
    }

    let info: Response;
    try {
      info = await this.fetchImpl(USERINFO_URL, {
        headers: { authorization: `OAuth ${String(json.access_token)}`, accept: 'application/json' },
      });
    } catch {
      throw new OAuthError('upstream_unavailable', 'Yandex userinfo endpoint is unreachable', 503);
    }

    if (!info.ok) {
      throw new OAuthError('userinfo_failed', `Yandex userinfo failed: ${info.status}`, 502);
    }

    const raw = (await info.json()) as any;
    const id = String(raw?.id ?? '').trim();
    if (!id) throw new OAuthError('invalid_profile', 'Yandex profile has no id', 502);

    const email = raw?.default_email || raw?.email || null;
    const name = [raw?.first_name, raw?.last_name].filter(Boolean).join(' ').trim() || raw?.display_name || null;
    const avatarKey = raw?.default_avatar_id || raw?.avatar_id || null;

    return {
      provider: 'yandex',
      providerUserId: id,
      email: email ? String(email).toLowerCase() : null,
      // Yandex возвращает подтверждённый default_email для scope login:email
      emailVerified: Boolean(email),
      name: name ? String(name) : null,
      avatarUrl: avatarKey ? `https://avatars.yandex.net/get-yapic/${avatarKey}/islands-200` : null,
      locale: null,
    };
  }
}

/** Мок-провайдер Yandex — только для тестов. */
export class FakeYandexProvider implements AuthProvider {
  readonly name = 'yandex' as const;
  readonly enabled = true;

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL('https://fake.test/yandex/authorize');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('client_id', 'fake-yandex-client');
    return url.toString();
  }

  async exchangeCode({ code }: { code: string }): Promise<OAuthProfile> {
    const profile = decodeFakeCode(code);
    if (!profile || profile.provider !== 'yandex') {
      throw new OAuthError('invalid_code', 'fake yandex code is invalid', 400);
    }
    return profile;
  }
}
