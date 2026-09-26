// Usage: tsx scripts/create-staff.ts <email> <password> <ADMIN|PROVIDER> [providerId]
import { hashPassword, newTotpSecret } from '../src/auth.js';
import { createPool } from '../src/db.js';

const [email, password, role = 'ADMIN', providerId] = process.argv.slice(2);
if (!email || !password || password.length < 12) throw new Error('email and a password of 12+ characters are required');
const db = createPool();
const totp = newTotpSecret();
await db.query(
  `INSERT INTO staff_user (email, role, provider_id, password_hash, totp_secret) VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, totp_secret = EXCLUDED.totp_secret, role = EXCLUDED.role`,
  [email, role, providerId ?? null, hashPassword(password), totp]);
console.log(`Staff user ${email} (${role}) saved.`);
console.log(`Add to an authenticator app: otpauth://totp/WellnessAve:${encodeURIComponent(email)}?secret=${totp}&issuer=WellnessAve`);
await db.end();
