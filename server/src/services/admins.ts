import type { Env } from '../config.js';
import type { Store, UserRow } from '../db/types.js';
import { forbidden, unauthorized } from '../http/errors.js';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_LOGIN,
  DEMO_ADMIN_PASSWORD,
  hashPassword,
  verifyPasswordConstantTime,
} from '../lib/passwords.js';

export interface AdminDemoCredentials {
  /** Короткий логин для экрана входа (по умолчанию `admin`). */
  login: string;
  email: string;
  password: string;
  /** true, если это встроенный демо-пароль (не задан через env). */
  isDemo: boolean;
}

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
 *  - демо-пароль существует ТОЛЬКО вне production; в production конфигурация
 *    с ним не стартует (см. инварианты в config.ts);
 *  - парольный вход даёт доступ только аккаунтам с ролью `admin`.
 */
export class AdminAuthService {
  constructor(private readonly store: Store, private readonly env: Env) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  /** Учётные данные для подсказки на экране входа (только вне production). */
  demoCredentials(): AdminDemoCredentials | null {
    if (this.isProduction) return null;
    const email = this.env.ADMIN_EMAIL;
    const login = this.env.ADMIN_LOGIN;
    if (this.env.ADMIN_PASSWORD) return { login, email, password: this.env.ADMIN_PASSWORD, isDemo: false };
    return { login: DEMO_ADMIN_LOGIN, email, password: DEMO_ADMIN_PASSWORD, isDemo: true };
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
    const password = explicit ?? DEMO_ADMIN_PASSWORD;

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

    const fresh = await this.store.userById(user.id);
    let passwordSet = false;
    if (explicit || !fresh?.passwordHash) {
      await this.store.userSetPassword(user.id, hashPassword(password));
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

export { DEMO_ADMIN_EMAIL, DEMO_ADMIN_LOGIN, DEMO_ADMIN_PASSWORD };
