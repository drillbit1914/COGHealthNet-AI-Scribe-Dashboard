'use client';

import { useState } from 'react';
import { PatientPicker, type PatientHit } from '@/components/admin/patient-search';
import {
  ErrorNote,
  Field,
  inp,
  PageHeader,
  Panel,
  post,
  SmallButton,
  useAction,
  useData,
  useStaff,
} from '@/components/admin/ui';
import { clinicToIso, dayOf, fmtWhen } from '@/lib/clinic-time';

/** Recurring standing appointments, created CONFIRMED; conflicts listed before saving (PRD §9). */
export default function SeriesPage() {
  const { tz } = useStaff();
  const providers =
    useData<{ id: string; name: string; discipline: string; active: boolean }[]>('/api/admin/providers');
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [f, setF] = useState({
    providerId: '',
    visitType: 'FOLLOW_UP',
    date: dayOf(new Date(), tz),
    time: '09:00',
    rule: 'WEEKLY',
    count: 8,
    skipConflicts: false,
  });
  const [preview, setPreview] = useState<{ startsAt: string; conflict: boolean }[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const body = () => ({
    patientId: patient?.id,
    providerId: f.providerId,
    visitType: f.visitType,
    firstStartsAt: clinicToIso(f.date, f.time, tz),
    rule: f.rule,
    count: f.count,
    skipConflicts: f.skipConflicts,
  });
  const conflicts = preview?.filter((p) => p.conflict).length ?? 0;
  const set = (patch: Partial<typeof f>) => (setF({ ...f, ...patch }), setPreview(null), setDone(null));

  return (
    <div>
      <PageHeader title="Recurring series" />
      <Panel>
        <div className="grid max-w-3xl gap-3 md:grid-cols-2">
          <Field label="Child">
            <PatientPicker value={patient} onChange={(p) => (setPatient(p), setPreview(null))} />
          </Field>
          <Field label="Provider">
            <select className={inp} value={f.providerId} onChange={(e) => set({ providerId: e.target.value })}>
              <option value="">Choose…</option>
              {providers.data
                ?.filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.discipline}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Visit type">
            <select className={inp} value={f.visitType} onChange={(e) => set({ visitType: e.target.value })}>
              <option value="FOLLOW_UP">Follow-up (1 hour)</option>
              <option value="EVALUATION">Evaluation (1.5 hours)</option>
            </select>
          </Field>
          <Field label="First visit (AST)">
            <div className="flex gap-1">
              <input type="date" className={inp} value={f.date} onChange={(e) => set({ date: e.target.value })} />
              <input
                type="time"
                step={1800}
                className={inp}
                value={f.time}
                onChange={(e) => set({ time: e.target.value })}
              />
            </div>
          </Field>
          <Field label="Repeat">
            <select className={inp} value={f.rule} onChange={(e) => set({ rule: e.target.value })}>
              <option value="WEEKLY">Weekly</option>
              <option value="BIWEEKLY">Every 2 weeks</option>
            </select>
          </Field>
          <Field label="Number of sessions">
            <input
              type="number"
              min={1}
              max={52}
              className={inp}
              value={f.count}
              onChange={(e) => set({ count: Number(e.target.value) })}
            />
          </Field>
        </div>
        <SmallButton
          className="mt-3"
          variant="secondary"
          disabled={busy || !patient || !f.providerId}
          onClick={() => run(async () => setPreview((await post('/api/admin/series/preview', body())) as never))}
        >
          Check for conflicts
        </SmallButton>
        {preview && (
          <div className="mt-3">
            <ul className="text-sm">
              {preview.map((p) => (
                <li key={p.startsAt} className={p.conflict ? 'text-laterite font-bold' : ''}>
                  {fmtWhen(p.startsAt, tz)}{' '}
                  {p.conflict ? '— conflict (provider busy, off, or clinic closed)' : '— free'}
                </li>
              ))}
            </ul>
            {conflicts > 0 && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={f.skipConflicts}
                  onChange={(e) => setF({ ...f, skipConflicts: e.target.checked })}
                />{' '}
                Skip the {conflicts} conflicting date(s)
              </label>
            )}
            <SmallButton
              className="mt-2"
              disabled={busy || (conflicts > 0 && !f.skipConflicts)}
              onClick={() =>
                run(async () => {
                  const r = (await post('/api/admin/series', body())) as { appointmentIds: string[] };
                  setDone(
                    `Created ${r.appointmentIds.length} confirmed visit(s). The family was sent a confirmation for the first one.`,
                  );
                  setPreview(null);
                })
              }
            >
              Create series
            </SmallButton>
          </div>
        )}
        {done && <p className="text-acacia mt-2 font-bold">{done}</p>}
        <ErrorNote error={error} />
      </Panel>
    </div>
  );
}
