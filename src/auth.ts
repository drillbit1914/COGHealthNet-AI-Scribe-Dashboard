import crypto from 'node:crypto';
import type { Ctx } from './ctx.js';
import type { Queryable } from './db.js';
import { AppError, unauthorized } from './errors.js';
import { STRINGS } from './i18n/en.js';
import { deliver } from './notify/notify.js';
import { toE164 } from './phone.js';
import { getSettings } from './settings.js';
import { audit, type Actor } from './audit.js';

const OTP_TTL_MIN = 10;
const OTP_PER_HOUR = 5;       // PRD §13
const OTP_MAX_ATTEMPTS = 5;   // PRD §13
export const PARENT_SESSION_MS = 30 * 86400000;
export const STAFF_SESSION_MS = 12 * 3600000;

const secret = () => process.env.SESSION_SECRET ?? 'dev-only-secret';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const otpHash = (phone: string, code: string) => crypto.createHmac('sha256', secret()).update(`${phone}:${code}`).digest('hex');

export async function requestOtp(ctx: Ctx, rawPhone: string) {
  const s = await getSettings(ctx.db);
  const phone = toE164(rawPhone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE);
  const now = ctx.now();
  const recent = await ctx.db.query('SELECT count(*)::int n FROM otp_code WHERE phone = $1 AND created_at > $2',
    [phone, new Date(now.getTime() - 3600000)]);
  if (recent.rows[0].n >= OTP_PER_HOUR) throw new AppError(429, 'RATE_LIMITED', STRINGS.tooManyCodes);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await ctx.db.query('INSERT INTO otp_code (phone, code_hash, expires_at, created_at) VALUES ($1,$2,$3,$4)',
    [phone, otpHash(phone, code), new Date(now.getTime() + OTP_TTL_MIN * 60000), now]);
  const g = await ctx.db.query('SELECT id FROM guardian WHERE phone_e164 = $1', [phone]);
  // Authentication template by WhatsApp; SMS fallback on failure (PRD §5 step 1).
  await deliver(ctx, { guardianId: g.rows[0]?.id, apptId: null, key: 'T0', to: phone,
    body: `Your ${s.CLINIC_NAME} code is ${code}. It expires in ${OTP_TTL_MIN} minutes.`, buttons: [],
    vars: { clinic: s.CLINIC_NAME, code }, whatsapp: true });
  return { phone };
}

export async function verifyOtp(ctx: Ctx, rawPhone: string, code: string) {
  const s = await getSettings(ctx.db);
  const phone = toE164(rawPhone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE);
  const now = ctx.now();
  const r = await ctx.db.query(
    `SELECT * FROM otp_code WHERE phone = $1 AND consumed_at IS NULL AND expires_at > $2 ORDER BY created_at DESC LIMIT 1`, [phone, now]);
  const otp = r.rows[0];
  if (!otp) throw new AppError(401, 'CODE_INVALID', STRINGS.codeInvalid);
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new AppError(429, 'CODE_LOCKED', STRINGS.codeLocked);
  const ok = crypto.timingSafeEqual(Buffer.from(otp.code_hash), Buffer.from(otpHash(phone, String(code).trim())));
  if (!ok) {
    const u = await ctx.db.query('UPDATE otp_code SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [otp.id]);
    if (u.rows[0].attempts >= OTP_MAX_ATTEMPTS) throw new AppError(429, 'CODE_LOCKED', STRINGS.codeLocked);
    throw new AppError(401, 'CODE_INVALID', STRINGS.codeInvalid);
  }
  await ctx.db.query('UPDATE otp_code SET consumed_at = $2 WHERE id = $1', [otp.id, now]);
  const g = await ctx.db.query(
    `INSERT INTO guardian (phone_e164, verified_at) VALUES ($1,$2)
     ON CONFLICT (phone_e164) DO UPDATE SET verified_at = COALESCE(guardian.verified_at, EXCLUDED.verified_at) RETURNING id`,
    [phone, now]);
  const guardianId = g.rows[0].id as string;
  return { guardianId, token: await createSession(ctx.db, { guardianId }, now) };
}

export async function createSession(q: Queryable, who: { guardianId?: string; staffUserId?: string }, now = new Date()) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = who.guardianId ? PARENT_SESSION_MS : STAFF_SESSION_MS;
  await q.query('INSERT INTO session (token_hash, guardian_id, staff_user_id, expires_at) VALUES ($1,$2,$3,$4)',
    [sha256(token), who.guardianId ?? null, who.staffUserId ?? null, new Date(now.getTime() + ttl)]);
  return token;
}

export async function resolveSession(q: Queryable, token: string | undefined, now = new Date()): Promise<Actor | null> {
  if (!token) return null;
  const r = await q.query(
    `SELECT s.guardian_id, s.staff_user_id, u.role, u.provider_id FROM session s LEFT JOIN staff_user u ON u.id = s.staff_user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`, [sha256(token), now]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.guardian_id) return { type: 'GUARDIAN', id: row.guardian_id };
  return { type: 'STAFF', id: row.staff_user_id, role: row.role, providerId: row.provider_id };
}

export async function endSession(q: Queryable, token: string) {
  await q.query('DELETE FROM session WHERE token_hash = $1', [sha256(token)]);
}

// ---------- Staff: password + TOTP (admin 2FA required, PRD §13) ----------

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 64).toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  return Array.from(crypto.randomBytes(20), (b) => B32[b & 31]).join('');
}
function b32decode(s: string) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}
export function totpAt(secretB32: string, t: number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export const verifyTotp = (secretB32: string, code: string, now = Date.now()) =>
  [-1, 0, 1].some((w) => totpAt(secretB32, now + w * 30000) === String(code).trim());

export async function staffLogin(ctx: Ctx, email: string, password: string, totp?: string) {
  const r = await ctx.db.query('SELECT * FROM staff_user WHERE lower(email) = lower($1)', [email]);
  const u = r.rows[0];
  if (!u || !verifyPassword(password, u.password_hash)) throw unauthorized();
  if (u.role === 'ADMIN' && !u.totp_secret) throw new AppError(403, 'TOTP_REQUIRED', 'Two-factor setup is required for administrators');
  if (u.totp_secret && !verifyTotp(u.totp_secret, totp ?? '', ctx.now().getTime())) throw unauthorized();
  const token = await createSession(ctx.db, { staffUserId: u.id }, ctx.now());
  await audit(ctx.db, { type: 'STAFF', id: u.id, role: u.role }, 'login', 'staff_user', u.id);
  return { token, role: u.role as 'ADMIN' | 'PROVIDER', providerId: u.provider_id as string | null };
}
