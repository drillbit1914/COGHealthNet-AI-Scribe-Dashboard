import { cancel } from '@/server/appointments';
import { requireGuardian, route } from '@/server/http';

export const POST = route(async ({ ctx, actor, params }) => {
  await cancel(ctx, { type: 'GUARDIAN', id: requireGuardian(actor) }, params.id);
  return { ok: true };
});
