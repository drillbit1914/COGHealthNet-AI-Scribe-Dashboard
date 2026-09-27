import 'dotenv/config';
import { createPrisma } from '../src/server/db';
import { env } from '../src/server/env';
import { seed } from '../src/server/seed';
import { ensurePrivateBucket } from '../src/server/storage';

const db = createPrisma();
const adminEmail = env('ADMIN_EMAIL') ?? 'kniquiah.hughes@gmail.com';
const adminPassword = env('ADMIN_INITIAL_PASSWORD');
await seed(db, { adminEmail, adminPassword, log: true });
if (!adminPassword && !(await db.staffUser.count()))
  console.warn('No staff login exists yet: set ADMIN_INITIAL_PASSWORD and redeploy to create the first admin.');
try {
  console.log(`Storage bucket: ${await ensurePrivateBucket()}`);
} catch (e) {
  console.warn(
    `Storage bucket not ready (create "wellness-ave-private" in Supabase → Storage): ${(e as Error).message}`,
  );
}
console.log('Seeded Wellness Ave defaults.');
await db.$disconnect();
