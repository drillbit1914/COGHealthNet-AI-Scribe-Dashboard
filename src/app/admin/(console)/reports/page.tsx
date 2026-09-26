'use client';

import { useState } from 'react';
import { Empty, ErrorNote, inp, PageHeader, Panel, td, th, useData, useStaff } from '@/components/admin/ui';
import { addDaysStr, dayOf } from '@/lib/clinic-time';

interface Report {
  visitsByProvider: { provider: string; status: string; n: number }[];
  load: { provider: string; color: string; visits: number; hours: number }[];
  outcomes: { outcome: string; n: number }[];
  payments: { payment_status: string; n: number }[];
  noShowRate: number | null;
  lateCancels: number;
}

const label = (s: string) => s.toLowerCase().replaceAll('_', ' ');

export default function ReportsPage() {
  const { tz } = useStaff();
  const today = dayOf(new Date(), tz);
  const [r, setR] = useState({ from: addDaysStr(today, -27), to: today });
  const { data, error } = useData<Report>(`/api/admin/reports?from=${r.from}&to=${r.to}`);
  const statuses = ['CONFIRMED', 'COMPLETED', 'NO_SHOW'];
  const count = (p: string, s: string) =>
    data?.visitsByProvider.find((x) => x.provider === p && x.status === s)?.n ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Reports">
        <input
          type="date"
          className={inp}
          value={r.from}
          onChange={(e) => setR({ ...r, from: e.target.value })}
          aria-label="From"
        />
        <input
          type="date"
          className={inp}
          value={r.to}
          onChange={(e) => setR({ ...r, to: e.target.value })}
          aria-label="To"
        />
      </PageHeader>
      <ErrorNote error={error} />
      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Panel title="No-show rate">
              <p className="text-3xl font-bold">{data.noShowRate == null ? '—' : `${data.noShowRate}%`}</p>
              <p className="text-muted text-sm">of attended or missed visits</p>
            </Panel>
            <Panel title="Late cancellations">
              <p className="text-3xl font-bold">{data.lateCancels}</p>
            </Panel>
            <Panel title="Requests">
              {data.outcomes.map((o) => (
                <p key={o.outcome} className="text-sm">
                  {label(o.outcome)}: <b>{o.n}</b>
                </p>
              ))}
              {!data.outcomes.length && <Empty>No requests.</Empty>}
            </Panel>
          </div>
          <Panel title="Visits and load by provider">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Provider</th>
                  {statuses.map((s) => (
                    <th key={s} className={th}>
                      {label(s)}
                    </th>
                  ))}
                  <th className={th}>Booked hours</th>
                </tr>
              </thead>
              <tbody>
                {data.load.map((l) => (
                  <tr key={l.provider}>
                    <td className={td}>
                      <span className="mr-2 inline-block size-3 rounded-full" style={{ background: l.color }} />
                      {l.provider}
                    </td>
                    {statuses.map((s) => (
                      <td key={s} className={td}>
                        {count(l.provider, s)}
                      </td>
                    ))}
                    <td className={td}>{l.hours.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Payments recorded by method">
            {data.payments.map((p) => (
              <p key={p.payment_status} className="text-sm">
                {label(p.payment_status)}: <b>{p.n}</b>
              </p>
            ))}
            {!data.payments.length && <Empty>No payments recorded.</Empty>}
          </Panel>
        </>
      )}
    </div>
  );
}
