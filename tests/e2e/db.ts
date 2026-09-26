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
