import { claimWaitlistOffer } from '@/server/appointments';
import { requireGuardian, route } from '@/server/http';

export const POST = route(async ({ ctx, actor, params }) => {
  const r = await claimWaitlistOffer(ctx, requireGuardian(actor), params.id);
  return { appointmentId: r.appointmentId, ref: r.ref };
});
