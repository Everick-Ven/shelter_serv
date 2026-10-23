import { z } from 'zod';

/**
 * КОНТРАКТЫ интеграции с браузером (P2).
 *
 * Методы моста и их JSON-форматы ЗАМОРОЖЕНЫ — менять нельзя (TZ):
 *   premium.status      -> GET  /api/v1/me/subscription
 *   premium.checkout    -> POST /api/v1/checkout
 *   app.checkUpdates    -> GET  /api/v1/updates/check
 *
 * Сервер лишь гарантирует, что ответы всегда соответствуют этим схемам.
 */

export const PremiumStatusResponse = z.object({
  active: z.boolean(),
  planId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  status: z.enum(['active', 'expired', 'cancelled', 'refunded', 'revoked', 'none']),
  reason: z.string(),
  checkedAt: z.string(),
});
export type PremiumStatusResponse = z.infer<typeof PremiumStatusResponse>;

export const CheckoutRequest = z.object({
  planId: z.string().min(1),
  /** Необязательный ключ идемпотентности от клиента. */
  idempotencyKey: z.string().min(8).max(128).optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

export const CheckoutResponse = z.object({
  orderId: z.string(),
  planId: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  days: z.number().int(),
  provider: z.string(),
  checkoutUrl: z.string(),
  status: z.string(),
  expiresAt: z.string().nullable(),
});
export type CheckoutResponse = z.infer<typeof CheckoutResponse>;

export const CheckUpdatesRequest = z.object({
  currentVersion: z.string().min(1).max(32),
  channel: z.enum(['stable', 'beta', 'auto']).optional(),
});
export type CheckUpdatesRequest = z.infer<typeof CheckUpdatesRequest>;

export const UpdateRelease = z.object({
  version: z.string(),
  tagName: z.string(),
  name: z.string().nullable(),
  htmlUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  notes: z.string().nullable(),
  assets: z.array(z.object({ name: z.string(), url: z.string(), size: z.number() })),
});

export const CheckUpdatesResponse = z.object({
  updateAvailable: z.boolean(),
  channel: z.enum(['stable', 'beta']),
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  release: UpdateRelease.nullable(),
  forceUpdate: z.boolean(),
  minSupportedVersion: z.string().nullable(),
  /** Всегда false: автоустановка запрещена (TZ). */
  autoInstall: z.literal(false),
  checkedAt: z.string(),
});
export type CheckUpdatesResponse = z.infer<typeof CheckUpdatesResponse>;

/** Единый формат ошибки API. */
export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const ProfileUpdateRequest = z.object({
  name: z.string().min(1).max(120).nullish(),
  avatarUrl: z.string().url().max(2048).nullish(),
});
export type ProfileUpdateRequest = z.infer<typeof ProfileUpdateRequest>;
