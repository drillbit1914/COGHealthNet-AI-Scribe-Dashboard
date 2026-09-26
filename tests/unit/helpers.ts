import { PrismaClient } from '@/generated/prisma/client';
import type { Ctx } from '@/server/context';
import { createPrisma, exec, q } from '@/server/db';
import { seed } from '@/server/seed';
import { localToUtc } from '@/server/time';

export const TZ = 'America/Anguilla';
/** Thursday 1 Oct 2026, 08:00 AST. The next clinic days are Fri 2 Oct and Sat 3 Oct. */
export const NOW = new Date('2026-10-01T12:00:00Z');
export const FRI = '2026-10-02';
export const SAT = '2026-10-03';
export const at = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return localToUtc(day, h * 60 + m, TZ);
};

let shared: PrismaClient | undefined;
export const db = () => (shared ??= createPrisma(process.env.DATABASE_URL));

export interface TestEnv {
  db: PrismaClient;
  ctx: Ctx;
  clock: { now: Date };
  providers: string[];
}

/** Truncate everything, re-seed, and give providers readable names in display order. */
export async function setup(): Promise<TestEnv> {
  const d = db();
  const tables = await q<{ tablename: string }>(
    d,
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  await exec(d, `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seed(d);
  await d.clinicSettings.update({
    where: { id: 1 },
    data: {
      settings: {
        ...((await d.clinicSettings.findUnique({ where: { id: 1 } }))!.settings as object),
        ADMIN_ALERT_PHONES: ['+12645550000'],
      },
    },
  });
  const providers = (await d.provider.findMany({ orderBy: { displayOrder: 'asc' } })).map((p) => p.id);
  for (const [i, name] of ['Ana', 'Ben', 'Cara', 'Dev'].entries())
    await d.provider.update({ where: { id: providers[i] }, data: { name, phoneE164: `+12645550${i}10` } });
  const clock = { now: NOW };
  return { db: d, ctx: { db: d, now: () => clock.now }, clock, providers };
}

let phoneSeq = 1000;
export async function guardian(d: PrismaClient, name: string, opts: { whatsapp?: boolean } = {}) {
  const g = await d.guardian.create({
    data: {
      name,
      phoneE164: `+1264555${phoneSeq++}`,
      whatsappOptInAt: opts.whatsapp === false ? null : new Date(),
      verifiedAt: new Date(),
    },
  });
  return g.id;
}

export async function child(
  d: PrismaClient,
  name: string,
  links: { g: string; canBook?: boolean; notify?: boolean; restricted?: boolean }[],
  dob?: string,
) {
  const p = await d.patient.create({
    data: { fullName: name, createdByGuardianId: links[0].g, dob: dob ? new Date(dob) : null },
  });
  for (const l of links)
    await d.guardianPatient.create({
      data: {
        guardianId: l.g,
        patientId: p.id,
        canBook: l.canBook ?? false,
        receivesNotifications: l.notify ?? true,
        restricted: l.restricted ?? false,
      },
    });
  for (const type of ['DATA_PROCESSING', 'MESSAGING'] as const)
    await d.consent.create({ data: { guardianId: links[0].g, patientId: p.id, type, version: '2026-01' } });
  return p.id;
}

export const ADMIN = { type: 'STAFF' as const, id: '00000000-0000-4000-8000-000000000001', role: 'ADMIN' as const };

export async function onlyProviders(d: PrismaClient, ids: string[]) {
  await exec(d, 'UPDATE provider SET active = (id = ANY($1::uuid[]))', ids);
}

export const status = async (d: PrismaClient, id: string) =>
  (await d.appointment.findUniqueOrThrow({ where: { id } })).status;

export const outbox = (d: PrismaClient, key: string) =>
  d.message.findMany({ where: { templateKey: key, direction: 'OUT' }, orderBy: { createdAt: 'asc' } });
