import type { Queryable } from './db.js';
import { forbidden, notFound } from './errors.js';
import { STRINGS, render } from './i18n/en.js';
import { getSettings } from './settings.js';

export interface Link { guardian_id: string; patient_id: string; can_book: boolean; receives_notifications: boolean; full_name: string }

/**
 * Every parent query goes through here (PRD §13, AC 11). A missing or restricted link is a 404,
 * so neither another family's child nor a restriction is ever revealed.
 */
export async function linkFor(q: Queryable, guardianId: string, patientId: string): Promise<Link> {
  if (!/^[0-9a-f-]{36}$/i.test(patientId)) throw notFound();
  const r = await q.query(
    `SELECT gp.guardian_id, gp.patient_id, gp.can_book, gp.receives_notifications, p.full_name
       FROM guardian_patient gp JOIN patient p ON p.id = gp.patient_id
      WHERE gp.guardian_id = $1 AND gp.patient_id = $2 AND NOT gp.restricted AND p.merged_into_id IS NULL`,
    [guardianId, patientId],
  );
  if (!r.rowCount) throw notFound();
  return r.rows[0];
}

/** Write access: only can_book guardians (AC 7). */
export async function requireCanBook(q: Queryable, guardianId: string, patientId: string): Promise<Link> {
  const link = await linkFor(q, guardianId, patientId);
  if (!link.can_book) {
    const s = await getSettings(q);
    throw forbidden(render(STRINGS.notifyOnlyCannotBook, { child: link.full_name.split(' ')[0], CLINIC_PHONE: s.CLINIC_PHONE }));
  }
  return link;
}

export async function appointmentForGuardian(q: Queryable, guardianId: string, apptId: string, write: boolean) {
  if (!/^[0-9a-f-]{36}$/i.test(apptId)) throw notFound();
  const r = await q.query('SELECT * FROM appointment WHERE id = $1', [apptId]);
  if (!r.rowCount) throw notFound();
  const appt = r.rows[0];
  await (write ? requireCanBook : linkFor)(q, guardianId, appt.patient_id);
  return appt;
}
