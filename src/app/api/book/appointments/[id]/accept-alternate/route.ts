import { acceptAlternate } from '@/server/appointments';
import { requireGuardian, route } from '@/server/http';

export const POST = route(async ({ ctx, actor, params }) => {
  await acceptAlternate(ctx, requireGuardian(actor), params.id);
  return { ok: true };
});
