/** Parent read model and non-appointment writes. Every query is scoped by guardian link + restricted = false. */
import { z } from 'zod';
import { t } from '@/i18n';
import { audit, type Actor } from './audit';
import { appointmentForGuardian, firstName, linkFor, requireCanBook } from './authz';
import type { Ctx } from './context';
import { exec, q } from './db';
import { badRequest } from './errors';
import { buildIcs } from './ics';
import { getSettings } from './settings';
import { fmtDate, fmtDay, fmtTime } from './time';

/** Provider names are only revealed once a visit is CONFIRMED (CLAUDE.md rule). */
const PROVIDER_VISIBLE = ['CONFIRMED', 'COMPLETED', 'NO_SHOW'];

export async function getMe(ctx: Ctx, guardianId: string) {
  const s = await getSettings(ctx.db);
  const g = await ctx.db.guardian.findUniqueOrThrow({
    where: { id: guardianId },
    select: { id: true, name: true, phoneE164: true, whatsappOptInAt: true },
  });
  const kids = await q(
    ctx.db,
    `SELECT p.id, p.full_name, p.dob, gp.can_book, gp.relationship
       FROM guardian_patient gp JOIN patient p ON p.id = gp.patient_id
      WHERE gp.guardian_id = $1::uuid AND NOT gp.restricted AND p.merged_into_id IS NULL ORDER BY p.full_name`,
    guardianId,
  );
  return {
    guardian: { id: g.id, name: g.name, phone: g.phoneE164, whatsapp: !!g.whatsappOptInAt },
    children: kids.map((k) => ({
      id: k.id as string,
      name: k.full_name as string,
      dob: k.dob ? (k.dob as Date).toISOString().slice(0, 10) : null,
      canBook: k.can_book as boolean,
      notice: k.can_book
        ? null
        : t('errors.notifyOnlyCannotBook', { child: firstName(k.full_name), CLINIC_PHONE: s.CLINIC_PHONE }),
    })),
    clinicPhone: s.CLINIC_PHONE,
    cancelCutoffHours: s.CANCEL_CUTOFF_HOURS,
  };
}

export async function updateName(ctx: Ctx, guardianId: string, raw: unknown) {
  const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(raw);
  const before = await ctx.db.guardian.findUniqueOrThrow({ where: { id: guardianId }, select: { name: true } });
  await ctx.db.guardian.update({ where: { id: guardianId }, data: { name } });
  await audit(ctx.db, { type: 'GUARDIAN', id: guardianId }, 'update', 'guardian', guardianId, before, { name });
  return { ok: true };
}

export async function listAppointments(ctx: Ctx, guardianId: string, patientId: string) {
  const link = await linkFor(ctx.db, guardianId, patientId);
  const s = await getSettings(ctx.db);
  const tz = s.TIMEZONE;
  const rows = await q(
    ctx.db,
    `SELECT a.id, a.ref, a.visit_type::text, a.starts_at, a.ends_at, a.status::text, a.payment_status::text,
            a.original_starts_at, a.late_cancel, pr.name provider
       FROM appointment a JOIN provider pr ON pr.id = a.provider_id
      WHERE a.patient_id = $1::uuid AND a.status <> 'RESCHEDULED' ORDER BY a.starts_at DESC LIMIT 200`,
    patientId,
  );
  const now = ctx.now().getTime();
  const shape = (a: (typeof rows)[number]) => ({
    id: a.id as string,
    ref: a.ref as string,
    visitType: a.visit_type as 'FOLLOW_UP' | 'EVALUATION',
    startsAt: (a.starts_at as Date).toISOString(),
    when: `${fmtDay(a.starts_at, tz)} ${fmtDate(a.starts_at, tz)}, ${fmtTime(a.starts_at, tz)}`,
    status: a.status as string,
    paymentStatus: a.payment_status as string,
    provider: PROVIDER_VISIBLE.includes(a.status) ? (a.provider as string) : null,
    canChange: link.can_book && ['REQUESTED', 'CONFIRMED'].includes(a.status) && a.starts_at.getTime() > now,
    isLate: a.starts_at.getTime() - now < s.CANCEL_CUTOFF_HOURS * 3600000,
    alternatePending: a.status === 'ALTERNATE_PROPOSED' && link.can_book,
  });
  const upcoming = rows
    .filter((a) => a.starts_at.getTime() >= now && ['REQUESTED', 'ALTERNATE_PROPOSED', 'CONFIRMED'].includes(a.status))
    .reverse();
  const past = rows.filter((a) => !upcoming.includes(a));
  return {
    child: { id: patientId, name: link.full_name, canBook: link.can_book },
    upcoming: upcoming.map(shape),
    past: past.map(shape),
  };
}

export async function icsFor(ctx: Ctx, guardianId: string, apptId: string) {
  const a = await appointmentForGuardian(ctx.db, guardianId, apptId, false);
  const s = await getSettings(ctx.db);
  const [x] = await q(
    ctx.db,
    'SELECT p.full_name child, pr.name provider FROM patient p, provider pr WHERE p.id = $1::uuid AND pr.id = $2::uuid',
    a.patient_id,
    a.provider_id,
  );
  return {
    filename: `${a.ref}.ics`,
    body: buildIcs(
      {
        id: a.id,
        ref: a.ref,
        startsAt: a.starts_at,
        endsAt: a.ends_at,
        visitType: a.visit_type,
        child: firstName(x.child),
        provider: PROVIDER_VISIBLE.includes(a.status) ? x.provider : null,
      },
      s.CLINIC_PHONE,
      ctx.now(),
    ),
  };
}

export const WaitlistInput = z.object({
  patientId: z.uuid(),
  visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  window: z.enum(['ANY', 'MORNING', 'AFTERNOON']).default('ANY'),
});

export async function joinWaitlist(ctx: Ctx, guardianId: string, raw: unknown) {
  const w = WaitlistInput.parse(raw);
  await requireCanBook(ctx.db, guardianId, w.patientId);
  if (w.dateTo < w.dateFrom) throw badRequest(t('errors.invalidRange'));
  const [row] = await q(
    ctx.db,
    `INSERT INTO waitlist_entry (patient_id, guardian_id, visit_type, date_from, date_to, "window", created_at)
     VALUES ($1::uuid, $2::uuid, $3::visit_type, $4::date, $5::date, $6::waitlist_window, $7) RETURNING id`,
    w.patientId,
    guardianId,
    w.visitType,
    w.dateFrom,
    w.dateTo,
    w.window,
    ctx.now(),
  );
  await audit(ctx.db, { type: 'GUARDIAN', id: guardianId }, 'join', 'waitlist_entry', row.id, null, w);
  return { id: row.id as string };
}

export async function withdrawConsent(ctx: Ctx, guardianId: string, raw: unknown) {
  const b = z.object({ type: z.enum(['DATA_PROCESSING', 'MESSAGING']), patientId: z.uuid().optional() }).parse(raw);
  if (b.patientId) await linkFor(ctx.db, guardianId, b.patientId);
  await exec(
    ctx.db,
    `UPDATE consent SET withdrawn_at = $4 WHERE guardian_id = $1::uuid AND type = $2::consent_type
       AND ($3::uuid IS NULL OR patient_id = $3::uuid) AND withdrawn_at IS NULL`,
    guardianId,
    b.type,
    b.patientId ?? null,
    ctx.now(),
  );
  const actor: Actor = { type: 'GUARDIAN', id: guardianId };
  await audit(ctx.db, actor, 'withdraw_consent', 'consent', null, null, b);
  return { ok: true };
}
