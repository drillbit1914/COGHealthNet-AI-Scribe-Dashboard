'use client';

import { useState } from 'react';
import { PatientPicker, type PatientHit } from '@/components/admin/patient-search';
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
import { addDaysStr, dayOf, fmtWhen } from '@/lib/clinic-time';

interface Entry {
  id: string;
  visit_type: 'FOLLOW_UP' | 'EVALUATION';
  date_from: string;
  date_to: string;
  window: string;
  created_at: string;
  child: string;
  guardian: string | null;
  phone_e164: string;
}

export default function WaitlistPage() {
  const { tz } = useStaff();
  const list = useData<Entry[]>('/api/admin/waitlist');
  const today = dayOf(new Date(), tz);
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const profile = useData<{
    guardians: { id: string; name: string | null; phone_e164: string; can_book: boolean; restricted: boolean }[];
  }>(patient ? `/api/admin/patients/${patient.id}` : null);
  const [f, setF] = useState({
    guardianId: '',
    visitType: 'FOLLOW_UP',
    dateFrom: today,
    dateTo: addDaysStr(today, 14),
    window: 'ANY',
  });
  const { busy, error, run } = useAction();
  const bookers = profile.data?.guardians.filter((g) => g.can_book && !g.restricted) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Waitlist" />
      <Panel title="Add to the waitlist">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Child">
            <PatientPicker value={patient} onChange={(p) => (setPatient(p), setF({ ...f, guardianId: '' }))} />
          </Field>
          <Field label="Guardian to offer times to">
            <select className={inp} value={f.guardianId} onChange={(e) => setF({ ...f, guardianId: e.target.value })}>
              <option value="">Choose…</option>
              {bookers.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name ?? g.phone_e164}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Visit type">
            <select className={inp} value={f.visitType} onChange={(e) => setF({ ...f, visitType: e.target.value })}>
              <option value="FOLLOW_UP">Follow-up</option>
              <option value="EVALUATION">Evaluation</option>
            </select>
          </Field>
          <Field label="From">
            <input
              type="date"
              className={inp}
              value={f.dateFrom}
              onChange={(e) => setF({ ...f, dateFrom: e.target.value })}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={inp}
              value={f.dateTo}
              onChange={(e) => setF({ ...f, dateTo: e.target.value })}
            />
          </Field>
          <Field label="Time of day">
            <select className={inp} value={f.window} onChange={(e) => setF({ ...f, window: e.target.value })}>
              <option value="ANY">Any</option>
              <option value="MORNING">Morning</option>
              <option value="AFTERNOON">Afternoon</option>
            </select>
          </Field>
          <SmallButton
            disabled={busy || !patient || !f.guardianId}
            onClick={() => run(() => post('/api/admin/waitlist', { patientId: patient!.id, ...f }), list.reload)}
          >
            Add
          </SmallButton>
        </div>
        <ErrorNote error={error} />
      </Panel>
      <Panel title="Waiting">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Child</th>
              <th className={th}>Guardian</th>
              <th className={th}>Visit</th>
              <th className={th}>Dates</th>
              <th className={th}>Time of day</th>
              <th className={th}>Added</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {list.data?.map((e) => (
              <tr key={e.id}>
                <td className={td}>{e.child}</td>
                <td className={td}>
                  {e.guardian} {e.phone_e164}
                </td>
                <td className={td}>{t(`visitTypeTitle.${e.visit_type}`)}</td>
                <td className={td}>
                  {e.date_from} → {e.date_to}
                </td>
                <td className={td}>{e.window.toLowerCase()}</td>
                <td className={td}>{fmtWhen(e.created_at, tz)}</td>
                <td className={td}>
                  <SmallButton
                    variant="ghost"
                    disabled={busy}
                    onClick={() => run(() => post(`/api/admin/waitlist/${e.id}`, undefined, 'DELETE'), list.reload)}
                  >
                    Remove
                  </SmallButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.data?.length && <Empty>Nobody is waiting.</Empty>}
      </Panel>
    </div>
  );
}
