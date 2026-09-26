import { requireStaffPage } from '@/server/auth/page';
import { defaultCtx } from '@/server/context';
import { getSettings } from '@/server/settings';
import { ConsoleShell } from './shell';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireStaffPage();
  const ctx = defaultCtx();
  const s = await getSettings(ctx.db);
  const me = await ctx.db.staffUser.findUnique({ where: { id: actor.id }, select: { email: true } });
  return (
    <ConsoleShell
      staff={{
        role: actor.role,
        providerId: actor.providerId ?? null,
        canApprove: actor.role === 'ADMIN' || s.PROVIDER_CAN_APPROVE,
        tz: s.TIMEZONE,
      }}
      email={me?.email ?? ''}
    >
      {children}
    </ConsoleShell>
  );
}
