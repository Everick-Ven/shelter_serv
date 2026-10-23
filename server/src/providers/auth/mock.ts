import { OAuthError, type AuthProvider, type OAuthProfile } from './types.js';

/**
 * DEV-провайдер (только DEV_LOGIN_ENABLED=true и NODE_ENV != production).
 *
 * ВАЖНО: он создаёт АККАУНТ, но никогда не выдаёт подписку. Право на премиум
 * всегда определяется отдельной проверкой (fail-closed), поэтому «залогиниться
 * бесплатно и получить премиум» через него невозможно.
 */
export class DevLoginProvider implements AuthProvider {
  readonly name = 'google' as const;
  readonly enabled = true;

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL(`${redirectUri}`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode({ code }: { code: string }): Promise<OAuthProfile> {
    const email = String(code || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
      throw new OAuthError('invalid_code', 'dev login expects an email as code', 400);
    }
    return {
      provider: 'google',
      providerUserId: `dev_${email}`,
      email,
      emailVerified: false,
      name: email.split('@')[0],
      avatarUrl: null,
      locale: null,
    };
  }
}
