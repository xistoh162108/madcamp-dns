# DNS 셀프서비스 API — 참가생 사용 가이드

> 이 API를 사용하면 Cloudflare에 직접 접속하지 않고도 여러분의 서브도메인 아래에 DNS 레코드를 자유롭게 만들고, 수정하고, 삭제할 수 있습니다. 또한, 추가 서브도메인을 직접 신청하고 반납할 수 있으며, VM에서 돌아가는 로컬 서버를 **터널(Tunnel)** 기능으로 외부에 공개할 수 있습니다.

---

## 목차

1. [기본 개념](#1-기본-개념)
2. [API 키 발급 받기](#2-api-키-발급-받기)
3. [인증 방법](#3-인증-방법)
4. [내 계정 정보 확인](#4-내-계정-정보-확인)
5. [서브도메인 관리](#5-서브도메인-관리)
   - 5-1. [서브도메인 목록 조회](#5-1-서브도메인-목록-조회)
   - 5-2. [추가 서브도메인 신청](#5-2-추가-서브도메인-신청)
   - 5-3. [추가 서브도메인 반납](#5-3-추가-서브도메인-반납)
6. [DNS 레코드 관리](#6-dns-레코드-관리)
   - 6-1. [레코드 목록 조회](#6-1-레코드-목록-조회)
   - 6-2. [레코드 단건 조회](#6-2-레코드-단건-조회)
   - 6-3. [레코드 생성](#6-3-레코드-생성)
   - 6-4. [레코드 수정](#6-4-레코드-수정)
   - 6-5. [레코드 삭제](#6-5-레코드-삭제)
7. [터널(Tunnel)로 로컬 서버 공개하기](#7-터널tunnel로-로컬-서버-공개하기)
   - 7-1. [터널이 뭔가요?](#7-1-터널이-뭔가요)
   - 7-2. [터널 만들고 cloudflared 설치하기](#7-2-터널-만들고-cloudflared-설치하기)
   - 7-3. [내 터널 상태 확인](#7-3-내-터널-상태-확인)
   - 7-4. [설치 명령어 다시 받기](#7-4-설치-명령어-다시-받기)
   - 7-5. [호스트네임(포트) 추가](#7-5-호스트네임포트-추가)
   - 7-6. [호스트네임 삭제](#7-6-호스트네임-삭제)
   - 7-7. [포트/이름 제약](#7-7-포트이름-제약)
   - 7-8. [지원하는 통신 프로토콜 (자세히)](#7-8-지원하는-통신-프로토콜-자세히)
   - 7-9. [ngrok 등 다른 터널 서비스와의 차이](#7-9-ngrok-등-다른-터널-서비스와의-차이)
8. [레코드 타입 설명](#8-레코드-타입-설명)
9. [Cloudflare Free Tier 제약](#9-cloudflare-free-tier-제약)
10. [오류 코드 전체 목록](#10-오류-코드-전체-목록)
11. [요청 제한 (Rate Limit)](#11-요청-제한-rate-limit)
12. [실전 예시 코드](#12-실전-예시-코드)
13. [자주 묻는 질문 (FAQ)](#13-자주-묻는-질문-faq)

---

## 1. 기본 개념

### 도메인 구조

관리자가 여러분에게 **기본 서브도메인** 하나를 처음에 할당합니다. 예를 들어:

```
alice.madcamp-kaist.org        ← 기본 서브도메인 (관리자 할당)
myproject.madcamp-kaist.org    ← 추가 서브도메인 (직접 신청 가능)
```

DNS 레코드를 만들 때 입력하는 **이름(name)** 은 서브도메인 기준 **상대 경로**입니다.

| 서브도메인 | 입력한 name | 실제 DNS 이름 (FQDN) |
|---|---|---|
| alice (기본) | `www` | `www.alice.madcamp-kaist.org` |
| alice (기본) | `api` | `api.alice.madcamp-kaist.org` |
| myproject (추가) | `www` | `www.myproject.madcamp-kaist.org` |

> **이름 최대 깊이**: `a.b.c` 형식의 3단계까지 가능합니다.

### API 기본 URL

```
https://dns.madcamp-kaist.org
```

| 엔드포인트 | 전체 URL |
|---|---|
| 내 정보 | `https://dns.madcamp-kaist.org/v1/me` |
| 서브도메인 목록 | `https://dns.madcamp-kaist.org/v1/subdomains` |
| DNS 레코드 목록 | `https://dns.madcamp-kaist.org/v1/records` |
| DNS 레코드 생성 | `https://dns.madcamp-kaist.org/v1/records` |
| DNS 레코드 수정 | `https://dns.madcamp-kaist.org/v1/records/:id` |
| DNS 레코드 삭제 | `https://dns.madcamp-kaist.org/v1/records/:id` |
| 터널 생성/조회 | `https://dns.madcamp-kaist.org/v1/tunnels` |
| 터널 호스트네임 추가 | `https://dns.madcamp-kaist.org/v1/tunnels/hostnames` |
| 터널 호스트네임 삭제 | `https://dns.madcamp-kaist.org/v1/tunnels/hostnames/:id` |

```bash
# 터미널 환경변수로 설정해두면 편합니다
export API_KEY="여기에_발급받은_키"
export BASE_URL="https://dns.madcamp-kaist.org"
```

---

## 2. API 키 발급 받기

API 키는 관리자가 발급해 줍니다. 발급받은 키는 다음과 같이 생겼습니다:

```
dns_a1b2c3d4e5f6...
```

> **중요**: API 키는 최초 발급 시 한 번만 보여집니다. 반드시 안전한 곳에 저장하세요.
> 분실한 경우 관리자에게 재발급을 요청하세요.

---

## 3. 인증 방법

모든 API 요청에는 `Authorization` 헤더가 필요합니다:

```
Authorization: Bearer <API 키>
```

예시:

```bash
curl -H "Authorization: Bearer dns_a1b2c3d4e5f6..." \
     https://dns.madcamp-kaist.org/v1/me
```

---

## 4. 내 계정 정보 확인

```
GET /v1/me
```

내 이메일, 기본 서브도메인, 레코드 한도를 확인합니다.

### 요청 예시

```bash
curl -s \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/me
```

### 응답 예시 (200 OK)

```json
{
  "student": {
    "id": "clyxxx...",
    "email": "alice@example.com",
    "subdomain": "alice.madcamp-kaist.org",
    "recordLimit": 10,
    "isActive": true,
    "createdAt": "2026-06-25T09:00:00.000Z"
  }
}
```

---

## 5. 서브도메인 관리

### 5-1. 서브도메인 목록 조회

```
GET /v1/subdomains
```

기본 서브도메인 + 내가 신청한 추가 서브도메인 목록을 반환합니다.

```bash
curl -s \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/subdomains
```

#### 응답 예시 (200 OK)

```json
{
  "primary": {
    "subdomain": "alice",
    "fqdn": "alice.madcamp-kaist.org"
  },
  "additional": [
    {
      "id": "sub_abc123",
      "subdomain": "myproject",
      "fqdn": "myproject.madcamp-kaist.org",
      "createdAt": "2026-06-25T11:00:00.000Z"
    }
  ],
  "additionalUsed": 1,
  "additionalLimit": 5
}
```

---

### 5-2. 추가 서브도메인 신청

```
POST /v1/subdomains
Content-Type: application/json
```

원하는 서브도메인을 신청합니다. 아무도 사용 중이지 않고, 예약어가 아니면 즉시 할당됩니다.

#### 요청 필드

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `subdomain` | string | 필수 | 원하는 서브도메인 이름 (소문자 영문, 숫자, 하이픈) |

#### 서브도메인 이름 규칙

- 소문자 영문(`a-z`), 숫자(`0-9`), 하이픈(`-`)만 허용
- 1~32자
- 하이픈으로 시작하거나 끝날 수 없음
- `www`, `mail`, `smtp`, `ns`, `ns1`, `admin`, `ftp`, `dns` 등 예약어 불가
- 이미 다른 학생이 사용 중인 이름 불가

#### 요청 예시

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subdomain": "myproject"}' \
  $BASE_URL/v1/subdomains
```

#### 응답 예시 (201 Created)

```json
{
  "subdomain": {
    "id": "sub_abc123",
    "subdomain": "myproject",
    "fqdn": "myproject.madcamp-kaist.org",
    "createdAt": "2026-06-25T11:00:00.000Z"
  }
}
```

> **한도**: 기본 서브도메인 외에 추가로 최대 **5개**까지 신청 가능합니다.

---

### 5-3. 추가 서브도메인 반납

```
DELETE /v1/subdomains/:id
```

더 이상 필요 없는 추가 서브도메인을 반납합니다.

> **주의**: 해당 서브도메인 아래 DNS 레코드가 남아있으면 반납이 거부됩니다. 먼저 레코드를 모두 삭제하세요.

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/subdomains/sub_abc123
```

#### 응답 예시 (200 OK)

```json
{ "success": true }
```

---

## 6. DNS 레코드 관리

### 6-1. 레코드 목록 조회

```
GET /v1/records
```

내 모든 DNS 레코드를 조회합니다 (기본 서브도메인 + 추가 서브도메인 아래 레코드 모두).

```bash
curl -s \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/records
```

#### 응답 예시 (200 OK)

```json
{
  "records": [
    {
      "id": "rec_abc123",
      "name": "www",
      "fqdn": "www.alice.madcamp-kaist.org",
      "type": "A",
      "content": "1.2.3.4",
      "ttl": 300,
      "proxied": false,
      "createdAt": "2026-06-25T10:00:00.000Z",
      "updatedAt": "2026-06-25T10:00:00.000Z"
    },
    {
      "id": "rec_def456",
      "name": "api",
      "fqdn": "api.myproject.madcamp-kaist.org",
      "type": "A",
      "content": "5.6.7.8",
      "ttl": 60,
      "proxied": false,
      "createdAt": "2026-06-25T11:30:00.000Z",
      "updatedAt": "2026-06-25T11:30:00.000Z"
    }
  ]
}
```

---

### 6-2. 레코드 단건 조회

```
GET /v1/records/:id
```

```bash
curl -s \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/records/rec_abc123
```

---

### 6-3. 레코드 생성

```
POST /v1/records
Content-Type: application/json
```

#### 요청 필드

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `name` | string | 필수 | | 레코드 이름 (서브도메인 기준 상대 경로) |
| `type` | string | 필수 | | `A`, `AAAA`, `CNAME`, `TXT` 중 하나 |
| `content` | string | 필수 | | 레코드 값 |
| `ttl` | number | 선택 | `1` | TTL(초). `1`(자동), `60`, `120`, `300`, `600`, `1800`, `3600`, `86400` |
| `proxied` | boolean | 선택 | `false` | Cloudflare 프록시 여부 |
| `subdomain` | string | 선택 | 기본 서브도메인 | 레코드를 생성할 서브도메인 (추가 서브도메인에 생성 시) |

#### 기본 서브도메인 아래에 생성 (subdomain 생략)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "www", "type": "A", "content": "1.2.3.4"}' \
  $BASE_URL/v1/records
# → www.alice.madcamp-kaist.org
```

#### 추가 서브도메인 아래에 생성 (subdomain 명시)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "api", "type": "A", "content": "5.6.7.8", "subdomain": "myproject"}' \
  $BASE_URL/v1/records
# → api.myproject.madcamp-kaist.org
```

#### CNAME 예시 (GitHub Pages 연결)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "blog", "type": "CNAME", "content": "myid.github.io"}' \
  $BASE_URL/v1/records
```

#### TXT 예시 (도메인 인증)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "verify", "type": "TXT", "content": "google-site-verification=abc123"}' \
  $BASE_URL/v1/records
```

#### 응답 예시 (201 Created)

```json
{
  "record": {
    "id": "rec_abc123",
    "name": "www",
    "fqdn": "www.alice.madcamp-kaist.org",
    "type": "A",
    "content": "1.2.3.4",
    "ttl": 1,
    "proxied": false,
    "createdAt": "2026-06-25T10:00:00.000Z",
    "updatedAt": "2026-06-25T10:00:00.000Z"
  }
}
```

#### 이름(name) 규칙

| 규칙 | 허용 예 | 불허 예 |
|---|---|---|
| 소문자 영문, 숫자, 하이픈 | `www`, `api-v2`, `dev` | `MY-APP`, `내이름` |
| 점(`.`)으로 최대 3단계 | `v1.api.service` | `a.b.c.d` |
| **`@` = 서브도메인 자체에 직접 바인딩** | `@` | |
| 빈 문자열 불가 | | `""` |
| 와일드카드, 언더스코어 불가 | | `*.service`, `_acme` |
| `www`, `mail`, `ftp` 등 예약어 불가 | | `admin`, `root` |

> **`@` 사용 예시**: `name: "@"` 으로 레코드를 만들면 `alice.madcamp-kaist.org` 자체에 IP가 바인딩됩니다.

#### 서브도메인 자체(apex)에 IP 바인딩 (`@`)

```bash
# alice.madcamp-kaist.org 자체를 1.2.3.4로 지정
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "@", "type": "A", "content": "1.2.3.4"}' \
  https://dns.madcamp-kaist.org/v1/records

# 추가 서브도메인 자체에도 동일하게 적용 가능
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "@", "type": "A", "content": "5.6.7.8", "subdomain": "myproject"}' \
  https://dns.madcamp-kaist.org/v1/records
# → myproject.madcamp-kaist.org = 5.6.7.8
```

---

### 6-4. 레코드 수정

```
PATCH /v1/records/:id
Content-Type: application/json
```

원하는 필드만 보내면 됩니다. `type`은 변경 불가 (삭제 후 재생성 필요).

```bash
# content만 변경
curl -s -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "5.6.7.8"}' \
  $BASE_URL/v1/records/rec_abc123

# TTL과 content 동시 변경
curl -s -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "5.6.7.8", "ttl": 60}' \
  $BASE_URL/v1/records/rec_abc123
```

---

### 6-5. 레코드 삭제

```
DELETE /v1/records/:id
```

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/records/rec_abc123
```

응답: `{ "success": true }`

---

## 7. 터널(Tunnel)로 로컬 서버 공개하기

### 7-1. 터널이 뭔가요?

캠프 VM은 **KCLOUD 내부망**에 있어서, VPN에 연결되지 않은 일반 인터넷 방문자는 애초에 VM에 접근할 수 없습니다 (VPN·방화벽 관련 자세한 내용은 별도 KCLOUD 가이드를 참고하세요). 그래서 지금까지의 A 레코드처럼 "내 VM의 IP"를 직접 DNS에 등록하는 방식으로는, 인터넷에 있는 아무나가 여러분의 프로젝트에 접속하게 만들 수 없습니다.

터널은 이 문제를 해결합니다. VM 안에서 `cloudflared`라는 프로그램을 한 번 설치해서 실행하면, 그 프로그램이 Cloudflare로 **아웃바운드 연결을 직접** 엽니다. 이후 외부에서 `team01.madcamp-kaist.org` 같은 주소로 들어오는 요청은 Cloudflare를 거쳐 이 연결을 타고 여러분의 VM 안 로컬 포트(예: `localhost:3000`)로 전달됩니다.

```
브라우저 → Cloudflare → (VM이 미리 열어둔 아웃바운드 연결) → VM의 localhost:포트
```

정리하면:

| 방식 | 언제 사용 | 특징 |
|---|---|---|
| DNS 레코드 (A/AAAA/CNAME/TXT) | 외부에서 접속 가능한 고정 IP나 서비스가 있을 때 | 직접 IP/호스트를 지정 |
| **터널(Tunnel)** | VM에서 돌아가는 로컬 서버를 그냥 공개하고 싶을 때 | IP 필요 없음, `cloudflared` 설치만 하면 됨 |

**같은 이름(fqdn)에는 DNS 레코드와 터널 호스트네임을 동시에 만들 수 없습니다** — 서브도메인 하나(예: `team01`) 아래에서도 `www.team01`은 일반 A 레코드로, `api.team01`은 터널로, 이런 식으로 **이름별로는 자유롭게 섞어 쓸 수 있습니다.**

> **레코드 한도 공유**: `recordLimit`은 DNS 레코드와 터널 호스트네임을 **합산**한 개수입니다. `GET /v1/me`로 확인하는 한도 안에서 둘을 자유롭게 나눠 쓰면 됩니다.

---

### 7-2. 터널 만들고 cloudflared 설치하기

```
POST /v1/tunnels
```

내 계정에 터널이 없으면 새로 만들고, 있으면 기존 터널 정보를 반환합니다. **설치 명령어(install command)는 이 요청에서만 보여줍니다** — 아무 때나 다시 보고 싶으면 [7-4](#7-4-설치-명령어-다시-받기)를 사용하세요.

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/tunnels
```

#### 응답 예시 (200 OK)

```json
{
  "tunnel": { "id": "tun_abc123", "name": "alice-tunnel" },
  "installCommand": "sudo cloudflared service install eyJhIjoiYWJjMTIz..."
}
```

**VM에서 딱 한 번만** 아래 명령어를 실행하세요 (`installCommand` 값 그대로 복사):

```bash
sudo cloudflared service install eyJhIjoiYWJjMTIz...
```

설치가 끝나면 `cloudflared`가 백그라운드 서비스로 등록되어 VM이 재부팅돼도 자동으로 다시 연결됩니다. **VM을 새로 만들거나 밀었다면** 이 명령어를 다시 실행해야 하며, 그럴 땐 [7-4](#7-4-설치-명령어-다시-받기)로 명령어만 다시 받으면 됩니다 (터널을 새로 만들 필요 없음).

---

### 7-3. 내 터널 상태 확인

```
GET /v1/tunnels
```

터널 존재 여부와 현재 등록된 호스트네임 목록을 보여줍니다. **보안을 위해 설치 명령어는 여기 포함되지 않습니다.**

```bash
curl -s -H "Authorization: Bearer $API_KEY" $BASE_URL/v1/tunnels
```

#### 응답 예시 (터널이 있는 경우)

```json
{
  "tunnel": {
    "exists": true,
    "id": "tun_abc123",
    "name": "alice-tunnel",
    "hostnames": [
      {
        "id": "th_xyz789",
        "name": "@",
        "fqdn": "alice.madcamp-kaist.org",
        "localPort": 3000,
        "protocol": "http",
        "createdAt": "2026-07-06T09:00:00.000Z",
        "updatedAt": "2026-07-06T09:00:00.000Z"
      }
    ]
  }
}
```

#### 응답 예시 (아직 터널을 만들지 않은 경우)

```json
{ "tunnel": { "exists": false } }
```

---

### 7-4. 설치 명령어 다시 받기

```
GET /v1/tunnels/token
```

VM을 새로 만들었거나 `cloudflared`를 다시 설치해야 할 때, 기존 터널을 그대로 유지한 채 설치 명령어만 다시 받습니다.

```bash
curl -s -H "Authorization: Bearer $API_KEY" $BASE_URL/v1/tunnels/token
```

#### 응답 예시 (200 OK)

```json
{ "installCommand": "sudo cloudflared service install eyJhIjoiYWJjMTIz..." }
```

> 터널을 아직 만들지 않았다면 404가 반환됩니다 — 먼저 [`POST /v1/tunnels`](#7-2-터널-만들고-cloudflared-설치하기)를 호출하세요.

---

### 7-5. 호스트네임(포트) 추가

```
POST /v1/tunnels/hostnames
Content-Type: application/json
```

VM의 로컬 포트 하나를 외부에서 접속 가능한 이름 하나에 연결합니다. 터널이 없으면 자동으로 먼저 생성됩니다.

#### 요청 필드

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `subdomain` | string | 필수 | | 이 호스트네임을 걸어둘 서브도메인 (기본 서브도메인 또는 소유한 추가 서브도메인) |
| `name` | string | 선택 | `"@"` | 서브도메인 기준 상대 경로 (DNS 레코드의 `name`과 동일한 규칙) |
| `localPort` | number | 필수 | | VM에서 실제로 서비스가 떠 있는 포트 |

#### 서브도메인 자체를 공개 (name 생략 → `@`)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subdomain": "alice", "localPort": 3000}' \
  $BASE_URL/v1/tunnels/hostnames
# → alice.madcamp-kaist.org 가 VM의 localhost:3000 으로 연결됨
```

#### 이름을 지정해서 여러 개 만들기 (프론트/백엔드 등 여러 서비스)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subdomain": "alice", "name": "api", "localPort": 8080}' \
  $BASE_URL/v1/tunnels/hostnames
# → api.alice.madcamp-kaist.org 가 VM의 localhost:8080 으로 연결됨
```

같은 서브도메인 아래에 `name`만 다르게 해서 여러 개의 호스트네임을 만들 수 있습니다 — 예를 들어 프론트엔드는 `@`(포트 3000), 백엔드는 `api`(포트 8080)로 각각 등록해두면 하나의 터널(하나의 `cloudflared` 설치)로 둘 다 서비스할 수 있습니다.

#### 응답 예시 (201 Created)

```json
{
  "hostname": {
    "id": "th_xyz789",
    "name": "@",
    "fqdn": "alice.madcamp-kaist.org",
    "localPort": 3000,
    "protocol": "http",
    "createdAt": "2026-07-06T09:00:00.000Z",
    "updatedAt": "2026-07-06T09:00:00.000Z"
  }
}
```

만든 직후 바로 안 될 수 있습니다 — VM에서 `cloudflared` 서비스가 정상적으로 연결되어 있는지, 그리고 해당 포트에서 서버가 실제로 떠 있는지 확인하세요.

---

### 7-6. 호스트네임 삭제

```
DELETE /v1/tunnels/hostnames/:id
```

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/tunnels/hostnames/th_xyz789
```

#### 응답 예시 (200 OK)

```json
{ "success": true, "cloudflareCleanup": { "ingressUpdated": true, "dnsRecordDeleted": true } }
```

`cloudflareCleanup`은 참고용 정보입니다 — `false`가 보이더라도 호스트네임 자체는 이미 삭제된 상태이니 다시 삭제를 시도할 필요는 없습니다. 계속 `false`가 보이면 운영진에게 문의하세요.

> **서브도메인 반납 시 주의**: 해당 서브도메인 아래 터널 호스트네임이 남아있으면 `DELETE /v1/subdomains/:id` 반납이 거부됩니다. DNS 레코드와 마찬가지로 먼저 지워야 합니다.

---

### 7-7. 포트/이름 제약

| 항목 | 규칙 |
|---|---|
| `localPort` 범위 | **1024 ~ 65535** (그 이하 포트는 사용 불가) |
| 차단되는 포트 | 22(SSH), 3306(MySQL), 5432(PostgreSQL), 6379(Redis), 27017(MongoDB), 9200(Elasticsearch) 등 인프라/DB용 포트 |
| 연결 대상 | 항상 VM의 `localhost`(127.0.0.1)만 가능 — 다른 IP나 다른 VM은 지정 불가 |
| 프로토콜 | 현재는 `http`만 지원 |
| `name` 규칙 | DNS 레코드의 [이름(name) 규칙](#이름name-규칙)과 동일 (예약어 불가, 최대 3단계 등) |

> 포트 제한은 실수로 DB나 SSH 같은 서비스를 그대로 노출하는 사고를 막기 위한 안전장치입니다. 위 목록에 없는 포트라도 민감한 서비스(관리자 페이지 등)를 올릴 때는 자체적으로 인증을 꼭 걸어두세요 — 터널로 연결하는 순간 그 포트는 인터넷에 공개된다는 뜻입니다.

---

### 7-8. 지원하는 통신 프로토콜 (자세히)

이 터널 기능은 Cloudflare Tunnel의 **HTTP 기반 ingress**만 사용하도록 만들어져 있습니다 (내부적으로 항상 `http://127.0.0.1:포트` 형태로 연결합니다). Cloudflare Tunnel 자체는 순수 TCP·SSH·RDP 등 다른 ingress 방식도 지원하지만, **이 API는 그중 HTTP 방식 하나만 사용합니다.** 그래서 어떤 통신이 되고 안 되는지는 "HTTP(S)로 시작하는 연결인가"가 기준입니다.

**되는 것 (TCP 기반, HTTP로 시작하는 통신)**

| 프로토콜 / 기술 | 가능 여부 | 설명 |
|---|---|---|
| HTTP / HTTPS (REST API 등) | ✅ | 기본으로 지원 |
| WebSocket (`ws://`, `wss://`) | ✅ | HTTP Upgrade로 시작하는 연결이라 프록시를 그대로 통과합니다 |
| Socket.IO | ✅ | 내부적으로 WebSocket 또는 HTTP 롱폴링을 쓰는데 둘 다 통과됩니다 |
| Server-Sent Events (SSE) | ✅ | 오래 유지되는 HTTP 응답 스트림이라 문제 없습니다 |
| WebRTC **시그널링**(연결 협상 단계) | ✅ | 보통 HTTP나 WebSocket으로 이루어지므로 통과됩니다 |

**안 되는 것**

| 프로토콜 / 기술 | 가능 여부 | 이유 |
|---|---|---|
| 순수 TCP (직접 만든 바이너리 프로토콜, DB 와이어 프로토콜 등) | ❌ | Cloudflare Tunnel 자체는 TCP ingress도 지원하지만, 이 API는 HTTP ingress만 만들도록 되어 있어 지금은 노출할 수 없습니다 |
| **UDP 기반 모든 통신** | ❌ | Cloudflare Tunnel은 애초에 UDP를 터널링하지 않습니다. (방문자↔Cloudflare 구간에서 QUIC/HTTP3를 쓰는 것과는 별개 얘기이며, VM 쪽 서비스에는 영향이 없습니다) |
| WebRTC **미디어/데이터 채널** (영상·음성·화면공유·RTCDataChannel) | ❌ | ICE/DTLS-SRTP 등 UDP 기반이고, 애초에 이런 트래픽은 터널이 아니라 P2P나 별도 TURN 서버를 통해 흐릅니다 — 시그널링이 이 터널로 잘 되더라도 미디어 자체는 이 경로를 타지 않습니다 |
| gRPC (HTTP/2) | ⚠️ 확인 필요 | 이 API가 origin과의 HTTP/2 전용 설정을 별도로 켜두지 않으므로 정상 동작을 보장하지 않습니다 |

> 정리하면: **평범한 웹 서버 / REST API / 실시간 채팅(WebSocket) 서비스는 문제없이 됩니다.** 게임 서버, 화상회의 미디어 서버, 커스텀 TCP·UDP 프로토콜을 쓰는 서비스는 이 터널로는 외부에 공개할 수 없습니다.

---

### 7-9. ngrok 등 다른 터널 서비스와의 차이

6장에서 다뤘듯, 원하는 외부 호스트를 가리키는 CNAME 레코드는 지금도 자유롭게 만들 수 있습니다. 그래서 "ngrok 같은 서비스로 터널을 열고, 그 주소를 CNAME으로 연결"하는 것도 기술적으로는 가능합니다. 하지만 이 API의 터널 기능과는 중요한 차이가 있습니다.

| 항목 | 이 API의 터널(Tunnel) 기능 | ngrok 등 + 수동 CNAME |
|---|---|---|
| 별도 가입 | 불필요 (같은 API 키 사용) | ngrok 등 제3자 서비스에 별도 가입 필요 |
| DNS 레코드 생성 | 자동 (CNAME + ingress 설정을 API가 관리) | 직접 CNAME 레코드를 만들어야 함 |
| HTTPS 인증서 | Cloudflare가 `team01.madcamp-kaist.org`용 정상 인증서를 발급 | 문제가 생기기 쉬움 — 아래 설명 참고 |
| 포트 / 보안 가드레일 | 있음 (1024번 이상만, DB/SSH 포트 차단, `localhost`만 허용) | 없음 — ngrok 쪽에서 실제로 뭘 노출하든 우리 쪽에서 통제 불가 |
| 운영진 가시성 | `/admin/tunnels`로 전체 조회·강제 삭제 가능 | 우리 서버 입장에선 그냥 CNAME 레코드 하나 — 실제로 뭘 서비스하는지 알 수 없음 |
| 비용 | Cloudflare Tunnel 자체는 무료 | 무료 티어에 세션 시간·대역폭 제한이 있는 경우가 많음 |

**실제로 가장 자주 걸리는 문제 — 인증서/Host 불일치**: ngrok 같은 서비스의 무료 플랜은 보통 원하는 커스텀 도메인에 자체 인증서를 발급해주지 않습니다. `team01.madcamp-kaist.org`를 ngrok 주소로 CNAME만 걸어두면:
- Cloudflare 프록시(`proxied: true`)를 켜지 않은 경우, 브라우저가 `team01.madcamp-kaist.org`로 접속했을 때 ngrok 서버가 내려주는 인증서는 ngrok 자신의 도메인용이라 **인증서 불일치 경고**가 뜹니다.
- Cloudflare 프록시를 켜면 인증서 문제는 Cloudflare가 대신 해결해주지만, 이번엔 ngrok 무료 플랜 쪽에서 **자신의 도메인이 아닌 Host 헤더로 오는 요청을 거부**하는 경우가 흔해서 아예 연결이 안 될 수 있습니다. (ngrok 유료 커스텀 도메인 기능을 쓰면 해결되지만, 그럼 굳이 CNAME으로 우회할 이유가 없어집니다.)

**권장 사항**

- **VM에서 직접 띄운 서버를 외부에 공개하고 싶다면 → 이 API의 터널 기능을 쓰세요.** 위 표의 문제들이 애초에 발생하지 않습니다.
- **Vercel / Netlify / GitHub Pages처럼 이미 공인 도메인으로 서비스되는 곳에 연결하고 싶다면 → 기존 CNAME 레코드(6장)를 그대로 쓰세요.** 이런 서비스들은 보통 커스텀 도메인 + 인증서 발급을 정식으로 지원합니다.
- ngrok 등 제3자 터널 서비스는 **이 API의 터널 기능이 지원하지 않는 상황(순수 TCP, UDP 등)이거나 특별한 사정이 있을 때만** 최후의 수단으로 고려하세요. 그마저도 인증서·Host 헤더 문제는 직접 해결해야 합니다.

---

## 8. 레코드 타입 설명

### A 레코드 — IPv4 주소

```
www.alice.example.com → 1.2.3.4
```
서버 IP를 직접 가리킬 때 사용합니다.

### AAAA 레코드 — IPv6 주소

```
www.alice.example.com → 2001:db8::1
```

### CNAME 레코드 — 별칭

```
blog.alice.example.com → myid.github.io
```
GitHub Pages, Vercel, Netlify 등 외부 서비스 연결 시 사용합니다.
> **주의**: CNAME은 같은 이름에 A/AAAA와 공존 불가입니다.

### TXT 레코드 — 텍스트 (최대 255자)

```
verify.alice.example.com → "google-site-verification=abc..."
```
도메인 소유권 인증, 서비스 설정값 등에 사용합니다.

---

## 9. Cloudflare Free Tier 제약

이 서비스는 Cloudflare 무료 플랜을 사용합니다. 다음 제약을 알고 계세요:

| 항목 | 제약 | 비고 |
|---|---|---|
| 지원 레코드 타입 | A, AAAA, CNAME, TXT만 지원 | MX, SRV, CAA 등 불가 |
| TXT 레코드 최대 길이 | **255자** | 초과 시 API 거부 |
| Cloudflare API 요청 한도 | 1,200회 / 5분 | 전체 캠프 공유 한도 |
| proxied 지원 타입 | A, AAAA, CNAME만 가능 | TXT는 proxied 불가 |
| DNS 전파 시간 | TTL에 따라 최대 수 분 | TTL 1(자동) ≈ 300초 |
| 무료 플랜 SLA | 없음 | 장애 시 즉각 복구 보장 없음 |

### `proxied: true` 란?

Cloudflare 리버스 프록시를 통해 트래픽이 전달됩니다:
- 실제 서버 IP가 외부에 숨겨집니다
- Cloudflare DDoS 보호 및 CDN 캐싱 혜택
- A/AAAA/CNAME 타입에서만 동작합니다 (TXT는 무시됨)

### TTL 권장값

| 상황 | 권장 TTL |
|---|---|
| 개발/테스트 중 (자주 변경) | `60` (1분) 또는 `1` (자동) |
| 서비스 안정화 후 | `300` (5분) |
| 거의 변경 안 함 | `3600` (1시간) 이상 |

---

## 10. 오류 코드 전체 목록

오류 응답 형식:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "사람이 읽을 수 있는 설명",
    "details": { ... }
  }
}
```

| HTTP | code | 의미 | 해결 방법 |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | 요청 형식 오류 | `details` 확인 후 수정 |
| 400 | `INVALID_RECORD_NAME` | 레코드 이름 규칙 위반 | [이름 규칙](#이름name-규칙) 참고 |
| 400 | `UNSUPPORTED_RECORD_TYPE` | 지원하지 않는 타입 | A, AAAA, CNAME, TXT 사용 |
| 400 | `INVALID_RECORD_CONTENT` | 레코드 값 형식 오류 | IP/호스트명 형식 확인 |
| 401 | `UNAUTHORIZED` | API 키 없거나 형식 오류 | `Authorization: Bearer <키>` 확인 |
| 401 | `API_KEY_REVOKED` | API 키 폐기됨 | 관리자에게 재발급 요청 |
| 403 | `STUDENT_DISABLED` | 계정 비활성화 | 관리자에게 문의 |
| 403 | `FORBIDDEN_RECORD` | 다른 사람 레코드 접근 | 내 레코드 ID만 사용 |
| 403 | `RECORD_LIMIT_EXCEEDED` | 레코드 한도 초과 | 불필요한 레코드 삭제 후 재시도 |
| 404 | `NOT_FOUND` | 레코드/서브도메인 없음 | ID 확인 |
| 409 | `DNS_RECORD_CONFLICT` | DNS 충돌 | 타입 간 충돌 규칙 확인 |
| 413 | `INVALID_REQUEST` | 요청 바디 64KB 초과 | 요청 크기 줄이기 |
| 429 | `RATE_LIMITED` | 요청 너무 많음 | `Retry-After` 헤더 값만큼 대기 |
| 502 | `CLOUDFLARE_ERROR` | Cloudflare API 오류 | 잠시 후 재시도 |
| 500 | `INTERNAL_ERROR` | 서버 내부 오류 | 관리자에게 문의 (x-request-id 첨부) |

---

## 11. 요청 제한 (Rate Limit)

| 구분 | 한도 | 기간 |
|---|---|---|
| 전체 요청 | 30회 | 1분 |
| 쓰기 요청 (POST/PATCH/DELETE) | 10회 | 1분 |

한도 초과 시 HTTP 429 응답과 함께 `Retry-After` 헤더가 옵니다:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Try again later.",
    "details": { "limit": 10, "windowSeconds": 60, "retryAfterSeconds": 45 }
  }
}
```

---

## 12. 실전 사용법 (curl / Postman)

### 환경변수 설정 (터미널)

한 번 설정해두면 이후 명령어를 짧게 쓸 수 있습니다:

```bash
export API_KEY="dns_여기에_발급받은_키"
export BASE_URL="https://dns.madcamp-kaist.org"
```

---

### curl 빠른 참고

```bash
# ── 내 정보 ──────────────────────────────────────────────
curl -s -H "Authorization: Bearer $API_KEY" $BASE_URL/v1/me | jq

# ── 서브도메인 ────────────────────────────────────────────
# 목록 조회
curl -s -H "Authorization: Bearer $API_KEY" $BASE_URL/v1/subdomains | jq

# 추가 신청
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subdomain": "myproject"}' \
  $BASE_URL/v1/subdomains | jq

# 반납 (레코드를 먼저 모두 삭제해야 함)
curl -s -X DELETE \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/subdomains/<ID> | jq

# ── DNS 레코드 ────────────────────────────────────────────
# 목록
curl -s -H "Authorization: Bearer $API_KEY" $BASE_URL/v1/records | jq

# 생성 — 기본 서브도메인 아래
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "www", "type": "A", "content": "1.2.3.4"}' \
  $BASE_URL/v1/records | jq

# 생성 — 추가 서브도메인 아래
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "api", "type": "A", "content": "1.2.3.4", "subdomain": "myproject"}' \
  $BASE_URL/v1/records | jq

# 수정 (content만 변경)
curl -s -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "5.6.7.8"}' \
  $BASE_URL/v1/records/<ID> | jq

# 삭제
curl -s -X DELETE \
  -H "Authorization: Bearer $API_KEY" \
  $BASE_URL/v1/records/<ID> | jq
```

> `| jq` 없이도 동작합니다. `jq`를 설치하면 JSON이 이쁘게 출력됩니다.

---

### Postman 사용법

#### 1. Authorization 설정

모든 요청에 API 키를 편하게 넣으려면 **Collection 또는 Environment** 변수를 사용하세요.

1. Postman에서 **New Collection** 생성
2. Collection 선택 → **Authorization** 탭
3. Type: `Bearer Token`
4. Token: `{{API_KEY}}` 입력
5. **Environment** 탭에서 `API_KEY` 변수에 발급받은 키 값 입력

이후 각 요청에서 Auth를 `Inherit from parent`로 설정하면 자동으로 키가 붙습니다.

#### 2. 자주 쓰는 요청 템플릿

| 이름 | Method | URL |
|---|---|---|
| 내 정보 | GET | `{{BASE_URL}}/v1/me` |
| 서브도메인 목록 | GET | `{{BASE_URL}}/v1/subdomains` |
| 서브도메인 신청 | POST | `{{BASE_URL}}/v1/subdomains` |
| 레코드 목록 | GET | `{{BASE_URL}}/v1/records` |
| 레코드 생성 | POST | `{{BASE_URL}}/v1/records` |
| 레코드 수정 | PATCH | `{{BASE_URL}}/v1/records/{{record_id}}` |
| 레코드 삭제 | DELETE | `{{BASE_URL}}/v1/records/{{record_id}}` |

#### 3. POST 요청 Body 설정

`Body` 탭 → `raw` → `JSON` 선택 후 아래처럼 입력:

```json
{
  "name": "www",
  "type": "A",
  "content": "1.2.3.4",
  "ttl": 300
}
```

추가 서브도메인 아래에 생성하려면 `subdomain` 필드 추가:

```json
{
  "name": "api",
  "type": "A",
  "content": "1.2.3.4",
  "subdomain": "myproject"
}
```

---

## 13. 자주 묻는 질문 (FAQ)

### Q. 추가 서브도메인이란 무엇인가요?

관리자가 처음 할당해 준 기본 서브도메인 외에, 여러분이 직접 `POST /v1/subdomains`로 신청할 수 있는 독립적인 서브도메인입니다. 예: 기본이 `alice.madcamp.com`이라면, `myproject.madcamp.com`, `backend.madcamp.com` 등을 추가로 신청할 수 있습니다.

---

### Q. 서브도메인 반납 시 DNS 레코드는 어떻게 되나요?

반납 전에 **직접 DNS 레코드를 삭제**해야 합니다. 레코드가 남아있으면 반납이 거부됩니다. 레코드를 삭제하면 Cloudflare에서도 즉시 제거됩니다. **터널 호스트네임이 남아있어도 마찬가지로 반납이 거부됩니다** — 먼저 지워야 합니다.

---

### Q. 터널을 만들었는데 브라우저로 접속이 안 돼요.

다음 순서로 확인하세요:

1. VM에서 `sudo systemctl status cloudflared` (또는 `cloudflared` 서비스 상태)로 정상 연결됐는지 확인
2. `localPort`로 지정한 포트에서 실제로 서버가 떠 있는지 (`curl localhost:포트`로 VM 안에서 직접 확인)
3. `GET /v1/tunnels`로 호스트네임이 정상 등록되어 있는지 확인
4. VM을 새로 만들었다면 `cloudflared`를 다시 설치해야 합니다 — [7-4](#7-4-설치-명령어-다시-받기)로 설치 명령어를 다시 받으세요

---

### Q. 터널로 화상채팅(WebRTC)이나 게임 서버를 공개할 수 있나요?

부분적으로만 가능합니다. WebRTC의 **연결 협상(시그널링)** 단계는 보통 HTTP/WebSocket이라 터널을 통과하지만, 실제 **영상·음성 데이터**는 UDP 기반이라 이 터널로는 흐르지 않습니다. 커스텀 TCP/UDP 프로토콜을 쓰는 게임 서버도 마찬가지로 이 터널로는 외부에 공개할 수 없습니다. 자세한 내용은 [7-8](#7-8-지원하는-통신-프로토콜-자세히)을 참고하세요.

---

### Q. DNS 레코드를 만들었는데 바로 작동하지 않아요.

DNS 전파에는 TTL 시간만큼 걸립니다. TTL 300이면 최대 5분 대기가 필요합니다.

확인 방법:
```bash
dig www.alice.madcamp-kaist.org A
nslookup www.alice.madcamp-kaist.org 1.1.1.1
```

---

### Q. "DNS_RECORD_CONFLICT" 오류가 납니다.

같은 이름에 충돌하는 타입이 이미 있습니다. 예: CNAME과 A를 같은 이름에 동시에 생성 불가. 기존 레코드를 먼저 삭제하세요.

---

### Q. API 키를 Git에 올려버렸어요.

즉시 관리자에게 연락하여 **기존 키 폐기 + 새 키 재발급**을 요청하세요. API 키는 환경변수로 관리하세요:

```bash
# .env 파일 (절대 Git에 커밋 금지)
DNS_API_KEY=dns_a1b2c3d4...
```

---

### Q. TXT 레코드에 255자 이상 내용이 필요해요.

Cloudflare free tier에서 TXT 레코드 내용은 255자 제한이 있습니다. 긴 텍스트(예: DKIM 키)는 여러 개의 TXT 레코드로 분리하거나, 별도 방법을 사용하세요. 이는 API 제약이 아닌 DNS/Cloudflare 제약입니다.

---

### Q. proxied:true를 TXT에 설정하면 어떻게 되나요?

Cloudflare는 TXT 레코드의 proxied 설정을 무시합니다 (TXT는 프록시가 불가능한 타입). API에서 설정해도 실제로는 반영되지 않습니다.

---

### Q. 서비스 중에 IP를 바꿔야 하는데 다운타임 없이 가능한가요?

```bash
# 1단계: TTL을 60초로 낮춤
curl -s -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttl": 60}' \
  $BASE_URL/v1/records/<RECORD_ID>

# 2단계: 기존 TTL 시간(예: 5분)만큼 대기

# 3단계: IP 변경
curl -s -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "새로운_IP", "ttl": 300}' \
  $BASE_URL/v1/records/<RECORD_ID>
```

---

### Q. 오류 발생 시 무엇을 보고해야 하나요?

응답 헤더의 `X-Request-Id` 값을 관리자에게 알려주세요. 이 값으로 서버 로그에서 해당 요청을 추적할 수 있습니다.

```bash
curl -v -H "Authorization: Bearer $API_KEY" $BASE_URL/v1/records 2>&1 | grep -i x-request-id
```

---

*문의사항은 운영 채널(슬랙/디스코드)로 연락하거나 관리자에게 직접 문의하세요.*
