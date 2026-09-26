/** Scheduled work behind /api/cron/* (every 5 minutes). Every job is idempotent. */
import { escalate, expire, queueReminders } from './appointments';
import type { Ctx } from './context';
import { q, withTx } from './db';
import { processOutbox, purgeMessageBodies } from './messaging/outbox';
import type { Providers } from './messaging/provider';
import { enqueue, settingsVars } from './notifications';
import { adminLink, getSettings } from './settings';
import { addDays, fmtTime, localDateStr, localParts, localToUtc } from './time';
import { sweepWaitlist } from './waitlist';

/**
 * S3 at {{PROVIDER_AGENDA_HOUR}}:00 AST on clinic days (weekdays with opening hours), once per provider
 * per day, to active providers with a phone and at least one confirmed visit.
 */
export async function providerAgendas(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  const now = ctx.now();
  const tz = s.TIMEZONE;
  const { hh, weekday } = localParts(now, tz);
  if (hh !== s.PROVIDER_AGENDA_HOUR) return 0;
  const [{ open }] = await q(ctx.db, 'SELECT count(*)::int open FROM availability_rule WHERE weekday = $1', weekday);
  if (!open) return 0;
  const day = localDateStr(now, tz);
  const from = localToUtc(day, 0, tz);
  const to = localToUtc(addDays(day, 1), 0, tz);
  return withTx(ctx.db, async (tx) => {
    const rows = await q(
      tx,
      `SELECT pr.id, pr.phone_e164, count(a.id)::int n, min(a.starts_at) first
         FROM provider pr
         JOIN appointment a ON a.provider_id = pr.id AND a.status = 'CONFIRMED' AND a.starts_at >= $1 AND a.starts_at < $2
        WHERE pr.active AND pr.phone_e164 IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM message m WHERE m.provider_id = pr.id AND m.template_key = 'S3' AND m.created_at >= $1)
        GROUP BY pr.id`,
      from,
      to,
    );
    for (const p of rows)
      await enqueue(tx, {
        key: 'S3',
        vars: { ...settingsVars(s), n: p.n, time: fmtTime(p.first, tz), link: `${adminLink()}/calendar` },
        toPhone: p.phone_e164,
        providerId: p.id,
        now,
      });
    return rows.length;
  });
}

export const JOBS = {
  /** Expire REQUESTED / ALTERNATE_PROPOSED past expiry (T4/T7) and send S2 escalations. */
  expire: async (ctx: Ctx) => ({ expired: await expire(ctx), escalated: await escalate(ctx) }),
  /** T6 exactly once, 24h before each CONFIRMED visit (reminder_sent_at marker). */
  reminders: async (ctx: Ctx) => ({ reminders: await queueReminders(ctx) }),
  agenda: async (ctx: Ctx) => ({ agendas: await providerAgendas(ctx) }),
  waitlist: async (ctx: Ctx) => sweepWaitlist(ctx),
  retention: async (ctx: Ctx) => ({
    purged: await purgeMessageBodies(ctx, (await getSettings(ctx.db)).MESSAGE_RETENTION_MONTHS),
  }),
  outbox: async () => ({}),
} as const;
export type JobName = keyof typeof JOBS;

/** Run a job, then flush the outbox so its messages go out in the same tick. */
export async function runJob(ctx: Ctx, name: JobName, providers?: Providers) {
  const result = await JOBS[name](ctx);
  const outbox = await processOutbox(ctx, { providers });
  return { job: name, ...result, outbox };
}
