import type { Queryable } from './db.js';

export interface ClinicSettings {
  CLINIC_NAME: string;
  TIMEZONE: string;
  CURRENCY: string;
  DEFAULT_COUNTRY_CODE: string;
  DEFAULT_AREA_CODE: string;
  SLOT_STEP_MIN: number;
  VISIT_DURATIONS_MIN: { FOLLOW_UP: number; EVALUATION: number };
  BUFFER_MIN: number;
  HORIZON_DAYS: number;
  MIN_NOTICE_HOURS: number;
  REQUEST_EXPIRY_HOURS: number;
  ALT_EXPIRY_HOURS: number;
  CANCEL_CUTOFF_HOURS: number;
  PROVIDER_CAN_APPROVE: boolean;
  EVAL_DISCIPLINE_MATCH: boolean;
  WAITLIST_OFFER_MAX: number;
  MESSAGE_RETENTION_MONTHS: number;
  PROVIDER_AGENDA_HOUR: number;
  ACCOUNT_NAME: string;
  NCBA_ACCOUNT_NO: string;
  CLINIC_PHONE: string;
  BOOKING_BASE_URL: string;
  ADMIN_BASE_URL: string;
  ADMIN_ALERT_PHONES: string[];
  CONSENT_VERSION: string;
}

export const DEFAULT_SETTINGS: ClinicSettings = {
  CLINIC_NAME: 'Wellness Ave',
  TIMEZONE: 'America/Anguilla',
  CURRENCY: 'XCD',
  DEFAULT_COUNTRY_CODE: '1',
  DEFAULT_AREA_CODE: '264',
  SLOT_STEP_MIN: 30,
  VISIT_DURATIONS_MIN: { FOLLOW_UP: 60, EVALUATION: 90 },
  BUFFER_MIN: 0,
  HORIZON_DAYS: 28,
  MIN_NOTICE_HOURS: 12,
  REQUEST_EXPIRY_HOURS: 24,
  ALT_EXPIRY_HOURS: 24,
  CANCEL_CUTOFF_HOURS: 24,
  PROVIDER_CAN_APPROVE: false,
  EVAL_DISCIPLINE_MATCH: false,
  WAITLIST_OFFER_MAX: 3,
  MESSAGE_RETENTION_MONTHS: 12,
  PROVIDER_AGENDA_HOUR: 7,
  ACCOUNT_NAME: 'SET ME',
  NCBA_ACCOUNT_NO: 'SET ME',
  CLINIC_PHONE: '+1264XXXXXXX',
  BOOKING_BASE_URL: 'https://book.example.com',
  ADMIN_BASE_URL: 'https://book.example.com/admin',
  ADMIN_ALERT_PHONES: [],
  CONSENT_VERSION: '2026-01',
};

export async function getSettings(db: Queryable): Promise<ClinicSettings> {
  const r = await db.query('SELECT settings FROM clinic_settings WHERE id = 1');
  return { ...DEFAULT_SETTINGS, ...(r.rows[0]?.settings ?? {}) };
}
