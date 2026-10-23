export type OAuthProviderName = 'google' | 'yandex';

export interface OAuthProfile {
  provider: OAuthProviderName;
  /** Стабильный идентификатор пользователя у провайдера (sub / id). */
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  locale?: string | null;
}

export interface AuthorizeParams {
  state: string;
  redirectUri: string;
}

export interface AuthProvider {
  readonly name: OAuthProviderName;
  readonly enabled: boolean;
  authorizeUrl(params: AuthorizeParams): string;
  exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthProfile>;
}

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}
