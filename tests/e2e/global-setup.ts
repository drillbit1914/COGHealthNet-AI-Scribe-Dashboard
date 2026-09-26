import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { E2E_DB, MESSAGE_LOG } from '../../playwright.config';

/**
 * Fresh, disposable e2e database per run: apply migrations (non-destructive), truncate every table,
 * then seed. Never point E2E_DATABASE_URL at a real database.
 */
export default function globalSetup() {
  const env = { ...process.env, DATABASE_URL: E2E_DB, DIRECT_URL: E2E_DB };
  execSync('pnpm exec prisma migrate deploy', { env, stdio: 'pipe' });
  execSync(
    `psql "${E2E_DB}" -q -c "DO \\$\\$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP EXECUTE format('TRUNCATE %I CASCADE', t); END LOOP; END \\$\\$;"`,
    { stdio: 'pipe' },
  );
  execSync('pnpm exec tsx prisma/seed.ts', {
    env: { ...env, ADMIN_EMAIL: '', ADMIN_INITIAL_PASSWORD: '' },
    stdio: 'pipe',
  });
  fs.mkdirSync('test-results', { recursive: true });
  fs.rmSync(MESSAGE_LOG, { force: true });
}
