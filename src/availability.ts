import type { Queryable } from './db.js';
import { getSettings, type ClinicSettings } from './settings.js';
import { addDays, localDateStr, localToUtc, timeToMin, weekdayOf } from './time.js';

export type VisitType = 'FOLLOW_UP' | 'EVALUATION';
export const VISIT_TYPES: VisitType[] = ['FOLLOW_UP', 'EVALUATION'];
export const BLOCKING = ['REQUESTED', 'ALTERNATE_PROPOSED', 'CONFIRMED'] as const;

export interface Provider { id: string; name: string; discipline: 'OT' | 'PT'; color: string; display_order: number; phone_e164: string | null }
export interface Slot { startsAt: Date; endsAt: Date; providerIds: string[] }

interface Interval { s: number; e: number }
const overlaps = (a: Interval, b: Interval) => a.s < b.e && b.s < a.e;

export interface AvailabilityOpts {
  visitType: VisitType;
  now?: Date;
  fromDate?: string;              // clinic-local YYYY-MM-DD, inclusive
  toDate?: string;                // clinic-local YYYY-MM-DD, inclusive
  applyBookingWindow?: boolean;   // parent rules: min notice + horizon (default true). Staff actions pass false.
  excludeAppointmentId?: string;  // ignore this appointment's own hold (reassign / reschedule)
  providerIds?: string[];
  settings?: ClinicSettings;
}

export const durationMin = (s: ClinicSettings, vt: VisitType) => s.VISIT_DURATIONS_MIN[vt];

/**
 * Pooled availability (PRD §4): every start time on the grid where the full visit fits inside
 * open hours, together with the active providers free for the whole duration (+ buffer).
 */
export async function computeSlots(q: Queryable, o: AvailabilityOpts): Promise<Slot[]> {
  const s = o.settings ?? (await getSettings(q));
  const tz = s.TIMEZONE;
  const now = o.now ?? new Date();
  const windowOn = o.applyBookingWindow !== false;
  const dur = durationMin(s, o.visitType);
  const step = s.SLOT_STEP_MIN;
  const bufMs = s.BUFFER_MIN * 60000;
  const earliest = windowOn ? now.getTime() + s.MIN_NOTICE_HOURS * 3600000 : -Infinity;

  let from = o.fromDate ?? localDateStr(now, tz);
  let to = o.toDate ?? addDays(localDateStr(now, tz), s.HORIZON_DAYS);
  if (windowOn) {
    const minD = localDateStr(new Date(earliest), tz);
    const maxD = addDays(localDateStr(now, tz), s.HORIZON_DAYS);
    if (from < minD) from = minD;
    if (to > maxD) to = maxD;
  }
  if (from > to) return [];

  const providers = (await q.query(
    `SELECT id FROM provider WHERE active ${o.providerIds ? 'AND id = ANY($1)' : ''} ORDER BY display_order, name`,
    o.providerIds ? [o.providerIds] : [],
  )).rows.map((r) => r.id as string);
  if (!providers.length) return [];

  const rules = (await q.query('SELECT provider_id, weekday, start_time::text, end_time::text FROM availability_rule')).rows;
  const rangeS = localToUtc(from, 0, tz).getTime() - 86400000;
  const rangeE = localToUtc(addDays(to, 1), 0, tz).getTime() + 86400000;

  const busy = new Map<string, Interval[]>();
  const blocks = new Map<string | null, Interval[]>();
  const appts = await q.query(
    `SELECT provider_id, starts_at, ends_at FROM appointment
      WHERE status = ANY($1) AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR id <> $4)`,
    [BLOCKING, new Date(rangeS), new Date(rangeE), o.excludeAppointmentId ?? null],
  );
  for (const a of appts.rows) {
    const list = busy.get(a.provider_id) ?? [];
    list.push({ s: a.starts_at.getTime() - bufMs, e: a.ends_at.getTime() + bufMs });
    busy.set(a.provider_id, list);
  }
  const offs = await q.query(
    'SELECT provider_id, starts_at, ends_at FROM time_off WHERE starts_at < $2 AND ends_at > $1',
    [new Date(rangeS), new Date(rangeE)],
  );
  for (const t of offs.rows) {
    const list = blocks.get(t.provider_id) ?? [];
    list.push({ s: t.starts_at.getTime(), e: t.ends_at.getTime() });
    blocks.set(t.provider_id, list);
  }

  const windowsFor = (pid: string, wd: number) => {
    const own = rules.filter((r) => r.provider_id === pid && r.weekday === wd);
    return own.length ? own : rules.filter((r) => r.provider_id === null && r.weekday === wd);
  };

  const byStart = new Map<number, Slot>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    for (const pid of providers) {
      for (const w of windowsFor(pid, wd)) {
        const ws = timeToMin(w.start_time);
        const we = timeToMin(w.end_time);
        for (let m = Math.ceil(ws / step) * step; m + dur <= we; m += step) {
          const st = localToUtc(d, m, tz).getTime();
          if (st < earliest) continue;
          const iv = { s: st, e: st + dur * 60000 };
          if ((blocks.get(null) ?? []).some((b) => overlaps(b, iv))) continue;
          if ((blocks.get(pid) ?? []).some((b) => overlaps(b, iv))) continue;
          if ((busy.get(pid) ?? []).some((b) => overlaps(b, iv))) continue;
          const slot = byStart.get(st) ?? { startsAt: new Date(st), endsAt: new Date(iv.e), providerIds: [] };
          if (!slot.providerIds.includes(pid)) slot.providerIds.push(pid);
          byStart.set(st, slot);
        }
      }
    }
  }
  return [...byStart.values()]
    .map((sl) => ({ ...sl, providerIds: providers.filter((p) => sl.providerIds.includes(p)) }))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Providers free for the full visit at an exact start time, in provider order. */
export async function freeProvidersAt(
  q: Queryable, visitType: VisitType, startsAt: Date,
  opts: Omit<AvailabilityOpts, 'visitType' | 'fromDate' | 'toDate'> = {},
): Promise<string[]> {
  const s = opts.settings ?? (await getSettings(q));
  const day = localDateStr(startsAt, s.TIMEZONE);
  const slots = await computeSlots(q, { ...opts, settings: s, visitType, fromDate: day, toDate: day });
  return slots.find((x) => x.startsAt.getTime() === startsAt.getTime())?.providerIds ?? [];
}

/** Blocking bookings per provider on the clinic-local day of `at` (for load balancing and the reassign picker). */
export async function dayLoad(q: Queryable, at: Date, tz: string): Promise<Map<string, number>> {
  const day = localDateStr(at, tz);
  const r = await q.query(
    `SELECT provider_id, count(*)::int n FROM appointment
      WHERE status = ANY($1) AND starts_at >= $2 AND starts_at < $3 GROUP BY provider_id`,
    [BLOCKING, localToUtc(day, 0, tz), localToUtc(addDays(day, 1), 0, tz)],
  );
  return new Map(r.rows.map((x) => [x.provider_id, x.n]));
}
