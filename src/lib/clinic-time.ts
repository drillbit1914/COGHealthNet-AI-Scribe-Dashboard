import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** Browser-side clinic time: always the clinic's zone, never the device's (AC 14). */
export const fmtIn = (d: Date | string, tz: string, pattern: string) => formatInTimeZone(new Date(d), tz, pattern);
export const fmtWhen = (d: Date | string, tz: string) => fmtIn(d, tz, 'EEE d MMM yyyy, h:mm a');
export const fmtTimeOnly = (d: Date | string, tz: string) => fmtIn(d, tz, 'h:mm a');
export const dayOf = (d: Date | string, tz: string) => fmtIn(d, tz, 'yyyy-MM-dd');
/** Clinic-local date + "HH:MM" → UTC ISO string. */
export const clinicToIso = (date: string, time: string, tz: string) =>
  fromZonedTime(`${date}T${time}:00`, tz).toISOString();
export function addDaysStr(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const weekdayOfStr = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay();
