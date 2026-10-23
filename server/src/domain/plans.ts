/**
 * Каталог тарифов. Валюта и цены — из клиентского каталога (TZ):
 *   monthly: 299 RUB / 30 дней
 *   yearly: 2390 RUB / 365 дней
 *
 * Сервер НЕ доверяет ничему, что приходит из клиента: `planId` валидируется
 * по этому каталогу, сумма и срок всегда берутся отсюда (клиент цену не задаёт).
 */

export const CURRENCY = 'RUB';

export type PlanId = 'monthly' | 'yearly';

export interface Plan {
  id: PlanId;
  title: string;
  /** Цена в минорных единицах (копейки). 299 RUB = 29900. */
  amountMinor: number;
  currency: typeof CURRENCY;
  /** Длительность подписки, дни. */
  days: number;
  /** Перечёркнутая «старая» цена для витрины (копейки), необязательно. */
  compareAtMinor?: number;
  badge?: string;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  monthly: {
    id: 'monthly',
    title: 'Месяц',
    amountMinor: 29900,
    currency: CURRENCY,
    days: 30,
    features: [
      'Все возможности SHELTER Premium',
      'Обновления браузера',
      'Поддержка по почте',
    ],
  },
  yearly: {
    id: 'yearly',
    title: 'Год',
    amountMinor: 239000,
    currency: CURRENCY,
    days: 365,
    compareAtMinor: 29900 * 12,
    badge: 'Выгода 33%',
    features: [
      'Все возможности SHELTER Premium',
      'Обновления браузера',
      'Приоритетная поддержка',
      '365 дней одной оплатой',
    ],
  },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLANS, value);
}

export function getPlan(planId: string): Plan | null {
  return isPlanId(planId) ? PLANS[planId] : null;
}

/** Копейки -> "299 ₽" / "2 390 ₽" для витрины и писем. */
export function formatAmount(amountMinor: number, currency: string = CURRENCY): string {
  const major = amountMinor / 100;
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(major);
  return currency === CURRENCY ? `${formatted} ₽` : `${formatted} ${currency}`;
}
