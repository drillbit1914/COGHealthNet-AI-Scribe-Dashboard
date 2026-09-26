import { z } from 'zod';
import { reschedule } from '@/server/appointments';
import { json, requireGuardian, route } from '@/server/http';

export const POST = route(async ({ req, ctx, actor, params }) => {
  const { startsAt } = z.object({ startsAt: z.coerce.date() }).parse(await json(req));
  const r = await reschedule(ctx, { type: 'GUARDIAN', id: requireGuardian(actor) }, params.id, startsAt);
  return { appointmentId: r.appointmentId, ref: r.ref };
});
