import { createRemoteJWKSet, jwtVerify } from 'jose';
import { OAuthError, type AuthProvider, type OAuthProfile } from './types.js';

export interface GoogleProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Тесты подменяют fetch, чтобы не ходить в сеть. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const AUDIENCE_OVERRIDE = 'https://accounts.google.com';

/**
 * Google OAuth 2.0 / OIDC.
 * id_token проверяется криптографически по JWKS Google (jose): подпись, iss, aud,
 * exp. Access token используется только как fallback и никогда не является
 * доказательством чего-либо на клиенте.
 */
export class GoogleProvider implements AuthProvider {
  readonly name = 'google' as const;
  readonly enabled = true;

  private readonly fetchImpl: typeof fetch;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly opts: GoogleProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.opts.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      'openid email profile',
    );
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthProfile> {
    const body = new URLSearchParams({
      code,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
      });
    } catch {
      throw new OAuthError('upstream_unavailable', 'Google token endpoint is unreachable', 503);
    }

    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    if (!res.ok) {
      throw new OAuthError(
        'token_exchange_failed',
        `Google token exchange failed: ${json?.error ?? res.status}`,
        400,
      );
    }

    const idToken: string | undefined = json.id_token;
    if (!idToken) throw new OAuthError('missing_id_token', 'Google response has no id_token', 400);

    const claims = await this.verifyIdToken(idToken);
    const sub = String(claims.sub ?? '');
    if (!sub) throw new OAuthError('invalid_id_token', 'id_token has no sub', 400);

    return {
      provider: 'google',
      providerUserId: sub,
      email: claims.email ? String(claims.email).toLowerCase() : null,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name: claims.name ? String(claims.name) : null,
      avatarUrl: claims.picture ? String(claims.picture) : null,
      locale: claims.locale ? String(claims.locale) : null,
    };
  }

  private async verifyIdToken(idToken: string): Promise<Record<string, unknown>> {
    try {
      if (!this.jwks) {
        this.jwks = createRemoteJWKSet(new URL(JWKS_URL), {
          // jose позволяет передать свой cooldown; fetch подменяем в тестах через opts
          cooldownDuration: 60_000,
          cacheMaxAge: 600_000,
        });
      }
      const { payload } = await jwtVerify(idToken, this.jwks, {
        issuer: ISSUERS,
        audience: [this.opts.clientId, AUDIENCE_OVERRIDE],
        clockTolerance: 30,
      });
      return payload as Record<string, unknown>;
    } catch {
      throw new OAuthError('invalid_id_token', 'Google id_token verification failed', 401);
    }
  }
}

/**
 * Тестовый/мок-провайдер Google: принимает «id_token» в формате
 * base64url(header).base64url(payload).mock и не проверяет подпись.
 * Используется ТОЛЬКО в тестах (NODE_ENV=test) и никогда не даёт премиум.
 */
export class FakeGoogleProvider implements AuthProvider {
  readonly name = 'google' as const;
  readonly enabled = true;

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL('https://fake.test/google/authorize');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('client_id', 'fake-google-client');
    return url.toString();
  }

  async exchangeCode({ code }: { code: string }): Promise<OAuthProfile> {
    const profile = decodeFakeCode(code);
    if (!profile || profile.provider !== 'google') {
      throw new OAuthError('invalid_code', 'fake google code is invalid', 400);
    }
    return profile;
  }
}

export function encodeFakeCode(profile: OAuthProfile): string {
  return Buffer.from(JSON.stringify(profile), 'utf8').toString('base64url');
}

export function decodeFakeCode(code: string): OAuthProfile | null {
  try {
    const parsed = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.providerUserId || !parsed.provider) return null;
    return parsed as OAuthProfile;
  } catch {
    return null;
  }
}
