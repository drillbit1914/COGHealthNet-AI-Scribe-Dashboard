'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminSlotPicker } from '@/components/admin/slot-picker';
import {
  Empty,
  ErrorNote,
  inp,
  PageHeader,
  Pill,
  post,
  SmallButton,
  useAction,
  useData,
  useStaff,
} from '@/components/admin/ui';
import { t } from '@/i18n';
import { addDaysStr, dayOf, fmtWhen } from '@/lib/clinic-time';

interface Item {
  id: string;
  ref: string;
  visit_type: 'FOLLOW_UP' | 'EVALUATION';
  starts_at: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  provider_id: string;
  provider_name: string;
  discipline: string;
  provider_assigned_by: string;
  original_starts_at: string | null;
  patient_id: string;
  child: string;
  dob: string | null;
  needs_admin_match: boolean;
  requested_by: string | null;
  requested_by_phone: string | null;
  no_shows: number;
  late_cancels: number;
  proofs: number;
  reason_text: string | null;
  reason_tags: string[] | null;
  payer_type: string | null;
  insurer: string | null;
  member_no: string | null;
  has_referral: boolean | null;
  referral_url: string | null;
}

function useNow(ms = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return now;
}

function Countdown({ to }: { to: string | null }) {
  const now = useNow();
  if (!to) return null;
  const mins = Math.round((new Date(to).getTime() - now) / 60000);
  const label = mins <= 0 ? 'expiring now' : `expires in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return <span className={mins < 6 * 60 ? 'text-laterite font-bold' : 'text-muted'}>{label}</span>;
}

export default function QueuePage() {
  const { data, error, reload } = useData<Item[]>('/api/admin/queue');
  return (
    <div>
      <PageHeader title="Approval queue">
        <SmallButton variant="secondary" onClick={reload}>
          Refresh
        </SmallButton>
      </PageHeader>
      <ErrorNote error={error} />
      {data && !data.length && <Empty>No requests waiting. </Empty>}
      <div className="flex flex-col gap-3">
        {data?.map((item) => (
          <QueueItem key={item.id} item={item} onDone={reload} />
        ))}
      </div>
    </div>
  );
}

function QueueItem({ item, onDone }: { item: Item; onDone: () => void }) {
  const { tz, canApprove, role } = useStaff();
  const pending = item.status === 'REQUESTED';
  const [provider, setProvider] = useState(item.provider_id);
  const [mode, setMode] = useState<'idle' | 'decline' | 'propose'>('idle');
  const [reason, setReason] = useState('');
  const [alt, setAlt] = useState<string>();
  const { busy, error, run } = useAction();
  const { data: cands } = useData<{ id: string; name: string; discipline: string; load: number; suggested: boolean }[]>(
    pending && canApprove ? `/api/admin/appointments/${item.id}/candidates` : null,
  );
  const act = (path: string, body: unknown = {}) =>
    run(() => post(`/api/admin/appointments/${item.id}/${path}`, body), onDone);
  const today = dayOf(new Date(), tz);

  return (
    <article className="border-line rounded-lg border bg-white p-4" data-testid="queue-item">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-lg font-bold">
            {item.patient_id && (
              <Link href={`/admin/patients/${item.patient_id}`} className="hover:underline">
                {item.child}
              </Link>
            )}{' '}
            <span className="text-muted text-sm font-normal">
              {t(`visitTypeTitle.${item.visit_type}`)} · {item.ref}
            </span>
          </p>
          <p className="font-bold" data-testid="queue-when">
            {fmtWhen(item.starts_at, tz)}
          </p>
          {item.original_starts_at && (
            <p className="text-muted text-sm">Originally requested {fmtWhen(item.original_starts_at, tz)}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 text-sm">
          <Pill value={item.status} label={item.status === 'ALTERNATE_PROPOSED' ? 'waiting for family' : 'requested'} />
          <Countdown to={item.expires_at} />
        </div>
      </div>

      <div className="mt-2 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
        <p>
          Requested by <b>{item.requested_by ?? '—'}</b> {item.requested_by_phone}
        </p>
        <p>
          No-shows <b className={item.no_shows ? 'text-laterite' : ''}>{item.no_shows}</b> · Late cancels{' '}
          <b>{item.late_cancels}</b>
          {item.proofs > 0 && (
            <>
              {' '}
              · <b>{item.proofs}</b> payment proof(s)
            </>
          )}
        </p>
        {item.needs_admin_match && (
          <p className="text-laterite font-bold">Typed name — match to an existing child before confirming.</p>
        )}
        {item.visit_type === 'EVALUATION' && item.reason_text && (
          <div className="bg-paper rounded-md p-2 md:col-span-2">
            <p>
              <b>Reason:</b> {item.reason_text}
            </p>
            {!!item.reason_tags?.length && (
              <p className="text-muted">{item.reason_tags.join(', ').replaceAll('_', ' ')}</p>
            )}
            <p>
              <b>{item.payer_type === 'INSURANCE' ? `Insurance: ${item.insurer} · ${item.member_no}` : 'Self-pay'}</b>
              {item.referral_url && (
                <>
                  {' '}
                  ·{' '}
                  <a className="text-jacaranda underline" href={item.referral_url} target="_blank" rel="noreferrer">
                    Referral letter
                  </a>
                </>
              )}
              {item.dob && <> · DOB {item.dob.slice(0, 10)}</>}
            </p>
          </div>
        )}
      </div>

      {pending && canApprove && (
        <div className="border-line mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
          <label className="flex flex-col text-sm">
            <span className="font-bold">
              Provider{' '}
              {item.provider_assigned_by === 'SYSTEM' && (
                <span className="text-muted font-normal">(suggested: {item.provider_name})</span>
              )}
            </span>
            <select
              className={inp}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              aria-label="Provider"
            >
              {(
                cands ?? [
                  {
                    id: item.provider_id,
                    name: item.provider_name,
                    discipline: item.discipline,
                    load: 0,
                    suggested: true,
                  },
                ]
              ).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.discipline} · {c.load} other today{c.suggested ? ' · suggested' : ''}
                </option>
              ))}
            </select>
          </label>
          <SmallButton disabled={busy} onClick={() => act('confirm', { providerId: provider })}>
            Confirm visit
          </SmallButton>
          <SmallButton variant="secondary" onClick={() => setMode(mode === 'propose' ? 'idle' : 'propose')}>
            Propose alternate
          </SmallButton>
          <SmallButton variant="ghost" onClick={() => setMode(mode === 'decline' ? 'idle' : 'decline')}>
            Decline
          </SmallButton>
        </div>
      )}
      {!pending && role === 'ADMIN' && (
        <div className="border-line mt-3 border-t pt-3">
          <SmallButton
            variant="ghost"
            disabled={busy}
            onClick={() => confirm('Cancel this offer?') && act('cancel', { reason: 'Offer withdrawn by the clinic.' })}
          >
            Withdraw offer
          </SmallButton>
        </div>
      )}
      {mode === 'decline' && (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            className={inp}
            rows={2}
            placeholder="Reason (sent to the family)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Decline reason"
          />
          <SmallButton
            variant="danger"
            className="self-start"
            disabled={busy || !reason.trim()}
            onClick={() => act('decline', { reason })}
          >
            Decline request
          </SmallButton>
        </div>
      )}
      {mode === 'propose' && (
        <div className="mt-3 flex flex-col gap-2">
          <AdminSlotPicker
            url={`/api/admin/appointments/${item.id}/alternates?from=${today}&to=${addDaysStr(today, 28)}`}
            value={alt}
            onChange={setAlt}
          />
          <SmallButton className="self-start" disabled={busy || !alt} onClick={() => act('propose', { startsAt: alt })}>
            Send this time to the family
          </SmallButton>
        </div>
      )}
      <div className="mt-2">
        <ErrorNote error={error} />
      </div>
    </article>
  );
}
