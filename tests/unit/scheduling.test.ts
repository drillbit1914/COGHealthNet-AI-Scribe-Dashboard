import { beforeEach, describe, expect, it } from 'vitest';
import { formatInTimeZone } from 'date-fns-tz';
import {
  ALL_STATUSES,
  cancel,
  canTransition,
  complete,
  confirm,
  createRequest,
  decline,
  expire,
  escalate,
  markNoShow,
  proposeAlternate,
  reassignCandidates,
  reassignProvider,
  TRANSITIONS,
  type Status,
} from '@/server/appointments';
import { getPooledSlots, getProviderSlots } from '@/server/availability';
import { exec } from '@/server/db';
import { InvalidTransitionError, SlotTakenError } from '@/server/errors';
import { fmtTime } from '@/server/time';
import {
  ADMIN,
  at,
  child,
  FRI,
  guardian,
  onlyProviders,
  outbox,
  SAT,
  setup,
  status,
  TZ,
  type TestEnv,
} from './helpers';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});

const times = async (visitType: 'FOLLOW_UP' | 'EVALUATION', day: string) =>
  (await getPooledSlots(env.db, { visitType, now: env.clock.now, from: day, to: day })).map((s) =>
    fmtTime(s.startsAt, TZ),
  );
const fu = (patientId: string, startsAt: Date) => ({
  visitType: 'FOLLOW_UP',
  startsAt: startsAt.toISOString(),
  patientId,
});
async function family(name: string) {
  const g = await guardian(env.db, name);
  return { g, c: await child(env.db, `${name} Kid`, [{ g, canBook: true }], '2019-05-01') };
}

describe('availability (PRD §4)', () => {
  it('AC 1: a 90-minute evaluation is never offered at Fri 16:00 or Sat 17:00', async () => {
    const evFri = await times('EVALUATION', FRI);
    const evSat = await times('EVALUATION', SAT);
    expect(evFri[0]).toBe('8:00 AM');
    expect(evFri.at(-1)).toBe('3:30 PM');
    expect(evFri).not.toContain('4:00 PM');
    expect(evSat.at(-1)).toBe('4:30 PM');
    expect(evSat).not.toContain('5:00 PM');
    expect((await times('FOLLOW_UP', FRI)).at(-1)).toBe('4:00 PM');
    expect((await times('FOLLOW_UP', SAT)).at(-1)).toBe('5:00 PM');
    const all = await getPooledSlots(env.db, { visitType: 'FOLLOW_UP', now: env.clock.now });
    expect(new Set(all.map((s) => formatInTimeZone(s.startsAt, TZ, 'EEE')))).toEqual(new Set(['Fri', 'Sat']));
  });

  it('respects min notice (12h), horizon (28 days), buffer, and clinic/provider time off', async () => {
    env.clock.now = at(FRI, '00:00'); // Fri 08:00–11:30 falls inside the 12-hour notice window
    expect((await times('FOLLOW_UP', FRI))[0]).toBe('12:00 PM');
    const all = await getPooledSlots(env.db, { visitType: 'FOLLOW_UP', now: NOWPLUS() });
    const last = all.at(-1)!.startsAt.getTime();
    expect(last).toBeLessThanOrEqual(NOWPLUS().getTime() + 29 * 86400000);
    env.clock.now = new Date('2026-10-01T12:00:00Z');
    await env.db.timeOff.create({
      data: { startsAt: at(SAT, '12:00'), endsAt: at(SAT, '14:00'), reason: 'Staff meeting' },
    });
    const sat = await times('FOLLOW_UP', SAT);
    expect(sat).toContain('11:00 AM');
    expect(sat).not.toContain('11:30 AM');
    expect(sat).not.toContain('1:00 PM');
    expect(sat).toContain('2:00 PM');
    // Provider-level time off for three providers leaves the time open on the fourth.
    for (const p of env.providers.slice(0, 3))
      await env.db.timeOff.create({ data: { providerId: p, startsAt: at(SAT, '15:00'), endsAt: at(SAT, '16:00') } });
    expect(await times('FOLLOW_UP', SAT)).toContain('3:00 PM');
    const provSlots = await getProviderSlots(env.db, {
      visitType: 'FOLLOW_UP',
      providerId: env.providers[0],
      from: SAT,
      to: SAT,
    });
    expect(provSlots.map((s) => fmtTime(s.startsAt, TZ))).not.toContain('3:00 PM');
  });

  it('applies {{BUFFER_MIN}} between visits for the same provider', async () => {
    await onlyProviders(env.db, [env.providers[0]]);
    await exec(env.db, `UPDATE clinic_settings SET settings = settings || '{"BUFFER_MIN": 15}'`);
    const { g, c } = await family('Buf');
    await createRequest(env.ctx, g, fu(c, at(FRI, '10:00')));
    const fri = await times('FOLLOW_UP', FRI);
    expect(fri).toContain('8:30 AM');
    expect(fri).not.toContain('9:00 AM'); // would end 10:00, inside the 15-minute buffer
    expect(fri).not.toContain('11:00 AM');
    expect(fri).toContain('11:30 AM');
  });

  it('AC 4: a time disappears only when all providers are busy', async () => {
    const t = at(FRI, '10:00');
    for (let i = 0; i < 4; i++) {
      expect(await times('FOLLOW_UP', FRI)).toContain('10:00 AM');
      const { g, c } = await family(`G${i}`);
      await createRequest(env.ctx, g, fu(c, t));
    }
    const fri = await times('FOLLOW_UP', FRI);
    expect(fri).not.toContain('10:00 AM');
    expect(fri).not.toContain('9:30 AM'); // overlaps 10:00–11:00 on every provider
    expect(fri).toContain('9:00 AM');
    expect(fri).toContain('11:00 AM');
  });

  it('AC 14: all times render in AST regardless of the machine timezone', () => {
    expect(process.env.TZ).toBe('Asia/Tokyo');
    expect(at(FRI, '08:00').toISOString()).toBe('2026-10-02T12:00:00.000Z');
    expect(fmtTime(new Date('2026-10-02T12:00:00Z'), TZ)).toBe('8:00 AM');
    expect(new Date('2026-10-02T12:00:00Z').getHours()).toBe(21); // Tokyo wall clock, proving isolation
  });
});
const NOWPLUS = () => new Date('2026-10-01T12:00:00Z');

describe('tentative assignment and concurrency (PRD §4, §11)', () => {
  it('assigns the least-loaded provider, ties broken by provider order', async () => {
    const a = await family('A');
    const r1 = await createRequest(env.ctx, a.g, fu(a.c, at(FRI, '09:00')));
    expect(r1.providerId).toBe(env.providers[0]);
    const r2 = await createRequest(env.ctx, a.g, fu(a.c, at(FRI, '13:00')));
    expect(r2.providerId).toBe(env.providers[1]); // Ana already has one booking that day
  });

  it('AC 2: one provider free — two concurrent submissions: exactly one succeeds, the other gets SlotTakenError', async () => {
    await onlyProviders(env.db, [env.providers[0]]);
    const [a, b] = [await family('A'), await family('B')];
    const t = at(FRI, '10:00');
    const res = await Promise.allSettled([
      createRequest(env.ctx, a.g, fu(a.c, t)),
      createRequest(env.ctx, b.g, fu(b.c, t)),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(SlotTakenError);
    expect(rej.reason.message).toMatch(/That time was just taken/);
    expect(await times('FOLLOW_UP', FRI)).not.toContain('10:00 AM');
    // The loser's typed child record was rolled back with the failed request.
    expect(await env.db.appointment.count()).toBe(1);
  });

  it('AC 3: two providers free — two concurrent submissions both succeed on different providers', async () => {
    await onlyProviders(env.db, env.providers.slice(0, 2));
    const [a, b] = [await family('A'), await family('B')];
    const t = at(FRI, '10:00');
    const [r1, r2] = await Promise.all([
      createRequest(env.ctx, a.g, fu(a.c, t)),
      createRequest(env.ctx, b.g, fu(b.c, t)),
    ]);
    expect(new Set([r1.providerId, r2.providerId])).toEqual(new Set(env.providers.slice(0, 2)));
  });

  it('the database itself rejects an overlapping hold on the same provider (exclusion constraint)', async () => {
    const a = await family('A');
    const r = await createRequest(env.ctx, a.g, fu(a.c, at(FRI, '10:00')));
    await expect(
      exec(
        env.db,
        `INSERT INTO appointment (ref, patient_id, provider_id, provider_assigned_by, visit_type, starts_at, ends_at, status)
         VALUES ('WAV-XXXX', $1::uuid, $2::uuid, 'ADMIN', 'FOLLOW_UP', $3, $4, 'CONFIRMED')`,
        a.c,
        r.providerId,
        at(FRI, '10:30'),
        at(FRI, '11:30'),
      ),
    ).rejects.toThrow();
  });
});

describe('approval actions (PRD §6, §9)', () => {
  it('AC 5: reassignment offers only providers free for the full duration', async () => {
    const a = await family('A');
    const ev = await createRequest(env.ctx, a.g, {
      visitType: 'EVALUATION',
      startsAt: at(FRI, '09:00').toISOString(),
      patientId: a.c,
      evaluation: { reasonText: 'Handwriting', payerType: 'SELF_PAY' },
    });
    // Busy only in the last 30 minutes of the 90-minute evaluation.
    const other = env.providers.find((p) => p !== ev.providerId)!;
    const b = await family('B');
    await exec(
      env.db,
      `INSERT INTO appointment (ref, patient_id, provider_id, provider_assigned_by, visit_type, starts_at, ends_at, status)
       VALUES ('WAV-TEST', $1::uuid, $2::uuid, 'ADMIN', 'FOLLOW_UP', $3, $4, 'CONFIRMED')`,
      b.c,
      other,
      at(FRI, '10:00'),
      at(FRI, '11:00'),
    );
    const cands = await reassignCandidates(env.ctx, ev.appointmentId);
    expect(cands.map((c) => c.id)).not.toContain(other);
    expect(cands).toHaveLength(3);
    expect(cands.find((c) => c.suggested)!.id).toBe(ev.providerId);
    expect(cands[0].discipline).toMatch(/OT|PT/);
    await expect(reassignProvider(env.ctx, ADMIN, ev.appointmentId, other)).rejects.toMatchObject({
      code: 'PROVIDER_BUSY',
    });
    const free = cands.find((c) => !c.suggested)!.id;
    await confirm(env.ctx, ADMIN, ev.appointmentId, free);
    const appt = await env.db.appointment.findUniqueOrThrow({ where: { id: ev.appointmentId } });
    expect(appt).toMatchObject({ status: 'CONFIRMED', providerId: free, providerAssignedBy: 'ADMIN' });
  });

  it('AC 9: REQUESTED with no action becomes EXPIRED at the configured time and the slot reappears', async () => {
    await onlyProviders(env.db, [env.providers[0]]);
    const a = await family('A');
    const r = await createRequest(env.ctx, a.g, fu(a.c, at(SAT, '14:00')));
    expect(await times('FOLLOW_UP', SAT)).not.toContain('2:00 PM');
    env.clock.now = new Date(env.clock.now.getTime() + 12 * 3600000 + 60000);
    expect(await escalate(env.ctx)).toBe(1); // S2 at 50% of the expiry window
    expect(await escalate(env.ctx)).toBe(0);
    env.clock.now = new Date(env.clock.now.getTime() + 11 * 3600000);
    expect(await expire(env.ctx)).toBe(0);
    env.clock.now = new Date(env.clock.now.getTime() + 3600000);
    expect(await expire(env.ctx)).toBe(1);
    expect(await status(env.db, r.appointmentId)).toBe('EXPIRED');
    expect(await times('FOLLOW_UP', SAT)).toContain('2:00 PM');
    expect(await outbox(env.db, 'T4')).toHaveLength(1);
    const audit = await env.db.auditLog.findMany({ where: { entityId: r.appointmentId } });
    expect(audit.map((x) => x.action)).toEqual(['request', 'status:EXPIRED']);
  });

  it('decline requires a reason; propose alternate moves the hold and frees the original time', async () => {
    await onlyProviders(env.db, [env.providers[0]]);
    const a = await family('A');
    const r = await createRequest(env.ctx, a.g, fu(a.c, at(FRI, '09:00')));
    await expect(decline(env.ctx, ADMIN, r.appointmentId, ' ')).rejects.toMatchObject({ status: 400 });
    await proposeAlternate(env.ctx, ADMIN, r.appointmentId, at(FRI, '14:00'));
    const fri = await times('FOLLOW_UP', FRI);
    expect(fri).toContain('9:00 AM');
    expect(fri).not.toContain('2:00 PM');
    const appt = await env.db.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } });
    expect(appt.status).toBe('ALTERNATE_PROPOSED');
    expect(appt.originalStartsAt).toEqual(at(FRI, '09:00'));
  });

  it('provider cannot approve unless PROVIDER_CAN_APPROVE; providers mark only their own visits', async () => {
    const a = await family('A');
    const r = await createRequest(env.ctx, a.g, fu(a.c, at(FRI, '09:00')));
    const own = { type: 'STAFF' as const, id: ADMIN.id, role: 'PROVIDER' as const, providerId: r.providerId };
    const other = { ...own, providerId: env.providers[3] };
    await expect(confirm(env.ctx, own, r.appointmentId)).rejects.toMatchObject({ status: 403 });
    await exec(env.db, `UPDATE clinic_settings SET settings = settings || '{"PROVIDER_CAN_APPROVE": true}'`);
    await expect(confirm(env.ctx, other, r.appointmentId)).rejects.toMatchObject({ status: 403 });
    await confirm(env.ctx, own, r.appointmentId);
    await expect(markNoShow(env.ctx, other, r.appointmentId)).rejects.toMatchObject({ status: 403 });
    await complete(env.ctx, own, r.appointmentId);
    expect(await status(env.db, r.appointmentId)).toBe('COMPLETED');
  });
});

describe('status machine (PRD §6)', () => {
  const legal: [Status, Status][] = [
    ['REQUESTED', 'CONFIRMED'],
    ['REQUESTED', 'DECLINED'],
    ['REQUESTED', 'ALTERNATE_PROPOSED'],
    ['REQUESTED', 'EXPIRED'],
    ['REQUESTED', 'CANCELLED_BY_PARENT'],
    ['REQUESTED', 'CANCELLED_BY_CLINIC'],
    ['ALTERNATE_PROPOSED', 'CONFIRMED'],
    ['ALTERNATE_PROPOSED', 'CANCELLED'],
    ['ALTERNATE_PROPOSED', 'CANCELLED_BY_CLINIC'],
    ['CONFIRMED', 'COMPLETED'],
    ['CONFIRMED', 'NO_SHOW'],
    ['CONFIRMED', 'CANCELLED_BY_PARENT'],
    ['CONFIRMED', 'CANCELLED_BY_CLINIC'],
    ['CONFIRMED', 'RESCHEDULED'],
  ];

  it('the transition table is exactly the PRD machine (every other pair is illegal)', () => {
    for (const from of ALL_STATUSES)
      for (const to of ALL_STATUSES) {
        const isLegal = legal.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(isLegal);
      }
    expect(Object.values(TRANSITIONS).flat()).toHaveLength(legal.length);
  });

  it('services reject illegal changes from every terminal state', async () => {
    const a = await family('A');
    const mk = async (hhmm: string) => (await createRequest(env.ctx, a.g, fu(a.c, at(SAT, hhmm)))).appointmentId;
    const declined = await mk('09:00');
    await decline(env.ctx, ADMIN, declined, 'Fully booked');
    await expect(confirm(env.ctx, ADMIN, declined)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(cancel(env.ctx, ADMIN, declined, 'x')).rejects.toBeInstanceOf(InvalidTransitionError);
    const done = await mk('11:00');
    await confirm(env.ctx, ADMIN, done);
    await complete(env.ctx, ADMIN, done);
    await expect(markNoShow(env.ctx, ADMIN, done)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(cancel(env.ctx, { type: 'GUARDIAN', id: a.g }, done)).rejects.toBeInstanceOf(InvalidTransitionError);
    const pending = await mk('13:00');
    await expect(complete(env.ctx, ADMIN, pending)).rejects.toBeInstanceOf(InvalidTransitionError);
    await confirm(env.ctx, ADMIN, pending);
    await expect(confirm(env.ctx, ADMIN, pending)).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});
