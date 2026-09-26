/**
 * Admin API routing table: METHOD + path pattern → handler. `admin: true` routes are ADMIN-only;
 * the rest allow providers, and the services scope providers to their own visits.
 */
import { z } from 'zod';
import {
  alternateOptions,
  cancel,
  closeClinic,
  complete,
  confirm,
  createSeries,
  decline,
  markNoShow,
  previewClosure,
  previewSeries,
  proposeAlternate,
  reassignCandidates,
  reassignProvider,
  recordPayment,
  reschedule,
} from '../appointments';
import type { Ctx } from '../context';
import { notFound } from '../errors';
import { getSettings } from '../settings';
import * as A from './admin';
import { SETTINGS_FIELDS } from './settings-schema';

type Handler = (a: {
  ctx: Ctx;
  actor: A.Staff;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}) => Promise<unknown>;
interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  admin?: boolean;
  handle: Handler;
}

const Id = z.uuid();
const Range = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date() });
const SeriesBody = z.object({
  patientId: z.uuid(),
  providerId: z.uuid(),
  visitType: z.enum(['FOLLOW_UP', 'EVALUATION']),
  firstStartsAt: z.coerce.date(),
  rule: z.enum(['WEEKLY', 'BIWEEKLY']),
  count: z.number().int().min(1).max(52),
  skipConflicts: z.boolean().default(false),
});
const ok = { ok: true };

export const ADMIN_ROUTES: RouteDef[] = [
  {
    method: 'GET',
    path: 'me',
    handle: async ({ ctx, actor }) => ({
      ...actor,
      email: (await ctx.db.staffUser.findUnique({ where: { id: actor.id } }))?.email,
      canApprove: actor.role === 'ADMIN' || (await getSettings(ctx.db)).PROVIDER_CAN_APPROVE,
    }),
  },

  // Approval queue
  { method: 'GET', path: 'queue', handle: ({ ctx, actor }) => A.queue(ctx, actor) },
  {
    method: 'GET',
    path: 'appointments/:id/candidates',
    handle: ({ ctx, params }) => reassignCandidates(ctx, params.id),
  },
  {
    method: 'GET',
    path: 'appointments/:id/alternates',
    handle: async ({ ctx, params, query }) =>
      (await alternateOptions(ctx, params.id, query.from, query.to)).map((s) => ({
        startsAt: s.startsAt,
        freeProviders: s.providerIds.length,
      })),
  },
  {
    method: 'POST',
    path: 'appointments/:id/confirm',
    handle: async ({ ctx, actor, params, body }) => (
      await confirm(ctx, actor, params.id, z.object({ providerId: z.uuid().optional() }).parse(body ?? {}).providerId),
      ok
    ),
  },
  {
    method: 'POST',
    path: 'appointments/:id/reassign',
    handle: async ({ ctx, actor, params, body }) => (
      await reassignProvider(ctx, actor, params.id, z.object({ providerId: z.uuid() }).parse(body).providerId),
      ok
    ),
  },
  {
    method: 'POST',
    path: 'appointments/:id/decline',
    handle: async ({ ctx, actor, params, body }) => (
      await decline(ctx, actor, params.id, z.object({ reason: z.string().max(300) }).parse(body).reason),
      ok
    ),
  },
  {
    method: 'POST',
    path: 'appointments/:id/propose',
    handle: async ({ ctx, actor, params, body }) => (
      await proposeAlternate(ctx, actor, params.id, z.object({ startsAt: z.coerce.date() }).parse(body).startsAt),
      ok
    ),
  },
  {
    method: 'POST',
    path: 'appointments/:id/reschedule',
    handle: ({ ctx, actor, params, body }) => {
      const b = z.object({ startsAt: z.coerce.date(), providerId: z.uuid().optional() }).parse(body);
      return reschedule(ctx, actor, params.id, b.startsAt, b.providerId);
    },
  },
  {
    method: 'POST',
    path: 'appointments/:id/cancel',
    admin: true,
    handle: async ({ ctx, actor, params, body }) => (
      await cancel(
        ctx,
        actor,
        params.id,
        z.object({ reason: z.string().max(300).default('') }).parse(body ?? {}).reason,
      ),
      ok
    ),
  },
  {
    method: 'POST',
    path: 'appointments/:id/attendance',
    handle: async ({ ctx, actor, params, body }) => {
      const { outcome } = z.object({ outcome: z.enum(['COMPLETED', 'NO_SHOW']) }).parse(body);
      await (outcome === 'COMPLETED' ? complete : markNoShow)(ctx, actor, params.id);
      return ok;
    },
  },
  {
    method: 'POST',
    path: 'appointments/:id/payment',
    admin: true,
    handle: async ({ ctx, actor, params, body }) => (
      await recordPayment(
        ctx,
        actor,
        params.id,
        z
          .object({
            status: z.enum(['PAID_CASH', 'PAID_BANK_TRANSFER', 'WAIVED', 'UNPAID']),
            reference: z.string().max(100).optional(),
          })
          .parse(body),
      ),
      ok
    ),
  },

  // Calendar
  { method: 'GET', path: 'calendar', handle: ({ ctx, actor, query }) => A.calendar(ctx, actor, query) },

  // Patients & guardians
  { method: 'GET', path: 'patients', admin: true, handle: ({ ctx, query }) => A.searchPatients(ctx, query.q ?? '') },
  {
    method: 'GET',
    path: 'patients/:id',
    admin: true,
    handle: ({ ctx, actor, params }) => A.patientProfile(ctx, actor, params.id),
  },
  {
    method: 'PATCH',
    path: 'patients/:id',
    admin: true,
    handle: ({ ctx, actor, params, body }) => A.updatePatient(ctx, actor, params.id, body),
  },
  {
    method: 'GET',
    path: 'patients/:id/export',
    admin: true,
    handle: ({ ctx, actor, params }) => A.exportPatient(ctx, actor, params.id),
  },
  {
    method: 'POST',
    path: 'patients/:id/erase',
    admin: true,
    handle: async ({ ctx, actor, params }) => (await A.erasePatient(ctx, actor, params.id), ok),
  },
  {
    method: 'POST',
    path: 'guardian-links',
    admin: true,
    handle: ({ ctx, actor, body }) => A.upsertGuardianLink(ctx, actor, body),
  },
  {
    method: 'POST',
    path: 'merge/patients',
    admin: true,
    handle: async ({ ctx, actor, body }) => {
      const b = z.object({ fromId: Id, intoId: Id }).parse(body);
      await A.mergePatients(ctx, actor, b.fromId, b.intoId);
      return ok;
    },
  },
  {
    method: 'POST',
    path: 'merge/guardians',
    admin: true,
    handle: async ({ ctx, actor, body }) => {
      const b = z.object({ fromId: Id, intoId: Id }).parse(body);
      await A.mergeGuardians(ctx, actor, b.fromId, b.intoId);
      return ok;
    },
  },
  { method: 'GET', path: 'breach-export', admin: true, handle: ({ ctx, actor }) => A.breachExport(ctx, actor) },

  // Payments
  { method: 'GET', path: 'payments/unpaid', admin: true, handle: ({ ctx }) => A.unpaid(ctx) },
  { method: 'GET', path: 'payments/totals', admin: true, handle: ({ ctx, query }) => A.paymentTotals(ctx, query) },
  { method: 'GET', path: 'payments/proofs', admin: true, handle: ({ ctx }) => A.proofQueue(ctx) },
  {
    method: 'POST',
    path: 'payments/proofs/:id/reviewed',
    admin: true,
    handle: async ({ ctx, actor, params }) => (await A.reviewProof(ctx, actor, params.id), ok),
  },

  // Time off, closures, rebook
  { method: 'GET', path: 'time-off', handle: ({ ctx, actor }) => A.listTimeOff(ctx, actor) },
  { method: 'POST', path: 'time-off', handle: ({ ctx, actor, body }) => A.addTimeOff(ctx, actor, body) },
  {
    method: 'DELETE',
    path: 'time-off/:id',
    handle: async ({ ctx, actor, params }) => (await A.deleteTimeOff(ctx, actor, params.id), ok),
  },
  {
    method: 'POST',
    path: 'closures/preview',
    admin: true,
    handle: ({ ctx, body }) => {
      const b = Range.parse(body);
      return previewClosure(ctx, b.startsAt, b.endsAt);
    },
  },
  {
    method: 'POST',
    path: 'closures',
    admin: true,
    handle: ({ ctx, actor, body }) => {
      const b = Range.extend({ reason: z.string().trim().min(1).max(200) }).parse(body);
      return closeClinic(ctx, actor, b.startsAt, b.endsAt, b.reason);
    },
  },
  { method: 'GET', path: 'rebook', admin: true, handle: ({ ctx }) => A.rebookList(ctx) },
  {
    method: 'POST',
    path: 'rebook/:id/resolve',
    admin: true,
    handle: async ({ ctx, actor, params }) => (await A.resolveRebook(ctx, actor, params.id), ok),
  },

  // Recurring series
  {
    method: 'POST',
    path: 'series/preview',
    admin: true,
    handle: ({ ctx, body }) => previewSeries(ctx, SeriesBody.parse(body)),
  },
  {
    method: 'POST',
    path: 'series',
    admin: true,
    handle: ({ ctx, actor, body }) => {
      const b = SeriesBody.parse(body);
      return createSeries(ctx, actor, b, b.skipConflicts);
    },
  },

  // Waitlist
  { method: 'GET', path: 'waitlist', admin: true, handle: ({ ctx }) => A.waitlist(ctx) },
  { method: 'POST', path: 'waitlist', admin: true, handle: ({ ctx, actor, body }) => A.addWaitlist(ctx, actor, body) },
  {
    method: 'DELETE',
    path: 'waitlist/:id',
    admin: true,
    handle: async ({ ctx, actor, params }) => (await A.removeWaitlist(ctx, actor, params.id), ok),
  },

  // Logs
  { method: 'GET', path: 'messages', admin: true, handle: ({ ctx, query }) => A.messageLog(ctx, query) },
  { method: 'GET', path: 'audit', admin: true, handle: ({ ctx, query }) => A.auditLog(ctx, query) },

  // Settings, providers, hours, staff
  {
    method: 'GET',
    path: 'settings',
    admin: true,
    handle: async ({ ctx }) => ({ values: await getSettings(ctx.db), fields: SETTINGS_FIELDS }),
  },
  {
    method: 'PATCH',
    path: 'settings',
    admin: true,
    handle: ({ ctx, actor, body }) => A.updateSettings(ctx, actor, body),
  },
  { method: 'GET', path: 'providers', handle: ({ ctx }) => A.providersList(ctx) },
  {
    method: 'POST',
    path: 'providers',
    admin: true,
    handle: ({ ctx, actor, body }) => A.upsertProvider(ctx, actor, body),
  },
  { method: 'GET', path: 'rules', admin: true, handle: ({ ctx }) => A.rulesList(ctx) },
  {
    method: 'PUT',
    path: 'rules',
    admin: true,
    handle: async ({ ctx, actor, body }) => (await A.replaceRules(ctx, actor, body), ok),
  },
  { method: 'GET', path: 'staff', admin: true, handle: ({ ctx, actor }) => A.staffUsers(ctx, actor) },
  { method: 'POST', path: 'staff', admin: true, handle: ({ ctx, actor, body }) => A.createStaff(ctx, actor, body) },
  {
    method: 'POST',
    path: 'staff/:id/active',
    admin: true,
    handle: async ({ ctx, actor, params, body }) => (
      await A.setStaffActive(ctx, actor, params.id, z.object({ active: z.boolean() }).parse(body).active),
      ok
    ),
  },

  // Reports
  { method: 'GET', path: 'reports', admin: true, handle: ({ ctx, query }) => A.reports(ctx, query) },
];

/** Match a path like "appointments/abc/confirm" against the table; uuid params are validated. */
export function matchRoute(method: string, path: string[]) {
  for (const r of ADMIN_ROUTES) {
    if (r.method !== method) continue;
    const parts = r.path.split('/');
    if (parts.length !== path.length) continue;
    const params: Record<string, string> = {};
    let hit = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        if (!Id.safeParse(path[i]).success) throw notFound();
        params[parts[i].slice(1)] = path[i];
      } else if (parts[i] !== path[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { route: r, params };
  }
  return null;
}
