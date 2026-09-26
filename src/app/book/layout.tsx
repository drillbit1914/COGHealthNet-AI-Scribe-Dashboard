import Link from 'next/link';
import { t } from '@/i18n';

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4">
      <header className="flex items-center justify-between py-4">
        <Link href="/book" className="text-jacaranda text-2xl font-bold tracking-tight">
          {t('brand.clinic')}
        </Link>
      </header>
      <main className="flex flex-1 flex-col pb-8">{children}</main>
    </div>
  );
}
