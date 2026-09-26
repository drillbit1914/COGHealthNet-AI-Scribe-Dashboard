import { audit, type Actor } from './audit.js';
import { freeProvidersAt, type VisitType } from './availability.js';
import { placeHold } from './booking.js';
import type { Ctx } from './ctx.js';
import { withTx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { notifyAppointment } from './notify/notify.js';
import { getSettings } from './settings.js';
import { addDays, localDateStr, localParts, localToUtc } from './time.js';

export interface SeriesInput {
  patientId: string; providerId: string; visitType: VisitType; firstStartsAt: Date; rule: 'WEEKLY' | 'BIWEEKLY'; count: number;
}

/** Occurrences at the same clinic-local wall time, each flagged if the provider is not free. */
export async function previewSeries(ctx: Ctx, i: SeriesInput) {
  if (i.count < 1 || i.count > 52) throw badRequest('Count must be between 1 and 52');
  const s = await getSettings(ctx.db);
  const tz = s.TIMEZONE;
  const p = localParts(i.firstStartsAt, tz);
  const minutes = p.hh * 60 + p.mm;
  const day0 = localDateStr(i.firstStartsAt, tz);
  const step = i.rule === 'WEEKLY' ? 7 : 14;
  const out = [];
  for (let k = 0; k < i.count; k++) {
    const startsAt = localToUtc(addDays(day0, k * step), minutes, tz);
    const free = await freeProvidersAt(ctx.db, i.visitType, startsAt,
      { applyBookingWindow: false, providerIds: [i.providerId], settings: s, now: ctx.now() });
    out.push({ startsAt, conflict: !free.length });
  }
  return out;
}

/** Recurring series are created CONFIRMED (PRD §9). Conflicts must be resolved or explicitly skipped. */
export async function createSeries(ctx: Ctx, actor: Actor, i: SeriesInput, skipConflicts = false) {
  if (actor.type !== 'STAFF' || actor.role !== 'ADMIN') throw forbidden();
  const s = await getSettings(ctx.db);
  const preview = await previewSeries(ctx, i);
  const conflicts = preview.filter((o) => o.conflict);
  if (conflicts.length && !skipConflicts) throw conflict('SERIES_CONFLICTS', `${conflicts.length} date(s) conflict`);
  const ids = await withTx(ctx.db, async (tx) => {
    const pt = await tx.query('SELECT id FROM patient WHERE id = $1', [i.patientId]);
    if (!pt.rowCount) throw notFound();
    const sr = await tx.query(
      'INSERT INTO recurring_series (patient_id, provider_id, visit_type, rule, count) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [i.patientId, i.providerId, i.visitType, i.rule, i.count]);
    const created: string[] = [];
    for (const o of preview.filter((x) => !x.conflict)) {
      const hold = await placeHold(tx, { patientId: i.patientId, visitType: i.visitType, startsAt: o.startsAt,
        candidates: [i.providerId], status: 'CONFIRMED', requestedBy: null, expiresAt: null, assignedBy: 'ADMIN',
        seriesId: sr.rows[0].id, settings: s });
      if (!hold) throw conflict('SERIES_CONFLICTS', 'A date was just booked; preview again');
      created.push(hold.id);
    }
    await audit(tx, actor, 'create', 'recurring_series', sr.rows[0].id, null, { ...i, created: created.length });
    return created;
  });
  // One confirmation for the first visit; 24h reminders cover the rest without flooding parents.
  if (ids[0]) await notifyAppointment(ctx, ids[0], 'T3');
  return { appointmentIds: ids, skipped: conflicts.map((c) => c.startsAt) };
}
