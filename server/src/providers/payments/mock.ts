import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/tokens.js';
import {
  headerOf,
  type CheckoutRequest,
  type CheckoutResult,
  type PaymentProvider,
  type WebhookOutcome,
  type WebhookRequest,
} from './types.js';

export interface MockPaymentOptions {
  /** Базовый URL самого сервера — на него ведёт «страница оплаты». */
  baseUrl: string;
  webhookSecret: string;
}

/**
 * MOCK-провайдер для локальной разработки и smoke-тестов.
 *
 * Он НЕ является платёжной системой и НЕ принимается как доказательство оплаты
 * в production (конфиг прямо запрещает PAYMENT_PROVIDER=mock при
 * NODE_ENV=production). Симуляция «успешной оплаты» возможна только при наличии
 * корректной HMAC-подписи webhook'а, ключ которой хранится в env.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  constructor(private readonly opts: MockPaymentOptions) {}

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const url = new URL(`${this.opts.baseUrl.replace(/\/+$/, '')}/checkout/mock`);
    url.searchParams.set('order', req.orderId);
    url.searchParams.set('amount', String(req.amountMinor));
    url.searchParams.set('return', req.returnUrl);
    return {
      provider: this.name,
      providerPaymentId: `mock_${req.orderId}`,
      checkoutUrl: url.toString(),
      raw: { simulated: true },
    };
  }

  async verifyWebhook(req: WebhookRequest): Promise<WebhookOutcome | null> {
    const signature = headerOf(req.headers, 'x-shelter-signature') ?? headerOf(req.headers, 'signature');
    if (!signature) return null;
    const expected = createHmac('sha256', this.opts.webhookSecret).update(req.rawBody, 'utf8').digest('hex');
    const raw = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    if (!safeEqual(expected, raw.trim().toLowerCase())) return null;

    let event: any;
    try {
      event = JSON.parse(req.rawBody);
    } catch {
      return null;
    }
    const eventId = String(event?.id ?? '');
    const orderId = String(event?.orderId ?? '');
    if (!eventId || !orderId) return null;

    const type = String(event?.type ?? 'payment.succeeded');
    if (type === 'payment.succeeded') {
      return {
        status: 'paid',
        providerPaymentId: String(event?.providerPaymentId ?? `mock_${orderId}`),
        orderId,
        eventId,
        amountMinor: Number.isFinite(Number(event?.amountMinor)) ? Number(event.amountMinor) : undefined,
      };
    }
    if (type === 'payment.failed') return { status: 'failed', orderId, eventId, reason: String(event?.reason ?? 'failed') };
    if (type === 'refund.succeeded') {
      return {
        status: 'refunded',
        providerPaymentId: String(event?.providerPaymentId ?? `mock_${orderId}`),
        orderId,
        eventId,
      };
    }
    return { status: 'ignored', eventId, reason: `unsupported event type: ${type}` };
  }

  /** Помощник для smoke-теста: подпись полезной нагрузки. */
  sign(payload: string): string {
    return createHmac('sha256', this.opts.webhookSecret).update(payload, 'utf8').digest('hex');
  }
}
