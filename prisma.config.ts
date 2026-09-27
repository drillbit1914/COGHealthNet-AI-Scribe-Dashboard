import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const v = (n: string) => process.env[n]?.trim() || undefined;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  // Session-mode connection for migrations: our DIRECT_URL, else the Supabase ↔ Vercel integration's names.
  datasource: {
    url: v('DIRECT_URL') ?? v('POSTGRES_URL_NON_POOLING') ?? v('DATABASE_URL') ?? v('POSTGRES_URL') ?? '',
  },
});
