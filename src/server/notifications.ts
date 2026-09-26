import { t, type Vars } from '@/i18n';
import { firstName } from './authz';
import { exec, q, type Queryable } from './db';
import { renderBody, TEMPLATES, type Button, type TemplateKey } from './messaging/templates';
import { adminLink, bookingLink, getSettings, type ClinicSettings } from './settings';
import { fmtDate, fmtDay, fmtTime } from './time';

export interface Recipient {
  guardian_id: string;
  name: string | null;
  phone_e164: string;
  can_book: boolean;
}

/** PRD §7 fan-out: linked, receives_notifications = true AND restricted = false. */
export function recipientsFor(db: Queryable, patientId: string) {
  return q<Recipient>(
    db,
    `SELECT g.id guardian_id, g.name, g.phone_e164, gp.can_book
       FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id
      WHERE gp.patient_id = $1::uuid AND gp.receives_notifications AND NOT gp.restricted AND g.merged_into_id IS NULL
      ORDER BY gp.can_book DESC, g.created_at`,
    patientId,
  );
}

export const settingsVars = (s: ClinicSettings): Vars => ({
  ACCOUNT_NAME: s.ACCOUNT_NAME,
  NCBA_ACCOUNT_NO: s.NCBA_ACCOUNT_NO,
  CLINIC_PHONE: s.CLINIC_PHONE,
  link: bookingLink(),
  admin_link: adminLink(),
});

/** Name, visit type, date/time, provider — nothing else (PRD §13: no health details in messages). */
export async function appointmentVars(db: Queryable, apptId: string, s: ClinicSettings) {
  const [a] = await q(
    db,
    `SELECT a.id, a.ref, a.patient_id, a.visit_type::text, a.starts_at, a.decline_reason, a.cancel_reason,
            p.full_name child, pr.name provider
       FROM appointment a JOIN patient p ON p.id = a.patient_id JOIN provider pr ON pr.id = a.provider_id
      WHERE a.id = $1::uuid`,
    apptId,
  );
  const tz = s.TIMEZONE;
  const when = { day: fmtDay(a.starts_at, tz), date: fmtDate(a.starts_at, tz), time: fmtTime(a.starts_at, tz) };
  return {
    patient_id: a.patient_id as string,
    vars: {
      ...settingsVars(s),
      appointment_id: a.id,
      ref: a.ref,
      child: firstName(a.child),
      visit_type: t(`visitType.${a.visit_type}`),
      provider: a.provider,
      ...when,
      new_day: when.day,
      new_date: when.date,
      new_time: when.time,
      reason: a.decline_reason ?? a.cancel_reason ?? '',
    } as Vars,
  };
}

interface Enqueue {
  key: TemplateKey;
  vars: Vars;
  toPhone: string;
  guardianId?: string | null;
  providerId?: string | null;
  appointmentId?: string | null;
  buttons?: Button[];
  smsOnly?: boolean;
  now: Date;
}

/** Outbox insert (status PENDING). Runs inside the caller's transaction; the outbox worker sends. */
export async function enqueue(db: Queryable, m: Enqueue) {
  await exec(
    db,
    `INSERT INTO message (guardian_id, provider_id, appointment_id, template_key, to_phone, status, direction, body, vars,
                          buttons, sms_only, next_attempt_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'PENDING', 'OUT', $6, $7::jsonb, $8::jsonb, $9, $10, $10, $10)`,
    m.guardianId ?? null,
    m.providerId ?? null,
    m.appointmentId ?? null,
    m.key,
    m.toPhone,
    renderBody(m.key, m.vars),
    JSON.stringify(m.vars),
    JSON.stringify(m.buttons ?? []),
    m.smsOnly ?? false,
    m.now,
  );
}

/** One message per eligible guardian; action buttons only for can_book guardians (PRD §7, AC 6). */
export async function enqueueForAppointment(
  db: Queryable,
  apptId: string,
  key: TemplateKey,
  now: Date,
  extra: Vars = {},
) {
  const s = await getSettings(db);
  const { patient_id, vars } = await appointmentVars(db, apptId, s);
  const all = { ...vars, ...extra };
  for (const r of await recipientsFor(db, patient_id)) {
    await enqueueToGuardian(db, r, key, all, apptId, now);
  }
}

export async function enqueueToGuardian(
  db: Queryable,
  r: Recipient,
  key: TemplateKey,
  vars: Vars,
  apptId: string | null,
  now: Date,
  opts: { smsOnly?: boolean } = {},
) {
  const v = { ...vars, guardian: r.name ?? 'there' };
  await enqueue(db, {
    key,
    vars: v,
    toPhone: r.phone_e164,
    guardianId: r.guardian_id,
    appointmentId: apptId,
    buttons: r.can_book ? (TEMPLATES[key].buttons?.(v) ?? []) : [],
    smsOnly: opts.smsOnly,
    now,
  });
}

/** Staff alerts (S1, S2) go to every admin alert phone. */
export async function enqueueAdminAlert(db: Queryable, key: TemplateKey, vars: Vars, now: Date, apptId?: string) {
  const s = await getSettings(db);
  for (const phone of s.ADMIN_ALERT_PHONES) {
    await enqueue(db, { key, vars: { ...settingsVars(s), ...vars }, toPhone: phone, appointmentId: apptId, now });
  }
}
