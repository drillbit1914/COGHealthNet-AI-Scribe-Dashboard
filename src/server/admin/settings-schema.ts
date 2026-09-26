import { z } from 'zod';

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +12645551234');
const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Every clinic_settings value with its allowed range. Unknown keys are rejected. */
export const SettingsPatch = z
  .object({
    TIMEZONE: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown timezone'),
    CURRENCY: z.string().regex(/^[A-Z]{3}$/),
    DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/),
    DEFAULT_AREA_CODE: z.string().regex(/^\d{3}$/),
    SLOT_STEP_MIN: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
    VISIT_DURATIONS_MIN: z.object({ FOLLOW_UP: int(15, 240), EVALUATION: int(15, 240) }),
    BUFFER_MIN: int(0, 60),
    HORIZON_DAYS: int(1, 180),
    MIN_NOTICE_HOURS: int(0, 168),
    REQUEST_EXPIRY_HOURS: int(1, 168),
    ALT_EXPIRY_HOURS: int(1, 168),
    CANCEL_CUTOFF_HOURS: int(0, 168),
    PROVIDER_CAN_APPROVE: z.boolean(),
    EVAL_DISCIPLINE_MATCH: z.boolean(),
    WAITLIST_OFFER_MAX: int(1, 10),
    MESSAGE_RETENTION_MONTHS: int(1, 120),
    PROVIDER_AGENDA_HOUR: int(0, 23),
    ACCOUNT_NAME: z.string().trim().min(1).max(120),
    NCBA_ACCOUNT_NO: z.string().trim().min(1).max(40),
    CLINIC_PHONE: z.string().trim().min(7).max(30),
    ADMIN_ALERT_PHONES: z.array(e164).max(10),
    CONSENT_VERSION: z.string().trim().min(1).max(20),
    CANCELLATION_POLICY: z.string().trim().min(1).max(500),
  })
  .partial()
  .strict();

export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** Field metadata for the settings editor (label + input kind), in display order. */
export const SETTINGS_FIELDS: {
  key: keyof SettingsPatch;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'phones' | 'durations' | 'textarea';
  help?: string;
}[] = [
  { key: 'CLINIC_PHONE', label: 'Clinic phone', kind: 'text' },
  {
    key: 'ACCOUNT_NAME',
    label: 'NCBA account name',
    kind: 'text',
    help: 'Must match the notice posted at the clinic.',
  },
  {
    key: 'NCBA_ACCOUNT_NO',
    label: 'NCBA account number',
    kind: 'text',
    help: 'Sent only in T1. Must match the notice posted at the clinic.',
  },
  { key: 'ADMIN_ALERT_PHONES', label: 'Admin alert phones (S1, S2)', kind: 'phones', help: 'One per line, +1264…' },
  { key: 'VISIT_DURATIONS_MIN', label: 'Visit durations (minutes)', kind: 'durations' },
  { key: 'SLOT_STEP_MIN', label: 'Start-time grid (minutes)', kind: 'number' },
  { key: 'BUFFER_MIN', label: 'Buffer between visits (minutes)', kind: 'number' },
  { key: 'HORIZON_DAYS', label: 'Booking horizon (days)', kind: 'number' },
  { key: 'MIN_NOTICE_HOURS', label: 'Minimum notice (hours)', kind: 'number' },
  { key: 'REQUEST_EXPIRY_HOURS', label: 'Request expiry (hours)', kind: 'number', help: 'Escalation alert at 50%.' },
  { key: 'ALT_EXPIRY_HOURS', label: 'Alternate offer expiry (hours)', kind: 'number' },
  { key: 'CANCEL_CUTOFF_HOURS', label: 'Cancellation cutoff (hours)', kind: 'number' },
  { key: 'CANCELLATION_POLICY', label: 'Cancellation policy wording', kind: 'textarea' },
  { key: 'WAITLIST_OFFER_MAX', label: 'Waitlist offers per freed slot', kind: 'number' },
  { key: 'PROVIDER_AGENDA_HOUR', label: 'Provider agenda hour (AST)', kind: 'number' },
  { key: 'PROVIDER_CAN_APPROVE', label: 'Providers can approve requests', kind: 'boolean' },
  { key: 'EVAL_DISCIPLINE_MATCH', label: 'Show OT/PT discipline when reassigning evaluations', kind: 'boolean' },
  { key: 'MESSAGE_RETENTION_MONTHS', label: 'Message body retention (months)', kind: 'number' },
  {
    key: 'CONSENT_VERSION',
    label: 'Consent version',
    kind: 'text',
    help: 'Changing it asks every guardian to consent again.',
  },
  { key: 'TIMEZONE', label: 'Timezone', kind: 'text' },
  { key: 'CURRENCY', label: 'Currency', kind: 'text' },
  { key: 'DEFAULT_COUNTRY_CODE', label: 'Default country code', kind: 'text' },
  { key: 'DEFAULT_AREA_CODE', label: 'Default area code', kind: 'text' },
];
