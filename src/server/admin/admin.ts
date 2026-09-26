/**
 * Admin/provider console read models and non-appointment writes (PRD §9). Appointment state changes
 * stay in src/server/appointments.ts. Every write is audited.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { t } from '@/i18n';
import { audit, type Actor } from '../audit';
import { hashPassword } from '../auth/staff';
import type { Ctx } from '../context';
import { exec, q, withTx } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { toE164 } from '../phone';
import { getSettings } from '../settings';
import { getStorage } from '../storage';
import { addDays, localToUtc } from '../time';
import { newTotpSecret, totpUri } from '../totp';
import { SettingsPatch } from './settings-schema';

export type Staff = Extract<Actor, { type: 'STAFF' }>;
const own = (a: Staff) => (a.role === 'PROVIDER' ? (a.providerId ?? '00000000-0000-0000-0000-000000000000') : null);
export const requireAdmin = (a: Staff) => {
  if (a.role !== 'ADMIN') throw forbidden();
};
const signed = async (key: string | null) => (key ? getStorage().signedUrl(key) : null);

export const DateRange = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
async function utcRange(ctx: Ctx, raw: unknown) {
  const r = DateRange.parse(raw);
  const tz = (await getSettings(ctx.db)).TIMEZONE;
  return [localToUtc(r.from, 0, tz), localToUtc(addDays(r.to, 1), 0, tz)] as const;
}

// ---------- Approval queue ----------

export async function queue(ctx: Ctx, actor: Staff) {
  const rows = await q(
    ctx.db,
    `SELECT a.id, a.ref, a.visit_type::text, a.starts_at, a.ends_at, a.status::text, a.expires_at, a.created_at, a.provider_id,
            a.provider_assigned_by::text, a.original_starts_at, a.payment_status::text,
            pr.name provider_name, pr.discipline::text, pr.color provider_color,
            p.id patient_id, p.full_name child, p.dob, p.needs_admin_match,
            g.name requested_by, g.phone_e164 requested_by_phone,
            (SELECT count(*)::int FROM appointment x WHERE x.patient_id = a.patient_id AND x.status = 'NO_SHOW') no_shows,
            (SELECT count(*)::int FROM appointment x WHERE x.patient_id = a.patient_id AND x.late_cancel) late_cancels,
            (SELECT count(*)::int FROM payment_proof pp WHERE pp.appointment_id = a.id AND pp.reviewed_at IS NULL) proofs,
            e.reason_text, e.reason_tags, e.payer_type::text, e.insurer, e.member_no, e.has_referral, e.referral_file_key
       FROM appointment a JOIN provider pr ON pr.id = a.provider_id JOIN patient p ON p.id = a.patient_id
       LEFT JOIN guardian g ON g.id = a.requested_by_guardian_id LEFT JOIN evaluation_intake e ON e.appointment_id = a.id
      WHERE a.status IN ('REQUESTED','ALTERNATE_PROPOSED') AND ($1::uuid IS NULL OR a.provider_id = $1::uuid)
      ORDER BY a.created_at`,
    own(actor),
  );
  return Promise.all(rows.map(async (r) => ({ ...r, referral_url: await signed(r.referral_file_key) })));
}

// ---------- Calendar ----------

export async function calendar(ctx: Ctx, actor: Staff, raw: unknown) {
  const [from, to] = await utcRange(ctx, raw);
  const mine = own(actor);
  const [providers, appointments, timeOff, rules] = await Promise.all([
    q(
      ctx.db,
      `SELECT id, name, discipline::text, color, display_order FROM provider WHERE active AND ($1::uuid IS NULL OR id = $1::uuid) ORDER BY display_order, name`,
      mine,
    ),
    q(
      ctx.db,
      `SELECT a.id, a.ref, a.provider_id, a.visit_type::text, a.starts_at, a.ends_at, a.status::text, a.payment_status::text,
              p.full_name child, p.id patient_id
         FROM appointment a JOIN patient p ON p.id = a.patient_id
        WHERE a.status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED','COMPLETED','NO_SHOW') AND a.starts_at < $2 AND a.ends_at > $1
          AND ($3::uuid IS NULL OR a.provider_id = $3::uuid) ORDER BY a.starts_at`,
      from,
      to,
      mine,
    ),
    q(
      ctx.db,
      `SELECT id, provider_id, starts_at, ends_at, reason, is_closure FROM time_off
        WHERE starts_at < $2 AND ends_at > $1 AND ($3::uuid IS NULL OR provider_id IS NULL OR provider_id = $3::uuid) ORDER BY starts_at`,
      from,
      to,
      mine,
    ),
    q(ctx.db, `SELECT provider_id, weekday, start_time::text, end_time::text FROM availability_rule`),
  ]);
  return { providers, appointments, timeOff, rules };
}

// ---------- Patients & guardians ----------

export async function searchPatients(ctx: Ctx, term: string) {
  return q(
    ctx.db,
    `SELECT p.id, p.full_name, p.dob, p.needs_admin_match,
            (SELECT count(*)::int FROM appointment a WHERE a.patient_id = p.id AND a.status = 'NO_SHOW') no_shows,
            (SELECT string_agg(g.name || ' ' || g.phone_e164, ', ') FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id WHERE gp.patient_id = p.id) guardians
       FROM patient p
      WHERE p.merged_into_id IS NULL AND p.full_name <> 'Erased'
        AND ($1 = '' OR p.full_name ILIKE '%' || $1 || '%' OR EXISTS (
              SELECT 1 FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id
               WHERE gp.patient_id = p.id AND (g.phone_e164 LIKE '%' || regexp_replace($1, '\\D', '', 'g') || '%' AND regexp_replace($1, '\\D', '', 'g') <> ''
                                               OR g.name ILIKE '%' || $1 || '%')))
      ORDER BY p.needs_admin_match DESC, p.full_name LIMIT 50`,
    term.trim().slice(0, 100),
  );
}

export async function patientProfile(ctx: Ctx, actor: Staff, id: string) {
  const [patient] = await q(ctx.db, 'SELECT * FROM patient WHERE id = $1::uuid', id);
  if (!patient) throw notFound();
  const [guardians, visits, intakes, consents] = await Promise.all([
    q(
      ctx.db,
      `SELECT g.id, g.name, g.phone_e164, g.whatsapp_opt_in_at, g.sms_opt_out_at, gp.relationship, gp.can_book, gp.receives_notifications,
              gp.restricted, gp.notes
         FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id WHERE gp.patient_id = $1::uuid ORDER BY gp.can_book DESC, g.name`,
      id,
    ),
    q(
      ctx.db,
      `SELECT a.id, a.ref, a.visit_type::text, a.starts_at, a.status::text, a.payment_status::text, a.payment_reference, a.late_cancel,
              a.decline_reason, a.cancel_reason, pr.name provider
         FROM appointment a JOIN provider pr ON pr.id = a.provider_id WHERE a.patient_id = $1::uuid ORDER BY a.starts_at DESC`,
      id,
    ),
    q(
      ctx.db,
      `SELECT e.*, a.ref, a.starts_at FROM evaluation_intake e JOIN appointment a ON a.id = e.appointment_id
        WHERE a.patient_id = $1::uuid ORDER BY a.starts_at DESC`,
      id,
    ),
    q(
      ctx.db,
      `SELECT c.type::text, c.version, c.granted_at, c.withdrawn_at, g.name guardian FROM consent c JOIN guardian g ON g.id = c.guardian_id WHERE c.patient_id = $1::uuid`,
      id,
    ),
  ]);
  await audit(ctx.db, actor, 'view', 'patient', id); // access to health records is itself audited
  return {
    patient,
    guardians,
    visits,
    consents,
    intakes: await Promise.all(intakes.map(async (e) => ({ ...e, referral_url: await signed(e.referral_file_key) }))),
    noShows: visits.filter((v) => v.status === 'NO_SHOW').length,
    lateCancels: visits.filter((v) => v.late_cancel).length,
  };
}

export async function updatePatient(ctx: Ctx, actor: Staff, id: string, raw: unknown) {
  const b = z
    .object({
      fullName: z.string().trim().min(1).max(120).optional(),
      dob: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      needsAdminMatch: z.boolean().optional(),
    })
    .parse(raw);
  const before = await ctx.db.patient.findUnique({
    where: { id },
    select: { fullName: true, dob: true, needsAdminMatch: true },
  });
  if (!before) throw notFound();
  const after = await ctx.db.patient.update({
    where: { id },
    data: {
      fullName: b.fullName,
      dob: b.dob === undefined ? undefined : b.dob ? new Date(b.dob) : null,
      needsAdminMatch: b.needsAdminMatch,
    },
    select: { fullName: true, dob: true, needsAdminMatch: true },
  });
  await audit(ctx.db, actor, 'update', 'patient', id, before, after);
  return after;
}

/** Guardian ↔ child flags (PRD §8). `restricted` is admin-only and never shown to parents. */
export async function upsertGuardianLink(ctx: Ctx, actor: Staff, raw: unknown) {
  requireAdmin(actor);
  const b = z
    .object({
      patientId: z.uuid(),
      guardianId: z.uuid().optional(),
      phone: z.string().optional(),
      name: z.string().trim().max(120).optional(),
      relationship: z.string().trim().max(60).nullable().optional(),
      canBook: z.boolean().optional(),
      receivesNotifications: z.boolean().optional(),
      restricted: z.boolean().optional(),
      notes: z.string().max(1000).nullable().optional(),
    })
    .parse(raw);
  const s = await getSettings(ctx.db);
  return withTx(ctx.db, async (tx) => {
    let gid = b.guardianId;
    if (!gid) {
      if (!b.phone) throw badRequest('Phone is required');
      const g = await tx.guardian.upsert({
        where: { phoneE164: toE164(b.phone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE) },
        create: { phoneE164: toE164(b.phone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE), name: b.name || null },
        update: {},
      });
      gid = g.id;
    }
    const key = { guardianId_patientId: { guardianId: gid, patientId: b.patientId } };
    const before = await tx.guardianPatient.findUnique({ where: key });
    const data = {
      relationship: b.relationship,
      canBook: b.canBook,
      receivesNotifications: b.receivesNotifications,
      restricted: b.restricted,
      notes: b.notes,
    };
    const after = await tx.guardianPatient.upsert({
      where: key,
      create: {
        guardianId: gid,
        patientId: b.patientId,
        ...data,
        canBook: b.canBook ?? false,
        receivesNotifications: b.receivesNotifications ?? true,
      },
      update: data,
    });
    await audit(tx, actor, before ? 'update' : 'create', 'guardian_patient', `${gid}:${b.patientId}`, before, after);
    return after;
  });
}

/** Merge duplicates (PRD §8): everything moves to the survivor; restrictions are never lost. */
export async function mergePatients(ctx: Ctx, actor: Staff, fromId: string, intoId: string) {
  requireAdmin(actor);
  if (fromId === intoId) throw badRequest('Choose two different records');
  await withTx(ctx.db, async (tx) => {
    for (const tbl of ['appointment', 'consent', 'waitlist_entry', 'rebook_entry', 'recurring_series'])
      await exec(tx, `UPDATE ${tbl} SET patient_id = $2::uuid WHERE patient_id = $1::uuid`, fromId, intoId);
    await exec(
      tx,
      `INSERT INTO guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications, restricted, notes, added_by_guardian_id)
       SELECT guardian_id, $2::uuid, relationship, can_book, receives_notifications, restricted, notes, added_by_guardian_id
         FROM guardian_patient WHERE patient_id = $1::uuid
       ON CONFLICT (guardian_id, patient_id) DO UPDATE SET
         restricted = guardian_patient.restricted OR EXCLUDED.restricted,
         can_book = guardian_patient.can_book OR EXCLUDED.can_book`,
      fromId,
      intoId,
    );
    await exec(tx, 'DELETE FROM guardian_patient WHERE patient_id = $1::uuid', fromId);
    await exec(
      tx,
      'UPDATE patient SET merged_into_id = $2::uuid, needs_admin_match = false WHERE id = $1::uuid',
      fromId,
      intoId,
    );
    await exec(tx, 'UPDATE patient SET needs_admin_match = false WHERE id = $1::uuid', intoId);
    await audit(tx, actor, 'merge', 'patient', fromId, null, { into: intoId });
  });
}

export async function mergeGuardians(ctx: Ctx, actor: Staff, fromId: string, intoId: string) {
  requireAdmin(actor);
  if (fromId === intoId) throw badRequest('Choose two different records');
  await withTx(ctx.db, async (tx) => {
    await exec(
      tx,
      `INSERT INTO guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications, restricted, notes)
       SELECT $2::uuid, patient_id, relationship, can_book, receives_notifications, restricted, notes FROM guardian_patient WHERE guardian_id = $1::uuid
       ON CONFLICT (guardian_id, patient_id) DO UPDATE SET
         can_book = guardian_patient.can_book OR EXCLUDED.can_book,
         restricted = guardian_patient.restricted OR EXCLUDED.restricted`,
      fromId,
      intoId,
    );
    await exec(tx, 'DELETE FROM guardian_patient WHERE guardian_id = $1::uuid', fromId);
    for (const tbl of ['consent', 'waitlist_entry', 'payment_proof'])
      await exec(tx, `UPDATE ${tbl} SET guardian_id = $2::uuid WHERE guardian_id = $1::uuid`, fromId, intoId);
    await exec(
      tx,
      'UPDATE appointment SET requested_by_guardian_id = $2::uuid WHERE requested_by_guardian_id = $1::uuid',
      fromId,
      intoId,
    );
    // Merged account: its sessions stop working immediately.
    await exec(
      tx,
      'UPDATE guardian SET merged_into_id = $2::uuid, sessions_valid_after = now() WHERE id = $1::uuid',
      fromId,
      intoId,
    );
    await audit(tx, actor, 'merge', 'guardian', fromId, null, { into: intoId });
  });
}

// ---------- Privacy (PRD §13) ----------

export async function exportPatient(ctx: Ctx, actor: Staff, id: string) {
  requireAdmin(actor);
  const rows = (sql: string) => q(ctx.db, sql, id);
  const [patient] = await rows('SELECT * FROM patient WHERE id = $1::uuid');
  if (!patient) throw notFound();
  const out = {
    exportedAt: ctx.now(),
    patient,
    guardians: await rows(
      `SELECT g.name, g.phone_e164, gp.relationship, gp.can_book, gp.receives_notifications FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id
        WHERE gp.patient_id = $1::uuid AND NOT gp.restricted`,
    ),
    appointments: await rows('SELECT * FROM appointment WHERE patient_id = $1::uuid ORDER BY starts_at'),
    evaluations: await rows(
      'SELECT e.* FROM evaluation_intake e JOIN appointment a ON a.id = e.appointment_id WHERE a.patient_id = $1::uuid',
    ),
    consents: await rows('SELECT * FROM consent WHERE patient_id = $1::uuid'),
    messages: await rows(
      `SELECT m.created_at, m.template_key, m.channel::text, m.status::text, m.body FROM message m JOIN appointment a ON a.id = m.appointment_id
        WHERE a.patient_id = $1::uuid ORDER BY m.created_at`,
    ),
  };
  await audit(ctx.db, actor, 'export', 'patient', id);
  return out;
}

/** Erasure on request: identifying and health data removed; anonymized rows keep schedules and audit consistent. */
export async function erasePatient(ctx: Ctx, actor: Staff, id: string) {
  requireAdmin(actor);
  await withTx(ctx.db, async (tx) => {
    const active = await q(
      tx,
      `SELECT 1 FROM appointment WHERE patient_id = $1::uuid AND status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED')`,
      id,
    );
    if (active.length) throw conflict('ACTIVE_APPOINTMENTS', 'Cancel active appointments first');
    const done = await q(
      tx,
      `UPDATE patient SET full_name = 'Erased', dob = NULL WHERE id = $1::uuid RETURNING id`,
      id,
    );
    if (!done.length) throw notFound();
    const sub = '(SELECT id FROM appointment WHERE patient_id = $1::uuid)';
    await exec(tx, `DELETE FROM evaluation_intake WHERE appointment_id IN ${sub}`, id);
    await exec(tx, `UPDATE payment_proof SET text = NULL, file_key = NULL WHERE appointment_id IN ${sub}`, id);
    await exec(tx, `UPDATE message SET body = NULL, vars = NULL, buttons = NULL WHERE appointment_id IN ${sub}`, id);
    await exec(tx, `UPDATE waitlist_entry SET status = 'REMOVED' WHERE patient_id = $1::uuid`, id);
    await exec(tx, 'DELETE FROM guardian_patient WHERE patient_id = $1::uuid', id);
    await audit(tx, actor, 'erase', 'patient', id);
  });
}

/** Breach-response export: every child with guardian contacts, for notification duties. */
export async function breachExport(ctx: Ctx, actor: Staff) {
  requireAdmin(actor);
  const rows = await q(
    ctx.db,
    `SELECT p.id patient_id, p.full_name, p.dob, g.name guardian_name, g.phone_e164,
            EXISTS (SELECT 1 FROM evaluation_intake e JOIN appointment a ON a.id = e.appointment_id WHERE a.patient_id = p.id) has_health_intake
       FROM patient p LEFT JOIN guardian_patient gp ON gp.patient_id = p.id AND NOT gp.restricted
       LEFT JOIN guardian g ON g.id = gp.guardian_id WHERE p.merged_into_id IS NULL ORDER BY p.full_name`,
  );
  await audit(ctx.db, actor, 'breach_export', 'patient', null, null, { rows: rows.length });
  return rows;
}

// ---------- Payments ----------

export async function unpaid(ctx: Ctx) {
  return q(
    ctx.db,
    `SELECT a.id, a.ref, a.starts_at, a.visit_type::text, a.status::text, p.full_name child,
            (SELECT count(*)::int FROM payment_proof pp WHERE pp.appointment_id = a.id AND pp.reviewed_at IS NULL) proofs
       FROM appointment a JOIN patient p ON p.id = a.patient_id
      WHERE a.payment_status = 'UNPAID' AND a.status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED','COMPLETED') ORDER BY a.starts_at`,
  );
}

export async function paymentTotals(ctx: Ctx, raw: unknown) {
  const [from, to] = await utcRange(ctx, raw);
  const tz = (await getSettings(ctx.db)).TIMEZONE;
  return q(
    ctx.db,
    `SELECT to_char(payment_recorded_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, payment_status::text, count(*)::int n
       FROM appointment WHERE payment_recorded_at >= $1 AND payment_recorded_at < $2 AND payment_status <> 'UNPAID'
      GROUP BY 1, 2 ORDER BY 1, 2`,
    from,
    to,
    tz,
  );
}

export async function proofQueue(ctx: Ctx) {
  const rows = await q(
    ctx.db,
    `SELECT pp.id, pp.appointment_id, pp.text, pp.file_key, pp.received_at, a.ref, a.payment_status::text, p.full_name child, g.name guardian, g.phone_e164
       FROM payment_proof pp JOIN appointment a ON a.id = pp.appointment_id JOIN patient p ON p.id = a.patient_id
       LEFT JOIN guardian g ON g.id = pp.guardian_id WHERE pp.reviewed_at IS NULL ORDER BY pp.received_at`,
  );
  return Promise.all(rows.map(async (r) => ({ ...r, file_url: await signed(r.file_key) })));
}

export async function reviewProof(ctx: Ctx, actor: Staff, id: string) {
  requireAdmin(actor);
  const r = await q(
    ctx.db,
    'UPDATE payment_proof SET reviewed_by = $2::uuid, reviewed_at = $3 WHERE id = $1::uuid AND reviewed_at IS NULL RETURNING id',
    id,
    actor.id,
    ctx.now(),
  );
  if (!r.length) throw notFound();
  await audit(ctx.db, actor, 'review', 'payment_proof', id);
}

// ---------- Time off, rebook list ----------

export const TimeOffInput = z.object({
  providerId: z.uuid().nullable().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  reason: z.string().trim().max(200).optional(),
});

/** Provider or clinic-wide block (date range or partial day). Providers may only add their own. */
export async function addTimeOff(ctx: Ctx, actor: Staff, raw: unknown) {
  const b = TimeOffInput.parse(raw);
  if (actor.role === 'PROVIDER' && b.providerId !== actor.providerId) throw forbidden();
  if (b.endsAt <= b.startsAt) throw badRequest('End must be after start');
  const row = await ctx.db.timeOff.create({
    data: {
      providerId: b.providerId ?? null,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      reason: b.reason || null,
      createdAt: ctx.now(),
    },
  });
  await audit(ctx.db, actor, 'create', 'time_off', row.id, null, row);
  return row;
}

export async function listTimeOff(ctx: Ctx, actor: Staff) {
  return q(
    ctx.db,
    `SELECT t.*, pr.name provider FROM time_off t LEFT JOIN provider pr ON pr.id = t.provider_id
      WHERE t.ends_at > $1 AND ($2::uuid IS NULL OR t.provider_id = $2::uuid OR t.provider_id IS NULL) ORDER BY t.starts_at`,
    ctx.now(),
    own(actor),
  );
}

export async function deleteTimeOff(ctx: Ctx, actor: Staff, id: string) {
  const row = await ctx.db.timeOff.findUnique({ where: { id } });
  if (!row) throw notFound();
  if (actor.role === 'PROVIDER' && row.providerId !== actor.providerId) throw forbidden();
  if (row.isClosure) requireAdmin(actor);
  await ctx.db.timeOff.delete({ where: { id } });
  await audit(ctx.db, actor, 'delete', 'time_off', id, row, null);
}

export async function rebookList(ctx: Ctx) {
  return q(
    ctx.db,
    `SELECT r.id, r.reason, r.created_at, a.ref, a.starts_at, a.visit_type::text, p.id patient_id, p.full_name child,
            (SELECT string_agg(g.name || ' ' || g.phone_e164, ', ') FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id
              WHERE gp.patient_id = p.id AND gp.can_book AND NOT gp.restricted) contacts
       FROM rebook_entry r JOIN appointment a ON a.id = r.appointment_id JOIN patient p ON p.id = r.patient_id
      WHERE r.resolved_at IS NULL ORDER BY r.created_at`,
  );
}

export async function resolveRebook(ctx: Ctx, actor: Staff, id: string) {
  requireAdmin(actor);
  await exec(ctx.db, 'UPDATE rebook_entry SET resolved_at = $2 WHERE id = $1::uuid', id, ctx.now());
  await audit(ctx.db, actor, 'resolve', 'rebook_entry', id);
}

// ---------- Waitlist ----------

export async function waitlist(ctx: Ctx) {
  return q(
    ctx.db,
    `SELECT w.id, w.visit_type::text, w.date_from::text, w.date_to::text, w."window"::text AS "window", w.created_at,
            p.id patient_id, p.full_name child, g.id guardian_id, g.name guardian, g.phone_e164
       FROM waitlist_entry w JOIN patient p ON p.id = w.patient_id JOIN guardian g ON g.id = w.guardian_id
      WHERE w.status = 'ACTIVE' ORDER BY w.created_at`,
  );
}

export async function addWaitlist(ctx: Ctx, actor: Staff, raw: unknown) {
  requireAdmin(actor);
  const b = z
    .object({
      patientId: z.uuid(),
      guardianId: z.uuid(),
      visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      window: z.enum(['ANY', 'MORNING', 'AFTERNOON']).default('ANY'),
    })
    .parse(raw);
  if (b.dateTo < b.dateFrom) throw badRequest(t('errors.invalidRange'));
  const link = await ctx.db.guardianPatient.findUnique({
    where: { guardianId_patientId: { guardianId: b.guardianId, patientId: b.patientId } },
  });
  if (!link || link.restricted || !link.canBook) throw badRequest('Choose a guardian who can book for this child');
  const row = await ctx.db.waitlistEntry.create({
    data: {
      patientId: b.patientId,
      guardianId: b.guardianId,
      visitType: b.visitType,
      dateFrom: new Date(b.dateFrom),
      dateTo: new Date(b.dateTo),
      window: b.window,
      createdAt: ctx.now(),
    },
  });
  await audit(ctx.db, actor, 'create', 'waitlist_entry', row.id, null, b);
  return row;
}

export async function removeWaitlist(ctx: Ctx, actor: Staff, id: string) {
  requireAdmin(actor);
  const r = await q(
    ctx.db,
    `UPDATE waitlist_entry SET status = 'REMOVED' WHERE id = $1::uuid AND status = 'ACTIVE' RETURNING id`,
    id,
  );
  if (!r.length) throw notFound();
  await audit(ctx.db, actor, 'remove', 'waitlist_entry', id);
}

// ---------- Logs ----------

export async function messageLog(ctx: Ctx, raw: unknown) {
  const f = z
    .object({
      status: z.string().max(20).optional(),
      template: z.string().max(10).optional(),
      phone: z.string().max(20).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    })
    .parse(raw);
  return q(
    ctx.db,
    `SELECT m.id, m.created_at, m.updated_at, m.direction::text, m.channel::text, m.status::text, m.template_key, m.to_phone, m.error,
            m.attempts, m.provider_message_id, m.fallback_of_id, m.body, g.name guardian, a.ref
       FROM message m LEFT JOIN guardian g ON g.id = m.guardian_id LEFT JOIN appointment a ON a.id = m.appointment_id
      WHERE ($1::text IS NULL OR m.status::text = $1) AND ($2::text IS NULL OR m.template_key = $2)
        AND ($3::text IS NULL OR m.to_phone LIKE '%' || $3 || '%')
      ORDER BY m.created_at DESC LIMIT $4`,
    f.status || null,
    f.template || null,
    f.phone || null,
    f.limit,
  );
}

export async function auditLog(ctx: Ctx, raw: unknown) {
  const f = z
    .object({
      entity: z.string().max(40).optional(),
      entityId: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    })
    .parse(raw);
  const rows = await q(
    ctx.db,
    `SELECT l.id::text, l.at, l.actor_type, l.actor_id, l.action, l.entity, l.entity_id, l.before, l.after,
            COALESCE(s.email, g.name, g.phone_e164) actor
       FROM audit_log l LEFT JOIN staff_user s ON s.id = l.actor_id LEFT JOIN guardian g ON g.id = l.actor_id
      WHERE ($1::text IS NULL OR l.entity = $1) AND ($2::text IS NULL OR l.entity_id = $2) ORDER BY l.id DESC LIMIT $3`,
    f.entity || null,
    f.entityId || null,
    f.limit,
  );
  return rows;
}

// ---------- Settings, providers, hours, staff ----------

export async function updateSettings(ctx: Ctx, actor: Staff, raw: unknown) {
  requireAdmin(actor);
  const patch = SettingsPatch.parse(raw);
  const before = await getSettings(ctx.db);
  await exec(
    ctx.db,
    `UPDATE clinic_settings SET settings = settings || $1::jsonb, updated_at = $2 WHERE id = 1`,
    JSON.stringify(patch),
    ctx.now(),
  );
  await audit(
    ctx.db,
    actor,
    'update',
    'clinic_settings',
    '1',
    Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof typeof before]])),
    patch,
  );
  return getSettings(ctx.db);
}

export const ProviderInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  discipline: z.enum(['OT', 'PT']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  phone: z.string().trim().max(20).nullable().optional(),
  displayOrder: z.number().int().min(0).max(99).default(0),
  active: z.boolean().default(true),
});

export async function upsertProvider(ctx: Ctx, actor: Staff, raw: unknown) {
  requireAdmin(actor);
  const b = ProviderInput.parse(raw);
  const s = await getSettings(ctx.db);
  const data = {
    name: b.name,
    discipline: b.discipline,
    color: b.color,
    phoneE164: b.phone ? toE164(b.phone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE) : null,
    displayOrder: b.displayOrder,
    active: b.active,
  };
  const before = b.id ? await ctx.db.provider.findUnique({ where: { id: b.id } }) : null;
  const row = b.id
    ? await ctx.db.provider.update({ where: { id: b.id }, data })
    : await ctx.db.provider.create({ data });
  await audit(ctx.db, actor, b.id ? 'update' : 'create', 'provider', row.id, before, row);
  return row;
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Replace opening hours for the clinic (providerId null) or one provider's override. */
export async function replaceRules(ctx: Ctx, actor: Staff, raw: unknown) {
  requireAdmin(actor);
  const b = z
    .object({
      providerId: z.uuid().nullable(),
      rules: z.array(z.object({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm })).max(21),
    })
    .parse(raw);
  for (const r of b.rules) if (r.end <= r.start) throw badRequest('Closing time must be after opening time');
  await withTx(ctx.db, async (tx) => {
    const before = await q(
      tx,
      'SELECT weekday, start_time::text, end_time::text FROM availability_rule WHERE provider_id IS NOT DISTINCT FROM $1::uuid',
      b.providerId,
    );
    await exec(tx, 'DELETE FROM availability_rule WHERE provider_id IS NOT DISTINCT FROM $1::uuid', b.providerId);
    for (const r of b.rules)
      await exec(
        tx,
        'INSERT INTO availability_rule (provider_id, weekday, start_time, end_time) VALUES ($1::uuid, $2, $3::time, $4::time)',
        b.providerId,
        r.weekday,
        r.start,
        r.end,
      );
    await audit(tx, actor, 'replace', 'availability_rule', b.providerId ?? 'clinic', before, b.rules);
  });
}

export async function staffUsers(ctx: Ctx, actor: Staff) {
  requireAdmin(actor);
  return q(
    ctx.db,
    `SELECT s.id, s.email, s.role::text, s.active, s.provider_id, pr.name provider, s.totp_secret IS NOT NULL has_totp FROM staff_user s LEFT JOIN provider pr ON pr.id = s.provider_id ORDER BY s.email`,
  );
}

/** Create a login; returns a one-time temporary password and TOTP enrolment URI (shown once). */
export async function createStaff(ctx: Ctx, actor: Staff, raw: unknown) {
  requireAdmin(actor);
  const b = z
    .object({
      email: z.string().email(),
      role: z.enum(['ADMIN', 'PROVIDER']),
      providerId: z.uuid().nullable().optional(),
    })
    .parse(raw);
  if (b.role === 'PROVIDER' && !b.providerId) throw badRequest('Choose the provider this login belongs to');
  const password = crypto.randomBytes(12).toString('base64url');
  const totpSecret = newTotpSecret();
  const row = await ctx.db.staffUser.create({
    data: {
      email: b.email.toLowerCase(),
      role: b.role,
      providerId: b.role === 'PROVIDER' ? b.providerId : null,
      passwordHash: await hashPassword(password),
      totpSecret,
    },
  });
  await audit(ctx.db, actor, 'create', 'staff_user', row.id, null, { email: row.email, role: row.role });
  return { id: row.id, email: row.email, temporaryPassword: password, totpUri: totpUri(totpSecret, row.email) };
}

export async function setStaffActive(ctx: Ctx, actor: Staff, id: string, active: boolean) {
  requireAdmin(actor);
  if (id === actor.id && !active) throw badRequest('You cannot deactivate your own login');
  await ctx.db.staffUser.update({
    where: { id },
    data: { active, sessionsValidAfter: active ? undefined : ctx.now() },
  });
  await audit(ctx.db, actor, active ? 'activate' : 'deactivate', 'staff_user', id);
}

// ---------- Reports (PRD §9) ----------

export async function reports(ctx: Ctx, raw: unknown) {
  const [from, to] = await utcRange(ctx, raw);
  const rows = (sql: string) => q(ctx.db, sql, from, to);
  const [visitsByProvider, load, outcomes, payments, noShow] = await Promise.all([
    rows(`SELECT pr.name provider, a.status::text, count(*)::int n FROM appointment a JOIN provider pr ON pr.id = a.provider_id
           WHERE a.starts_at >= $1 AND a.starts_at < $2 AND a.status IN ('CONFIRMED','COMPLETED','NO_SHOW') GROUP BY 1, 2 ORDER BY 1, 2`),
    rows(`SELECT pr.name provider, pr.color, count(a.id)::int visits, COALESCE(sum(EXTRACT(EPOCH FROM a.ends_at - a.starts_at) / 3600), 0)::float hours
            FROM provider pr LEFT JOIN appointment a ON a.provider_id = pr.id AND a.starts_at >= $1 AND a.starts_at < $2
             AND a.status IN ('CONFIRMED','COMPLETED','NO_SHOW')
           WHERE pr.active GROUP BY pr.id ORDER BY pr.display_order`),
    rows(`SELECT CASE WHEN status IN ('CONFIRMED','COMPLETED','NO_SHOW','RESCHEDULED') THEN 'APPROVED' ELSE status::text END outcome, count(*)::int n
            FROM appointment WHERE created_at >= $1 AND created_at < $2 AND requested_by_guardian_id IS NOT NULL GROUP BY 1 ORDER BY 1`),
    rows(
      `SELECT payment_status::text, count(*)::int n FROM appointment WHERE payment_recorded_at >= $1 AND payment_recorded_at < $2 AND payment_status <> 'UNPAID' GROUP BY 1`,
    ),
    rows(`SELECT count(*) FILTER (WHERE status = 'NO_SHOW')::int no_show, count(*) FILTER (WHERE status IN ('COMPLETED','NO_SHOW'))::int attended_or_missed,
                 count(*) FILTER (WHERE late_cancel)::int late_cancels
            FROM appointment WHERE starts_at >= $1 AND starts_at < $2`),
  ]);
  const ns = noShow[0];
  return {
    visitsByProvider,
    load,
    outcomes,
    payments,
    noShowRate: ns.attended_or_missed ? Math.round((1000 * ns.no_show) / ns.attended_or_missed) / 10 : null,
    lateCancels: ns.late_cancels,
  };
}

export async function providersList(ctx: Ctx) {
  return q(
    ctx.db,
    'SELECT id, name, discipline::text, color, phone_e164, display_order, active FROM provider ORDER BY display_order, name',
  );
}
export async function rulesList(ctx: Ctx) {
  return q(
    ctx.db,
    'SELECT provider_id, weekday, start_time::text, end_time::text FROM availability_rule ORDER BY provider_id NULLS FIRST, weekday, start_time',
  );
}
