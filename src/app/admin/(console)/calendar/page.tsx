'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ErrorNote, PageHeader, Pill, post, SmallButton, useAction, useData, useStaff } from '@/components/admin/ui';
import { t } from '@/i18n';
import { addDaysStr, clinicToIso, dayOf, fmtIn, fmtTimeOnly, weekdayOfStr } from '@/lib/clinic-time';
import { cn } from '@/lib/utils';

interface Provider {
  id: string;
  name: string;
  discipline: string;
  color: string;
}
interface Appt {
  id: string;
  ref: string;
  provider_id: string;
  visit_type: 'FOLLOW_UP' | 'EVALUATION';
  starts_at: string;
  ends_at: string;
  status: string;
  payment_status: string;
  child: string;
  patient_id: string;
}
interface TimeOff {
  id: string;
  provider_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  is_closure: boolean;
}
interface Rule {
  provider_id: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
}
interface Cal {
  providers: Provider[];
  appointments: Appt[];
  timeOff: TimeOff[];
  rules: Rule[];
}

const ROW_PX = 28; // one 30-minute row
const PENDING = ['REQUESTED', 'ALTERNATE_PROPOSED'];
const toMin = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** Pending = striped, confirmed/completed = solid provider colour, no-show = red outline (CLAUDE.md). */
function blockStyle(a: Appt, color: string): React.CSSProperties {
  if (PENDING.includes(a.status))
    return {
      background: `repeating-linear-gradient(45deg, ${color}22 0 8px, ${color}55 8px 16px)`,
      border: `2px dashed ${color}`,
      color: '#1F2230',
    };
  if (a.status === 'NO_SHOW') return { background: '#fff', border: '2px solid #B5412F', color: '#B5412F' };
  return { background: color, color: '#fff', border: `2px solid ${color}` };
}

export default function CalendarPage() {
  const { tz } = useStaff();
  const [view, setView] = useState<'day' | 'week'>('day');
  const [date, setDate] = useState(() => dayOf(new Date(), tz));
  const from = view === 'day' ? date : addDaysStr(date, -weekdayOfStr(date));
  const to = view === 'day' ? date : addDaysStr(from, 6);
  const { data, error, reload } = useData<Cal>(`/api/admin/calendar?from=${from}&to=${to}`);
  const [selected, setSelected] = useState<Appt | null>(null);

  return (
    <div>
      <PageHeader title="Calendar">
        <SmallButton
          variant="secondary"
          onClick={() => setDate(addDaysStr(date, view === 'day' ? -1 : -7))}
          aria-label="Previous"
        >
          ←
        </SmallButton>
        <SmallButton variant="secondary" onClick={() => setDate(dayOf(new Date(), tz))}>
          Today
        </SmallButton>
        <SmallButton
          variant="secondary"
          onClick={() => setDate(addDaysStr(date, view === 'day' ? 1 : 7))}
          aria-label="Next"
        >
          →
        </SmallButton>
        <input
          type="date"
          className="border-line rounded-md border px-2 py-1 text-sm"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          aria-label="Date"
        />
        <div className="border-jacaranda flex overflow-hidden rounded-md border">
          {(['day', 'week'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn('px-3 py-1 text-sm font-bold', view === v ? 'bg-jacaranda text-white' : 'text-jacaranda')}
            >
              {v === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </div>
      </PageHeader>
      <p className="mb-3 text-lg font-bold">
        {view === 'day'
          ? fmtIn(`${date}T12:00:00Z`, 'UTC', 'EEEE d MMMM yyyy')
          : `Week of ${fmtIn(`${from}T12:00:00Z`, 'UTC', 'd MMMM yyyy')}`}
      </p>
      <ErrorNote error={error} />
      {data && view === 'day' && <DayView date={date} cal={data} onChanged={reload} onSelect={setSelected} />}
      {data && view === 'week' && (
        <WeekView
          from={from}
          cal={data}
          onPick={(d) => {
            setDate(d);
            setView('day');
          }}
        />
      )}
      {selected && (
        <Details
          a={selected}
          provider={data?.providers.find((p) => p.id === selected.provider_id)}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function DayView({
  date,
  cal,
  onChanged,
  onSelect,
}: {
  date: string;
  cal: Cal;
  onChanged: () => void;
  onSelect: (a: Appt) => void;
}) {
  const { tz, canApprove } = useStaff();
  const { busy, error, run } = useAction();
  const wd = weekdayOfStr(date);
  const hours = cal.rules.filter((r) => r.weekday === wd);
  const start = hours.length ? Math.min(...hours.map((r) => toMin(r.start_time))) : 8 * 60;
  const end = hours.length ? Math.max(...hours.map((r) => toMin(r.end_time))) : 18 * 60;
  const rows = Math.ceil((end - start) / 30);
  const dayStart = new Date(
    clinicToIso(date, `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`, tz),
  ).getTime();
  const top = (iso: string) => ((new Date(iso).getTime() - dayStart) / 60000 / 30) * ROW_PX;
  const height = (a: string, b: string) => ((new Date(b).getTime() - new Date(a).getTime()) / 60000 / 30) * ROW_PX;
  const [drag, setDrag] = useState<Appt | null>(null);

  /** Drop: same time + new provider → reassign; new time → reschedule (confirmed) or propose (pending). */
  async function drop(providerId: string, row: number) {
    const a = drag;
    setDrag(null);
    if (!a) return;
    const startsAt = new Date(dayStart + row * 30 * 60000).toISOString();
    const sameTime = startsAt === new Date(a.starts_at).toISOString();
    if (sameTime && providerId === a.provider_id) return;
    const who = cal.providers.find((p) => p.id === providerId)?.name;
    const when = fmtTimeOnly(startsAt, tz);
    if (PENDING.includes(a.status)) {
      if (sameTime) {
        if (confirm(`Assign ${a.child} to ${who}?`))
          await run(() => post(`/api/admin/appointments/${a.id}/reassign`, { providerId }), onChanged);
      } else if (
        a.status === 'REQUESTED' &&
        confirm(`Propose ${when} to ${a.child}'s family? The clinic will assign the provider.`)
      ) {
        await run(() => post(`/api/admin/appointments/${a.id}/propose`, { startsAt }), onChanged);
      }
      return;
    }
    if (a.status === 'CONFIRMED' && confirm(`Move ${a.child} to ${when} with ${who}? The family will be notified.`))
      await run(() => post(`/api/admin/appointments/${a.id}/reschedule`, { startsAt, providerId }), onChanged);
  }

  return (
    <div>
      <ErrorNote error={error} />
      <div className="border-line overflow-x-auto rounded-lg border bg-white">
        <div
          className="grid min-w-[720px]"
          style={{ gridTemplateColumns: `64px repeat(${cal.providers.length}, minmax(160px, 1fr))` }}
        >
          <div className="border-line border-b" />
          {cal.providers.map((p) => (
            <div
              key={p.id}
              className="border-line border-b border-l px-2 py-2 text-sm font-bold"
              style={{ borderTop: `4px solid ${p.color}` }}
            >
              {p.name} <span className="text-muted font-normal">· {p.discipline}</span>
            </div>
          ))}
          <div className="relative" style={{ height: rows * ROW_PX }}>
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="text-muted absolute right-1 text-[11px]" style={{ top: i * ROW_PX - 6 }}>
                {i % 2 === 0 ? fmtTimeOnly(new Date(dayStart + i * 30 * 60000), tz) : ''}
              </div>
            ))}
          </div>
          {cal.providers.map((p) => (
            <div
              key={p.id}
              className="border-line relative border-l"
              style={{ height: rows * ROW_PX }}
              data-testid={`col-${p.name}`}
            >
              {Array.from({ length: rows }, (_, i) => (
                <div
                  key={i}
                  className={cn(
                    'absolute inset-x-0 border-t',
                    i % 2 ? 'border-line/40' : 'border-line',
                    drag && 'hover:bg-jacaranda-light',
                  )}
                  style={{ top: i * ROW_PX, height: ROW_PX }}
                  onDragOver={(e) => drag && e.preventDefault()}
                  onDrop={() => drop(p.id, i)}
                />
              ))}
              {cal.timeOff
                .filter((x) => x.provider_id === null || x.provider_id === p.id)
                .map((x) => (
                  <div
                    key={x.id}
                    className="text-muted pointer-events-none absolute inset-x-0 overflow-hidden px-1 text-[11px]"
                    style={{
                      top: Math.max(0, top(x.starts_at)),
                      height: Math.min(rows * ROW_PX, top(x.ends_at)) - Math.max(0, top(x.starts_at)),
                      background: 'repeating-linear-gradient(-45deg, #eee 0 6px, #f7f7f7 6px 12px)',
                    }}
                  >
                    {x.is_closure ? 'Clinic closed' : 'Time off'} {x.reason ? `· ${x.reason}` : ''}
                  </div>
                ))}
              {cal.appointments
                .filter((a) => a.provider_id === p.id)
                .map((a) => (
                  <button
                    key={a.id}
                    draggable={!busy && (a.status === 'CONFIRMED' || (PENDING.includes(a.status) && canApprove))}
                    onDragStart={() => setDrag(a)}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => onSelect(a)}
                    data-testid="cal-appt"
                    className="absolute inset-x-1 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs"
                    style={{
                      top: top(a.starts_at) + 1,
                      height: height(a.starts_at, a.ends_at) - 2,
                      ...blockStyle(a, p.color),
                    }}
                  >
                    <b>{a.child}</b>
                    <br />
                    {fmtTimeOnly(a.starts_at, tz)} · {t(`visitTypeTitle.${a.visit_type}`)}
                    {PENDING.includes(a.status) && ' · pending'}
                  </button>
                ))}
            </div>
          ))}
        </div>
      </div>
      <p className="text-muted mt-2 text-xs">
        Drag a visit to another time or provider. Striped = pending, solid = confirmed.
      </p>
    </div>
  );
}

function WeekView({ from, cal, onPick }: { from: string; cal: Cal; onPick: (d: string) => void }) {
  const { tz } = useStaff();
  const days = Array.from({ length: 7 }, (_, i) => addDaysStr(from, i));
  const byId = useMemo(() => new Map(cal.providers.map((p) => [p.id, p])), [cal.providers]);
  return (
    <div className="grid grid-cols-7 gap-2">
      {days.map((d) => {
        const list = cal.appointments.filter((a) => dayOf(a.starts_at, tz) === d);
        const closed = cal.timeOff.some(
          (x) => x.is_closure && dayOf(x.starts_at, tz) <= d && dayOf(x.ends_at, tz) >= d,
        );
        return (
          <button
            key={d}
            onClick={() => onPick(d)}
            className="border-line hover:border-jacaranda min-h-40 rounded-lg border bg-white p-2 text-left align-top"
          >
            <p className="text-sm font-bold">{fmtIn(`${d}T12:00:00Z`, 'UTC', 'EEE d')}</p>
            {closed && <p className="text-laterite text-xs font-bold">Closed</p>}
            <div className="mt-1 flex flex-col gap-1">
              {list.map((a) => (
                <span
                  key={a.id}
                  className="rounded px-1 py-0.5 text-[11px]"
                  style={blockStyle(a, byId.get(a.provider_id)?.color ?? '#5B3F8C')}
                >
                  {fmtTimeOnly(a.starts_at, tz)} {a.child.split(' ')[0]}
                </span>
              ))}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Details({
  a,
  provider,
  onClose,
  onChanged,
}: {
  a: Appt;
  provider?: Provider;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { tz, role } = useStaff();
  const { busy, error, run } = useAction();
  const done = () => {
    onClose();
    onChanged();
  };
  const past = new Date(a.starts_at).getTime() <= Date.now();
  return (
    <aside className="border-line fixed top-0 right-0 z-10 flex h-dvh w-80 flex-col gap-3 border-l bg-white p-4 shadow-xl">
      <div className="flex items-start justify-between">
        <h2 className="text-lg font-bold">{a.child}</h2>
        <button onClick={onClose} aria-label="Close" className="text-xl">
          ×
        </button>
      </div>
      <p>
        {t(`visitTypeTitle.${a.visit_type}`)} · {a.ref}
      </p>
      <p className="font-bold">
        {fmtIn(a.starts_at, tz, 'EEE d MMM, h:mm a')} – {fmtTimeOnly(a.ends_at, tz)}
      </p>
      <p>{provider?.name}</p>
      <div className="flex gap-2">
        <Pill value={a.status} />
        <Pill value={a.payment_status} />
      </div>
      {role === 'ADMIN' && (
        <Link className="text-jacaranda text-sm font-bold underline" href={`/admin/patients/${a.patient_id}`}>
          Open patient
        </Link>
      )}
      {PENDING.includes(a.status) && (
        <Link className="text-jacaranda text-sm font-bold underline" href="/admin/queue">
          Review in the approval queue
        </Link>
      )}
      {a.status === 'CONFIRMED' && (
        <div className="border-line flex flex-col gap-2 border-t pt-3">
          {past && (
            <>
              <SmallButton
                disabled={busy}
                onClick={() =>
                  run(() => post(`/api/admin/appointments/${a.id}/attendance`, { outcome: 'COMPLETED' }), done)
                }
              >
                Mark attended
              </SmallButton>
              <SmallButton
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  run(() => post(`/api/admin/appointments/${a.id}/attendance`, { outcome: 'NO_SHOW' }), done)
                }
              >
                Mark no-show
              </SmallButton>
            </>
          )}
          {role === 'ADMIN' && (
            <SmallButton
              variant="ghost"
              disabled={busy}
              onClick={() => {
                const reason = prompt('Reason for cancelling (sent to the family):');
                if (reason !== null) run(() => post(`/api/admin/appointments/${a.id}/cancel`, { reason }), done);
              }}
            >
              Cancel visit
            </SmallButton>
          )}
        </div>
      )}
      <ErrorNote error={error} />
    </aside>
  );
}
