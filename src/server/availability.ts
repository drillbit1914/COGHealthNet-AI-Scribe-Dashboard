import { isOverlapError, q, type Queryable, type Tx } from './db';
import { getSettings, type ClinicSettings } from './settings';
import { addDays, localDateStr, localToUtc, timeToMin, weekdayOf } from './time';

export type VisitType = 'FOLLOW_UP' | 'EVALUATION';
export const VISIT_TYPES: VisitType[] = ['FOLLOW_UP', 'EVALUATION'];
export const BLOCKING = ['REQUESTED', 'ALTERNATE_PROPOSED', 'CONFIRMED'] as const;

export interface Slot {
  startsAt: Date;
  endsAt: Date;
  providerIds: string[];
}

interface Interval {
  s: number;
  e: number;
}
const overlaps = (a: Interval, b: Interval) => a.s < b.e && b.s < a.e;

export interface SlotQuery {
  visitType: VisitType;
  now?: Date;
  /** Clinic-local YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  /** Parent rules: min notice + horizon. Staff tools pass false. Default true. */
  applyBookingWindow?: boolean;
  /** Ignore this appointment's own hold (reassign / alternate / reschedule). */
  excludeAppointmentId?: string;
  providerIds?: string[];
  settings?: ClinicSettings;
}

export const durationMin = (s: ClinicSettings, vt: VisitType) => s.VISIT_DURATIONS_MIN[vt];

/**
 * PRD §4. Every start on the {{SLOT_STEP_MIN}} grid where the full visit fits inside open hours, with
 * the active providers free for the whole duration (+ {{BUFFER_MIN}} either side of existing bookings),
 * outside provider and clinic time off. Per-provider rules for a weekday override the clinic default.
 */
export async function computeSlots(db: Queryable, o: SlotQuery): Promise<Slot[]> {
  const s = o.settings ?? (await getSettings(db));
  const tz = s.TIMEZONE;
  const now = o.now ?? new Date();
  const windowOn = o.applyBookingWindow !== false;
  const dur = durationMin(s, o.visitType);
  const step = s.SLOT_STEP_MIN;
  const bufMs = s.BUFFER_MIN * 60000;
  const earliest = windowOn ? now.getTime() + s.MIN_NOTICE_HOURS * 3600000 : -Infinity;
  const today = localDateStr(now, tz);

  let from = o.from ?? today;
  let to = o.to ?? addDays(today, s.HORIZON_DAYS);
  if (windowOn) {
    const minD = localDateStr(new Date(earliest), tz);
    const maxD = addDays(today, s.HORIZON_DAYS);
    if (from < minD) from = minD;
    if (to > maxD) to = maxD;
  }
  if (from > to) return [];

  const providers = (
    await q<{ id: string }>(
      db,
      `SELECT id FROM provider WHERE active AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY display_order, name`,
      o.providerIds ?? null,
    )
  ).map((r) => r.id);
  if (!providers.length) return [];

  const rules = await q<{ provider_id: string | null; weekday: number; start_time: string; end_time: string }>(
    db,
    'SELECT provider_id, weekday, start_time::text, end_time::text FROM availability_rule',
  );
  const rangeS = new Date(localToUtc(from, 0, tz).getTime() - 86400000);
  const rangeE = new Date(localToUtc(addDays(to, 1), 0, tz).getTime() + 86400000);

  const busy = new Map<string, Interval[]>();
  for (const a of await q<{ provider_id: string; starts_at: Date; ends_at: Date }>(
    db,
    `SELECT provider_id, starts_at, ends_at FROM appointment
      WHERE status = ANY($1::appointment_status[]) AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    BLOCKING,
    rangeS,
    rangeE,
    o.excludeAppointmentId ?? null,
  )) {
    const list = busy.get(a.provider_id) ?? [];
    list.push({ s: a.starts_at.getTime() - bufMs, e: a.ends_at.getTime() + bufMs });
    busy.set(a.provider_id, list);
  }
  const blocks = new Map<string | null, Interval[]>();
  for (const t of await q<{ provider_id: string | null; starts_at: Date; ends_at: Date }>(
    db,
    'SELECT provider_id, starts_at, ends_at FROM time_off WHERE starts_at < $2 AND ends_at > $1',
    rangeS,
    rangeE,
  )) {
    const list = blocks.get(t.provider_id) ?? [];
    list.push({ s: t.starts_at.getTime(), e: t.ends_at.getTime() });
    blocks.set(t.provider_id, list);
  }

  const windowsFor = (pid: string, wd: number) => {
    const own = rules.filter((r) => r.provider_id === pid && r.weekday === wd);
    return own.length ? own : rules.filter((r) => r.provider_id === null && r.weekday === wd);
  };
  const clinicBlocks = blocks.get(null) ?? [];

  const byStart = new Map<number, Slot>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    for (const pid of providers) {
      const own = blocks.get(pid) ?? [];
      const booked = busy.get(pid) ?? [];
      for (const w of windowsFor(pid, wd)) {
        const ws = timeToMin(w.start_time);
        const we = timeToMin(w.end_time);
        for (let m = Math.ceil(ws / step) * step; m + dur <= we; m += step) {
          const st = localToUtc(d, m, tz).getTime();
          if (st < earliest) continue;
          const iv = { s: st, e: st + dur * 60000 };
          if (clinicBlocks.some((b) => overlaps(b, iv)) || own.some((b) => overlaps(b, iv))) continue;
          if (booked.some((b) => overlaps(b, iv))) continue;
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

/** Parent view: a time is open if any active provider is free. Returns times only — never provider ids. */
export async function getPooledSlots(
  db: Queryable,
  o: { visitType: VisitType; from?: string; to?: string; now?: Date },
): Promise<{ startsAt: Date; endsAt: Date }[]> {
  const slots = await computeSlots(db, { ...o, applyBookingWindow: true });
  return slots.map(({ startsAt, endsAt }) => ({ startsAt, endsAt }));
}

/** Admin view for one provider; ignores min notice / horizon (staff may book inside them). */
export async function getProviderSlots(
  db: Queryable,
  o: { visitType: VisitType; providerId: string; from: string; to: string; now?: Date; excludeAppointmentId?: string },
) {
  const slots = await computeSlots(db, { ...o, providerIds: [o.providerId], applyBookingWindow: false });
  return slots.map(({ startsAt, endsAt }) => ({ startsAt, endsAt }));
}

/** Providers free for the full visit at an exact start time, in provider order. */
export async function freeProvidersAt(
  db: Queryable,
  visitType: VisitType,
  startsAt: Date,
  opts: Omit<SlotQuery, 'visitType' | 'from' | 'to'> = {},
): Promise<string[]> {
  const s = opts.settings ?? (await getSettings(db));
  const day = localDateStr(startsAt, s.TIMEZONE);
  const slots = await computeSlots(db, { ...opts, settings: s, visitType, from: day, to: day });
  return slots.find((x) => x.startsAt.getTime() === startsAt.getTime())?.providerIds ?? [];
}

/** Blocking bookings per provider on the clinic-local day of `at`. */
export async function dayLoad(db: Queryable, at: Date, tz: string): Promise<Map<string, number>> {
  const day = localDateStr(at, tz);
  const rows = await q<{ provider_id: string; n: number }>(
    db,
    `SELECT provider_id, count(*)::int n FROM appointment
      WHERE status = ANY($1::appointment_status[]) AND starts_at >= $2 AND starts_at < $3 GROUP BY provider_id`,
    BLOCKING,
    localToUtc(day, 0, tz),
    localToUtc(addDays(day, 1), 0, tz),
  );
  return new Map(rows.map((r) => [r.provider_id, r.n]));
}

/** Fewest bookings that day first; ties broken by provider order (PRD §4). */
export async function rankByLoad(db: Queryable, free: string[], at: Date, tz: string) {
  const load = await dayLoad(db, at, tz);
  return free
    .map((id, i) => ({ id, i, n: load.get(id) ?? 0 }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.id);
}

/**
 * Tentative assignment (PRD §4, §11): try the least-loaded free provider; if the insert hits the
 * exclusion constraint (a concurrent booking won), roll back to a savepoint and try the next.
 * `insert` performs the actual write (owned by appointments.ts). Returns null when all are taken.
 */
export async function assignTentativeProvider<T>(
  tx: Tx,
  candidates: string[],
  insert: (providerId: string) => Promise<T>,
): Promise<T | null> {
  for (const providerId of candidates) {
    await tx.$executeRawUnsafe('SAVEPOINT tentative_assign');
    try {
      const out = await insert(providerId);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT tentative_assign');
      return out;
    } catch (e) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tentative_assign');
      if (!isOverlapError(e)) throw e;
    }
  }
  return null;
}
