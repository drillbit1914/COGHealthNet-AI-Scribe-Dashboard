import { audit, type Actor } from './audit.js';
import type { Ctx } from './ctx.js';
import { withTx } from './db.js';
import { conflict, notFound } from './errors.js';

/** Subject-access export for a child (PRD §13). */
export async function exportPatient(ctx: Ctx, actor: Actor, patientId: string) {
  const q = (sql: string) => ctx.db.query(sql, [patientId]).then((r) => r.rows);
  const patient = (await q('SELECT * FROM patient WHERE id = $1'))[0];
  if (!patient) throw notFound();
  const out = {
    patient,
    guardians: await q(`SELECT g.id, g.name, g.phone_e164, gp.relationship, gp.can_book, gp.receives_notifications
                          FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id WHERE gp.patient_id = $1 AND NOT gp.restricted`),
    appointments: await q('SELECT * FROM appointment WHERE patient_id = $1 ORDER BY starts_at'),
    evaluations: await q('SELECT e.* FROM evaluation_intake e JOIN appointment a ON a.id = e.appointment_id WHERE a.patient_id = $1'),
    consents: await q('SELECT * FROM consent WHERE patient_id = $1'),
    messages: await q(`SELECT m.created_at, m.template_key, m.channel, m.status, m.body FROM message m
                         JOIN appointment a ON a.id = m.appointment_id WHERE a.patient_id = $1 ORDER BY m.created_at`),
    exportedAt: ctx.now(),
  };
  await audit(ctx.db, actor, 'export', 'patient', patientId);
  return out;
}

/**
 * Deletion on request: health and identifying data are erased; appointment rows are kept (anonymized)
 * so schedules, payments and the audit trail stay consistent. Refused while visits are still active.
 */
export async function erasePatient(ctx: Ctx, actor: Actor, patientId: string) {
  await withTx(ctx.db, async (tx) => {
    const active = await tx.query(`SELECT 1 FROM appointment WHERE patient_id = $1 AND status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED')`, [patientId]);
    if (active.rowCount) throw conflict('ACTIVE_APPOINTMENTS', 'Cancel active appointments first');
    const r = await tx.query(`UPDATE patient SET full_name = 'Erased', dob = NULL WHERE id = $1 RETURNING id`, [patientId]);
    if (!r.rowCount) throw notFound();
    await tx.query(`DELETE FROM evaluation_intake WHERE appointment_id IN (SELECT id FROM appointment WHERE patient_id = $1)`, [patientId]);
    await tx.query(`UPDATE payment_proof SET text = NULL, file_key = NULL WHERE appointment_id IN (SELECT id FROM appointment WHERE patient_id = $1)`, [patientId]);
    await tx.query(`UPDATE message SET body = NULL, buttons = NULL WHERE appointment_id IN (SELECT id FROM appointment WHERE patient_id = $1)`, [patientId]);
    await tx.query(`UPDATE waitlist_entry SET status = 'REMOVED' WHERE patient_id = $1`, [patientId]);
    await tx.query('DELETE FROM guardian_patient WHERE patient_id = $1', [patientId]);
    await audit(tx, actor, 'erase', 'patient', patientId);
  });
}

/** Breach-response export: every child and guardian record with contact details, for notification duty. */
export async function breachExport(ctx: Ctx, actor: Actor) {
  const rows = (await ctx.db.query(
    `SELECT p.id patient_id, p.full_name, p.dob, g.name guardian_name, g.phone_e164,
            EXISTS (SELECT 1 FROM evaluation_intake e JOIN appointment a ON a.id = e.appointment_id WHERE a.patient_id = p.id) has_health_intake
       FROM patient p LEFT JOIN guardian_patient gp ON gp.patient_id = p.id AND NOT gp.restricted
       LEFT JOIN guardian g ON g.id = gp.guardian_id WHERE p.merged_into_id IS NULL ORDER BY p.full_name`)).rows;
  await audit(ctx.db, actor, 'breach_export', 'patient', null, null, { rows: rows.length });
  return rows;
}

/** Merge duplicates (PRD §8): links, appointments, consents and waitlist move to the survivor. */
export async function mergePatients(ctx: Ctx, actor: Actor, fromId: string, intoId: string) {
  await withTx(ctx.db, async (tx) => {
    for (const t of ['appointment', 'consent', 'waitlist_entry', 'rebook_entry', 'recurring_series'])
      await tx.query(`UPDATE ${t} SET patient_id = $2 WHERE patient_id = $1`, [fromId, intoId]);
    await tx.query(`INSERT INTO guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications, restricted, notes)
                    SELECT guardian_id, $2, relationship, can_book, receives_notifications, restricted, notes FROM guardian_patient WHERE patient_id = $1
                    ON CONFLICT (guardian_id, patient_id) DO UPDATE SET restricted = guardian_patient.restricted OR EXCLUDED.restricted`, [fromId, intoId]);
    await tx.query('DELETE FROM guardian_patient WHERE patient_id = $1', [fromId]);
    await tx.query('UPDATE patient SET merged_into_id = $2, needs_admin_match = false WHERE id = $1', [fromId, intoId]);
    await tx.query('UPDATE patient SET needs_admin_match = false WHERE id = $1', [intoId]);
    await audit(tx, actor, 'merge', 'patient', fromId, null, { into: intoId });
  });
}

export async function mergeGuardians(ctx: Ctx, actor: Actor, fromId: string, intoId: string) {
  await withTx(ctx.db, async (tx) => {
    await tx.query(`INSERT INTO guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications, restricted, notes)
                    SELECT $2, patient_id, relationship, can_book, receives_notifications, restricted, notes FROM guardian_patient WHERE guardian_id = $1
                    ON CONFLICT (guardian_id, patient_id) DO UPDATE SET
                      can_book = guardian_patient.can_book OR EXCLUDED.can_book,
                      restricted = guardian_patient.restricted OR EXCLUDED.restricted`, [fromId, intoId]);
    await tx.query('DELETE FROM guardian_patient WHERE guardian_id = $1', [fromId]);
    for (const t of ['consent', 'waitlist_entry', 'payment_proof'])
      await tx.query(`UPDATE ${t} SET guardian_id = $2 WHERE guardian_id = $1`, [fromId, intoId]);
    await tx.query('UPDATE appointment SET requested_by_guardian_id = $2 WHERE requested_by_guardian_id = $1', [fromId, intoId]);
    await tx.query('DELETE FROM session WHERE guardian_id = $1', [fromId]);
    await tx.query('UPDATE guardian SET merged_into_id = $2 WHERE id = $1', [fromId, intoId]);
    await audit(tx, actor, 'merge', 'guardian', fromId, null, { into: intoId });
  });
}
