import { Suspense } from 'react';
import { requireGuardianPage } from '@/server/auth/page';
import { defaultCtx } from '@/server/context';
import { getMe } from '@/server/parent';
import { Wizard } from './wizard';

export const dynamic = 'force-dynamic';

export default async function NewBooking() {
  const me = await getMe(defaultCtx(), await requireGuardianPage());
  return (
    <Suspense>
      <Wizard children_={me.children} />
    </Suspense>
  );
}
