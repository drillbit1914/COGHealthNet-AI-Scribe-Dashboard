import { SYSTEM } from './audit.js';
import { transition } from './appointments.js';
import type { Ctx } from './ctx.js';
import { withTx } from './db.js';
import { notifyAppointment, sendStaff, settingsVars } from './notify/notify.js';
import { getSettings } from './settings.js';
import { addDays, fmtTime, localDateStr, localParts, localToUtc } from './time.js';
import { offerFreedSlot } from './waitlist.js';

/** Run every minute by the worker. Each step is idempotent. */
export async function runJobs(ctx: Ctx) {
  return {
    expired: await expireRequests(ctx),
    altExpired: await expireAlternates(ctx),
    escalations: await escalate(ctx),
    reminders: await sendReminders(ctx),
    agendas: await providerAgendas(ctx),
    purged: await purgeMessageBodies(ctx),
  };
}

/** REQUESTED past expires_at → EXPIRED; the slot reappears (AC 9). */
export async function expireRequests(ctx: Ctx) {
  const due = await ctx.db.query(`SELECT id FROM appointment WHERE status = 'REQUESTED' AND expires_at <= $1`, [ctx.now()]);
  for (const { id } of due.rows) {
    const res = await withTx(ctx.db, (tx) =>
      transition(tx, SYSTEM, id, 'EXPIRED', { decline_reason: 'The request expired before it could be confirmed' }, ctx.now())
    ).catch(() => null); // already actioned concurrently
    if (!res) continue;
    await notifyAppointment(ctx, id, 'T4');
    await offerFreedSlot(ctx, res.before);
  }
  return due.rowCount ?? 0;
}

/** ALTERNATE_PROPOSED with no reply in {{ALT_EXPIRY_HOURS}} → CANCELLED. */
export async function expireAlternates(ctx: Ctx) {
  const due = await ctx.db.query(`SELECT id FROM appointment WHERE status = 'ALTERNATE_PROPOSED' AND expires_at <= $1`, [ctx.now()]);
  for (const { id } of due.rows) {
    const res = await withTx(ctx.db, (tx) =>
      transition(tx, SYSTEM, id, 'CANCELLED', { cancel_reason: 'No reply was received for the offered time.' }, ctx.now())
    ).catch(() => null);
    if (!res) continue;
    await notifyAppointment(ctx, id, 'T7');
    await offerFreedSlot(ctx, res.before);
  }
  return due.rowCount ?? 0;
}

/** S2 once a request has used 50% of its time to expiry. */
export async function escalate(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  const r = await ctx.db.query(
    `UPDATE appointment SET escalation_sent_at = $1
      WHERE status = 'REQUESTED' AND escalation_sent_at IS NULL AND expires_at > $1
        AND created_at + (expires_at - created_at) / 2 <= $1 RETURNING id, ref, expires_at`, [ctx.now()]);
  for (const a of r.rows)
    for (const phone of s.ADMIN_ALERT_PHONES)
      await sendStaff(ctx, phone, 'S2', { ref: a.ref, expires_at: `${localDateStr(a.expires_at, s.TIMEZONE)} ${fmtTime(a.expires_at, s.TIMEZONE)}` }, { apptId: a.id });
  return r.rowCount ?? 0;
}

/** T6 exactly once per confirmed visit, within 24h of start; never for cancelled visits (AC 12). */
export async function sendReminders(ctx: Ctx) {
  const now = ctx.now();
  const r = await ctx.db.query(
    `UPDATE appointment SET reminder_sent_at = $1
      WHERE status = 'CONFIRMED' AND reminder_sent_at IS NULL AND starts_at > $1 AND starts_at <= $2 RETURNING id`,
    [now, new Date(now.getTime() + 24 * 3600000)]);
  for (const { id } of r.rows) await notifyAppointment(ctx, id, 'T6');
  return r.rowCount ?? 0;
}

/** S3 at {{PROVIDER_AGENDA_HOUR}}:00 clinic time, once per provider per day with visits. */
export async function providerAgendas(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  const now = ctx.now();
  if (localParts(now, s.TIMEZONE).hh !== s.PROVIDER_AGENDA_HOUR) return 0;
  const day = localDateStr(now, s.TIMEZONE);
  const from = localToUtc(day, 0, s.TIMEZONE);
  const to = localToUtc(addDays(day, 1), 0, s.TIMEZONE);
  const rows = (await ctx.db.query(
    `SELECT pr.id, pr.phone_e164, count(a.id)::int n, min(a.starts_at) first
       FROM provider pr JOIN appointment a ON a.provider_id = pr.id AND a.status = 'CONFIRMED' AND a.starts_at >= $1 AND a.starts_at < $2
      WHERE pr.active AND pr.phone_e164 IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM message m WHERE m.provider_id = pr.id AND m.template_key = 'S3' AND m.created_at >= $1)
      GROUP BY pr.id`, [from, to])).rows;
  for (const p of rows)
    await sendStaff(ctx, p.phone_e164, 'S3', { ...settingsVars(s), n: p.n, time: fmtTime(p.first, s.TIMEZONE), link: s.ADMIN_BASE_URL }, { providerId: p.id });
  return rows.length;
}

/** Retention: purge message bodies after {{MESSAGE_RETENTION_MONTHS}}, keep metadata (PRD §13). */
export async function purgeMessageBodies(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  const r = await ctx.db.query(
    `UPDATE message SET body = NULL, buttons = NULL WHERE body IS NOT NULL AND created_at < $1::timestamptz - make_interval(months => $2)`,
    [ctx.now(), s.MESSAGE_RETENTION_MONTHS]);
  return r.rowCount ?? 0;
}
