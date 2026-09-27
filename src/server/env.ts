import crypto from 'node:crypto';

/**
 * Deployment settings with sensible fallbacks, so a Vercel + Supabase setup needs as few hand-typed
 * values as possible. Empty strings count as unset (Vercel's import can create empty variables).
 */
export const env = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

/** Runtime connection: our own name first, then the Supabase ↔ Vercel integration's names. */
export const databaseUrl = () =>
  env('DATABASE_URL') ?? env('POSTGRES_URL_NON_POOLING') ?? env('POSTGRES_PRISMA_URL') ?? env('POSTGRES_URL');

/** Migrations need a session-mode (non-transaction-pooled) connection. */
export const directUrl = () => env('DIRECT_URL') ?? env('POSTGRES_URL_NON_POOLING') ?? databaseUrl();

/** Public origin: explicit, else Vercel's production domain, else local dev. */
export const appBaseUrl = () => {
  const explicit = env('APP_BASE_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = env('VERCEL_PROJECT_PRODUCTION_URL') ?? env('VERCEL_URL');
  return vercel ? `https://${vercel}` : 'http://localhost:3000';
};

/**
 * Secret for sealing sessions and signing codes/URLs. Explicit SESSION_SECRET wins; otherwise it is
 * derived from the Supabase service-role key (itself secret and stable), so no one has to invent one.
 */
export function sessionSecret(): string {
  const explicit = env('SESSION_SECRET');
  if (explicit) return explicit;
  const service = env('SUPABASE_SERVICE_ROLE_KEY');
  if (service) return crypto.createHmac('sha256', service).update('wellness-ave-session-v1').digest('hex');
  if (process.env.NODE_ENV === 'production' && process.env.E2E !== '1')
    throw new Error('Set SESSION_SECRET (or SUPABASE_SERVICE_ROLE_KEY) in production');
  return 'dev-only-secret-dev-only-secret-000';
}

/**
 * pg options for a connection string. Supabase (pooler) needs TLS; its certificate chain isn't in
 * Node's default store, so TLS is kept on without chain verification. `sslmode` and pooler flags are
 * stripped from the URL because pg would let them override the explicit TLS setting.
 */
export function pgConfig(url: string) {
  const u = new URL(url);
  const supabase = /\.supabase\.(co|com)$/.test(u.hostname);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'pgbouncer', 'supa']) u.searchParams.delete(p);
  return { connectionString: u.toString(), ...(supabase ? { ssl: { rejectUnauthorized: false } } : {}) };
}
