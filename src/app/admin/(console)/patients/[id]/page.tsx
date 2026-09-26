'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PaymentForm } from '@/components/admin/payment-form';
import { PatientPicker, type PatientHit } from '@/components/admin/patient-search';
import {
  ErrorNote,
  Field,
  inp,
  PageHeader,
  Panel,
  Pill,
  post,
  SmallButton,
  td,
  th,
  useAction,
  useData,
  useStaff,
} from '@/components/admin/ui';
import { t } from '@/i18n';
import { fmtWhen } from '@/lib/clinic-time';

interface Guardian {
  id: string;
  name: string | null;
  phone_e164: string;
  whatsapp_opt_in_at: string | null;
  sms_opt_out_at: string | null;
  relationship: string | null;
  can_book: boolean;
  receives_notifications: boolean;
  restricted: boolean;
  notes: string | null;
}
interface Visit {
  id: string;
  ref: string;
  visit_type: 'FOLLOW_UP' | 'EVALUATION';
  starts_at: string;
  status: string;
  payment_status: string;
  payment_reference: string | null;
  late_cancel: boolean;
  provider: string;
  decline_reason: string | null;
  cancel_reason: string | null;
}
interface Profile {
  patient: {
    id: string;
    full_name: string;
    dob: string | null;
    needs_admin_match: boolean;
    merged_into_id: string | null;
  };
  guardians: Guardian[];
  visits: Visit[];
  intakes: {
    appointment_id: string;
    ref: string;
    starts_at: string;
    reason_text: string;
    reason_tags: string[];
    payer_type: string;
    insurer: string | null;
    member_no: string | null;
    has_referral: boolean;
    referral_url: string | null;
  }[];
  consents: { type: string; version: string; granted_at: string; withdrawn_at: string | null; guardian: string }[];
  noShows: number;
  lateCancels: number;
}

export default function PatientProfile() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { tz } = useStaff();
  const { data, error, reload } = useData<Profile>(`/api/admin/patients/${id}`);
  const { busy, error: actErr, run } = useAction();
  const [edit, setEdit] = useState<{ fullName: string; dob: string } | null>(null);
  const [merge, setMerge] = useState<PatientHit | null>(null);
  const [ng, setNg] = useState({ name: '', phone: '', relationship: '', canBook: false, receivesNotifications: true });
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const p = data.patient;
  const link = (guardianId: string, patch: Record<string, unknown>) =>
    run(() => post('/api/admin/guardian-links', { patientId: id, guardianId, ...patch }), reload);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={p.full_name}>
        {p.needs_admin_match && <Pill value="MATCH" label="typed name — needs match" />}
        <span className="text-sm">
          No-shows <b className={data.noShows ? 'text-laterite' : ''}>{data.noShows}</b> · Late cancels{' '}
          <b>{data.lateCancels}</b>
        </span>
      </PageHeader>
      <ErrorNote error={actErr} />

      <Panel
        title="Child"
        actions={
          !edit && (
            <SmallButton
              variant="secondary"
              onClick={() => setEdit({ fullName: p.full_name, dob: p.dob?.slice(0, 10) ?? '' })}
            >
              Edit
            </SmallButton>
          )
        }
      >
        {edit ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Full name">
              <input
                className={inp}
                value={edit.fullName}
                onChange={(e) => setEdit({ ...edit, fullName: e.target.value })}
              />
            </Field>
            <Field label="Date of birth">
              <input
                type="date"
                className={inp}
                value={edit.dob}
                onChange={(e) => setEdit({ ...edit, dob: e.target.value })}
              />
            </Field>
            <SmallButton
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    post(
                      `/api/admin/patients/${id}`,
                      { fullName: edit.fullName, dob: edit.dob || null, needsAdminMatch: false },
                      'PATCH',
                    ),
                  () => {
                    setEdit(null);
                    reload();
                  },
                )
              }
            >
              Save
            </SmallButton>
          </div>
        ) : (
          <p>
            Date of birth: <b>{p.dob?.slice(0, 10) ?? '—'}</b>
          </p>
        )}
      </Panel>

      <Panel title="Guardians">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Phone</th>
              <th className={th}>Channel</th>
              <th className={th}>Can book</th>
              <th className={th}>Gets updates</th>
              <th className={th}>Restricted</th>
              <th className={th}>Merge duplicate into…</th>
            </tr>
          </thead>
          <tbody>
            {data.guardians.map((g) => (
              <tr key={g.id} className={g.restricted ? 'bg-[#fbeeeb]' : ''}>
                <td className={td}>
                  <b>{g.name ?? '—'}</b> <span className="text-muted">{g.relationship}</span>
                </td>
                <td className={td}>{g.phone_e164}</td>
                <td className={td}>{g.whatsapp_opt_in_at ? 'WhatsApp' : g.sms_opt_out_at ? 'SMS opted out' : 'SMS'}</td>
                <td className={td}>
                  <input
                    type="checkbox"
                    aria-label={`Can book: ${g.name}`}
                    checked={g.can_book}
                    disabled={busy}
                    onChange={(e) => link(g.id, { canBook: e.target.checked })}
                  />
                </td>
                <td className={td}>
                  <input
                    type="checkbox"
                    aria-label={`Gets updates: ${g.name}`}
                    checked={g.receives_notifications}
                    disabled={busy}
                    onChange={(e) => link(g.id, { receivesNotifications: e.target.checked })}
                  />
                </td>
                <td className={td}>
                  <input
                    type="checkbox"
                    aria-label={`Restricted: ${g.name}`}
                    checked={g.restricted}
                    disabled={busy}
                    onChange={(e) =>
                      (!e.target.checked ||
                        confirm(
                          'Restrict this guardian? They will get no messages and cannot see or book for this child. This is never shown to them.',
                        )) &&
                      link(g.id, { restricted: e.target.checked })
                    }
                  />
                </td>
                <td className={td}>
                  <select
                    className={inp}
                    value=""
                    aria-label={`Merge ${g.name}`}
                    onChange={(e) =>
                      e.target.value &&
                      confirm(
                        'Merge this guardian record into the selected one? Links, consents and history move over.',
                      ) &&
                      run(() => post('/api/admin/merge/guardians', { fromId: g.id, intoId: e.target.value }), reload)
                    }
                  >
                    <option value="">—</option>
                    {data.guardians
                      .filter((o) => o.id !== g.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name ?? o.phone_e164}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-line mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
          <Field label="Name">
            <input className={inp} value={ng.name} onChange={(e) => setNg({ ...ng, name: e.target.value })} />
          </Field>
          <Field label="Mobile">
            <input className={inp} value={ng.phone} onChange={(e) => setNg({ ...ng, phone: e.target.value })} />
          </Field>
          <Field label="Relationship">
            <input
              className={inp}
              value={ng.relationship}
              onChange={(e) => setNg({ ...ng, relationship: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={ng.canBook} onChange={(e) => setNg({ ...ng, canBook: e.target.checked })} />{' '}
            Can book
          </label>
          <SmallButton
            disabled={busy || !ng.phone}
            onClick={() =>
              run(
                () =>
                  post('/api/admin/guardian-links', { patientId: id, ...ng, relationship: ng.relationship || null }),
                () => {
                  setNg({ name: '', phone: '', relationship: '', canBook: false, receivesNotifications: true });
                  reload();
                },
              )
            }
          >
            Add guardian
          </SmallButton>
        </div>
      </Panel>

      <Panel title="Visits">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>When</th>
              <th className={th}>Visit</th>
              <th className={th}>Provider</th>
              <th className={th}>Status</th>
              <th className={th}>Payment</th>
              <th className={th}>Record payment</th>
            </tr>
          </thead>
          <tbody>
            {data.visits.map((v) => (
              <tr key={v.id}>
                <td className={td}>{fmtWhen(v.starts_at, tz)}</td>
                <td className={td}>
                  {t(`visitTypeTitle.${v.visit_type}`)} · {v.ref}
                </td>
                <td className={td}>{v.provider}</td>
                <td className={td}>
                  <Pill value={v.status} /> {v.late_cancel && <Pill value="LATE" label="late cancel" />}
                  {(v.decline_reason || v.cancel_reason) && (
                    <p className="text-muted text-xs">{v.decline_reason ?? v.cancel_reason}</p>
                  )}
                </td>
                <td className={td}>
                  <Pill value={v.payment_status} /> <span className="text-xs">{v.payment_reference}</span>
                </td>
                <td className={td}>
                  <PaymentForm id={v.id} onDone={reload} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {data.intakes.length > 0 && (
        <Panel title="Evaluation intake">
          {data.intakes.map((e) => (
            <div key={e.appointment_id} className="mb-2 text-sm">
              <p className="font-bold">
                {e.ref} · {fmtWhen(e.starts_at, tz)}
              </p>
              <p>{e.reason_text}</p>
              <p className="text-muted">{e.reason_tags.join(', ').replaceAll('_', ' ')}</p>
              <p>
                {e.payer_type === 'INSURANCE' ? `Insurance: ${e.insurer} · ${e.member_no}` : 'Self-pay'}
                {e.referral_url && (
                  <>
                    {' '}
                    ·{' '}
                    <a className="text-jacaranda underline" href={e.referral_url} target="_blank" rel="noreferrer">
                      View referral letter
                    </a>{' '}
                    <span className="text-muted">(link valid 15 minutes)</span>
                  </>
                )}
              </p>
            </div>
          ))}
        </Panel>
      )}

      <Panel title="Consents">
        <ul className="text-sm">
          {data.consents.map((c, i) => (
            <li key={i}>
              {c.type.replace('_', ' ').toLowerCase()} v{c.version} by {c.guardian} on {fmtWhen(c.granted_at, tz)}
              {c.withdrawn_at && <b className="text-laterite"> — withdrawn {fmtWhen(c.withdrawn_at, tz)}</b>}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Merge a duplicate child record into this one">
        <div className="flex flex-wrap items-end gap-2">
          <PatientPicker value={merge} onChange={setMerge} exclude={id} />
          <SmallButton
            variant="secondary"
            disabled={!merge || busy}
            onClick={() =>
              merge &&
              confirm(`Merge "${merge.full_name}" into "${p.full_name}"? Visits, guardians and consents move here.`) &&
              run(
                () => post('/api/admin/merge/patients', { fromId: merge.id, intoId: id }),
                () => {
                  setMerge(null);
                  reload();
                },
              )
            }
          >
            Merge into {p.full_name}
          </SmallButton>
        </div>
      </Panel>

      <Panel title="Privacy">
        <div className="flex flex-wrap gap-2">
          <SmallButton
            variant="secondary"
            onClick={async () => {
              const res = await fetch(`/api/admin/patients/${id}/export`);
              const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `patient-${id}.json`;
              a.click();
            }}
          >
            Export record (access request)
          </SmallButton>
          <SmallButton
            variant="danger"
            disabled={busy}
            onClick={() =>
              prompt('Type ERASE to permanently remove this child’s personal and health data.') === 'ERASE' &&
              run(
                () => post(`/api/admin/patients/${id}/erase`),
                () => router.push('/admin/patients'),
              )
            }
          >
            Erase record
          </SmallButton>
        </div>
      </Panel>
    </div>
  );
}
