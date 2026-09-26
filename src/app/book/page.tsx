import Link from 'next/link';
import { StickyAction } from '@/components/book/sticky-action';
import { buttonVariants } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/field';
import { t } from '@/i18n';
import { requireGuardianPage } from '@/server/auth/page';
import { defaultCtx } from '@/server/context';
import { getMe } from '@/server/parent';
import { NameForm, SignOut } from './home-client';

export const dynamic = 'force-dynamic';

export default async function BookHome() {
  const me = await getMe(defaultCtx(), await requireGuardianPage());
  const canBookAny = me.children.length === 0 || me.children.some((c) => c.canBook);
  return (
    <div className="flex flex-1 flex-col gap-5">
      <h1 className="text-3xl font-bold">
        {t('ui.home.greeting', { name: me.guardian.name ? `, ${me.guardian.name}` : '' })}
      </h1>
      {!me.guardian.name && <NameForm />}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">{t('ui.home.children')}</h2>
        {me.children.length === 0 && <p className="text-muted">{t('ui.home.noChildren')}</p>}
        {me.children.map((c) => (
          <Card key={c.id}>
            <p className="text-lg font-bold">{c.name}</p>
            {c.notice && (
              <Alert tone="info" className="mt-2 text-sm">
                {c.notice}
              </Alert>
            )}
          </Card>
        ))}
      </section>
      <SignOut />
      <StickyAction>
        {canBookAny && (
          <Link href="/book/new" className={buttonVariants({ size: 'lg' })}>
            {t('ui.home.book')}
          </Link>
        )}
        <Link href="/book/visits" className={buttonVariants({ size: 'lg', variant: 'secondary' })}>
          {t('ui.home.visits')}
        </Link>
      </StickyAction>
    </div>
  );
}
