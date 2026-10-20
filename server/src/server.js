import 'dotenv/config';
import { createApp } from './app.js';
import { migrateDb } from './db/migrate.js';
import { db } from './db/database.js';

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
}
await migrateDb();
const port = Number(process.env.PORT) || 3001;
const server = createApp().listen(port, '127.0.0.1', () => console.log(`Workyuk API listening on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => db.close(() => process.exit(0))));
