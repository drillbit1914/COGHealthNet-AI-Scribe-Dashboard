'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/field';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Day {
  date: string;
  label: string;
  short: string;
  times: { startsAt: string; label: string }[];
}

/**
 * Only Fridays/Saturdays with pooled open times appear (the server decides — never computed here).
 * `refreshKey` forces a refetch in place, e.g. after "That time was just taken".
 */
export function SlotPicker({
  visitType,
  value,
  onChange,
  refreshKey = 0,
}: {
  visitType: 'FOLLOW_UP' | 'EVALUATION';
  value?: string;
  onChange: (startsAt: string | undefined, label?: string) => void;
  refreshKey?: number;
}) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDays(null);
    api<{ days: Day[] }>(`/api/book/slots?visitType=${visitType}`)
      .then((r) => {
        if (!live) return;
        setDays(r.days);
        const stillOpen = r.days.find((d) => d.times.some((x) => x.startsAt === value));
        if (value && !stillOpen) onChange(undefined);
        setDate(stillOpen?.date ?? r.days[0]?.date ?? null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitType, refreshKey]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!days) return <p className="text-muted">{t('ui.time.loading')}</p>;
  if (!days.length) return <Alert tone="info">{t('ui.time.none')}</Alert>;
  const day = days.find((d) => d.date === date) ?? days[0];

  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className="mb-2 font-bold">{t('ui.time.pickDate')}</legend>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2">
          {days.map((d) => (
            <button
              key={d.date}
              type="button"
              aria-pressed={d.date === day.date}
              aria-label={d.label}
              onClick={() => setDate(d.date)}
              className={cn(
                'shrink-0 rounded-xl border-2 px-4 py-3 text-left font-bold',
                d.date === day.date ? 'border-jacaranda bg-jacaranda text-white' : 'border-line bg-white',
              )}
            >
              {d.short}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 font-bold">
          {t('ui.time.pickTime')} — {day.label}
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {day.times.map((x) => (
            <button
              key={x.startsAt}
              type="button"
              aria-pressed={x.startsAt === value}
              onClick={() => onChange(x.startsAt, `${day.label}, ${x.label}`)}
              className={cn(
                'h-12 rounded-xl border-2 font-bold',
                x.startsAt === value ? 'border-jacaranda bg-jacaranda text-white' : 'border-line bg-white',
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
