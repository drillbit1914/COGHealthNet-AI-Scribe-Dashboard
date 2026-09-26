'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface StaffInfo {
  role: 'ADMIN' | 'PROVIDER';
  providerId: string | null;
  canApprove: boolean;
  tz: string;
}
export const StaffContext = createContext<StaffInfo>({
  role: 'ADMIN',
  providerId: null,
  canApprove: true,
  tz: 'America/Anguilla',
});
export const useStaff = () => useContext(StaffContext);

/** Fetch JSON with loading/error state and a reload function. */
export function useData<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      setData(await api<T>(url));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Run a mutation, surface its error, then refresh. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, after?: () => unknown): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      await after?.();
      return r;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export const post = (url: string, json: unknown = {}, method = 'POST') => api(url, { method, json });

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Panel({
  title,
  className,
  children,
  actions,
}: {
  title?: string;
  className?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className={cn('border-line rounded-lg border bg-white p-4', className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-lg font-bold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export const th = 'border-b border-line px-2 py-1.5 text-left text-xs font-bold uppercase tracking-wide text-muted';
export const td = 'border-b border-line px-2 py-1.5 align-top text-sm';
export const inp =
  'rounded-md border border-line bg-white px-2 py-1.5 text-sm focus:border-jacaranda focus:outline-none disabled:bg-paper';

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-laterite rounded-md bg-[#fbeeeb] px-3 py-2 text-sm">
      {error}
    </p>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted py-4 text-sm">{children}</p>;
}

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1 text-sm', className)}>
      <span className="font-bold">{label}</span>
      {children}
    </label>
  );
}

const statusTone: Record<string, string> = {
  CONFIRMED: 'bg-acacia text-white',
  COMPLETED: 'bg-acacia/80 text-white',
  REQUESTED: 'bg-sunbird text-ink',
  ALTERNATE_PROPOSED: 'bg-sunbird/60 text-ink',
  SENT: 'bg-acacia/80 text-white',
  DELIVERED: 'bg-acacia text-white',
  READ: 'bg-acacia text-white',
  PENDING: 'bg-sunbird text-ink',
  SENDING: 'bg-sunbird text-ink',
  RECEIVED: 'bg-jacaranda-light text-jacaranda',
  SKIPPED: 'bg-line text-ink',
  UNPAID: 'bg-sunbird text-ink',
  PAID_CASH: 'bg-acacia text-white',
  PAID_BANK_TRANSFER: 'bg-acacia text-white',
  WAIVED: 'bg-line text-ink',
};
export function Pill({ value, label }: { value: string; label?: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded px-1.5 py-0.5 text-xs font-bold whitespace-nowrap',
        statusTone[value] ?? 'bg-laterite text-white',
      )}
    >
      {label ?? value.replaceAll('_', ' ').toLowerCase()}
    </span>
  );
}

export function SmallButton(props: React.ComponentProps<typeof Button>) {
  return <Button size="sm" {...props} />;
}
