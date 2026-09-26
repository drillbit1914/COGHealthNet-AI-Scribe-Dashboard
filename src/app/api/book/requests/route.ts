import { NextResponse } from 'next/server';
import { t } from '@/i18n';
import { createRequest } from '@/server/appointments';
import { badRequest } from '@/server/errors';
import { json, requireGuardian, route } from '@/server/http';
import { getSettings } from '@/server/settings';
import { fmtDate, fmtDay, fmtTime } from '@/server/time';

/** Submit a request. The response never includes the (tentative) provider. */
export const POST = route(async ({ req, ctx, actor }) => {
  const guardianId = requireGuardian(actor);
  const body = (await json(req)) as { evaluation?: { referralFileKey?: string } };
  const key = body?.evaluation?.referralFileKey;
  if (key && !key.startsWith(`referrals/${guardianId}/`)) throw badRequest(t('errors.unknownFile'));
  const r = await createRequest(ctx, guardianId, body);
  const s = await getSettings(ctx.db);
  const tz = s.TIMEZONE;
  return NextResponse.json(
    {
      appointmentId: r.appointmentId,
      ref: r.ref,
      status: r.status,
      visitType: r.visitType,
      startsAt: r.startsAt.toISOString(),
      when: `${fmtDay(r.startsAt, tz)} ${fmtDate(r.startsAt, tz)}, ${fmtTime(r.startsAt, tz)}`,
      payment:
        r.visitType === 'FOLLOW_UP'
          ? { accountName: s.ACCOUNT_NAME, accountNo: s.NCBA_ACCOUNT_NO, reference: r.ref, currency: s.CURRENCY }
          : null,
      icsUrl: `/api/book/appointments/${r.appointmentId}/ics`,
      notice: t('booking.neverNewBankDetails'),
    },
    { status: 201 },
  );
});
