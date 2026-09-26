import 'dotenv/config';
import { createPrisma } from '../src/server/db';
import { seed } from '../src/server/seed';

const db = createPrisma();
await seed(db, { adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_INITIAL_PASSWORD, log: true });
console.log('Seeded Wellness Ave defaults.');
await db.$disconnect();
