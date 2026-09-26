import { json, requireGuardian, route } from '@/server/http';
import { getMe, updateName } from '@/server/parent';

export const GET = route(async ({ ctx, actor }) => getMe(ctx, requireGuardian(actor)));
export const PATCH = route(async ({ req, ctx, actor }) => updateName(ctx, requireGuardian(actor), await json(req)));
