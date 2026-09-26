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
