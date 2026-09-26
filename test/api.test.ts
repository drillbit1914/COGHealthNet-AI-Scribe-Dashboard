import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { hashPassword, newTotpSecret, totpAt } from '../src/auth.js';
import { LocalStorage } from '../src/storage.js';
import { at, child, FRI, SAT, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  if (env) await env.db.end();
  env = await setup();
  app = await buildApp({ ctx: env.ctx, storage: new LocalStorage(path.join(os.tmpdir(), 'wav-test-files'), 's3cret'), secureCookies: false });
});
afterAll(async () => { await env?.db.end(); });

async function signIn(phone: string) {
  await app.inject({ method: 'POST', url: '/api/auth/otp/request', payload: { phone } });
  const code = env.ctx.messenger.sent.at(-1)!.body.match(/\d{6}/)![0];
  const r = await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { phone, code } });
  expect(r.statusCode).toBe(200);
  return { cookie: `wav_session=${r.cookies[0].value}`, guardianId: r.json().guardianId as string };
}
const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie } });

describe('parent API', () => {
  it('sign in by OTP (local 7-digit number → +1264), book a follow-up, see times only', async () => {
    const a = await signIn('235 1234');
    const g = await env.db.query('SELECT phone_e164 FROM guardian WHERE id = $1', [a.guardianId]);
    expect(g.rows[0].phone_e164).toBe('+12642351234');
    const slots = await call(a.cookie, 'GET', `/api/slots?visitType=EVALUATION&from=${FRI}&to=${FRI}`);
    const day = slots.json().days[0];
    expect(day.times[0]).toEqual({ startsAt: '2026-10-02T12:00:00.000Z', label: '8:00 AM' });
    expect(JSON.stringify(slots.json())).not.toMatch(/Ana|Ben|provider/i);
    const r = await call(a.cookie, 'POST', '/api/requests', {
      visitType: 'FOLLOW_UP', startsAt: at(FRI, '09:00').toISOString(), patientName: 'Maya Richardson',
      consents: { dataProcessing: true, messaging: true },
      otherGuardian: { name: 'Dad', relationship: 'father', phone: '+1 721 555 0101', notify: true },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.ref).toMatch(/^WAV-[2-9A-HJ-NP-Z]{4}$/);
    expect(body.payment.reference).toBe(body.ref);
    expect(body.notice).toMatch(/never send you new bank details/);
    expect(JSON.stringify(body)).not.toMatch(/Ana|Ben|Cara|Dev/);
    // Co-parent abroad got T9 by SMS and is notify-only.
    const toDad = env.ctx.messenger.sent.filter((m) => m.to === '+17215550101');
    expect(toDad.map((m) => m.channel)).toEqual(['SMS', 'SMS']); // T9 invite, then T1 by SMS until they reply YES
    const t9 = toDad[0];
    expect(t9.channel).toBe('SMS');
    expect(t9.body).toMatch(/Reply YES/);
    const pid = (await env.db.query('SELECT patient_id FROM appointment WHERE id = $1', [body.appointmentId])).rows[0].patient_id;
    const link = await env.db.query(`SELECT can_book FROM guardian_patient gp JOIN guardian g ON g.id = gp.guardian_id WHERE g.phone_e164 = '+17215550101' AND gp.patient_id = $1`, [pid]);
    expect(link.rows[0].can_book).toBe(false);
    const ics = await call(a.cookie, 'GET', body.icsUrl);
    expect(ics.headers['content-type']).toMatch(/text\/calendar/);
    expect(ics.body).toContain('DTSTART:20261002T130000Z');
  });

  it('AC 11: parent A cannot load parent B\'s child or appointment by editing the URL', async () => {
    const a = await signIn('+12645551111');
    const b = await signIn('+12645552222');
    const kid = await child(env.db, 'B Kid', [{ g: b.guardianId, canBook: true }]);
    const booked = await call(b.cookie, 'POST', '/api/requests', { visitType: 'FOLLOW_UP', startsAt: at(SAT, '09:00').toISOString(), patientId: kid });
    expect(booked.statusCode).toBe(201);
    expect((await call(a.cookie, 'GET', `/api/patients/${kid}/appointments`)).statusCode).toBe(404);
    expect((await call(a.cookie, 'GET', `/api/appointments/${booked.json().appointmentId}/ics`)).statusCode).toBe(404);
    expect((await call(a.cookie, 'POST', `/api/appointments/${booked.json().appointmentId}/cancel`)).statusCode).toBe(404);
    expect((await call(b.cookie, 'GET', `/api/patients/${kid}/appointments`)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/patients/${kid}/appointments` })).statusCode).toBe(401);
  });

  it('AC 7 via API: notify-only guardian sees visits and the notice but cannot write', async () => {
    const p = await signIn('+12645553333');
    const co = await signIn('+12645554444');
    const kid = await child(env.db, 'Kid Shared', [{ g: p.guardianId, canBook: true }, { g: co.guardianId }]);
    const booked = await call(p.cookie, 'POST', '/api/requests', { visitType: 'FOLLOW_UP', startsAt: at(SAT, '09:00').toISOString(), patientId: kid });
    const me = (await call(co.cookie, 'GET', '/api/me')).json();
    expect(me.children[0].can_book).toBe(false);
    expect(me.children[0].notice).toMatch(/Bookings for Kid are made by the primary contact/);
    expect((await call(co.cookie, 'GET', `/api/patients/${kid}/appointments`)).json().appointments).toHaveLength(1);
    const id = booked.json().appointmentId;
    for (const [url, payload] of [
      ['/api/requests', { visitType: 'FOLLOW_UP', startsAt: at(SAT, '11:00').toISOString(), patientId: kid }],
      [`/api/appointments/${id}/cancel`, {}],
      [`/api/appointments/${id}/reschedule`, { startsAt: at(SAT, '13:00').toISOString() }],
      ['/api/waitlist', { patientId: kid, visitType: 'FOLLOW_UP', dateFrom: FRI, dateTo: SAT }],
    ] as const) expect((await call(co.cookie, 'POST', url, payload)).statusCode).toBe(403);
  });

  it('OTP: 5 codes per phone per hour; lockout after 5 wrong codes', async () => {
    for (let i = 0; i < 5; i++)
      expect((await app.inject({ method: 'POST', url: '/api/auth/otp/request', payload: { phone: '+12645559999' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/otp/request', payload: { phone: '+12645559999' } })).statusCode).toBe(429);
    const real = env.ctx.messenger.sent.at(-1)!.body.match(/\d{6}/)![0];
    const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++)
      expect((await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { phone: '+12645559999', code: wrong } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { phone: '+12645559999', code: wrong } })).statusCode).toBe(429);
    expect((await app.inject({ method: 'POST', url: '/api/auth/otp/verify', payload: { phone: '+12645559999', code: real } })).statusCode).toBe(429);
  });
});

describe('staff API', () => {
  async function staffCookie(role: 'ADMIN' | 'PROVIDER', providerId?: string) {
    const secret = newTotpSecret();
    const email = `${role.toLowerCase()}${crypto.randomInt(1e6)}@clinic.test`;
    await env.db.query('INSERT INTO staff_user (email, role, provider_id, password_hash, totp_secret) VALUES ($1,$2,$3,$4,$5)',
      [email, role, providerId ?? null, hashPassword('correct horse battery'), secret]);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/staff/login', payload: { email, password: 'correct horse battery', totp: '000000' } });
    expect(bad.statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/auth/staff/login',
      payload: { email, password: 'correct horse battery', totp: totpAt(secret, env.clock.now.getTime()) } });
    expect(r.statusCode).toBe(200);
    return `wav_session=${r.cookies[0].value}`;
  }

  it('admin queue → confirm with reassignment → parent sees provider; provider cannot approve; parent cannot reach admin', async () => {
    const parent = await signIn('+12645556666');
    const kid = await child(env.db, 'Queue Kid', [{ g: parent.guardianId, canBook: true }]);
    const booked = (await call(parent.cookie, 'POST', '/api/requests', { visitType: 'FOLLOW_UP', startsAt: at(FRI, '10:00').toISOString(), patientId: kid })).json();
    const admin = await staffCookie('ADMIN');
    const queue = (await call(admin, 'GET', '/api/admin/queue')).json();
    expect(queue[0]).toMatchObject({ ref: booked.ref, provider_name: 'Ana', provider_assigned_by: 'SYSTEM', expiresInMin: 24 * 60, no_shows: 0 });
    const cands = (await call(admin, 'GET', `/api/admin/appointments/${booked.appointmentId}/candidates`)).json();
    expect(cands).toHaveLength(4);
    const provider = await staffCookie('PROVIDER', env.providers[0]);
    expect((await call(provider, 'POST', `/api/admin/appointments/${booked.appointmentId}/confirm`, {})).statusCode).toBe(403);
    expect((await call(parent.cookie, 'GET', '/api/admin/queue')).statusCode).toBe(401);
    const ok = await call(admin, 'POST', `/api/admin/appointments/${booked.appointmentId}/confirm`, { providerId: env.providers[2] });
    expect(ok.statusCode).toBe(200);
    const mine = (await call(parent.cookie, 'GET', `/api/patients/${kid}/appointments`)).json().appointments[0];
    expect(mine).toMatchObject({ status: 'CONFIRMED', provider: 'Cara' });
    const cal = (await call(provider, 'GET', `/api/admin/calendar?from=${FRI}&to=${SAT}`)).json();
    expect(cal.providers).toHaveLength(1);
    expect(cal.appointments).toHaveLength(0);
    const audit = (await call(admin, 'GET', `/api/admin/audit?entity=appointment&entityId=${booked.appointmentId}`)).json();
    expect(audit.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['request', 'reassign', 'status:CONFIRMED']));
  });

  it('webhooks reject bad signatures and process WhatsApp failed status + YES opt-in', async () => {
    process.env.WHATSAPP_APP_SECRET = 'appsecret';
    const bad = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: { entry: [] }, headers: { 'x-hub-signature-256': 'sha256=00' } });
    expect(bad.statusCode).toBe(403);
    const parent = await signIn('+12645557777');
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '12645557777', id: 'wamid.1', type: 'text', text: { body: 'yes' } }] } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(body).digest('hex');
    const ok = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
    expect(ok.statusCode).toBe(200);
    const g = await env.db.query('SELECT whatsapp_opt_in_at FROM guardian WHERE id = $1', [parent.guardianId]);
    expect(g.rows[0].whatsapp_opt_in_at).not.toBeNull();
  });
});
