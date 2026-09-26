import { exec, type Queryable } from './db';

export type Actor =
  | { type: 'GUARDIAN'; id: string }
  | { type: 'STAFF'; id: string; role: 'ADMIN' | 'PROVIDER'; providerId?: string | null }
  | { type: 'SYSTEM'; id?: null };

export const SYSTEM: Actor = { type: 'SYSTEM' };

const json = (v: unknown) => (v == null ? null : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));

/** Append-only audit trail: who, what, when, before/after (PRD §3). */
export async function audit(
  db: Queryable,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown = null,
  after: unknown = null,
) {
  await exec(
    db,
    `INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id, before, after)
     VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    actor.type,
    actor.id ?? null,
    action,
    entity,
    entityId,
    json(before),
    json(after),
  );
}
