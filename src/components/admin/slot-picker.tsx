'use client';

import { useState } from 'react';
import { dayOf, fmtIn } from '@/lib/clinic-time';
import { cn } from '@/lib/utils';
import { useData, useStaff } from './ui';

/** Pooled open times (server-computed) for proposing an alternate. */
export function AdminSlotPicker({
  url,
  value,
  onChange,
}: {
  url: string;
  value?: string;
  onChange: (iso: string) => void;
}) {
  const { tz } = useStaff();
  const { data, error } = useData<{ startsAt: string; freeProviders: number }[]>(url);
  const [day, setDay] = useState<string | null>(null);
  if (error) return <p className="text-laterite text-sm">{error}</p>;
  if (!data) return <p className="text-muted text-sm">Loading open times…</p>;
  if (!data.length) return <p className="text-muted text-sm">No open times in the booking window.</p>;
  const days = [...new Set(data.map((s) => dayOf(s.startsAt, tz)))];
  const current = day ?? days[0];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {days.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDay(d)}
            className={cn(
              'rounded border px-2 py-1 text-xs font-bold',
              d === current ? 'border-jacaranda bg-jacaranda text-white' : 'border-line',
            )}
          >
            {fmtIn(`${d}T12:00:00Z`, 'UTC', 'EEE d MMM')}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {data
          .filter((s) => dayOf(s.startsAt, tz) === current)
          .map((s) => (
            <button
              key={s.startsAt}
              type="button"
              onClick={() => onChange(s.startsAt)}
              className={cn(
                'rounded border px-2 py-1 text-xs',
                s.startsAt === value ? 'border-jacaranda bg-jacaranda text-white' : 'border-line',
              )}
              title={`${s.freeProviders} provider(s) free`}
            >
              {fmtIn(s.startsAt, tz, 'h:mm a')}
            </button>
          ))}
      </div>
    </div>
  );
}
