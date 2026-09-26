import type { ClinicSettings } from './settings.js';

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (t: string) => t.replace(/[\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');

/** Add-to-calendar file (PRD §10.8). UTC timestamps render correctly in any calendar app. */
export function buildIcs(a: { id: string; ref: string; starts_at: Date; ends_at: Date; visit_type: string; child: string; provider?: string | null },
  s: ClinicSettings, now = new Date()) {
  const title = `${a.child} — ${a.visit_type === 'EVALUATION' ? 'Evaluation' : 'Follow-up'} (${s.CLINIC_NAME})`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wellness Ave//Scheduling//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${a.id}@wellness-ave`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(a.starts_at)}`, `DTEND:${stamp(a.ends_at)}`,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(`Ref ${a.ref}${a.provider ? ` with ${a.provider}` : ''}. Clinic: ${s.CLINIC_PHONE}`)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
