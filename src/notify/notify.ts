import type { Ctx } from '../ctx.js';
import type { Queryable } from '../db.js';
import { BUTTONS, STRINGS, TEMPLATES, VISIT_LABEL, render, templateParams, type Button, type TemplateKey, type Vars } from '../i18n/en.js';
import { getSettings, type ClinicSettings } from '../settings.js';
import { fmtDate, fmtDay, fmtTime } from '../time.js';

export interface Recipient {
  guardian_id: string; name: string | null; phone_e164: string; can_book: boolean;
  whatsapp_opt_in_at: Date | null; sms_opt_out_at: Date | null;
}

/** PRD §7 fan-out: linked, receives_notifications = true AND restricted = false. */
export async function recipientsFor(q: Queryable, patientId: string): Promise<Recipient[]> {
  const r = await q.query(
    `SELECT g.id guardian_id, g.name, g.phone_e164, gp.can_book, g.whatsapp_opt_in_at, g.sms_opt_out_at
       FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id
      WHERE gp.patient_id = $1 AND gp.receives_notifications AND NOT gp.restricted AND g.merged_into_id IS NULL
      ORDER BY gp.can_book DESC, g.created_at`,
    [patientId],
  );
  return r.rows;
}

/** Template variables for an appointment. Only name, visit type, time, provider — no health details (PRD §13). */
export async function appointmentVars(q: Queryable, apptId: string, s: ClinicSettings): Promise<Vars & { patient_id: string }> {
  const r = await q.query(
    `SELECT a.*, p.full_name child, pr.name provider FROM appointment a
       JOIN patient p ON p.id = a.patient_id JOIN provider pr ON pr.id = a.provider_id WHERE a.id = $1`,
    [apptId],
  );
  const a = r.rows[0];
  const tz = s.TIMEZONE;
  return {
    patient_id: a.patient_id, appointment_id: a.id, ref: a.ref, child: firstName(a.child),
    visit_type: VISIT_LABEL[a.visit_type as keyof typeof VISIT_LABEL], provider: a.provider,
    day: fmtDay(a.starts_at, tz), date: fmtDate(a.starts_at, tz), time: fmtTime(a.starts_at, tz),
    new_day: fmtDay(a.starts_at, tz), new_date: fmtDate(a.starts_at, tz), new_time: fmtTime(a.starts_at, tz),
    reason: a.decline_reason ?? a.cancel_reason ?? '',
    ...settingsVars(s),
  };
}

const firstName = (full: string) => full.trim().split(/\s+/)[0];

export const settingsVars = (s: ClinicSettings): Vars => ({
  clinic: s.CLINIC_NAME, ACCOUNT_NAME: s.ACCOUNT_NAME, NCBA_ACCOUNT_NO: s.NCBA_ACCOUNT_NO,
  CLINIC_PHONE: s.CLINIC_PHONE, link: s.BOOKING_BASE_URL, admin_link: s.ADMIN_BASE_URL,
});

/** Send one templated message to each notified guardian of the appointment's child. */
export async function notifyAppointment(ctx: Ctx, apptId: string, key: TemplateKey, extra: Vars = {}) {
  const s = await getSettings(ctx.db);
  const vars = { ...(await appointmentVars(ctx.db, apptId, s)), ...extra };
  for (const g of await recipientsFor(ctx.db, vars.patient_id)) {
    await sendToGuardian(ctx, g, key, { ...vars, guardian: g.name ?? 'there' }, apptId);
  }
}

export async function sendToGuardian(ctx: Ctx, g: Recipient, key: TemplateKey, vars: Vars, apptId: string | null, forceSms = false) {
  const body = render(TEMPLATES[key], vars);
  const buttons: Button[] = g.can_book ? (BUTTONS[key]?.(vars) ?? []) : [];
  const useWa = !forceSms && !!g.whatsapp_opt_in_at;
  if (!useWa && g.sms_opt_out_at) {
    await logMessage(ctx, { guardian_id: g.guardian_id, appointment_id: apptId, template_key: key, channel: 'SMS',
      to_phone: g.phone_e164, status: 'SKIPPED', error: 'SMS opt-out', body });
    return;
  }
  await deliver(ctx, { guardianId: g.guardian_id, apptId, key, to: g.phone_e164, body, buttons, vars, whatsapp: useWa });
}

/** Staff/provider alerts (S1–S3). */
export async function sendStaff(ctx: Ctx, to: string, key: TemplateKey, vars: Vars, opts: { providerId?: string; apptId?: string } = {}) {
  const body = render(TEMPLATES[key], vars);
  await deliver(ctx, { apptId: opts.apptId ?? null, providerId: opts.providerId, key, to, body, buttons: [], vars, whatsapp: true });
}

interface DeliverArgs {
  guardianId?: string; providerId?: string; apptId: string | null; key: TemplateKey; to: string;
  body: string; buttons: Button[]; vars: Vars; whatsapp: boolean;
}

/** Sends one message; a WhatsApp API error falls back to SMS immediately (PRD §7, AC 8). */
export async function deliver(ctx: Ctx, m: DeliverArgs) {
  const base = { guardian_id: m.guardianId ?? null, provider_id: m.providerId ?? null, appointment_id: m.apptId,
    template_key: m.key, to_phone: m.to };
  if (m.whatsapp) {
    try {
      const { id } = await ctx.messenger.sendWhatsApp({ to: m.to, templateKey: m.key, params: templateParams(m.key, m.vars),
        body: m.body, buttons: m.buttons });
      await logMessage(ctx, { ...base, channel: 'WHATSAPP', provider_message_id: id, status: 'SENT', body: m.body, buttons: m.buttons });
      return;
    } catch (e) {
      const failed = await logMessage(ctx, { ...base, channel: 'WHATSAPP', status: 'FAILED', error: String((e as Error).message), body: m.body, buttons: m.buttons });
      await sendSmsLogged(ctx, base, smsBody(m), failed);
      return;
    }
  }
  await sendSmsLogged(ctx, base, smsBody(m), null);
}

/** SMS has no buttons; can_book recipients get a link to the booking site instead. */
const smsBody = (m: Pick<DeliverArgs, 'body' | 'buttons' | 'vars'>) =>
  m.buttons.length ? m.body + render(STRINGS.smsManageSuffix, m.vars) : m.body;

async function sendSmsLogged(ctx: Ctx, base: Record<string, unknown>, body: string, fallbackOf: string | null) {
  try {
    const { id } = await ctx.messenger.sendSms(base.to_phone as string, body);
    await logMessage(ctx, { ...base, channel: 'SMS', provider_message_id: id, status: 'SENT', body, fallback_of_id: fallbackOf });
  } catch (e) {
    await logMessage(ctx, { ...base, channel: 'SMS', status: 'FAILED', error: String((e as Error).message), body, fallback_of_id: fallbackOf });
  }
}

async function logMessage(ctx: Ctx, m: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(m);
  const vals = cols.map((c) => (c === 'buttons' ? JSON.stringify(m[c]) : m[c]));
  const r = await ctx.db.query(
    `INSERT INTO message (direction, created_at, updated_at, ${cols.join(',')})
     VALUES ('OUT', $1, $1, ${cols.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`,
    [ctx.now(), ...vals],
  );
  return r.rows[0].id;
}

/**
 * Delivery-status webhook (WhatsApp or Twilio). A WhatsApp "failed" status triggers an SMS resend
 * exactly once (AC 8).
 */
export async function handleDeliveryStatus(ctx: Ctx, providerMessageId: string, status: string, error?: string) {
  const r = await ctx.db.query(
    `UPDATE message SET status = $2, error = COALESCE($3, error), updated_at = $4
      WHERE provider_message_id = $1 AND direction = 'OUT' RETURNING *`,
    [providerMessageId, status.toUpperCase(), error ?? null, ctx.now()],
  );
  const msg = r.rows[0];
  if (!msg || msg.channel !== 'WHATSAPP' || msg.status !== 'FAILED') return;
  const already = await ctx.db.query('SELECT 1 FROM message WHERE fallback_of_id = $1', [msg.id]);
  if (already.rowCount) return;
  const sms = msg.buttons?.length ? msg.body + render(STRINGS.smsManageSuffix, { link: (await getSettings(ctx.db)).BOOKING_BASE_URL }) : msg.body;
  await sendSmsLogged(ctx, { guardian_id: msg.guardian_id, provider_id: msg.provider_id, appointment_id: msg.appointment_id,
    template_key: msg.template_key, to_phone: msg.to_phone }, sms, msg.id);
}
