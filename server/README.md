# SHELTER — серверная часть

Сервер для браузера **SHELTER**: аккаунты и OAuth, проверка премиум-подписки,
заказы и платёжные webhook-и, канал обновлений на GitHub Releases, витрина и
панель управления.

Стек: **Node.js 20+ / TypeScript / Fastify 5 / PostgreSQL 16 / zod / vitest**.

| Что | Где |
| --- | --- |
| Витрина браузера (в стиле Apple) | `https://<домен>/` |
| Панель управления (только роль `admin`) | `https://<домен>/manage` |
| Личный кабинет пользователя | `https://<домен>/account` |
| API | `https://<домен>/api/v1/...` |
| Health-пробы | `/healthz`, `/readyz` |

---

## 1. Быстрый старт

### 1.1. Docker Compose (рекомендуется, «с нуля»)

```bash
# из корня репозитория
docker compose up --build
```

Что произойдёт:

1. поднимется PostgreSQL 16 (с healthcheck'ом);
2. соберётся образ API (`server/Dockerfile`, multi-stage, запуск под непривилегированным пользователем);
3. **миграции применятся автоматически при старте** (`RUN_MIGRATIONS_ON_BOOT=true`);
4. API слушает `0.0.0.0:8080`.

Проверка:

```bash
curl -i http://localhost:8080/healthz
open http://localhost:8080/          # витрина
open http://localhost:8080/manage    # панель управления
```

Демо-данные (необязательно):

```bash
docker compose exec api sh -c 'npm run seed'   # требует dev-зависимостей в образе; см. ниже
# либо с хоста:
DATABASE_URL=postgres://shelter:shelter@localhost:5432/shelter npm --prefix server run seed
```

> В образ кладутся только production-зависимости, поэтому `npm run seed`
> удобнее запускать с хоста (там есть `tsx`), либо использовать `docker compose run --rm api node dist/scripts/...`.
> Seed — только для локальной разработки: при `NODE_ENV=production` скрипт отказывается работать.

Smoke-тесты против поднятого сервиса:

```bash
docker compose exec api sh tests/smoke.sh      # внутри контейнера
BASE_URL=http://localhost:8080 npm --prefix server run smoke   # с хоста
```

### 1.2. Без Docker (локальная разработка)

```bash
cd server
cp .env.example .env      # и заполнить значения
npm install
npm run migrate           # применить миграции к своей БД
npm run dev               # tsx watch src/index.ts
```

Если PostgreSQL под рукой нет, а посмотреть витрину и панель нужно:

```bash
STORE_DRIVER=memory npm run dev
```

`memory` хранит данные только в процессе и **запрещён при `NODE_ENV=production`**
(конфигурация не пройдёт валидацию — сервис не стартует).

### 1.3. Тесты

```bash
cd server
npm test                  # все unit-тесты (БД не нужна)
npm run test:unit         # то же, подробный вывод
npm run test:integration  # интеграционные с PostgreSQL (нужен DATABASE_URL)
npm run typecheck         # tsc --noEmit
npm run smoke             # smoke против запущенного сервера (BASE_URL)
```

Интеграционные тесты без `DATABASE_URL` пропускаются целиком (`describe.skip`) —
это не «зелёные потому что не запускались», а явный пропуск: unit-контур
покрывает ту же логику на in-memory реализации хранилища.

---

## 2. Переменные окружения

Полный список с комментариями — в [`.env.example`](./.env.example). Секреты
**только** из окружения или secret store: в коде и репозитории их нет, а
обязательные значения без дефолтов (сервис не стартует, если их не задать).

Ключевые:

| Переменная | Зачем | Обязательна |
| --- | --- | --- |
| `DATABASE_URL` | строка подключения PostgreSQL | да (при `STORE_DRIVER=pg`) |
| `SESSION_SECRET` | подпись OAuth-state, защита cookie (≥32 символов) | да |
| `PAYMENT_WEBHOOK_SECRET` | проверка подписи платёжных уведомлений | да |
| `PUBLIC_BASE_URL` | публичный https-адрес сервиса | да в production |
| `GOOGLE_CLIENT_ID/SECRET` | вход через Google | при `GOOGLE_ENABLED=true` |
| `YANDEX_CLIENT_ID/SECRET` | вход через Yandex ID | при `YANDEX_ENABLED=true` |
| `YOOKASSA_SHOP_ID/SECRET_KEY` | приём платежей | при `PAYMENT_PROVIDER=yookassa` |
| `ADMIN_BOOTSTRAP_EMAILS` | кто получает роль `admin` при входе | да в production |
| `GITHUB_REPO`, `GITHUB_TOKEN` | источник релизов для канала обновлений | `GITHUB_TOKEN` опционален |

Production-инварианты (проверяются при старте, нарушение = отказ стартовать):

- `PUBLIC_BASE_URL` только `https://`;
- `COOKIE_SECURE=true`;
- `DEV_LOGIN_ENABLED=false`;
- `PAYMENT_PROVIDER != mock`;
- заданы секреты включённых OAuth-провайдеров;
- `STORE_DRIVER=pg`.

Генерация секретов:

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # PAYMENT_WEBHOOK_SECRET
```

---

## 3. Миграции

Файлы: `migrations/*.sql`, применяются по имени, каждая — в своей транзакции,
версии фиксируются в `schema_migrations`. Все миграции **идемпотентны**
(`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), поэтому повторный запуск безопасен.

```bash
DATABASE_URL=postgres://... npm run migrate                 # применить
npm run migrate:create -- add_promo_codes                   # создать новый файл
RUN_MIGRATIONS_ON_BOOT=false npm start                      # не применять при старте
```

Схема: `users`, `user_identities`, `sessions`, `subscriptions`, `orders`,
`payment_events`, `releases`, `app_settings`, `events`.

Осознанные решения:

- **`sessions.token_hash`** — в БД лежит только SHA-256 токена: утечка базы не даёт входа.
- **`subscriptions` НЕ хранит `paid_order_count` / `first_payment_at`** — эти
  показатели вычисляются из `orders` (`COUNT(*)`, `MIN(paid_at)`, `SUM(amount_minor)`
  при `status='paid'`). Дублирование запрещено ТЗ и ломается на первой же ретрансляции webhook'а.
- **`payment_events UNIQUE (provider, event_id)`** — идемпотентность на уровне БД:
  повторная доставка уведомления не продлевает подписку второй раз.
- **`users_email_active_uniq`** — частичный уникальный индекс: после `DELETE /me`
  email зануляется, и тот же адрес можно использовать снова.
- CHECK-ограничения на статусах заказов/подписок и `amount_minor > 0` — «левый»
  статус или нулевую цену не даст записать даже прямой SQL.

---

## 4. API

### 4.1. Аккаунт и OAuth

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/api/v1/auth/providers` | доступные способы входа |
| GET | `/api/v1/auth/:provider/start?redirect=` | начало OAuth (Google/Yandex), ставит подписанный `state` |
| GET | `/api/v1/auth/:provider/callback` | завершение OAuth, ставит сессионную cookie |
| GET | `/api/v1/auth/session` | текущая сессия (для SPA) |
| POST | `/api/v1/auth/logout` | отзыв текущей сессии |
| POST | `/api/v1/auth/dev-login` | **только dev**: аккаунт без подписки |

Google: `id_token` проверяется криптографически по JWKS (`jose`: подпись, `iss`,
`aud`, `exp`). Yandex: `code` → `access_token` → `/info`, токен наружу не отдаётся.
`state` подписан HMAC и сверяется с cookie — CSRF и подмена `redirect` исключены
(внешний и protocol-relative редирект заменяется на `/manage`).

### 4.2. Профиль и подписка

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/api/v1/plans` | каталог тарифов (публично) |
| GET | `/api/v1/me` | профиль + подписка + `billing` (из `orders`) |
| PATCH | `/api/v1/me` | изменить имя/аватар |
| DELETE | `/api/v1/me` | анонимизация данных + отзыв всех сессий + закрытие доступа |
| GET | `/api/v1/me/subscription` | **`premium.status`** — серверная проверка права |
| GET | `/api/v1/me/orders` | история заказов |
| GET | `/api/v1/me/sessions` | активные сессии |
| POST | `/api/v1/me/sessions/revoke` | отозвать одну или все сессии |

### 4.3. Оплата

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/api/v1/checkout` | **`premium.checkout`** — создание заказа и ссылки на оплату |
| GET | `/api/v1/checkout/:orderId` | статус заказа + текущий entitlement |
| POST | `/api/v1/webhooks/payment` | уведомление провайдера (подпись обязательна) |

Клиент передаёт только `planId`: сумма, валюта и срок берутся из серверного
каталога (месяц — 299 ₽ / 30 дней, год — 2390 ₽ / 365 дней). Попытка передать
`amountMinor`/`days`/`currency` в теле игнорируется.

### 4.4. Обновления

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/api/v1/updates/check?currentVersion=X.Y.Z[&channel=auto]` | **`app.checkUpdates`** |
| GET | `/api/v1/updates/latest` | последний релиз канала (для витрины) |

Ответ всегда содержит `autoInstall: false` — автоустановка запрещена: клиент
показывает уведомление и ссылку на страницу релиза.

### 4.5. Панель управления (`/manage/api/*`, только роль `admin`)

`overview`, `users`, `users/:id`, `users/:id` (роль),
`users/:id/subscription/grant`, `users/:id/subscription/revoke`,
`orders`, `orders/:id/refund`, `payments/events`, `updates`,
`updates/refresh`, `health`.

---

## 5. Безопасность и принцип fail-closed

**Единственный источник правды о премиуме** — `src/domain/entitlement.ts`.
Доступ подтверждён, только если: запись подписки найдена, статус `active`,
источник — оплаченный заказ или явный grant администратора, и `expires_at`
в будущем относительно **серверного** времени.

Отказ (`active: false`) возвращается во всех остальных случаях, включая:

- записи нет (`no_subscription`), срок истёк (`expired`), отмена/возврат/отзыв;
- неожиданный статус, пустой `planId`, нечитаемая дата (`invalid_data`);
- **любой сбой проверки**, например недоступность БД (`verification_failed`).

Что из этого следует на практике:

- данные из локального хранилища браузера доказательством подписки не являются
  и в проверку не передаются вообще;
- dev-вход и «beta-promo» дают аккаунт, но не дают доступ: он выдаётся только
  заказом со статусом `paid` либо grant'ом администратора с источником `admin_grant`;
- webhook без корректной подписи → `401`, заказ не становится оплаченным;
- расхождение суммы в уведомлении и в заказе → доступ не выдаётся, событие уходит в аудит;
- повторное уведомление с тем же `event_id` → `duplicate`, срок не продлевается дважды.

Прочее:

- **HTTPS only**: HSTS (`max-age=31536000; includeSubDomains; preload`),
  редирект http→https при `REQUIRE_HTTPS=true` (в production включён),
  cookie `Secure` + `HttpOnly` + `SameSite=Lax`;
- **CSP** `script-src 'self'` без `unsafe-inline`, `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'self'`; плюс `nosniff`, `referrer-policy`,
  `permissions-policy`;
- **rate limit** глобальный (300/мин по умолчанию) и отдельные лимиты на
  auth (10/10 мин), checkout (20/10 мин), webhook (120/мин), updates (60/10 мин);
- **zod** на всех входах: query, body, параметры; отдельный слой — валидация
  самой конфигурации окружения при старте;
- **секреты** только из env: в логах маскируются (`redact`), в репозиторий не попадают;
- роли хранятся в БД: клиент не может повысить себя через запрос.

---

## 6. Деплой

### 6.1. Production-профиль compose

```bash
export POSTGRES_USER=shelter POSTGRES_PASSWORD='...' POSTGRES_DB=shelter
export SESSION_SECRET="$(openssl rand -hex 32)"
export PAYMENT_WEBHOOK_SECRET="$(openssl rand -hex 32)"
export YOOKASSA_SHOP_ID=... YOOKASSA_SECRET_KEY=...
export PUBLIC_BASE_URL=https://shelter.example.com
export ALLOWED_ORIGINS=https://shelter.example.com
export SITE_ADDRESS=shelter.example.com
export ADMIN_BOOTSTRAP_EMAILS=you@example.com
export GOOGLE_ENABLED=true GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

В prod-профиле:

- TLS терминирует **caddy** (Let's Encrypt), API и БД наружу не публикуются;
- секреты объявлены через `${VAR:?...}` — compose **не стартует** без них;
  значений по умолчанию у секретов нет ни в файлах, ни в коде;
- `REQUIRE_HTTPS=true`, `TRUST_PROXY=true`, `COOKIE_SECURE=true`;
- `PAYMENT_PROVIDER=mock` и `DEV_LOGIN_ENABLED=true` запрещены на уровне валидации конфига.

### 6.2. Порядок выката

1. применить миграции (автоматически при старте, либо `npm run migrate` до деплоя);
2. задеплоить новую версию API;
3. проверить `/healthz` и `/readyz`;
4. прогнать `npm run smoke` против боевого адреса;
5. в `/manage` → «Обновления»: проверить канал (`stable`/`beta`) и при
   необходимости задать `minSupportedVersion` (включает `forceUpdate` у старых клиентов).

Откат: миграции обратно не «откатываются» автоматически — файлы идемпотентны и
добавляют только совместимые объекты. Для отката схемы пишите отдельную миграцию
вперёд (forward-only), как принято для боевых БД.

### 6.3. Что нужно настроить во внешних системах

- **Google Cloud**: OAuth-клиент, redirect `https://<домен>/api/v1/auth/google/callback`.
- **Yandex OAuth**: приложение, redirect `https://<домен>/api/v1/auth/yandex/callback`.
- **Платёжный провайдер**: webhook на `https://<домен>/api/v1/webhooks/payment`,
  секрет подписи — в `PAYMENT_WEBHOOK_SECRET`.
- **GitHub**: публичные релизы в `GITHUB_REPO`; `GITHUB_TOKEN` — только для
  повышения лимитов API (не обязателен).

---

## 7. Структура

```
server/
├── migrations/          # идемпотентные SQL-миграции
├── public/              # витрина (/), панель (/manage), кабинет (/account), страницы оплаты
│   ├── index.html       # презентация браузера в стиле Apple
│   ├── assets/          # site.css/js, manage.css/js, account.js, checkout.js
│   ├── manage/          # панель управления (домен/manage)
│   ├── account/         # личный кабинет пользователя
│   └── checkout/        # возврат с оплаты и dev-симуляция
├── scripts/             # migrate, migrate:create, seed
├── src/
│   ├── config.ts        # zod-валидация окружения + production-инварианты
│   ├── app.ts           # сборка Fastify: helmet, cookie, rate-limit, static, маршруты
│   ├── index.ts         # запуск: БД, миграции, провайдеры, graceful shutdown
│   ├── contracts.ts     # замороженные контракты premium.status / checkout / checkUpdates
│   ├── domain/          # entitlement (fail-closed), plans, versions
│   ├── db/              # types (контракт хранилища), pg, memory, migrate
│   ├── providers/       # auth (google/yandex/mock), payments (yookassa/mock)
│   ├── routes/          # health, auth, me, checkout, webhooks, updates, admin
│   ├── services/        # sessions, subscriptions, updates
│   └── lib/             # tokens (HMAC/хеши), time (UTC)
└── tests/
    ├── unit/            # 159 тестов: домен, сервисы, HTTP-контур (in-memory)
    ├── integration/     # PostgreSQL: миграции, схема, e2e-сценарий (нужен DATABASE_URL)
    ├── smoke.mjs        # smoke-проверки живого сервера (22 проверки)
    └── smoke.sh         # обёртка: ждёт /healthz и запускает smoke.mjs
```

Архитектурный приём: прикладная логика зависит от интерфейса `Store`
(`src/db/types.ts`), у которого две реализации — `PgStore` и `MemoryStore`.
Благодаря этому весь HTTP-контур (включая webhook-и и админку) тестируется
быстро и без внешней инфраструктуры, а боевой код идёт по тому же пути.

---

## 8. Известные ограничения

- Реализованы провайдеры платежей **YooKassa** и **mock**; подключение другого
  провайдера — это новая реализация интерфейса `PaymentProvider`
  (`createCheckout` + `verifyWebhook`), маршруты и логика продления не меняются.
- Возвраты принимаются от провайдера (`refund.succeeded`) и из панели (`orders/:id/refund`);
  автоматического пересчёта налога/чеков нет — это зона платёжного провайдера.
- Автопродления подписки нет (по ТЗ): срок заканчивается ровно через оплаченный период.
- Очередь задач/планировщик отсутствует намеренно: просроченные заказы закрывает
  минутный таймер в процессе, а entitlement вычисляется по факту обращения.
