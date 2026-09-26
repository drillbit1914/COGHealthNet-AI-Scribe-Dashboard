import { declineAlternate } from '@/server/appointments';
import { requireGuardian, route } from '@/server/http';

export const POST = route(async ({ ctx, actor, params }) => {
  await declineAlternate(ctx, requireGuardian(actor), params.id);
  return { ok: true };
});
