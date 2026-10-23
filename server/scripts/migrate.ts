#!/usr/bin/env tsx
/**
 * Мигратор: применяет server/migrations/*.sql по порядку, отмечая применённые
 * в таблице schema_migrations. Каждый файл выполняется в отдельной транзакции.
 *
 * Запуск:
 *   DATABASE_URL=postgres://... npm run migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[migrate] DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    ssl: ['1', 'true', 'yes', 'on'].includes(String(process.env.PG_SSL ?? '').toLowerCase())
      ? { rejectUnauthorized: true }
      : undefined,
  });

  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r: any) => r.version),
    );

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        console.log(`[migrate] skip  ${version} (already applied)`);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] apply ${version} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        count++;
        console.log(`[migrate] ok    ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(`[migrate] done: ${count} migration(s) applied, ${files.length - count} skipped`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
