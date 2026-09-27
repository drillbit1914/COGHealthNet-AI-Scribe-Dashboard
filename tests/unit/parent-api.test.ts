import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as acceptAlt from '@/app/api/book/appointments/[id]/accept-alternate/route';
import * as cancelR from '@/app/api/book/appointments/[id]/cancel/route';
import * as declineAlt from '@/app/api/book/appointments/[id]/decline-alternate/route';
import * as ics from '@/app/api/book/appointments/[id]/ics/route';
import * as reschedR from '@/app/api/book/appointments/[id]/reschedule/route';
import * as withdraw from '@/app/api/book/consents/withdraw/route';
import * as me from '@/app/api/book/me/route';
import * as appts from '@/app/api/book/patients/[id]/appointments/route';
import * as requests from '@/app/api/book/requests/route';
import * as slots from '@/app/api/book/slots/route';
import * as upload from '@/app/api/book/uploads/referral/route';
import * as claim from '@/app/api/book/waitlist/offers/[id]/claim/route';
import * as waitlist from '@/app/api/book/waitlist/route';
import * as otpReq from '@/app/api/auth/otp/request/route';
import * as otpVerify from '@/app/api/auth/otp/verify/route';
import { cancel, confirm, proposeAlternate } from '@/server/appointments';
import { setRouteCtx } from '@/server/http';
import { LocalStorage, setStorage } from '@/server/storage';
import { ADMIN, at, child, FRI, SAT, setup, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(() => setStorage(new LocalStorage(path.join(os.tmpdir(), 'wav-test-files'))));
beforeEach(async () => {
  env = await setup();
  setRouteCtx(env.ctx);
});
afterAll(() => setRouteCtx(undefined));

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(
  h: Handler,
  o: {
    method?: string;
    path?: string;
    cookie?: string;
    body?: unknown;
    params?: Record<string, string>;
    raw?: { type: string; data: Buffer };
  },
) {
  const headers: Record<string, string> = {};
  if (o.cookie) headers.cookie = o.cookie;
  let body: BodyInit | undefined;
  if (o.raw) {
    headers['content-type'] = o.raw.type;
    body = new Uint8Array(o.raw.data);
  } else if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const req = new NextRequest(new URL(o.path ?? '/', 'http://localhost'), { method: o.method ?? 'GET', headers, body });
  const res = await h(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: json as any, text, headers: res.headers };
}

async function signIn(phone: string) {
  expect((await call(otpReq.POST, { method: 'POST', body: { phone } })).status).toBe(200);
  const msg = await env.db.message.findFirstOrThrow({ where: { templateKey: 'T0', toPhone: phone } });
  const code = msg.body!.match(/\d{6}/)![0];
  const r = await call(otpVerify.POST, { method: 'POST', body: { phone, code } });
  expect(r.status).toBe(200);
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const guardianId = (await env.db.guardian.findUniqueOrThrow({ where: { phoneE164: phone } })).id;
  return { cookie, guardianId };
}

const fuBody = (patientId: string, startsAt: Date) => ({
  visitType: 'FOLLOW_UP',
  startsAt: startsAt.toISOString(),
  patientId,
});

describe('parent sign-in (PRD §5 step 1, §13)', () => {
  it('OTP: local 7-digit number → +1-264; 5 codes/hour; lockout after 5 wrong codes', async () => {
    const r = await call(otpReq.POST, { method: 'POST', body: { phone: '235 1234' } });
    expect(r.json.phone).toBe('+12642351234');
    for (let i = 0; i < 4; i++) await call(otpReq.POST, { method: 'POST', body: { phone: '235 1234' } });
    expect((await call(otpReq.POST, { method: 'POST', body: { phone: '235 1234' } })).status).toBe(429);
    const real = (
      await env.db.message.findFirstOrThrow({ where: { templateKey: 'T0' }, orderBy: { createdAt: 'desc' } })
    ).body!.match(/\d{6}/)![0];
    const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++)
      expect(
        (await call(otpVerify.POST, { method: 'POST', body: { phone: '+12642351234', code: wrong } })).status,
      ).toBe(401);
    expect((await call(otpVerify.POST, { method: 'POST', body: { phone: '+12642351234', code: wrong } })).status).toBe(
      429,
    );
    expect((await call(otpVerify.POST, { method: 'POST', body: { phone: '+12642351234', code: real } })).status).toBe(
      429,
    );
    // Codes are stored hashed.
    const stored = await env.db.otpCode.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(stored.codeHash).not.toContain(real);
  });

  it('a session issued in the same second the guardian is created is valid (real clock)', async () => {
    env.clock.now = new Date();
    const p = await signIn('+12645550303');
    expect((await call(me.GET, { cookie: p.cookie })).status).toBe(200);
    // Revocation: sessions issued before sessions_valid_after are rejected.
    await env.db.guardian.update({
      where: { id: p.guardianId },
      data: { sessionsValidAfter: new Date(Date.now() + 1000) },
    });
    expect((await call(me.GET, { cookie: p.cookie })).status).toBe(401);
  });

  it('unauthenticated and tampered cookies are rejected', async () => {
    expect((await call(me.GET, {})).status).toBe(401);
    expect((await call(me.GET, { cookie: 'wellnessave_session=garbage' })).status).toBe(401);
  });
});

describe('booking flow via API', () => {
  it('new child follow-up with co-parent; response never names a provider', async () => {
    const p = await signIn('+12645551111');
    const s = await call(slots.GET, { path: `/?visitType=EVALUATION&from=${FRI}&to=${FRI}`, cookie: p.cookie });
    expect(s.json.days[0].times[0]).toEqual({ startsAt: '2026-10-02T12:00:00.000Z', label: '8:00 AM' });
    expect(s.text).not.toMatch(/Ana|Ben|Cara|Dev|provider/i);
    const r = await call(requests.POST, {
      method: 'POST',
      cookie: p.cookie,
      body: {
        visitType: 'FOLLOW_UP',
        startsAt: at(FRI, '09:00').toISOString(),
        patientName: 'Maya Richardson',
        consents: { dataProcessing: true, messaging: true },
        otherGuardian: { name: 'Dad', relationship: 'father', phone: '+1 721 555 0101', notify: true },
      },
    });
    expect(r.status).toBe(201);
    expect(r.json.ref).toMatch(/^WAV-[2-9A-HJ-NP-Z]{4}$/);
    expect(r.json.payment.reference).toBe(r.json.ref);
    expect(r.json.notice).toMatch(/never send you new bank details/);
    expect(r.text).not.toMatch(/Ana|Ben|Cara|Dev|providerId/);
    // Their messaging consent opts them in to WhatsApp; the co-parent stays on SMS until they reply YES.
    expect((await env.db.guardian.findUniqueOrThrow({ where: { id: p.guardianId } })).whatsappOptInAt).not.toBeNull();
    expect(
      (await env.db.guardian.findUniqueOrThrow({ where: { phoneE164: '+17215550101' } })).whatsappOptInAt,
    ).toBeNull();
    const meRes = await call(me.GET, { cookie: p.cookie });
    expect(meRes.json.children).toEqual([expect.objectContaining({ name: 'Maya Richardson', canBook: true })]);
    const list = await call(appts.GET, { cookie: p.cookie, params: { id: meRes.json.children[0].id } });
    expect(list.json.upcoming[0]).toMatchObject({ status: 'REQUESTED', provider: null });
    // Co-parent: notify-only link, T9 by SMS before any other message.
    const dad = await env.db.guardian.findUniqueOrThrow({
      where: { phoneE164: '+17215550101' },
      include: { links: true },
    });
    expect(dad.links[0]).toMatchObject({ canBook: false, receivesNotifications: true });
    const toDad = await env.db.message.findMany({ where: { guardianId: dad.id }, orderBy: { createdAt: 'asc' } });
    expect(toDad.map((m) => [m.templateKey, m.smsOnly])).toEqual([
      ['T9', true],
      ['T1', false],
    ]);
    // Provider revealed only after confirmation.
    await confirm(env.ctx, ADMIN, r.json.appointmentId);
    const after = await call(appts.GET, { cookie: p.cookie, params: { id: meRes.json.children[0].id } });
    expect(after.json.upcoming[0].provider).toBe('Ana');
    const cal = await call(ics.GET, { cookie: p.cookie, params: { id: r.json.appointmentId } });
    expect(cal.headers.get('content-type')).toMatch(/text\/calendar/);
    expect(cal.text).toContain('DTSTART:20261002T130000Z');
    expect(cal.text).toContain('SUMMARY:Maya — Follow-up at Wellness Ave');
    expect(cal.text).toContain('X-WR-CALNAME:Wellness Ave');
  });

  it('evaluation with insurance + referral upload; foreign referral keys are refused', async () => {
    const p = await signIn('+12645552222');
    const up = await call(upload.POST, {
      method: 'POST',
      cookie: p.cookie,
      raw: { type: 'application/pdf', data: Buffer.from('%PDF-1.4 test') },
    });
    expect(up.status).toBe(200);
    expect(
      (
        await call(upload.POST, {
          method: 'POST',
          cookie: p.cookie,
          raw: { type: 'text/plain', data: Buffer.from('x') },
        })
      ).status,
    ).toBe(400);
    const body = (key: string) => ({
      visitType: 'EVALUATION',
      startsAt: at(SAT, '09:00').toISOString(),
      patientName: 'Leo Brooks',
      dob: '2019-04-02',
      evaluation: {
        reasonText: 'Pencil grip',
        reasonTags: ['handwriting'],
        payerType: 'INSURANCE',
        insurer: 'NAGICO',
        memberNo: 'M-1',
        hasReferral: true,
        referralFileKey: key,
      },
      consents: { dataProcessing: true, messaging: true },
    });
    expect(
      (await call(requests.POST, { method: 'POST', cookie: p.cookie, body: body('referrals/someone-else/x.pdf') }))
        .status,
    ).toBe(400);
    const r = await call(requests.POST, { method: 'POST', cookie: p.cookie, body: body(up.json.key) });
    expect(r.status).toBe(201);
    expect(r.json.payment).toBeNull();
    const intake = await env.db.evaluationIntake.findUniqueOrThrow({ where: { appointmentId: r.json.appointmentId } });
    expect(intake).toMatchObject({ payerType: 'INSURANCE', hasReferral: true, referralFileKey: up.json.key });
    // Missing consents are rejected for a new child.
    const noConsent = {
      ...body(up.json.key),
      startsAt: at(SAT, '13:00').toISOString(),
      patientName: 'Other Kid',
      consents: undefined,
    };
    expect((await call(requests.POST, { method: 'POST', cookie: p.cookie, body: noConsent })).status).toBe(400);
  });

  it('SlotTakenError surfaces as 409 "That time was just taken"', async () => {
    await env.db.provider.updateMany({ where: { id: { not: env.providers[0] } }, data: { active: false } });
    const a = await signIn('+12645553333');
    const b = await signIn('+12645554444');
    const body = {
      visitType: 'FOLLOW_UP',
      startsAt: at(FRI, '10:00').toISOString(),
      patientName: 'Kid X',
      consents: { dataProcessing: true, messaging: true },
    };
    expect((await call(requests.POST, { method: 'POST', cookie: a.cookie, body })).status).toBe(201);
    const r = await call(requests.POST, { method: 'POST', cookie: b.cookie, body: { ...body, patientName: 'Kid Y' } });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'SLOT_TAKEN', message: expect.stringMatching(/That time was just taken/) });
  });
});

describe('AC 7 + AC 11 on every parent route', () => {
  it('cross-family access is 404 and notify-only writes are 403 on every route', async () => {
    const p = await signIn('+12645556666'); // primary for the shared child
    const co = await signIn('+12645557777'); // notify-only co-parent
    const stranger = await signIn('+12645558888'); // another family
    const kid = await child(env.db, 'Shared Kid', [{ g: p.guardianId, canBook: true }, { g: co.guardianId }]);
    const booked = (
      await call(requests.POST, { method: 'POST', cookie: p.cookie, body: fuBody(kid, at(SAT, '09:00')) })
    ).json;
    const other = (await call(requests.POST, { method: 'POST', cookie: p.cookie, body: fuBody(kid, at(SAT, '14:00')) }))
      .json;
    await proposeAlternate(env.ctx, ADMIN, other.appointmentId, at(SAT, '15:00'));
    const id = { id: booked.appointmentId };
    const alt = { id: other.appointmentId };

    // Reads: the co-parent can view; a stranger gets 404.
    for (const [h, params] of [
      [appts.GET, { id: kid }],
      [ics.GET, id],
    ] as const) {
      expect((await call(h, { cookie: co.cookie, params })).status).toBe(200);
      expect((await call(h, { cookie: stranger.cookie, params })).status).toBe(404);
    }
    const coMe = await call(me.GET, { cookie: co.cookie });
    expect(coMe.json.children[0]).toMatchObject({
      canBook: false,
      notice: expect.stringMatching(/Bookings for Shared are made by the primary contact/),
    });
    expect((await call(me.GET, { cookie: stranger.cookie })).json.children).toEqual([]);

    // Writes: notify-only → 403, stranger → 404, and nothing changed.
    const writes: [Handler, Record<string, string>, unknown][] = [
      [requests.POST, {}, fuBody(kid, at(FRI, '11:00'))],
      [cancelR.POST, id, {}],
      [reschedR.POST, id, { startsAt: at(FRI, '13:00').toISOString() }],
      [acceptAlt.POST, alt, {}],
      [declineAlt.POST, alt, {}],
      [waitlist.POST, {}, { patientId: kid, visitType: 'FOLLOW_UP', dateFrom: FRI, dateTo: SAT }],
    ];
    for (const [h, params, body] of writes) {
      expect((await call(h, { method: 'POST', cookie: co.cookie, params, body })).status, `notify-only ${h.name}`).toBe(
        403,
      );
      expect(
        (await call(h, { method: 'POST', cookie: stranger.cookie, params, body })).status,
        `stranger ${h.name}`,
      ).toBe(404);
    }
    expect(
      (
        await call(withdraw.POST, {
          method: 'POST',
          cookie: stranger.cookie,
          body: { type: 'MESSAGING', patientId: kid },
        })
      ).status,
    ).toBe(404);
    expect(await env.db.appointment.count({ where: { patientId: kid } })).toBe(2);
    expect((await env.db.appointment.findUniqueOrThrow({ where: { id: booked.appointmentId } })).status).toBe(
      'REQUESTED',
    );
    expect((await env.db.appointment.findUniqueOrThrow({ where: { id: other.appointmentId } })).status).toBe(
      'ALTERNATE_PROPOSED',
    );

    // Waitlist claim: notify-only guardians are never offered and cannot claim; the primary can.
    await call(waitlist.POST, {
      method: 'POST',
      cookie: p.cookie,
      body: { patientId: kid, visitType: 'FOLLOW_UP', dateFrom: FRI, dateTo: SAT },
    });
    await env.db.provider.updateMany({
      where: { id: { not: booked.providerId ?? env.providers[0] } },
      data: { active: false },
    });
    await confirm(env.ctx, ADMIN, booked.appointmentId);
    const other2 = await signIn('+12645559999');
    const kid2 = await child(env.db, 'Kid Two', [{ g: other2.guardianId, canBook: true }]);
    const b2 = (
      await call(requests.POST, { method: 'POST', cookie: other2.cookie, body: fuBody(kid2, at(FRI, '09:00')) })
    ).json;
    await confirm(env.ctx, ADMIN, b2.appointmentId);
    await cancel(env.ctx, { type: 'GUARDIAN', id: other2.guardianId }, b2.appointmentId);
    const offer = await env.db.waitlistOffer.findFirstOrThrow();
    expect((await call(claim.POST, { method: 'POST', cookie: co.cookie, params: { id: offer.id } })).status).toBe(404);
    expect((await call(claim.POST, { method: 'POST', cookie: stranger.cookie, params: { id: offer.id } })).status).toBe(
      404,
    );
    const won = await call(claim.POST, { method: 'POST', cookie: p.cookie, params: { id: offer.id } });
    expect(won.status).toBe(200);
    expect((await call(claim.POST, { method: 'POST', cookie: p.cookie, params: { id: offer.id } })).json.error).toBe(
      'OFFER_TAKEN',
    );
  });

  it('a restricted guardian sees nothing and cannot book — indistinguishable from a stranger', async () => {
    const p = await signIn('+12645550101');
    const r = await signIn('+12645550202');
    const kid = await child(env.db, 'Guarded Kid', [
      { g: p.guardianId, canBook: true },
      { g: r.guardianId, canBook: true, restricted: true },
    ]);
    expect((await call(me.GET, { cookie: r.cookie })).json.children).toEqual([]);
    const res = await call(appts.GET, { cookie: r.cookie, params: { id: kid } });
    expect(res.status).toBe(404);
    expect(res.text).not.toMatch(/restrict/i);
    expect(
      (await call(requests.POST, { method: 'POST', cookie: r.cookie, body: fuBody(kid, at(FRI, '09:00')) })).status,
    ).toBe(404);
  });
});
