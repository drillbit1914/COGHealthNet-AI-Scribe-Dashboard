'use client';

import { useState } from 'react';
import { Empty, ErrorNote, inp, PageHeader, Pill, td, th, useData, useStaff } from '@/components/admin/ui';
import { fmtWhen } from '@/lib/clinic-time';
import { cn } from '@/lib/utils';

interface Msg {
  id: string;
  created_at: string;
  direction: string;
  channel: string | null;
  status: string;
  template_key: string | null;
  to_phone: string | null;
  error: string | null;
  attempts: number;
  fallback_of_id: string | null;
  body: string | null;
  guardian: string | null;
  ref: string | null;
}
interface Audit {
  id: string;
  at: string;
  actor_type: string;
  actor: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}

export default function MessagesPage() {
  const { tz } = useStaff();
  const [tab, setTab] = useState<'messages' | 'audit'>('messages');
  const [f, setF] = useState({ status: '', template: '', phone: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const msgs = useData<Msg[]>(tab === 'messages' ? `/api/admin/messages?${qs}` : null);
  const audit = useData<Audit[]>(tab === 'audit' ? '/api/admin/audit' : null);
  return (
    <div>
      <PageHeader title="Messages & audit">
        {(['messages', 'audit'] as const).map((x) => (
          <button
            key={x}
            onClick={() => setTab(x)}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-bold',
              tab === x ? 'bg-jacaranda text-white' : 'text-jacaranda',
            )}
          >
            {x === 'messages' ? 'Message log' : 'Audit log'}
          </button>
        ))}
      </PageHeader>
      {tab === 'messages' && (
        <>
          <div className="mb-3 flex gap-2">
            <select
              className={inp}
              value={f.status}
              onChange={(e) => setF({ ...f, status: e.target.value })}
              aria-label="Status"
            >
              <option value="">All statuses</option>
              {['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'RECEIVED'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              className={inp}
              placeholder="Template (T1…)"
              value={f.template}
              onChange={(e) => setF({ ...f, template: e.target.value.toUpperCase() })}
            />
            <input
              className={inp}
              placeholder="Phone contains"
              value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value })}
            />
          </div>
          <ErrorNote error={msgs.error} />
          <table className="w-full bg-white">
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Dir</th>
                <th className={th}>Channel</th>
                <th className={th}>Template</th>
                <th className={th}>To / from</th>
                <th className={th}>Status</th>
                <th className={th}>Message</th>
              </tr>
            </thead>
            <tbody>
              {msgs.data?.map((m) => (
                <tr key={m.id}>
                  <td className={td}>{fmtWhen(m.created_at, tz)}</td>
                  <td className={td}>{m.direction === 'IN' ? '← in' : '→ out'}</td>
                  <td className={td}>
                    {m.channel ?? '—'}
                    {m.fallback_of_id && <span className="text-muted text-xs"> (fallback)</span>}
                  </td>
                  <td className={td}>{m.template_key}</td>
                  <td className={td}>
                    {m.guardian} {m.to_phone} {m.ref && <span className="text-muted">· {m.ref}</span>}
                  </td>
                  <td className={td}>
                    <Pill value={m.status} />
                    {m.attempts > 1 && <span className="text-xs"> ×{m.attempts}</span>}
                    {m.error && <p className="text-laterite text-xs">{m.error}</p>}
                  </td>
                  <td className={cn(td, 'max-w-md text-xs')}>
                    {m.body ?? <span className="text-muted">(not retained)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!msgs.data?.length && <Empty>No messages.</Empty>}
        </>
      )}
      {tab === 'audit' && (
        <>
          <ErrorNote error={audit.error} />
          <table className="w-full bg-white">
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Who</th>
                <th className={th}>Action</th>
                <th className={th}>Record</th>
                <th className={th}>Change</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.map((a) => (
                <tr key={a.id}>
                  <td className={td}>{fmtWhen(a.at, tz)}</td>
                  <td className={td}>
                    {a.actor ?? a.actor_type.toLowerCase()}{' '}
                    <span className="text-muted text-xs">{a.actor_type.toLowerCase()}</span>
                  </td>
                  <td className={td}>{a.action}</td>
                  <td className={td}>
                    {a.entity} <span className="text-muted text-xs">{a.entity_id?.slice(0, 8)}</span>
                  </td>
                  <td className={cn(td, 'max-w-md font-mono text-[11px]')}>
                    {a.before != null && <p className="text-laterite">− {JSON.stringify(a.before)}</p>}
                    {a.after != null && <p className="text-acacia">+ {JSON.stringify(a.after)}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
