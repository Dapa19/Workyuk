import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db, run, get } from './database.js';
import { normalizeUsername, now } from '../utils.js';

const username = process.env.SEED_AGENCY_USERNAME?.trim();
const password = process.env.SEED_AGENCY_PASSWORD;
const displayName = process.env.SEED_AGENCY_DISPLAY_NAME?.trim() || 'Admin Workyuk';
if (!username || !password || password.length < 12) {
  console.error('Set SEED_AGENCY_USERNAME and SEED_AGENCY_PASSWORD (minimum 12 characters) in your environment.');
  process.exitCode = 1;
} else {
  const existing = await get('SELECT id FROM users WHERE normalized_username=?', [normalizeUsername(username)]).catch(() => null);
  if (existing) {
    console.error('That username already exists. No account was changed.');
    process.exitCode = 1;
  } else {
    const stamp = now();
    await run(`INSERT INTO users(username, normalized_username, display_name, password_hash, role,
      is_active, must_change_password, created_at, updated_at) VALUES(?, ?, ?, ?, 'agency', 1, 0, ?, ?)`,
    [username, normalizeUsername(username), displayName, await bcrypt.hash(password, 12), stamp, stamp]);
    console.log(`Agency account created for ${normalizeUsername(username)}.`);
  }
}
db.close();
