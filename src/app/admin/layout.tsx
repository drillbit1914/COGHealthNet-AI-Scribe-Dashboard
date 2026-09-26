import type { Metadata } from 'next';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('brand.adminTitle') };

export default function AdminRoot({ children }: { children: React.ReactNode }) {
  return <div className="bg-paper text-ink min-h-dvh">{children}</div>;
}
