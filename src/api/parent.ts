import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { acceptAlternate, cancelByParent, declineAlternate, reschedule } from '../appointments.js';
import { audit } from '../audit.js';
import { endSession, requestOtp, staffLogin, verifyOtp, PARENT_SESSION_MS, STAFF_SESSION_MS } from '../auth.js';
import { appointmentForGuardian, linkFor } from '../authz.js';
import { computeSlots, VISIT_TYPES } from '../availability.js';
import { createRequest } from '../booking.js';
import { badRequest } from '../errors.js';
import { STRINGS, render } from '../i18n/en.js';
import { buildIcs } from '../ics.js';
import { getSettings } from '../settings.js';
import { ALLOWED_UPLOADS, MAX_UPLOAD_BYTES } from '../storage.js';
import { fmtDate, fmtDay, fmtTime, localDateStr } from '../time.js';
import { claimOffer, joinWaitlist } from '../waitlist.js';
import { guardianId, SESSION_COOKIE, type AppDeps } from './app.js';

/** Parent-facing API. Every patient/appointment lookup goes through authz (AC 7, AC 11). */
export const parentRoutes = (deps: AppDeps): FastifyPluginAsync => async (app) => {
  const { ctx } = deps;
  const setCookie = (reply: { setCookie: Function }, token: string, maxAgeMs: number) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: deps.secureCookies ?? true, sameSite: 'lax', path: '/', maxAge: maxAgeMs / 1000 });

  // ----- Sign in -----
  app.post('/auth/otp/request', async (req) => {
    const { phone } = z.object({ phone: z.string().min(7).max(20) }).parse(req.body);
    return requestOtp(ctx, phone);
  });
  app.post('/auth/otp/verify', async (req, reply) => {
    const { phone, code } = z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const { token, guardianId: id } = await verifyOtp(ctx, phone, code);
    setCookie(reply, token, PARENT_SESSION_MS);
    return { guardianId: id };
  });
  app.post('/auth/staff/login', async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string(), totp: z.string().optional() }).parse(req.body);
    const r = await staffLogin(ctx, b.email, b.password, b.totp);
    setCookie(reply, r.token, STAFF_SESSION_MS);
    return { role: r.role, providerId: r.providerId };
  });
  app.post('/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await endSession(ctx.db, t);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ----- Profile -----
  app.get('/me', async (req) => {
    const gid = guardianId(req);
    const g = (await ctx.db.query('SELECT id, name, phone_e164, whatsapp_opt_in_at FROM guardian WHERE id = $1', [gid])).rows[0];
    const kids = (await ctx.db.query(
      `SELECT p.id, p.full_name, p.dob, gp.can_book, gp.relationship FROM guardian_patient gp JOIN patient p ON p.id = gp.patient_id
        WHERE gp.guardian_id = $1 AND NOT gp.restricted AND p.merged_into_id IS NULL ORDER BY p.full_name`, [gid])).rows;
    const s = await getSettings(ctx.db);
    return {
      guardian: g,
      children: kids.map((k) => ({ ...k, notice: k.can_book ? null
        : render(STRINGS.notifyOnlyCannotBook, { child: k.full_name.split(' ')[0], CLINIC_PHONE: s.CLINIC_PHONE }) })),
    };
  });
  app.patch('/me', async (req) => {
    const gid = guardianId(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    await ctx.db.query('UPDATE guardian SET name = $2 WHERE id = $1', [gid, name]);
    await audit(ctx.db, { type: 'GUARDIAN', id: gid }, 'update', 'guardian', gid, null, { name });
    return { ok: true };
  });
  app.post('/me/consents/withdraw', async (req) => {
    const gid = guardianId(req);
    const b = z.object({ type: z.enum(['DATA_PROCESSING', 'MESSAGING']), patientId: z.string().uuid().optional() }).parse(req.body);
    if (b.patientId) await linkFor(ctx.db, gid, b.patientId);
    await ctx.db.query(`UPDATE consent SET withdrawn_at = $4 WHERE guardian_id = $1 AND type = $2 AND ($3::uuid IS NULL OR patient_id = $3) AND withdrawn_at IS NULL`,
      [gid, b.type, b.patientId ?? null, ctx.now()]);
    await audit(ctx.db, { type: 'GUARDIAN', id: gid }, 'withdraw_consent', 'consent', null, null, b);
    return { ok: true };
  });

  // ----- Availability: times only, never provider identities (PRD §4) -----
  app.get('/slots', async (req) => {
    const q = z.object({ visitType: z.enum(VISIT_TYPES as [string, ...string[]]), from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const s = await getSettings(ctx.db);
    const slots = await computeSlots(ctx.db, { visitType: q.visitType as never, now: ctx.now(), fromDate: q.from, toDate: q.to, settings: s });
    const days = new Map<string, { date: string; label: string; times: { startsAt: string; label: string }[] }>();
    for (const sl of slots) {
      const d = localDateStr(sl.startsAt, s.TIMEZONE);
      if (!days.has(d)) days.set(d, { date: d, label: `${fmtDay(sl.startsAt, s.TIMEZONE)} ${fmtDate(sl.startsAt, s.TIMEZONE)}`, times: [] });
      days.get(d)!.times.push({ startsAt: sl.startsAt.toISOString(), label: fmtTime(sl.startsAt, s.TIMEZONE) });
    }
    return { timezone: s.TIMEZONE, days: [...days.values()] };
  });

  // ----- Booking -----
  app.post('/uploads/referral', async (req) => {
    const gid = guardianId(req);
    const type = String(req.headers['content-type'] ?? '').split(';')[0];
    const ext = ALLOWED_UPLOADS[type];
    const body = req.body as Buffer;
    if (!ext || !Buffer.isBuffer(body)) throw badRequest('Upload a PDF, JPG or PNG');
    if (body.length > MAX_UPLOAD_BYTES) throw badRequest('File must be 10 MB or smaller');
    const key = `referrals/${crypto.randomUUID()}.${ext}`;
    await deps.storage.put(key, body, type);
    await audit(ctx.db, { type: 'GUARDIAN', id: gid }, 'upload', 'file', key);
    return { key };
  });
  app.post('/requests', async (req, reply) => {
    const gid = guardianId(req);
    const body = req.body as { evaluation?: { referralFileKey?: string } };
    const key = body?.evaluation?.referralFileKey;
    if (key) {
      const own = await ctx.db.query(`SELECT 1 FROM audit_log WHERE actor_id = $1 AND action = 'upload' AND entity_id = $2`, [gid, key]);
      if (!own.rowCount) throw badRequest('Unknown referral file');
    }
    const r = await createRequest(ctx, gid, req.body);
    const s = await getSettings(ctx.db);
    reply.status(201);
    return {
      ref: r.ref, appointmentId: r.appointmentId, status: r.status, visitType: r.visitType, startsAt: r.startsAt,
      when: `${fmtDay(r.startsAt, s.TIMEZONE)} ${fmtDate(r.startsAt, s.TIMEZONE)}, ${fmtTime(r.startsAt, s.TIMEZONE)}`,
      payment: r.visitType === 'FOLLOW_UP'
        ? { options: ['Cash at the clinic', 'Bank transfer to NCBA'], accountName: s.ACCOUNT_NAME, accountNo: s.NCBA_ACCOUNT_NO, reference: r.ref }
        : null,
      icsUrl: `/api/appointments/${r.appointmentId}/ics`,
      notice: STRINGS.neverNewBankDetails,
    };
  });

  // ----- Appointments -----
  app.get('/patients/:id/appointments', async (req) => {
    const gid = guardianId(req);
    const { id } = req.params as { id: string };
    const link = await linkFor(ctx.db, gid, id);
    const rows = (await ctx.db.query(
      `SELECT a.id, a.ref, a.visit_type, a.starts_at, a.ends_at, a.status, a.payment_status, a.original_starts_at,
              CASE WHEN a.status IN ('CONFIRMED','COMPLETED') THEN pr.name END provider
         FROM appointment a JOIN provider pr ON pr.id = a.provider_id
        WHERE a.patient_id = $1 ORDER BY a.starts_at DESC LIMIT 100`, [id])).rows;
    return { canBook: link.can_book, appointments: rows };
  });
  app.get('/appointments/:id/ics', async (req, reply) => {
    const gid = guardianId(req);
    const a = await appointmentForGuardian(ctx.db, gid, (req.params as { id: string }).id, false);
    const extra = (await ctx.db.query(`SELECT p.full_name child, pr.name provider FROM patient p, provider pr WHERE p.id = $1 AND pr.id = $2`,
      [a.patient_id, a.provider_id])).rows[0];
    const s = await getSettings(ctx.db);
    return reply.type('text/calendar').header('Content-Disposition', `attachment; filename="${a.ref}.ics"`)
      .send(buildIcs({ ...a, child: extra.child, provider: a.status === 'CONFIRMED' ? extra.provider : null }, s, ctx.now()));
  });
  app.post('/appointments/:id/cancel', async (req) => {
    await cancelByParent(ctx, guardianId(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/appointments/:id/reschedule', async (req) => {
    const { startsAt } = z.object({ startsAt: z.coerce.date() }).parse(req.body);
    return reschedule(ctx, { type: 'GUARDIAN', id: guardianId(req) }, (req.params as { id: string }).id, startsAt);
  });
  app.post('/appointments/:id/accept-alternate', async (req) => {
    await acceptAlternate(ctx, guardianId(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/appointments/:id/decline-alternate', async (req) => {
    await declineAlternate(ctx, guardianId(req), (req.params as { id: string }).id);
    return { ok: true };
  });

  // ----- Waitlist -----
  app.post('/waitlist', async (req, reply) => {
    const b = z.object({
      patientId: z.string().uuid(), visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      window: z.enum(['ANY', 'MORNING', 'AFTERNOON']).optional(),
    }).parse(req.body);
    reply.status(201);
    return { id: await joinWaitlist(ctx, guardianId(req), b) };
  });
  app.post('/waitlist/offers/:id/claim', async (req) => claimOffer(ctx, guardianId(req), (req.params as { id: string }).id));
};
