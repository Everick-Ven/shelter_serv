#!/usr/bin/env bash
# ============================================================================
# Smoke-тесты SHELTER: требуют запущенный сервер.
#
#   BASE_URL=http://localhost:8080 npm run smoke
#
# Внутри docker compose:
#   docker compose exec api node tests/smoke.mjs
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://localhost:8080}"

# Если smoke запускается рядом с .env — берём из него те значения, которые не
# заданы в окружении явно (секрет подписи webhook, email администратора и т.п.).
from_env_file() {
  local key="$1" file="${2:-.env}" value=""
  if [ ! -f "$file" ]; then printf ''; return 0; fi
  # `|| true` обязателен: grep возвращает 1, если ключа в файле нет,
  # а при set -euo pipefail это убило бы весь скрипт.
  value="$(grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  printf '%s' "$value"
  return 0
}

if [ -z "${PAYMENT_WEBHOOK_SECRET:-}" ]; then
  PAYMENT_WEBHOOK_SECRET="$(from_env_file PAYMENT_WEBHOOK_SECRET)"
fi
PAYMENT_WEBHOOK_SECRET="${PAYMENT_WEBHOOK_SECRET:-dev-only-webhook-signing-key-change-me}"

if [ -z "${ADMIN_EMAIL:-}" ]; then
  ADMIN_EMAIL="$(from_env_file ADMIN_BOOTSTRAP_EMAILS | cut -d, -f1)"
fi
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@shelter.local}"

if [ -z "${DEV_LOGIN_ENABLED:-}" ]; then
  DEV_LOGIN_ENABLED="$(from_env_file DEV_LOGIN_ENABLED)"
fi
DEV_LOGIN_ENABLED="${DEV_LOGIN_ENABLED:-true}"

if [ -z "${COOKIE_NAME:-}" ]; then
  COOKIE_NAME="$(from_env_file COOKIE_NAME)"
fi
COOKIE_NAME="${COOKIE_NAME:-shelter_session}"

echo "smoke: BASE_URL=${BASE_URL} ADMIN_EMAIL=${ADMIN_EMAIL} DEV_LOGIN=${DEV_LOGIN_ENABLED}"

echo "waiting for ${BASE_URL}/healthz ..."
for i in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    echo "server is up (attempt ${i})"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "server did not become healthy in time" >&2
    exit 1
  fi
  sleep 1
done

BASE_URL="$BASE_URL" \
ADMIN_EMAIL="$ADMIN_EMAIL" \
DEV_LOGIN_ENABLED="$DEV_LOGIN_ENABLED" \
PAYMENT_WEBHOOK_SECRET="$PAYMENT_WEBHOOK_SECRET" \
COOKIE_NAME="$COOKIE_NAME" \
node tests/smoke.mjs
