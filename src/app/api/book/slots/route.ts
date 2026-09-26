import { z } from 'zod';
import { getPooledSlots } from '@/server/availability';
import { requireGuardian, route } from '@/server/http';
import { getSettings } from '@/server/settings';
import { fmtDate, fmtDay, fmtShortDate, fmtTime, localDateStr } from '@/server/time';

const Query = z.object({
  visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Pooled times only (PRD §4) — no provider identities, grouped by clinic-local day. */
export const GET = route(async ({ req, ctx, actor }) => {
  requireGuardian(actor);
  const qy = Query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const s = await getSettings(ctx.db);
  const tz = s.TIMEZONE;
  const slots = await getPooledSlots(ctx.db, { visitType: qy.visitType, from: qy.from, to: qy.to, now: ctx.now() });
  const days = new Map<
    string,
    { date: string; label: string; short: string; times: { startsAt: string; label: string }[] }
  >();
  for (const sl of slots) {
    const d = localDateStr(sl.startsAt, tz);
    if (!days.has(d))
      days.set(d, {
        date: d,
        label: `${fmtDay(sl.startsAt, tz)} ${fmtDate(sl.startsAt, tz)}`,
        short: fmtShortDate(sl.startsAt, tz),
        times: [],
      });
    days.get(d)!.times.push({ startsAt: sl.startsAt.toISOString(), label: fmtTime(sl.startsAt, tz) });
  }
  return { timezone: tz, days: [...days.values()] };
});
