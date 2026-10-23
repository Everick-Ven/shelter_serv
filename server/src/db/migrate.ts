import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export interface RunMigrationsOptions {
  connectionString: string;
  dir: string;
  ssl?: boolean;
  log?: (msg: string) => void;
}

export interface MigrationsResult {
  applied: string[];
  skipped: string[];
}

/**
 * Применяет *.sql из каталога migrations по имени, фиксируя версии в
 * schema_migrations. Каждый файл — в своей транзакции. Идемпотентно.
 */
export async function runMigrations(opts: RunMigrationsOptions): Promise<MigrationsResult> {
  const log = opts.log ?? (() => {});
  const client = new pg.Client({
    connectionString: opts.connectionString,
    ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(opts.dir)).filter((f) => f.endsWith('.sql')).sort();
    const existing = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r: { version: string }) => r.version),
    );

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (existing.has(version)) {
        skipped.push(version);
        continue;
      }
      const sql = await readFile(path.join(opts.dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        applied.push(version);
        log(`[migrate] applied ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        log(`[migrate] FAILED ${version}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }
    log(`[migrate] done: ${applied.length} applied, ${skipped.length} skipped`);
    return { applied, skipped };
  } finally {
    await client.end();
  }
}
