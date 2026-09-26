'use client';

import { useState } from 'react';
import { PaymentForm } from '@/components/admin/payment-form';
import {
  Empty,
  ErrorNote,
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
import { addDaysStr, dayOf, fmtWhen } from '@/lib/clinic-time';

interface Unpaid {
  id: string;
  ref: string;
  starts_at: string;
  visit_type: 'FOLLOW_UP' | 'EVALUATION';
  status: string;
  child: string;
  proofs: number;
}
interface Proof {
  id: string;
  appointment_id: string;
  text: string | null;
  file_url: string | null;
  received_at: string;
  ref: string;
  payment_status: string;
  child: string;
  guardian: string | null;
  phone_e164: string | null;
}

export default function PaymentsPage() {
  const { tz } = useStaff();
  const today = dayOf(new Date(), tz);
  const [range, setRange] = useState({ from: addDaysStr(today, -6), to: today });
  const unpaid = useData<Unpaid[]>('/api/admin/payments/unpaid');
  const proofs = useData<Proof[]>('/api/admin/payments/proofs');
  const totals = useData<{ day: string; payment_status: string; n: number }[]>(
    `/api/admin/payments/totals?from=${range.from}&to=${range.to}`,
  );
  const { busy, error, run } = useAction();
  const reloadAll = () => Promise.all([unpaid.reload(), proofs.reload(), totals.reload()]);
  const days = [...new Set(totals.data?.map((r) => r.day))];
  const cell = (day: string, s: string) => totals.data?.find((r) => r.day === day && r.payment_status === s)?.n ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Payments" />
      <ErrorNote error={error ?? unpaid.error ?? proofs.error} />
      <Panel title="Payment proofs to review (from WhatsApp/SMS)">
        {!proofs.data?.length && <Empty>Nothing to review.</Empty>}
        {proofs.data?.map((p) => (
          <div
            key={p.id}
            className="border-line flex flex-wrap items-start justify-between gap-3 border-b py-2 text-sm"
            data-testid="proof"
          >
            <div>
              <p>
                <b>{p.child}</b> · {p.ref} · from {p.guardian ?? p.phone_e164} · {fmtWhen(p.received_at, tz)}
              </p>
              {p.text && <p className="italic">“{p.text}”</p>}
              {p.file_url && (
                <a className="text-jacaranda underline" href={p.file_url} target="_blank" rel="noreferrer">
                  View attachment
                </a>
              )}
              <p className="text-muted text-xs">
                Check against the NCBA statement before marking paid. Never auto-marked.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <PaymentForm
                id={p.appointment_id}
                defaultStatus="PAID_BANK_TRANSFER"
                defaultReference={p.text?.match(/[A-Z0-9-]{4,}/i)?.[0] ?? ''}
                onDone={reloadAll}
              />
              <SmallButton
                variant="ghost"
                disabled={busy}
                onClick={() => run(() => post(`/api/admin/payments/proofs/${p.id}/reviewed`), reloadAll)}
              >
                Mark reviewed
              </SmallButton>
            </div>
          </div>
        ))}
      </Panel>
      <Panel title="Unpaid visits">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>When</th>
              <th className={th}>Child</th>
              <th className={th}>Visit</th>
              <th className={th}>Status</th>
              <th className={th}>Mark paid</th>
            </tr>
          </thead>
          <tbody>
            {unpaid.data?.map((u) => (
              <tr key={u.id}>
                <td className={td}>{fmtWhen(u.starts_at, tz)}</td>
                <td className={td}>
                  <b>{u.child}</b> {u.proofs > 0 && <span className="text-acacia text-xs">· proof received</span>}
                </td>
                <td className={td}>
                  {t(`visitTypeTitle.${u.visit_type}`)} · {u.ref}
                </td>
                <td className={td}>{u.status.toLowerCase().replaceAll('_', ' ')}</td>
                <td className={td}>
                  <PaymentForm id={u.id} onDone={reloadAll} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!unpaid.data?.length && <Empty>Everything is paid.</Empty>}
      </Panel>
      <Panel
        title="Daily totals by method (payments recorded)"
        actions={
          <div className="flex gap-2">
            <input
              type="date"
              className={inp}
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              aria-label="From"
            />
            <input
              type="date"
              className={inp}
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              aria-label="To"
            />
          </div>
        }
      >
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Day</th>
              <th className={th}>Cash</th>
              <th className={th}>Bank transfer</th>
              <th className={th}>Waived</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d}>
                <td className={td}>{d}</td>
                <td className={td}>{cell(d, 'PAID_CASH')}</td>
                <td className={td}>{cell(d, 'PAID_BANK_TRANSFER')}</td>
                <td className={td}>{cell(d, 'WAIVED')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!days.length && <Empty>No payments recorded in this range.</Empty>}
      </Panel>
    </div>
  );
}
