import os from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as admin from '@/app/api/admin/[...path]/route';
import * as staffLogin from '@/app/api/auth/staff/login/route';
import * as totpSetup from '@/app/api/auth/staff/totp-setup/route';
import * as me from '@/app/api/book/me/route';
import { createRequest } from '@/server/appointments';
import { sealSession } from '@/server/auth/session';
import { exec } from '@/server/db';
import { setRouteCtx } from '@/server/http';
import { LocalStorage, setStorage } from '@/server/storage';
import { newTotpSecret, totpAt } from '@/server/totp';
import { at, child, FRI, guardian, SAT, setup, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(() => setStorage(new LocalStorage(path.join(os.tmpdir(), 'wav-test-files'))));
beforeEach(async () => {
  env = await setup();
  setRouteCtx(env.ctx);
});
afterAll(() => setRouteCtx(undefined));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function api(
  cookie: string | null,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const url = new URL(`/api/admin/${p}`, 'http://localhost');
  const req = new NextRequest(url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const handler = (
    admin as unknown as Record<
      string,
      (r: NextRequest, c: { params: Promise<{ path: string[] }> }) => Promise<Response>
    >
  )[method];
  const res = await handler(req, {
    params: Promise.resolve({ path: url.pathname.replace('/api/admin/', '').split('/') }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function makeStaff(
  role: 'ADMIN' | 'PROVIDER',
  opts: { providerId?: string; totp?: boolean; email?: string } = {},
) {
  const secret = opts.totp === false ? null : newTotpSecret();
  const email = opts.email ?? `${role.toLowerCase()}-${Math.random().toString(36).slice(2)}@wellnessave.test`;
  const u = await env.db.staffUser.create({
    data: {
      email,
      role,
      providerId: opts.providerId ?? null,
      passwordHash: await argon2.hash('correct horse battery'),
      totpSecret: secret,
    },
  });
  return { id: u.id, email, secret };
}

async function login(email: string, password: string, totp?: string) {
  const res = await staffLogin.POST(
    new NextRequest('http://localhost/api/auth/staff/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, totp }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null, json: await res.json() };
}

async function adminCookie() {
  const a = await makeStaff('ADMIN');
  const r = await login(a.email, 'correct horse battery', totpAt(a.secret!, env.clock.now.getTime()));
  expect(r.status).toBe(200);
  return r.cookie!;
}
async function providerCookie(providerId: string) {
  const p = await makeStaff('PROVIDER', { providerId, totp: false });
  return (await login(p.email, 'correct horse battery')).cookie!;
}
const fu = (patientId: string, startsAt: Date) => ({
  visitType: 'FOLLOW_UP',
  startsAt: startsAt.toISOString(),
  patientId,
});
async function booking(name: string, hhmm: string, day = FRI) {
  const g = await guardian(env.db, name);
  const c = await child(env.db, `${name} Kid`, [{ g, canBook: true }], '2019-02-02');
  const r = await createRequest(env.ctx, g, fu(c, at(day, hhmm)));
  return { g, c, ...r };
}

describe('staff login (PRD §13)', () => {
  it('admin needs password + TOTP; wrong code fails; 5 failures lock; admin without 2FA cannot sign in', async () => {
    const a = await makeStaff('ADMIN');
    expect((await login(a.email, 'correct horse battery')).status).toBe(401);
    expect((await login(a.email, 'wrong', totpAt(a.secret!, env.clock.now.getTime()))).status).toBe(401);
    const ok = await login(a.email.toUpperCase(), 'correct horse battery', totpAt(a.secret!, env.clock.now.getTime()));
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(/^wellnessave_session=/);
    for (let i = 0; i < 4; i++) await login(a.email, 'nope', '000000');
    const locked = await login(a.email, 'nope', '000000');
    expect(locked.status).toBe(429);
    expect((await login(a.email, 'correct horse battery', totpAt(a.secret!, env.clock.now.getTime()))).status).toBe(
      429,
    );
    env.clock.now = new Date(env.clock.now.getTime() + 16 * 60000);
    expect((await login(a.email, 'correct horse battery', totpAt(a.secret!, env.clock.now.getTime()))).status).toBe(
      200,
    );
    // An admin without 2FA must enroll before getting a session.
    const fresh = await makeStaff('ADMIN', { totp: false });
    const first = await login(fresh.email, 'correct horse battery');
    expect(first.status).toBe(200);
    expect(first.cookie).toBeNull();
    expect(first.json).toMatchObject({ needsTotpSetup: true, qr: expect.stringMatching(/^data:image\/png;base64,/) });
    const finish = (code: string) =>
      totpSetup.POST(
        new NextRequest('http://localhost/api/auth/staff/totp-setup', {
          method: 'POST',
          body: JSON.stringify({ setupToken: first.json.setupToken, code }),
          headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({}) },
      );
    expect((await finish('000000')).status).toBe(401);
    const done = await finish(totpAt(first.json.secret, env.clock.now.getTime()));
    expect(done.status).toBe(200);
    expect(done.headers.get('set-cookie')).toMatch(/^wellnessave_session=/);
    expect((await finish(totpAt(first.json.secret, env.clock.now.getTime()))).status).toBe(409); // token can't re-enroll
    expect((await login(fresh.email, 'correct horse battery')).status).toBe(401); // now requires the code
    expect(
      (await login(fresh.email, 'correct horse battery', totpAt(first.json.secret, env.clock.now.getTime()))).status,
    ).toBe(200);
    expect((await login('nobody@wellnessave.test', 'x')).status).toBe(401);
  });

  it('staff sessions expire after 12 hours and deactivation revokes them', async () => {
    const cookie = await adminCookie();
    expect((await api(cookie, 'GET', 'queue')).status).toBe(200);
    env.clock.now = new Date(env.clock.now.getTime() + 12 * 3600000 + 1000);
    expect((await api(cookie, 'GET', 'queue')).status).toBe(401);
  });
});

describe('route guards (PRD §3)', () => {
  it('parents and anonymous users cannot reach the admin API; providers cannot reach admin-only routes', async () => {
    expect((await api(null, 'GET', 'queue')).status).toBe(401);
    const g = await guardian(env.db, 'Parent');
    const iat = env.clock.now.getTime();
    const parent = `wellnessave_session=${await sealSession({ kind: 'guardian', guardianId: g, iat, exp: iat + 3600000 })}`;
    expect((await api(parent, 'GET', 'queue')).status).toBe(401);
    const prov = await providerCookie(env.providers[0]);
    for (const p of [
      'patients',
      'settings',
      'payments/unpaid',
      'messages',
      'reports?from=2026-10-01&to=2026-10-31',
      'staff',
    ])
      expect((await api(prov, 'GET', p)).status, p).toBe(403);
    expect((await api(prov, 'PATCH', 'settings', { BUFFER_MIN: 5 })).status).toBe(403);
    expect((await api(prov, 'GET', 'nope')).status).toBe(404);
  });

  it('a provider sees only their own queue items and calendar, and cannot approve by default', async () => {
    const a = await booking('A', '09:00'); // → Ana
    const b = await booking('B', '09:00'); // → Ben
    const ana = await providerCookie(a.providerId);
    const q = await api(ana, 'GET', 'queue');
    expect(q.json.map((x: { id: string }) => x.id)).toEqual([a.appointmentId]);
    const cal = await api(ana, 'GET', `calendar?from=${FRI}&to=${FRI}`);
    expect(cal.json.providers).toHaveLength(1);
    expect(cal.json.appointments.map((x: { id: string }) => x.id)).toEqual([a.appointmentId]);
    expect((await api(ana, 'POST', `appointments/${a.appointmentId}/confirm`, {})).status).toBe(403);
    expect((await api(ana, 'POST', `appointments/${b.appointmentId}/confirm`, {})).status).toBe(403);
    // Providers manage only their own time off.
    const mine = await api(ana, 'POST', 'time-off', {
      providerId: a.providerId,
      startsAt: at(SAT, '08:00'),
      endsAt: at(SAT, '10:00'),
    });
    expect(mine.status).toBe(200);
    expect(
      (
        await api(ana, 'POST', 'time-off', {
          providerId: b.providerId,
          startsAt: at(SAT, '08:00'),
          endsAt: at(SAT, '10:00'),
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(ana, 'POST', 'time-off', { providerId: null, startsAt: at(SAT, '08:00'), endsAt: at(SAT, '10:00') }))
        .status,
    ).toBe(403);
  });
});

describe('approval queue and calendar (PRD §9)', () => {
  it('queue shows countdown data and suggested provider; reassign dropdown lists only free providers; confirm with reassignment', async () => {
    const a = await booking('A', '10:00');
    const cookie = await adminCookie();
    const q = await api(cookie, 'GET', 'queue');
    expect(q.json[0]).toMatchObject({ ref: a.ref, provider_name: 'Ana', provider_assigned_by: 'SYSTEM', no_shows: 0 });
    expect(new Date(q.json[0].expires_at).getTime() - env.clock.now.getTime()).toBe(24 * 3600000);
    await booking('B', '10:30'); // Ben busy 10:30–11:30 → not free for 10:00–11:00
    const cands = (await api(cookie, 'GET', `appointments/${a.appointmentId}/candidates`)).json;
    expect(cands.map((c: { name: string }) => c.name).sort()).toEqual(['Ana', 'Cara', 'Dev']);
    expect(cands.find((c: { name: string }) => c.name === 'Cara')).toMatchObject({ discipline: 'OT', load: 0 });
    expect(
      (await api(cookie, 'POST', `appointments/${a.appointmentId}/confirm`, { providerId: env.providers[1] })).json
        .error,
    ).toBe('PROVIDER_BUSY');
    expect(
      (await api(cookie, 'POST', `appointments/${a.appointmentId}/confirm`, { providerId: env.providers[2] })).status,
    ).toBe(200);
    const appt = await env.db.appointment.findUniqueOrThrow({ where: { id: a.appointmentId } });
    expect(appt).toMatchObject({ status: 'CONFIRMED', providerId: env.providers[2], providerAssignedBy: 'ADMIN' });
    expect((await api(cookie, 'POST', `appointments/${a.appointmentId}/decline`, { reason: 'x' })).json.error).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('decline needs a reason; propose alternate uses the pooled slot picker', async () => {
    const a = await booking('A', '10:00');
    const cookie = await adminCookie();
    expect((await api(cookie, 'POST', `appointments/${a.appointmentId}/decline`, { reason: '  ' })).status).toBe(400);
    const alts = (await api(cookie, 'GET', `appointments/${a.appointmentId}/alternates?from=${SAT}&to=${SAT}`)).json;
    expect(alts[0]).toMatchObject({ startsAt: at(SAT, '08:00').toISOString(), freeProviders: 4 });
    expect(
      (await api(cookie, 'POST', `appointments/${a.appointmentId}/propose`, { startsAt: alts[0].startsAt })).status,
    ).toBe(200);
    expect((await env.db.appointment.findUniqueOrThrow({ where: { id: a.appointmentId } })).status).toBe(
      'ALTERNATE_PROPOSED',
    );
  });

  it('calendar drag: moving a confirmed visit to another provider and time reschedules it through the service layer', async () => {
    const a = await booking('A', '10:00');
    const cookie = await adminCookie();
    await api(cookie, 'POST', `appointments/${a.appointmentId}/confirm`, {});
    const moved = await api(cookie, 'POST', `appointments/${a.appointmentId}/reschedule`, {
      startsAt: at(FRI, '14:00'),
      providerId: env.providers[3],
    });
    expect(moved.status).toBe(200);
    const old = await env.db.appointment.findUniqueOrThrow({ where: { id: a.appointmentId } });
    const neu = await env.db.appointment.findUniqueOrThrow({ where: { id: moved.json.appointmentId } });
    expect(old.status).toBe('RESCHEDULED');
    expect(neu).toMatchObject({
      status: 'CONFIRMED',
      providerId: env.providers[3],
      startsAt: at(FRI, '14:00'),
      rescheduledFromId: a.appointmentId,
    });
    expect(await env.db.message.count({ where: { appointmentId: neu.id, templateKey: 'T3' } })).toBe(1);
    // Dropping onto a busy provider is refused by the exclusion constraint path.
    const b = await booking('B', '14:00');
    await api(cookie, 'POST', `appointments/${b.appointmentId}/confirm`, { providerId: env.providers[0] });
    const clash = await api(cookie, 'POST', `appointments/${b.appointmentId}/reschedule`, {
      startsAt: at(FRI, '14:00'),
      providerId: env.providers[3],
    });
    expect(clash.json.error).toBe('SLOT_TAKEN');
    expect((await env.db.appointment.findUniqueOrThrow({ where: { id: b.appointmentId } })).status).toBe('CONFIRMED');
    const cal = await api(cookie, 'GET', `calendar?from=${FRI}&to=${SAT}`);
    expect(cal.json.providers).toHaveLength(4);
    expect(cal.json.appointments).toHaveLength(2);
  });
});

describe('patients and guardians (PRD §8, §9)', () => {
  it('restricting a guardian hides the child from them; merge keeps restrictions; referral opens via signed URL', async () => {
    const cookie = await adminCookie();
    const [p, other] = [await guardian(env.db, 'Primary'), await guardian(env.db, 'Other')];
    const kid = await child(
      env.db,
      'Maya Richardson',
      [
        { g: p, canBook: true },
        { g: other, canBook: true },
      ],
      '2019-01-01',
    );
    const iat = env.clock.now.getTime();
    const otherCookie = `wellnessave_session=${await sealSession({ kind: 'guardian', guardianId: other, iat, exp: iat + 3600000 })}`;
    const meCall = async () =>
      (
        await me.GET(new NextRequest('http://localhost/api/book/me', { headers: { cookie: otherCookie } }), {
          params: Promise.resolve({}),
        })
      ).json();
    expect((await meCall()).children).toHaveLength(1);
    expect(
      (await api(cookie, 'POST', 'guardian-links', { patientId: kid, guardianId: other, restricted: true })).status,
    ).toBe(200);
    expect((await meCall()).children).toHaveLength(0);

    // Duplicate record created by a typed name; merging moves everything and keeps the restriction.
    const dup = await env.db.patient.create({ data: { fullName: 'Maya R', needsAdminMatch: true } });
    await env.db.guardianPatient.create({ data: { guardianId: other, patientId: dup.id, canBook: true } });
    await exec(
      env.db,
      `INSERT INTO appointment (ref, patient_id, provider_id, provider_assigned_by, visit_type, starts_at, ends_at, status)
      VALUES ('WAV-DUP1', $1::uuid, $2::uuid, 'ADMIN', 'FOLLOW_UP', $3, $4, 'COMPLETED')`,
      dup.id,
      env.providers[0],
      at(FRI, '08:00'),
      at(FRI, '09:00'),
    );
    expect((await api(cookie, 'POST', 'merge/patients', { fromId: dup.id, intoId: kid })).status).toBe(200);
    const link = await env.db.guardianPatient.findUniqueOrThrow({
      where: { guardianId_patientId: { guardianId: other, patientId: kid } },
    });
    expect(link.restricted).toBe(true);
    const profile = (await api(cookie, 'GET', `patients/${kid}`)).json;
    expect(profile.visits.map((v: { ref: string }) => v.ref)).toContain('WAV-DUP1');

    // Evaluation with a referral → signed URL in the profile.
    await createRequest(env.ctx, p, {
      visitType: 'EVALUATION',
      startsAt: at(SAT, '09:00').toISOString(),
      patientId: kid,
      evaluation: {
        reasonText: 'x',
        payerType: 'INSURANCE',
        insurer: 'NAGICO',
        memberNo: '1',
        hasReferral: true,
        referralFileKey: `referrals/${p}/r.pdf`,
      },
    });
    const withIntake = (await api(cookie, 'GET', `patients/${kid}`)).json;
    expect(withIntake.intakes[0].referral_url).toMatch(/^\/api\/files\/referrals\/.+\?exp=\d+&sig=/);
    const search = (await api(cookie, 'GET', 'patients?q=maya')).json;
    expect(search.map((s: { id: string }) => s.id)).toEqual([kid]);
  });

  it('merging guardians revokes the duplicate’s sessions; erase is refused while visits are active', async () => {
    const cookie = await adminCookie();
    const [a, b] = [await guardian(env.db, 'Tasha'), await guardian(env.db, 'Tasha (dup)')];
    const kid = await child(env.db, 'Kid', [{ g: a, canBook: true }, { g: b }]);
    expect((await api(cookie, 'POST', 'merge/guardians', { fromId: b, intoId: a })).status).toBe(200);
    expect((await env.db.guardian.findUniqueOrThrow({ where: { id: b } })).mergedIntoId).toBe(a);
    await createRequest(env.ctx, a, fu(kid, at(FRI, '09:00')));
    expect((await api(cookie, 'POST', `patients/${kid}/erase`)).json.error).toBe('ACTIVE_APPOINTMENTS');
    const exported = (await api(cookie, 'GET', `patients/${kid}/export`)).json;
    expect(exported.appointments).toHaveLength(1);
  });
});

describe('payments, closures, series, settings, reports', () => {
  it('payments: bank transfer needs a reference; totals by day and method; proofs review queue', async () => {
    const cookie = await adminCookie();
    const a = await booking('A', '09:00');
    expect(
      (await api(cookie, 'POST', `appointments/${a.appointmentId}/payment`, { status: 'PAID_BANK_TRANSFER' })).status,
    ).toBe(400);
    await env.db.paymentProof.create({ data: { appointmentId: a.appointmentId, guardianId: a.g, text: 'NCBA 99812' } });
    const proofs = (await api(cookie, 'GET', 'payments/proofs')).json;
    expect(proofs[0]).toMatchObject({ ref: a.ref, text: 'NCBA 99812' });
    expect((await api(cookie, 'GET', 'payments/unpaid')).json[0].proofs).toBe(1);
    await api(cookie, 'POST', `appointments/${a.appointmentId}/payment`, {
      status: 'PAID_BANK_TRANSFER',
      reference: '99812',
    });
    await api(cookie, 'POST', `payments/proofs/${proofs[0].id}/reviewed`);
    expect((await api(cookie, 'GET', 'payments/proofs')).json).toHaveLength(0);
    expect((await api(cookie, 'GET', 'payments/unpaid')).json).toHaveLength(0);
    const totals = (await api(cookie, 'GET', `payments/totals?from=2026-10-01&to=2026-10-01`)).json;
    expect(totals).toEqual([{ day: '2026-10-01', payment_status: 'PAID_BANK_TRANSFER', n: 1 }]);
  });

  it('closure preview → apply → rebook list', async () => {
    const cookie = await adminCookie();
    await booking('A', '09:00', SAT);
    await booking('B', '12:00', SAT);
    const range = { startsAt: at(SAT, '00:00'), endsAt: at('2026-10-04', '00:00') };
    expect((await api(cookie, 'POST', 'closures/preview', range)).json).toHaveLength(2);
    expect((await api(cookie, 'POST', 'closures', { ...range, reason: '' })).status).toBe(400);
    expect((await api(cookie, 'POST', 'closures', { ...range, reason: 'Public holiday' })).json.cancelled).toBe(2);
    const rebook = (await api(cookie, 'GET', 'rebook')).json;
    expect(rebook).toHaveLength(2);
    await api(cookie, 'POST', `rebook/${rebook[0].id}/resolve`);
    expect((await api(cookie, 'GET', 'rebook')).json).toHaveLength(1);
  });

  it('recurring series: conflicts listed before saving, created CONFIRMED', async () => {
    const cookie = await adminCookie();
    const g = await guardian(env.db, 'A');
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    await env.db.timeOff.create({
      data: { providerId: env.providers[0], startsAt: at('2026-10-09', '00:00'), endsAt: at('2026-10-10', '00:00') },
    });
    const body = {
      patientId: kid,
      providerId: env.providers[0],
      visitType: 'FOLLOW_UP',
      firstStartsAt: at(FRI, '09:00'),
      rule: 'WEEKLY',
      count: 3,
    };
    const preview = (await api(cookie, 'POST', 'series/preview', body)).json;
    expect(preview.map((p: { conflict: boolean }) => p.conflict)).toEqual([false, true, false]);
    expect((await api(cookie, 'POST', 'series', body)).json.error).toBe('SERIES_CONFLICTS');
    const made = (await api(cookie, 'POST', 'series', { ...body, skipConflicts: true })).json;
    expect(made.appointmentIds).toHaveLength(2);
    expect(await env.db.appointment.count({ where: { seriesId: made.seriesId, status: 'CONFIRMED' } })).toBe(2);
  });

  it('settings: every value is validated; unknown keys rejected; changes audited and applied', async () => {
    const cookie = await adminCookie();
    const s = (await api(cookie, 'GET', 'settings')).json;
    expect(s.fields.map((f: { key: string }) => f.key).sort()).toEqual(Object.keys(s.values).sort());
    expect((await api(cookie, 'PATCH', 'settings', { NOPE: 1 })).status).toBe(400);
    expect((await api(cookie, 'PATCH', 'settings', { BUFFER_MIN: -5 })).status).toBe(400);
    expect((await api(cookie, 'PATCH', 'settings', { ADMIN_ALERT_PHONES: ['264 555'] })).status).toBe(400);
    expect((await api(cookie, 'PATCH', 'settings', { TIMEZONE: 'Mars/Base' })).status).toBe(400);
    const ok = await api(cookie, 'PATCH', 'settings', {
      VISIT_DURATIONS_MIN: { FOLLOW_UP: 45, EVALUATION: 90 },
      NCBA_ACCOUNT_NO: '123-456',
    });
    expect(ok.json.NCBA_ACCOUNT_NO).toBe('123-456');
    const audit = (await api(cookie, 'GET', 'audit?entity=clinic_settings')).json;
    expect(audit[0].after).toMatchObject({ NCBA_ACCOUNT_NO: '123-456' });
    // Hours editor and providers
    expect(
      (await api(cookie, 'PUT', 'rules', { providerId: null, rules: [{ weekday: 5, start: '09:00', end: '08:00' }] }))
        .status,
    ).toBe(400);
    expect(
      (await api(cookie, 'PUT', 'rules', { providerId: null, rules: [{ weekday: 5, start: '09:00', end: '13:00' }] }))
        .status,
    ).toBe(200);
    expect((await api(cookie, 'GET', 'rules')).json).toEqual([
      { provider_id: null, weekday: 5, start_time: '09:00:00', end_time: '13:00:00' },
    ]);
    const created = (
      await api(cookie, 'POST', 'staff', {
        email: 'ana@wellnessave.test',
        role: 'PROVIDER',
        providerId: env.providers[0],
      })
    ).json;
    expect(created.temporaryPassword).toHaveLength(16);
    expect(created).not.toHaveProperty('totpUri');
  });

  it('reports: visits by provider, load, outcomes, no-show rate, payments', async () => {
    const cookie = await adminCookie();
    const a = await booking('A', '09:00');
    await api(cookie, 'POST', `appointments/${a.appointmentId}/confirm`, {});
    await api(cookie, 'POST', `appointments/${a.appointmentId}/attendance`, { outcome: 'NO_SHOW' });
    await api(cookie, 'POST', `appointments/${a.appointmentId}/payment`, { status: 'PAID_CASH' });
    const r = (await api(cookie, 'GET', `reports?from=2026-10-01&to=2026-10-31`)).json;
    expect(r.noShowRate).toBe(100);
    expect(r.visitsByProvider).toEqual([{ provider: 'Ana', status: 'NO_SHOW', n: 1 }]);
    expect(r.load.find((l: { provider: string }) => l.provider === 'Ana')).toMatchObject({ visits: 1, hours: 1 });
    expect(r.outcomes).toEqual([{ outcome: 'APPROVED', n: 1 }]);
    expect(r.payments).toEqual([{ payment_status: 'PAID_CASH', n: 1 }]);
  });
});
