import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { seedDefaults } from '../src/seed.js';

const db = createPool();
await migrate(db);
await seedDefaults(db);
console.log('Migrated and seeded clinic defaults.');
await db.end();
