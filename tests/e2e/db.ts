import 'dotenv/config';
import pg from 'pg';

/** E2E helper: read the latest OTP from the outbox (the stub provider doesn't send anything yet). */
export async function latestOtp(phone: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    for (let i = 0; i < 20; i++) {
      const r = await c.query(
        `SELECT body FROM message WHERE template_key = 'T0' AND to_phone = $1 ORDER BY created_at DESC LIMIT 1`,
        [phone],
      );
      if (r.rows[0]) return r.rows[0].body.match(/\d{6}/)[0];
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('no OTP');
  } finally {
    await c.end();
  }
}

export const randomPhone = () => `+1264${String(Math.floor(2000000 + Math.random() * 7999999))}`;
