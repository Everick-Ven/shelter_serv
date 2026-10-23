import type { FastifyInstance } from 'fastify';

export const SERVER_VERSION = process.env.npm_package_version ?? '1.0.0';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    version: SERVER_VERSION,
    uptime: process.uptime(),
  }));

  app.get(
    '/readyz',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const { store, env } = app.deps;
      try {
        await store.settingsGet('updates_channel');
        return {
          status: 'ok',
          version: SERVER_VERSION,
          store: store.kind,
          payments: env.PAYMENT_PROVIDER,
          updates: env.UPDATES_ENABLED,
        };
      } catch (err) {
        request.log.error({ err }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable', store: store.kind });
      }
    },
  );
}
