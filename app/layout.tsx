import './globals.css';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import TopBar from '@/components/TopBar';
import PinDialog from '@/components/PinDialog';

export const metadata: Metadata = {
  title: 'ARGUS-K',
  description: '공개정보 기반 안보 동향 분석지원 도구',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="flex min-h-screen flex-col">
        <Suspense fallback={<div className="h-12 bg-slate-900" />}>
          <TopBar />
        </Suspense>
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        <PinDialog />
      </body>
    </html>
  );
}
