import type { Queryable } from './db.js';
import { DEFAULT_SETTINGS } from './settings.js';

/** Clinic defaults (PRD §2): Fri 08:00–17:00, Sat 08:00–18:00, clinic-wide. Idempotent. */
export async function seedDefaults(q: Queryable) {
  await q.query('INSERT INTO clinic_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [JSON.stringify(DEFAULT_SETTINGS)]);
  const has = await q.query('SELECT 1 FROM availability_rule WHERE provider_id IS NULL LIMIT 1');
  if (!has.rowCount)
    await q.query(`INSERT INTO availability_rule (provider_id, weekday, start_time, end_time)
                   VALUES (NULL, 5, '08:00', '17:00'), (NULL, 6, '08:00', '18:00')`);
}
