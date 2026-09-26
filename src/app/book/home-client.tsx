'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, Help, Input, Label } from '@/components/ui/field';
import { t } from '@/i18n';
import { api } from '@/lib/api';

export function NameForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  return (
    <Card>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await api('/api/book/me', { method: 'PATCH', json: { name } });
          router.refresh();
        }}
        className="flex flex-col gap-2"
      >
        <Label htmlFor="gname">{t('ui.home.nameLabel')}</Label>
        <Input id="gname" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Help>{t('ui.home.namePrompt')}</Help>
        <Button type="submit" variant="secondary" disabled={!name.trim()}>
          {t('ui.home.saveName')}
        </Button>
      </form>
    </Card>
  );
}

export function SignOut() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      className="self-start"
      onClick={async () => {
        await api('/api/auth/logout', { method: 'POST' });
        router.replace('/book/sign-in');
      }}
    >
      {t('ui.home.signOut')}
    </Button>
  );
}
