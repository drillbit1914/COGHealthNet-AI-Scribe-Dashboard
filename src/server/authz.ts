import { t } from '@/i18n';
import { q, type Queryable } from './db';
import { forbidden, notFound } from './errors';
import { getSettings } from './settings';

export interface Link {
  guardian_id: string;
  patient_id: string;
  can_book: boolean;
  receives_notifications: boolean;
  full_name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

/**
 * Every parent read goes through here (PRD §13, AC 11): guardian_patient link AND restricted = false.
 * Missing and restricted both surface as 404 so neither another family's child nor a restriction leaks.
 */
export async function linkFor(db: Queryable, guardianId: string, patientId: string): Promise<Link> {
  if (!isUuid(patientId)) throw notFound();
  const [link] = await q<Link>(
    db,
    `SELECT gp.guardian_id, gp.patient_id, gp.can_book, gp.receives_notifications, p.full_name
       FROM guardian_patient gp JOIN patient p ON p.id = gp.patient_id
      WHERE gp.guardian_id = $1::uuid AND gp.patient_id = $2::uuid AND NOT gp.restricted AND p.merged_into_id IS NULL`,
    guardianId,
    patientId,
  );
  if (!link) throw notFound();
  return link;
}

/** Every parent write additionally requires can_book = true (AC 7). */
export async function requireCanBook(db: Queryable, guardianId: string, patientId: string): Promise<Link> {
  const link = await linkFor(db, guardianId, patientId);
  if (!link.can_book) {
    const s = await getSettings(db);
    throw forbidden(
      t('errors.notifyOnlyCannotBook', { child: firstName(link.full_name), CLINIC_PHONE: s.CLINIC_PHONE }),
    );
  }
  return link;
}

/** Raw appointment row (snake_case columns). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApptRow = Record<string, any>;

export async function appointmentForGuardian(
  db: Queryable,
  guardianId: string,
  apptId: string,
  write: boolean,
): Promise<ApptRow> {
  if (!isUuid(apptId)) throw notFound();
  const [appt] = await q<ApptRow>(db, 'SELECT * FROM appointment WHERE id = $1::uuid', apptId);
  if (!appt) throw notFound();
  await (write ? requireCanBook : linkFor)(db, guardianId, appt.patient_id);
  return appt;
}

export const firstName = (full: string) => full.trim().split(/\s+/)[0];
