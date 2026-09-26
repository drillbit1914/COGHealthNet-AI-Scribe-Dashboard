import { t } from '@/i18n';

export default function BookPlaceholder() {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <p className="text-jacaranda text-2xl font-bold">{t('brand.clinic')}</p>
      <p className="text-muted mt-4">Booking opens soon.</p>
    </main>
  );
}
