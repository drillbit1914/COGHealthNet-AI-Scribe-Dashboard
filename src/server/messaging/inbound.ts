/**
 * Inbound WhatsApp/SMS (PRD §7). Buttons change an appointment only for can_book guardians — the
 * services enforce it; anyone else gets a polite reply and nothing changes. YES/STOP manage opt-in.
 * Free text or an image after T1 becomes a payment_proof for admin review — never auto-marked paid.
 */
import crypto from 'node:crypto';
import { t } from '@/i18n';
import { acceptAlternate, claimWaitlistOffer } from '../appointments';
import { audit } from '../audit';
import { appointmentForGuardian, isUuid } from '../authz';
import type { Ctx } from '../context';
import { exec, q } from '../db';
import { AppError } from '../errors';
import { enqueueReply } from '../notifications';
import { bookingLink, getSettings } from '../settings';
import { getStorage } from '../storage';

export interface Inbound {
  channel: 'WHATSAPP' | 'SMS';
  from: string;
  providerMessageId?: string;
  text?: string;
  buttonPayload?: string;
  /** Loads the attachment bytes (WhatsApp media id or Twilio media URL). */
  media?: () => Promise<{ data: Buffer; contentType: string }>;
}

const PROOF_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export async function handleInbound(ctx: Ctx, m: Inbound): Promise<{ action: string; error?: string }> {
  const now = ctx.now();
  const from = '+' + m.from.replace(/\D/g, '');
  if (m.providerMessageId) {
    const dup = await q(
      ctx.db,
      `SELECT 1 FROM message WHERE provider_message_id = $1 AND direction = 'IN'`,
      m.providerMessageId,
    );
    if (dup.length) return { action: 'duplicate' }; // Meta and Twilio retry webhooks
  }
  const [g] = await q(ctx.db, `SELECT COALESCE(merged_into_id, id) id FROM guardian WHERE phone_e164 = $1`, from);
  await exec(
    ctx.db,
    `INSERT INTO message (guardian_id, channel, to_phone, provider_message_id, status, direction, body, created_at, updated_at)
     VALUES ($1::uuid, $2::channel, $3, $4, 'RECEIVED', 'IN', $5, $6, $6)`,
    g?.id ?? null,
    m.channel,
    from,
    m.providerMessageId ?? null,
    m.buttonPayload ? `[button] ${m.buttonPayload}` : (m.text ?? (m.media ? '[attachment]' : null)),
    now,
  );
  if (!g) return { action: 'ignored_unknown_sender' };

  const s = await getSettings(ctx.db);
  const actor = { type: 'GUARDIAN' as const, id: g.id as string };
  const reply = (body: string, appointmentId?: string) =>
    enqueueReply(ctx.db, { toPhone: from, guardianId: g.id, channel: m.channel, body, appointmentId, now });

  if (m.buttonPayload) return handleButton(ctx, g.id, m.buttonPayload, reply, s.CLINIC_PHONE);

  const word = m.text?.trim().toUpperCase();
  if (word === 'YES') {
    await exec(
      ctx.db,
      `UPDATE guardian SET whatsapp_opt_in_at = COALESCE(whatsapp_opt_in_at, $2), sms_opt_out_at = NULL WHERE id = $1::uuid`,
      g.id,
      now,
    );
    await audit(ctx.db, actor, 'whatsapp_opt_in', 'guardian', g.id);
    await reply(t('replies.optIn'));
    return { action: 'opt_in' };
  }
  if (word && ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(word)) {
    // SMS STOP: Twilio also blocks at carrier level; WhatsApp STOP: fall back to SMS updates.
    if (m.channel === 'SMS')
      await exec(ctx.db, 'UPDATE guardian SET sms_opt_out_at = $2 WHERE id = $1::uuid', g.id, now);
    else await exec(ctx.db, 'UPDATE guardian SET whatsapp_opt_in_at = NULL WHERE id = $1::uuid', g.id);
    await audit(ctx.db, actor, 'opt_out', 'guardian', g.id, null, { channel: m.channel });
    return { action: 'opt_out' };
  }

  if (m.text || m.media) {
    // Latest unpaid, still-active visit whose T1 (payment options) went to this guardian.
    const [a] = await q(
      ctx.db,
      `SELECT a.id, a.ref FROM appointment a
        WHERE a.payment_status = 'UNPAID' AND a.status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED')
          AND EXISTS (SELECT 1 FROM message x WHERE x.appointment_id = a.id AND x.guardian_id = $1::uuid AND x.template_key = 'T1')
          AND EXISTS (SELECT 1 FROM guardian_patient gp WHERE gp.patient_id = a.patient_id AND gp.guardian_id = $1::uuid AND NOT gp.restricted)
        ORDER BY a.created_at DESC LIMIT 1`,
      g.id,
    );
    if (!a) return { action: 'ignored' };
    let fileKey: string | null = null;
    if (m.media) {
      try {
        const f = await m.media();
        const ext = PROOF_TYPES[f.contentType.split(';')[0]];
        if (ext && f.data.length && f.data.length <= 10 * 1024 * 1024) {
          fileKey = `proofs/${a.id}/${crypto.randomUUID()}.${ext}`;
          await getStorage().put(fileKey, f.data, f.contentType.split(';')[0]);
        }
      } catch (e) {
        console.error('payment proof media download failed', e);
      }
    }
    await exec(
      ctx.db,
      `INSERT INTO payment_proof (appointment_id, guardian_id, text, file_key, received_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
      a.id,
      g.id,
      m.text?.slice(0, 1000) ?? null,
      fileKey,
      now,
    );
    await audit(ctx.db, actor, 'payment_proof', 'appointment', a.id, null, { file: !!fileKey });
    await reply(t('replies.proofReceived', { ref: a.ref }), a.id);
    return { action: 'payment_proof' };
  }
  return { action: 'ignored' };
}

async function handleButton(
  ctx: Ctx,
  guardianId: string,
  payload: string,
  reply: (body: string, appointmentId?: string) => Promise<void>,
  clinicPhone: string,
): Promise<{ action: string; error?: string }> {
  const [kind, id] = payload.split(':');
  if (!isUuid(id)) return { action: 'ignored' };
  try {
    switch (kind) {
      case 'ACCEPT':
        await acceptAlternate(ctx, guardianId, id); // T3 is queued by the service
        return { action: 'accepted' };
      case 'CLAIM':
        await claimWaitlistOffer(ctx, guardianId, id); // T1/T2 queued by the service
        return { action: 'claimed' };
      case 'ATTEND':
        await appointmentForGuardian(ctx.db, guardianId, id, true);
        await audit(ctx.db, { type: 'GUARDIAN', id: guardianId }, 'attendance_confirmed', 'appointment', id);
        await reply(t('replies.attendThanks'), id);
        return { action: 'attend_ack' };
      case 'RESCHEDULE':
      case 'CHOOSE_OTHER':
        await appointmentForGuardian(ctx.db, guardianId, id, true);
        await reply(t('replies.manageLink', { link: `${bookingLink()}/visits` }), id);
        return { action: 'link_sent' };
      case 'VIEW':
        await appointmentForGuardian(ctx.db, guardianId, id, false);
        await reply(t('replies.manageLink', { link: `${bookingLink()}/visits` }), id);
        return { action: 'link_sent' };
      default:
        return { action: 'ignored' };
    }
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if (e.code === 'FORBIDDEN') await reply(t('replies.notAllowed', { CLINIC_PHONE: clinicPhone }));
    else if (e.code === 'OFFER_TAKEN' || e.code === 'SLOT_TAKEN') await reply(t('replies.offerTaken'));
    else await reply(t('replies.unavailable', { CLINIC_PHONE: clinicPhone }));
    return { action: 'rejected', error: e.code };
  }
}
