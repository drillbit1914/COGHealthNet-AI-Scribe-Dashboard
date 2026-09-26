import { execSync } from 'node:child_process';

/** Apply pending migrations to the test database once per run (non-destructive; tests truncate between cases). */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://wav:wav@localhost:5432/wav_test';
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, PRISMA_SKIP_POSTINSTALL_GENERATE: '1' },
    stdio: 'pipe',
  });
}
