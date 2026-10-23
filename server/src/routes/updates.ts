import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CheckUpdatesRequest } from '../contracts.js';
import { badRequest, forbidden } from '../http/errors.js';
import { requireAdmin } from '../plugins/auth.js';

const checkQuery = z.object({
  currentVersion: z.string().min(1).max(32).optional(),
  version: z.string().min(1).max(32).optional(),
  channel: z.enum(['stable', 'beta', 'auto']).optional(),
});

/**
 * app.checkUpdates — канал обновлений (P1).
 *
 * Ответ содержит только уведомление и ссылку на страницу релиза.
 * `autoInstall` всегда false: автоустановка запрещена (TZ).
 */
export async function updatesRoutes(app: FastifyInstance): Promise<void> {
  const { store, env, updates } = app.deps;

  app.get(
    '/api/v1/updates/check',
    {
      config: { rateLimit: { max: 60, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      if (!env.UPDATES_ENABLED) {
        return reply.send({
          updateAvailable: false,
          channel: 'stable',
          currentVersion: null,
          latestVersion: null,
          release: null,
          forceUpdate: false,
          minSupportedVersion: null,
          autoInstall: false as const,
          checkedAt: new Date().toISOString(),
        });
      }

      const parsed = checkQuery.safeParse(request.query ?? {});
      if (!parsed.success) throw badRequest('invalid_query', 'Invalid query parameters');
      const currentVersion = parsed.data.currentVersion ?? parsed.data.version;
      if (!currentVersion) throw badRequest('missing_version', 'currentVersion query parameter is required');

      // Клиентская версия принимается к сравнению, но не является доверенной:
      // нераспознанный формат => «обновлений нет».
      const contract = CheckUpdatesRequest.safeParse({ currentVersion, channel: parsed.data.channel ?? 'auto' });
      if (!contract.success) throw badRequest('invalid_query', 'Invalid update check payload');

      const result = await updates.check(contract.data);
      await store.eventInsert('updates.check', request.currentUser?.id ?? null, {
        currentVersion,
        channel: result.channel,
        updateAvailable: result.updateAvailable,
      });
      return reply.send(result);
    },
  );

  /** Публичная сводка о последней версии — для витрины сайта. */
  app.get('/api/v1/updates/latest', async (_request, reply) => {
    if (!env.UPDATES_ENABLED) return reply.send({ available: false, release: null });
    const channel = await updates.getChannel();
    const release = await updates.latestForChannel(channel);
    return reply.send({
      available: Boolean(release),
      channel,
      release: release
        ? {
            version: release.version,
            tagName: release.tagName,
            name: release.name,
            htmlUrl: release.htmlUrl,
            publishedAt: release.publishedAt,
            notes: release.body,
            assets: (release.assets ?? []).map((a) => ({ name: a.name, url: a.url, size: a.size })),
          }
        : null,
    });
  });

  // --- администрирование канала обновлений --------------------------------

  app.get('/manage/api/updates', { preHandler: [requireAdmin] }, async () => {
    const channel = await updates.getChannel();
    const minSupportedVersion = await updates.getMinSupportedVersion();
    const releases = await store.releasesList({ limit: 50 });
    return {
      enabled: env.UPDATES_ENABLED,
      repo: env.GITHUB_REPO,
      channel,
      minSupportedVersion,
      cacheTtlSeconds: env.UPDATES_CACHE_TTL_SECONDS,
      releases: releases.map((r) => ({
        id: r.id,
        tagName: r.tagName,
        version: r.version,
        channel: r.channel,
        name: r.name,
        htmlUrl: r.htmlUrl,
        publishedAt: r.publishedAt,
        isPrerelease: r.isPrerelease,
        fetchedAt: r.fetchedAt,
        assets: r.assets?.length ?? 0,
      })),
    };
  });

  app.post<{ Body: unknown }>('/manage/api/updates/refresh', { preHandler: [requireAdmin] }, async (request) => {
    if (!env.UPDATES_ENABLED) throw forbidden('updates_disabled', 'Update channel is disabled');
    const result = await updates.refreshFromGitHub();
    await store.eventInsert('updates.refreshed', request.currentUser!.id, { fetched: result.fetched });
    return { ok: true, fetched: result.fetched, cached: result.releases.length };
  });

  app.patch<{ Body: unknown }>('/manage/api/updates', { preHandler: [requireAdmin] }, async (request) => {
    const body = z
      .object({
        channel: z.enum(['stable', 'beta']).optional(),
        minSupportedVersion: z.string().max(32).nullable().optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) throw badRequest('invalid_body', 'Invalid payload');

    if (body.data.channel) await updates.setChannel(body.data.channel);
    if (body.data.minSupportedVersion !== undefined) {
      try {
        await updates.setMinSupportedVersion(body.data.minSupportedVersion);
      } catch (err) {
        throw badRequest('invalid_version', err instanceof Error ? err.message : 'Invalid version');
      }
    }
    await store.eventInsert('updates.config_changed', request.currentUser!.id, { ...body.data });
    return {
      ok: true,
      channel: await updates.getChannel(),
      minSupportedVersion: await updates.getMinSupportedVersion(),
    };
  });
}
