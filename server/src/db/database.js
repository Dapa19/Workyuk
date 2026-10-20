import 'dotenv/config';
import sqlite3 from 'sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.resolve(here, '../../data/workyuk.sqlite');
export const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : defaultPath;

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
export const db = new sqlite3.Database(databasePath);
db.configure('busyTimeout', 5000);
db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA journal_mode = WAL');

export const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function onRun(error) {
    if (error) reject(error);
    else resolve({ id: this.lastID, changes: this.changes });
  });
});

export const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
});

export const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
});

let transactionTail = Promise.resolve();
export async function transaction(work) {
  let release;
  const previous = transactionTail;
  transactionTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    await run('BEGIN IMMEDIATE');
    const result = await work({ run, get, all });
    await run('COMMIT');
    return result;
  } catch (error) {
    try { await run('ROLLBACK'); } catch { /* original error is more useful */ }
    throw error;
  } finally {
    release();
  }
}
