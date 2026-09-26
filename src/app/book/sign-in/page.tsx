'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StickyAction } from '@/components/book/sticky-action';
import { Button } from '@/components/ui/button';
import { Alert, Help, Input, Label } from '@/components/ui/field';
import { t } from '@/i18n';
import { api } from '@/lib/api';

export default function SignIn() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [e164, setE164] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ phone: string }>('/api/auth/otp/request', { method: 'POST', json: { phone } });
      setE164(r.phone);
      setCode('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/otp/verify', { method: 'POST', json: { phone: e164, code } });
      router.replace('/book');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!e164)
    return (
      <form onSubmit={send} className="flex flex-1 flex-col gap-4">
        <h1 className="text-3xl font-bold">{t('ui.signIn.title')}</h1>
        <div>
          <Label htmlFor="phone">{t('ui.signIn.phoneLabel')}</Label>
          <Input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="264 235 1234"
          />
          <Help>{t('ui.signIn.phoneHelp')}</Help>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <StickyAction>
          <Button size="lg" type="submit" disabled={busy || phone.trim().length < 7}>
            {t('ui.signIn.sendCode')}
          </Button>
        </StickyAction>
      </form>
    );

  return (
    <form onSubmit={verify} className="flex flex-1 flex-col gap-4">
      <h1 className="text-3xl font-bold">{t('ui.signIn.codeTitle')}</h1>
      <p>{t('ui.signIn.codeHelp', { phone: e164 })}</p>
      <div>
        <Label htmlFor="code">{t('ui.signIn.codeLabel')}</Label>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="text-center text-2xl tracking-[0.5em]"
        />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-between">
        <Button type="button" variant="ghost" onClick={() => setE164(null)}>
          {t('ui.signIn.differentNumber')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => send()} disabled={busy}>
          {t('ui.signIn.resend')}
        </Button>
      </div>
      <StickyAction>
        <Button size="lg" type="submit" disabled={busy || code.length !== 6}>
          {t('ui.signIn.verify')}
        </Button>
      </StickyAction>
    </form>
  );
}
