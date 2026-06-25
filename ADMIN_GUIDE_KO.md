# DNS 셀프서비스 API — 관리자 운영 매뉴얼

> 이 문서는 캠프 운영진을 위한 것입니다. 학생용 가이드는 `STUDENT_GUIDE_KO.md`를 참고하세요.

---

## 목차

1. [시스템 구성 요약](#1-시스템-구성-요약)
2. [최초 배포 절차](#2-최초-배포-절차)
3. [관리자 인증](#3-관리자-인증)
4. [학생 계정 관리](#4-학생-계정-관리)
5. [API 키 관리](#5-api-키-관리)
6. [DNS 레코드 관리 (관리자 전용)](#6-dns-레코드-관리-관리자-전용)
7. [감사 로그 조회](#7-감사-로그-조회)
8. [테스트 키 생성](#8-테스트-키-생성)
9. [헬스 체크](#9-헬스-체크)
10. [모니터링 및 운영](#10-모니터링-및-운영)
11. [장애 대응 절차](#11-장애-대응-절차)
12. [Cloudflare Free Tier 운영 주의사항](#12-cloudflare-free-tier-운영-주의사항)
13. [보안 체크리스트](#13-보안-체크리스트)
14. [전체 API 엔드포인트 목록](#14-전체-api-엔드포인트-목록)

---

## 1. 시스템 구성 요약

```
[학생 curl/Postman]
       │
       ▼
[nginx 또는 Cloudflare (앞단)]   ← 실제 IP 숨김 + TLS 종단
       │
       ▼
[dns-api (Node.js / Hono)]       포트 3000
       │                         ├ /v1/*       학생용
       │                         └ /admin/*    관리자 전용
       ▼
[PostgreSQL 16]                  포트 5432 (외부 미노출)
       │
       ▼
[Cloudflare API (dns_records)]   외부 호출 (10s 타임아웃)
```

### 스택

| 구성요소 | 기술 |
|---|---|
| 런타임 | Node.js 20 (Alpine) |
| 프레임워크 | Hono |
| ORM | Prisma + PostgreSQL 16 |
| 입력 검증 | Zod |
| DNS 백엔드 | Cloudflare API (free tier) |
| 컨테이너 | Docker + docker-compose |

---

## 2. 최초 배포 절차

### 2-1. 환경 파일 작성

```bash
cp .env.example .env
```

`.env` 파일을 열어 다음 항목을 모두 채웁니다:

```bash
# PostgreSQL 비밀번호 (20자 이상 랜덤값 권장)
POSTGRES_PASSWORD=여기에_강한_비밀번호

# 루트 도메인 (Cloudflare에서 관리 중인 도메인)
ROOT_DOMAIN=madcamp-kaist.org

# API 서버 공개 URL (로그/에러 안내용)
PUBLIC_BASE_URL=https://dns.madcamp-kaist.org

# Cloudflare Zone ID — CF 대시보드 → 도메인 선택 → Overview 오른쪽에 표시
CLOUDFLARE_ZONE_ID=abcdef1234567890abcdef1234567890

# Cloudflare API 토큰 — "DNS Edit" 권한만 부여 (최소 권한 원칙)
CLOUDFLARE_API_TOKEN=Bearer_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 관리자 API 키 — 아래 명령으로 생성
ADMIN_API_KEY=admin_dns_$(openssl rand -hex 32)
```

> **Cloudflare API 토큰 생성 방법**  
> CF 대시보드 → My Profile → API Tokens → Create Token  
> Template: "Edit zone DNS" → Zone 선택 → 생성

### 2-2. 서비스 시작

```bash
docker compose up -d
```

컨테이너가 올라오면 마이그레이션이 자동 실행되고 서버가 시작됩니다.

### 2-3. 시작 확인

```bash
# 헬스 체크
curl http://localhost:3000/health

# 예상 응답
# {"status":"ok","timestamp":"2026-06-25T09:00:00.000Z"}

# 로그 확인
docker compose logs -f api
```

### 2-4. 테스트 (선택)

```bash
# 테스트 학생 계정 2개 + API 키 자동 생성
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count": 2}' \
  http://localhost:3000/admin/test-keys | jq
```

---

## 3. 관리자 인증

### 서비스 정보

| 항목 | 값 |
|---|---|
| **API 주소** | `https://dns.madcamp-kaist.org` |
| **서버 IP** | `167.172.66.80` |
| **서버 경로** | `/opt/madcamp-dns` |
| **루트 도메인** | `madcamp-kaist.org` |

모든 `/admin/*` 엔드포인트는 관리자 API 키가 필요합니다.

```bash
# 관리자 API 키를 환경변수로 설정해두면 편합니다
export ADMIN_KEY="서버 /opt/madcamp-dns/.env의 ADMIN_API_KEY 값"
export BASE_URL="https://dns.madcamp-kaist.org"
```

이후 모든 관리자 요청에:

```
Authorization: Bearer $ADMIN_KEY
```

### 전체 관리자 엔드포인트 (전체 URL)

| Method | 전체 URL | 설명 |
|---|---|---|
| POST | `https://dns.madcamp-kaist.org/admin/students` | 학생 생성 |
| POST | `https://dns.madcamp-kaist.org/admin/students/bulk` | 학생 대량 생성 |
| GET | `https://dns.madcamp-kaist.org/admin/students` | 학생 목록 |
| GET | `https://dns.madcamp-kaist.org/admin/students/:id` | 학생 단건 |
| PATCH | `https://dns.madcamp-kaist.org/admin/students/:id` | 학생 수정 |
| GET | `https://dns.madcamp-kaist.org/admin/students/:id/api-keys` | API 키 목록 |
| POST | `https://dns.madcamp-kaist.org/admin/students/:id/api-keys` | API 키 발급 |
| POST | `https://dns.madcamp-kaist.org/admin/students/:id/rotate-key` | 키 교체 |
| DELETE | `https://dns.madcamp-kaist.org/admin/students/:id/api-keys/:keyId` | 키 폐기 |
| GET | `https://dns.madcamp-kaist.org/admin/records` | 레코드 조회 |
| DELETE | `https://dns.madcamp-kaist.org/admin/records/:id` | 레코드 강제 삭제 |
| GET | `https://dns.madcamp-kaist.org/admin/audit-logs` | 감사 로그 |
| POST | `https://dns.madcamp-kaist.org/admin/test-keys` | 테스트 계정 생성 |
| GET | `https://dns.madcamp-kaist.org/health` | 헬스 체크 (인증 불필요) |

---

## 4. 학생 계정 관리

### 학생 1명 생성

```bash
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@kaist.ac.kr",
    "name": "Alice",
    "subdomain": "alice",
    "recordLimit": 10
  }' \
  $BASE_URL/admin/students | jq
```

응답에 `apiKey` 필드로 초기 API 키가 포함됩니다 (이 값은 한 번만 표시됨).

**요청 필드**

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `email` | string | 필수 | | 학생 이메일 (중복 불가) |
| `name` | string | 선택 | | 학생 이름 |
| `subdomain` | string | 필수 | | 기본 서브도메인 (소문자, 숫자, 하이픈, 1~32자) |
| `recordLimit` | number | 선택 | `10` | DNS 레코드 최대 생성 개수 (1~100) |

---

### 학생 대량 생성 (최대 100명)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "students": [
      {"email": "alice@kaist.ac.kr", "subdomain": "alice"},
      {"email": "bob@kaist.ac.kr",   "subdomain": "bob"},
      {"email": "carol@kaist.ac.kr", "subdomain": "carol"}
    ],
    "recordLimit": 10
  }' \
  $BASE_URL/admin/students/bulk | jq
```

---

### 학생 목록 조회

```bash
# 기본 (20명씩 페이징)
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/students" | jq

# 페이지 조회
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/students?page=2&limit=50" | jq
```

---

### 학생 단건 조회

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  $BASE_URL/admin/students/<STUDENT_ID> | jq
```

---

### 학생 정보 수정

`isActive`, `name`, `recordLimit` 중 원하는 필드만 보내면 됩니다.

```bash
# 계정 비활성화 (학생 차단)
curl -s -X PATCH \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"isActive": false}' \
  $BASE_URL/admin/students/<STUDENT_ID> | jq

# 레코드 한도 증가
curl -s -X PATCH \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"recordLimit": 20}' \
  $BASE_URL/admin/students/<STUDENT_ID> | jq

# 다시 활성화
curl -s -X PATCH \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"isActive": true}' \
  $BASE_URL/admin/students/<STUDENT_ID> | jq
```

---

## 5. API 키 관리

### 학생의 API 키 목록 조회

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  $BASE_URL/admin/students/<STUDENT_ID>/api-keys | jq
```

응답 예시:

```json
{
  "apiKeys": [
    {
      "id": "key_abc123",
      "keyPrefix": "dns_a1b2",
      "label": "default",
      "isActive": true,
      "lastUsedAt": "2026-06-25T10:30:00.000Z",
      "createdAt": "2026-06-25T09:00:00.000Z",
      "revokedAt": null
    }
  ]
}
```

---

### 새 API 키 발급

기존 키는 그대로 유지하고 새 키를 추가합니다.

```bash
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label": "재발급 2026-06-25"}' \
  $BASE_URL/admin/students/<STUDENT_ID>/api-keys | jq
```

응답에 `apiKey` (raw 값) 포함 — 이 값은 한 번만 표시됩니다. 학생에게 안전하게 전달하세요.

---

### API 키 교체 (기존 키 전부 폐기 + 신규 발급)

학생이 키를 분실하거나 유출된 경우 사용합니다.

```bash
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_KEY" \
  $BASE_URL/admin/students/<STUDENT_ID>/rotate-key | jq
```

> **주의**: 기존 활성 키가 전부 폐기됩니다. 학생의 기존 스크립트/설정이 모두 중단됩니다.

---

### 특정 API 키 단건 폐기

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $ADMIN_KEY" \
  $BASE_URL/admin/students/<STUDENT_ID>/api-keys/<KEY_ID> | jq
```

---

## 6. DNS 레코드 관리 (관리자 전용)

### 전체 레코드 목록 조회

```bash
# 전체
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/records" | jq

# 특정 학생 레코드만
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/records?studentId=<STUDENT_ID>" | jq

# 페이징
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/records?page=1&limit=50" | jq
```

관리자 응답에는 학생에게 숨겨진 `cloudflareRecordId`도 포함됩니다.

---

### 레코드 강제 삭제

학생이 직접 삭제하지 않은 레코드를 관리자가 강제 제거합니다.

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $ADMIN_KEY" \
  $BASE_URL/admin/records/<RECORD_ID> | jq
```

---

## 7. 감사 로그 조회

모든 생성/수정/삭제/인증 작업이 자동으로 기록됩니다.

```bash
# 전체 감사 로그 (최신순)
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/audit-logs" | jq

# 특정 학생 로그
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/audit-logs?studentId=<STUDENT_ID>" | jq

# 특정 액션만
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/audit-logs?action=DNS_RECORD_CREATED" | jq

# 날짜 범위 필터 (ISO 8601)
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/audit-logs?after=2026-06-25T00:00:00Z&before=2026-06-25T23:59:59Z" | jq

# 페이징
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/audit-logs?page=1&limit=100" | jq
```

**조회 가능한 액션 목록**

| 액션 | 의미 |
|---|---|
| `STUDENT_CREATED` | 학생 계정 생성 |
| `STUDENTS_BULK_CREATED` | 학생 대량 생성 |
| `API_KEY_CREATED` | API 키 발급 |
| `API_KEY_ROTATED` | API 키 교체 |
| `API_KEY_REVOKED` | API 키 폐기 |
| `STUDENT_UPDATED` | 학생 정보 수정 (isActive, recordLimit 등) |
| `ADMIN_RECORD_DELETED` | 관리자 강제 레코드 삭제 |
| `DNS_RECORD_CREATED` | 학생이 DNS 레코드 생성 |
| `DNS_RECORD_UPDATED` | 학생이 DNS 레코드 수정 |
| `DNS_RECORD_DELETED` | 학생이 DNS 레코드 삭제 |
| `SUBDOMAIN_CLAIMED` | 학생이 추가 서브도메인 신청 |
| `SUBDOMAIN_RELEASED` | 학생이 추가 서브도메인 반납 |
| `TEST_KEYS_CREATED` | 테스트 키 생성 |

---

## 8. 테스트 키 생성

캠프 시작 전, 개발용 테스트 계정을 빠르게 만들 때 사용합니다.

```bash
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count": 3, "recordLimit": 10}' \
  $BASE_URL/admin/test-keys | jq
```

`test1@local`, `test2@local`, `test3@local` 학생이 생성되고 각각의 API 키가 반환됩니다. 이미 존재하는 경우 새 키만 추가됩니다.

---

## 9. 헬스 체크

```bash
curl http://localhost:3000/health
```

응답:
- `200 {"status":"ok"}` — 정상
- `503 {"status":"error","message":"Database unavailable."}` — DB 연결 불가

> 5초 캐시가 있어 연속 호출 시 DB에 부하를 주지 않습니다.

---

## 10. 모니터링 및 운영

### 로그 확인

```bash
# 실시간 로그
docker compose logs -f api

# 최근 100줄
docker compose logs --tail=100 api

# 오류만 필터
docker compose logs api 2>&1 | grep -E "\[SLOW\]|\[fatal\]|\[unhandled\]"
```

**로그 패턴**

| 패턴 | 의미 |
|---|---|
| `[req ] GET /v1/records 200 5ms` | 정상 요청 |
| `[SLOW] POST /v1/records 201 3200ms` | 2초 초과 요청 (CF API 지연 등) |
| `[fatal]` | 프로세스 종료 수준 오류 |
| `[unhandled error]` | 처리되지 않은 500 에러 |
| `[audit] Failed to write audit log` | 감사 로그 기록 실패 (경미) |
| `[rate-limit cleanup]` | 레이트리밋 정리 실패 (경미) |

---

### 컨테이너 상태 확인

```bash
docker compose ps

# 예상 출력
# NAME        STATUS    PORTS
# dns-api-db-1   Up (healthy)
# dns-api-api-1  Up (healthy)   0.0.0.0:3000->3000/tcp
```

---

### 서비스 재시작

```bash
# API만 재시작 (마이그레이션도 재실행됨)
docker compose restart api

# 전체 재시작
docker compose down && docker compose up -d
```

---

### DB 직접 접속 (디버깅용)

```bash
# 주의: 프로덕션에서는 docker-compose.yml에서 포트가 주석 처리되어 있음
# 필요 시 임시로 주석 해제 후 접속

docker compose exec db psql -U dnsapi -d dnsapi

# 유용한 SQL
-- 전체 학생 수
SELECT COUNT(*) FROM "Student";

-- 레코드 많이 생성한 학생 Top 5
SELECT s.email, s.subdomain, COUNT(r.id) as cnt
FROM "Student" s
LEFT JOIN "DnsRecord" r ON r."studentId" = s.id
GROUP BY s.id ORDER BY cnt DESC LIMIT 5;

-- 만료된 레이트리밋 로그 수
SELECT COUNT(*) FROM "RateLimitLog" WHERE "expiresAt" < NOW();

-- 추가 서브도메인 현황
SELECT s.email, o.subdomain, o."createdAt"
FROM "OwnedSubdomain" o
JOIN "Student" s ON s.id = o."studentId"
ORDER BY o."createdAt" DESC;
```

---

### 업데이트 (코드 변경 시)

```bash
docker compose build api
docker compose up -d api
```

---

## 11. 장애 대응 절차

### DB 연결 불가 (`/health` 503)

```bash
# DB 컨테이너 상태 확인
docker compose ps db
docker compose logs db --tail=50

# DB 재시작 시도
docker compose restart db
# 이후 api도 재시작 (DB 준비 후 연결 재시도)
docker compose restart api
```

---

### API 서버 무응답

```bash
# 프로세스 상태 확인
docker compose ps api
docker compose logs api --tail=50

# 강제 재시작
docker compose restart api
```

---

### 학생이 "API 키가 작동하지 않는다"고 할 때

```bash
# 1. 학생 계정 확인
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/students?page=1&limit=100" | jq '.students[] | select(.email == "alice@kaist.ac.kr")'

# 2. 계정 비활성화 여부 확인
# isActive: false → 활성화
curl -s -X PATCH \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"isActive": true}' \
  $BASE_URL/admin/students/<STUDENT_ID>

# 3. 키 폐기 여부 확인
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  "$BASE_URL/admin/students/<STUDENT_ID>/api-keys" | jq '.apiKeys[] | {prefix: .keyPrefix, active: .isActive}'

# 4. 활성 키가 없으면 재발급
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label": "재발급"}' \
  $BASE_URL/admin/students/<STUDENT_ID>/api-keys | jq '.apiKey'
```

---

### Cloudflare API 502 오류 빈발 시

CF API 장애이거나 요청 한도 초과 가능성:

```bash
# 최근 CF 오류 로그 확인
docker compose logs api 2>&1 | grep "CLOUDFLARE_ERROR"

# Cloudflare 상태 확인
curl -s https://www.cloudflarestatus.com/api/v2/status.json | jq '.status.description'
```

CF 한도 초과(free: 1200회/5분)가 의심되면 잠시 학생 요청을 차단하거나 CF 대시보드에서 사용량 확인.

---

### 로그에서 특정 요청 추적

학생이 오류 신고 시 `X-Request-Id` 헤더 값을 받아 로그에서 검색:

```bash
docker compose logs api 2>&1 | grep "rid=<REQUEST_ID>"
```

---

## 12. Cloudflare Free Tier 운영 주의사항

| 항목 | 제약 | 운영 시 주의 |
|---|---|---|
| DNS API 요청 한도 | 1,200회 / 5분 (Zone 전체) | 학생 100명 × 10회/min = 1,000회/min → **주의** |
| DNS 레코드 수 | 무제한 | — |
| 지원 타입 | A, AAAA, CNAME, TXT (API는 이 4가지만 허용) | MX, SRV 등 불가 |
| proxied 지원 타입 | A, AAAA, CNAME | TXT는 proxied 불가 |
| TXT 길이 | 255자 | 초과 시 API가 미리 거부 |
| SLA | 없음 | CF 장애 시 DNS 변경 불가 |

### Cloudflare API 한도 계산

- 학생 레이트리밋: 쓰기 10회/min, 전체 30회/min
- API 호출당 CF 요청 1회 (생성/수정/삭제)
- 학생 100명 동시 쓰기: 최대 100 × 10 = 1,000 CF 요청/min → 한도 내
- 학생 200명 동시 쓰기: 2,000 CF 요청/min → **초과 가능**

캠프 참가자가 200명 이상이면 학생별 쓰기 레이트리밋을 낮추는 것을 고려하세요.

---

## 13. 보안 체크리스트

### 배포 전 필수 확인

- [ ] `ADMIN_API_KEY`가 충분히 강한지 확인 (`openssl rand -hex 32` 이상 권장)
- [ ] `POSTGRES_PASSWORD`가 20자 이상 랜덤값인지 확인
- [ ] `CLOUDFLARE_API_TOKEN`이 "DNS Edit" 권한만 있는지 확인 (Zone 범위 제한)
- [ ] `.env` 파일이 Git에 커밋되지 않았는지 확인 (`.gitignore` 포함)
- [ ] `docker-compose.yml`에서 DB 포트(5432)가 외부 미노출인지 확인
- [ ] 앞단(nginx/CF)에서 HTTPS 강제 적용 확인
- [ ] nginx에 `client_max_body_size 64k` 설정 확인

### 운영 중 정기 확인

- [ ] `docker compose logs api | grep "[fatal]"` — 치명적 오류 없는지
- [ ] `/health` 엔드포인트 정상 응답 확인
- [ ] 감사 로그에서 비정상적인 대량 요청 여부 확인
- [ ] 만료된 레이트리밋 로그가 자동 정리되고 있는지 확인

### 사고 발생 시

1. `ADMIN_API_KEY` 유출 → `.env`에서 즉시 교체 후 컨테이너 재시작
2. `CLOUDFLARE_API_TOKEN` 유출 → CF 대시보드에서 즉시 토큰 폐기 + 새 토큰 생성
3. DB 데이터 유출 의심 → 모든 학생 API 키 일괄 폐기 후 재발급

```bash
# 비상: 모든 학생 계정 비활성화 (서비스 중단)
docker compose exec db psql -U dnsapi -d dnsapi \
  -c 'UPDATE "Student" SET "isActive" = false;'
```

---

## 14. 전체 API 엔드포인트 목록

### 공개 엔드포인트 (인증 불필요)

| Method | Path | 설명 |
|---|---|---|
| GET | `/health` | 헬스 체크 |

### 학생 엔드포인트 (Bearer 학생 API 키)

| Method | Path | 설명 |
|---|---|---|
| GET | `/v1/me` | 내 계정 정보 |
| GET | `/v1/subdomains` | 내 서브도메인 목록 |
| POST | `/v1/subdomains` | 추가 서브도메인 신청 |
| DELETE | `/v1/subdomains/:id` | 추가 서브도메인 반납 |
| GET | `/v1/records` | 내 DNS 레코드 목록 |
| GET | `/v1/records/:id` | DNS 레코드 단건 조회 |
| POST | `/v1/records` | DNS 레코드 생성 |
| PATCH | `/v1/records/:id` | DNS 레코드 수정 |
| DELETE | `/v1/records/:id` | DNS 레코드 삭제 |

### 관리자 엔드포인트 (Bearer ADMIN_API_KEY)

| Method | Path | 설명 |
|---|---|---|
| POST | `/admin/students` | 학생 생성 |
| POST | `/admin/students/bulk` | 학생 대량 생성 |
| GET | `/admin/students` | 학생 목록 (`page`, `limit`) |
| GET | `/admin/students/:id` | 학생 단건 조회 |
| PATCH | `/admin/students/:id` | 학생 정보 수정 |
| GET | `/admin/students/:id/api-keys` | 학생 API 키 목록 |
| POST | `/admin/students/:id/api-keys` | 새 API 키 발급 |
| POST | `/admin/students/:id/rotate-key` | 키 교체 (구키 폐기 + 신키 발급) |
| DELETE | `/admin/students/:id/api-keys/:keyId` | 특정 API 키 폐기 |
| GET | `/admin/records` | 전체 레코드 조회 (`studentId`, `page`, `limit`) |
| DELETE | `/admin/records/:id` | 레코드 강제 삭제 |
| GET | `/admin/audit-logs` | 감사 로그 (`studentId`, `action`, `after`, `before`, `page`, `limit`) |
| POST | `/admin/test-keys` | 테스트 계정 생성 (`count`, `recordLimit`) |

---

*시스템 문의나 긴급 장애 시 운영진 채널로 연락하세요.*
