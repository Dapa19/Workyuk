import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, run, get, all } from './database.js';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrateDb() {
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const version = Number.parseInt(file.split('-')[0], 10);
    const hasMigrations = await get("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
    const existing = hasMigrations ? await get('SELECT version FROM schema_migrations WHERE version = ?', [version]) : null;
    if (!existing) {
      if (version === 2) {
        const columns = await all('PRAGMA table_info(activity_logs)');
        if (!columns.some((column) => column.name === 'subproject_id')) {
          await run('ALTER TABLE activity_logs ADD COLUMN subproject_id INTEGER REFERENCES subprojects(id) ON DELETE SET NULL');
        }
      }
      const sql = await fs.readFile(path.join(directory, file), 'utf8');
      await new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
      console.log(`Applied migration ${file}`);
    }
  }
  await run('PRAGMA foreign_keys = ON');
  return db;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await migrateDb();
  console.log('Database schema is up to date.');
  db.close();
}
