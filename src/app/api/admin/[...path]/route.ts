import { NextResponse, type NextRequest } from 'next/server';
import { matchRoute } from '@/server/admin/api';
import { notFound } from '@/server/errors';
import { requireStaff, route } from '@/server/http';

export const dynamic = 'force-dynamic';

const inner = route(async ({ req, ctx, actor, params }) => {
  const path = (params as unknown as { path?: string[] }).path ?? [];
  const m = matchRoute(req.method, path);
  if (!m) throw notFound();
  const staff = requireStaff(actor, m.route.admin);
  const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.json().catch(() => ({}));
  const out = await m.route.handle({
    ctx,
    actor: staff,
    params: m.params,
    query: Object.fromEntries(req.nextUrl.searchParams),
    body,
  });
  return NextResponse.json(out ?? { ok: true });
});

/** Single entry point for the admin API; routing table in src/server/admin/api.ts. */
function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return inner(req, ctx as unknown as { params: Promise<Record<string, string>> });
}

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST, handler as PUT };
