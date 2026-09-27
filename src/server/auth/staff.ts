import argon2 from 'argon2';
import { sealData, unsealData } from 'iron-session';
import QRCode from 'qrcode';
import { t } from '@/i18n';
import { audit } from '../audit';
import type { Ctx } from '../context';
import { sessionSecret } from '../env';
import { AppError, conflict } from '../errors';
import { newTotpSecret, totpUri, verifyTotp } from '../totp';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const ENROLL_TTL_S = 10 * 60;
// Unknown emails still pay for one argon2 verify so response timing doesn't reveal which accounts exist.
let dummyHash: Promise<string> | undefined;

export type LoginResult =
  | { kind: 'session'; staffId: string; role: 'ADMIN' | 'PROVIDER'; providerId: string | null }
  | { kind: 'enroll'; staffId: string; email: string };

/**
 * Email + password (argon2id). TOTP is mandatory for ADMIN: an admin who has not enrolled yet gets an
 * enrollment step (QR code) after a correct password and cannot reach the console until it is done.
 * 5 failures lock the account for 15 minutes. Every attempt is audited.
 */
export async function staffLogin(ctx: Ctx, email: string, password: string, totp?: string): Promise<LoginResult> {
  const now = ctx.now();
  const u = await ctx.db.staffUser.findFirst({ where: { email: { equals: email.trim(), mode: 'insensitive' } } });
  const bad = () => new AppError(401, 'BAD_LOGIN', t('errors.badLogin'));
  if (!u || !u.active) {
    await argon2.verify(await (dummyHash ??= argon2.hash('not-a-real-password')), password).catch(() => false);
    throw bad();
  }
  if (u.lockedUntil && u.lockedUntil > now) throw new AppError(429, 'LOCKED', t('errors.locked'));
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
  if (u.role === 'ADMIN' && !u.totpSecret) {
    await audit(ctx.db, actor, 'login_needs_2fa_setup', 'staff_user', u.id);
    return { kind: 'enroll', staffId: u.id, email: u.email };
  }
  await audit(ctx.db, actor, 'login', 'staff_user', u.id);
  return { kind: 'session', staffId: u.id, role: u.role, providerId: u.providerId };
}

interface EnrollToken {
  staffId: string;
  secret: string;
  exp: number;
}
const password = () => sessionSecret();

/** Start 2FA enrollment: a fresh secret sealed into a 10-minute token, plus its QR code. */
export async function startEnrollment(ctx: Ctx, staffId: string, email: string) {
  const secret = newTotpSecret();
  const uri = totpUri(secret, email);
  const setupToken = await sealData(
    { staffId, secret, exp: ctx.now().getTime() + ENROLL_TTL_S * 1000 } satisfies EnrollToken,
    {
      password: password(),
      ttl: ENROLL_TTL_S,
    },
  );
  return { setupToken, secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }), uri };
}

/** Finish enrollment: the first code from the authenticator proves the secret was saved. */
export async function finishEnrollment(ctx: Ctx, setupToken: string, code: string): Promise<LoginResult> {
  let tok: EnrollToken;
  try {
    tok = await unsealData<EnrollToken>(setupToken, { password: password() });
  } catch {
    throw new AppError(401, 'SETUP_EXPIRED', t('errors.setupExpired'));
  }
  if (!tok?.staffId || tok.exp < ctx.now().getTime())
    throw new AppError(401, 'SETUP_EXPIRED', t('errors.setupExpired'));
  if (!verifyTotp(tok.secret, code, ctx.now().getTime())) throw new AppError(401, 'BAD_CODE', t('errors.codeInvalid'));
  const done = await ctx.db.staffUser.updateMany({
    where: { id: tok.staffId, totpSecret: null, active: true },
    data: { totpSecret: tok.secret },
  });
  if (!done.count) throw conflict('ALREADY_ENROLLED', t('errors.alreadyEnrolled'));
  const u = await ctx.db.staffUser.findUniqueOrThrow({ where: { id: tok.staffId } });
  await audit(ctx.db, { type: 'STAFF', id: u.id, role: u.role }, 'totp_enrolled', 'staff_user', u.id);
  return { kind: 'session', staffId: u.id, role: u.role, providerId: u.providerId };
}

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
