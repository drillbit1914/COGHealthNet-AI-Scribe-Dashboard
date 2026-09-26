import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { t } from '@/i18n';
import { requireGuardianPage } from '@/server/auth/page';
import { defaultCtx } from '@/server/context';
import { getMe, listAppointments } from '@/server/parent';
import { getSettings } from '@/server/settings';
import { ChildVisits } from './visits-client';

export const dynamic = 'force-dynamic';

export default async function Visits() {
  const ctx = defaultCtx();
  const guardianId = await requireGuardianPage();
  const me = await getMe(ctx, guardianId);
  const s = await getSettings(ctx.db);
  const perChild = await Promise.all(me.children.map((c) => listAppointments(ctx, guardianId, c.id)));
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/book" className="text-jacaranda font-bold">
          ← {t('ui.steps.back')}
        </Link>
        <h1 className="mt-2 text-3xl font-bold">{t('ui.visits.title')}</h1>
      </div>
      {perChild.length === 0 && <p className="text-muted">{t('ui.visits.none')}</p>}
      {perChild.map((v, i) => (
        <ChildVisits key={v.child.id} data={v} notice={me.children[i].notice} cutoffHours={s.CANCEL_CUTOFF_HOURS} />
      ))}
      <Link href="/book/new" className={buttonVariants({ size: 'lg' })}>
        {t('ui.home.book')}
      </Link>
    </div>
  );
}
