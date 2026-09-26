import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * Clinic-time helpers. Timestamps are stored in UTC; clinic-local wall time comes from the configured
 * IANA zone, so the server's or device's timezone never matters (AC 14).
 */
export const localDateStr = (date: Date, tz: string) => formatInTimeZone(date, tz, 'yyyy-MM-dd');

export function localParts(date: Date, tz: string) {
  const [hh, mm, iso] = formatInTimeZone(date, tz, 'H m i').split(' ').map(Number);
  return { hh, mm, weekday: iso % 7 }; // 0 = Sunday … 6 = Saturday
}

/** Clinic-local YYYY-MM-DD + minutes since midnight → UTC instant. */
export function localToUtc(dateStr: string, minutes: number, tz: string): Date {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return fromZonedTime(`${dateStr}T${hh}:${mm}:00`, tz);
}

/** Calendar arithmetic on YYYY-MM-DD strings (timezone-free). */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const weekdayOf = (dateStr: string) => new Date(dateStr + 'T12:00:00Z').getUTCDay();
export const timeToMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export const fmtDay = (d: Date, tz: string) => formatInTimeZone(d, tz, 'EEEE');
export const fmtDate = (d: Date, tz: string) => formatInTimeZone(d, tz, 'd MMMM yyyy');
export const fmtTime = (d: Date, tz: string) => formatInTimeZone(d, tz, 'h:mm a');
export const fmtShortDate = (d: Date, tz: string) => formatInTimeZone(d, tz, 'EEE d MMM');
