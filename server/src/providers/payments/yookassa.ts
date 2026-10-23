import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/tokens.js';
import {
  PaymentError,
  headerOf,
  type CheckoutRequest,
  type CheckoutResult,
  type PaymentProvider,
  type WebhookOutcome,
  type WebhookRequest,
} from './types.js';

export interface YooKassaOptions {
  shopId: string;
  secretKey: string;
  /** Если задан — webhook дополнительно проверяется по HMAC-подписи провайдера. */
  webhookSecret?: string | null;
  capture?: boolean;
  fetchImpl?: typeof fetch;
}

const API = 'https://api.yookassa.ru/v3';

/**
 * YooKassa (ЮKassa) — создание платежа и приём уведомлений.
 *
 * Безопасность:
 *  - секретный ключ магазина только из env;
 *  - уведомление принимается только если пройдена проверка подлинности
 *    (HTTP Basic shopId:secretKey и/или HMAC-подпись, если выдана);
 *  - сумма из уведомления сверяется с суммой заказа в БД: расхождение => отказ.
 */
export class YooKassaProvider implements PaymentProvider {
  readonly name = 'yookassa';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: YooKassaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const payload = {
      amount: { value: (req.amountMinor / 100).toFixed(2), currency: req.currency },
      description: req.description.slice(0, 128),
      capture: this.opts.capture ?? true,
      confirmation: { type: 'redirect', return_url: req.returnUrl, confirmation_url: undefined },
      metadata: { orderId: req.orderId, ...(req.metadata ?? {}) },
      ...(req.cancelUrl ? { cancel_url: req.cancelUrl } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/payments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`${this.opts.shopId}:${this.opts.secretKey}`).toString('base64')}`,
          'idempotence-key': req.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new PaymentError('upstream_unavailable', 'YooKassa API is unreachable', 503);
    }

    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    if (!res.ok || !json?.id || !json?.confirmation?.confirmation_url) {
      throw new PaymentError(
        'checkout_failed',
        `YooKassa checkout failed: ${json?.description ?? json?.code ?? res.status}`,
        502,
      );
    }

    return {
      provider: this.name,
      providerPaymentId: String(json.id),
      checkoutUrl: String(json.confirmation.confirmation_url),
      raw: { status: json.status, expires_at: json.expires_at ?? null },
    };
  }

  async verifyWebhook(req: WebhookRequest): Promise<WebhookOutcome | null> {
    let event: any;
    try {
      event = JSON.parse(req.rawBody);
    } catch {
      return null; // невалидный JSON => отказ
    }

    const eventId = String(event?.id ?? '');
    const type = String(event?.type ?? '');
    const obj = event?.object ?? {};
    const providerPaymentId = String(obj?.id ?? '');
    const orderId = String(obj?.metadata?.orderId ?? '');
    if (!eventId || !providerPaymentId) return null;

    if (!this.authenticate(req)) return null;

    const amountMinor = amountToMinor(obj?.amount?.value);

    if (type === 'payment.succeeded') {
      if (obj?.status !== 'succeeded') return null;
      return { status: 'paid', providerPaymentId, orderId, eventId, paidAt: toDate(obj?.paid_at), amountMinor };
    }
    if (type === 'payment.canceled') {
      return { status: 'failed', providerPaymentId, orderId, eventId, reason: String(obj?.cancellation_details?.reason ?? 'canceled') };
    }
    if (type === 'refund.succeeded') {
      const refundOrderId = String(obj?.metadata?.orderId ?? orderId ?? '');
      return {
        status: 'refunded',
        providerPaymentId: String(obj?.payment_id ?? providerPaymentId),
        orderId: refundOrderId,
        eventId,
        refundedAt: toDate(obj?.created_at),
      };
    }
    return { status: 'ignored', eventId, reason: `unsupported event type: ${type}` };
  }

  /**
   * Проверка подлинности уведомления:
   *  1) если задан PAYMENT_WEBHOOK_SECRET — обязательна корректная HMAC-подпись;
   *  2) иначе — HTTP Basic с shopId/secretKey (стандарт YooKassa).
   * Ошибка на любом шаге => null (уведомление отклоняется).
   */
  private authenticate(req: WebhookRequest): boolean {
    const signature =
      headerOf(req.headers, 'signature') ??
      headerOf(req.headers, 'x-signature') ??
      headerOf(req.headers, 'x-webhook-signature');

    if (this.opts.webhookSecret) {
      if (!signature) return false;
      const raw = signature.startsWith('sha256=') ? signature.slice(7) : signature;
      const expected = createHmac('sha256', this.opts.webhookSecret).update(req.rawBody, 'utf8').digest('hex');
      return safeEqual(expected, raw.trim().toLowerCase());
    }

    const auth = headerOf(req.headers, 'authorization');
    if (!auth || !auth.toLowerCase().startsWith('basic ')) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
    } catch {
      return false;
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    const shopId = decoded.slice(0, idx);
    const secret = decoded.slice(idx + 1);
    return safeEqual(shopId, this.opts.shopId) && safeEqual(secret, this.opts.secretKey);
  }
}

function amountToMinor(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100);
}

function toDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
