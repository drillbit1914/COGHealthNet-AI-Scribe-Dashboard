import { after, NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { t } from '@/i18n';
import type { Actor } from './audit';
import { actorFromRequest } from './auth/session';
import { defaultCtx, type Ctx } from './context';
import { AppError, forbidden, unauthorized } from './errors';
import { processOutbox } from './messaging/outbox';

/** Test seam: route handlers use this context; tests swap in a fixed clock and test DB. */
let ctxOverride: Ctx | undefined;
export const setRouteCtx = (c: Ctx | undefined) => void (ctxOverride = c);
export const routeCtx = () => ctxOverride ?? defaultCtx();

type Params = Record<string, string>;
interface HandlerArgs {
  req: NextRequest;
  ctx: Ctx;
  actor: Actor | null;
  params: Params;
}

/** Uniform JSON errors for AppError / ZodError; never leaks internals. */
export function route(fn: (a: HandlerArgs) => Promise<Response | unknown>) {
  return async (req: NextRequest, context: { params: Promise<Params> }) => {
    try {
      const ctx = routeCtx();
      const actor = await actorFromRequest(req, ctx.db, ctx.now());
      const params = (await context?.params) ?? {};
      const out = await fn({ req, ctx, actor, params });
      if (req.method !== 'GET') kickOutbox(ctx);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof AppError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
      if (e instanceof ZodError)
        return NextResponse.json(
          { error: 'BAD_REQUEST', message: e.issues.map((i) => i.message).join('; ') },
          { status: 400 },
        );
      if (e instanceof SyntaxError)
        return NextResponse.json({ error: 'BAD_REQUEST', message: 'Invalid JSON' }, { status: 400 });
      console.error(e);
      return NextResponse.json({ error: 'INTERNAL', message: t('errors.internal') }, { status: 500 });
    }
  };
}

export function requireGuardian(actor: Actor | null): string {
  if (actor?.type !== 'GUARDIAN') throw unauthorized();
  return actor.id;
}

export function requireStaff(actor: Actor | null, adminOnly = false): Extract<Actor, { type: 'STAFF' }> {
  if (actor?.type !== 'STAFF') throw unauthorized();
  if (adminOnly && actor.role !== 'ADMIN') throw forbidden();
  return actor;
}

export const json = async (req: NextRequest) => (await req.json().catch(() => ({}))) as unknown;

/**
 * Send what this request queued right after the response (codes, confirmations), instead of waiting
 * for the next cron tick. Outside a request scope (unit tests) this is a no-op.
 */
function kickOutbox(ctx: Ctx) {
  if (ctxOverride) return;
  try {
    after(() => processOutbox(ctx).catch((e) => console.error('outbox', e)));
  } catch {
    /* not in a request scope */
  }
}
