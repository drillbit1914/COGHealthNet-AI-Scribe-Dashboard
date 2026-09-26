'use client';

import { useState } from 'react';
import {
  Empty,
  ErrorNote,
  Field,
  inp,
  PageHeader,
  Panel,
  post,
  SmallButton,
  td,
  th,
  useAction,
  useData,
  useStaff,
} from '@/components/admin/ui';
import { t } from '@/i18n';
import { addDaysStr, clinicToIso, dayOf, fmtWhen } from '@/lib/clinic-time';

interface Affected {
  id: string;
  ref: string;
  status: string;
  visit_type: 'FOLLOW_UP' | 'EVALUATION';
  starts_at: string;
  child: string;
  provider: string;
}
interface Rebook {
  id: string;
  reason: string;
  ref: string;
  starts_at: string;
  visit_type: 'FOLLOW_UP' | 'EVALUATION';
  patient_id: string;
  child: string;
  contacts: string | null;
}

/** Clinic closure (PRD §9): preview → one action cancels all, sends T10, fills the rebook list. */
export default function ClosuresPage() {
  const { tz } = useStaff();
  const today = dayOf(new Date(), tz);
  const [f, setF] = useState({ from: today, to: today, reason: '' });
  const [preview, setPreview] = useState<Affected[] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const rebook = useData<Rebook[]>('/api/admin/rebook');
  const { busy, error, run } = useAction();
  const range = {
    startsAt: clinicToIso(f.from, '00:00', tz),
    endsAt: clinicToIso(addDaysStr(f.to, 1), '00:00', tz),
    reason: f.reason,
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Clinic closures" />
      <Panel title="Close the clinic">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="First day closed">
            <input
              type="date"
              className={inp}
              value={f.from}
              onChange={(e) => (setF({ ...f, from: e.target.value }), setPreview(null))}
            />
          </Field>
          <Field label="Last day closed">
            <input
              type="date"
              className={inp}
              value={f.to}
              onChange={(e) => (setF({ ...f, to: e.target.value }), setPreview(null))}
            />
          </Field>
          <Field label="Reason (sent to families)" className="min-w-64 flex-1">
            <input
              className={inp}
              value={f.reason}
              placeholder="e.g. Tropical storm warning"
              onChange={(e) => setF({ ...f, reason: e.target.value })}
            />
          </Field>
          <SmallButton
            variant="secondary"
            disabled={busy || f.to < f.from}
            onClick={() =>
              run(async () => setPreview((await post('/api/admin/closures/preview', range)) as Affected[]))
            }
          >
            Preview affected visits
          </SmallButton>
        </div>
        {preview && (
          <div className="mt-3">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Child</th>
                  <th className={th}>Visit</th>
                  <th className={th}>Provider</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((a) => (
                  <tr key={a.id}>
                    <td className={td}>{fmtWhen(a.starts_at, tz)}</td>
                    <td className={td}>{a.child}</td>
                    <td className={td}>
                      {t(`visitTypeTitle.${a.visit_type}`)} · {a.ref}
                    </td>
                    <td className={td}>{a.provider}</td>
                    <td className={td}>{a.status.toLowerCase().replaceAll('_', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!preview.length && <Empty>No visits are booked in this range.</Empty>}
            <SmallButton
              variant="danger"
              className="mt-3"
              disabled={busy || !f.reason.trim()}
              onClick={() =>
                confirm(
                  `Close the clinic and cancel ${preview.length} visit(s)? Every notified guardian gets a closure message.`,
                ) &&
                run(async () => {
                  const r = (await post('/api/admin/closures', range)) as { cancelled: number };
                  setResult(`Closed. ${r.cancelled} visit(s) cancelled and families notified.`);
                  setPreview(null);
                }, rebook.reload)
              }
            >
              Close clinic and cancel {preview.length} visit(s)
            </SmallButton>
          </div>
        )}
        {result && <p className="text-acacia mt-2 font-bold">{result}</p>}
        <ErrorNote error={error} />
      </Panel>
      <Panel title="Rebook list">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Child</th>
              <th className={th}>Cancelled visit</th>
              <th className={th}>Contact</th>
              <th className={th}>Reason</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {rebook.data?.map((r) => (
              <tr key={r.id}>
                <td className={td}>
                  <a className="text-jacaranda font-bold hover:underline" href={`/admin/patients/${r.patient_id}`}>
                    {r.child}
                  </a>
                </td>
                <td className={td}>
                  {fmtWhen(r.starts_at, tz)} · {t(`visitTypeTitle.${r.visit_type}`)} · {r.ref}
                </td>
                <td className={td}>{r.contacts}</td>
                <td className={td}>{r.reason}</td>
                <td className={td}>
                  <SmallButton
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run(() => post(`/api/admin/rebook/${r.id}/resolve`), rebook.reload)}
                  >
                    Rebooked
                  </SmallButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rebook.data?.length && <Empty>No families waiting to rebook.</Empty>}
      </Panel>
    </div>
  );
}
