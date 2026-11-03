# ARGUS-K (MVP v1.1)

북한 등 안보 관련 공개정보를 자동 수집하고, 중복을 정리하고, **출처가 붙은 사실·추정 구분 요약**과 지도로 전일 대비 변화를 보여주며, **사람이 검토·승인한 내용만** 지휘관 브리핑으로 게시하는 웹 도구입니다.

- **로컬 실행**: DB 설정 없이 바로 실행됩니다 (로컬 Postgres 호환 파일 DB `data/pglite`).
- **배포**: Vercel + Supabase(Postgres). 아래 "Vercel + Supabase 배포" 참고.

## 로컬 실행 (명령 3개)

필요한 것: **Node.js 20 LTS 이상**, Chrome 또는 Edge

```bash
npm install
copy .env.example .env.local     # macOS: cp .env.example .env.local   (AI를 쓸 때만 내용을 채우면 됩니다)
npm run start:local
```

처음 실행은 빌드 때문에 1~2분 걸립니다. 다 되면 **http://localhost:3000** 을 여세요. `data/pglite` 가 자동으로 만들어지고 수집 출처가 등록됩니다. 종료는 `Ctrl + C`.

`.env.local` 에 `DATABASE_URL` 을 넣으면 로컬에서도 그 Postgres(예: Supabase)를 씁니다. `npm run dev` 는 항상 로컬 개발용 DB(`data/pglite-dev`)를 써서 운영 DB를 건드리지 않습니다.

## Vercel + Supabase 배포

### 1) Supabase 준비
1. https://supabase.com 에서 프로젝트 생성 (리전은 가까운 곳, 예: Northeast Asia/Seoul). **Database password** 를 기록해 둡니다.
2. 프로젝트 → **Connect** → **Transaction pooler**(포트 6543) 연결 문자열을 복사합니다. 형태: `postgresql://postgres.<프로젝트ID>:<비밀번호>@<호스트>:6543/postgres`
3. 테이블은 **직접 만들 필요가 없습니다.** 첫 요청 때 앱이 `db/migrations/*.sql` 을 자동 적용하고 수집 출처 8개를 등록합니다.

### 2) Vercel 배포
1. https://vercel.com → **Add New → Project** → GitHub 저장소 `leesk_261103` 선택
2. **Root Directory** 는 기본값(저장소 루트) 그대로 둡니다. Framework Preset 은 Next.js 로 자동 인식됩니다
3. **Environment Variables** 등록:

| 이름 | 값 |
|---|---|
| `DATABASE_URL` | Supabase 연결 문자열 (필수) |
| `EDIT_PIN` | 쓰기용 공유 PIN, 6자리 이상 (필수. 없으면 편집·수집 버튼이 모두 막힙니다) |
| `CRON_SECRET` | 임의의 긴 문자열 (필수. 매일 자동 수집 인증용) |
| `GEMINI_API_KEY`, `AI_MODEL` | 선택. Gemini API 키(또는 `ANTHROPIC_API_KEY`). 없으면 키워드 규칙으로 동작 |

4. **Deploy**. 배포 후 주소(`https://….vercel.app`)를 열면 상황판이 나옵니다.

### 수집 방식 (Hobby 플랜)
- **매일 07:00(KST) 자동 수집**: `vercel.json` 의 Cron 이 `/api/cron/collect` 를 호출합니다. Hobby 플랜은 정해진 시각의 **1시간 안**에 실행됩니다.
- **지금 수집 버튼**: 상황판·설정 화면에서 언제든 수동 수집 (PIN 필요).
- **실시간 수집**: 상황판이 **열려 있는 동안** 설정 간격(`LIVE_INTERVAL_MIN`, 기본 10분)마다 자동 수집합니다. 서버에 상시 타이머가 없으므로 화면을 닫으면 멈춥니다. 상시 10분 수집이 필요하면 Vercel Pro 로 Cron 을 10분 간격으로 바꾸세요.
- 긴급 알람(붉은 띠·경보음)도 화면이 열려 있을 때만 울립니다.

### 주의
- **인터넷에 공개되는 주소**입니다. 열람은 누구나 가능하고 쓰기만 PIN 으로 막힙니다. 비공개로 운영하려면 Vercel 의 Deployment Protection(Vercel Authentication)을 켜세요.
- 수집은 한 번에 최대 약 200초 안에서 처리하고, 남은 기사는 다음 수집에서 이어서 처리합니다.
- 백업은 Supabase 대시보드(Database → Backups)를 사용하세요.

## `.env.local` 설정

| 이름 | 설명 | 기본값 |
|---|---|---|
| `DATABASE_URL` | Postgres 연결 문자열. 없으면 로컬 파일 DB | 없음 |
| `PGLITE_DIR` | 로컬 파일 DB 경로 | `./data/pglite` |
| `AI_PROVIDER` | `gemini` 또는 `anthropic`. 비우면 키가 있는 쪽 자동 선택(Gemini 우선) | 자동 |
| `GEMINI_API_KEY` | Google Gemini API 키 (aistudio.google.com/apikey, 무료 등급 가능). **없어도 실행됩니다** | 없음 |
| `ANTHROPIC_API_KEY` | Claude API 키 (`AI_PROVIDER=anthropic` 일 때) | 없음 |
| `AI_MODEL` | 사용할 모델 ID | Gemini: `gemini-3.6-flash` |
| `AI_FALLBACK_MODEL` | Gemini 과부하(503)·한도(429) 시 예비 모델 | `gemini-3.5-flash-lite` |
| `AI_DAILY_LIMIT` / `AI_BATCH_LIMIT` | 하루 AI 호출 상한 / 수집 1회당 AI 처리 기사 수 | 300 / 100 |
| `LIVE_INTERVAL_MIN` | 실시간 수집 간격(분). 0 이면 끔 | 10 |
| `PORT` | 로컬 포트 | `3000` |
| `EDIT_PIN` | 공유 모드/배포용 PIN (6자리 이상) | 없음 |
| `CRON_SECRET` | 배포 시 Cron 인증 문자열 | 없음 |

### AI 없이 쓰기
API 키가 없으면 수집된 기사는 **키워드 규칙**으로 지역·유형을 추정해 수집함에 들어가고, 위치는 지명 사전으로 채웁니다. 요약은 실무자가 직접 쓰거나 CSV(사전 생성 요약)로 넣습니다. 키를 넣으면 위치·유형 추출, 요약 문장 생성, 충돌 제안, 브리핑 초안 작성에 AI가 쓰입니다. AI 결과는 모두 **[미확인]/[사실 제안]** 으로 시작하며 사람이 승인해야 합니다.

## 내부망 공유 모드 (선택)

1. `.env.local` 에 `EDIT_PIN=숫자6자리이상` 설정
2. `npm run start:lan`
3. 다른 PC 브라우저에서 `http://<실행 PC의 IP>:3000`

열람은 PIN 없이 가능하고, 수집·편집·게시 등 **쓰기 작업에는 PIN**이 필요합니다(같은 IP에서 5회 틀리면 10분 잠금).

## 화면

- **상황판** — 지역별 신규·지속·확대·종료 건수와 경보 배지, 지도 + 목록(번호 연동), 필터, 사건 상세 패널, 긴급 알람
- **브리핑** — 보기 / 편집 / 발표(전체화면). 게시 전 검증(출처 없는 문장·검토 미완료 사건 참조·[사실] 조건)을 통과해야 게시됩니다.
- **데이터·설정** — 지금 수집, 수집 기록, 출처 활성 토글, CSV 업로드, AI 설정, 저장소 정보

## 핵심 규칙 (PRD 11·16·17장)

- 모든 요약 문장은 라벨 1개 + 출처 1개 이상. 출처 없는 문장은 자동으로 [미확인]
- **[사실]** 은 ① 서로 독립적인 출처 2개 이상, 또는 ② A등급(공식) 출처 1개 + 실무자 승인일 때만 저장됩니다. 당사자(관영매체) 기사만 있으면 [당사자 주장]만 가능
- 같은 URL은 한 번만 저장, 원문 본문은 저장하지 않음(제목·설명·링크만)
- 중복은 후보만 제안하고 **병합은 사람이 확정**
- 검토 완료된 사건만 브리핑에 들어갑니다

## 개발·테스트

```bash
npm run seed:dev   # 개발용 DB(data/pglite-dev)에 합성 데이터 40건 넣기 (운영 DB에는 넣지 않음)
npm run dev        # 개발용 DB로 개발 서버 시작 (http://localhost:3000)
npm test           # [사실] 조건·신뢰도·경보·중복 규칙 단위 테스트
```

## 수집 출처 (`data/feeds.seed.json`)

연합뉴스 북한, 38 North, NK News, UN News(평화·안보), IAEA, Yonhap(English), BBC 중동, Kyiv Independent.
RSS를 확인하지 못해 제외한 출처: **통일부 보도자료**(RSS 주소 404), **ISW**(접근 403). 출처를 추가하려면 `data/feeds.seed.json` 에 넣으세요(DB가 비어 있을 때만 반영되며, 이미 만든 DB에서는 설정 화면의 활성 토글만 지원).

## 문제 해결

| 증상 | 조치 |
|---|---|
| 포트 3000이 사용 중 | `.env.local` 에서 `PORT=3001` 로 변경 |
| 지도가 안 보임 | 인터넷(지도 타일) 확인. 목록·상세는 계속 사용 가능 |
| 배포 후 "DATABASE_URL 환경변수가 없습니다" | Vercel 환경변수에 `DATABASE_URL` 등록 후 재배포 |
| 배포 후 버튼이 "PIN이 필요합니다" | Vercel 에 `EDIT_PIN` 등록 후 재배포, 화면에서 PIN 입력 |
| 수집 버튼이 시간 초과 | Vercel 플랜의 함수 최대 실행 시간 확인. 남은 기사는 다음 수집에서 이어서 처리됩니다 |

> 공개정보 기반 분석지원 도구입니다. AI 결과는 반드시 검토하고, 최종 판단은 사람이 합니다. 사건 정보는 요약을 위해 외부 AI 서비스로 전송되므로 비공개 업무 내용을 입력하지 마십시오.
