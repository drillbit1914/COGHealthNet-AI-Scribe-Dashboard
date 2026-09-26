'use client';

import { useState } from 'react';
import { ErrorNote, inp, post, SmallButton, useAction } from './ui';

/** Record cash / bank transfer (+ reference) / waived (PRD §9). */
export function PaymentForm({
  id,
  onDone,
  defaultStatus = 'PAID_CASH',
  defaultReference = '',
}: {
  id: string;
  onDone: () => void;
  defaultStatus?: string;
  defaultReference?: string;
}) {
  const [status, setStatus] = useState(defaultStatus);
  const [reference, setReference] = useState(defaultReference);
  const { busy, error, run } = useAction();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select className={inp} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Payment method">
        <option value="PAID_CASH">Cash</option>
        <option value="PAID_BANK_TRANSFER">Bank transfer</option>
        <option value="WAIVED">Waived</option>
        <option value="UNPAID">Unpaid</option>
      </select>
      {status === 'PAID_BANK_TRANSFER' && (
        <input
          className={`${inp} w-28`}
          placeholder="Reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          aria-label="Transfer reference"
        />
      )}
      <SmallButton
        disabled={busy}
        onClick={() =>
          run(
            () => post(`/api/admin/appointments/${id}/payment`, { status, reference: reference || undefined }),
            onDone,
          )
        }
      >
        Save
      </SmallButton>
      <ErrorNote error={error} />
    </div>
  );
}
