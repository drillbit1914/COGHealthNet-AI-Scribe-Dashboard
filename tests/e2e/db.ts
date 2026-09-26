import fs from 'node:fs/promises';
import path from 'node:path';

const LOG = path.resolve('test-results/e2e-messages.jsonl');

/** E2E: read the OTP the console messaging stub "sent" (codes are never kept in the database). */
export async function latestOtp(phone: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const lines = (await fs.readFile(LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    const hit = lines
      .map((l) => JSON.parse(l))
      .reverse()
      .find((m) => m.to === phone && m.templateKey === 'T0');
    if (hit) return hit.params[0];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no OTP for ${phone}`);
}

export const randomPhone = () => `+1264${String(Math.floor(2000000 + Math.random() * 7999999))}`;

import crypto from 'node:crypto';
import 'dotenv/config';
import argon2 from 'argon2';
import pg from 'pg';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret: string, ms = Date.now()) {
  let bits = '';
  for (const c of secret) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Create a staff login directly in the dev DB; returns credentials and a TOTP generator. */
export async function createStaff(role: 'ADMIN' | 'PROVIDER', providerName?: string) {
  const c = new pg.Client({
    connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://wav:wav@localhost:5432/wav_e2e',
  });
  await c.connect();
  try {
    const secret = Array.from(crypto.randomBytes(20), (b) => B32[b & 31]).join('');
    const email = `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@wellnessave.test`;
    const password = 'e2e-password-123';
    const provider = providerName
      ? (await c.query('SELECT id FROM provider WHERE name = $1', [providerName])).rows[0]?.id
      : null;
    await c.query(
      'INSERT INTO staff_user (email, role, provider_id, password_hash, totp_secret) VALUES ($1, $2, $3, $4, $5)',
      [email, role, provider, await argon2.hash(password), secret],
    );
    return { email, password, code: () => totp(secret) };
  } finally {
    await c.end();
  }
}
