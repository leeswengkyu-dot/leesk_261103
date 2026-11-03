import { NextResponse } from 'next/server';
import { isLanMode, requireWrite } from '@/lib/pin';

export const dynamic = 'force-dynamic';

export function GET() {
  const lan = isLanMode();
  // web: 인터넷에 공개된 배포(Vercel), lan: 내부망 공유, local: 이 PC 전용
  return NextResponse.json({ mode: process.env.VERCEL ? 'web' : lan ? 'lan' : 'local', pinRequired: lan });
}

/** PIN 확인용 (클라이언트가 입력한 PIN 이 맞는지 검사) */
export async function POST(req: Request) {
  return (await requireWrite(req)) ?? NextResponse.json({ ok: true });
}
