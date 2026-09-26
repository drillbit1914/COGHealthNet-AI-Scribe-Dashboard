import { t } from '@/i18n';

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const esc = (s: string) => s.replace(/[\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');

/** Add-to-calendar (PRD §10.8). Brand: ORGANIZER / calendar name "Wellness Ave". UTC times. */
export function buildIcs(
  a: {
    id: string;
    ref: string;
    startsAt: Date;
    endsAt: Date;
    visitType: 'FOLLOW_UP' | 'EVALUATION';
    child: string;
    provider?: string | null;
  },
  clinicPhone: string,
  now = new Date(),
) {
  const clinic = t('brand.clinic');
  const title = `${a.child} — ${t(`visitTypeTitle.${a.visitType}`)} at ${clinic}`;
  const desc = `Ref ${a.ref}${a.provider ? ` with ${a.provider}` : ''}. ${clinic}: ${clinicPhone}`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wellness Ave//Wellness Ave Scheduling//EN',
    `X-WR-CALNAME:${clinic}`,
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${a.id}@wellnessave`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(a.startsAt)}`,
    `DTEND:${stamp(a.endsAt)}`,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(desc)}`,
    `ORGANIZER;CN=${clinic}:mailto:noreply@wellnessave.invalid`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
