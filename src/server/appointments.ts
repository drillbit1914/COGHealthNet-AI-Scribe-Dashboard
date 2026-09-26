/**
 * The single write path for appointments (CLAUDE.md rule). Every exported function validates input and
 * the PRD §6 state transition, writes, appends audit_log, and enqueues outbox messages — all in one
 * transaction. Concurrency is settled by the no_provider_overlap exclusion constraint (SQLSTATE 23P01),
 * surfaced as SlotTakenError.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { t } from '@/i18n';
import { audit, SYSTEM, type Actor } from './audit';
import { appointmentForGuardian, firstName, isUuid, requireCanBook } from './authz';
import {
  assignTentativeProvider,
  BLOCKING,
  computeSlots,
  dayLoad,
  durationMin,
  freeProvidersAt,
  rankByLoad,
  type VisitType,
} from './availability';
import type { Ctx } from './context';
import { exec, isOverlapError, isUniqueError, q, withTx, type Tx } from './db';
import { AppError, badRequest, conflict, forbidden, InvalidTransitionError, notFound, SlotTakenError } from './errors';
import { enqueueAdminAlert, enqueueForAppointment, enqueueToGuardian, settingsVars } from './notifications';
import { toE164 } from './phone';
import { getSettings, type ClinicSettings } from './settings';
import { addDays, fmtDate, fmtDay, fmtTime, localDateStr, localParts, localToUtc } from './time';

// ---------------------------------------------------------------------------------------------------
// State machine (PRD §6)
// ---------------------------------------------------------------------------------------------------

export type Status =
  | 'REQUESTED'
  | 'ALTERNATE_PROPOSED'
  | 'CONFIRMED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'NO_SHOW'
  | 'CANCELLED_BY_PARENT'
  | 'CANCELLED_BY_CLINIC'
  | 'RESCHEDULED';

/**
 * PRD §6, plus two parent-protective additions: a parent may withdraw a REQUESTED booking, and the
 * clinic may cancel pending ones (closures, CANCELLED_BY_CLINIC).
 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  REQUESTED: ['CONFIRMED', 'DECLINED', 'ALTERNATE_PROPOSED', 'EXPIRED', 'CANCELLED_BY_PARENT', 'CANCELLED_BY_CLINIC'],
  ALTERNATE_PROPOSED: ['CONFIRMED', 'CANCELLED', 'CANCELLED_BY_CLINIC'],
  CONFIRMED: ['COMPLETED', 'NO_SHOW', 'CANCELLED_BY_PARENT', 'CANCELLED_BY_CLINIC', 'RESCHEDULED'],
  DECLINED: [],
  EXPIRED: [],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED_BY_PARENT: [],
  CANCELLED_BY_CLINIC: [],
  RESCHEDULED: [],
};
export const ALL_STATUSES = Object.keys(TRANSITIONS) as Status[];
export const canTransition = (from: Status, to: Status) => TRANSITIONS[from].includes(to);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function lockAppt(tx: Tx, id: string): Promise<Row> {
  if (!isUuid(id)) throw notFound();
  const [row] = await q(tx, 'SELECT * FROM appointment WHERE id = $1::uuid FOR UPDATE', id);
  if (!row) throw notFound();
  return row;
}

/** Validated status change + audit. Returns the row before and after. */
async function transition(tx: Tx, actor: Actor, id: string, to: Status, patch: Record<string, unknown>, now: Date) {
  const before = await lockAppt(tx, id);
  if (!canTransition(before.status, to)) throw new InvalidTransitionError(before.status, to);
  const fields: Record<string, unknown> = { ...patch, status: to, updated_at: now };
  const cols = Object.keys(fields);
  let after: Row;
  try {
    [after] = await q(
      tx,
      `UPDATE appointment SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1::uuid RETURNING *`,
      id,
      ...cols.map((c) => fields[c]),
    );
  } catch (e) {
    if (isOverlapError(e)) throw new SlotTakenError();
    throw e;
  }
  await audit(tx, actor, `status:${to}`, 'appointment', id, pick(before, cols), pick(after, cols));
  return { before, after };
}
const pick = (o: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function requireApprover(actor: Actor, s: ClinicSettings, appt?: { provider_id: string }) {
  if (actor.type !== 'STAFF') throw forbidden();
  if (actor.role === 'ADMIN') return;
  if (!s.PROVIDER_CAN_APPROVE) throw forbidden(t('errors.adminOnlyApprove'));
  if (appt && actor.providerId !== appt.provider_id) throw forbidden();
}
function requireAdmin(actor: Actor) {
  if (actor.type !== 'STAFF' || actor.role !== 'ADMIN') throw forbidden();
}
function requireStaffFor(actor: Actor, appt: { provider_id: string }) {
  if (actor.type !== 'STAFF') throw forbidden();
  if (actor.role === 'PROVIDER' && actor.providerId !== appt.provider_id) throw forbidden();
}

// ---------------------------------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------------------------------

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
export const newRef = () =>
  'WAV-' + Array.from(crypto.randomBytes(4), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');

interface HoldArgs {
  patientId: string;
  visitType: VisitType;
  startsAt: Date;
  candidates: string[];
  status: 'REQUESTED' | 'CONFIRMED';
  requestedBy: string | null;
  expiresAt: Date | null;
  assignedBy: 'SYSTEM' | 'ADMIN';
  rescheduledFromId?: string;
  seriesId?: string;
  settings: ClinicSettings;
  now: Date;
}

/** Insert on the first candidate the database accepts (retry on 23P01); null if every one is taken. */
async function placeHold(tx: Tx, a: HoldArgs): Promise<{ id: string; ref: string; provider_id: string } | null> {
  const endsAt = new Date(a.startsAt.getTime() + durationMin(a.settings, a.visitType) * 60000);
  return assignTentativeProvider(tx, a.candidates, async (providerId) => {
    for (let attempt = 0; ; attempt++) {
      await exec(tx, 'SAVEPOINT ref_try');
      try {
        const [row] = await q(
          tx,
          `INSERT INTO appointment (ref, patient_id, provider_id, provider_assigned_by, visit_type, starts_at, ends_at, status,
             requested_by_guardian_id, expires_at, rescheduled_from_id, series_id, created_at, updated_at)
           VALUES ($1, $2::uuid, $3::uuid, $4::assigned_by, $5::visit_type, $6, $7, $8::appointment_status, $9::uuid, $10,
                   $11::uuid, $12::uuid, $13, $13)
           RETURNING id, ref, provider_id`,
          newRef(),
          a.patientId,
          providerId,
          a.assignedBy,
          a.visitType,
          a.startsAt,
          endsAt,
          a.status,
          a.requestedBy,
          a.expiresAt,
          a.rescheduledFromId ?? null,
          a.seriesId ?? null,
          a.now,
        );
        await exec(tx, 'RELEASE SAVEPOINT ref_try');
        return row;
      } catch (e) {
        await exec(tx, 'ROLLBACK TO SAVEPOINT ref_try');
        if (isUniqueError(e) && attempt < 5) continue; // booking-ref collision → new ref
        throw e; // 23P01 bubbles to assignTentativeProvider → next provider
      }
    }
  });
}

export const requestExpiry = (now: Date, startsAt: Date, hours: number) =>
  new Date(Math.min(now.getTime() + hours * 3600000, startsAt.getTime()));

async function alertNewRequest(tx: Tx, apptId: string, s: ClinicSettings, now: Date) {
  const [a] = await q(
    tx,
    `SELECT a.visit_type::text, a.starts_at, p.full_name child, pr.name provider FROM appointment a
       JOIN patient p ON p.id = a.patient_id JOIN provider pr ON pr.id = a.provider_id WHERE a.id = $1::uuid`,
    apptId,
  );
  await enqueueAdminAlert(
    tx,
    'S1',
    {
      visit_type: t(`visitType.${a.visit_type}`),
      child: a.child,
      date: fmtDate(a.starts_at, s.TIMEZONE),
      time: fmtTime(a.starts_at, s.TIMEZONE),
      provider: a.provider,
    },
    now,
    apptId,
  );
}

// ---------------------------------------------------------------------------------------------------
// Parent: create a request (PRD §5)
// ---------------------------------------------------------------------------------------------------

export const REASON_TAGS = [
  'fine_motor',
  'gross_motor',
  'sensory_processing',
  'feeding',
  'handwriting',
  'developmental_delay',
  'post_injury_surgery',
  'other',
] as const;

export const RequestInput = z
  .object({
    visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
    startsAt: z.coerce.date(),
    patientId: z.uuid().optional(),
    patientName: z.string().trim().min(2).max(120).optional(),
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    evaluation: z
      .object({
        reasonText: z.string().trim().min(1).max(500),
        reasonTags: z.array(z.enum(REASON_TAGS)).default([]),
        payerType: z.enum(['INSURANCE', 'SELF_PAY']),
        insurer: z.string().trim().max(120).optional(),
        memberNo: z.string().trim().max(60).optional(),
        hasReferral: z.boolean().default(false),
        referralFileKey: z.string().max(300).optional(),
      })
      .optional(),
    otherGuardian: z
      .object({
        name: z.string().trim().min(1).max(120),
        relationship: z.string().trim().max(60).optional(),
        phone: z.string().min(7).max(20),
        notify: z.boolean().default(true),
      })
      .optional(),
    consents: z.object({ dataProcessing: z.boolean(), messaging: z.boolean() }).optional(),
  })
  .superRefine((v, c) => {
    if (v.visitType === 'EVALUATION') {
      if (!v.patientId && (!v.patientName || !v.dob))
        c.addIssue({ code: 'custom', message: 'Patient full name and date of birth are required' });
      if (!v.evaluation) c.addIssue({ code: 'custom', message: 'Evaluation details are required' });
      else if (v.evaluation.payerType === 'INSURANCE' && (!v.evaluation.insurer || !v.evaluation.memberNo))
        c.addIssue({ code: 'custom', message: 'Insurer and member number are required for insurance' });
      else if (v.evaluation.hasReferral && !v.evaluation.referralFileKey)
        c.addIssue({ code: 'custom', message: 'Please upload the referral letter' });
    } else if (!v.patientId && !v.patientName) c.addIssue({ code: 'custom', message: 'Patient name is required' });
  });
export type RequestInput = z.infer<typeof RequestInput>;

export async function createRequest(ctx: Ctx, guardianId: string, raw: unknown) {
  const input = RequestInput.parse(raw);
  const now = ctx.now();
  const actor: Actor = { type: 'GUARDIAN', id: guardianId };

  return withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const free = await freeProvidersAt(tx, input.visitType, input.startsAt, { now, settings: s });
    if (!free.length) throw new SlotTakenError();

    let patientId = input.patientId;
    const isNewPatient = !patientId;
    if (patientId) {
      await requireCanBook(tx, guardianId, patientId);
    } else {
      // Typed follow-up names are flagged for the admin to match to an existing child (PRD §5).
      [{ id: patientId }] = await q(
        tx,
        `INSERT INTO patient (full_name, dob, created_by_guardian_id, needs_admin_match) VALUES ($1, $2::date, $3::uuid, $4) RETURNING id`,
        input.patientName,
        input.dob ?? null,
        guardianId,
        input.visitType === 'FOLLOW_UP',
      );
      // Creator of the child record → can_book = true, receives_notifications = true (PRD §8).
      await exec(
        tx,
        `INSERT INTO guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications)
         VALUES ($1::uuid, $2::uuid, 'parent', true, true)`,
        guardianId,
        patientId,
      );
      await audit(tx, actor, 'create', 'patient', patientId!, null, { full_name: input.patientName, dob: input.dob });
    }

    // Versioned consents: required for evaluations and new child records unless already on file.
    if (input.visitType === 'EVALUATION' || isNewPatient) {
      const have = new Set(
        (
          await q(
            tx,
            `SELECT type::text FROM consent WHERE guardian_id = $1::uuid AND (patient_id = $2::uuid OR (type = 'MESSAGING' AND patient_id IS NULL))
               AND withdrawn_at IS NULL AND version = $3`,
            guardianId,
            patientId,
            s.CONSENT_VERSION,
          )
        ).map((r) => r.type),
      );
      for (const [type, given] of [
        ['DATA_PROCESSING', input.consents?.dataProcessing],
        ['MESSAGING', input.consents?.messaging],
      ] as const) {
        if (have.has(type)) continue;
        if (!given) throw badRequest(t('errors.consentsRequired'));
        await exec(
          tx,
          `INSERT INTO consent (guardian_id, patient_id, type, version, granted_at) VALUES ($1::uuid, $2::uuid, $3::consent_type, $4, $5)`,
          guardianId,
          patientId,
          type,
          s.CONSENT_VERSION,
          now,
        );
      }
    }

    const hold = await placeHold(tx, {
      patientId: patientId!,
      visitType: input.visitType,
      startsAt: input.startsAt,
      candidates: await rankByLoad(tx, free, input.startsAt, s.TIMEZONE),
      status: 'REQUESTED',
      requestedBy: guardianId,
      expiresAt: requestExpiry(now, input.startsAt, s.REQUEST_EXPIRY_HOURS),
      assignedBy: 'SYSTEM',
      settings: s,
      now,
    });
    if (!hold) throw new SlotTakenError();

    if (input.evaluation) {
      const e = input.evaluation;
      await exec(
        tx,
        `INSERT INTO evaluation_intake (appointment_id, reason_text, reason_tags, payer_type, insurer, member_no, has_referral, referral_file_key)
         VALUES ($1::uuid, $2, $3::text[], $4::payer_type, $5, $6, $7, $8)`,
        hold.id,
        e.reasonText,
        e.reasonTags,
        e.payerType,
        e.insurer ?? null,
        e.memberNo ?? null,
        e.hasReferral,
        e.referralFileKey ?? null,
      );
    }
    await audit(tx, actor, 'request', 'appointment', hold.id, null, {
      ...hold,
      starts_at: input.startsAt,
      visit_type: input.visitType,
    });

    // Invite first so the co-parent's first message explains who added them (PRD §8).
    if (input.otherGuardian) await addOtherGuardian(tx, actor, guardianId, patientId!, input.otherGuardian, s, now);
    await enqueueForAppointment(tx, hold.id, input.visitType === 'FOLLOW_UP' ? 'T1' : 'T2', now);
    await alertNewRequest(tx, hold.id, s, now);

    return {
      appointmentId: hold.id,
      ref: hold.ref,
      patientId: patientId!,
      providerId: hold.provider_id, // internal/tests only — never returned to parent endpoints
      visitType: input.visitType,
      startsAt: input.startsAt,
      status: 'REQUESTED' as const,
    };
  });
}

/** Co-parent defaults: can_book = false, receives_notifications = toggle; T9 by SMS (PRD §8). */
async function addOtherGuardian(
  tx: Tx,
  actor: Actor,
  inviterId: string,
  patientId: string,
  og: NonNullable<RequestInput['otherGuardian']>,
  s: ClinicSettings,
  now: Date,
) {
  const phone = toE164(og.phone, s.DEFAULT_COUNTRY_CODE, s.DEFAULT_AREA_CODE);
  const [g] = await q(
    tx,
    `INSERT INTO guardian (name, phone_e164) VALUES ($1, $2)
     ON CONFLICT (phone_e164) DO UPDATE SET name = COALESCE(guardian.name, EXCLUDED.name) RETURNING id, name, phone_e164`,
    og.name,
    phone,
  );
  if (g.id === inviterId) return;
  const linked = await q(
    tx,
    `INSERT INTO guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications, added_by_guardian_id)
     VALUES ($1::uuid, $2::uuid, $3, false, $4, $5::uuid) ON CONFLICT DO NOTHING RETURNING guardian_id`,
    g.id,
    patientId,
    og.relationship ?? null,
    og.notify,
    inviterId,
  );
  if (!linked.length) return;
  await audit(tx, actor, 'add_guardian', 'guardian_patient', `${g.id}:${patientId}`, null, {
    guardian_id: g.id,
    patient_id: patientId,
    can_book: false,
    receives_notifications: og.notify,
  });
  if (!og.notify) return;
  const [ctx] = await q(
    tx,
    `SELECT (SELECT name FROM guardian WHERE id = $1::uuid) inviter, (SELECT full_name FROM patient WHERE id = $2::uuid) child`,
    inviterId,
    patientId,
  );
  await enqueueToGuardian(
    tx,
    { guardian_id: g.id, name: g.name, phone_e164: g.phone_e164, can_book: false },
    'T9',
    { ...settingsVars(s), inviter: ctx.inviter ?? 'A parent', child: firstName(ctx.child) },
    null,
    now,
    { smsOnly: true },
  );
}

// ---------------------------------------------------------------------------------------------------
// Admin: approval queue actions (PRD §9)
// ---------------------------------------------------------------------------------------------------

/** Providers free for the full duration at this appointment's time, with discipline and day load (AC 5). */
export async function reassignCandidates(ctx: Ctx, apptId: string) {
  if (!isUuid(apptId)) throw notFound();
  const s = await getSettings(ctx.db);
  const [a] = await q(ctx.db, 'SELECT * FROM appointment WHERE id = $1::uuid', apptId);
  if (!a) throw notFound();
  const free = await freeProvidersAt(ctx.db, a.visit_type, a.starts_at, {
    applyBookingWindow: false,
    excludeAppointmentId: a.id,
    settings: s,
    now: ctx.now(),
  });
  const load = await dayLoad(ctx.db, a.starts_at, s.TIMEZONE);
  const rows = await q(
    ctx.db,
    'SELECT id, name, discipline::text, color FROM provider WHERE id = ANY($1::uuid[])',
    free,
  );
  const byId = new Map(rows.map((p) => [p.id, p]));
  return free.map((id) => ({
    ...byId.get(id),
    load: (load.get(id) ?? 0) - (id === a.provider_id ? 1 : 0),
    suggested: id === a.provider_id,
  })) as { id: string; name: string; discipline: 'OT' | 'PT'; color: string; load: number; suggested: boolean }[];
}

async function moveProvider(tx: Tx, ctx: Ctx, actor: Actor, a: Row, providerId: string, s: ClinicSettings) {
  if (providerId === a.provider_id) return;
  const free = await freeProvidersAt(tx, a.visit_type, a.starts_at, {
    applyBookingWindow: false,
    excludeAppointmentId: a.id,
    settings: s,
    now: ctx.now(),
  });
  if (!free.includes(providerId)) throw conflict('PROVIDER_BUSY', t('errors.providerBusy'));
  try {
    await exec(
      tx,
      `UPDATE appointment SET provider_id = $2::uuid, provider_assigned_by = 'ADMIN', updated_at = $3 WHERE id = $1::uuid`,
      a.id,
      providerId,
      ctx.now(),
    );
  } catch (e) {
    if (isOverlapError(e)) throw conflict('PROVIDER_BUSY', t('errors.providerBusy'));
    throw e;
  }
  await audit(tx, actor, 'reassign', 'appointment', a.id, { provider_id: a.provider_id }, { provider_id: providerId });
}

export async function reassignProvider(ctx: Ctx, actor: Actor, apptId: string, providerId: string) {
  await withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const a = await lockAppt(tx, apptId);
    requireApprover(actor, s, a);
    if (!(BLOCKING as readonly string[]).includes(a.status)) throw new InvalidTransitionError(a.status, a.status);
    await moveProvider(tx, ctx, actor, a, providerId, s);
  });
}

export async function confirm(ctx: Ctx, actor: Actor, apptId: string, providerId?: string) {
  await withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const a = await lockAppt(tx, apptId);
    requireApprover(actor, s, a);
    if (!canTransition(a.status, 'CONFIRMED') || a.status !== 'REQUESTED')
      throw new InvalidTransitionError(a.status, 'CONFIRMED');
    if (providerId) await moveProvider(tx, ctx, actor, a, providerId, s);
    await transition(tx, actor, apptId, 'CONFIRMED', { provider_assigned_by: 'ADMIN', expires_at: null }, ctx.now());
    await enqueueForAppointment(tx, apptId, 'T3', ctx.now());
  });
}

export async function decline(ctx: Ctx, actor: Actor, apptId: string, reason: string) {
  if (!reason?.trim()) throw badRequest(t('errors.reasonRequired'));
  await withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    requireApprover(actor, s, await lockAppt(tx, apptId));
    const { before } = await transition(
      tx,
      actor,
      apptId,
      'DECLINED',
      { decline_reason: reason.trim(), expires_at: null },
      ctx.now(),
    );
    await enqueueForAppointment(tx, apptId, 'T4', ctx.now());
    await offerFreedSlot(tx, before, s, ctx.now());
  });
}

/** Move the hold to another pooled slot and ask the parent (T5). The original time is released. */
export async function proposeAlternate(ctx: Ctx, actor: Actor, apptId: string, startsAt: Date) {
  await withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const now = ctx.now();
    const a = await lockAppt(tx, apptId);
    requireApprover(actor, s, a);
    if (a.status !== 'REQUESTED') throw new InvalidTransitionError(a.status, 'ALTERNATE_PROPOSED');
    const free = await freeProvidersAt(tx, a.visit_type, startsAt, {
      applyBookingWindow: false,
      excludeAppointmentId: a.id,
      settings: s,
      now,
    });
    if (!free.length) throw new SlotTakenError();
    const ranked = free.includes(a.provider_id) ? [a.provider_id] : await rankByLoad(tx, free, startsAt, s.TIMEZONE);
    const endsAt = new Date(startsAt.getTime() + (a.ends_at.getTime() - a.starts_at.getTime()));
    const res = await assignTentativeProvider(tx, ranked, (pid) =>
      transition(
        tx,
        actor,
        apptId,
        'ALTERNATE_PROPOSED',
        {
          provider_id: pid,
          provider_assigned_by: 'ADMIN',
          starts_at: startsAt,
          ends_at: endsAt,
          original_starts_at: a.starts_at,
          expires_at: new Date(now.getTime() + s.ALT_EXPIRY_HOURS * 3600000),
        },
        now,
      ).catch((e) => {
        throw e instanceof SlotTakenError ? Object.assign(new Error('overlap'), { code: '23P01' }) : e;
      }),
    );
    if (!res) throw new SlotTakenError();
    await enqueueForAppointment(tx, apptId, 'T5', now);
    await offerFreedSlot(tx, res.before, s, now);
  });
}

export async function complete(ctx: Ctx, actor: Actor, apptId: string) {
  await withTx(ctx.db, async (tx) => {
    requireStaffFor(actor, await lockAppt(tx, apptId));
    await transition(tx, actor, apptId, 'COMPLETED', {}, ctx.now());
  });
}

export async function markNoShow(ctx: Ctx, actor: Actor, apptId: string) {
  await withTx(ctx.db, async (tx) => {
    requireStaffFor(actor, await lockAppt(tx, apptId));
    await transition(tx, actor, apptId, 'NO_SHOW', {}, ctx.now());
  });
}

export async function recordPayment(
  ctx: Ctx,
  actor: Actor,
  apptId: string,
  p: { status: 'PAID_CASH' | 'PAID_BANK_TRANSFER' | 'WAIVED' | 'UNPAID'; reference?: string },
) {
  requireAdmin(actor);
  if (p.status === 'PAID_BANK_TRANSFER' && !p.reference?.trim()) throw badRequest('Transfer reference is required');
  await withTx(ctx.db, async (tx) => {
    const a = await lockAppt(tx, apptId);
    const method = { PAID_CASH: 'CASH', PAID_BANK_TRANSFER: 'BANK_TRANSFER', WAIVED: null, UNPAID: null }[p.status];
    const [after] = await q(
      tx,
      `UPDATE appointment SET payment_status = $2::payment_status, payment_method = $3::payment_method, payment_reference = $4,
         payment_recorded_by = $5::uuid, payment_recorded_at = $6, updated_at = $6 WHERE id = $1::uuid
       RETURNING payment_status, payment_method, payment_reference`,
      apptId,
      p.status,
      method,
      p.reference?.trim() || null,
      actor.id,
      ctx.now(),
    );
    await audit(
      tx,
      actor,
      'payment',
      'appointment',
      apptId,
      { payment_status: a.payment_status, payment_method: a.payment_method, payment_reference: a.payment_reference },
      after,
    );
  });
}

/** Pooled open slots for the "propose alternate" picker. */
export async function alternateOptions(ctx: Ctx, apptId: string, from?: string, to?: string) {
  if (!isUuid(apptId)) throw notFound();
  const [a] = await q(ctx.db, 'SELECT * FROM appointment WHERE id = $1::uuid', apptId);
  if (!a) throw notFound();
  return computeSlots(ctx.db, { visitType: a.visit_type, now: ctx.now(), from, to, excludeAppointmentId: a.id });
}

// ---------------------------------------------------------------------------------------------------
// Cancel / reschedule / alternate replies
// ---------------------------------------------------------------------------------------------------

/**
 * Guardian (can_book only) → CANCELLED_BY_PARENT; inside {{CANCEL_CUTOFF_HOURS}} it is allowed but
 * flagged late (PRD §10.2). Admin → CANCELLED_BY_CLINIC. Sends T7 and offers the slot to the waitlist.
 */
export async function cancel(ctx: Ctx, actor: Actor, apptId: string, reason?: string) {
  await withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const now = ctx.now();
    let res;
    if (actor.type === 'GUARDIAN') {
      const a = await appointmentForGuardian(tx, actor.id, apptId, true);
      const late = a.status === 'CONFIRMED' && a.starts_at.getTime() - now.getTime() < s.CANCEL_CUTOFF_HOURS * 3600000;
      res = await transition(
        tx,
        actor,
        apptId,
        'CANCELLED_BY_PARENT',
        { late_cancel: late, cancel_reason: null, expires_at: null },
        now,
      );
    } else {
      requireAdmin(actor);
      res = await transition(
        tx,
        actor,
        apptId,
        'CANCELLED_BY_CLINIC',
        { cancel_reason: reason?.trim() || null, expires_at: null },
        now,
      );
    }
    await enqueueForAppointment(tx, apptId, 'T7', now);
    await offerFreedSlot(tx, res.before, s, now);
  });
}

export async function acceptAlternate(ctx: Ctx, guardianId: string, apptId: string) {
  await withTx(ctx.db, async (tx) => {
    const a = await appointmentForGuardian(tx, guardianId, apptId, true);
    if (a.status !== 'ALTERNATE_PROPOSED') throw conflict('INVALID_TRANSITION', t('errors.offerUnavailable'));
    await transition(tx, { type: 'GUARDIAN', id: guardianId }, apptId, 'CONFIRMED', { expires_at: null }, ctx.now());
    await enqueueForAppointment(tx, apptId, 'T3', ctx.now());
  });
}

export async function declineAlternate(ctx: Ctx, guardianId: string, apptId: string) {
  await withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const a = await appointmentForGuardian(tx, guardianId, apptId, true);
    if (a.status !== 'ALTERNATE_PROPOSED') throw conflict('INVALID_TRANSITION', t('errors.offerUnavailable'));
    const { before } = await transition(
      tx,
      { type: 'GUARDIAN', id: guardianId },
      apptId,
      'CANCELLED',
      { cancel_reason: t('reasons.alternateDeclined'), expires_at: null },
      ctx.now(),
    );
    await enqueueForAppointment(tx, apptId, 'T7', ctx.now());
    await offerFreedSlot(tx, before, s, ctx.now());
  });
}

/**
 * Reschedule = RESCHEDULED + a new linked appointment (PRD §6). Parent: the new one is REQUESTED and
 * returns to the approval queue. Admin (drag on the calendar): CONFIRMED on the chosen provider.
 */
export async function reschedule(ctx: Ctx, actor: Actor, apptId: string, startsAt: Date, providerId?: string) {
  return withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const now = ctx.now();
    const byParent = actor.type === 'GUARDIAN';
    const a = byParent ? await appointmentForGuardian(tx, actor.id, apptId, true) : await lockAppt(tx, apptId);
    if (!byParent) requireApprover(actor, s, a);
    const late = byParent && a.starts_at.getTime() - now.getTime() < s.CANCEL_CUTOFF_HOURS * 3600000;
    const { before } = await transition(tx, actor, apptId, 'RESCHEDULED', { late_cancel: late, expires_at: null }, now);
    const free = await freeProvidersAt(tx, a.visit_type, startsAt, { applyBookingWindow: byParent, settings: s, now });
    const pool = providerId ? free.filter((p) => p === providerId) : free;
    const hold = await placeHold(tx, {
      patientId: a.patient_id,
      visitType: a.visit_type,
      startsAt,
      candidates: providerId ? pool : await rankByLoad(tx, pool, startsAt, s.TIMEZONE),
      status: byParent ? 'REQUESTED' : 'CONFIRMED',
      requestedBy: byParent ? actor.id : a.requested_by_guardian_id,
      expiresAt: byParent ? requestExpiry(now, startsAt, s.REQUEST_EXPIRY_HOURS) : null,
      assignedBy: byParent ? 'SYSTEM' : 'ADMIN',
      rescheduledFromId: a.id,
      settings: s,
      now,
    });
    if (!hold) throw new SlotTakenError();
    await exec(
      tx,
      `UPDATE appointment SET payment_status = $2::payment_status, payment_method = $3::payment_method, payment_reference = $4
        WHERE id = $1::uuid`,
      hold.id,
      a.payment_status,
      a.payment_method,
      a.payment_reference,
    );
    await exec(
      tx,
      `INSERT INTO evaluation_intake SELECT $2::uuid, reason_text, reason_tags, payer_type, insurer, member_no, has_referral,
         referral_file_key FROM evaluation_intake WHERE appointment_id = $1::uuid`,
      a.id,
      hold.id,
    );
    await audit(tx, actor, 'reschedule', 'appointment', hold.id, { from: a.id }, hold);
    if (byParent) {
      await enqueueForAppointment(tx, hold.id, a.visit_type === 'FOLLOW_UP' ? 'T1' : 'T2', now);
      await alertNewRequest(tx, hold.id, s, now);
    } else {
      await enqueueForAppointment(tx, hold.id, 'T3', now);
    }
    await offerFreedSlot(tx, before, s, now);
    return { appointmentId: hold.id as string, ref: hold.ref as string };
  });
}

// ---------------------------------------------------------------------------------------------------
// Waitlist (PRD §10.3): offer on free, first claim wins
// ---------------------------------------------------------------------------------------------------

/**
 * Runs inside the transaction that freed the slot: if the time is bookable for parents again, send T8
 * to up to {{WAITLIST_OFFER_MAX}} matching entries whose guardian can still book.
 */
async function offerFreedSlot(tx: Tx, freed: Row, s: ClinicSettings, now: Date) {
  if (!(BLOCKING as readonly string[]).includes(freed.status)) return;
  const free = await freeProvidersAt(tx, freed.visit_type, freed.starts_at, {
    now,
    settings: s,
    providerIds: [freed.provider_id],
  });
  if (!free.length) return;
  const tz = s.TIMEZONE;
  const day = localDateStr(freed.starts_at, tz);
  const win = localParts(freed.starts_at, tz).hh < 12 ? 'MORNING' : 'AFTERNOON';
  const entries = await q(
    tx,
    `SELECT w.id, w.guardian_id, g.name, g.phone_e164
       FROM waitlist_entry w
       JOIN guardian_patient gp ON gp.guardian_id = w.guardian_id AND gp.patient_id = w.patient_id AND gp.can_book AND NOT gp.restricted
       JOIN guardian g ON g.id = w.guardian_id
      WHERE w.status = 'ACTIVE' AND w.visit_type = $1::visit_type AND $2::date BETWEEN w.date_from AND w.date_to
        AND w."window"::text IN ('ANY', $3)
        AND NOT EXISTS (SELECT 1 FROM appointment a WHERE a.patient_id = w.patient_id AND a.starts_at = $4
                          AND a.status = ANY($6::appointment_status[]))
      ORDER BY w.created_at LIMIT $5`,
    freed.visit_type,
    day,
    win,
    freed.starts_at,
    s.WAITLIST_OFFER_MAX,
    BLOCKING,
  );
  if (!entries.length) return;
  const [offer] = await q(
    tx,
    `INSERT INTO waitlist_offer (provider_id, visit_type, starts_at, ends_at, entry_ids, created_at)
     VALUES ($1::uuid, $2::visit_type, $3, $4, $5::uuid[], $6) RETURNING id`,
    freed.provider_id,
    freed.visit_type,
    freed.starts_at,
    freed.ends_at,
    entries.map((e) => e.id),
    now,
  );
  const vars = {
    ...settingsVars(s),
    offer_id: offer.id,
    visit_type: t(`visitType.${freed.visit_type}`),
    day: fmtDay(freed.starts_at, tz),
    date: fmtDate(freed.starts_at, tz),
    time: fmtTime(freed.starts_at, tz),
  };
  for (const e of entries) {
    await enqueueToGuardian(
      tx,
      { guardian_id: e.guardian_id, name: e.name, phone_e164: e.phone_e164, can_book: true },
      'T8',
      vars,
      null,
      now,
    );
  }
}

/** First tap wins: the offer row is claimed atomically, then a REQUESTED hold is placed (AC 10). */
export async function claimWaitlistOffer(ctx: Ctx, guardianId: string, offerId: string) {
  if (!isUuid(offerId)) throw notFound();
  return withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const now = ctx.now();
    const [o] = await q(tx, 'SELECT * FROM waitlist_offer WHERE id = $1::uuid', offerId);
    if (!o) throw notFound();
    const [entry] = await q(
      tx,
      `SELECT * FROM waitlist_entry WHERE id = ANY($1::uuid[]) AND guardian_id = $2::uuid ORDER BY created_at LIMIT 1`,
      o.entry_ids,
      guardianId,
    );
    if (!entry) throw notFound();
    await requireCanBook(tx, guardianId, entry.patient_id);
    const won = await q(
      tx,
      `UPDATE waitlist_offer SET claimed_by_entry_id = $2::uuid, claimed_at = $3 WHERE id = $1::uuid AND claimed_at IS NULL RETURNING id`,
      offerId,
      entry.id,
      now,
    );
    if (!won.length) throw conflict('OFFER_TAKEN', t('errors.offerTaken'));
    const hold = await placeHold(tx, {
      patientId: entry.patient_id,
      visitType: o.visit_type,
      startsAt: o.starts_at,
      candidates: [o.provider_id],
      status: 'REQUESTED',
      requestedBy: guardianId,
      expiresAt: requestExpiry(now, o.starts_at, s.REQUEST_EXPIRY_HOURS),
      assignedBy: 'SYSTEM',
      settings: s,
      now,
    });
    if (!hold) throw conflict('OFFER_TAKEN', t('errors.offerTaken'));
    await exec(tx, 'UPDATE waitlist_offer SET appointment_id = $2::uuid WHERE id = $1::uuid', offerId, hold.id);
    await exec(tx, `UPDATE waitlist_entry SET status = 'FULFILLED' WHERE id = $1::uuid`, entry.id);
    await audit(tx, { type: 'GUARDIAN', id: guardianId }, 'claim', 'waitlist_offer', offerId, null, {
      appointment_id: hold.id,
    });
    await enqueueForAppointment(tx, hold.id, o.visit_type === 'FOLLOW_UP' ? 'T1' : 'T2', now);
    await alertNewRequest(tx, hold.id, s, now);
    return { appointmentId: hold.id as string, ref: hold.ref as string };
  });
}

// ---------------------------------------------------------------------------------------------------
// Timed transitions (called by /api/cron/*)
// ---------------------------------------------------------------------------------------------------

/**
 * REQUESTED past expires_at → EXPIRED (T4, slot reappears — AC 9);
 * ALTERNATE_PROPOSED past expires_at → CANCELLED (T7).
 */
export async function expire(ctx: Ctx) {
  const now = ctx.now();
  const due = await q(
    ctx.db,
    `SELECT id, status::text FROM appointment WHERE status IN ('REQUESTED','ALTERNATE_PROPOSED') AND expires_at <= $1`,
    now,
  );
  let n = 0;
  for (const d of due) {
    try {
      await withTx(ctx.db, async (tx) => {
        const s = await getSettings(tx);
        const req = d.status === 'REQUESTED';
        const { before } = await transition(
          tx,
          SYSTEM,
          d.id,
          req ? 'EXPIRED' : 'CANCELLED',
          req ? { decline_reason: t('reasons.requestExpired') } : { cancel_reason: t('reasons.alternateNoReply') },
          now,
        );
        await enqueueForAppointment(tx, d.id, req ? 'T4' : 'T7', now);
        await offerFreedSlot(tx, before, s, now);
      });
      n++;
    } catch (e) {
      if (!(e instanceof InvalidTransitionError)) throw e; // actioned concurrently
    }
  }
  return n;
}

/** S2 once a request has used 50% of its time to expiry. */
export async function escalate(ctx: Ctx) {
  return withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const now = ctx.now();
    const rows = await q(
      tx,
      `UPDATE appointment SET escalation_sent_at = $1
        WHERE status = 'REQUESTED' AND escalation_sent_at IS NULL AND expires_at > $1
          AND created_at + (expires_at - created_at) / 2 <= $1 RETURNING id, ref, expires_at`,
      now,
    );
    for (const a of rows) {
      await enqueueAdminAlert(
        tx,
        'S2',
        { ref: a.ref, expires_at: `${fmtDate(a.expires_at, s.TIMEZONE)} ${fmtTime(a.expires_at, s.TIMEZONE)}` },
        now,
        a.id,
      );
    }
    return rows.length;
  });
}

/** T6 exactly once per CONFIRMED visit, within 24h of start; never for cancelled visits (AC 12). */
export async function queueReminders(ctx: Ctx) {
  return withTx(ctx.db, async (tx) => {
    const now = ctx.now();
    const rows = await q(
      tx,
      `UPDATE appointment SET reminder_sent_at = $1
        WHERE status = 'CONFIRMED' AND reminder_sent_at IS NULL AND starts_at > $1 AND starts_at <= $2 RETURNING id`,
      now,
      new Date(now.getTime() + 24 * 3600000),
    );
    for (const r of rows) await enqueueForAppointment(tx, r.id, 'T6', now);
    return rows.length;
  });
}

// ---------------------------------------------------------------------------------------------------
// Clinic closure (PRD §9) and recurring series
// ---------------------------------------------------------------------------------------------------

export async function previewClosure(ctx: Ctx, startsAt: Date, endsAt: Date) {
  return q(
    ctx.db,
    `SELECT a.id, a.ref, a.status::text, a.visit_type::text, a.starts_at, p.full_name child, pr.name provider
       FROM appointment a JOIN patient p ON p.id = a.patient_id JOIN provider pr ON pr.id = a.provider_id
      WHERE a.status = ANY($1::appointment_status[]) AND a.starts_at < $3 AND a.ends_at > $2 ORDER BY a.starts_at`,
    BLOCKING,
    startsAt,
    endsAt,
  );
}

/**
 * Block the range, cancel every affected visit (CANCELLED_BY_CLINIC), add each family to the rebook
 * list, and send one T10 per notified guardian (AC 13). No waitlist offers — the clinic is closed.
 */
export async function closeClinic(ctx: Ctx, actor: Actor, startsAt: Date, endsAt: Date, reason: string) {
  requireAdmin(actor);
  if (!reason?.trim()) throw badRequest(t('errors.reasonRequired'));
  if (endsAt <= startsAt) throw badRequest('End must be after start');
  return withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const now = ctx.now();
    const [block] = await q(
      tx,
      `INSERT INTO time_off (provider_id, starts_at, ends_at, reason, is_closure, created_at) VALUES (NULL, $1, $2, $3, true, $4) RETURNING id`,
      startsAt,
      endsAt,
      reason.trim(),
      now,
    );
    await audit(tx, actor, 'closure', 'time_off', block.id, null, { startsAt, endsAt, reason });
    const affected = await q(
      tx,
      `SELECT id, patient_id, starts_at FROM appointment WHERE status = ANY($1::appointment_status[]) AND starts_at < $3 AND ends_at > $2
        ORDER BY starts_at FOR UPDATE`,
      BLOCKING,
      startsAt,
      endsAt,
    );
    for (const a of affected) {
      await transition(tx, actor, a.id, 'CANCELLED_BY_CLINIC', { cancel_reason: reason.trim(), expires_at: null }, now);
      await exec(
        tx,
        'INSERT INTO rebook_entry (patient_id, appointment_id, reason, created_at) VALUES ($1::uuid, $2::uuid, $3, $4)',
        a.patient_id,
        a.id,
        reason.trim(),
        now,
      );
      await enqueueForAppointment(tx, a.id, 'T10', now, {
        reason: reason.trim(),
        date: fmtDate(a.starts_at, s.TIMEZONE),
      });
    }
    return { cancelled: affected.length, appointmentIds: affected.map((a) => a.id as string) };
  });
}

export interface SeriesInput {
  patientId: string;
  providerId: string;
  visitType: VisitType;
  firstStartsAt: Date;
  rule: 'WEEKLY' | 'BIWEEKLY';
  count: number;
}

/** Occurrences at the same clinic-local wall time, each flagged if the provider is not free. */
export async function previewSeries(ctx: Ctx, i: SeriesInput) {
  if (i.count < 1 || i.count > 52) throw badRequest('Count must be between 1 and 52');
  const s = await getSettings(ctx.db);
  const tz = s.TIMEZONE;
  const { hh, mm } = localParts(i.firstStartsAt, tz);
  const day0 = localDateStr(i.firstStartsAt, tz);
  const step = i.rule === 'WEEKLY' ? 7 : 14;
  const out: { startsAt: Date; conflict: boolean }[] = [];
  for (let k = 0; k < i.count; k++) {
    const startsAt = localToUtc(addDays(day0, k * step), hh * 60 + mm, tz);
    const free = await freeProvidersAt(ctx.db, i.visitType, startsAt, {
      applyBookingWindow: false,
      providerIds: [i.providerId],
      settings: s,
      now: ctx.now(),
    });
    out.push({ startsAt, conflict: !free.length });
  }
  return out;
}

/** Recurring series are created CONFIRMED (PRD §9); conflicts must be resolved or explicitly skipped. */
export async function createSeries(ctx: Ctx, actor: Actor, i: SeriesInput, skipConflicts = false) {
  requireAdmin(actor);
  const preview = await previewSeries(ctx, i);
  const conflicts = preview.filter((o) => o.conflict);
  if (conflicts.length && !skipConflicts) throw conflict('SERIES_CONFLICTS', `${conflicts.length} date(s) conflict`);
  return withTx(ctx.db, async (tx) => {
    const s = await getSettings(tx);
    const now = ctx.now();
    const [pt] = await q(tx, 'SELECT id FROM patient WHERE id = $1::uuid', i.patientId);
    if (!pt) throw notFound();
    const [sr] = await q(
      tx,
      `INSERT INTO recurring_series (patient_id, provider_id, visit_type, rule, count, created_at)
       VALUES ($1::uuid, $2::uuid, $3::visit_type, $4::series_rule, $5, $6) RETURNING id`,
      i.patientId,
      i.providerId,
      i.visitType,
      i.rule,
      i.count,
      now,
    );
    const created: string[] = [];
    for (const o of preview.filter((x) => !x.conflict)) {
      const hold = await placeHold(tx, {
        patientId: i.patientId,
        visitType: i.visitType,
        startsAt: o.startsAt,
        candidates: [i.providerId],
        status: 'CONFIRMED',
        requestedBy: null,
        expiresAt: null,
        assignedBy: 'ADMIN',
        seriesId: sr.id,
        settings: s,
        now,
      });
      if (!hold) throw new SlotTakenError();
      created.push(hold.id);
    }
    await audit(tx, actor, 'create', 'recurring_series', sr.id, null, { ...i, created: created.length });
    // One confirmation for the first visit; 24h reminders cover the rest without flooding parents.
    if (created[0]) await enqueueForAppointment(tx, created[0], 'T3', now);
    return { seriesId: sr.id as string, appointmentIds: created, skipped: conflicts.map((c) => c.startsAt) };
  });
}

export { AppError };
