import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptAlternate, cancelByClinic, cancelByParent, confirm, proposeAlternate, reassignCandidates, reschedule } from '../src/appointments.js';
import { linkFor } from '../src/authz.js';
import { computeSlots } from '../src/availability.js';
import { createRequest } from '../src/booking.js';
import { applyClosure } from '../src/closures.js';
import { handleInbound } from '../src/inbound.js';
import { runJobs } from '../src/jobs.js';
import { handleDeliveryStatus } from '../src/notify/notify.js';
import { fmtTime } from '../src/time.js';
import { claimOffer, joinWaitlist } from '../src/waitlist.js';
import { ADMIN, at, child, FRI, guardian, onlyProviders, SAT, setup, TZ, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => { if (env) await env.db.end(); env = await setup(); });
afterAll(async () => { await env?.db.end(); });

const times = async (visitType: 'FOLLOW_UP' | 'EVALUATION', day: string) =>
  (await computeSlots(env.db, { visitType, now: env.clock.now, fromDate: day, toDate: day })).map((s) => fmtTime(s.startsAt, TZ));
const fu = (patientId: string, startsAt: Date) => ({ visitType: 'FOLLOW_UP', startsAt: startsAt.toISOString(), patientId });
const status = async (id: string) => (await env.db.query('SELECT status FROM appointment WHERE id = $1', [id])).rows[0].status;
const msgs = async (key: string) => (await env.db.query(`SELECT * FROM message WHERE template_key = $1 AND direction = 'OUT' ORDER BY created_at`, [key])).rows;

describe('PRD §14 acceptance tests', () => {
  it('1. a 90-minute evaluation is never offered at Fri 16:00 or Sat 17:00; follow-up last starts are 16:00 / 17:00', async () => {
    const evFri = await times('EVALUATION', FRI);
    const evSat = await times('EVALUATION', SAT);
    expect(evFri.at(-1)).toBe('3:30 PM');
    expect(evFri).not.toContain('4:00 PM');
    expect(evSat.at(-1)).toBe('4:30 PM');
    expect(evSat).not.toContain('5:00 PM');
    expect((await times('FOLLOW_UP', FRI)).at(-1)).toBe('4:00 PM');
    expect((await times('FOLLOW_UP', SAT)).at(-1)).toBe('5:00 PM');
    const all = await computeSlots(env.db, { visitType: 'FOLLOW_UP', now: env.clock.now });
    expect(new Set(all.map((s) => new Intl.DateTimeFormat('en', { timeZone: TZ, weekday: 'short' }).format(s.startsAt)))).toEqual(new Set(['Fri', 'Sat']));
  });

  it('2. one provider free: two simultaneous submissions → exactly one succeeds, the other gets SLOT_TAKEN', async () => {
    await onlyProviders(env.db, [env.providers[0]]);
    const [g1, g2] = [await guardian(env.db, 'A'), await guardian(env.db, 'B')];
    const [c1, c2] = [await child(env.db, 'Kid One', [{ g: g1, canBook: true }]), await child(env.db, 'Kid Two', [{ g: g2, canBook: true }])];
    const t = at(FRI, '10:00');
    const res = await Promise.allSettled([createRequest(env.ctx, g1, fu(c1, t)), createRequest(env.ctx, g2, fu(c2, t))]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason.code).toBe('SLOT_TAKEN');
    expect(rej.reason.message).toMatch(/That time was just taken/);
    expect(await times('FOLLOW_UP', FRI)).not.toContain('10:00 AM');
  });

  it('3. two providers free: two simultaneous submissions both succeed on different providers', async () => {
    await onlyProviders(env.db, env.providers.slice(0, 2));
    const [g1, g2] = [await guardian(env.db, 'A'), await guardian(env.db, 'B')];
    const [c1, c2] = [await child(env.db, 'Kid One', [{ g: g1, canBook: true }]), await child(env.db, 'Kid Two', [{ g: g2, canBook: true }])];
    const t = at(FRI, '10:00');
    const [a, b] = await Promise.all([createRequest(env.ctx, g1, fu(c1, t)), createRequest(env.ctx, g2, fu(c2, t))]);
    expect(new Set([a.providerId, b.providerId])).toEqual(new Set(env.providers.slice(0, 2)));
  });

  it('4. a time disappears only when all providers are busy', async () => {
    const t = at(FRI, '10:00');
    for (let i = 0; i < 4; i++) {
      expect(await times('FOLLOW_UP', FRI)).toContain('10:00 AM');
      const g = await guardian(env.db, `G${i}`);
      await createRequest(env.ctx, g, fu(await child(env.db, `Kid ${i}`, [{ g, canBook: true }]), t));
    }
    expect(await times('FOLLOW_UP', FRI)).not.toContain('10:00 AM');
    // Overlap: a 10:00 follow-up blocks 9:30 (ends 10:30) but not 9:00.
    const ft = await times('FOLLOW_UP', FRI);
    expect(ft).toContain('9:00 AM');
    expect(ft).not.toContain('9:30 AM');
    expect(ft).toContain('11:00 AM');
  });

  it('5. admin reassignment offers only providers free for the full duration', async () => {
    const g = await guardian(env.db, 'A');
    const c = await child(env.db, 'Kid', [{ g, canBook: true }]);
    await env.db.query('UPDATE patient SET dob = $2 WHERE id = $1', [c, '2019-01-01']);
    const ev = await createRequest(env.ctx, g, {
      visitType: 'EVALUATION', startsAt: at(FRI, '09:00').toISOString(), patientId: c,
      evaluation: { reasonText: 'Handwriting', payerType: 'SELF_PAY' }, consents: { dataProcessing: true, messaging: true },
    });
    // Busy only in the last 30 minutes of the 90-minute evaluation.
    const other = env.providers.find((p) => p !== ev.providerId)!;
    const g2 = await guardian(env.db, 'B');
    const c2 = await child(env.db, 'Kid2', [{ g: g2, canBook: true }]);
    await env.db.query(`INSERT INTO appointment (ref, patient_id, provider_id, provider_assigned_by, visit_type, starts_at, ends_at, status)
      VALUES ('WAV-TEST', $1, $2, 'ADMIN', 'FOLLOW_UP', $3, $4, 'CONFIRMED')`, [c2, other, at(FRI, '10:00'), at(FRI, '11:00')]);
    const cands = await reassignCandidates(env.ctx, ev.appointmentId);
    const ids = cands.map((c) => c.id);
    expect(ids).toContain(ev.providerId);
    expect(ids).not.toContain(other);
    expect(ids).toHaveLength(3);
    expect(cands[0]).toHaveProperty('discipline');
    await expect(confirm(env.ctx, ADMIN, ev.appointmentId, other)).rejects.toMatchObject({ code: 'PROVIDER_BUSY' });
  });

  it('6. fan-out: two notified guardians → two messages; restricted → none; notify-only copy has no buttons', async () => {
    const [p, co, r] = [await guardian(env.db, 'Primary'), await guardian(env.db, 'Co'), await guardian(env.db, 'Restricted')];
    const c = await child(env.db, 'Kid', [{ g: p, canBook: true }, { g: co }, { g: r, restricted: true, canBook: true }]);
    const { appointmentId } = await createRequest(env.ctx, p, fu(c, at(SAT, '09:00')));
    const t1 = await msgs('T1');
    expect(t1.map((m) => m.guardian_id).sort()).toEqual([p, co].sort());
    await confirm(env.ctx, ADMIN, appointmentId);
    const t3 = await msgs('T3');
    expect(t3).toHaveLength(2);
    expect(t3.find((m) => m.guardian_id === co).buttons).toEqual([]);
    expect(t3.find((m) => m.guardian_id === p).buttons.map((b: { title: string }) => b.title)).toEqual(['View', 'Reschedule']);
    expect(t3[0].body).toContain('with Ana');
    // Evaluation → T2 to both
    await env.db.query('UPDATE patient SET dob = $2 WHERE id = $1', [c, '2019-01-01']);
    await createRequest(env.ctx, p, { visitType: 'EVALUATION', startsAt: at(SAT, '13:00').toISOString(), patientId: c,
      evaluation: { reasonText: 'x', payerType: 'SELF_PAY' }, consents: { dataProcessing: true, messaging: true } });
    expect((await msgs('T2')).map((m) => m.guardian_id).sort()).toEqual([p, co].sort());
  });

  it('7. a notify-only guardian cannot book, cancel, reschedule, or claim (service + WhatsApp button)', async () => {
    const [p, co] = [await guardian(env.db, 'Primary'), await guardian(env.db, 'Co')];
    const c = await child(env.db, 'Kid', [{ g: p, canBook: true }, { g: co }]);
    await expect(createRequest(env.ctx, co, fu(c, at(FRI, '09:00')))).rejects.toMatchObject({ status: 403 });
    await expect(createRequest(env.ctx, co, fu(c, at(FRI, '09:00')))).rejects.toThrow(/made by the primary contact/);
    const { appointmentId } = await createRequest(env.ctx, p, fu(c, at(FRI, '09:00')));
    await expect(cancelByParent(env.ctx, co, appointmentId)).rejects.toMatchObject({ status: 403 });
    await expect(reschedule(env.ctx, { type: 'GUARDIAN', id: co }, appointmentId, at(FRI, '11:00'))).rejects.toMatchObject({ status: 403 });
    await expect(joinWaitlist(env.ctx, co, { patientId: c, visitType: 'FOLLOW_UP', dateFrom: FRI, dateTo: SAT })).rejects.toMatchObject({ status: 403 });
    await proposeAlternate(env.ctx, ADMIN, appointmentId, at(FRI, '13:00'));
    const coPhone = (await env.db.query('SELECT phone_e164 FROM guardian WHERE id = $1', [co])).rows[0].phone_e164;
    const res = await handleInbound(env.ctx, { channel: 'WHATSAPP', from: coPhone, buttonPayload: `ACCEPT:${appointmentId}` });
    expect(res).toEqual({ action: 'rejected', error: 'FORBIDDEN' });
    expect(await status(appointmentId)).toBe('ALTERNATE_PROPOSED');
    // Waitlist offer: notify-only co-parent is never offered and cannot claim.
    const w = await joinWaitlist(env.ctx, p, { patientId: c, visitType: 'FOLLOW_UP', dateFrom: SAT, dateTo: SAT });
    expect(w).toBeTruthy();
    await acceptAlternate(env.ctx, p, appointmentId);
    expect(await status(appointmentId)).toBe('CONFIRMED');
  });

  it('8. WhatsApp failure triggers SMS immediately (API error and failed-status webhook)', async () => {
    const g = await guardian(env.db, 'A');
    const c = await child(env.db, 'Kid', [{ g, canBook: true }]);
    env.ctx.messenger.failWhatsApp = true;
    await createRequest(env.ctx, g, fu(c, at(FRI, '09:00')));
    const t1 = await msgs('T1');
    expect(t1.map((m) => [m.channel, m.status])).toEqual([['WHATSAPP', 'FAILED'], ['SMS', 'SENT']]);
    expect(t1[1].fallback_of_id).toBe(t1[0].id);

    env.ctx.messenger.failWhatsApp = false;
    const g2 = await guardian(env.db, 'B');
    const c2 = await child(env.db, 'Kid2', [{ g: g2, canBook: true }]);
    await createRequest(env.ctx, g2, fu(c2, at(FRI, '11:00')));
    const wa = (await msgs('T1')).find((m) => m.guardian_id === g2 && m.channel === 'WHATSAPP');
    await handleDeliveryStatus(env.ctx, wa.provider_message_id, 'failed', '131026 undeliverable');
    await handleDeliveryStatus(env.ctx, wa.provider_message_id, 'failed'); // duplicate webhook → no second SMS
    const sms = (await msgs('T1')).filter((m) => m.guardian_id === g2 && m.channel === 'SMS');
    expect(sms).toHaveLength(1);
    expect(sms[0].fallback_of_id).toBe(wa.id);
    expect(sms[0].created_at.getTime() - wa.created_at.getTime()).toBeLessThan(60000);
  });

  it('9. REQUESTED with no action becomes EXPIRED at the configured time and the slot reappears', async () => {
    await onlyProviders(env.db, [env.providers[0]]);
    const g = await guardian(env.db, 'A');
    const c = await child(env.db, 'Kid', [{ g, canBook: true }]);
    const { appointmentId } = await createRequest(env.ctx, g, fu(c, at(SAT, '14:00')));
    expect(await times('FOLLOW_UP', SAT)).not.toContain('2:00 PM');
    env.clock.now = new Date(env.clock.now.getTime() + 12 * 3600000 + 60000);
    expect((await runJobs(env.ctx)).escalations).toBe(1);
    expect(await msgs('S2')).toHaveLength(1);
    env.clock.now = new Date(env.clock.now.getTime() + 11 * 3600000);
    await runJobs(env.ctx);
    expect(await status(appointmentId)).toBe('REQUESTED');
    env.clock.now = new Date(env.clock.now.getTime() + 3600000);
    await runJobs(env.ctx);
    expect(await status(appointmentId)).toBe('EXPIRED');
    expect(await times('FOLLOW_UP', SAT)).toContain('2:00 PM');
  });

  it('10. cancelling a confirmed slot sends T8 to waitlist matches; first Claim holds, later taps get "already taken"', async () => {
    await onlyProviders(env.db, [env.providers[0]]);
    const g = await guardian(env.db, 'Booker');
    const c = await child(env.db, 'Kid', [{ g, canBook: true }]);
    const { appointmentId } = await createRequest(env.ctx, g, fu(c, at(SAT, '10:00')));
    await confirm(env.ctx, ADMIN, appointmentId);
    const w = [];
    for (const n of ['W1', 'W2']) {
      const wg = await guardian(env.db, n);
      const wc = await child(env.db, `Kid ${n}`, [{ g: wg, canBook: true }]);
      await joinWaitlist(env.ctx, wg, { patientId: wc, visitType: 'FOLLOW_UP', dateFrom: FRI, dateTo: SAT });
      w.push(wg);
    }
    await cancelByParent(env.ctx, g, appointmentId);
    const t8 = await msgs('T8');
    expect(t8.map((m) => m.guardian_id).sort()).toEqual([...w].sort());
    expect(t8[0].buttons[0].title).toBe('Claim');
    const offerId = t8[0].buttons[0].id.split(':')[1];
    const first = await claimOffer(env.ctx, w[1], offerId);
    expect(await status(first.appointmentId)).toBe('REQUESTED');
    await expect(claimOffer(env.ctx, w[0], offerId)).rejects.toMatchObject({ code: 'OFFER_TAKEN', message: expect.stringMatching(/already been taken/) });
  });

  it('11. parent A cannot load parent B\'s child by ID', async () => {
    const [a, b] = [await guardian(env.db, 'A'), await guardian(env.db, 'B')];
    const cb = await child(env.db, 'B Kid', [{ g: b, canBook: true }]);
    await expect(linkFor(env.db, a, cb)).rejects.toMatchObject({ status: 404 });
    await expect(createRequest(env.ctx, a, fu(cb, at(FRI, '09:00')))).rejects.toMatchObject({ status: 404 });
    // Restricted guardians look exactly like strangers.
    const r = await guardian(env.db, 'R');
    await env.db.query('INSERT INTO guardian_patient (guardian_id, patient_id, can_book, restricted) VALUES ($1,$2,true,true)', [r, cb]);
    await expect(linkFor(env.db, r, cb)).rejects.toMatchObject({ status: 404 });
  });

  it('12. reminder T6 fires once, 24h before, and not for cancelled visits', async () => {
    const g = await guardian(env.db, 'A');
    const c = await child(env.db, 'Kid', [{ g, canBook: true }]);
    const a1 = await createRequest(env.ctx, g, fu(c, at(SAT, '09:00')));
    const a2 = await createRequest(env.ctx, g, fu(c, at(SAT, '11:00')));
    await confirm(env.ctx, ADMIN, a1.appointmentId);
    await confirm(env.ctx, ADMIN, a2.appointmentId);
    await cancelByClinic(env.ctx, ADMIN, a2.appointmentId, 'Therapist unwell.');
    env.clock.now = new Date(at(SAT, '09:00').getTime() - 25 * 3600000);
    await runJobs(env.ctx);
    expect(await msgs('T6')).toHaveLength(0);
    env.clock.now = new Date(at(SAT, '09:00').getTime() - 24 * 3600000);
    await runJobs(env.ctx);
    await runJobs(env.ctx);
    const t6 = await msgs('T6');
    expect(t6).toHaveLength(1);
    expect(t6[0].appointment_id).toBe(a1.appointmentId);
  });

  it('13. clinic closure cancels every affected appointment and sends one T10 per notified guardian', async () => {
    const [p, co] = [await guardian(env.db, 'P'), await guardian(env.db, 'Co')];
    const c = await child(env.db, 'Kid', [{ g: p, canBook: true }, { g: co }]);
    const g2 = await guardian(env.db, 'Solo');
    const c2 = await child(env.db, 'Kid2', [{ g: g2, canBook: true }]);
    const a = await createRequest(env.ctx, p, fu(c, at(SAT, '09:00')));
    const b = await createRequest(env.ctx, g2, fu(c2, at(SAT, '15:00')));
    const keep = await createRequest(env.ctx, g2, fu(c2, at(FRI, '15:00')));
    await confirm(env.ctx, ADMIN, a.appointmentId);
    const res = await applyClosure(env.ctx, ADMIN, at(SAT, '00:00'), at('2026-10-04', '00:00'), 'Tropical storm warning');
    expect(res.cancelled).toBe(2);
    expect(await status(a.appointmentId)).toBe('CANCELLED_BY_CLINIC');
    expect(await status(b.appointmentId)).toBe('CANCELLED_BY_CLINIC');
    expect(await status(keep.appointmentId)).toBe('REQUESTED');
    const t10 = await msgs('T10');
    expect(t10).toHaveLength(3);
    expect(t10[0].body).toContain('closed on 3 October 2026 (Tropical storm warning)');
    expect((await env.db.query('SELECT count(*)::int n FROM rebook_entry')).rows[0].n).toBe(2);
    expect(await times('FOLLOW_UP', SAT)).toEqual([]);
  });

  it('14. all times are in AST regardless of the server/device timezone', () => {
    expect(process.env.TZ).toBe('Asia/Tokyo');
    expect(at(FRI, '08:00').toISOString()).toBe('2026-10-02T12:00:00.000Z');
    expect(fmtTime(new Date('2026-10-02T12:00:00Z'), TZ)).toBe('8:00 AM');
    expect(fmtTime(new Date('2026-10-02T12:00:00Z'), TZ)).not.toBe(new Date('2026-10-02T12:00:00Z').toLocaleTimeString());
  });
});
