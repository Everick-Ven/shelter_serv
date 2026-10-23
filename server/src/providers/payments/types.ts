export interface CheckoutRequest {
  orderId: string;
  amountMinor: number;
  currency: string;
  description: string;
  idempotencyKey: string;
  returnUrl: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckoutResult {
  provider: string;
  providerPaymentId: string;
  checkoutUrl: string;
  raw?: Record<string, unknown>;
}

export interface WebhookRequest {
  /** Тело в том виде, в котором оно пришло (для проверки подписи). */
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export type WebhookOutcome =
  | { status: 'paid'; providerPaymentId: string; orderId: string; eventId: string; paidAt?: Date; amountMinor?: number }
  | { status: 'refunded'; providerPaymentId: string; orderId: string; eventId: string; refundedAt?: Date }
  | { status: 'failed'; providerPaymentId?: string; orderId?: string; eventId: string; reason?: string }
  | { status: 'ignored'; eventId: string; reason: string };

export interface PaymentProvider {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  /**
   * Проверка подлинности уведомления. Любая ошибка/несовпадение => null,
   * webhook отклоняется, заказ НЕ становится оплаченным (fail-closed).
   */
  verifyWebhook(req: WebhookRequest): Promise<WebhookOutcome | null>;
}

export class PaymentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
  }
}

export function headerOf(headers: WebhookRequest['headers'], name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ? String(v) : null;
}
