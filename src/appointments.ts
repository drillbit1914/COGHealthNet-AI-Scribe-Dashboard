import { audit, SYSTEM, type Actor } from './audit.js';
import { computeSlots, dayLoad, freeProvidersAt, type VisitType } from './availability.js';
import { appointmentForGuardian } from './authz.js';
import { alertAdminsNewRequest, placeHold, rankCandidates, requestExpiry, slotTaken } from './booking.js';
import type { Ctx } from './ctx.js';
import { withTx, type Tx } from './db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { notifyAppointment } from './notify/notify.js';
import { getSettings, type ClinicSettings } from './settings.js';
import { offerFreedSlot } from './waitlist.js';

export type Status =
  | 'REQUESTED' | 'ALTERNATE_PROPOSED' | 'CONFIRMED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED'
  | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED_BY_PARENT' | 'CANCELLED_BY_CLINIC' | 'RESCHEDULED';

/**
 * PRD §6 status machine. Two additions, both parent-protective: a parent may withdraw a REQUESTED
 * booking (CANCELLED_BY_PARENT), and the clinic may cancel a pending one (closures).
 */
export const TRANSITIONS: Record<Status, Status[]> = {
  REQUESTED: ['CONFIRMED', 'DECLINED', 'ALTERNATE_PROPOSED', 'EXPIRED', 'CANCELLED_BY_PARENT', 'CANCELLED_BY_CLINIC'],
  ALTERNATE_PROPOSED: ['CONFIRMED', 'CANCELLED', 'CANCELLED_BY_CLINIC'],
  CONFIRMED: ['COMPLETED', 'NO_SHOW', 'CANCELLED_BY_PARENT', 'CANCELLED_BY_CLINIC', 'RESCHEDULED'],
  DECLINED: [], EXPIRED: [], CANCELLED: [], COMPLETED: [], NO_SHOW: [], CANCELLED_BY_PARENT: [],
  CANCELLED_BY_CLINIC: [], RESCHEDULED: [],
};

export async function lockAppt(tx: Tx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const r = await tx.query('SELECT * FROM appointment WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound();
  return r.rows[0];
}

export async function transition(tx: Tx, actor: Actor, id: string, to: Status, patch: Record<string, unknown> = {}, now = new Date()) {
  const before = await lockAppt(tx, id);
  if (!TRANSITIONS[before.status as Status].includes(to))
    throw conflict('INVALID_TRANSITION', `Cannot change a ${before.status} appointment to ${to}`);
  const fields = { ...patch, status: to, updated_at: now };
  const cols = Object.keys(fields);
  const r = await tx.query(
    `UPDATE appointment SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...cols.map((c) => fields[c as keyof typeof fields])]);
  await audit(tx, actor, `status:${to}`, 'appointment', id, pick(before, cols), pick(r.rows[0], cols));
  return { before, after: r.rows[0] };
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function requireApprover(actor: Actor, s: ClinicSettings, appt?: { provider_id: string }) {
  if (actor.type !== 'STAFF') throw forbidden();
  if (actor.role === 'ADMIN') return;
  if (!s.PROVIDER_CAN_APPROVE) throw forbidden('Only the administrator can approve requests');
  if (appt && actor.providerId !== appt.provider_id) throw forbidden();
}
function requireStaffFor(actor: Actor, appt: { provider_id: string }) {
  if (actor.type !== 'STAFF') throw forbidden();
  if (actor.role === 'PROVIDER' && actor.providerId !== appt.provider_id) throw forbidden();
}

// ---------- Admin: approval queue ----------

/** Providers free for the full duration at this appointment's time, with discipline and day load (AC 5). */
export async function reassignCandidates(ctx: Ctx, apptId: string) {
  const s = await getSettings(ctx.db);
  const a = (await ctx.db.query('SELECT * FROM appointment WHERE id = $1', [apptId])).rows[0];
  if (!a) throw notFound();
  const free = await freeProvidersAt(ctx.db, a.visit_type, a.starts_at,
    { applyBookingWindow: false, excludeAppointmentId: a.id, settings: s, now: ctx.now() });
  const load = await dayLoad(ctx.db, a.starts_at, s.TIMEZONE);
  const r = await ctx.db.query('SELECT id, name, discipline, color FROM provider WHERE id = ANY($1)', [free]);
  const byId = new Map(r.rows.map((p) => [p.id, p]));
  return free.map((id) => ({ ...byId.get(id), load: (load.get(id) ?? 0) - (id === a.provider_id ? 1 : 0), suggested: id === a.provider_id }));
}

async function moveProvider(tx: Tx, ctx: Ctx, actor: Actor, a: { id: string; visit_type: VisitType; starts_at: Date; provider_id: string }, providerId: string, s: ClinicSettings) {
  if (providerId === a.provider_id) return;
  const free = await freeProvidersAt(tx, a.visit_type, a.starts_at,
    { applyBookingWindow: false, excludeAppointmentId: a.id, settings: s, now: ctx.now() });
  if (!free.includes(providerId)) throw conflict('PROVIDER_BUSY', 'That provider is not free for the full visit');
  try {
    await tx.query(`UPDATE appointment SET provider_id = $2, provider_assigned_by = 'ADMIN', updated_at = $3 WHERE id = $1`,
      [a.id, providerId, ctx.now()]);
  } catch (e) {
    if ((e as { code?: string }).code === '23P01') throw conflict('PROVIDER_BUSY', 'That provider was just booked');
    throw e;
  }
  await audit(tx, actor, 'reassign', 'appointment', a.id, { provider_id: a.provider_id }, { provider_id: providerId });
}

export async function reassign(ctx: Ctx, actor: Actor, apptId: string, providerId: string) {
  const s = await getSettings(ctx.db);
  await withTx(ctx.db, async (tx) => {
    const a = await lockAppt(tx, apptId);
    requireApprover(actor, s, a);
    if (!['REQUESTED', 'ALTERNATE_PROPOSED', 'CONFIRMED'].includes(a.status)) throw conflict('INVALID_STATE', 'Appointment is not active');
    await moveProvider(tx, ctx, actor, a, providerId, s);
  });
}

export async function confirm(ctx: Ctx, actor: Actor, apptId: string, providerId?: string) {
  const s = await getSettings(ctx.db);
  await withTx(ctx.db, async (tx) => {
    const a = await lockAppt(tx, apptId);
    requireApprover(actor, s, a);
    if (providerId) await moveProvider(tx, ctx, actor, a, providerId, s);
    await transition(tx, actor, apptId, 'CONFIRMED', { provider_assigned_by: 'ADMIN', expires_at: null }, ctx.now());
  });
  await notifyAppointment(ctx, apptId, 'T3');
}

export async function decline(ctx: Ctx, actor: Actor, apptId: string, reason: string) {
  if (!reason?.trim()) throw badRequest('A reason is required');
  const s = await getSettings(ctx.db);
  const { before } = await withTx(ctx.db, async (tx) => {
    requireApprover(actor, s, await lockAppt(tx, apptId));
    return transition(tx, actor, apptId, 'DECLINED', { decline_reason: reason.trim(), expires_at: null }, ctx.now());
  });
  await notifyAppointment(ctx, apptId, 'T4');
  await offerFreedSlot(ctx, before);
}

/** Move the hold to a new pooled slot and ask the parent (T5). The original slot is released. */
export async function proposeAlternate(ctx: Ctx, actor: Actor, apptId: string, startsAt: Date) {
  const s = await getSettings(ctx.db);
  const { before } = await withTx(ctx.db, async (tx) => {
    const a = await lockAppt(tx, apptId);
    requireApprover(actor, s, a);
    if (a.status !== 'REQUESTED') throw conflict('INVALID_TRANSITION', 'Only pending requests can get an alternate');
    const free = await freeProvidersAt(tx, a.visit_type, startsAt,
      { applyBookingWindow: false, excludeAppointmentId: a.id, settings: s, now: ctx.now() });
    if (!free.length) throw slotTaken();
    const ranked = free.includes(a.provider_id) ? [a.provider_id] : await rankCandidates(tx, free, startsAt, s.TIMEZONE);
    const endsAt = new Date(startsAt.getTime() + (a.ends_at.getTime() - a.starts_at.getTime()));
    for (const pid of ranked) {
      await tx.query('SAVEPOINT alt');
      try {
        return await transition(tx, actor, apptId, 'ALTERNATE_PROPOSED', {
          provider_id: pid, provider_assigned_by: 'ADMIN', starts_at: startsAt, ends_at: endsAt,
          original_starts_at: a.starts_at, expires_at: new Date(ctx.now().getTime() + s.ALT_EXPIRY_HOURS * 3600000),
        }, ctx.now());
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT alt');
        if ((e as { code?: string }).code !== '23P01') throw e;
      }
    }
    throw slotTaken();
  });
  await notifyAppointment(ctx, apptId, 'T5');
  await offerFreedSlot(ctx, before);
}

export async function markAttendance(ctx: Ctx, actor: Actor, apptId: string, outcome: 'COMPLETED' | 'NO_SHOW') {
  await withTx(ctx.db, async (tx) => {
    requireStaffFor(actor, await lockAppt(tx, apptId));
    await transition(tx, actor, apptId, outcome, {}, ctx.now());
  });
}

export async function cancelByClinic(ctx: Ctx, actor: Actor, apptId: string, reason: string) {
  if (actor.type !== 'STAFF' || actor.role !== 'ADMIN') throw forbidden();
  const { before } = await withTx(ctx.db, (tx) =>
    transition(tx, actor, apptId, 'CANCELLED_BY_CLINIC', { cancel_reason: reason?.trim() || null, expires_at: null }, ctx.now()));
  await notifyAppointment(ctx, apptId, 'T7');
  await offerFreedSlot(ctx, before);
}

export async function recordPayment(ctx: Ctx, actor: Actor, apptId: string,
  p: { status: 'PAID_CASH' | 'PAID_BANK_TRANSFER' | 'WAIVED' | 'UNPAID'; reference?: string }) {
  if (actor.type !== 'STAFF' || actor.role !== 'ADMIN') throw forbidden();
  if (p.status === 'PAID_BANK_TRANSFER' && !p.reference?.trim()) throw badRequest('Transfer reference is required');
  await withTx(ctx.db, async (tx) => {
    const a = await lockAppt(tx, apptId);
    const method = { PAID_CASH: 'CASH', PAID_BANK_TRANSFER: 'BANK_TRANSFER', WAIVED: null, UNPAID: null }[p.status];
    const r = await tx.query(
      `UPDATE appointment SET payment_status = $2, payment_method = $3, payment_reference = $4,
         payment_recorded_by = $5, payment_recorded_at = $6, updated_at = $6 WHERE id = $1
       RETURNING payment_status, payment_method, payment_reference`,
      [apptId, p.status, method, p.reference?.trim() || null, actor.id, ctx.now()]);
    await audit(tx, actor, 'payment', 'appointment', apptId,
      { payment_status: a.payment_status, payment_method: a.payment_method, payment_reference: a.payment_reference }, r.rows[0]);
  });
}

// ---------- Parent actions (can_book only — AC 7) ----------

export async function acceptAlternate(ctx: Ctx, guardianId: string, apptId: string) {
  const actor: Actor = { type: 'GUARDIAN', id: guardianId };
  await withTx(ctx.db, async (tx) => {
    const a = await appointmentForGuardian(tx, guardianId, apptId, true);
    if (a.status !== 'ALTERNATE_PROPOSED') throw conflict('INVALID_TRANSITION', 'This offer is no longer available');
    await transition(tx, actor, apptId, 'CONFIRMED', { expires_at: null }, ctx.now());
  });
  await notifyAppointment(ctx, apptId, 'T3');
}

export async function declineAlternate(ctx: Ctx, guardianId: string, apptId: string) {
  const actor: Actor = { type: 'GUARDIAN', id: guardianId };
  const { before } = await withTx(ctx.db, async (tx) => {
    const a = await appointmentForGuardian(tx, guardianId, apptId, true);
    if (a.status !== 'ALTERNATE_PROPOSED') throw conflict('INVALID_TRANSITION', 'This offer is no longer available');
    return transition(tx, actor, apptId, 'CANCELLED', { cancel_reason: 'Alternate time declined.', expires_at: null }, ctx.now());
  });
  await notifyAppointment(ctx, apptId, 'T7');
  await offerFreedSlot(ctx, before);
}

/** Self-service cancel; inside {{CANCEL_CUTOFF_HOURS}} it is allowed but flagged late (PRD §10.2). */
export async function cancelByParent(ctx: Ctx, guardianId: string, apptId: string) {
  const s = await getSettings(ctx.db);
  const actor: Actor = { type: 'GUARDIAN', id: guardianId };
  const { before } = await withTx(ctx.db, async (tx) => {
    const a = await appointmentForGuardian(tx, guardianId, apptId, true);
    const late = a.status === 'CONFIRMED' && a.starts_at.getTime() - ctx.now().getTime() < s.CANCEL_CUTOFF_HOURS * 3600000;
    return transition(tx, actor, apptId, 'CANCELLED_BY_PARENT', { late_cancel: late, cancel_reason: null, expires_at: null }, ctx.now());
  });
  await notifyAppointment(ctx, apptId, 'T7');
  await offerFreedSlot(ctx, before);
}

/**
 * Reschedule creates a new linked appointment (PRD §6). Parent: the new one is REQUESTED and goes back
 * to the approval queue. Admin: the new one is CONFIRMED on the chosen (or least-loaded) provider.
 */
export async function reschedule(ctx: Ctx, actor: Actor, apptId: string, startsAt: Date, providerId?: string) {
  const s = await getSettings(ctx.db);
  const byParent = actor.type === 'GUARDIAN';
  const res = await withTx(ctx.db, async (tx) => {
    const a = byParent ? await appointmentForGuardian(tx, actor.id, apptId, true) : await lockAppt(tx, apptId);
    if (!byParent) requireApprover(actor, s, a);
    const late = byParent && a.starts_at.getTime() - ctx.now().getTime() < s.CANCEL_CUTOFF_HOURS * 3600000;
    const { before } = await transition(tx, actor, apptId, 'RESCHEDULED', { late_cancel: late, expires_at: null }, ctx.now());
    const free = await freeProvidersAt(tx, a.visit_type, startsAt, { applyBookingWindow: byParent, settings: s, now: ctx.now() });
    const pool = providerId ? free.filter((p) => p === providerId) : free;
    const candidates = byParent || !providerId ? await rankCandidates(tx, pool, startsAt, s.TIMEZONE) : pool;
    const hold = await placeHold(tx, {
      patientId: a.patient_id, visitType: a.visit_type, startsAt, candidates,
      status: byParent ? 'REQUESTED' : 'CONFIRMED', requestedBy: byParent ? actor.id : a.requested_by_guardian_id,
      expiresAt: byParent ? requestExpiry(ctx.now(), startsAt, s.REQUEST_EXPIRY_HOURS) : null,
      assignedBy: byParent ? 'SYSTEM' : 'ADMIN', rescheduledFromId: a.id, settings: s,
    });
    if (!hold) throw slotTaken();
    await tx.query(`UPDATE appointment SET payment_status = $2, payment_method = $3, payment_reference = $4 WHERE id = $1`,
      [hold.id, a.payment_status, a.payment_method, a.payment_reference]);
    await tx.query(`INSERT INTO evaluation_intake SELECT $2, reason_text, reason_tags, payer_type, insurer, member_no, has_referral,
      referral_file_key FROM evaluation_intake WHERE appointment_id = $1`, [a.id, hold.id]);
    await audit(tx, actor, 'reschedule', 'appointment', hold.id, { from: a.id }, hold);
    return { before, hold, visitType: a.visit_type as VisitType };
  });
  if (byParent) {
    await notifyAppointment(ctx, res.hold.id, res.visitType === 'FOLLOW_UP' ? 'T1' : 'T2');
    await alertAdminsNewRequest(ctx, res.hold.id, s);
  } else await notifyAppointment(ctx, res.hold.id, 'T3');
  await offerFreedSlot(ctx, res.before);
  return { appointmentId: res.hold.id, ref: res.hold.ref };
}

/** Pooled open slots for the "propose alternate" picker. */
export async function alternateOptions(ctx: Ctx, apptId: string, fromDate?: string, toDate?: string) {
  const a = (await ctx.db.query('SELECT * FROM appointment WHERE id = $1', [apptId])).rows[0];
  if (!a) throw notFound();
  return computeSlots(ctx.db, { visitType: a.visit_type, now: ctx.now(), fromDate, toDate, excludeAppointmentId: a.id });
}

export { AppError, SYSTEM };
