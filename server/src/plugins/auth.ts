import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../http/errors.js';
import type { SessionValidation } from '../services/sessions.js';

async function loadSession(request: FastifyRequest): Promise<{ token?: string; result: SessionValidation }> {
  const { sessions, env } = request.server.deps;
  const token = (request.cookies as Record<string, string | undefined>)?.[env.COOKIE_NAME];
  const result = await sessions.validate(token);
  return { token, result };
}

/**
 * Аутентификация по сессионной cookie.
 * Fail-closed: проверка не удалась — 401, никаких «похоже на пользователя».
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { env, sessions } = request.server.deps;
  const { token, result } = await loadSession(request);
  if (!result.ok || !result.user) {
    if (token) reply.clearCookie(env.COOKIE_NAME, { path: '/' });
    throw unauthorized('session_invalid', 'Authentication required');
  }
  request.currentUser = result.user;
  request.currentSessionId = result.sessionId;
  if (result.renew && result.expiresAt && token) {
    reply.setCookie(env.COOKIE_NAME, token, sessions.cookieOptions(result.expiresAt));
  }
}

/** Опциональная аутентификация: есть валидная сессия — кладём пользователя в request. */
export async function optionalAuth(request: FastifyRequest): Promise<void> {
  const { result } = await loadSession(request);
  if (result.ok && result.user) {
    request.currentUser = result.user;
    request.currentSessionId = result.sessionId;
  }
}

/** Доступ только для администраторов (роль в БД, не из клиента). */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  const { result } = await loadSession(request);
  if (!result.ok || !result.user) throw unauthorized('session_invalid', 'Authentication required');
  if (result.user.role !== 'admin') throw forbidden('admin_required', 'Administrator access required');
  request.currentUser = result.user;
  request.currentSessionId = result.sessionId;
}
