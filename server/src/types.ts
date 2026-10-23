import type { Env } from './config.js';
import type { Store, UserRow } from './db/types.js';
import type { SessionService } from './services/sessions.js';
import type { SubscriptionService } from './services/subscriptions.js';
import type { UpdatesService } from './services/updates.js';
import type { AuthProvider } from './providers/auth/types.js';
import type { PaymentProvider } from './providers/payments/types.js';

export interface AppDeps {
  env: Env;
  store: Store;
  sessions: SessionService;
  subscriptions: SubscriptionService;
  updates: UpdatesService;
  authProviders: Record<string, AuthProvider>;
  payments: PaymentProvider;
  /** Публичный каталог (сайт + /manage). */
  publicDir?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    currentUser?: UserRow;
    currentSessionId?: string;
  }
}

