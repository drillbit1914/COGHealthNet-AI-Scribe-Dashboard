'use client';

import { useState } from 'react';
import { clinicToIso, dayOf, fmtWhen } from '@/lib/clinic-time';
import { Empty, ErrorNote, Field, inp, Panel, post, SmallButton, td, th, useAction, useData, useStaff } from './ui';

interface Row {
  id: string;
  provider_id: string | null;
  provider: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  is_closure: boolean;
}

/** Provider or clinic-wide time off, date range or partial day (PRD §9). Providers manage their own. */
export function TimeOffPanel() {
  const { tz, role, providerId } = useStaff();
  const list = useData<Row[]>('/api/admin/time-off');
  const providers = useData<{ id: string; name: string; active: boolean }[]>('/api/admin/providers');
  const today = dayOf(new Date(), tz);
  const [f, setF] = useState({
    providerId: role === 'PROVIDER' ? (providerId ?? '') : '',
    fromDate: today,
    fromTime: '08:00',
    toDate: today,
    toTime: '18:00',
    reason: '',
  });
  const { busy, error, run } = useAction();
  return (
    <Panel title="Time off">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        {role === 'ADMIN' && (
          <Field label="Who">
            <select className={inp} value={f.providerId} onChange={(e) => setF({ ...f, providerId: e.target.value })}>
              <option value="">Whole clinic</option>
              {providers.data
                ?.filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="From">
          <div className="flex gap-1">
            <input
              type="date"
              className={inp}
              value={f.fromDate}
              onChange={(e) => setF({ ...f, fromDate: e.target.value })}
            />
            <input
              type="time"
              step={1800}
              className={inp}
              value={f.fromTime}
              onChange={(e) => setF({ ...f, fromTime: e.target.value })}
            />
          </div>
        </Field>
        <Field label="To">
          <div className="flex gap-1">
            <input
              type="date"
              className={inp}
              value={f.toDate}
              onChange={(e) => setF({ ...f, toDate: e.target.value })}
            />
            <input
              type="time"
              step={1800}
              className={inp}
              value={f.toTime}
              onChange={(e) => setF({ ...f, toTime: e.target.value })}
            />
          </div>
        </Field>
        <Field label="Reason">
          <input className={inp} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        <SmallButton
          disabled={busy}
          onClick={() =>
            run(
              () =>
                post('/api/admin/time-off', {
                  providerId: f.providerId || null,
                  startsAt: clinicToIso(f.fromDate, f.fromTime, tz),
                  endsAt: clinicToIso(f.toDate, f.toTime, tz),
                  reason: f.reason || undefined,
                }),
              list.reload,
            )
          }
        >
          Add time off
        </SmallButton>
      </div>
      <ErrorNote error={error ?? list.error} />
      <table className="w-full">
        <thead>
          <tr>
            <th className={th}>Who</th>
            <th className={th}>From</th>
            <th className={th}>To</th>
            <th className={th}>Reason</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {list.data?.map((r) => (
            <tr key={r.id}>
              <td className={td}>{r.provider ?? (r.is_closure ? 'Clinic closure' : 'Whole clinic')}</td>
              <td className={td}>{fmtWhen(r.starts_at, tz)}</td>
              <td className={td}>{fmtWhen(r.ends_at, tz)}</td>
              <td className={td}>{r.reason}</td>
              <td className={td}>
                {(role === 'ADMIN' || r.provider_id === providerId) && (
                  <SmallButton
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      confirm('Remove this block?') &&
                      run(() => post(`/api/admin/time-off/${r.id}`, undefined, 'DELETE'), list.reload)
                    }
                  >
                    Remove
                  </SmallButton>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.data?.length && <Empty>No upcoming time off.</Empty>}
    </Panel>
  );
}
