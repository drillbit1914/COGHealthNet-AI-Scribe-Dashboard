import cookie from '@fastify/cookie';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Actor } from '../audit.js';
import { resolveSession } from '../auth.js';
import type { Ctx } from '../ctx.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import type { Storage } from '../storage.js';
import { adminRoutes } from './admin.js';
import { parentRoutes } from './parent.js';
import { webhookRoutes } from './webhooks.js';

export const SESSION_COOKIE = 'wav_session';

declare module 'fastify' {
  interface FastifyRequest { actor: Actor | null; rawBody?: string }
}

export interface AppDeps { ctx: Ctx; storage: Storage; secureCookies?: boolean }

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false, bodyLimit: 11 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);

  // Keep the raw body for webhook signature checks (WhatsApp X-Hub-Signature-256, Twilio).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addContentTypeParser(['application/pdf', 'image/jpeg', 'image/png'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE] ?? req.headers.authorization?.replace(/^Bearer /, '');
    req.actor = await resolveSession(deps.ctx.db, token, deps.ctx.now());
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'BAD_REQUEST', message: err.issues.map((i) => i.message).join('; ') });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'BAD_REQUEST', message: (err as Error).message });
    console.error(err);
    return reply.status(500).send({ error: 'INTERNAL', message: 'Something went wrong' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  await app.register(parentRoutes(deps), { prefix: '/api' });
  await app.register(adminRoutes(deps), { prefix: '/api/admin' });
  await app.register(webhookRoutes(deps), { prefix: '/webhooks' });

  app.get('/files/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const q = req.query as { exp?: string; sig?: string };
    if (!deps.storage.verify(key, q.exp ?? '', q.sig ?? '', deps.ctx.now())) throw forbidden();
    const f = await deps.storage.get(key);
    if (!f) return reply.status(404).send();
    return reply.type(f.contentType).send(f.data);
  });
  return app;
}

export function guardianId(req: FastifyRequest): string {
  if (req.actor?.type !== 'GUARDIAN') throw unauthorized();
  return req.actor.id;
}
export function staff(req: FastifyRequest, adminOnly = false): Extract<Actor, { type: 'STAFF' }> {
  if (req.actor?.type !== 'STAFF') throw unauthorized();
  if (adminOnly && req.actor.role !== 'ADMIN') throw forbidden();
  return req.actor;
}
export type { FastifyReply };
