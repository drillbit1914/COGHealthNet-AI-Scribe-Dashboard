'use client';

import { useEffect, useState } from 'react';
import {
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
} from '@/components/admin/ui';

type Kind = 'text' | 'number' | 'boolean' | 'phones' | 'durations' | 'textarea';
interface SettingsResp {
  values: Record<string, unknown>;
  fields: { key: string; label: string; kind: Kind; help?: string }[];
}
interface Provider {
  id: string;
  name: string;
  discipline: 'OT' | 'PT';
  color: string;
  phone_e164: string | null;
  display_order: number;
  active: boolean;
}
interface Rule {
  provider_id: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Settings" />
      <ClinicSettings />
      <Providers />
      <Hours />
      <StaffLogins />
      <Panel title="Privacy">
        <SmallButton
          variant="secondary"
          onClick={async () => {
            const rows = (await (await fetch('/api/admin/breach-export')).json()) as Record<string, unknown>[];
            const cols = Object.keys(rows[0] ?? { patient_id: '' });
            const csv = [
              cols.join(','),
              ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(',')),
            ].join('\n');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
            a.download = 'breach-response-export.csv';
            a.click();
          }}
        >
          Download breach-response export (CSV)
        </SmallButton>
      </Panel>
    </div>
  );
}

function ClinicSettings() {
  const { data, error, reload } = useData<SettingsResp>('/api/admin/settings');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);
  const { busy, error: saveErr, run } = useAction();
  useEffect(() => {
    if (data) setDraft(data.values);
  }, [data]);
  if (!data) return <ErrorNote error={error} />;
  const set = (k: string, v: unknown) => (setDraft({ ...draft, [k]: v }), setSaved(false));
  const changed = Object.fromEntries(
    data.fields
      .map((f) => f.key)
      .filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(data.values[k]))
      .map((k) => [k, draft[k]]),
  );

  return (
    <Panel
      title="Clinic settings"
      actions={
        <SmallButton
          disabled={busy || !Object.keys(changed).length}
          onClick={() =>
            run(
              () => post('/api/admin/settings', changed, 'PATCH'),
              async () => {
                await reload();
                setSaved(true);
              },
            )
          }
        >
          Save changes
        </SmallButton>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        {data.fields.map((f) => (
          <Field key={f.key} label={f.label}>
            {f.kind === 'boolean' ? (
              <input
                type="checkbox"
                className="size-5"
                checked={!!draft[f.key]}
                onChange={(e) => set(f.key, e.target.checked)}
                aria-label={f.label}
              />
            ) : f.kind === 'number' ? (
              <input
                type="number"
                className={inp}
                value={String(draft[f.key] ?? '')}
                onChange={(e) => set(f.key, Number(e.target.value))}
                aria-label={f.label}
              />
            ) : f.kind === 'phones' ? (
              <textarea
                className={inp}
                rows={2}
                value={((draft[f.key] as string[]) ?? []).join('\n')}
                onChange={(e) => set(f.key, e.target.value.split(/\s+/).filter(Boolean))}
                aria-label={f.label}
              />
            ) : f.kind === 'durations' ? (
              <div className="flex gap-2">
                {(['FOLLOW_UP', 'EVALUATION'] as const).map((vt) => (
                  <label key={vt} className="flex items-center gap-1 text-xs">
                    {vt === 'FOLLOW_UP' ? 'Follow-up' : 'Evaluation'}
                    <input
                      type="number"
                      className={`${inp} w-20`}
                      value={(draft[f.key] as Record<string, number>)?.[vt] ?? ''}
                      onChange={(e) => set(f.key, { ...(draft[f.key] as object), [vt]: Number(e.target.value) })}
                    />
                  </label>
                ))}
              </div>
            ) : f.kind === 'textarea' ? (
              <textarea
                className={inp}
                rows={2}
                value={String(draft[f.key] ?? '')}
                onChange={(e) => set(f.key, e.target.value)}
                aria-label={f.label}
              />
            ) : (
              <input
                className={inp}
                value={String(draft[f.key] ?? '')}
                onChange={(e) => set(f.key, e.target.value)}
                aria-label={f.label}
              />
            )}
            {f.help && <span className="text-muted text-xs font-normal">{f.help}</span>}
          </Field>
        ))}
      </div>
      <ErrorNote error={saveErr} />
      {saved && <p className="text-acacia mt-2 text-sm font-bold">Saved.</p>}
    </Panel>
  );
}

function Providers() {
  const { data, reload } = useData<Provider[]>('/api/admin/providers');
  const { busy, error, run } = useAction();
  const [rows, setRows] = useState<Provider[]>([]);
  useEffect(() => {
    if (data) setRows(data);
  }, [data]);
  const save = (p: Provider) =>
    run(
      () =>
        post('/api/admin/providers', {
          id: p.id || undefined,
          name: p.name,
          discipline: p.discipline,
          color: p.color,
          phone: p.phone_e164 || null,
          displayOrder: p.display_order,
          active: p.active,
        }),
      reload,
    );
  const upd = (i: number, patch: Partial<Provider>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Panel
      title="Providers"
      actions={
        <SmallButton
          variant="secondary"
          onClick={() =>
            setRows([
              ...rows,
              {
                id: '',
                name: '',
                discipline: 'OT',
                color: '#5B3F8C',
                phone_e164: '',
                display_order: rows.length,
                active: true,
              },
            ])
          }
        >
          Add provider
        </SmallButton>
      }
    >
      <table className="w-full">
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Discipline</th>
            <th className={th}>Colour</th>
            <th className={th}>WhatsApp number</th>
            <th className={th}>Order</th>
            <th className={th}>Active</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.id || `new-${i}`}>
              <td className={td}>
                <input
                  className={inp}
                  value={p.name}
                  onChange={(e) => upd(i, { name: e.target.value })}
                  aria-label="Provider name"
                />
              </td>
              <td className={td}>
                <select
                  className={inp}
                  value={p.discipline}
                  onChange={(e) => upd(i, { discipline: e.target.value as 'OT' | 'PT' })}
                >
                  <option>OT</option>
                  <option>PT</option>
                </select>
              </td>
              <td className={td}>
                <input
                  type="color"
                  value={p.color}
                  onChange={(e) => upd(i, { color: e.target.value })}
                  aria-label="Colour"
                />
              </td>
              <td className={td}>
                <input
                  className={inp}
                  value={p.phone_e164 ?? ''}
                  onChange={(e) => upd(i, { phone_e164: e.target.value })}
                  aria-label="Phone"
                />
              </td>
              <td className={td}>
                <input
                  type="number"
                  className={`${inp} w-16`}
                  value={p.display_order}
                  onChange={(e) => upd(i, { display_order: Number(e.target.value) })}
                  aria-label="Order"
                />
              </td>
              <td className={td}>
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={(e) => upd(i, { active: e.target.checked })}
                  aria-label="Active"
                />
              </td>
              <td className={td}>
                <SmallButton disabled={busy || !p.name.trim()} onClick={() => save(p)}>
                  Save
                </SmallButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorNote error={error} />
    </Panel>
  );
}

/** Clinic-wide hours plus optional per-provider overrides (PRD §2). */
function Hours() {
  const rules = useData<Rule[]>('/api/admin/rules');
  const providers = useData<Provider[]>('/api/admin/providers');
  const [who, setWho] = useState<string>('');
  const [week, setWeek] = useState<{ open: boolean; start: string; end: string }[]>([]);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!rules.data) return;
    const mine = rules.data.filter((r) => (r.provider_id ?? '') === who);
    setWeek(
      DAYS.map((_, wd) => {
        const r = mine.find((x) => x.weekday === wd);
        return r
          ? { open: true, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) }
          : { open: false, start: '08:00', end: '17:00' };
      }),
    );
    setSaved(false);
  }, [rules.data, who]);
  return (
    <Panel
      title="Opening hours"
      actions={
        <select className={inp} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Hours for">
          <option value="">Clinic-wide default</option>
          {providers.data?.map((p) => (
            <option key={p.id} value={p.id}>
              Override for {p.name}
            </option>
          ))}
        </select>
      }
    >
      {who && (
        <p className="text-muted mb-2 text-sm">
          Days left closed here fall back to the clinic-wide hours. Use time off to block a provider on an open day.
        </p>
      )}
      <div className="flex flex-col gap-1">
        {week.map((d, wd) => (
          <div key={wd} className="flex items-center gap-2 text-sm">
            <label className="flex w-32 items-center gap-2">
              <input
                type="checkbox"
                checked={d.open}
                onChange={(e) => setWeek(week.map((x, j) => (j === wd ? { ...x, open: e.target.checked } : x)))}
              />
              {DAYS[wd]}
            </label>
            <input
              type="time"
              step={1800}
              disabled={!d.open}
              className={inp}
              value={d.start}
              onChange={(e) => setWeek(week.map((x, j) => (j === wd ? { ...x, start: e.target.value } : x)))}
              aria-label={`${DAYS[wd]} opens`}
            />
            –
            <input
              type="time"
              step={1800}
              disabled={!d.open}
              className={inp}
              value={d.end}
              onChange={(e) => setWeek(week.map((x, j) => (j === wd ? { ...x, end: e.target.value } : x)))}
              aria-label={`${DAYS[wd]} closes`}
            />
          </div>
        ))}
      </div>
      <SmallButton
        className="mt-3"
        disabled={busy}
        onClick={() =>
          run(
            () =>
              post(
                '/api/admin/rules',
                {
                  providerId: who || null,
                  rules: week.flatMap((d, wd) => (d.open ? [{ weekday: wd, start: d.start, end: d.end }] : [])),
                },
                'PUT',
              ),
            async () => {
              await rules.reload();
              setSaved(true);
            },
          )
        }
      >
        Save hours
      </SmallButton>
      {saved && <span className="text-acacia ml-2 text-sm font-bold">Saved.</span>}
      <ErrorNote error={error} />
    </Panel>
  );
}

function StaffLogins() {
  const staff =
    useData<{ id: string; email: string; role: string; active: boolean; provider: string | null; has_totp: boolean }[]>(
      '/api/admin/staff',
    );
  const providers = useData<Provider[]>('/api/admin/providers');
  const [f, setF] = useState({ email: '', role: 'PROVIDER', providerId: '' });
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string; totpUri: string } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Panel title="Staff logins">
      <table className="w-full">
        <thead>
          <tr>
            <th className={th}>Email</th>
            <th className={th}>Role</th>
            <th className={th}>Provider</th>
            <th className={th}>2FA</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {staff.data?.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'text-muted'}>
              <td className={td}>{s.email}</td>
              <td className={td}>{s.role.toLowerCase()}</td>
              <td className={td}>{s.provider}</td>
              <td className={td}>{s.has_totp ? 'On' : 'Off'}</td>
              <td className={td}>
                <SmallButton
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    run(() => post(`/api/admin/staff/${s.id}/active`, { active: !s.active }), staff.reload)
                  }
                >
                  {s.active ? 'Deactivate' : 'Reactivate'}
                </SmallButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-line mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
        <Field label="Email">
          <input className={inp} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Role">
          <select className={inp} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="PROVIDER">Provider</option>
            <option value="ADMIN">Administrator</option>
          </select>
        </Field>
        {f.role === 'PROVIDER' && (
          <Field label="Provider">
            <select className={inp} value={f.providerId} onChange={(e) => setF({ ...f, providerId: e.target.value })}>
              <option value="">Choose…</option>
              {providers.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <SmallButton
          disabled={busy || !f.email}
          onClick={() =>
            run(async () => {
              setCreated((await post('/api/admin/staff', { ...f, providerId: f.providerId || null })) as never);
              setF({ email: '', role: 'PROVIDER', providerId: '' });
            }, staff.reload)
          }
        >
          Create login
        </SmallButton>
      </div>
      {created && (
        <div className="border-sunbird mt-3 rounded-md border-l-4 bg-[#fdf5e6] p-3 text-sm">
          <p className="font-bold">Give these to {created.email} privately. They are shown once.</p>
          <p>
            Temporary password: <code className="font-mono">{created.temporaryPassword}</code>
          </p>
          <p className="break-all">
            Authenticator setup: <code className="font-mono">{created.totpUri}</code>
          </p>
        </div>
      )}
      <ErrorNote error={error} />
    </Panel>
  );
}
