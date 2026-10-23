import type { Env } from '../config.js';
import { baseUrl } from '../config.js';
import { ConfigError } from '../config.js';
import type { AuthProvider } from './auth/types.js';
import { GoogleProvider, FakeGoogleProvider } from './auth/google.js';
import { YandexProvider, FakeYandexProvider } from './auth/yandex.js';
import { DevLoginProvider } from './auth/mock.js';
import type { PaymentProvider } from './payments/types.js';
import { YooKassaProvider } from './payments/yookassa.js';
import { MockPaymentProvider } from './payments/mock.js';

export interface ProviderBundle {
  authProviders: Record<string, AuthProvider>;
  payments: PaymentProvider;
}

/**
 * Сборка провайдеров из конфигурации.
 *
 * В production:
 *  - только реально настроенные OAuth-провайдеры (без фейков);
 *  - только боевой платёжный провайдер (mock запрещён на уровне config.ts).
 */
export function buildProviders(env: Env, overrides: Partial<ProviderBundle> = {}): ProviderBundle {
  const authProviders: Record<string, AuthProvider> = {};

  if (env.GOOGLE_ENABLED) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new ConfigError('GOOGLE_ENABLED requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    }
    authProviders.google =
      env.NODE_ENV === 'test'
        ? new FakeGoogleProvider()
        : new GoogleProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
  }

  if (env.YANDEX_ENABLED) {
    if (!env.YANDEX_CLIENT_ID || !env.YANDEX_CLIENT_SECRET) {
      throw new ConfigError('YANDEX_ENABLED requires YANDEX_CLIENT_ID and YANDEX_CLIENT_SECRET');
    }
    authProviders.yandex =
      env.NODE_ENV === 'test'
        ? new FakeYandexProvider()
        : new YandexProvider({ clientId: env.YANDEX_CLIENT_ID, clientSecret: env.YANDEX_CLIENT_SECRET });
  }

  if (env.DEV_LOGIN_ENABLED && env.NODE_ENV !== 'production') {
    authProviders.dev = new DevLoginProvider();
  }

  let payments: PaymentProvider;
  if (env.PAYMENT_PROVIDER === 'yookassa') {
    if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) {
      throw new ConfigError('PAYMENT_PROVIDER=yookassa requires YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY');
    }
    payments = new YooKassaProvider({
      shopId: env.YOOKASSA_SHOP_ID,
      secretKey: env.YOOKASSA_SECRET_KEY,
      webhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? null,
      capture: env.YOOKASSA_CAPTURE,
    });
  } else {
    if (!env.PAYMENT_WEBHOOK_SECRET) {
      throw new ConfigError('PAYMENT_WEBHOOK_SECRET is required (webhook signatures are mandatory)');
    }
    if (env.NODE_ENV === 'production') {
      throw new ConfigError('PAYMENT_PROVIDER=mock is not allowed in production');
    }
    payments = new MockPaymentProvider({
      baseUrl: baseUrl(env),
      webhookSecret: env.PAYMENT_WEBHOOK_SECRET,
    });
  }

  return {
    authProviders: overrides.authProviders ?? authProviders,
    payments: overrides.payments ?? payments,
  };
}
