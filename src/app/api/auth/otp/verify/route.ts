import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyOtp } from '@/server/auth/otp';
import { PARENT_SESSION_S, sealSession, setSessionCookie } from '@/server/auth/session';
import { json, route } from '@/server/http';

export const POST = route(async ({ req, ctx }) => {
  const b = z.object({ phone: z.string().min(7).max(20), code: z.string().regex(/^\d{6}$/) }).parse(await json(req));
  const { guardianId } = await verifyOtp(ctx, b.phone, b.code);
  const iat = ctx.now().getTime();
  const res = NextResponse.json({ ok: true });
  setSessionCookie(
    res,
    await sealSession({ kind: 'guardian', guardianId, iat, exp: iat + PARENT_SESSION_S * 1000 }),
    PARENT_SESSION_S,
  );
  return res;
});
