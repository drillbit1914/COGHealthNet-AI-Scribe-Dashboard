import crypto from 'node:crypto';
import { z } from 'zod';
import { audit, SYSTEM, type Actor } from './audit.js';
import { dayLoad, durationMin, freeProvidersAt, type VisitType } from './availability.js';
import { requireCanBook } from './authz.js';
import type { Ctx } from './ctx.js';
import { isOverlapError, withTx, type Tx } from './db.js';
import { badRequest, conflict } from './errors.js';
import { STRINGS } from './i18n/en.js';
import { notifyAppointment, sendStaff, sendToGuardian, settingsVars } from './notify/notify.js';
import { toE164 } from './phone.js';
import { getSettings, type ClinicSettings } from './settings.js';
import { fmtDate, fmtTime } from './time.js';

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
export const newRef = () =>
  'WAV-' + Array.from(crypto.randomBytes(4), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');

export const REASON_TAGS = ['fine_motor', 'gross_motor', 'sensory_processing', 'feeding', 'handwriting',
  'developmental_delay', 'post_injury_surgery', 'other'] as const;

export const RequestInput = z.object({
  visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
  startsAt: z.coerce.date(),
  patientId: z.string().uuid().optional(),
  patientName: z.string().trim().min(2).max(120).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  evaluation: z.object({
    reasonText: z.string().trim().min(1).max(500),
    reasonTags: z.array(z.enum(REASON_TAGS)).default([]),
    payerType: z.enum(['INSURANCE', 'SELF_PAY']),
    insurer: z.string().trim().max(120).optional(),
    memberNo: z.string().trim().max(60).optional(),
    hasReferral: z.boolean().default(false),
    referralFileKey: z.string().max(300).optional(),
  }).optional(),
  otherGuardian: z.object({
    name: z.string().trim().min(1).max(120),
    relationship: z.string().trim().max(60).optional(),
    phone: z.string().min(7).max(20),
    notify: z.boolean().default(true),
  }).optional(),
  consents: z.object({ dataProcessing: z.boolean(), messaging: z.boolean() }).optional(),
}).superRefine((v, c) => {
  if (v.visitType === 'EVALUATION') {
    if (!v.patientId && (!v.patientName || !v.dob)) c.addIssue({ code: 'custom', message: 'Patient full name and date of birth are required' });
    if (!v.evaluation) c.addIssue({ code: 'custom', message: 'Evaluation details are required' });
    else if (v.evaluation.payerType === 'INSURANCE' && (!v.evaluation.insurer || !v.evaluation.memberNo))
      c.addIssue({ code: 'custom', message: 'Insurer and member number are required for insurance' });
    else if (v.evaluation.hasReferral && !v.evaluation.referralFileKey)
      c.addIssue({ code: 'custom', message: 'Please upload the referral letter' });
  } else if (!v.patientId && !v.patientName) c.addIssue({ code: 'custom', message: 'Patient name is required' });
});
export type RequestInput = z.infer<typeof RequestInput>;

export interface HoldArgs {
  patientId: string; visitType: VisitType; startsAt: Date; candidates: string[]; status: 'REQUESTED' | 'CONFIRMED' | 'ALTERNATE_PROPOSED';
  requestedBy: string | null; expiresAt: Date | null; assignedBy: 'SYSTEM' | 'ADMIN';
  rescheduledFromId?: string; seriesId?: string; settings: ClinicSettings;
}

/**
 * Insert an appointment on the first candidate provider the database accepts. Each attempt runs in a
 * savepoint: if the exclusion constraint rejects it (a concurrent booking won), try the next provider
 * (PRD §11, AC 2/3). Returns null when every candidate is taken.
 */
export async function placeHold(tx: Tx, a: HoldArgs): Promise<{ id: string; ref: string; provider_id: string } | null> {
  const endsAt = new Date(a.startsAt.getTime() + durationMin(a.settings, a.visitType) * 60000);
  for (const providerId of a.candidates) {
    for (let refTry = 0; refTry < 5; refTry++) {
      await tx.query('SAVEPOINT hold');
      try {
        const r = await tx.query(
          `INSERT INTO appointment (ref, patient_id, provider_id, provider_assigned_by, visit_type, starts_at, ends_at, status,
             requested_by_guardian_id, expires_at, rescheduled_from_id, series_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, ref, provider_id`,
          [newRef(), a.patientId, providerId, a.assignedBy, a.visitType, a.startsAt, endsAt, a.status,
           a.requestedBy, a.expiresAt, a.rescheduledFromId ?? null, a.seriesId ?? null],
        );
        await tx.query('RELEASE SAVEPOINT hold');
        return r.rows[0];
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT hold');
        if (isOverlapError(e)) break;                                  // provider taken → next candidate
        if ((e as { code?: string }).code === '23505') continue;       // ref collision → new ref
        throw e;
      }
    }
  }
  return null;
}

/** Tentative assignment order: fewest bookings that day, ties by provider order (PRD §4). */
export async function rankCandidates(tx: Tx, free: string[], at: Date, tz: string) {
  const load = await dayLoad(tx, at, tz);
  return free.map((id, i) => ({ id, i, n: load.get(id) ?? 0 })).sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.id);
}

export const slotTaken = () => conflict('SLOT_TAKEN', STRINGS.slotTaken);

export function requestExpiry(now: Date, startsAt: Date, hours: number) {
  return new Date(Math.min(now.getTime() + hours * 3600000, startsAt.getTime()));
}

/** Parent submits a request (PRD §5). */
export async function createRequest(ctx: Ctx, guardianId: string, raw: unknown) {
  const input = RequestInput.parse(raw);
  const s = await getSettings(ctx.db);
  const now = ctx.now();
  const actor: Actor = { type: 'GUARDIAN', id: guardianId };
  let invite: { guardianId: string; patientId: string } | null = null;

  const result = await withTx(ctx.db, async (tx) => {
    const free = await freeProvidersAt(tx, input.visitType, input.startsAt, { now, settings: s });
    if (!free.length) throw slotTaken();

    let patientId = input.patientId;
    const isNewPatient = !patientId;
    if (patientId) await requireCanBook(tx, guardianId, patientId);
    else {
      const p = await tx.query(
        `INSERT INTO patient (full_name, dob, created_by_guardian_id, needs_admin_match) VALUES ($1,$2,$3,$4) RETURNING id`,
        [input.patientName, input.dob ?? null, guardianId, input.visitType === 'FOLLOW_UP'],
      );
      patientId = p.rows[0].id as string;
      await tx.query(
        `INSERT INTO guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications)
         VALUES ($1,$2,'parent',true,true)`, [guardianId, patientId]);
      await audit(tx, actor, 'create', 'patient', patientId, null, { full_name: input.patientName, dob: input.dob });
    }

    // Consents: required for evaluations and new child records unless already on file (PRD §5, §13).
    const needConsent = input.visitType === 'EVALUATION' || isNewPatient;
    if (needConsent) {
      const have = await tx.query(
        `SELECT type FROM consent WHERE guardian_id = $1 AND (patient_id = $2 OR (type = 'MESSAGING' AND patient_id IS NULL))
           AND withdrawn_at IS NULL AND version = $3`, [guardianId, patientId, s.CONSENT_VERSION]);
      const types = new Set(have.rows.map((r) => r.type));
      const want = [['DATA_PROCESSING', input.consents?.dataProcessing], ['MESSAGING', input.consents?.messaging]] as const;
      for (const [type, given] of want) {
        if (types.has(type)) continue;
        if (!given) throw badRequest('Both consents are required');
        await tx.query('INSERT INTO consent (guardian_id, patient_id, type, version, granted_at) VALUES ($1,$2,$3,$4,$5)',
          [guardianId, patientId, type, s.CONSENT_VERSION, now]);
      }
    }

    const candidates = await rankCandidates(tx, free, input.startsAt, s.TIMEZONE);
    const hold = await placeHold(tx, {
      patientId: patientId!, visitType: input.visitType, startsAt: input.startsAt, candidates, status: 'REQUESTED',
      requestedBy: guardianId, expiresAt: requestExpiry(now, input.startsAt, s.REQUEST_EXPIRY_HOURS),
      assignedBy: 'SYSTEM', settings: s,
    });
    if (!hold) throw slotTaken();

    if (input.evaluation) {
      const e = input.evaluation;
      await tx.query(
        `INSERT INTO evaluation_intake (appointment_id, reason_text, reason_tags, payer_type, insurer, member_no, has_referral, referral_file_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [hold.id, e.reasonText, e.reasonTags, e.payerType, e.insurer ?? null, e.memberNo ?? null, e.hasReferral, e.referralFileKey ?? null]);
    }

    if (input.otherGuardian) invite = await addOtherGuardian(tx, actor, guardianId, patientId!, input.otherGuardian, s);

    await audit(tx, actor, 'request', 'appointment', hold.id, null, { ...hold, starts_at: input.startsAt, visit_type: input.visitType });
    return { appointmentId: hold.id, ref: hold.ref, providerId: hold.provider_id, patientId: patientId! };
  });

  // Invite first so the co-parent's first message explains who added them (PRD §8).
  if (invite) await sendInvite(ctx, invite, guardianId, s);
  await notifyAppointment(ctx, result.appointmentId, input.visitType === 'FOLLOW_UP' ? 'T1' : 'T2');
  await alertAdminsNewRequest(ctx, result.appointmentId, s);
  return { ...result, visitType: input.visitType, startsAt: input.startsAt, status: 'REQUESTED' as const };
}

/** Co-parent defaults: can_book = false, receives_notifications = toggle (PRD §8). */
export async function addOtherGuardian(tx: Tx, actor: Actor, inviterId: string, patientId: string,
  og: NonNullable<RequestInput['otherGuardian']>, s: ClinicSettings) {
  const phone = toE164(og.phone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE);
  const g = await tx.query(
    `INSERT INTO guardian (name, phone_e164) VALUES ($1,$2)
     ON CONFLICT (phone_e164) DO UPDATE SET name = COALESCE(guardian.name, EXCLUDED.name) RETURNING id`,
    [og.name, phone]);
  const gid = g.rows[0].id as string;
  if (gid === inviterId) return null;
  const link = await tx.query(
    `INSERT INTO guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications, added_by_guardian_id)
     VALUES ($1,$2,$3,false,$4,$5) ON CONFLICT DO NOTHING RETURNING guardian_id`,
    [gid, patientId, og.relationship ?? null, og.notify, inviterId]);
  if (!link.rowCount) return null;
  await audit(tx, actor, 'add_guardian', 'guardian_patient', `${gid}:${patientId}`, null,
    { guardian_id: gid, patient_id: patientId, can_book: false, receives_notifications: og.notify });
  return og.notify ? { guardianId: gid, patientId } : null;
}

/** T9 goes by SMS: WhatsApp requires the recipient's own opt-in (PRD §8). */
export async function sendInvite(ctx: Ctx, inv: { guardianId: string; patientId: string }, inviterId: string, s: ClinicSettings) {
  const r = await ctx.db.query(
    `SELECT g.id guardian_id, g.name, g.phone_e164, false can_book, g.whatsapp_opt_in_at, g.sms_opt_out_at,
            (SELECT name FROM guardian WHERE id = $3) inviter, p.full_name child
       FROM guardian g, patient p WHERE g.id = $1 AND p.id = $2`, [inv.guardianId, inv.patientId, inviterId]);
  const g = r.rows[0];
  await sendToGuardian(ctx, g, 'T9', { ...settingsVars(s), inviter: g.inviter ?? 'A parent', child: g.child.split(' ')[0] }, null, true);
}

export async function alertAdminsNewRequest(ctx: Ctx, apptId: string, s: ClinicSettings) {
  if (!s.ADMIN_ALERT_PHONES.length) return;
  const r = await ctx.db.query(
    `SELECT a.visit_type, a.starts_at, p.full_name child, pr.name provider FROM appointment a
       JOIN patient p ON p.id = a.patient_id JOIN provider pr ON pr.id = a.provider_id WHERE a.id = $1`, [apptId]);
  const a = r.rows[0];
  const vars = { ...settingsVars(s), visit_type: a.visit_type === 'FOLLOW_UP' ? 'follow-up' : 'evaluation', child: a.child,
    date: fmtDate(a.starts_at, s.TIMEZONE), time: fmtTime(a.starts_at, s.TIMEZONE), provider: a.provider };
  for (const phone of s.ADMIN_ALERT_PHONES) await sendStaff(ctx, phone, 'S1', vars, { apptId });
}

export { SYSTEM };
