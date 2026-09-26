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
  // E2E runs against four test providers, not the clinic's real roster.
  execSync(
    `psql "${E2E_DB}" -q -c "DELETE FROM provider; INSERT INTO provider (name, discipline, color, display_order) VALUES ('Provider A','OT','#5B3F8C',0),('Provider B','PT','#1F6F8B',1),('Provider C','OT','#8A4B08',2),('Provider D','PT','#2E7D32',3);"`,
    { stdio: 'pipe' },
  );
  fs.mkdirSync('test-results', { recursive: true });
  fs.rmSync(MESSAGE_LOG, { force: true });
}
