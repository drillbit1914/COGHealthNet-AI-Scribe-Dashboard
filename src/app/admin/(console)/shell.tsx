'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { StaffContext, type StaffInfo } from '@/components/admin/ui';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const NAV: { href: string; label: string; admin?: boolean }[] = [
  { href: '/admin/queue', label: 'Approval queue' },
  { href: '/admin/calendar', label: 'Calendar' },
  { href: '/admin/patients', label: 'Patients', admin: true },
  { href: '/admin/payments', label: 'Payments', admin: true },
  { href: '/admin/closures', label: 'Closures', admin: true },
  { href: '/admin/time-off', label: 'Time off' },
  { href: '/admin/series', label: 'Recurring series', admin: true },
  { href: '/admin/waitlist', label: 'Waitlist', admin: true },
  { href: '/admin/messages', label: 'Messages & audit', admin: true },
  { href: '/admin/reports', label: 'Reports', admin: true },
  { href: '/admin/settings', label: 'Settings', admin: true },
];

export function ConsoleShell({
  staff,
  email,
  children,
}: {
  staff: StaffInfo;
  email: string;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();
  const blocked = staff.role !== 'ADMIN' && NAV.some((n) => n.admin && path.startsWith(n.href));
  // Providers only get their own queue, calendar and time off (the API enforces this too).
  useEffect(() => {
    if (blocked) router.replace('/admin/queue');
  }, [blocked, router]);
  return (
    <StaffContext.Provider value={staff}>
      <div className="flex min-h-dvh">
        <nav className="border-line sticky top-0 flex h-dvh w-56 shrink-0 flex-col gap-1 border-r bg-white p-3">
          <p className="text-jacaranda mb-4 px-2 text-xl font-bold">{t('brand.clinic')}</p>
          {NAV.filter((n) => !n.admin || staff.role === 'ADMIN').map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                'rounded-md px-2 py-1.5 text-sm font-bold',
                path.startsWith(n.href) ? 'bg-jacaranda text-white' : 'hover:bg-jacaranda-light',
              )}
            >
              {n.label}
            </Link>
          ))}
          <div className="border-line text-muted mt-auto border-t px-2 pt-3 text-xs">
            <p className="truncate">{email}</p>
            <p>{staff.role === 'ADMIN' ? 'Administrator' : 'Provider'} · times in AST</p>
            <button
              className="text-jacaranda mt-2 font-bold"
              onClick={async () => {
                await api('/api/auth/logout', { method: 'POST' });
                router.replace('/admin/login');
              }}
            >
              Sign out
            </button>
          </div>
        </nav>
        <main className="min-w-0 flex-1 p-6">{blocked ? null : children}</main>
      </div>
    </StaffContext.Provider>
  );
}
