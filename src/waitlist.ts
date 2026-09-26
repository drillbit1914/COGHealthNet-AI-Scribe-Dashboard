import { audit, SYSTEM, type Actor } from './audit.js';
import { freeProvidersAt, type VisitType } from './availability.js';
import { requireCanBook } from './authz.js';
import { alertAdminsNewRequest, placeHold, requestExpiry } from './booking.js';
import type { Ctx } from './ctx.js';
import { withTx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { STRINGS, VISIT_LABEL } from './i18n/en.js';
import { notifyAppointment, sendToGuardian, settingsVars } from './notify/notify.js';
import { getSettings } from './settings.js';
import { fmtDate, fmtDay, fmtTime, localDateStr, localParts } from './time.js';

export async function joinWaitlist(ctx: Ctx, guardianId: string,
  w: { patientId: string; visitType: VisitType; dateFrom: string; dateTo: string; window?: 'ANY' | 'MORNING' | 'AFTERNOON' }) {
  await requireCanBook(ctx.db, guardianId, w.patientId);
  if (w.dateTo < w.dateFrom) throw badRequest('Invalid date range');
  const r = await ctx.db.query(
    `INSERT INTO waitlist_entry (patient_id, guardian_id, visit_type, date_from, date_to, "window") VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [w.patientId, guardianId, w.visitType, w.dateFrom, w.dateTo, w.window ?? 'ANY']);
  await audit(ctx.db, { type: 'GUARDIAN', id: guardianId }, 'join', 'waitlist_entry', r.rows[0].id, null, w);
  return r.rows[0].id as string;
}

/**
 * A blocking appointment was released: if its time is bookable for parents again, offer it to up to
 * {{WAITLIST_OFFER_MAX}} matching entries whose guardian can still book (T8). First claim wins (AC 10).
 */
export async function offerFreedSlot(ctx: Ctx, freed: { provider_id: string; visit_type: VisitType; starts_at: Date; ends_at: Date; status: string }) {
  if (!['REQUESTED', 'ALTERNATE_PROPOSED', 'CONFIRMED'].includes(freed.status)) return;
  const s = await getSettings(ctx.db);
  const now = ctx.now();
  const free = await freeProvidersAt(ctx.db, freed.visit_type, freed.starts_at, { now, settings: s, providerIds: [freed.provider_id] });
  if (!free.length) return;
  const day = localDateStr(freed.starts_at, s.TIMEZONE);
  const hour = localParts(freed.starts_at, s.TIMEZONE).hh;
  const win = hour < 12 ? 'MORNING' : 'AFTERNOON';
  const entries = (await ctx.db.query(
    `SELECT w.id, w.guardian_id, w.patient_id, p.full_name child, g.name, g.phone_e164, g.whatsapp_opt_in_at, g.sms_opt_out_at
       FROM waitlist_entry w
       JOIN guardian_patient gp ON gp.guardian_id = w.guardian_id AND gp.patient_id = w.patient_id AND gp.can_book AND NOT gp.restricted
       JOIN guardian g ON g.id = w.guardian_id JOIN patient p ON p.id = w.patient_id
      WHERE w.status = 'ACTIVE' AND w.visit_type = $1 AND $2::date BETWEEN w.date_from AND w.date_to AND w."window" IN ('ANY', $3)
        AND NOT EXISTS (SELECT 1 FROM appointment a WHERE a.patient_id = w.patient_id AND a.starts_at = $4
                          AND a.status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED'))
      ORDER BY w.created_at LIMIT $5`,
    [freed.visit_type, day, win, freed.starts_at, s.WAITLIST_OFFER_MAX])).rows;
  if (!entries.length) return;
  const offer = await ctx.db.query(
    `INSERT INTO waitlist_offer (provider_id, visit_type, starts_at, ends_at, entry_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [freed.provider_id, freed.visit_type, freed.starts_at, freed.ends_at, entries.map((e) => e.id)]);
  const tz = s.TIMEZONE;
  for (const e of entries) {
    await sendToGuardian(ctx, { ...e, can_book: true }, 'T8', {
      ...settingsVars(s), offer_id: offer.rows[0].id, visit_type: VISIT_LABEL[freed.visit_type],
      day: fmtDay(freed.starts_at, tz), date: fmtDate(freed.starts_at, tz), time: fmtTime(freed.starts_at, tz),
    }, null);
  }
  return offer.rows[0].id as string;
}

/** First tap wins: the offer row is claimed atomically, then a REQUESTED hold is placed. */
export async function claimOffer(ctx: Ctx, guardianId: string, offerId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(offerId)) throw notFound();
  const s = await getSettings(ctx.db);
  const actor: Actor = { type: 'GUARDIAN', id: guardianId };
  const res = await withTx(ctx.db, async (tx) => {
    const o = (await tx.query('SELECT * FROM waitlist_offer WHERE id = $1', [offerId])).rows[0];
    if (!o) throw notFound();
    const entry = (await tx.query(
      `SELECT * FROM waitlist_entry WHERE id = ANY($1) AND guardian_id = $2 ORDER BY created_at LIMIT 1`, [o.entry_ids, guardianId])).rows[0];
    if (!entry) throw notFound();
    await requireCanBook(tx, guardianId, entry.patient_id);
    const won = await tx.query(
      `UPDATE waitlist_offer SET claimed_by_entry_id = $2, claimed_at = $3 WHERE id = $1 AND claimed_at IS NULL RETURNING id`,
      [offerId, entry.id, ctx.now()]);
    if (!won.rowCount) throw conflict('OFFER_TAKEN', STRINGS.offerTaken);
    const hold = await placeHold(tx, {
      patientId: entry.patient_id, visitType: o.visit_type, startsAt: o.starts_at, candidates: [o.provider_id],
      status: 'REQUESTED', requestedBy: guardianId, expiresAt: requestExpiry(ctx.now(), o.starts_at, s.REQUEST_EXPIRY_HOURS),
      assignedBy: 'SYSTEM', settings: s,
    });
    if (!hold) throw conflict('OFFER_TAKEN', STRINGS.offerTaken);
    await tx.query('UPDATE waitlist_offer SET appointment_id = $2 WHERE id = $1', [offerId, hold.id]);
    await tx.query(`UPDATE waitlist_entry SET status = 'FULFILLED' WHERE id = $1`, [entry.id]);
    await audit(tx, actor, 'claim', 'waitlist_offer', offerId, null, { appointment_id: hold.id });
    return { hold, visitType: o.visit_type as VisitType };
  });
  await notifyAppointment(ctx, res.hold.id, res.visitType === 'FOLLOW_UP' ? 'T1' : 'T2');
  await alertAdminsNewRequest(ctx, res.hold.id, s);
  return { appointmentId: res.hold.id, ref: res.hold.ref };
}

export async function removeWaitlistEntry(ctx: Ctx, actor: Actor, entryId: string) {
  const r = await ctx.db.query(`UPDATE waitlist_entry SET status = 'REMOVED' WHERE id = $1 AND status = 'ACTIVE' RETURNING id`, [entryId]);
  if (!r.rowCount) throw notFound();
  await audit(ctx.db, actor, 'remove', 'waitlist_entry', entryId);
}

export { SYSTEM };
