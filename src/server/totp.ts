import crypto from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for admin 2FA. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const newTotpSecret = () => Array.from(crypto.randomBytes(20), (b) => B32[b & 31]).join('');

function b32decode(s: string) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}

export function totpAt(secret: string, ms: number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Accepts the previous, current and next 30-second window. */
export const verifyTotp = (secret: string, code: string, ms = Date.now()) =>
  [-1, 0, 1].some((w) => totpAt(secret, ms + w * 30000) === String(code).trim());

export const totpUri = (secret: string, email: string) =>
  `otpauth://totp/Wellness%20Ave:${encodeURIComponent(email)}?secret=${secret}&issuer=Wellness%20Ave`;
