import { json, requireGuardian, route } from '@/server/http';
import { withdrawConsent } from '@/server/parent';

export const POST = route(async ({ req, ctx, actor }) => withdrawConsent(ctx, requireGuardian(actor), await json(req)));
