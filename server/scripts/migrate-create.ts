#!/usr/bin/env tsx
/**
 * Создаёт пустой файл миграции: npm run migrate:create -- add_promo_codes
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

const name = process.argv[2] ?? 'migration';
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const safe = name.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
const file = path.join(MIGRATIONS_DIR, `${stamp}_0000_${safe}.sql`);

await writeFile(
  file,
  `-- ${safe}\n-- Миграция должна быть идемпотентной (IF NOT EXISTS / ON CONFLICT).\n\n`,
  'utf8',
);
console.log(`created ${file}`);
