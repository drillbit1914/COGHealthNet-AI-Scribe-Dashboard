import type { Queryable } from './db';

/** Every {{CONFIG}} value from the PRD. Stored as JSON in clinic_settings (single row). */
export interface ClinicSettings {
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
  ADMIN_ALERT_PHONES: string[];
  CONSENT_VERSION: string;
  CANCELLATION_POLICY: string;
}

export const DEFAULT_SETTINGS: ClinicSettings = {
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
  ACCOUNT_NAME: 'Wellness Ave.',
  NCBA_ACCOUNT_NO: '6001232',
  CLINIC_PHONE: '+1 786 942 0603',
  ADMIN_ALERT_PHONES: ['+17869420603'],
  CONSENT_VERSION: '2026-01',
  CANCELLATION_POLICY: 'Please cancel or reschedule at least 24 hours before your visit.',
};

export async function getSettings(db: Queryable): Promise<ClinicSettings> {
  const row = await db.clinicSettings.findUnique({ where: { id: 1 } });
  return { ...DEFAULT_SETTINGS, ...((row?.settings as Partial<ClinicSettings>) ?? {}) };
}

export { appBaseUrl } from './env';
import { appBaseUrl } from './env';
export const bookingLink = () => `${appBaseUrl()}/book`;
export const adminLink = () => `${appBaseUrl()}/admin`;
