import { afterEach, describe, expect, it } from 'vitest';
import { appBaseUrl, databaseUrl, directUrl, pgConfig, sessionSecret } from '@/server/env';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});
const clear = (...names: string[]) => names.forEach((n) => delete process.env[n]);

describe('deployment fallbacks', () => {
  it('uses the Supabase ↔ Vercel integration variables when ours are missing or empty', () => {
    clear('DATABASE_URL', 'DIRECT_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL');
    process.env.DATABASE_URL = ''; // Vercel import can create empty variables
    process.env.POSTGRES_URL_NON_POOLING =
      'postgres://s:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require';
    expect(databaseUrl()).toBe(process.env.POSTGRES_URL_NON_POOLING);
    expect(directUrl()).toBe(process.env.POSTGRES_URL_NON_POOLING);
    process.env.DATABASE_URL = 'postgres://mine';
    expect(databaseUrl()).toBe('postgres://mine');
  });

  it('Supabase hosts get TLS; sslmode and pooler flags are stripped so pg keeps that TLS setting', () => {
    const c = pgConfig(
      'postgres://u:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true&connect_timeout=15',
    );
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
    expect(c.connectionString).toBe(
      'postgres://u:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres?connect_timeout=15',
    );
    expect(pgConfig('postgres://wav:wav@localhost:5432/wav')).toEqual({
      connectionString: 'postgres://wav:wav@localhost:5432/wav',
    });
  });

  it('web address: explicit, else Vercel production domain, else localhost', () => {
    clear('APP_BASE_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL');
    expect(appBaseUrl()).toBe('http://localhost:3000');
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'wellness-ave.vercel.app';
    expect(appBaseUrl()).toBe('https://wellness-ave.vercel.app');
    process.env.APP_BASE_URL = 'https://book.wellnessave.com/';
    expect(appBaseUrl()).toBe('https://book.wellnessave.com');
  });

  it('session secret: explicit, else derived from the service-role key (stable, never the key itself)', () => {
    clear('SESSION_SECRET');
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-example';
    const a = sessionSecret();
    expect(a).toHaveLength(64);
    expect(a).not.toContain('service-role');
    expect(sessionSecret()).toBe(a);
    process.env.SESSION_SECRET = 'x'.repeat(40);
    expect(sessionSecret()).toBe('x'.repeat(40));
  });
});
