import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as cron from '@/app/api/cron/[job]/route';
import * as smsHook from '@/app/api/webhooks/sms/route';
import * as waHook from '@/app/api/webhooks/whatsapp/route';
import en from '@/i18n/en.json';
import { cancel, closeClinic, confirm, createRequest, proposeAlternate } from '@/server/appointments';
import { requestOtp } from '@/server/auth/otp';
import { exec } from '@/server/db';
import { setRouteCtx } from '@/server/http';
import { providerAgendas } from '@/server/jobs';
import { BACKOFF_MS, processOutbox } from '@/server/messaging/outbox';
import { setProviders, WhatsAppCloudProvider } from '@/server/messaging/provider';
import { twilioSignature } from '@/server/messaging/signatures';
import { TEMPLATES, type TemplateKey } from '@/server/messaging/templates';
import { LocalStorage, setStorage } from '@/server/storage';
import { MockProviders } from './mock-providers';
import { ADMIN, at, child, FRI, guardian, onlyProviders, SAT, setup, type TestEnv } from './helpers';

let env: TestEnv;
let mp: MockProviders;
beforeAll(() => setStorage(new LocalStorage(path.join(os.tmpdir(), 'wav-test-files'))));
beforeEach(async () => {
  env = await setup();
  mp = new MockProviders();
  setProviders(mp);
  setRouteCtx(env.ctx);
});
afterAll(() => {
  setProviders(undefined);
  setRouteCtx(undefined);
});

const flush = () => processOutbox(env.ctx, { providers: mp });
const phoneOf = async (id: string) => (await env.db.guardian.findUniqueOrThrow({ where: { id } })).phoneE164;
const fu = (patientId: string, startsAt: Date) => ({
  visitType: 'FOLLOW_UP',
  startsAt: startsAt.toISOString(),
  patientId,
});
const BASE = 'https://book.wellnessave.test';

async function postWhatsApp(payload: unknown, sig?: string) {
  const raw = JSON.stringify(payload);
  const signature =
    sig ?? 'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET!).update(raw).digest('hex');
  return waHook.POST(
    new NextRequest(`${BASE}/api/webhooks/whatsapp`, {
      method: 'POST',
      body: raw,
      headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' },
    }),
  );
}
const waInbound = (from: string, msg: Record<string, unknown>) => ({
  entry: [
    {
      changes: [
        { value: { messages: [{ from: from.replace('+', ''), id: `wamid.in.${crypto.randomUUID()}`, ...msg }] } },
      ],
    },
  ],
});
const waStatus = (id: string, status: string) => ({
  entry: [
    {
      changes: [
        {
          value: {
            statuses: [
              { id, status, errors: status === 'failed' ? [{ code: 131026, title: 'Undeliverable' }] : undefined },
            ],
          },
        },
      ],
    },
  ],
});

async function postSms(params: Record<string, string>, sig?: string) {
  const url = `${BASE}/api/webhooks/sms`;
  const signature = sig ?? twilioSignature(url, params, process.env.TWILIO_AUTH_TOKEN!);
  return smsHook.POST(
    new NextRequest(url, {
      method: 'POST',
      body: new URLSearchParams(params).toString(),
      headers: { 'x-twilio-signature': signature, 'content-type': 'application/x-www-form-urlencoded' },
    }),
  );
}
const runCron = (job: string, auth = `Bearer ${process.env.CRON_SECRET}`) =>
  cron.GET(new NextRequest(`${BASE}/api/cron/${job}`, { headers: { authorization: auth } }), {
    params: Promise.resolve({ job }),
  });

describe('template registry (PRD §7)', () => {
  it('variable order covers exactly the placeholders in en.json, and every body names Wellness Ave', () => {
    for (const [key, def] of Object.entries(TEMPLATES)) {
      const body = en.templates[key as TemplateKey];
      const placeholders = [...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      expect(new Set(def.vars), key).toEqual(new Set(placeholders));
      expect(body, key).toContain('Wellness Ave');
    }
  });

  it('WhatsAppCloudProvider builds template payloads with params, quick replies and the OTP copy-code button', () => {
    const p = new WhatsAppCloudProvider('123', 'token', 'v21.0');
    const t3 = p.payload({
      to: '+12645551234',
      body: 'x',
      templateKey: 'T3',
      params: ['Maya', 'follow-up'],
      buttons: [{ id: 'VIEW:1', title: 'View' }],
    });
    expect(t3).toMatchObject({
      to: '12645551234',
      type: 'template',
      template: { name: 'wellness_ave_confirmed', language: { code: 'en' } },
    });
    expect(JSON.stringify(t3)).toContain('"payload":"VIEW:1"');
    const t0 = p.payload({ to: '+1', body: 'x', templateKey: 'T0', params: ['123456'], buttons: [] });
    expect(JSON.stringify(t0)).toContain('"sub_type":"url"');
    const reply = p.payload({ to: '+1', body: 'hello', templateKey: null, params: [], buttons: [] });
    expect(reply).toMatchObject({ type: 'text', text: { body: 'hello' } });
  });
});

describe('fan-out (AC 6)', () => {
  it('two notified guardians → two T1/T2/T3; restricted → none; notify-only copy has no buttons', async () => {
    const [p, co, r] = [
      await guardian(env.db, 'Primary'),
      await guardian(env.db, 'Co'),
      await guardian(env.db, 'Restricted'),
    ];
    const kid = await child(
      env.db,
      'Maya Richardson',
      [{ g: p, canBook: true }, { g: co }, { g: r, canBook: true, restricted: true }],
      '2019-01-01',
    );
    const [pp, cp, rp] = [await phoneOf(p), await phoneOf(co), await phoneOf(r)];
    const req = await createRequest(env.ctx, p, fu(kid, at(SAT, '09:00')));
    await flush();
    expect(
      mp
        .byTemplate('T1')
        .map((m) => m.to)
        .sort(),
    ).toEqual([pp, cp].sort());
    await confirm(env.ctx, ADMIN, req.appointmentId);
    await flush();
    const t3 = mp.byTemplate('T3');
    expect(t3).toHaveLength(2);
    expect(t3.find((m) => m.to === pp)!.buttons.map((b) => b.title)).toEqual(['View', 'Reschedule']);
    expect(t3.find((m) => m.to === cp)!.buttons).toEqual([]);
    expect(t3[0].body).toContain('with Ana');
    expect(t3[0].params).toEqual(['Maya', 'follow-up', 'Saturday', '3 October 2026', '9:00 AM', 'Ana', req.ref]);
    await createRequest(env.ctx, p, {
      visitType: 'EVALUATION',
      startsAt: at(SAT, '13:00').toISOString(),
      patientId: kid,
      evaluation: { reasonText: 'Sensory', payerType: 'SELF_PAY' },
      consents: { dataProcessing: true, messaging: true },
    });
    await flush();
    expect(
      mp
        .byTemplate('T2')
        .map((m) => m.to)
        .sort(),
    ).toEqual([pp, cp].sort());
    expect(mp.to(rp)).toHaveLength(0);
    // No health details in bodies (PRD §13).
    expect(mp.sent.map((m) => m.body).join(' ')).not.toMatch(/Sensory/);
  });

  it('guardians without WhatsApp opt-in get SMS; can_book SMS carries a manage link instead of buttons', async () => {
    const p = await guardian(env.db, 'Primary', { whatsapp: false });
    const co = await guardian(env.db, 'Co', { whatsapp: false });
    const kid = await child(env.db, 'Kid', [{ g: p, canBook: true }, { g: co }]);
    const req = await createRequest(env.ctx, p, fu(kid, at(SAT, '09:00')));
    await confirm(env.ctx, ADMIN, req.appointmentId);
    await flush();
    const t3 = mp.sent.filter((m) => m.body.includes('is confirmed'));
    expect(t3.every((m) => m.channel === 'SMS')).toBe(true);
    const primary = mp.to(await phoneOf(p)).find((m) => m.body.includes('is confirmed'))!;
    const coMsg = mp.to(await phoneOf(co)).find((m) => m.body.includes('is confirmed'))!;
    expect(primary.body).toContain(`Manage: ${BASE}/book`);
    expect(coMsg.body).not.toContain('Manage:');
  });
});

describe('WhatsApp → SMS fallback and retries (AC 8)', () => {
  it('an API error falls back to SMS in the same run (well within 60 seconds)', async () => {
    const g = await guardian(env.db, 'A');
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    mp.failWhatsApp = true;
    await createRequest(env.ctx, g, fu(kid, at(FRI, '09:00')));
    const res = await flush();
    expect(res.fallbacks).toBeGreaterThanOrEqual(1);
    const rows = await env.db.message.findMany({ where: { templateKey: 'T1' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ['WHATSAPP', 'FAILED'],
      ['SMS', 'SENT'],
    ]);
    expect(rows[1].fallbackOfId).toBe(rows[0].id);
    expect(mp.to(await phoneOf(g)).map((m) => m.channel)).toEqual(['SMS']);
  });

  it('a "failed" status webhook triggers exactly one SMS resend, sent immediately', async () => {
    const g = await guardian(env.db, 'A');
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    await createRequest(env.ctx, g, fu(kid, at(FRI, '09:00')));
    await flush();
    const wa = mp.byTemplate('T1')[0];
    expect((await postWhatsApp(waStatus(wa.id, 'delivered'))).status).toBe(200);
    expect((await postWhatsApp(waStatus(wa.id, 'failed'))).status).toBe(200);
    expect((await postWhatsApp(waStatus(wa.id, 'failed'))).status).toBe(200); // Meta retries
    const sms = mp.sent.filter((m) => m.channel === 'SMS');
    expect(sms).toHaveLength(1);
    expect(sms[0].body).toMatch(/follow-up request/);
    const row = await env.db.message.findFirstOrThrow({ where: { providerMessageId: wa.id } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/131026/);
  });

  it('SMS retries with backoff and gives up after 3 attempts', async () => {
    const g = await guardian(env.db, 'A', { whatsapp: false });
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    mp.failSms = true;
    await createRequest(env.ctx, g, fu(kid, at(FRI, '09:00')));
    await flush();
    const get = () => env.db.message.findFirstOrThrow({ where: { templateKey: 'T1' } });
    expect(await get()).toMatchObject({ status: 'PENDING', attempts: 1 });
    await flush(); // not due yet
    expect((await get()).attempts).toBe(1);
    env.clock.now = new Date(env.clock.now.getTime() + BACKOFF_MS[0]);
    await flush();
    expect(await get()).toMatchObject({ status: 'PENDING', attempts: 2 });
    env.clock.now = new Date(env.clock.now.getTime() + BACKOFF_MS[1]);
    await flush();
    expect(await get()).toMatchObject({ status: 'FAILED', attempts: 3 });
  });

  it('SMS-only launch: before WhatsApp is configured, codes and updates go by SMS to opted-in guardians too', async () => {
    mp.whatsappEnabled = false;
    const g = await guardian(env.db, 'A'); // opted in to WhatsApp
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    await requestOtp(env.ctx, await phoneOf(g));
    const r = await createRequest(env.ctx, g, fu(kid, at(FRI, '09:00')));
    await confirm(env.ctx, ADMIN, r.appointmentId);
    await flush();
    const mine = mp.to(await phoneOf(g));
    expect(mine.map((m) => m.channel)).toEqual(['SMS', 'SMS', 'SMS']);
    expect(mine[2].body).toContain(`Manage: ${BASE}/book`); // T3 buttons become a link
    expect(await env.db.message.count({ where: { status: 'FAILED' } })).toBe(0);
  });

  it('never keeps one-time codes in the message log after sending', async () => {
    await requestOtp(env.ctx, '+12645550999');
    await flush();
    expect(mp.byTemplate('T0')[0].params[0]).toMatch(/^\d{6}$/);
    const row = await env.db.message.findFirstOrThrow({ where: { templateKey: 'T0' } });
    expect(row).toMatchObject({ status: 'SENT', body: null, vars: null });
  });
});

describe('waitlist offers (AC 10)', () => {
  it('cancelling a confirmed slot sends T8 with Claim; first tap wins, later taps get "already taken"', async () => {
    await onlyProviders(env.db, [env.providers[0]]);
    const b = await guardian(env.db, 'Booker');
    const kid = await child(env.db, 'Kid', [{ g: b, canBook: true }]);
    const req = await createRequest(env.ctx, b, fu(kid, at(SAT, '10:00')));
    await confirm(env.ctx, ADMIN, req.appointmentId);
    const waiters: string[] = [];
    for (const n of ['W1', 'W2']) {
      const w = await guardian(env.db, n);
      const wk = await child(env.db, `${n} Kid`, [{ g: w, canBook: true }]);
      await env.db.waitlistEntry.create({
        data: { patientId: wk, guardianId: w, visitType: 'FOLLOW_UP', dateFrom: new Date(FRI), dateTo: new Date(SAT) },
      });
      waiters.push(w);
    }
    await flush();
    mp.sent = [];
    await cancel(env.ctx, { type: 'GUARDIAN', id: b }, req.appointmentId);
    await flush();
    const t8 = mp.byTemplate('T8');
    expect(t8.map((m) => m.to).sort()).toEqual((await Promise.all(waiters.map(phoneOf))).sort());
    expect(t8[0].buttons.map((x) => x.title)).toEqual(['Claim']);
    const payload = t8[0].buttons[0].id;
    // Second waiter taps first and wins; the first waiter's tap then gets the polite "already taken".
    const [w1p, w2p] = await Promise.all(waiters.map(phoneOf));
    await postWhatsApp(waInbound(w2p, { type: 'button', button: { payload, text: 'Claim' } }));
    await postWhatsApp(waInbound(w1p, { type: 'button', button: { payload, text: 'Claim' } }));
    const held = await env.db.appointment.findMany({
      where: { startsAt: at(SAT, '10:00'), status: 'REQUESTED' },
      include: { patient: true },
    });
    expect(held).toHaveLength(1);
    expect(held[0].patient.fullName).toBe('W2 Kid');
    expect(mp.to(w1p).at(-1)!.body).toMatch(/already been taken/);
  });

  it('the cron sweep offers open times to waitlisted guardians, at most 3, without repeating', async () => {
    const entries = [];
    for (const n of ['A', 'B', 'C', 'D']) {
      const w = await guardian(env.db, n);
      const wk = await child(env.db, `${n} Kid`, [{ g: w, canBook: true }]);
      entries.push(
        await env.db.waitlistEntry.create({
          data: {
            patientId: wk,
            guardianId: w,
            visitType: 'EVALUATION',
            dateFrom: new Date(SAT),
            dateTo: new Date(SAT),
            window: 'AFTERNOON',
          },
        }),
      );
    }
    const res = await (await runCron('waitlist')).json();
    expect(res.offers).toBe(1);
    const t8 = mp.byTemplate('T8');
    expect(t8).toHaveLength(3);
    expect(t8[0].body).toContain('12:00 PM');
    await runCron('waitlist');
    expect(mp.byTemplate('T8')).toHaveLength(4); // the 4th entry gets its own offer; the first 3 are not repeated
  });
});

describe('reminders, agenda, closures (AC 12, AC 13, S3)', () => {
  it('AC 12: T6 fires once, 24h before, never for cancelled visits', async () => {
    const g = await guardian(env.db, 'A');
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    const a1 = await createRequest(env.ctx, g, fu(kid, at(SAT, '09:00')));
    const a2 = await createRequest(env.ctx, g, fu(kid, at(SAT, '11:00')));
    await confirm(env.ctx, ADMIN, a1.appointmentId);
    await confirm(env.ctx, ADMIN, a2.appointmentId);
    await cancel(env.ctx, ADMIN, a2.appointmentId, 'Therapist unwell.');
    env.clock.now = new Date(at(SAT, '09:00').getTime() - 25 * 3600000);
    await runCron('reminders');
    expect(mp.byTemplate('T6')).toHaveLength(0);
    env.clock.now = new Date(at(SAT, '09:00').getTime() - 24 * 3600000);
    expect((await runCron('reminders')).status).toBe(200);
    await runCron('reminders');
    const t6 = mp.byTemplate('T6');
    expect(t6).toHaveLength(1);
    expect(t6[0].body).toContain('tomorrow at 9:00 AM with Ana');
    expect(t6[0].buttons.map((b) => b.title)).toEqual(["I'll be there", 'Reschedule']);
  });

  it('AC 13: clinic closure sends one T10 per notified guardian of each affected visit', async () => {
    const [p, co] = [await guardian(env.db, 'P'), await guardian(env.db, 'Co')];
    const kid = await child(env.db, 'Kid', [{ g: p, canBook: true }, { g: co }]);
    const solo = await guardian(env.db, 'Solo');
    const kid2 = await child(env.db, 'Kid2', [{ g: solo, canBook: true }]);
    await createRequest(env.ctx, p, fu(kid, at(SAT, '09:00')));
    await createRequest(env.ctx, solo, fu(kid2, at(SAT, '15:00')));
    await createRequest(env.ctx, solo, fu(kid2, at(FRI, '15:00')));
    await flush();
    const res = await closeClinic(
      env.ctx,
      ADMIN,
      at(SAT, '00:00'),
      at('2026-10-04', '00:00'),
      'Tropical storm warning',
    );
    await flush();
    expect(res.cancelled).toBe(2);
    const t10 = mp.byTemplate('T10');
    expect(t10).toHaveLength(3);
    expect(t10[0].body).toContain('Wellness Ave is closed on 3 October 2026 (Tropical storm warning)');
    expect(mp.byTemplate('T8')).toHaveLength(0);
  });

  it('S3 provider agenda at 07:00 AST on clinic days, once per provider', async () => {
    const g = await guardian(env.db, 'A');
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    const r = await createRequest(env.ctx, g, fu(kid, at(FRI, '10:00')));
    await confirm(env.ctx, ADMIN, r.appointmentId);
    env.clock.now = at(FRI, '06:55');
    expect(await providerAgendas(env.ctx)).toBe(0);
    env.clock.now = at(FRI, '07:00');
    await runCron('agenda');
    env.clock.now = at(FRI, '07:05');
    await runCron('agenda');
    const s3 = mp.byTemplate('S3');
    expect(s3).toHaveLength(1);
    expect(s3[0].body).toContain("today's schedule: 1 visits. First at 10:00 AM");
    env.clock.now = at('2026-10-01', '07:00'); // Thursday — not a clinic day
    expect(await providerAgendas(env.ctx)).toBe(0);
  });

  it('cron endpoints require the CRON_SECRET bearer token', async () => {
    expect((await runCron('expire', 'Bearer wrong')).status).toBe(401);
    expect((await runCron('expire', '')).status).toBe(401);
    expect((await runCron('nope')).status).toBe(404);
    expect((await runCron('expire')).status).toBe(200);
  });
});

describe('WhatsApp webhook', () => {
  it('rejects missing or wrong X-Hub-Signature-256; verifies the GET handshake', async () => {
    expect((await postWhatsApp({ entry: [] }, 'sha256=deadbeef')).status).toBe(401);
    expect((await postWhatsApp({ entry: [] }, '')).status).toBe(401);
    const tampered = await waHook.POST(
      new NextRequest(`${BASE}/api/webhooks/whatsapp`, {
        method: 'POST',
        body: JSON.stringify({ entry: [1] }),
        headers: {
          'x-hub-signature-256':
            'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET!).update('{"entry":[]}').digest('hex'),
        },
      }),
    );
    expect(tampered.status).toBe(401);
    const ok = await waHook.GET(
      new NextRequest(
        `${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=42`,
      ),
    );
    expect(await ok.text()).toBe('42');
    expect(
      (
        await waHook.GET(
          new NextRequest(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42`),
        )
      ).status,
    ).toBe(403);
  });

  it('notify-only guardians: buttons are ignored with a polite reply and nothing changes', async () => {
    const [p, co] = [await guardian(env.db, 'P'), await guardian(env.db, 'Co')];
    const kid = await child(env.db, 'Kid', [{ g: p, canBook: true }, { g: co }]);
    const r = await createRequest(env.ctx, p, fu(kid, at(FRI, '09:00')));
    await proposeAlternate(env.ctx, ADMIN, r.appointmentId, at(FRI, '13:00'));
    await flush();
    const cop = await phoneOf(co);
    for (const payload of [`ACCEPT:${r.appointmentId}`, `RESCHEDULE:${r.appointmentId}`, `ATTEND:${r.appointmentId}`]) {
      await postWhatsApp(waInbound(cop, { type: 'button', button: { payload } }));
      expect(mp.to(cop).at(-1)!.body).toMatch(/Only the primary contact can change this appointment/);
    }
    expect((await env.db.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } })).status).toBe(
      'ALTERNATE_PROPOSED',
    );
    // The primary's Accept works.
    await postWhatsApp(
      waInbound(await phoneOf(p), { type: 'button', button: { payload: `ACCEPT:${r.appointmentId}` } }),
    );
    expect((await env.db.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } })).status).toBe('CONFIRMED');
    expect(mp.byTemplate('T3')).toHaveLength(2);
    // A stranger's forged payload reveals nothing.
    const stranger = await guardian(env.db, 'Stranger');
    await postWhatsApp(
      waInbound(await phoneOf(stranger), { type: 'button', button: { payload: `VIEW:${r.appointmentId}` } }),
    );
    expect(mp.to(await phoneOf(stranger)).at(-1)!.body).toMatch(/no longer available/);
  });

  it('text or image after T1 becomes a payment proof for review, never auto-paid; duplicates ignored', async () => {
    const g = await guardian(env.db, 'Payer');
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    const gp = await phoneOf(g);
    await postWhatsApp(waInbound(gp, { type: 'text', text: { body: 'hello?' } })); // before any T1 → ignored
    expect(await env.db.paymentProof.count()).toBe(0);
    const r = await createRequest(env.ctx, g, fu(kid, at(FRI, '09:00')));
    await flush();
    const img = waInbound(gp, { type: 'image', image: { id: 'media-1', caption: 'Transfer done' } });
    await postWhatsApp(img);
    await postWhatsApp(img); // Meta redelivery
    await postWhatsApp(waInbound(gp, { type: 'text', text: { body: 'NCBA ref 99812' } }));
    const proofs = await env.db.paymentProof.findMany({ orderBy: { receivedAt: 'asc' } });
    expect(proofs).toHaveLength(2);
    expect(proofs[0]).toMatchObject({ appointmentId: r.appointmentId, text: 'Transfer done', reviewedAt: null });
    expect(proofs[0].fileKey).toMatch(new RegExp(`^proofs/${r.appointmentId}/.+\\.png$`));
    expect(proofs[1].text).toBe('NCBA ref 99812');
    expect((await env.db.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } })).paymentStatus).toBe(
      'UNPAID',
    );
    expect(mp.to(gp).at(-1)!.body).toContain(`received your payment details for ${r.ref}`);
  });
});

describe('Twilio webhook', () => {
  it('rejects a missing or wrong X-Twilio-Signature', async () => {
    expect((await postSms({ MessageSid: 'SM1', MessageStatus: 'delivered' }, 'bad')).status).toBe(401);
    expect((await postSms({ MessageSid: 'SM1', MessageStatus: 'delivered' }, '')).status).toBe(401);
  });

  it('records status callbacks and handles YES / STOP replies', async () => {
    const co = await guardian(env.db, 'Co', { whatsapp: false });
    const p = await guardian(env.db, 'P', { whatsapp: false });
    const kid = await child(env.db, 'Kid', [{ g: p, canBook: true }, { g: co }]);
    await createRequest(env.ctx, p, fu(kid, at(FRI, '09:00')));
    await flush();
    const cop = await phoneOf(co);
    const sms = mp.to(cop)[0];
    expect((await postSms({ MessageSid: sms.id, MessageStatus: 'delivered', SmsStatus: 'delivered' })).status).toBe(
      200,
    );
    expect((await env.db.message.findFirstOrThrow({ where: { providerMessageId: sms.id } })).status).toBe('DELIVERED');
    // T9 asked them to reply YES by SMS → WhatsApp from now on.
    await postSms({ MessageSid: 'SMin1', From: cop, Body: 'Yes', SmsStatus: 'received', NumMedia: '0' });
    expect((await env.db.guardian.findUniqueOrThrow({ where: { id: co } })).whatsappOptInAt).not.toBeNull();
    expect(mp.to(cop).at(-1)).toMatchObject({ channel: 'SMS', body: expect.stringMatching(/on WhatsApp/) });
    await postSms({ MessageSid: 'SMin2', From: cop, Body: 'STOP', SmsStatus: 'received', NumMedia: '0' });
    expect((await env.db.guardian.findUniqueOrThrow({ where: { id: co } })).smsOptOutAt).not.toBeNull();
  });

  it('SMS opt-out skips SMS updates for guardians without WhatsApp', async () => {
    const g = await guardian(env.db, 'A', { whatsapp: false });
    await exec(env.db, 'UPDATE guardian SET sms_opt_out_at = now() WHERE id = $1::uuid', g);
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    await createRequest(env.ctx, g, fu(kid, at(FRI, '09:00')));
    const res = await flush();
    expect(res.skipped).toBe(1);
    expect(mp.to(await phoneOf(g))).toHaveLength(0);
  });
});

describe('single scheduler endpoint', () => {
  it('/api/cron/all runs expiry, reminders, agenda, waitlist and retention, then flushes the outbox', async () => {
    const g = await guardian(env.db, 'A');
    const kid = await child(env.db, 'Kid', [{ g, canBook: true }]);
    const r = await createRequest(env.ctx, g, fu(kid, at(SAT, '09:00')));
    await confirm(env.ctx, ADMIN, r.appointmentId);
    env.clock.now = new Date(at(SAT, '09:00').getTime() - 20 * 3600000);
    const res = await (await runCron('all')).json();
    expect(res).toMatchObject({ job: 'all', reminders: { reminders: 1 }, expire: { expired: 0 } });
    expect(mp.byTemplate('T6')).toHaveLength(1);
  });
});
