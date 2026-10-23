import type { Env } from '../config.js';
import type { Store, UserRow } from '../db/types.js';
import { forbidden, unauthorized } from '../http/errors.js';
import { hashPassword, verifyPasswordConstantTime } from '../lib/passwords.js';



/**
 * Вход администратора: логин + пароль, независимо от OAuth.
 *
 * Почему отдельно от OAuth: OAuth-провайдеры (Google/Yandex) настроены не
 * всегда, а панель оператора обязана работать сразу после `docker compose up`.
 * Сообщение «OAuth-провайдеры не настроены» относится к аккаунтам приложения,
 * а не к админке.
 *
 * Безопасность:
 *  - в БД только scrypt-хэш с солью, plaintext нигде не появляется;
 *  - проверка в constant-time, отсутствие аккаунта неотличимо по таймингу;
 *  - демо-вход без пароля существует ТОЛЬКО вне production: кнопка на экране
 *    входа создаёт сессию локального администратора; в production.endpoint
 *    отключён, остаётся пароль из ADMIN_PASSWORD;
 *  - парольный вход даёт доступ только аккаунтам с ролью `admin`.
 */
export class AdminAuthService {
  constructor(private readonly store: Store, private readonly env: Env) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  /** Показывать ли кнопку «Демо-вход» (без пароля): только вне production. */
  demoLoginEnabled(): boolean {
    return !this.isProduction;
  }

  /**
   * Демо-вход без пароля: локальный аккаунт администратора создаётся при
   * необходимости и получает сессию. Пароль при этом НЕ ставится: в боевом
   * режиме доступ даёт только ADMIN_PASSWORD.
   */
  async ensureDemoAdmin(): Promise<UserRow> {
    const email = this.env.ADMIN_EMAIL;
    let user = await this.store.userByEmail(email);
    if (!user || user.deletedAt) {
      user = await this.store.userCreate({ email, name: 'SHELTER Admin', avatarUrl: null, role: 'admin' });
      await this.store.subscriptionUpsert(user.id, { status: 'none' });
    }
    if (user.role !== 'admin') {
      user = (await this.store.userSetRole(user.id, 'admin')) ?? user;
    }
    return user;
  }

  /**
   * Разбор идентификатора входа: email напрямую, короткий логин — как алиас
   * аккаунта администратора (`ADMIN_LOGIN`, по умолчанию `admin`).
   */
  resolveLogin(login: string): string {
    const value = login.trim().toLowerCase();
    if (value.includes('@')) return value;
    if (value && value === this.env.ADMIN_LOGIN) return this.env.ADMIN_EMAIL;
    return value;
  }

  /**
   * Гарантирует существование аккаунта администратора при старте:
   *  - аккаунт `ADMIN_EMAIL` создаётся с ролью admin (если его нет);
   *  - пароль из `ADMIN_PASSWORD` авторитетен при старте (ротация через env);
   *  - без `ADMIN_PASSWORD` вне production ставится демо-пароль, но только
   *    если хэша ещё нет (чтобы не перезаписывать пароль живого демо-стенда).
   */
  async bootstrap(): Promise<{ email: string; created: boolean; passwordSet: boolean }> {
    const email = this.env.ADMIN_EMAIL.toLowerCase();
    const explicit = this.env.ADMIN_PASSWORD;
    if (this.isProduction && !explicit) {
      // Конфигурация с этим не стартует (инвариант), здесь — страховка.
      return { email, created: false, passwordSet: false };
    }
    let user = await this.store.userByEmail(email);
    let created = false;
    if (!user || user.deletedAt) {
      user = await this.store.userCreate({
        email,
        name: 'SHELTER Admin',
        avatarUrl: null,
        role: 'admin',
      });
      await this.store.subscriptionUpsert(user.id, { status: 'none' });
      created = true;
    }
    if (user.role !== 'admin') {
      user = (await this.store.userSetRole(user.id, 'admin')) ?? user;
    }

    let passwordSet = false;
    if (explicit) {
      await this.store.userSetPassword(user.id, hashPassword(explicit));
      passwordSet = true;
    }
    return { email, created, passwordSet };
  }

  /**
   * Проверка логина+пароля. Ошибки намеренно одинаковые для «нет такого
   * email» и «неверный пароль» (401 invalid_credentials), чтобы не давать
   * оракул существования аккаунтов. Не-админ с верным паролем — 403.
   */
  async verify(login: string, password: string): Promise<UserRow> {
    const normalized = this.resolveLogin(login);
    const user = await this.store.userByEmail(normalized);
    const hash = user && !user.deletedAt ? user.passwordHash : null;
    const ok = verifyPasswordConstantTime(password, hash);
    if (!user || user.deletedAt || !ok) {
      throw unauthorized('invalid_credentials', 'Неверный email или пароль');
    }
    if (user.role !== 'admin') {
      throw forbidden('admin_only', 'Панель доступна только администраторам');
    }
    return user;
  }
}
