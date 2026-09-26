import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { actorFromCookie, SESSION_COOKIE } from './session';

/** Server components: the signed-in guardian's id, or redirect to sign-in. */
export async function requireGuardianPage(): Promise<string> {
  const actor = await actorFromCookie((await cookies()).get(SESSION_COOKIE)?.value);
  if (actor?.type !== 'GUARDIAN') redirect('/book/sign-in');
  return actor.id;
}

export async function currentActor() {
  return actorFromCookie((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Staff pages: the signed-in staff actor, or redirect to the staff login. Optionally admin-only. */
export async function requireStaffPage(adminOnly = false) {
  const actor = await currentActor();
  if (actor?.type !== 'STAFF') redirect('/admin/login');
  if (adminOnly && actor.role !== 'ADMIN') redirect('/admin/queue');
  return actor;
}
