import { audit, type Actor } from './audit.js';
import { transition } from './appointments.js';
import { BLOCKING } from './availability.js';
import type { Ctx } from './ctx.js';
import { withTx } from './db.js';
import { badRequest, forbidden } from './errors.js';
import { notifyAppointment } from './notify/notify.js';
import { getSettings } from './settings.js';
import { fmtDate } from './time.js';

export interface TimeOffInput { providerId?: string | null; startsAt: Date; endsAt: Date; reason?: string }

/** Provider or clinic-wide time off (partial day or range). Providers may only add their own. */
export async function addTimeOff(ctx: Ctx, actor: Actor, t: TimeOffInput) {
  if (actor.type !== 'STAFF') throw forbidden();
  if (actor.role === 'PROVIDER' && t.providerId !== actor.providerId) throw forbidden();
  if (t.endsAt <= t.startsAt) throw badRequest('End must be after start');
  const r = await ctx.db.query(
    'INSERT INTO time_off (provider_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4) RETURNING *',
    [t.providerId ?? null, t.startsAt, t.endsAt, t.reason ?? null]);
  await audit(ctx.db, actor, 'create', 'time_off', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export async function previewClosure(ctx: Ctx, startsAt: Date, endsAt: Date) {
  const r = await ctx.db.query(
    `SELECT a.id, a.ref, a.status, a.visit_type, a.starts_at, p.full_name child, pr.name provider
       FROM appointment a JOIN patient p ON p.id = a.patient_id JOIN provider pr ON pr.id = a.provider_id
      WHERE a.status = ANY($1) AND a.starts_at < $3 AND a.ends_at > $2 ORDER BY a.starts_at`,
    [BLOCKING, startsAt, endsAt]);
  return r.rows;
}

/**
 * Clinic closure (PRD §9): block the range, cancel every affected visit as CANCELLED_BY_CLINIC,
 * add each family to the rebook list, and send one T10 per notified guardian (AC 13).
 */
export async function applyClosure(ctx: Ctx, actor: Actor, startsAt: Date, endsAt: Date, reason: string) {
  if (actor.type !== 'STAFF' || actor.role !== 'ADMIN') throw forbidden();
  if (!reason?.trim()) throw badRequest('A reason is required');
  if (endsAt <= startsAt) throw badRequest('End must be after start');
  const ids = await withTx(ctx.db, async (tx) => {
    const t = await tx.query(
      'INSERT INTO time_off (provider_id, starts_at, ends_at, reason, is_closure) VALUES (NULL,$1,$2,$3,true) RETURNING id',
      [startsAt, endsAt, reason.trim()]);
    await audit(tx, actor, 'closure', 'time_off', t.rows[0].id, null, { startsAt, endsAt, reason });
    const affected = await tx.query(
      `SELECT id, patient_id FROM appointment WHERE status = ANY($1) AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at FOR UPDATE`,
      [BLOCKING, startsAt, endsAt]);
    for (const a of affected.rows) {
      await transition(tx, actor, a.id, 'CANCELLED_BY_CLINIC', { cancel_reason: reason.trim(), expires_at: null }, ctx.now());
      await tx.query('INSERT INTO rebook_entry (patient_id, appointment_id, reason) VALUES ($1,$2,$3)', [a.patient_id, a.id, reason.trim()]);
    }
    return affected.rows.map((a) => a.id as string);
  });
  const s = await getSettings(ctx.db);
  for (const id of ids) {
    const a = (await ctx.db.query('SELECT starts_at FROM appointment WHERE id = $1', [id])).rows[0];
    await notifyAppointment(ctx, id, 'T10', { reason: reason.trim(), date: fmtDate(a.starts_at, s.TIMEZONE) });
  }
  return { cancelled: ids.length, appointmentIds: ids };
}
