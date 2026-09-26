'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SlotPicker } from '@/components/book/slot-picker';
import { StickyAction } from '@/components/book/sticky-action';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert, Card, Choice, Help, Input, Label, Textarea } from '@/components/ui/field';
import en from '@/i18n/en.json';
import { t } from '@/i18n';
import { api, ApiError } from '@/lib/api';

type VisitType = 'FOLLOW_UP' | 'EVALUATION';
type Step = 'type' | 'time' | 'details' | 'review' | 'done';
interface Child {
  id: string;
  name: string;
  dob: string | null;
  canBook: boolean;
  notice: string | null;
}
interface Draft {
  visitType?: VisitType;
  startsAt?: string;
  whenLabel?: string;
  patientId?: string; // child id, or 'new'
  patientName: string;
  dob: string;
  reasonText: string;
  reasonTags: string[];
  payerType?: 'INSURANCE' | 'SELF_PAY';
  insurer: string;
  memberNo: string;
  hasReferral?: boolean;
  referralFileKey?: string;
  referralFileName?: string;
  ogName: string;
  ogRelationship: string;
  ogPhone: string;
  ogNotify: boolean;
  consentData: boolean;
  consentMessaging: boolean;
}
interface Result {
  ref: string;
  when: string;
  visitType: VisitType;
  payment: { accountName: string; accountNo: string; reference: string } | null;
  icsUrl: string;
  notice: string;
}

const EMPTY: Draft = {
  patientName: '',
  dob: '',
  reasonText: '',
  reasonTags: [],
  insurer: '',
  memberNo: '',
  ogName: '',
  ogRelationship: '',
  ogPhone: '',
  ogNotify: true,
  consentData: false,
  consentMessaging: false,
};
const KEY = 'wellnessave-booking-v1';
const TAGS = Object.keys(en.ui.details.tags) as (keyof typeof en.ui.details.tags)[];
const ORDER: Step[] = ['type', 'time', 'details', 'review'];

export function Wizard({ children_ }: { children_: Child[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const bookable = children_.filter((c) => c.canBook);
  const blocked = children_.length > 0 && bookable.length === 0;
  const [d, setD] = useState<Draft>(EMPTY);
  const [result, setResult] = useState<Result | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploading, setUploading] = useState(false);

  // Persist the draft so back navigation and reloads keep what was entered.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        setD({ ...EMPTY, ...saved.d });
        setResult(saved.result ?? null);
      }
    } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) sessionStorage.setItem(KEY, JSON.stringify({ d, result }));
  }, [d, result, loaded]);

  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const isNew = d.patientId === 'new' || (!d.patientId && bookable.length === 0);
  const isEval = d.visitType === 'EVALUATION';
  const needsConsent = isEval || isNew;
  const detailsValid =
    (isNew ? d.patientName.trim().length >= 2 && (!isEval || !!d.dob) : !!d.patientId) &&
    (!isEval ||
      (d.reasonText.trim().length > 0 &&
        !!d.payerType &&
        (d.payerType === 'SELF_PAY' ||
          (d.insurer.trim() &&
            d.memberNo.trim() &&
            d.hasReferral !== undefined &&
            (!d.hasReferral || d.referralFileKey))))) &&
    (!d.ogPhone.trim() || d.ogName.trim().length > 0) &&
    (!needsConsent || (d.consentData && d.consentMessaging));

  // Guard the URL step: never show a step whose prerequisites are missing.
  const want = (sp.get('step') as Step) ?? 'type';
  const firstMissing: Step = !d.visitType ? 'type' : !d.startsAt ? 'time' : !detailsValid ? 'details' : 'review';
  const step: Step =
    want === 'done'
      ? result
        ? 'done'
        : firstMissing
      : ORDER.indexOf(want) <= ORDER.indexOf(firstMissing)
        ? want
        : firstMissing;
  const go = (s: Step) => router.push(`/book/new?step=${s}`);
  const back = () => router.back();

  if (!loaded) return null;
  if (blocked)
    return (
      <div className="flex flex-col gap-4">
        {children_.map((c) => (
          <Alert key={c.id}>{c.notice}</Alert>
        ))}
        <Link href="/book" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
          {t('ui.steps.back')}
        </Link>
      </div>
    );

  const header = (n: number, title: string) => (
    <div className="mb-4">
      {n > 1 && (
        <button type="button" onClick={back} className="text-jacaranda mb-2 font-bold">
          ← {t('ui.steps.back')}
        </button>
      )}
      <p className="text-muted text-sm font-bold">{t('ui.steps.stepOf', { n })}</p>
      <h1 className="text-3xl font-bold">{title}</h1>
    </div>
  );

  async function uploadReferral(file: File) {
    setUploading(true);
    setError(null);
    try {
      const r = await api<{ key: string }>('/api/book/uploads/referral', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      set({ referralFileKey: r.key, referralFileName: file.name });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        visitType: d.visitType,
        startsAt: d.startsAt,
        ...(isNew ? { patientName: d.patientName.trim(), dob: d.dob || undefined } : { patientId: d.patientId }),
        evaluation: isEval
          ? {
              reasonText: d.reasonText.trim(),
              reasonTags: d.reasonTags,
              payerType: d.payerType,
              insurer: d.payerType === 'INSURANCE' ? d.insurer.trim() : undefined,
              memberNo: d.payerType === 'INSURANCE' ? d.memberNo.trim() : undefined,
              hasReferral: d.payerType === 'INSURANCE' && !!d.hasReferral,
              referralFileKey: d.payerType === 'INSURANCE' && d.hasReferral ? d.referralFileKey : undefined,
            }
          : undefined,
        otherGuardian: d.ogPhone.trim()
          ? {
              name: d.ogName.trim(),
              relationship: d.ogRelationship.trim() || undefined,
              phone: d.ogPhone.trim(),
              notify: d.ogNotify,
            }
          : undefined,
        consents: needsConsent ? { dataProcessing: d.consentData, messaging: d.consentMessaging } : undefined,
      };
      const r = await api<Result>('/api/book/requests', { method: 'POST', json: body });
      setResult(r);
      setD(EMPTY);
      router.replace('/book/new?step=done');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLOT_TAKEN') {
        // Show the message and refresh times in place.
        set({ startsAt: undefined, whenLabel: undefined });
        setRefreshKey((k) => k + 1);
        setError(e.message);
        router.push('/book/new?step=time');
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === 'type')
    return (
      <div className="flex flex-1 flex-col">
        {header(1, t('ui.type.title'))}
        <div className="flex flex-col gap-3">
          {(['FOLLOW_UP', 'EVALUATION'] as const).map((vt) => (
            <Choice
              key={vt}
              name="visitType"
              checked={d.visitType === vt}
              onChange={() => set({ visitType: vt, startsAt: undefined, whenLabel: undefined })}
              label={t(`ui.type.${vt}`)}
              help={t(`ui.type.${vt}_help`)}
            />
          ))}
        </div>
        <StickyAction>
          <Button size="lg" disabled={!d.visitType} onClick={() => go('time')}>
            {t('ui.steps.continue')}
          </Button>
        </StickyAction>
      </div>
    );

  if (step === 'time')
    return (
      <div className="flex flex-1 flex-col">
        {header(2, t('ui.time.title'))}
        <Help className="-mt-2 mb-4">{t('ui.time.help')}</Help>
        {error && (
          <Alert tone="error" className="mb-4">
            {error}
          </Alert>
        )}
        <SlotPicker
          visitType={d.visitType!}
          value={d.startsAt}
          refreshKey={refreshKey}
          onChange={(startsAt, whenLabel) => {
            setError(null);
            set({ startsAt, whenLabel });
          }}
        />
        <StickyAction>
          <Button size="lg" disabled={!d.startsAt} onClick={() => go('details')}>
            {t('ui.steps.continue')}
          </Button>
        </StickyAction>
      </div>
    );

  if (step === 'details')
    return (
      <div className="flex flex-1 flex-col gap-5">
        {header(3, t('ui.details.title'))}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-bold">{t('ui.details.whoFor')}</legend>
          {bookable.map((c) => (
            <Choice
              key={c.id}
              name="child"
              checked={d.patientId === c.id}
              onChange={() => set({ patientId: c.id })}
              label={c.name}
            />
          ))}
          {bookable.length > 0 && (
            <Choice
              name="child"
              checked={d.patientId === 'new'}
              onChange={() => set({ patientId: 'new' })}
              label={t('ui.details.someoneNew')}
            />
          )}
        </fieldset>
        {isNew && (
          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="pname">{t('ui.details.childName')}</Label>
              <Input
                id="pname"
                autoComplete="off"
                value={d.patientName}
                onChange={(e) => set({ patientName: e.target.value })}
              />
              {!isEval && <Help>{t('ui.details.needsMatch')}</Help>}
            </div>
            {isEval && (
              <div>
                <Label htmlFor="dob">{t('ui.details.dob')}</Label>
                <Input
                  id="dob"
                  type="date"
                  value={d.dob}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => set({ dob: e.target.value })}
                />
              </div>
            )}
          </div>
        )}

        {isEval && (
          <>
            <div>
              <Label htmlFor="reason">{t('ui.details.reason')}</Label>
              <Textarea
                id="reason"
                maxLength={500}
                value={d.reasonText}
                onChange={(e) => set({ reasonText: e.target.value })}
              />
              <Help>{t('ui.details.reasonHelp', { n: d.reasonText.length })}</Help>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 font-bold">{t('ui.details.reasonTags')}</legend>
              {TAGS.map((tag) => (
                <Choice
                  key={tag}
                  type="checkbox"
                  checked={d.reasonTags.includes(tag)}
                  onChange={(e) =>
                    set({
                      reasonTags: e.target.checked ? [...d.reasonTags, tag] : d.reasonTags.filter((x) => x !== tag),
                    })
                  }
                  label={t(`ui.details.tags.${tag}`)}
                />
              ))}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 font-bold">{t('ui.details.payment')}</legend>
              {(['INSURANCE', 'SELF_PAY'] as const).map((p) => (
                <Choice
                  key={p}
                  name="payer"
                  checked={d.payerType === p}
                  onChange={() => set({ payerType: p })}
                  label={t(`ui.details.${p}`)}
                />
              ))}
            </fieldset>
            {d.payerType === 'INSURANCE' && (
              <div className="flex flex-col gap-4">
                <div>
                  <Label htmlFor="insurer">{t('ui.details.insurer')}</Label>
                  <Input id="insurer" value={d.insurer} onChange={(e) => set({ insurer: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="member">{t('ui.details.memberNo')}</Label>
                  <Input id="member" value={d.memberNo} onChange={(e) => set({ memberNo: e.target.value })} />
                </div>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 font-bold">{t('ui.details.referral')}</legend>
                  <Choice
                    name="referral"
                    checked={d.hasReferral === true}
                    onChange={() => set({ hasReferral: true })}
                    label={t('ui.details.yes')}
                  />
                  <Choice
                    name="referral"
                    checked={d.hasReferral === false}
                    onChange={() =>
                      set({ hasReferral: false, referralFileKey: undefined, referralFileName: undefined })
                    }
                    label={t('ui.details.no')}
                  />
                </fieldset>
                {d.hasReferral && (
                  <div>
                    <Label htmlFor="referral">{t('ui.details.upload')}</Label>
                    <input
                      id="referral"
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      className="file:bg-jacaranda-light file:text-jacaranda block w-full text-base file:mr-3 file:rounded-xl file:border-0 file:px-4 file:py-3 file:font-bold"
                      onChange={(e) => e.target.files?.[0] && uploadReferral(e.target.files[0])}
                    />
                    <Help>
                      {uploading
                        ? t('ui.details.uploading')
                        : d.referralFileName
                          ? t('ui.details.uploaded', { name: d.referralFileName })
                          : t('ui.details.uploadHelp')}
                    </Help>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <Card className="flex flex-col gap-3">
          <p className="font-bold">{t('ui.details.otherGuardian')}</p>
          <Help className="mt-0">{t('ui.details.otherGuardianPrompt')}</Help>
          <div>
            <Label htmlFor="ogname">{t('ui.details.ogName')}</Label>
            <Input id="ogname" value={d.ogName} onChange={(e) => set({ ogName: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="ogrel">{t('ui.details.ogRelationship')}</Label>
            <Input id="ogrel" value={d.ogRelationship} onChange={(e) => set({ ogRelationship: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="ogphone">{t('ui.details.ogPhone')}</Label>
            <Input
              id="ogphone"
              type="tel"
              inputMode="tel"
              value={d.ogPhone}
              onChange={(e) => set({ ogPhone: e.target.value })}
            />
          </div>
          <Choice
            type="checkbox"
            checked={d.ogNotify}
            onChange={(e) => set({ ogNotify: e.target.checked })}
            label={t('ui.details.ogNotify')}
            help={t('booking.otherGuardianHelper')}
          />
        </Card>

        {needsConsent && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-bold">{t('ui.details.consents')}</legend>
            <Choice
              type="checkbox"
              checked={d.consentData}
              onChange={(e) => set({ consentData: e.target.checked })}
              label={t('ui.details.consentData')}
            />
            <Choice
              type="checkbox"
              checked={d.consentMessaging}
              onChange={(e) => set({ consentMessaging: e.target.checked })}
              label={t('ui.details.consentMessaging')}
            />
          </fieldset>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <StickyAction>
          <Button size="lg" disabled={!detailsValid || uploading} onClick={() => go('review')}>
            {t('ui.steps.continue')}
          </Button>
        </StickyAction>
      </div>
    );

  if (step === 'review') {
    const childName = isNew ? d.patientName : bookable.find((c) => c.id === d.patientId)?.name;
    return (
      <div className="flex flex-1 flex-col gap-4">
        {header(4, t('ui.review.title'))}
        <Card>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted">{t('ui.review.visit')}</dt>
            <dd className="font-bold">{t(`visitTypeTitle.${d.visitType}`)}</dd>
            <dt className="text-muted">{t('ui.review.when')}</dt>
            <dd className="font-bold">{d.whenLabel}</dd>
            <dt className="text-muted">{t('ui.review.child')}</dt>
            <dd className="font-bold">{childName}</dd>
          </dl>
        </Card>
        <Help>{t('ui.review.therapistNote')}</Help>
        {error && <Alert tone="error">{error}</Alert>}
        <StickyAction>
          <Button size="lg" disabled={busy} onClick={submit}>
            {busy ? t('ui.review.submitting') : t('ui.review.submit')}
          </Button>
        </StickyAction>
      </div>
    );
  }

  // step === 'done'
  const r = result!;
  return (
    <div className="flex flex-1 flex-col gap-4">
      <h1 className="text-3xl font-bold">{t('ui.done.title')}</h1>
      <Card className="text-center">
        <p className="text-muted">{t('ui.done.ref')}</p>
        <p className="text-jacaranda text-4xl font-bold tracking-wider" data-testid="booking-ref">
          {r.ref}
        </p>
        <p className="mt-2 font-bold">{r.when}</p>
      </Card>
      <p>{r.visitType === 'EVALUATION' ? t('ui.done.evalNote') : t('ui.done.pending')}</p>
      {r.payment && (
        <Card>
          <p className="mb-2 font-bold">{t('ui.done.payTitle')}</p>
          <ul className="mb-3 list-disc pl-5">
            <li>{t('ui.done.payCash')}</li>
            <li>{t('ui.done.payBank')}</li>
          </ul>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted">{t('ui.done.accountName')}</dt>
            <dd className="font-bold">{r.payment.accountName}</dd>
            <dt className="text-muted">{t('ui.done.accountNo')}</dt>
            <dd className="font-bold">{r.payment.accountNo}</dd>
            <dt className="text-muted">{t('ui.done.payRef')}</dt>
            <dd className="font-bold">{r.payment.reference}</dd>
          </dl>
        </Card>
      )}
      <Alert tone="warning">{r.notice}</Alert>
      <a href={r.icsUrl} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
        {t('ui.done.addCalendar')}
      </a>
      <StickyAction>
        <Link
          href="/book/visits"
          onClick={() => sessionStorage.removeItem(KEY)}
          className={buttonVariants({ size: 'lg' })}
        >
          {t('ui.done.viewVisits')}
        </Link>
      </StickyAction>
    </div>
  );
}
