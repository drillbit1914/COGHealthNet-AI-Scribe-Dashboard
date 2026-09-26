import { t } from '@/i18n';
import { computeSlots, type VisitType } from './availability';
import type { Ctx } from './context';
import { exec, q, withTx } from './db';
import { enqueueToGuardian, settingsVars } from './notifications';
import { getSettings } from './settings';
import { fmtDate, fmtDay, fmtTime, localDateStr, localParts } from './time';

/**
 * Cron sweep (PRD §10.3). Immediate offers are sent inside the transaction that frees a slot; this
 * catches times that opened any other way (expired holds, removed time off, new hours). Each open
 * time goes to at most {{WAITLIST_OFFER_MAX}} can_book guardians; an entry is not re-offered while it
 * has an unclaimed offer from the last 12 hours. Claims are settled by the exclusion constraint.
 */
export async function sweepWaitlist(ctx: Ctx) {
  const now = ctx.now();
  const s = await getSettings(ctx.db);
  const tz = s.TIMEZONE;
  const today = localDateStr(now, tz);
  const closed = await exec(
    ctx.db,
    `UPDATE waitlist_entry SET status = 'REMOVED' WHERE status = 'ACTIVE' AND date_to < $1::date`,
    today,
  );

  const entries = await q(
    ctx.db,
    `SELECT w.id, w.guardian_id, w.patient_id, w.visit_type::text, w.date_from::text, w.date_to::text, w."window"::text AS win,
            g.name, g.phone_e164
       FROM waitlist_entry w
       JOIN guardian_patient gp ON gp.guardian_id = w.guardian_id AND gp.patient_id = w.patient_id AND gp.can_book AND NOT gp.restricted
       JOIN guardian g ON g.id = w.guardian_id
      WHERE w.status = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM waitlist_offer o WHERE w.id = ANY(o.entry_ids) AND o.claimed_at IS NULL AND o.created_at > $1)
      ORDER BY w.created_at`,
    new Date(now.getTime() - 12 * 3600000),
  );
  const slotCache = new Map<VisitType, Awaited<ReturnType<typeof computeSlots>>>();
  const groups = new Map<
    string,
    { slot: { startsAt: Date; endsAt: Date; providerId: string; visitType: VisitType }; entries: typeof entries }
  >();
  for (const e of entries) {
    const vt = e.visit_type as VisitType;
    if (!slotCache.has(vt)) slotCache.set(vt, await computeSlots(ctx.db, { visitType: vt, now, settings: s }));
    const slot = slotCache.get(vt)!.find((sl) => {
      const d = localDateStr(sl.startsAt, tz);
      const morning = localParts(sl.startsAt, tz).hh < 12;
      return d >= e.date_from && d <= e.date_to && (e.win === 'ANY' || (e.win === 'MORNING') === morning);
    });
    if (!slot) continue;
    const key = `${vt}|${slot.startsAt.toISOString()}`;
    const grp = groups.get(key) ?? {
      slot: { startsAt: slot.startsAt, endsAt: slot.endsAt, providerId: slot.providerIds[0], visitType: vt },
      entries: [],
    };
    if (grp.entries.length < s.WAITLIST_OFFER_MAX) grp.entries.push(e);
    groups.set(key, grp);
  }

  let offers = 0;
  for (const { slot, entries: es } of groups.values()) {
    await withTx(ctx.db, async (tx) => {
      const [offer] = await q(
        tx,
        `INSERT INTO waitlist_offer (provider_id, visit_type, starts_at, ends_at, entry_ids, created_at)
         VALUES ($1::uuid, $2::visit_type, $3, $4, $5::uuid[], $6) RETURNING id`,
        slot.providerId,
        slot.visitType,
        slot.startsAt,
        slot.endsAt,
        es.map((e) => e.id),
        now,
      );
      const vars = {
        ...settingsVars(s),
        offer_id: offer.id,
        visit_type: t(`visitType.${slot.visitType}`),
        day: fmtDay(slot.startsAt, tz),
        date: fmtDate(slot.startsAt, tz),
        time: fmtTime(slot.startsAt, tz),
      };
      for (const e of es)
        await enqueueToGuardian(
          tx,
          { guardian_id: e.guardian_id, name: e.name, phone_e164: e.phone_e164, can_book: true },
          'T8',
          vars,
          null,
          now,
        );
    });
    offers++;
  }
  return { closed, offers };
}
