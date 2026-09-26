import argon2 from 'argon2';
import { t } from '@/i18n';
import { audit } from '../audit';
import type { Ctx } from '../context';
import { AppError } from '../errors';
import { verifyTotp } from '../totp';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
// Unknown emails still pay for one argon2 verify so response timing doesn't reveal which accounts exist.
let dummyHash: Promise<string> | undefined;

/**
 * Email + password (argon2id). TOTP is mandatory for ADMIN and checked for anyone who has enrolled.
 * 5 failures lock the account for 15 minutes. Every attempt is audited.
 */
export async function staffLogin(ctx: Ctx, email: string, password: string, totp?: string) {
  const now = ctx.now();
  const u = await ctx.db.staffUser.findFirst({ where: { email: { equals: email.trim(), mode: 'insensitive' } } });
  const bad = () => new AppError(401, 'BAD_LOGIN', t('errors.badLogin'));
  if (!u || !u.active) {
    await argon2.verify(await (dummyHash ??= argon2.hash('not-a-real-password')), password).catch(() => false);
    throw bad();
  }
  if (u.lockedUntil && u.lockedUntil > now) throw new AppError(429, 'LOCKED', t('errors.locked'));
  if (u.role === 'ADMIN' && !u.totpSecret) throw new AppError(403, 'TOTP_REQUIRED', t('errors.totpRequired'));
  const ok =
    (await argon2.verify(u.passwordHash, password).catch(() => false)) &&
    (!u.totpSecret || verifyTotp(u.totpSecret, totp ?? '', now.getTime()));
  const actor = { type: 'STAFF' as const, id: u.id, role: u.role };
  if (!ok) {
    const failures = u.failedLogins + 1;
    await ctx.db.staffUser.update({
      where: { id: u.id },
      data: {
        failedLogins: failures >= MAX_FAILURES ? 0 : failures,
        lockedUntil: failures >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MS) : null,
      },
    });
    await audit(ctx.db, actor, failures >= MAX_FAILURES ? 'login_locked' : 'login_failed', 'staff_user', u.id);
    throw failures >= MAX_FAILURES ? new AppError(429, 'LOCKED', t('errors.locked')) : bad();
  }
  await ctx.db.staffUser.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
  await audit(ctx.db, actor, 'login', 'staff_user', u.id);
  return { staffId: u.id, role: u.role, providerId: u.providerId };
}

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
