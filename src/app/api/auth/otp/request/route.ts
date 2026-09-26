import { z } from 'zod';
import { requestOtp } from '@/server/auth/otp';
import { json, route } from '@/server/http';

export const POST = route(async ({ req, ctx }) => {
  const { phone } = z.object({ phone: z.string().min(7).max(20) }).parse(await json(req));
  const r = await requestOtp(ctx, phone);
  return { phone: r.phone };
});
