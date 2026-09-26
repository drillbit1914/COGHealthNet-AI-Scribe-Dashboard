import type { Metadata } from 'next';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('brand.adminTitle') };

export default function AdminPlaceholder() {
  return (
    <main className="px-8 py-10">
      <p className="text-jacaranda text-2xl font-bold">{t('brand.clinic')}</p>
    </main>
  );
}
