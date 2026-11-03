import { NextResponse } from 'next/server';
import { requireWrite } from './pin';
import { ValidationError } from './events';
import { CollectBusy } from './collect';
import { AiUnavailable } from './ai/provider';

type Ctx<P> = { params: Promise<P> };

/** 쓰기 라우트 공통 래퍼: PIN 확인 → 실행 → 오류를 JSON 으로 변환 */
export function write<P = Record<string, never>>(fn: (req: Request, ctx: Ctx<P>) => Promise<unknown> | unknown) {
  return async (req: Request, ctx: Ctx<P>) => {
    const denied = requireWrite(req);
    if (denied) return denied;
    return run(() => fn(req, ctx));
  };
}

export function read<P = Record<string, never>>(fn: (req: Request, ctx: Ctx<P>) => Promise<unknown> | unknown) {
  return async (req: Request, ctx: Ctx<P>) => run(() => fn(req, ctx));
}

async function run(fn: () => Promise<unknown> | unknown) {
  try {
    const out = await fn();
    if (out instanceof Response) return out;
    return NextResponse.json(out ?? { ok: true });
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 422 });
    if (e instanceof CollectBusy) return NextResponse.json({ error: e.message, code: 'busy' }, { status: 409 });
    if (e instanceof AiUnavailable) return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
    const msg = (e as Error).message || '알 수 없는 오류';
    console.error('[api]', e);
    const full = /ENOSPC|SQLITE_FULL/.test(msg);
    return NextResponse.json({ error: full ? '저장 공간이 부족합니다' : msg }, { status: 500 });
  }
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ValidationError('요청 형식이 올바르지 않습니다');
  }
}
