import { z } from 'zod';
import { finishEnrollment, type LoginResult } from '@/server/auth/staff';
import { json, route } from '@/server/http';
import { staffSessionResponse } from '@/server/auth/session';

/** Completes first-login 2FA enrollment and signs the admin in. */
export const POST = route(async ({ req, ctx }) => {
  const b = z
    .object({ setupToken: z.string().min(10).max(4000), code: z.string().regex(/^\d{6}$/) })
    .parse(await json(req));
  return staffSessionResponse(
    ctx.now(),
    (await finishEnrollment(ctx, b.setupToken, b.code)) as Extract<LoginResult, { kind: 'session' }>,
  );
});
