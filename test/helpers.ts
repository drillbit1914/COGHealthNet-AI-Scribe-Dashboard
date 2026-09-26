import pg from 'pg';
import type { Ctx } from '../src/ctx.js';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { FakeMessenger } from '../src/notify/messenger.js';
import { seedDefaults } from '../src/seed.js';
import { localToUtc } from '../src/time.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://wav:wav@localhost:5432/wav_test';
export const TZ = 'America/Anguilla';
// Thursday 1 Oct 2026, 08:00 AST. Next clinic days: Fri 2 Oct, Sat 3 Oct.
export const NOW = new Date('2026-10-01T12:00:00Z');
export const FRI = '2026-10-02';
export const SAT = '2026-10-03';
export const at = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return localToUtc(day, h * 60 + m, TZ);
};

export interface TestEnv { db: Db; ctx: Ctx & { messenger: FakeMessenger }; clock: { now: Date }; providers: string[] }

export async function setup(): Promise<TestEnv> {
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  const db = createPool(TEST_DB);
  await migrate(db);
  await seedDefaults(db);
  await db.query(`UPDATE clinic_settings SET settings = settings || '{"ADMIN_ALERT_PHONES":["+12645550000"]}'`);
  const providers: string[] = [];
  for (const [i, [name, d]] of [['Ana', 'OT'], ['Ben', 'PT'], ['Cara', 'OT'], ['Dev', 'PT']].entries()) {
    const r = await db.query(
      'INSERT INTO provider (name, discipline, display_order, phone_e164) VALUES ($1,$2,$3,$4) RETURNING id',
      [name, d, i, `+126455501${i}0`]);
    providers.push(r.rows[0].id);
  }
  const clock = { now: NOW };
  const ctx = { db, messenger: new FakeMessenger(), now: () => clock.now };
  return { db, ctx, clock, providers };
}

let phoneSeq = 1000;
export async function guardian(db: Db, name: string, opts: { whatsapp?: boolean } = {}) {
  const r = await db.query('INSERT INTO guardian (name, phone_e164, whatsapp_opt_in_at, verified_at) VALUES ($1,$2,$3,now()) RETURNING id',
    [name, `+1264555${phoneSeq++}`, opts.whatsapp === false ? null : new Date()]);
  return r.rows[0].id as string;
}

export async function child(db: Db, name: string, links: { g: string; canBook?: boolean; notify?: boolean; restricted?: boolean }[]) {
  const p = await db.query('INSERT INTO patient (full_name, created_by_guardian_id) VALUES ($1,$2) RETURNING id', [name, links[0].g]);
  for (const l of links)
    await db.query(
      'INSERT INTO guardian_patient (guardian_id, patient_id, can_book, receives_notifications, restricted) VALUES ($1,$2,$3,$4,$5)',
      [l.g, p.rows[0].id, l.canBook ?? false, l.notify ?? true, l.restricted ?? false]);
  // Consents on file so follow-up requests for existing children need none.
  for (const t of ['DATA_PROCESSING', 'MESSAGING'])
    await db.query(`INSERT INTO consent (guardian_id, patient_id, type, version) VALUES ($1,$2,$3,'2026-01')`, [links[0].g, p.rows[0].id, t]);
  return p.rows[0].id as string;
}

export const ADMIN = { type: 'STAFF' as const, id: '00000000-0000-0000-0000-000000000001', role: 'ADMIN' as const };

export async function onlyProviders(db: Db, ids: string[]) {
  await db.query('UPDATE provider SET active = (id = ANY($1))', [ids]);
}

export const sentWith = (env: TestEnv, key: string) =>
  env.ctx.messenger.sent.filter((m) => m.templateKey === key || (m.channel === 'SMS' && m.body.includes(key)));
