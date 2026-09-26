/**
 * Clinic-time helpers. Everything is stored in UTC; clinic-local wall time is derived
 * via Intl with the configured IANA zone, so the server/device timezone never matters (AC 14).
 */
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; weekday: number }
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date: Date, tz: string): LocalParts {
  const p = Object.fromEntries(partsFmt(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, weekday: WD[p.weekday] };
}

/** Offset (minutes) of tz from UTC at the given instant, e.g. −240 for AST. */
export function tzOffsetMin(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/** Convert a clinic-local wall time (YYYY-MM-DD + minutes since midnight) to a UTC Date. */
export function localToUtc(dateStr: string, minutes: number, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, minutes));
  const off = tzOffsetMin(guess, tz);
  const out = new Date(guess.getTime() - off * 60000);
  const off2 = tzOffsetMin(out, tz); // correct across a DST edge (not needed for AST, kept for portability)
  return off2 === off ? out : new Date(guess.getTime() - off2 * 60000);
}

export const localDateStr = (date: Date, tz: string) => {
  const p = localParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const weekdayOf = (dateStr: string) => new Date(dateStr + 'T12:00:00Z').getUTCDay();

export const timeToMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export function fmtDay(date: Date, tz: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(date);
}
export function fmtDate(date: Date, tz: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}
export function fmtTime(date: Date, tz: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date);
}
