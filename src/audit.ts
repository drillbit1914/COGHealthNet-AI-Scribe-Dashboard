import type { Queryable } from './db.js';

export type Actor =
  | { type: 'GUARDIAN'; id: string }
  | { type: 'STAFF'; id: string; role: 'ADMIN' | 'PROVIDER'; providerId?: string | null }
  | { type: 'SYSTEM'; id?: null };

export const SYSTEM: Actor = { type: 'SYSTEM' };

export async function audit(
  q: Queryable, actor: Actor, action: string, entity: string, entityId: string | null,
  before: unknown = null, after: unknown = null,
) {
  await q.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actor.type, actor.id ?? null, action, entity, entityId,
     before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)],
  );
}
