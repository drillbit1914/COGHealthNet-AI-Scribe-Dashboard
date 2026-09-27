import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@/generated/prisma/client';
import { databaseUrl, pgConfig } from './env';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
export type Queryable = PrismaClient | Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrisma(url = databaseUrl()): PrismaClient {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({ adapter: new PrismaPg(pgConfig(url)) });
}

/** Process-wide client (reused across Next.js hot reloads). */
export function getDb(): PrismaClient {
  globalForPrisma.prisma ??= createPrisma();
  return globalForPrisma.prisma;
}

/**
 * Raw SQL through Prisma. The scheduling core (availability, locking, savepoint retries against the
 * exclusion constraint) is written in SQL because that is where its correctness lives.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function q<T = any>(db: Queryable, sql: string, ...params: unknown[]): Promise<T[]> {
  return db.$queryRawUnsafe<T[]>(sql, ...params);
}
export function exec(db: Queryable, sql: string, ...params: unknown[]): Promise<number> {
  return db.$executeRawUnsafe(sql, ...params);
}

export function withTx<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn, { maxWait: 10000, timeout: 20000 });
}

/** Postgres SQLSTATE from a Prisma/driver-adapter error, wherever the adapter put it. */
export function pgCode(e: unknown): string | undefined {
  const err = e as {
    code?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { code?: string; originalCode?: string } } };
    cause?: { code?: string; originalCode?: string };
  };
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ??
    err?.meta?.driverAdapterError?.cause?.code ??
    err?.cause?.originalCode ??
    err?.cause?.code ??
    (err?.code && /^[0-9A-Z]{5}$/.test(err.code) && !err.code.startsWith('P') ? err.code : undefined) ??
    err?.meta?.code
  );
}

/** exclusion_violation — raised by no_provider_overlap. */
export const isOverlapError = (e: unknown) => pgCode(e) === '23P01';
export const isUniqueError = (e: unknown) => pgCode(e) === '23505' || (e as { code?: string })?.code === 'P2002';
