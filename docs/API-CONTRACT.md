# gh-proxy API 계약 문서 (API Contract)

- **대상 버전**: gh-proxy v1.0.x
- **검증 환경**: Node.js 24, gh CLI v2.92.0, git 2.x (2026-06-12)
- **상태**: 안정 (Stable)

이 문서는 gh-proxy 서버가 클라이언트에 제공하는 모든 인터페이스의 계약을 정의합니다.
서버 구현은 [`server.js`](../server.js) 단일 파일입니다.

---

## 목차

1. [개요와 용어](#1-개요와-용어)
2. [Base URL](#2-base-url)
3. [인증 계층](#3-인증-계층)
4. [공통 전송 규칙](#4-공통-전송-규칙)
5. [모드 ① — 포워드 프록시 (CONNECT 터널)](#5-모드--포워드-프록시-connect-터널)
6. [모드 ② — 리버스 프록시 엔드포인트](#6-모드--리버스-프록시-엔드포인트)
7. [URL 재작성 규칙](#7-url-재작성-규칙)
8. [리다이렉트 처리](#8-리다이렉트-처리)
9. [프록시 오류 응답 포맷](#9-프록시-오류-응답-포맷)
10. [허용 호스트 목록 (Allowlist)](#10-허용-호스트-목록-allowlist)
11. [타임아웃과 한도](#11-타임아웃과-한도)
12. [환경변수 레퍼런스](#12-환경변수-레퍼런스)
13. [호환성 노트](#13-호환성-노트)
14. [예시 모음](#14-예시-모음)

---

## 1. 개요와 용어

| 용어 | 의미 |
|------|------|
| **프록시 서버** | gh-proxy가 실행 중인, GitHub에 직접 접근 가능한 머신 |
| **클라이언트** | 프록시 서버에는 접근 가능하지만 github.com/api.github.com에 접근 불가능한 머신 |
| **업스트림(upstream)** | 프록시가 대신 접속하는 GitHub 측 서버 (api.github.com, github.com, uploads.github.com 등) |
| **PUBLIC_BASE** | 클라이언트가 프록시에 접근하는 기준 URL. `.env`의 `PUBLIC_HOST`로 결정 (예: `http://my-pc.internal:8788`) |
| **프록시 토큰** | `.env`의 `PROXY_TOKEN`. 프록시 사용 권한을 통제하는 공유 시크릿 (GitHub 토큰과 무관) |
| **GitHub 토큰** | `Authorization` 헤더로 전달되는 PAT 등. 프록시는 검사하지 않고 GitHub로 전달만 함 |

하나의 리스닝 포트(기본 8788)에서 아래 세 종류의 요청을 모두 처리합니다.

| 요청 형태 | 처리 |
|-----------|------|
| `CONNECT host:port` | 모드 ① — TCP 터널 (HTTPS 포워드 프록시) |
| 절대형 URI (`GET http://host/...`) | 모드 ①의 평문 HTTP 변형 — 허용 호스트로 패스스루 |
| 경로형 URI (`GET /api/v3/...`) | 모드 ② — 리버스 프록시 라우팅 |

## 2. Base URL

```
PUBLIC_BASE = (스킴)://(PUBLIC_HOST)
```

- `PUBLIC_HOST`에 스킴이 없으면 `http://`(TLS 미설정 시) 또는 `https://`(TLS 설정 시)가 붙습니다.
- `PUBLIC_HOST` 미설정 시 `localhost:<PORT>`가 사용됩니다. **다른 머신에서 쓰려면 반드시 설정하세요** — [URL 재작성](#7-url-재작성-규칙)이 이 값을 기준으로 동작합니다.
- 이 문서의 예시는 `http://proxy.internal:8788`을 PUBLIC_BASE로 가정합니다.

## 3. 인증 계층

인증은 **두 계층**으로 분리되어 있습니다. 혼동하지 마세요.

### 3.1 프록시 토큰 (선택, 프록시 사용 권한)

`PROXY_TOKEN`이 설정된 경우에만 검사하며, 미설정 시 모든 요청이 통과합니다.

| 요청 종류 | 토큰 전달 방법 |
|-----------|----------------|
| CONNECT / 절대형 URI | `Proxy-Authorization: Basic base64(<아무유저>:<토큰>)` 또는 `Proxy-Authorization: Bearer <토큰>` — 보통 `HTTPS_PROXY=http://user:<토큰>@host:port` 형태로 설정하면 클라이언트가 자동 전송 |
| 리버스 프록시 경로 | `X-Proxy-Token: <토큰>` 헤더 또는 위와 같은 `Proxy-Authorization` 헤더 |

- 검사 면제 경로: `GET /`, `GET /healthz`
- 실패 응답: CONNECT는 **407** (`Proxy-Authenticate: Basic realm="gh-proxy"`), 리버스 경로는 **401** + [프록시 오류 JSON](#9-프록시-오류-응답-포맷) (`PROXY_AUTH_REQUIRED`)
- `X-Proxy-Token`·`Proxy-Authorization` 헤더는 업스트림으로 **전달되지 않습니다** (프록시에서 소비).

### 3.2 GitHub 토큰 (GitHub API 권한)

- 클라이언트가 보낸 `Authorization` 헤더는 그대로 업스트림에 전달됩니다.
- `.env`에 `GITHUB_TOKEN`이 설정된 경우: `Authorization` 헤더가 **없는** `/api/v3`, `/api/graphql`, `/api/uploads` 요청에 한해 서버가 `Authorization: Bearer <GITHUB_TOKEN>`을 주입합니다.
  - `/login`, `/raw`, git smart HTTP, CONNECT 터널에는 주입하지 않습니다.
  - 크로스 호스트 리다이렉트 추적 시에는 [제거됩니다](#8-리다이렉트-처리).

## 4. 공통 전송 규칙

모드 ②(리버스 프록시)와 절대형 URI 처리에 적용됩니다. CONNECT 터널은 바이트 스트림을 그대로 중계하므로 해당 없음.

### 4.1 요청 헤더 처리 (클라이언트 → 업스트림)

| 처리 | 대상 |
|------|------|
| **제거** (hop-by-hop) | `Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `Proxy-Connection`, `TE`, `Trailer(s)`, `Transfer-Encoding`, `Upgrade` 및 `Connection` 헤더에 나열된 헤더 |
| **제거** (프록시 내부용) | `Host`(업스트림 호스트로 교체), `X-Proxy-Token` |
| **교체** | `Host: <업스트림 호스트>` |
| **조건부 설정** | `User-Agent` 부재 시 `gh-proxy/<버전>` (GitHub API는 UA 필수) |
| **조건부 교체** | URL 재작성 대상 경로(`/api/v3`, `/api/graphql`)는 `Accept-Encoding: identity`로 교체 (본문 검사를 위해 비압축 수신) |
| **그 외 전부** | 변경 없이 전달 (`Accept`, `Authorization`, `X-GitHub-Api-Version`, `If-None-Match` 등) |

### 4.2 응답 헤더 처리 (업스트림 → 클라이언트)

| 처리 | 대상 |
|------|------|
| **제거** | hop-by-hop 헤더 일체 (`Transfer-Encoding` 포함 — 프록시가 재프레이밍) |
| **재작성** | `Link`, `Location` — [§7](#7-url-재작성-규칙) 규칙 적용 |
| **추가** | `Via: 1.1 gh-proxy/<버전>` (기존 Via가 있으면 뒤에 연결) |
| **본문 재작성 시 갱신** | `Content-Length` 재계산, `Content-Encoding` 제거 |
| **그 외 전부** | 변경 없이 전달 (`ETag`, `X-RateLimit-*`, `X-GitHub-Request-Id` 등) |

### 4.3 메서드와 본문

- 모든 HTTP 메서드(GET/POST/PUT/PATCH/DELETE/HEAD)를 지원하며 요청 본문은 스트리밍으로 전달됩니다.
- `Expect: 100-continue`(대용량 git push)는 자동으로 100 응답 처리됩니다.
- GitHub의 응답 상태코드·본문은 (재작성 규칙 외에는) 가공 없이 그대로 전달됩니다. **4xx/5xx도 GitHub가 보낸 것이라면 그대로입니다** — 프록시 자체 오류와의 구분은 [§9](#9-프록시-오류-응답-포맷) 참고.

## 5. 모드 ① — 포워드 프록시 (CONNECT 터널)

### 5.1 계약

```
CONNECT <host>:<port> HTTP/1.1
Host: <host>:<port>
[Proxy-Authorization: Basic ...]        # PROXY_TOKEN 설정 시 필수
```

| 조건 | 응답 |
|------|------|
| 성공 | `HTTP/1.1 200 Connection Established` 후 양방향 TCP 중계 시작 |
| 프록시 토큰 불일치 | `HTTP/1.1 407 Proxy Authentication Required` + `Proxy-Authenticate: Basic realm="gh-proxy"` |
| 허용 목록 외 호스트 | `HTTP/1.1 403 Forbidden` |
| 허용 외 포트 (443/80/22 외) | `HTTP/1.1 403 Forbidden` |
| 업스트림 연결 실패/타임아웃(10초) | `HTTP/1.1 502 Bad Gateway` |

- 터널 수립 후 프록시는 페이로드를 검사하지 않습니다. TLS는 클라이언트와 GitHub 사이에서 종단간으로 유지되므로 **클라이언트에 별도 인증서 설치가 필요 없습니다.**
- 수립된 터널에 유휴 타임아웃은 없습니다 (긴 git clone/push 안전).

### 5.2 클라이언트 설정

```sh
export HTTPS_PROXY=http://proxy.internal:8788            # 토큰 없을 때
export HTTPS_PROXY=http://x:<PROXY_TOKEN>@proxy.internal:8788   # 토큰 있을 때
```

`gh`, `git`, `curl` 등 표준 프록시 환경변수를 따르는 모든 도구가 동작합니다.

### 5.3 절대형 URI (평문 HTTP 포워딩)

`GET http://github.com/... HTTP/1.1` 형태(포워드 프록시의 평문 HTTP 요청)는 허용 호스트에 한해 포트 80으로 패스스루됩니다.
`https://` 절대형 URI는 **400** (`USE_CONNECT`)으로 거절됩니다 — CONNECT를 사용하세요.

## 6. 모드 ② — 리버스 프록시 엔드포인트

### 6.0 라우팅 표 (요약)

| 프록시 경로 | 업스트림 | 용도 | URL 재작성 |
|-------------|----------|------|:---:|
| `GET /` | — | 서비스 정보 | — |
| `GET /healthz` | — | 헬스체크 | — |
| `/api/v3/{path}` | `https://api.github.com/{path}` | REST API | ✅ |
| `/api/graphql`, `/api/v3/graphql` | `https://api.github.com/graphql` | GraphQL | ✅ |
| `/api/uploads/{path}` | `https://uploads.github.com/{path}` | 릴리스 자산 업로드 | — |
| `/login/{path}` | `https://github.com/login/{path}` | OAuth/디바이스 플로우 | — |
| `/raw/{path}` | `https://raw.githubusercontent.com/{path}` | 원시 파일 | — |
| `/{owner}/{repo}[.git]/info/refs` `/{owner}/{repo}[.git]/git-upload-pack` `/{owner}/{repo}[.git]/git-receive-pack` | `https://github.com/...` | git smart HTTP | — |
| 그 외 | — | **404** `ROUTE_NOT_FOUND` | — |

쿼리 문자열은 모든 라우트에서 그대로 보존됩니다.

### 6.1 `GET /` — 서비스 정보

인증 불필요. 클라이언트가 프록시를 발견/점검하는 용도.

```json
{
  "name": "gh-proxy",
  "version": "1.0.0",
  "public_base": "http://proxy.internal:8788",
  "auth_required": false,
  "endpoints": { "rest": "http://proxy.internal:8788/api/v3/{path}", "...": "..." },
  "docs": "https://github.com/zaeval/gh-proxy/blob/main/docs/API-CONTRACT.md"
}
```

### 6.2 `GET /healthz` — 헬스체크

인증 불필요. 항상 **200**.

```json
{ "status": "ok", "version": "1.0.0", "uptime_s": 1234 }
```

`?upstream=1`을 붙이면 프록시→api.github.com 연결성을 실측(5초 타임아웃)해서 보고합니다:

```json
{ "status": "ok", "version": "1.0.0", "uptime_s": 1234,
  "upstream": { "reachable": true, "status": 200, "latency_ms": 127 } }
```

업스트림 도달 불가 시 `status`는 `"degraded"`, `upstream.reachable`은 `false`가 되며 HTTP 상태코드는 그대로 200입니다 (프록시 프로세스 자체는 살아있으므로).

### 6.3 `/api/v3/{path}` — GitHub REST API

`https://api.github.com/{path}`로의 완전한 패스스루입니다. GitHub REST API v3의 모든 엔드포인트·메서드·헤더 규약이 그대로 적용됩니다.

- 경로 매핑: `/api/v3` 프리픽스만 제거. `/api/v3` 단독 요청은 api.github.com 루트(`/`)로 전달.
- 페이지네이션: 응답 `Link` 헤더의 `https://api.github.com/...` URL이 `{PUBLIC_BASE}/api/v3/...`로 재작성되므로, 클라이언트는 `rel="next"`를 그대로 따라가면 됩니다.
- 본문 재작성: [§7](#7-url-재작성-규칙) 참고.
- 조건부 요청(`If-None-Match`/ETag), 레이트리밋 헤더(`X-RateLimit-*`), `X-GitHub-Api-Version` 등 모두 투명하게 전달.
- tarball/zipball 등 다운로드성 엔드포인트의 리다이렉트는 서버가 대신 추적해 **최종 바이트를 200으로 직접** 돌려줍니다 ([§8](#8-리다이렉트-처리)).

예시:

```sh
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     http://proxy.internal:8788/api/v3/repos/cli/cli/issues?per_page=50
```

### 6.4 `/api/graphql` — GitHub GraphQL API

`https://api.github.com/graphql` 패스스루. `POST` + JSON 본문. `/api/v3/graphql`도 동일하게 동작합니다(gh의 GHES 호환 경로).

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -d '{"query":"query{viewer{login}}"}' \
     http://proxy.internal:8788/api/graphql
```

### 6.5 `/api/uploads/{path}` — 릴리스 자산 업로드

`https://uploads.github.com/{path}` 패스스루. 본문은 스트리밍 전달되므로 대용량 자산 업로드에 안전합니다. URL 재작성을 하지 않습니다.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" \
     --data-binary @asset.zip \
     "http://proxy.internal:8788/api/uploads/repos/{owner}/{repo}/releases/{id}/assets?name=asset.zip"
```

> 참고: REST 응답의 `upload_url`(`https://uploads.github.com/...`)은 본문 재작성에 의해 `{PUBLIC_BASE}/api/uploads/...`로 변환되어 내려가므로 그대로 사용 가능합니다.

### 6.6 `/login/{path}` — OAuth / 디바이스 플로우

`https://github.com/login/{path}` 패스스루. `gh auth login`의 디바이스 플로우가 GHES 레이아웃으로 호출하는 `/login/device/code`, `/login/oauth/access_token` 등을 지원하기 위한 라우트입니다.

### 6.7 `/raw/{owner}/{repo}/{ref}/{path}` — 원시 파일

`https://raw.githubusercontent.com/...` 패스스루. 클라이언트에서 파일 하나를 빠르게 받을 때 사용.

```sh
curl http://proxy.internal:8788/raw/cli/cli/trunk/README.md
```

### 6.8 git smart HTTP — `/{owner}/{repo}[.git]/...`

`https://github.com/{owner}/{repo}[.git]/...` 패스스루. 다음 세 경로만 매칭됩니다:

- `GET  /{owner}/{repo}[.git]/info/refs?service=git-upload-pack|git-receive-pack`
- `POST /{owner}/{repo}[.git]/git-upload-pack`   (fetch/clone)
- `POST /{owner}/{repo}[.git]/git-receive-pack`  (push)

```sh
git clone http://proxy.internal:8788/octocat/Hello-World.git
git push  # origin이 프록시 URL이면 그대로 동작 (Basic 인증은 GitHub로 전달)
```

- private 저장소/push의 Basic 인증(`사용자명` + `PAT`)은 GitHub로 그대로 전달됩니다.
- 제약: owner 이름이 라우팅 프리픽스(`api`, `login`, `raw`)와 충돌하는 경우 해당 저장소는 이 라우트로 접근할 수 없습니다 (모드 ①을 사용하세요).

## 7. URL 재작성 규칙

`REWRITE_BODY_URLS=true`(기본)일 때, **`/api/v3`·`/api/graphql` 응답에 한해** 적용됩니다.

### 7.1 치환 규칙

| 원본 (문자열 일치) | 치환 결과 |
|--------------------|-----------|
| `https://api.github.com` | `{PUBLIC_BASE}/api/v3` |
| `https://uploads.github.com` | `{PUBLIC_BASE}/api/uploads` |

### 7.2 적용 위치

| 위치 | 적용 조건 |
|------|-----------|
| `Link` 응답 헤더 | 항상 (REWRITE_BODY_URLS와 무관하게 모드 ② api 라우트에서) |
| `Location` 응답 헤더 | 리다이렉트를 클라이언트로 넘기는 경우 ([§8](#8-리다이렉트-처리)) |
| 응답 본문 | `Content-Type`이 JSON 또는 `text/*`이고, 본문이 16 MiB 이하인 경우 |

### 7.3 적용하지 않는 것

- `html_url` 등의 **`https://github.com/...` URL은 재작성하지 않습니다** — 브라우저용 URL이며 API 호출 대상이 아니므로 원본을 보존합니다.
- `git_url`(`git://`), `ssh_url`(`git@github.com:`)도 보존됩니다.
- 본문이 16 MiB를 초과하면 재작성을 건너뛰고 원본 바이트를 스트리밍합니다 (로그에 `rewrite skipped` 기록).
- 업스트림이 알 수 없는 `Content-Encoding`으로 응답한 경우에도 원본을 그대로 전달합니다. (정상 경로에서는 프록시가 `Accept-Encoding: identity`를 보내므로 발생하지 않음. gzip/deflate/br은 프록시가 해제 후 재작성 가능.)

## 8. 리다이렉트 처리

`FOLLOW_REDIRECTS=true`(기본)일 때:

1. 업스트림이 **301/302/303/307/308** + `Location`으로 응답하고,
2. 클라이언트 요청 메서드가 **GET 또는 HEAD**이며,
3. `Location`의 호스트가 [허용 목록](#10-허용-호스트-목록-allowlist)에 있으면,

프록시가 **서버 측에서 리다이렉트를 추적**해 최종 응답을 클라이언트에 돌려줍니다. 클라이언트는 자신이 접근할 수 없는 호스트(`codeload.github.com`, `objects.githubusercontent.com` 등)를 볼 일이 없습니다.

- 추적 한도: `MAX_REDIRECTS`(기본 5). 초과 시 마지막 3xx 응답이 그대로 내려갑니다.
- **자격증명 보호**: 리다이렉트 대상 호스트가 직전 요청 호스트와 다르면 `Authorization` 헤더를 제거하고 따라갑니다 (GitHub 서명 URL 규약 준수, 토큰 유출 방지).
- 추적하지 않는 경우(POST 등 비-GET/HEAD, 허용 외 호스트, FOLLOW_REDIRECTS=false): 3xx 응답을 그대로 전달하되 `Location`이 api/uploads URL이면 [§7](#7-url-재작성-규칙) 재작성을 적용합니다.

## 9. 프록시 오류 응답 포맷

프록시 **자체**가 생성한 오류는 GitHub 오류와 구분되도록 다음 형식을 따릅니다.

```json
{
  "error": {
    "code": "HOST_NOT_ALLOWED",
    "message": "Host \"example.com\" is not in the GitHub allowlist.",
    "source": "gh-proxy/1.0.0"
  }
}
```

- 응답 헤더에 **`X-Gh-Proxy-Error: <코드>`** 가 항상 포함됩니다. **이 헤더가 없는 4xx/5xx는 GitHub가 보낸 응답입니다.**
- `Content-Type: application/json; charset=utf-8`

### 오류 코드 표

| HTTP | 코드 | 발생 조건 |
|------|------|-----------|
| 400 | `BAD_REQUEST` | 절대형 URI 파싱 불가 |
| 400 | `USE_CONNECT` | `https://` 절대형 URI를 평문 포워딩으로 요청 |
| 401 | `PROXY_AUTH_REQUIRED` | 리버스 경로에서 프록시 토큰 누락/불일치 |
| 403 | `HOST_NOT_ALLOWED` | 절대형 URI 대상 호스트가 허용 목록 외 |
| 404 | `ROUTE_NOT_FOUND` | 매칭되는 리버스 라우트 없음 |
| 502 | `UPSTREAM_ERROR` | 업스트림 연결 실패 (DNS, 연결 거부 등) |
| 504 | `UPSTREAM_TIMEOUT` | 업스트림 응답 타임아웃 (`UPSTREAM_TIMEOUT_MS`) |

CONNECT 터널의 오류는 HTTP 상태줄로만 전달됩니다 (407/403/502, [§5.1](#51-계약)).

## 10. 허용 호스트 목록 (Allowlist)

CONNECT 터널·절대형 URI·리다이렉트 추적 대상에 적용됩니다. 기본 목록:

```
github.com, *.github.com
githubusercontent.com, *.githubusercontent.com
ghcr.io, *.ghcr.io
githubcopilot.com, *.githubcopilot.com
```

- `*.x`는 모든 하위 도메인과 `x` 자체에 일치합니다.
- `EXTRA_ALLOWED_HOSTS`로 추가 가능 (쉼표 구분, `*.` 와일드카드 지원).
- CONNECT 허용 포트: **443, 80, 22** (22는 `ssh.github.com` 스타일의 SSH-over-CONNECT용).

## 11. 타임아웃과 한도

| 항목 | 기본값 | 환경변수 |
|------|--------|----------|
| 업스트림 요청 타임아웃 (리버스) | 30초 | `UPSTREAM_TIMEOUT_MS` |
| CONNECT 터널 수립 타임아웃 | 10초 | `CONNECT_TIMEOUT_MS` |
| 수립된 터널 유휴 타임아웃 | 없음 | — |
| 본문 재작성 최대 크기 | 16 MiB (초과 시 원본 스트리밍) | (고정) |
| 리다이렉트 추적 한도 | 5회 | `MAX_REDIRECTS` |
| 업스트림 keep-alive 커넥션 풀 | 64 소켓 | (고정) |

레이트리밋: 프록시 자체의 레이트리밋은 없습니다. GitHub의 레이트리밋이 그대로 적용되며 `X-RateLimit-*` 헤더로 확인할 수 있습니다.

## 12. 환경변수 레퍼런스

[README의 환경변수 표](../README.md#환경변수-env)와 [.env.example](../.env.example)을 참고하세요. 우선순위: **실제 환경변수 > `.env` 파일 > 기본값**.

## 13. 호환성 노트

- **gh CLI**: v2.92.0으로 검증. 모드 ①(`HTTPS_PROXY`)에서 `gh api`, `gh repo`, `gh pr` 등 전 기능 동작.
- **`GH_HOST` 모드 (GHES 에뮬레이션)**: 리버스 라우트가 GHES 경로 레이아웃(`/api/v3`, `/api/graphql`, `/api/uploads`, `/login`)을 따르지만, gh는 GH_HOST 대상에 **HTTPS를 강제**하므로 평문 HTTP 프록시에는 `GH_HOST`를 쓸 수 없습니다(실측: `http: server gave HTTP response to HTTPS client`). `TLS_CERT_FILE`/`TLS_KEY_FILE`로 클라이언트가 신뢰하는 인증서를 프록시에 설정한 경우에만 `GH_HOST=<PUBLIC_HOST>` + `GH_ENTERPRISE_TOKEN`으로 사용 가능합니다.
- **git**: 모드 ①(프록시 환경변수)과 모드 ②(직접 URL) 모두 검증 완료 (clone/ls-remote/upload-pack).
- **WebSocket**: 리버스 프록시는 Upgrade를 지원하지 않습니다. WebSocket이 필요한 기능은 모드 ①을 사용하세요.
- **HTTP 버전**: 클라이언트↔프록시는 HTTP/1.1. 프록시↔업스트림도 HTTP/1.1 (keep-alive 풀링).

## 14. 예시 모음

```sh
# 0) 프록시 상태 확인 (인증 불필요)
curl http://proxy.internal:8788/healthz
curl "http://proxy.internal:8788/healthz?upstream=1"
curl http://proxy.internal:8788/          # 엔드포인트 안내

# 1) gh 전체를 프록시로 (권장)
export HTTPS_PROXY=http://proxy.internal:8788
gh api rate_limit
gh pr list --repo cli/cli

# 2) REST 직접 호출
curl -H "Authorization: Bearer $TOKEN" \
     http://proxy.internal:8788/api/v3/user

# 3) 페이지네이션 — Link 헤더가 이미 프록시 주소로 재작성되어 있음
curl -sI "http://proxy.internal:8788/api/v3/repos/cli/cli/issues?per_page=1" | grep -i ^link

# 4) GraphQL
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -d '{"query":"query{viewer{login}}"}' \
     http://proxy.internal:8788/api/graphql

# 5) 저장소 tarball (codeload 리다이렉트는 서버가 대신 추적)
curl -L -o repo.tar.gz \
     http://proxy.internal:8788/api/v3/repos/octocat/Hello-World/tarball

# 6) git
git clone http://proxy.internal:8788/octocat/Hello-World.git

# 7) 원시 파일
curl http://proxy.internal:8788/raw/cli/cli/trunk/README.md

# 8) 프록시 토큰이 설정된 경우
export HTTPS_PROXY=http://x:MY_PROXY_TOKEN@proxy.internal:8788     # 모드 ①
curl -H "X-Proxy-Token: MY_PROXY_TOKEN" \
     http://proxy.internal:8788/api/v3/rate_limit                  # 모드 ②
```

---

### 버전 정책

이 계약은 gh-proxy의 **major 버전 내에서 하위 호환**을 유지합니다. 라우트 추가·허용 호스트 확장은 minor, 기존 라우트/재작성 규칙의 비호환 변경은 major 버전 변경으로 취급합니다.
