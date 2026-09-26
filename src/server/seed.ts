import argon2 from 'argon2';
import type { PrismaClient } from '@/generated/prisma/client';
import { DEFAULT_SETTINGS } from './settings';
import { newTotpSecret, totpUri } from './totp';

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

/** Idempotent seed: PRD defaults, the pilot provider (Dr. Hughes), clinic hours, first admin. */
export async function seed(
  db: PrismaClient,
  opts: { adminEmail?: string; adminPassword?: string; log?: boolean } = {},
) {
  await db.clinicSettings.upsert({
    where: { id: 1 },
    create: { id: 1, settings: DEFAULT_SETTINGS as object },
    update: {},
  });

  if ((await db.provider.count()) === 0) {
    // Pilot: Dr. Hughes is the only provider. Add more under Admin → Settings → Providers.
    await db.provider.create({
      data: {
        name: 'Dr. Kniquiah Hughes',
        discipline: 'OT',
        color: '#5B3F8C',
        phoneE164: '+17869420603',
        displayOrder: 0,
      },
    });
  }

  if ((await db.availabilityRule.count({ where: { providerId: null } })) === 0) {
    await db.availabilityRule.createMany({
      data: [
        { weekday: 5, startTime: t('08:00'), endTime: t('17:00') }, // Friday
        { weekday: 6, startTime: t('08:00'), endTime: t('18:00') }, // Saturday
      ],
    });
  }

  if (
    opts.adminEmail &&
    opts.adminPassword &&
    !(await db.staffUser.findUnique({ where: { email: opts.adminEmail } }))
  ) {
    if (opts.adminPassword.length < 12) throw new Error('ADMIN_INITIAL_PASSWORD must be at least 12 characters');
    const totpSecret = newTotpSecret();
    await db.staffUser.create({
      data: {
        email: opts.adminEmail,
        role: 'ADMIN',
        passwordHash: await argon2.hash(opts.adminPassword, { type: argon2.argon2id }),
        totpSecret,
      },
    });
    if (opts.log) {
      console.log(`Admin ${opts.adminEmail} created. Add this to an authenticator app (shown once):`);
      console.log(totpUri(totpSecret, opts.adminEmail));
    }
  }
}
