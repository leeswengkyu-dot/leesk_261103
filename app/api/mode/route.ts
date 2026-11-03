import { NextResponse } from 'next/server';
import { isLanMode, requireWrite } from '@/lib/pin';

export const dynamic = 'force-dynamic';

export function GET() {
  const lan = isLanMode();
  return NextResponse.json({ mode: lan ? 'lan' : 'local', pinRequired: lan });
}

/** PIN 확인용 (클라이언트가 입력한 PIN 이 맞는지 검사) */
export function POST(req: Request) {
  return requireWrite(req) ?? NextResponse.json({ ok: true });
}
