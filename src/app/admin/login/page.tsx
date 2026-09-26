'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorNote, Field, inp } from '@/components/admin/ui';
import { t } from '@/i18n';
import { api } from '@/lib/api';

export default function StaffLogin() {
  const router = useRouter();
  const [f, setF] = useState({ email: '', password: '', totp: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <p className="text-jacaranda mb-6 text-3xl font-bold">{t('brand.clinic')}</p>
      <form
        className="border-line flex flex-col gap-3 rounded-lg border bg-white p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/api/auth/staff/login', { method: 'POST', json: { ...f, totp: f.totp || undefined } });
            router.replace('/admin/queue');
            router.refresh();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
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
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
