import type { FastifyRequest } from 'fastify';

/**
 * Сырое тело запроса. Сохраняется content-type парсером в app.ts и нужно для
 * проверки HMAC-подписи платёжных уведомлений (пересериализация JSON может
 * изменить байты и сломать подпись).
 */
export function rawBodyOf(request: FastifyRequest): string | undefined {
  const raw = (request.raw as unknown as { rawBody?: string }).rawBody;
  if (typeof raw === 'string') return raw;
  const direct = (request as unknown as { rawBody?: string }).rawBody;
  return typeof direct === 'string' ? direct : undefined;
}
