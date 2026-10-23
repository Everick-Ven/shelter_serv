# ============================================================================
# SHELTER server — production image
# Сборка:  docker build -f server/Dockerfile .
# ============================================================================

FROM node:22-alpine AS build
WORKDIR /app

# Зависимости (включая dev — нужен tsc)
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Исходники -> dist
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# Продакшн-зависимости отдельным слоем
RUN npm prune --omit=dev


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# curl нужен для healthcheck'а compose
RUN apk add --no-cache curl tini

COPY server/package.json server/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/migrations ./migrations
COPY server/public ./public
# Smoke-тесты кладём в образ: их можно запускать внутри контейнера
# (docker compose exec api sh tests/smoke.sh)
COPY server/tests/smoke.mjs server/tests/smoke.sh ./tests/

# Никаких привилегий: запускаемся под непривилегированным пользователем
RUN addgroup -S shelter && adduser -S shelter -G shelter \
    && chown -R shelter:shelter /app
USER shelter

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=4s --start-period=25s --retries=5 \
  CMD curl -fsS http://127.0.0.1:${PORT:-8080}/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
