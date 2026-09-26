import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealSession, setSessionCookie, STAFF_SESSION_S } from '@/server/auth/session';
import { staffLogin } from '@/server/auth/staff';
import { json, route } from '@/server/http';

export const POST = route(async ({ req, ctx }) => {
  const b = z
    .object({ email: z.string().email(), password: z.string().min(1).max(200), totp: z.string().max(10).optional() })
    .parse(await json(req));
  const u = await staffLogin(ctx, b.email, b.password, b.totp);
  const iat = ctx.now().getTime();
  const res = NextResponse.json({ role: u.role });
  setSessionCookie(
    res,
    await sealSession({
      kind: 'staff',
      staffId: u.staffId,
      role: u.role,
      providerId: u.providerId,
      iat,
      exp: iat + STAFF_SESSION_S * 1000,
    }),
    STAFF_SESSION_S,
  );
  return res;
});
