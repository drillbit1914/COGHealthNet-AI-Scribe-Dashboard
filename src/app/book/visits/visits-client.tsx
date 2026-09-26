'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SlotPicker } from '@/components/book/slot-picker';
import { Button } from '@/components/ui/button';
import { Alert, Card, Choice, Help, Input, Label, StatusBadge } from '@/components/ui/field';
import { t } from '@/i18n';
import { api } from '@/lib/api';

interface Visit {
  id: string;
  ref: string;
  visitType: 'FOLLOW_UP' | 'EVALUATION';
  when: string;
  status: string;
  provider: string | null;
  canChange: boolean;
  isLate: boolean;
  alternatePending: boolean;
}
interface Data {
  child: { id: string; name: string; canBook: boolean };
  upcoming: Visit[];
  past: Visit[];
}

export function ChildVisits({ data, notice, cutoffHours }: { data: Data; notice: string | null; cutoffHours: number }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-2xl font-bold">{data.child.name}</h2>
      {notice && <Alert>{notice}</Alert>}
      <h3 className="text-muted font-bold">{t('ui.visits.upcoming')}</h3>
      {data.upcoming.length === 0 && <p className="text-muted">{t('ui.visits.none')}</p>}
      {data.upcoming.map((v) => (
        <VisitCard key={v.id} v={v} cutoffHours={cutoffHours} />
      ))}
      {data.child.canBook && <WaitlistForm patientId={data.child.id} />}
      {data.past.length > 0 && (
        <details className="border-line rounded-xl border bg-white p-4">
          <summary className="cursor-pointer font-bold">{t('ui.visits.past')}</summary>
          <ul className="mt-3 flex flex-col gap-2">
            {data.past.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2">
                <span>
                  {t(`visitTypeTitle.${v.visitType}`)} · {v.when}
                </span>
                <StatusBadge status={v.status} label={t(`ui.status.${v.status}`)} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function VisitCard({ v, cutoffHours }: { v: Visit; cutoffHours: number }) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'cancel' | 'reschedule'>('idle');
  const [newTime, setNewTime] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  async function run(path: string, json?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', json: json ?? {} });
      setMode('idle');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setRefreshKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3" data-testid="visit-card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-lg font-bold">{t(`visitTypeTitle.${v.visitType}`)}</p>
          <p>{v.when}</p>
          {v.provider && <p className="text-muted">{t('ui.visits.with', { provider: v.provider })}</p>}
          <p className="text-muted text-sm">{t('ui.visits.ref', { ref: v.ref })}</p>
        </div>
        <StatusBadge status={v.status} label={t(`ui.status.${v.status}`)} />
      </div>
      {v.alternatePending && (
        <div className="flex flex-col gap-2">
          <p className="font-bold">{t('ui.visits.altOffered')}</p>
          <Button disabled={busy} onClick={() => run(`/api/book/appointments/${v.id}/accept-alternate`)}>
            {t('ui.visits.acceptAlt')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => run(`/api/book/appointments/${v.id}/decline-alternate`)}
          >
            {t('ui.visits.declineAlt')}
          </Button>
        </div>
      )}
      {v.canChange && mode === 'idle' && (
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={() => setMode('reschedule')}>
            {t('ui.visits.reschedule')}
          </Button>
          <Button variant="ghost" className="flex-1" onClick={() => setMode('cancel')}>
            {t('ui.visits.cancel')}
          </Button>
        </div>
      )}
      {mode === 'cancel' && (
        <div className="flex flex-col gap-2">
          <p className="font-bold">{t('ui.visits.cancelConfirm')}</p>
          {v.isLate && <Alert tone="warning">{t('ui.visits.cancelLate', { hours: cutoffHours })}</Alert>}
          <Button variant="danger" disabled={busy} onClick={() => run(`/api/book/appointments/${v.id}/cancel`)}>
            {t('ui.visits.cancel')}
          </Button>
          <Button variant="ghost" onClick={() => setMode('idle')}>
            {t('ui.visits.keep')}
          </Button>
        </div>
      )}
      {mode === 'reschedule' && (
        <div className="flex flex-col gap-3">
          <p className="font-bold">{t('ui.visits.rescheduleTitle')}</p>
          {v.isLate && <Alert tone="warning">{t('ui.visits.cancelLate', { hours: cutoffHours })}</Alert>}
          <SlotPicker visitType={v.visitType} value={newTime} onChange={(s) => setNewTime(s)} refreshKey={refreshKey} />
          <Button
            disabled={!newTime || busy}
            onClick={() => run(`/api/book/appointments/${v.id}/reschedule`, { startsAt: newTime })}
          >
            {t('ui.visits.rescheduleSubmit')}
          </Button>
          <Button variant="ghost" onClick={() => setMode('idle')}>
            {t('ui.visits.keep')}
          </Button>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </Card>
  );
}

function WaitlistForm({ patientId }: { patientId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ visitType: 'FOLLOW_UP', dateFrom: today, dateTo: today, window: 'ANY' });
  const [state, setState] = useState<'idle' | 'done' | string>('idle');
  return (
    <details className="border-line rounded-xl border bg-white p-4">
      <summary className="cursor-pointer font-bold">{t('ui.visits.waitlistTitle')}</summary>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/api/book/waitlist', { method: 'POST', json: { patientId, ...f } });
            setState('done');
          } catch (err) {
            setState((err as Error).message);
          }
        }}
      >
        <Help className="mt-0">{t('ui.visits.waitlistHelp')}</Help>
        {(['FOLLOW_UP', 'EVALUATION'] as const).map((vt) => (
          <Choice
            key={vt}
            name={`wl-vt-${patientId}`}
            checked={f.visitType === vt}
            onChange={() => setF({ ...f, visitType: vt })}
            label={t(`ui.type.${vt}`)}
          />
        ))}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor={`wl-from-${patientId}`}>{t('ui.visits.from')}</Label>
            <Input
              id={`wl-from-${patientId}`}
              type="date"
              min={today}
              value={f.dateFrom}
              onChange={(e) => setF({ ...f, dateFrom: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor={`wl-to-${patientId}`}>{t('ui.visits.to')}</Label>
            <Input
              id={`wl-to-${patientId}`}
              type="date"
              min={f.dateFrom}
              value={f.dateTo}
              onChange={(e) => setF({ ...f, dateTo: e.target.value })}
            />
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-bold">{t('ui.visits.window')}</legend>
          {(['ANY', 'MORNING', 'AFTERNOON'] as const).map((w) => (
            <Choice
              key={w}
              name={`wl-w-${patientId}`}
              checked={f.window === w}
              onChange={() => setF({ ...f, window: w })}
              label={t(`ui.visits.${w}`)}
            />
          ))}
        </fieldset>
        {state === 'done' ? (
          <Alert tone="success">{t('ui.visits.joined')}</Alert>
        ) : (
          state !== 'idle' && <Alert tone="error">{state}</Alert>
        )}
        <Button type="submit" variant="secondary">
          {t('ui.visits.join')}
        </Button>
      </form>
    </details>
  );
}
