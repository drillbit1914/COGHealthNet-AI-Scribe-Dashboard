import { requireGuardian, route } from '@/server/http';
import { listAppointments } from '@/server/parent';

export const GET = route(async ({ ctx, actor, params }) => listAppointments(ctx, requireGuardian(actor), params.id));
