import { Suspense } from 'react';
import Board from '@/components/Board';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">불러오는 중...</div>}>
      <Board />
    </Suspense>
  );
}
