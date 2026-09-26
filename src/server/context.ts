import type { PrismaClient } from '@/generated/prisma/client';
import { getDb } from './db';

/** Service context — injected so tests control the clock. */
export interface Ctx {
  db: PrismaClient;
  now: () => Date;
}

export const defaultCtx = (): Ctx => ({ db: getDb(), now: () => new Date() });
