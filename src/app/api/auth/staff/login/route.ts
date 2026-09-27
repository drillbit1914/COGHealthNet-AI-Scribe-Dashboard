import { z } from 'zod';
import { staffSessionResponse } from '@/server/auth/session';
import { staffLogin, startEnrollment } from '@/server/auth/staff';
import { json, route } from '@/server/http';

export const POST = route(async ({ req, ctx }) => {
  const b = z
    .object({ email: z.string().email(), password: z.string().min(1).max(200), totp: z.string().max(10).optional() })
    .parse(await json(req));
  const u = await staffLogin(ctx, b.email, b.password, b.totp);
  if (u.kind === 'enroll') {
    const e = await startEnrollment(ctx, u.staffId, u.email);
    return { needsTotpSetup: true, setupToken: e.setupToken, secret: e.secret, qr: e.qr };
  }
  return staffSessionResponse(ctx.now(), u);
});
