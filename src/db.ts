import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const out = await fn(tx);
    await tx.query('COMMIT');
    return out;
  } catch (e) {
    await tx.query('ROLLBACK');
    throw e;
  } finally {
    tx.release();
  }
}

/** Postgres exclusion_violation — raised by the no_provider_overlap constraint. */
export const isOverlapError = (e: unknown) => (e as { code?: string })?.code === '23P01';
