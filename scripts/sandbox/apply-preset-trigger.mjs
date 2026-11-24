// Disposable bootstrap only: never implicitly target a production database.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL) {
  throw new Error('Refusing preset trigger setup without an explicit disposable database');
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query(await readFile(new URL('../../src/db/migrations/tt219-preset-generation-trigger.sql', import.meta.url), 'utf8'));
  console.log('Disposable preset generation trigger installed');
} finally { await db.end(); }
