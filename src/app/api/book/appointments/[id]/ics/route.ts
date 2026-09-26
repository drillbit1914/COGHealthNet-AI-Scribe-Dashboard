import { requireGuardian, route } from '@/server/http';
import { icsFor } from '@/server/parent';

export const GET = route(async ({ ctx, actor, params }) => {
  const { filename, body } = await icsFor(ctx, requireGuardian(actor), params.id);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});
