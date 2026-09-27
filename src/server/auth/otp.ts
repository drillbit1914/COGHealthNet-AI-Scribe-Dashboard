import crypto from 'node:crypto';
import { t } from '@/i18n';
import type { Ctx } from '../context';
import { exec, q } from '../db';
import { sessionSecret } from '../env';
import { AppError, tooMany } from '../errors';
import { enqueue } from '../notifications';
import { toE164 } from '../phone';
import { getSettings } from '../settings';

const OTP_TTL_MIN = 10;
const OTP_PER_HOUR = 5; // PRD §13
const OTP_MAX_ATTEMPTS = 5; // PRD §13

const otpHash = (phone: string, code: string) =>
  crypto.createHmac('sha256', sessionSecret()).update(`${phone}:${code}`).digest('hex');

/** Hashed 6-digit code, 10-minute expiry, 5 per phone per hour; sent as T0 via the outbox. */
export async function requestOtp(ctx: Ctx, rawPhone: string) {
  const s = await getSettings(ctx.db);
  const phone = toE164(rawPhone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE);
  const now = ctx.now();
  const [{ n }] = await q<{ n: number }>(
    ctx.db,
    'SELECT count(*)::int n FROM otp_code WHERE phone = $1 AND created_at > $2',
    phone,
    new Date(now.getTime() - 3600000),
  );
  if (n >= OTP_PER_HOUR) throw tooMany('RATE_LIMITED', t('errors.tooManyCodes'));
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await ctx.db.$transaction(async (tx) => {
    await exec(
      tx,
      'INSERT INTO otp_code (phone, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)',
      phone,
      otpHash(phone, code),
      new Date(now.getTime() + OTP_TTL_MIN * 60000),
      now,
    );
    const g = await tx.guardian.findUnique({ where: { phoneE164: phone }, select: { id: true } });
    await enqueue(tx, { key: 'T0', vars: { code }, toPhone: phone, guardianId: g?.id, now });
  });
  if (process.env.NODE_ENV === 'development' && !process.env.WA_ACCESS_TOKEN && !process.env.TWILIO_ACCOUNT_SID)
    console.info(`[dev] Wellness Ave code for ${phone}: ${code}`);
  return { phone };
}

/** Verify; lock after 5 wrong codes. Creates the guardian on first sign-in. */
export async function verifyOtp(ctx: Ctx, rawPhone: string, code: string) {
  const s = await getSettings(ctx.db);
  const phone = toE164(rawPhone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE);
  const now = ctx.now();
  const [otp] = await q(
    ctx.db,
    `SELECT * FROM otp_code WHERE phone = $1 AND consumed_at IS NULL AND expires_at > $2 ORDER BY created_at DESC LIMIT 1`,
    phone,
    now,
  );
  if (!otp) throw new AppError(401, 'CODE_INVALID', t('errors.codeInvalid'));
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw tooMany('CODE_LOCKED', t('errors.codeLocked'));
  const want = Buffer.from(otp.code_hash);
  const got = Buffer.from(otpHash(phone, String(code).trim()));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    const [u] = await q(
      ctx.db,
      'UPDATE otp_code SET attempts = attempts + 1 WHERE id = $1::uuid RETURNING attempts',
      otp.id,
    );
    if (u.attempts >= OTP_MAX_ATTEMPTS) throw tooMany('CODE_LOCKED', t('errors.codeLocked'));
    throw new AppError(401, 'CODE_INVALID', t('errors.codeInvalid'));
  }
  await exec(ctx.db, 'UPDATE otp_code SET consumed_at = $2 WHERE id = $1::uuid', otp.id, now);
  const g = await ctx.db.guardian.upsert({
    where: { phoneE164: phone },
    create: { phoneE164: phone, verifiedAt: now },
    update: {},
    select: { id: true, verifiedAt: true },
  });
  if (!g.verifiedAt) await ctx.db.guardian.update({ where: { id: g.id }, data: { verifiedAt: now } });
  return { guardianId: g.id };
}
