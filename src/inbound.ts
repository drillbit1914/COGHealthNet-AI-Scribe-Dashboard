import { audit } from './audit.js';
import { acceptAlternate, reschedule } from './appointments.js';
import type { Ctx } from './ctx.js';
import { AppError } from './errors.js';
import { claimOffer } from './waitlist.js';

export interface Inbound {
  channel: 'WHATSAPP' | 'SMS'; from: string; providerMessageId?: string;
  text?: string; buttonPayload?: string; mediaId?: string;
}

/**
 * Inbound replies (PRD §7). Buttons act only for can_book guardians (authorization is enforced inside
 * each service). Free text or images become a payment proof on the latest unpaid visit — never auto-paid.
 */
export async function handleInbound(ctx: Ctx, m: Inbound): Promise<{ action: string; error?: string }> {
  const from = m.from.startsWith('+') ? m.from : '+' + m.from;
  const g = (await ctx.db.query('SELECT * FROM guardian WHERE phone_e164 = $1', [from])).rows[0];
  await ctx.db.query(
    `INSERT INTO message (guardian_id, channel, to_phone, provider_message_id, status, direction, body, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'RECEIVED','IN',$5,$6,$6)`,
    [g?.id ?? null, m.channel, from, m.providerMessageId ?? null, m.buttonPayload ?? m.text ?? (m.mediaId ? '[media]' : null), ctx.now()]);
  if (!g) return { action: 'ignored_unknown_sender' };
  const actor = { type: 'GUARDIAN' as const, id: g.id };
  const word = m.text?.trim().toUpperCase();

  if (!m.buttonPayload && word === 'YES') {
    await ctx.db.query('UPDATE guardian SET whatsapp_opt_in_at = COALESCE(whatsapp_opt_in_at, $2), sms_opt_out_at = NULL WHERE id = $1', [g.id, ctx.now()]);
    await audit(ctx.db, actor, 'whatsapp_opt_in', 'guardian', g.id);
    return { action: 'opt_in' };
  }
  if (!m.buttonPayload && (word === 'STOP' || word === 'UNSUBSCRIBE')) {
    await ctx.db.query(`UPDATE guardian SET ${m.channel === 'SMS' ? 'sms_opt_out_at' : 'whatsapp_opt_in_at'} = $2 WHERE id = $1`,
      [g.id, m.channel === 'SMS' ? ctx.now() : null]);
    await audit(ctx.db, actor, 'opt_out', 'guardian', g.id, null, { channel: m.channel });
    return { action: 'opt_out' };
  }

  if (m.buttonPayload) {
    const [kind, id] = m.buttonPayload.split(':');
    try {
      if (kind === 'ACCEPT') { await acceptAlternate(ctx, g.id, id); return { action: 'accepted' }; }
      if (kind === 'CLAIM') { await claimOffer(ctx, g.id, id); return { action: 'claimed' }; }
      if (kind === 'ATTEND') { await audit(ctx.db, actor, 'attendance_confirmed', 'appointment', id); return { action: 'attend_ack' }; }
      // VIEW / RESCHEDULE / CHOOSE_OTHER open the booking site; nothing changes server-side.
      return { action: 'link_only' };
    } catch (e) {
      return { action: 'rejected', error: e instanceof AppError ? e.code : String(e) };
    }
  }

  if (m.text || m.mediaId) {
    const a = (await ctx.db.query(
      `SELECT a.id FROM appointment a JOIN guardian_patient gp ON gp.patient_id = a.patient_id
        WHERE gp.guardian_id = $1 AND NOT gp.restricted AND a.payment_status = 'UNPAID'
          AND a.status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED')
        ORDER BY a.created_at DESC LIMIT 1`, [g.id])).rows[0];
    if (!a) return { action: 'no_unpaid_appointment' };
    await ctx.db.query('INSERT INTO payment_proof (appointment_id, guardian_id, text, file_key, received_at) VALUES ($1,$2,$3,$4,$5)',
      [a.id, g.id, m.text ?? null, m.mediaId ? `whatsapp-media/${m.mediaId}` : null, ctx.now()]);
    return { action: 'payment_proof' };
  }
  return { action: 'ignored' };
}

export { reschedule };
