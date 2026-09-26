import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  alternateOptions, cancelByClinic, confirm, decline, markAttendance, proposeAlternate, reassign, reassignCandidates,
  recordPayment, reschedule,
} from '../appointments.js';
import { audit } from '../audit.js';
import { addTimeOff, applyClosure, previewClosure } from '../closures.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { breachExport, erasePatient, exportPatient, mergeGuardians, mergePatients } from '../privacy.js';
import { createSeries, previewSeries } from '../series.js';
import { DEFAULT_SETTINGS, getSettings } from '../settings.js';
import { addDays, localToUtc } from '../time.js';
import { removeWaitlistEntry } from '../waitlist.js';
import { staff, type AppDeps } from './app.js';

const Id = z.object({ id: z.string().uuid() });
const Range = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** Admin and provider console API (PRD §9). Providers see only their own calendar. */
export const adminRoutes = (deps: AppDeps): FastifyPluginAsync => async (app) => {
  const { ctx } = deps;
  const db = ctx.db;
  const range = async (q: unknown) => {
    const r = Range.parse(q);
    const tz = (await getSettings(db)).TIMEZONE;
    return [localToUtc(r.from, 0, tz), localToUtc(addDays(r.to, 1), 0, tz)] as const;
  };

  // ----- Approval queue: oldest first, with suggested provider and attendance history -----
  app.get('/queue', async (req) => {
    staff(req);
    const rows = (await db.query(
      `SELECT a.id, a.ref, a.visit_type, a.starts_at, a.ends_at, a.status, a.expires_at, a.created_at, a.provider_id,
              a.provider_assigned_by, a.original_starts_at, a.payment_status,
              pr.name provider_name, pr.discipline, p.id patient_id, p.full_name child, p.needs_admin_match,
              g.name requested_by, g.phone_e164 requested_by_phone,
              (SELECT count(*)::int FROM appointment x WHERE x.patient_id = a.patient_id AND x.status = 'NO_SHOW') no_shows,
              (SELECT count(*)::int FROM appointment x WHERE x.patient_id = a.patient_id AND x.late_cancel) late_cancels,
              (SELECT count(*)::int FROM payment_proof pp WHERE pp.appointment_id = a.id AND pp.reviewed_at IS NULL) proofs,
              to_jsonb(e) - 'appointment_id' intake
         FROM appointment a JOIN provider pr ON pr.id = a.provider_id JOIN patient p ON p.id = a.patient_id
         LEFT JOIN guardian g ON g.id = a.requested_by_guardian_id LEFT JOIN evaluation_intake e ON e.appointment_id = a.id
        WHERE a.status IN ('REQUESTED','ALTERNATE_PROPOSED') ORDER BY a.created_at`)).rows;
    return rows.map((r) => ({ ...r, expiresInMin: r.expires_at ? Math.round((r.expires_at.getTime() - ctx.now().getTime()) / 60000) : null }));
  });
  app.get('/appointments/:id/candidates', async (req) => { staff(req); return reassignCandidates(ctx, Id.parse(req.params).id); });
  app.get('/appointments/:id/alternates', async (req) => {
    staff(req);
    const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    return (await alternateOptions(ctx, Id.parse(req.params).id, q.from, q.to)).map((s) => ({ startsAt: s.startsAt, freeProviders: s.providerIds.length }));
  });
  app.post('/appointments/:id/confirm', async (req) => {
    const { providerId } = z.object({ providerId: z.string().uuid().optional() }).parse(req.body ?? {});
    await confirm(ctx, staff(req), Id.parse(req.params).id, providerId);
    return { ok: true };
  });
  app.post('/appointments/:id/reassign', async (req) => {
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(req.body);
    await reassign(ctx, staff(req), Id.parse(req.params).id, providerId);
    return { ok: true };
  });
  app.post('/appointments/:id/decline', async (req) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(300) }).parse(req.body);
    await decline(ctx, staff(req), Id.parse(req.params).id, reason);
    return { ok: true };
  });
  app.post('/appointments/:id/propose', async (req) => {
    const { startsAt } = z.object({ startsAt: z.coerce.date() }).parse(req.body);
    await proposeAlternate(ctx, staff(req), Id.parse(req.params).id, startsAt);
    return { ok: true };
  });
  app.post('/appointments/:id/reschedule', async (req) => {
    const b = z.object({ startsAt: z.coerce.date(), providerId: z.string().uuid().optional() }).parse(req.body);
    return reschedule(ctx, staff(req), Id.parse(req.params).id, b.startsAt, b.providerId);
  });
  app.post('/appointments/:id/cancel', async (req) => {
    const { reason } = z.object({ reason: z.string().trim().max(300).default('') }).parse(req.body ?? {});
    await cancelByClinic(ctx, staff(req, true), Id.parse(req.params).id, reason);
    return { ok: true };
  });
  app.post('/appointments/:id/attendance', async (req) => {
    const { outcome } = z.object({ outcome: z.enum(['COMPLETED', 'NO_SHOW']) }).parse(req.body);
    await markAttendance(ctx, staff(req), Id.parse(req.params).id, outcome);
    return { ok: true };
  });
  app.post('/appointments/:id/payment', async (req) => {
    const b = z.object({ status: z.enum(['PAID_CASH', 'PAID_BANK_TRANSFER', 'WAIVED', 'UNPAID']), reference: z.string().max(100).optional() }).parse(req.body);
    await recordPayment(ctx, staff(req, true), Id.parse(req.params).id, b);
    return { ok: true };
  });

  // ----- Calendar: columns per provider; providers see only their own -----
  app.get('/calendar', async (req) => {
    const actor = staff(req);
    const [from, to] = await range(req.query);
    const own = actor.role === 'PROVIDER' ? actor.providerId : null;
    const providers = (await db.query(`SELECT id, name, discipline, color, display_order FROM provider WHERE active AND ($1::uuid IS NULL OR id = $1) ORDER BY display_order`, [own])).rows;
    const appts = (await db.query(
      `SELECT a.id, a.ref, a.provider_id, a.visit_type, a.starts_at, a.ends_at, a.status, a.payment_status, p.full_name child
         FROM appointment a JOIN patient p ON p.id = a.patient_id
        WHERE a.status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED','COMPLETED','NO_SHOW') AND a.starts_at < $2 AND a.ends_at > $1
          AND ($3::uuid IS NULL OR a.provider_id = $3) ORDER BY a.starts_at`, [from, to, own])).rows
      .map((a) => ({ ...a, style: a.status === 'CONFIRMED' || a.status === 'COMPLETED' ? 'solid' : 'striped' }));
    const timeOff = (await db.query(`SELECT * FROM time_off WHERE starts_at < $2 AND ends_at > $1 AND ($3::uuid IS NULL OR provider_id IS NULL OR provider_id = $3)`, [from, to, own])).rows;
    return { providers, appointments: appts, timeOff };
  });

  // ----- Patients & guardians -----
  app.get('/patients', async (req) => {
    staff(req, true);
    const { q = '' } = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    return (await db.query(
      `SELECT p.id, p.full_name, p.dob, p.needs_admin_match,
              (SELECT count(*)::int FROM appointment a WHERE a.patient_id = p.id AND a.status = 'NO_SHOW') no_shows
         FROM patient p WHERE p.merged_into_id IS NULL AND (p.full_name ILIKE '%' || $1 || '%' OR EXISTS (
           SELECT 1 FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id WHERE gp.patient_id = p.id AND g.phone_e164 LIKE '%' || $1 || '%'))
        ORDER BY p.needs_admin_match DESC, p.full_name LIMIT 50`, [q])).rows;
  });
  app.get('/patients/:id', async (req) => {
    staff(req, true);
    const { id } = Id.parse(req.params);
    const patient = (await db.query('SELECT * FROM patient WHERE id = $1', [id])).rows[0];
    if (!patient) throw notFound();
    const [guardians, visits, intakes] = await Promise.all([
      db.query(`SELECT g.id, g.name, g.phone_e164, g.whatsapp_opt_in_at, gp.* FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id WHERE gp.patient_id = $1`, [id]),
      db.query(`SELECT a.*, pr.name provider FROM appointment a JOIN provider pr ON pr.id = a.provider_id WHERE a.patient_id = $1 ORDER BY a.starts_at DESC`, [id]),
      db.query(`SELECT e.* FROM evaluation_intake e JOIN appointment a ON a.id = e.appointment_id WHERE a.patient_id = $1`, [id]),
    ]);
    await audit(db, staff(req), 'view', 'patient', id);
    return {
      patient, guardians: guardians.rows, visits: visits.rows,
      intakes: intakes.rows.map((e) => ({ ...e, referralUrl: e.referral_file_key ? deps.storage.signedUrl(e.referral_file_key, ctx.now()) : null })),
      noShows: visits.rows.filter((v) => v.status === 'NO_SHOW').length,
      lateCancels: visits.rows.filter((v) => v.late_cancel).length,
    };
  });
  app.patch('/patients/:id', async (req) => {
    const actor = staff(req, true);
    const { id } = Id.parse(req.params);
    const b = z.object({ fullName: z.string().trim().min(1).optional(), dob: z.string().nullable().optional(), needsAdminMatch: z.boolean().optional() }).parse(req.body);
    const before = (await db.query('SELECT full_name, dob, needs_admin_match FROM patient WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound();
    const after = (await db.query(`UPDATE patient SET full_name = COALESCE($2, full_name), dob = CASE WHEN $5 THEN $3::date ELSE dob END,
      needs_admin_match = COALESCE($4, needs_admin_match) WHERE id = $1 RETURNING full_name, dob, needs_admin_match`,
      [id, b.fullName ?? null, b.dob ?? null, b.needsAdminMatch ?? null, b.dob !== undefined])).rows[0];
    await audit(db, actor, 'update', 'patient', id, before, after);
    return after;
  });
  /** Guardian-child flags. `restricted` is admin-only and never surfaced to parents (PRD §8). */
  app.patch('/guardian-links', async (req) => {
    const actor = staff(req, true);
    const b = z.object({ guardianId: z.string().uuid(), patientId: z.string().uuid(), canBook: z.boolean().optional(),
      receivesNotifications: z.boolean().optional(), restricted: z.boolean().optional(), relationship: z.string().max(60).optional(),
      notes: z.string().max(1000).optional() }).parse(req.body);
    const before = (await db.query('SELECT * FROM guardian_patient WHERE guardian_id = $1 AND patient_id = $2', [b.guardianId, b.patientId])).rows[0];
    const after = (await db.query(
      `INSERT INTO guardian_patient (guardian_id, patient_id, can_book, receives_notifications, restricted, relationship, notes)
       VALUES ($1,$2,COALESCE($3,false),COALESCE($4,true),COALESCE($5,false),$6,$7)
       ON CONFLICT (guardian_id, patient_id) DO UPDATE SET
         can_book = COALESCE($3, guardian_patient.can_book), receives_notifications = COALESCE($4, guardian_patient.receives_notifications),
         restricted = COALESCE($5, guardian_patient.restricted), relationship = COALESCE($6, guardian_patient.relationship),
         notes = COALESCE($7, guardian_patient.notes) RETURNING *`,
      [b.guardianId, b.patientId, b.canBook ?? null, b.receivesNotifications ?? null, b.restricted ?? null, b.relationship ?? null, b.notes ?? null])).rows[0];
    if (b.restricted) await db.query('DELETE FROM session WHERE guardian_id = $1 AND NOT EXISTS (SELECT 1 FROM guardian_patient WHERE guardian_id = $1 AND NOT restricted)', [b.guardianId]);
    await audit(db, actor, 'update', 'guardian_patient', `${b.guardianId}:${b.patientId}`, before ?? null, after);
    return after;
  });
  app.post('/guardians', async (req) => {
    const actor = staff(req, true);
    const b = z.object({ name: z.string().trim().min(1), phone: z.string() }).parse(req.body);
    const s = await getSettings(db);
    const { toE164 } = await import('../phone.js');
    const r = (await db.query(`INSERT INTO guardian (name, phone_e164) VALUES ($1,$2) ON CONFLICT (phone_e164) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
      [b.name, toE164(b.phone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE)])).rows[0];
    await audit(db, actor, 'upsert', 'guardian', r.id, null, r);
    return r;
  });
  app.post('/merge/patients', async (req) => {
    const b = z.object({ fromId: z.string().uuid(), intoId: z.string().uuid() }).refine((x) => x.fromId !== x.intoId).parse(req.body);
    await mergePatients(ctx, staff(req, true), b.fromId, b.intoId);
    return { ok: true };
  });
  app.post('/merge/guardians', async (req) => {
    const b = z.object({ fromId: z.string().uuid(), intoId: z.string().uuid() }).refine((x) => x.fromId !== x.intoId).parse(req.body);
    await mergeGuardians(ctx, staff(req, true), b.fromId, b.intoId);
    return { ok: true };
  });

  // ----- Payments -----
  app.get('/payments/unpaid', async (req) => {
    staff(req, true);
    return (await db.query(`SELECT a.id, a.ref, a.starts_at, a.visit_type, a.status, p.full_name child FROM appointment a JOIN patient p ON p.id = a.patient_id
      WHERE a.payment_status = 'UNPAID' AND a.status IN ('REQUESTED','CONFIRMED','COMPLETED') ORDER BY a.starts_at`)).rows;
  });
  app.get('/payments/totals', async (req) => {
    staff(req, true);
    const [from, to] = await range(req.query);
    const tz = (await getSettings(db)).TIMEZONE;
    return (await db.query(`SELECT (payment_recorded_at AT TIME ZONE $3)::date AS day, payment_status, count(*)::int n FROM appointment
      WHERE payment_recorded_at >= $1 AND payment_recorded_at < $2 AND payment_status <> 'UNPAID' GROUP BY 1, 2 ORDER BY 1, 2`, [from, to, tz])).rows;
  });
  app.get('/payments/proofs', async (req) => {
    staff(req, true);
    const rows = (await db.query(`SELECT pp.*, a.ref, p.full_name child, g.name guardian FROM payment_proof pp JOIN appointment a ON a.id = pp.appointment_id
      JOIN patient p ON p.id = a.patient_id LEFT JOIN guardian g ON g.id = pp.guardian_id WHERE pp.reviewed_at IS NULL ORDER BY pp.received_at`)).rows;
    return rows.map((r) => ({ ...r, fileUrl: r.file_key && !r.file_key.startsWith('whatsapp-media/') ? deps.storage.signedUrl(r.file_key, ctx.now()) : null }));
  });
  app.post('/payments/proofs/:id/reviewed', async (req) => {
    const actor = staff(req, true);
    const r = await db.query('UPDATE payment_proof SET reviewed_by = $2, reviewed_at = $3 WHERE id = $1 AND reviewed_at IS NULL RETURNING id', [Id.parse(req.params).id, actor.id, ctx.now()]);
    if (!r.rowCount) throw notFound();
    await audit(db, actor, 'review', 'payment_proof', r.rows[0].id);
    return { ok: true };
  });

  // ----- Time off & closures -----
  app.post('/time-off', async (req) => {
    const b = z.object({ providerId: z.string().uuid().nullable().optional(), startsAt: z.coerce.date(), endsAt: z.coerce.date(), reason: z.string().max(200).optional() }).parse(req.body);
    return addTimeOff(ctx, staff(req), b);
  });
  app.delete('/time-off/:id', async (req) => {
    const actor = staff(req);
    const { id } = Id.parse(req.params);
    const t = (await db.query('SELECT * FROM time_off WHERE id = $1', [id])).rows[0];
    if (!t) throw notFound();
    if (actor.role === 'PROVIDER' && t.provider_id !== actor.providerId) throw forbidden();
    await db.query('DELETE FROM time_off WHERE id = $1', [id]);
    await audit(db, actor, 'delete', 'time_off', id, t, null);
    return { ok: true };
  });
  const Closure = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date(), reason: z.string().trim().min(1).max(200) });
  app.post('/closures/preview', async (req) => { staff(req, true); const b = Closure.parse(req.body); return previewClosure(ctx, b.startsAt, b.endsAt); });
  app.post('/closures', async (req) => { const b = Closure.parse(req.body); return applyClosure(ctx, staff(req, true), b.startsAt, b.endsAt, b.reason); });
  app.get('/rebook', async (req) => {
    staff(req, true);
    return (await db.query(`SELECT r.*, a.ref, a.starts_at, a.visit_type, p.full_name child FROM rebook_entry r JOIN appointment a ON a.id = r.appointment_id
      JOIN patient p ON p.id = r.patient_id WHERE r.resolved_at IS NULL ORDER BY r.created_at`)).rows;
  });
  app.post('/rebook/:id/resolve', async (req) => {
    const actor = staff(req, true);
    await db.query('UPDATE rebook_entry SET resolved_at = $2 WHERE id = $1', [Id.parse(req.params).id, ctx.now()]);
    await audit(db, actor, 'resolve', 'rebook_entry', Id.parse(req.params).id);
    return { ok: true };
  });

  // ----- Recurring series -----
  const Series = z.object({ patientId: z.string().uuid(), providerId: z.string().uuid(), visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
    firstStartsAt: z.coerce.date(), rule: z.enum(['WEEKLY', 'BIWEEKLY']), count: z.number().int().min(1).max(52), skipConflicts: z.boolean().default(false) });
  app.post('/series/preview', async (req) => { staff(req, true); return previewSeries(ctx, Series.parse(req.body)); });
  app.post('/series', async (req) => { const b = Series.parse(req.body); return createSeries(ctx, staff(req, true), b, b.skipConflicts); });

  // ----- Waitlist -----
  app.get('/waitlist', async (req) => {
    staff(req, true);
    return (await db.query(`SELECT w.*, p.full_name child, g.name guardian, g.phone_e164 FROM waitlist_entry w JOIN patient p ON p.id = w.patient_id
      JOIN guardian g ON g.id = w.guardian_id WHERE w.status = 'ACTIVE' ORDER BY w.created_at`)).rows;
  });
  app.post('/waitlist', async (req) => {
    const actor = staff(req, true);
    const b = z.object({ patientId: z.string().uuid(), guardianId: z.string().uuid(), visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
      dateFrom: z.string(), dateTo: z.string(), window: z.enum(['ANY', 'MORNING', 'AFTERNOON']).default('ANY') }).parse(req.body);
    const r = await db.query(`INSERT INTO waitlist_entry (patient_id, guardian_id, visit_type, date_from, date_to, "window") VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.patientId, b.guardianId, b.visitType, b.dateFrom, b.dateTo, b.window]);
    await audit(db, actor, 'create', 'waitlist_entry', r.rows[0].id, null, r.rows[0]);
    return r.rows[0];
  });
  app.delete('/waitlist/:id', async (req) => { await removeWaitlistEntry(ctx, staff(req, true), Id.parse(req.params).id); return { ok: true }; });

  // ----- Logs -----
  app.get('/messages', async (req) => {
    staff(req, true);
    const q = z.object({ appointmentId: z.string().uuid().optional(), status: z.string().optional(), limit: z.coerce.number().max(500).default(100) }).parse(req.query);
    return (await db.query(`SELECT m.*, g.name guardian FROM message m LEFT JOIN guardian g ON g.id = m.guardian_id
      WHERE ($1::uuid IS NULL OR m.appointment_id = $1) AND ($2::text IS NULL OR m.status = $2) ORDER BY m.created_at DESC LIMIT $3`,
      [q.appointmentId ?? null, q.status ?? null, q.limit])).rows;
  });
  app.get('/audit', async (req) => {
    staff(req, true);
    const q = z.object({ entity: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().max(500).default(100) }).parse(req.query);
    return (await db.query(`SELECT * FROM audit_log WHERE ($1::text IS NULL OR entity = $1) AND ($2::text IS NULL OR entity_id = $2) ORDER BY id DESC LIMIT $3`,
      [q.entity ?? null, q.entityId ?? null, q.limit])).rows;
  });

  // ----- Providers & settings -----
  app.get('/providers', async (req) => { staff(req); return (await db.query('SELECT * FROM provider ORDER BY display_order, name')).rows; });
  app.post('/providers', async (req) => {
    const actor = staff(req, true);
    const b = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1), discipline: z.enum(['OT', 'PT']),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4F7CAC'), phone: z.string().nullable().optional(),
      displayOrder: z.number().int().default(0), active: z.boolean().default(true) }).parse(req.body);
    const r = await db.query(
      `INSERT INTO provider (id, name, discipline, color, phone_e164, display_order, active) VALUES (COALESCE($1, gen_random_uuid()),$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, discipline=$3, color=$4, phone_e164=$5, display_order=$6, active=$7 RETURNING *`,
      [b.id ?? null, b.name, b.discipline, b.color, b.phone ?? null, b.displayOrder, b.active]);
    await audit(db, actor, 'upsert', 'provider', r.rows[0].id, null, r.rows[0]);
    return r.rows[0];
  });
  app.get('/availability-rules', async (req) => { staff(req); return (await db.query('SELECT * FROM availability_rule ORDER BY provider_id NULLS FIRST, weekday, start_time')).rows; });
  app.put('/availability-rules', async (req) => {
    const actor = staff(req, true);
    const b = z.object({ providerId: z.string().uuid().nullable(), rules: z.array(z.object({ weekday: z.number().int().min(0).max(6),
      start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })) }).parse(req.body);
    const before = (await db.query('SELECT weekday, start_time, end_time FROM availability_rule WHERE provider_id IS NOT DISTINCT FROM $1', [b.providerId])).rows;
    await db.query('DELETE FROM availability_rule WHERE provider_id IS NOT DISTINCT FROM $1', [b.providerId]);
    for (const r of b.rules) {
      if (r.end <= r.start) throw badRequest('End must be after start');
      await db.query('INSERT INTO availability_rule (provider_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [b.providerId, r.weekday, r.start, r.end]);
    }
    await audit(db, actor, 'replace', 'availability_rule', b.providerId, before, b.rules);
    return { ok: true };
  });
  app.get('/settings', async (req) => { staff(req, true); return getSettings(db); });
  app.patch('/settings', async (req) => {
    const actor = staff(req, true);
    const patch = z.record(z.string(), z.unknown()).parse(req.body);
    const unknownKeys = Object.keys(patch).filter((k) => !(k in DEFAULT_SETTINGS));
    if (unknownKeys.length) throw badRequest(`Unknown settings: ${unknownKeys.join(', ')}`);
    const before = await getSettings(db);
    await db.query(`UPDATE clinic_settings SET settings = settings || $1::jsonb, updated_at = now() WHERE id = 1`, [JSON.stringify(patch)]);
    await audit(db, actor, 'update', 'clinic_settings', '1', Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof typeof before]])), patch);
    return getSettings(db);
  });

  // ----- Reports -----
  app.get('/reports', async (req) => {
    staff(req, true);
    const [from, to] = await range(req.query);
    const q = (sql: string) => db.query(sql, [from, to]).then((r) => r.rows);
    return {
      visitsByProvider: await q(`SELECT pr.name, a.status, count(*)::int n FROM appointment a JOIN provider pr ON pr.id = a.provider_id
        WHERE a.starts_at >= $1 AND a.starts_at < $2 AND a.status IN ('CONFIRMED','COMPLETED','NO_SHOW') GROUP BY 1, 2 ORDER BY 1, 2`),
      noShowRate: (await q(`SELECT round(100.0 * count(*) FILTER (WHERE status = 'NO_SHOW') / NULLIF(count(*) FILTER (WHERE status IN ('COMPLETED','NO_SHOW')), 0), 1) pct
        FROM appointment WHERE starts_at >= $1 AND starts_at < $2`))[0].pct,
      requestOutcomes: await q(`SELECT status, count(*)::int n FROM appointment WHERE created_at >= $1 AND created_at < $2
        AND requested_by_guardian_id IS NOT NULL GROUP BY 1 ORDER BY 1`),
      paymentsByMethod: await q(`SELECT payment_status, count(*)::int n FROM appointment WHERE payment_recorded_at >= $1 AND payment_recorded_at < $2
        AND payment_status <> 'UNPAID' GROUP BY 1`),
      lateCancels: (await q(`SELECT count(*)::int n FROM appointment WHERE late_cancel AND starts_at >= $1 AND starts_at < $2`))[0].n,
    };
  });

  // ----- Privacy (PRD §13) -----
  app.get('/privacy/patients/:id/export', async (req) => exportPatient(ctx, staff(req, true), Id.parse(req.params).id));
  app.post('/privacy/patients/:id/erase', async (req) => { await erasePatient(ctx, staff(req, true), Id.parse(req.params).id); return { ok: true }; });
  app.get('/privacy/breach-export', async (req) => breachExport(ctx, staff(req, true)));
  app.get('/files/url', async (req) => {
    staff(req, true);
    const { key } = z.object({ key: z.string() }).parse(req.query);
    return { url: deps.storage.signedUrl(key, ctx.now()) };
  });
};
