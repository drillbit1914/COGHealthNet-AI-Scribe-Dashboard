'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorNote, Field, inp } from '@/components/admin/ui';
import { t } from '@/i18n';
import { api } from '@/lib/api';

interface Setup {
  setupToken: string;
  secret: string;
  qr: string;
}

export default function StaffLogin() {
  const router = useRouter();
  const [f, setF] = useState({ email: '', password: '', totp: '' });
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enter = () => {
    router.replace('/admin/queue');
    router.refresh();
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (setup) {
        await api('/api/auth/staff/totp-setup', { method: 'POST', json: { setupToken: setup.setupToken, code } });
        return enter();
      }
      const r = await api<{ needsTotpSetup?: boolean } & Partial<Setup>>('/api/auth/staff/login', {
        method: 'POST',
        json: { ...f, totp: f.totp || undefined },
      });
      if (r.needsTotpSetup) setSetup(r as Setup);
      else enter();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-8">
      <p className="text-jacaranda mb-6 text-3xl font-bold">{t('brand.clinic')}</p>
      <form className="border-line flex flex-col gap-3 rounded-lg border bg-white p-6" onSubmit={submit}>
        {!setup ? (
          <>
            <h1 className="text-xl font-bold">Staff sign in</h1>
            <Field label="Email">
              <input
                className={inp}
                type="email"
                autoComplete="username"
                required
                value={f.email}
                onChange={(e) => setF({ ...f, email: e.target.value })}
              />
            </Field>
            <Field label="Password">
              <input
                className={inp}
                type="password"
                autoComplete="current-password"
                required
                value={f.password}
                onChange={(e) => setF({ ...f, password: e.target.value })}
              />
            </Field>
            <Field label="Authenticator code">
              <input
                className={inp}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={f.totp}
                onChange={(e) => setF({ ...f, totp: e.target.value.replace(/\D/g, '') })}
              />
            </Field>
            <p className="text-muted text-xs">
              First sign-in? Leave the code empty — you’ll set up your authenticator next.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold">Set up two-factor sign-in</h1>
            <ol className="list-decimal pl-5 text-sm">
              <li>Open Google Authenticator or Microsoft Authenticator on your phone.</li>
              <li>Tap “+” and scan this code.</li>
              <li>Type the 6-digit code it shows.</li>
            </ol>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="Authenticator QR code" className="mx-auto size-48" />
            <p className="text-muted text-center text-xs break-all">
              Can’t scan? Enter this key: <code className="font-mono">{setup.secret}</code>
            </p>
            <Field label="6-digit code">
              <input
                className={inp}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
          </>
        )}
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy}>
          {setup ? 'Finish setup and sign in' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}
