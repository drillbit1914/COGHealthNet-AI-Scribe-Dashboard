import type { Metadata, Viewport } from 'next';
import { t } from '@/i18n';
import './globals.css';

export const metadata: Metadata = { title: t('brand.parentTitle'), description: t('brand.product') };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#5B3F8C' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-paper text-ink min-h-dvh antialiased">{children}</body>
    </html>
  );
}
