/**
 * Outbox worker (PRD §7). Services only ever insert PENDING rows inside their transaction; this module
 * sends them. Channel per guardian: WhatsApp if opted in, else SMS. A WhatsApp failure (API error or
 * "failed" status webhook) falls back to SMS immediately (AC 8); SMS retries with backoff, 3 attempts.
 */
import { t, type Vars } from '@/i18n';
import type { Ctx } from '../context';
import { exec, q, type Queryable } from '../db';
import { bookingLink } from '../settings';
import { getProviders, type Providers } from './provider';
import { isTemplateKey, REPLY, templateParams, type Button } from './templates';

export const MAX_ATTEMPTS = 3;
/** Delay before attempt 2 and attempt 3. */
export const BACKOFF_MS = [60_000, 5 * 60_000];
const STALE_SENDING_MS = 10 * 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MsgRow = Record<string, any>;

/** Claim due rows (and rows stuck in SENDING after a crash) without blocking other workers. */
async function claim(db: Queryable, now: Date, limit: number): Promise<MsgRow[]> {
  const rows = await q(
    db,
    `UPDATE message SET status = 'SENDING', updated_at = $1
      WHERE id IN (
        SELECT id FROM message
         WHERE direction = 'OUT'
           AND ((status = 'PENDING' AND next_attempt_at <= $1) OR (status = 'SENDING' AND updated_at < $2))
         ORDER BY created_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    now,
    new Date(now.getTime() - STALE_SENDING_MS),
    limit,
  );
  return rows.sort((a, b) => a.created_at - b.created_at);
}

export interface OutboxResult {
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
  fallbacks: number;
}

export async function processOutbox(
  ctx: Ctx,
  opts: { providers?: Providers; limit?: number } = {},
): Promise<OutboxResult> {
  const providers = opts.providers ?? getProviders();
  const out: OutboxResult = { sent: 0, failed: 0, retried: 0, skipped: 0, fallbacks: 0 };
  // Loop so fallbacks created in this run go out in this run.
  for (let round = 0; round < 5; round++) {
    const batch = await claim(ctx.db, ctx.now(), opts.limit ?? 50);
    if (!batch.length) break;
    for (const m of batch) await sendOne(ctx, providers, m, out);
  }
  return out;
}

async function resolveChannel(db: Queryable, m: MsgRow): Promise<{ channel: 'WHATSAPP' | 'SMS'; skip?: string }> {
  if (m.channel) return { channel: m.channel };
  if (m.sms_only) return { channel: 'SMS' };
  if (m.template_key === 'T0') return { channel: 'WHATSAPP' }; // PRD §5: code by WhatsApp, SMS fallback
  if (!m.guardian_id) return { channel: 'WHATSAPP' }; // staff and provider alerts
  const [g] = await q(db, 'SELECT whatsapp_opt_in_at FROM guardian WHERE id = $1::uuid', m.guardian_id);
  return { channel: g?.whatsapp_opt_in_at ? 'WHATSAPP' : 'SMS' };
}

async function smsOptedOut(db: Queryable, m: MsgRow) {
  if (!m.guardian_id || m.template_key === 'T0') return false; // a code the person just asked for is always sent
  const [g] = await q(db, 'SELECT sms_opt_out_at FROM guardian WHERE id = $1::uuid', m.guardian_id);
  return !!g?.sms_opt_out_at;
}

/** SMS has no buttons: can_book recipients get a link to the booking site instead. */
function smsBody(m: MsgRow) {
  const buttons = (m.buttons ?? []) as Button[];
  return buttons.length ? m.body + t('templates.smsManageSuffix', { link: bookingLink() }) : m.body;
}

async function sendOne(ctx: Ctx, providers: Providers, m: MsgRow, out: OutboxResult) {
  const now = ctx.now();
  const { channel } = await resolveChannel(ctx.db, m);
  if (channel === 'SMS' && (await smsOptedOut(ctx.db, m))) {
    await exec(
      ctx.db,
      `UPDATE message SET status = 'SKIPPED', channel = 'SMS', error = 'SMS opt-out', updated_at = $2 WHERE id = $1::uuid`,
      m.id,
      now,
    );
    out.skipped++;
    return;
  }
  const key = isTemplateKey(m.template_key) ? m.template_key : null;
  const vars = (m.vars ?? {}) as Vars;
  const provider = channel === 'WHATSAPP' ? providers.whatsapp : providers.sms;
  try {
    const { providerMessageId } = await provider.send({
      to: m.to_phone,
      body: channel === 'SMS' ? smsBody(m) : m.body,
      templateKey: m.template_key === REPLY ? null : key,
      params: key ? templateParams(key, vars) : [],
      buttons: channel === 'WHATSAPP' ? ((m.buttons ?? []) as Button[]) : [],
    });
    await exec(
      ctx.db,
      `UPDATE message SET status = 'SENT', channel = $2::channel, provider_message_id = $3, attempts = attempts + 1, error = NULL,
         updated_at = $4,
         -- One-time codes are never retained in the message log.
         body = CASE WHEN template_key = 'T0' THEN NULL ELSE body END,
         vars = CASE WHEN template_key = 'T0' THEN NULL ELSE vars END
       WHERE id = $1::uuid`,
      m.id,
      channel,
      providerMessageId,
      now,
    );
    out.sent++;
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 500);
    const attempts = (m.attempts ?? 0) + 1;
    if (channel === 'WHATSAPP') {
      await exec(
        ctx.db,
        `UPDATE message SET status = 'FAILED', channel = 'WHATSAPP', attempts = $2, error = $3, updated_at = $4 WHERE id = $1::uuid`,
        m.id,
        attempts,
        error,
        now,
      );
      out.failed++;
      if (await createSmsFallback(ctx.db, m.id, now)) out.fallbacks++;
    } else if (attempts >= MAX_ATTEMPTS) {
      await exec(
        ctx.db,
        `UPDATE message SET status = 'FAILED', channel = 'SMS', attempts = $2, error = $3, updated_at = $4 WHERE id = $1::uuid`,
        m.id,
        attempts,
        error,
        now,
      );
      out.failed++;
    } else {
      await exec(
        ctx.db,
        `UPDATE message SET status = 'PENDING', channel = 'SMS', attempts = $2, error = $3, next_attempt_at = $4, updated_at = $5
          WHERE id = $1::uuid`,
        m.id,
        attempts,
        error,
        new Date(now.getTime() + BACKOFF_MS[attempts - 1]),
        now,
      );
      out.retried++;
    }
  }
}

/** Queue exactly one SMS copy of a failed WhatsApp message. Returns false if one already exists. */
export async function createSmsFallback(db: Queryable, failedId: string, now: Date) {
  const rows = await q(
    db,
    `INSERT INTO message (guardian_id, provider_id, appointment_id, template_key, channel, sms_only, to_phone, status, direction,
                          body, vars, buttons, next_attempt_at, fallback_of_id, created_at, updated_at)
     SELECT guardian_id, provider_id, appointment_id, template_key, 'SMS', true, to_phone, 'PENDING', 'OUT',
            body, vars, buttons, $2, id, $2, $2
       FROM message m
      WHERE m.id = $1::uuid AND m.channel = 'WHATSAPP'
        AND NOT EXISTS (SELECT 1 FROM message f WHERE f.fallback_of_id = m.id)
     RETURNING id`,
    failedId,
    now,
  );
  return rows.length > 0;
}

const RANK: Record<string, number> = { SENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };
const normalise = (s: string) =>
  ({
    sent: 'SENT',
    delivered: 'DELIVERED',
    read: 'READ',
    failed: 'FAILED',
    undelivered: 'FAILED',
    queued: 'SENT',
    accepted: 'SENT',
    sending: 'SENT',
  })[s.toLowerCase()];

/**
 * Delivery-status webhook (WhatsApp or Twilio). Never downgrades (a late "sent" after "read").
 * A WhatsApp "failed" queues the SMS fallback; returns true when the caller should flush the outbox.
 */
export async function recordDeliveryStatus(ctx: Ctx, providerMessageId: string, rawStatus: string, error?: string) {
  const status = normalise(rawStatus);
  if (!status) return false;
  const [m] = await q(
    ctx.db,
    `SELECT * FROM message WHERE provider_message_id = $1 AND direction = 'OUT'`,
    providerMessageId,
  );
  if (!m) return false;
  const upgrade =
    status === 'FAILED' ? m.status !== 'FAILED' : (RANK[status] ?? 0) > (RANK[m.status] ?? -1) && m.status !== 'FAILED';
  if (upgrade)
    await exec(
      ctx.db,
      `UPDATE message SET status = $2::message_status, error = COALESCE($3, error), updated_at = $4 WHERE id = $1::uuid`,
      m.id,
      status,
      error ?? null,
      ctx.now(),
    );
  if (status === 'FAILED' && m.channel === 'WHATSAPP') return createSmsFallback(ctx.db, m.id, ctx.now());
  return false;
}

/** Retention (PRD §13): purge message bodies after {{MESSAGE_RETENTION_MONTHS}}, keep metadata. */
export async function purgeMessageBodies(ctx: Ctx, months: number) {
  return exec(
    ctx.db,
    `UPDATE message SET body = NULL, vars = NULL, buttons = NULL
      WHERE (body IS NOT NULL OR vars IS NOT NULL) AND created_at < $1::timestamptz - make_interval(months => $2)`,
    ctx.now(),
    months,
  );
}
