# shelter_serv

Серверная часть проекта **SHELTER** (браузер: [`Everick-Ven/shelter`](https://github.com/Everick-Ven/shelter)).

Здесь живут: аккаунты и OAuth (Google / Yandex ID), **единственный источник
правды о премиум-подписке**, заказы и платёжные webhook-и, канал обновлений на
GitHub Releases, витрина браузера и панель управления.

| URL | Что отдаёт |
| --- | --- |
| `https://<домен>/` | презентация браузера (витрина) |
| `https://<домен>/manage` | панель управления (только роль `admin`) |
| `https://<домен>/account` | личный кабинет: подписка, оплата, заказы, удаление данных |
| `https://<домен>/api/v1/...` | API для клиента и интеграций |
| `https://<домен>/healthz` | health-проба |

---

## Быстрый старт

```bash
docker compose up --build
```

Поднимется PostgreSQL 16 и API; миграции применяются автоматически при старте.
Дальше:

- витрина — http://localhost:8080/
- панель — http://localhost:8080/manage
- smoke-проверки — `docker compose exec api sh tests/smoke.sh`

Локально без Docker и без PostgreSQL:

```bash
cd server && npm install && STORE_DRIVER=memory npm run dev
```

Подробности — в **[server/README.md](./server/README.md)**: конфигурация,
миграции, деплой, модель безопасности.

---

## Что внутри

```
docker-compose.yml         # dev-профиль: postgres + api, миграции при старте
docker-compose.prod.yml    # production-профиль: HTTPS (caddy), обязательные секреты
server/
├── src/                   # Fastify + TypeScript: маршруты, сервисы, домен, провайдеры
├── migrations/            # идемпотентные SQL-миграции PostgreSQL
├── public/                # витрина (/), панель (/manage), кабинет (/account), оплата
├── scripts/               # migrate, migrate:create, seed
├── tests/                 # unit (159), integration (PostgreSQL), smoke (22 проверки)
└── docs/                  # контракты интеграции с браузером
```

Ключевые документы:

- **[server/README.md](./server/README.md)** — запуск, миграции, env, деплой, безопасность;
- **[server/docs/client-integration.md](./server/docs/client-integration.md)** —
  замороженные контракты `premium.status`, `premium.checkout`, `app.checkUpdates`.

---

## Принципы, которые нарушать нельзя

1. **Fail-closed.** Любой сбой проверки (недоступность БД, битые данные,
   истёкший срок, неподписанное уведомление) означает «подписка не подтверждена».
   Доступ никогда не выдаётся «на всякий случай».
2. **Клиент ничего не доказывает.** Состояние локального хранилища браузера не
   является подтверждением подписки и на сервер не передаётся. Dev-вход и
   «beta-promo» оплатой не считаются.
3. **Серверная цена.** Клиент присылает только `planId`; сумма и срок берутся из
   серверного каталога (месяц — 299 ₽ / 30 дней, год — 2390 ₽ / 365 дней).
4. **Обновления без автоустановки.** Сервер сообщает номер версии и ссылку на
   релиз; `autoInstall` всегда `false`. Версии — только числовые `X.Y.Z`.
5. **HTTPS и секреты.** TLS обязателен, секреты живут только в окружении или
   secret store — ни одного значения в коде и репозитории.
6. **Показатели из одного места.** `paid_order_count` и `first_payment_at`
   вычисляются из таблицы `orders` (`COUNT` / `MIN` при `status='paid'`) и не
   дублируются в `subscriptions`.

---

## Проверки

```bash
cd server
npm run typecheck     # tsc --noEmit
npm test              # 159 unit-тестов (БД не нужна)
npm run test:integration   # интеграционные с PostgreSQL (нужен DATABASE_URL)
npm run smoke         # 22 smoke-проверки против запущенного сервера
```

CI (`.github/workflows/ci.yml`) выполняет typecheck, unit-тесты, поднимает
docker compose с нуля (с миграциями) и прогоняет smoke-тесты.
