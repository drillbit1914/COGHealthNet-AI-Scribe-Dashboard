import path from 'node:path';
import { buildApp } from './api/app.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { messengerFromEnv } from './notify/messenger.js';
import { seedDefaults } from './seed.js';
import { LocalStorage } from './storage.js';

const db = createPool();
await migrate(db);
await seedDefaults(db);
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required');
const app = await buildApp({
  ctx: { db, messenger: messengerFromEnv(), now: () => new Date() },
  storage: new LocalStorage(process.env.FILE_ROOT ?? path.resolve('.data/files'), process.env.SESSION_SECRET ?? 'dev-only-secret'),
  secureCookies: process.env.NODE_ENV === 'production',
});
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
console.log(`Wellness Ave Scheduling API on :${process.env.PORT ?? 3000}`);
