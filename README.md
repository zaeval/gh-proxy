# gh-proxy

**GitHub에 직접 접근할 수 없는 PC에서 `gh`, `git`, GitHub REST/GraphQL API를 쓸 수 있게 해주는 중계(릴레이) 서버.**

의존성 없는(zero-dependency) 단일 Node.js 파일로 동작합니다.

```
┌──────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  클라이언트 PC    │  HTTP   │   gh-proxy 서버   │  HTTPS  │   github.com    │
│ (GitHub 접근 불가)│ ──────► │ (GitHub 접근 가능)│ ──────► │ api.github.com  │
│  gh / git / curl │         │   이 저장소       │         │ codeload, ...   │
└──────────────────┘         └──────────────────┘         └─────────────────┘
```

## 동작 모드

하나의 포트에서 두 가지 모드를 동시에 제공합니다.

| 모드 | 사용법 | 용도 |
|------|--------|------|
| **① 포워드 프록시 (CONNECT 터널)** — 권장 | 클라이언트에서 `HTTPS_PROXY=http://<프록시호스트>:8788` 만 설정 | `gh`·`git`이 **수정 없이 그대로** 동작. TLS는 클라이언트↔GitHub 종단간 유지 |
| **② 리버스 프록시 (REST 패스스루)** | `http://<프록시호스트>:8788/api/v3/...` 등으로 직접 호출 | `curl`/스크립트로 GitHub API 호출, `git clone http://<프록시호스트>:8788/owner/repo.git` |

상세한 엔드포인트 명세는 **[docs/API-CONTRACT.md](docs/API-CONTRACT.md)** 를 참고하세요. 실행 중인 서버에서는 같은 문서를 브라우저에서 바로 볼 수 있습니다 — **`<PUBLIC_BASE>/contract`** (HTML 렌더링, `?raw=1`로 원본 마크다운). 이 엔드포인트는 토큰 없이 열람 가능합니다.

## 빠른 시작

### 서버 PC (GitHub에 접근 가능한 이 컴퓨터)

```powershell
git clone https://github.com/zaeval/gh-proxy.git
cd gh-proxy
copy .env.example .env     # PUBLIC_HOST를 외부에서 접근하는 호스트명으로 수정
npm start
```

`.env`에서 반드시 확인할 항목:

```ini
PORT=8788
# 클라이언트가 이 서버에 접근할 때 쓰는 호스트명(:포트).
# Link 헤더·JSON 본문의 api.github.com URL이 이 주소로 재작성됩니다.
PUBLIC_HOST=my-pc.example.internal:8788
```

방화벽에서 해당 포트의 인바운드를 허용해야 합니다(Windows):

```powershell
New-NetFirewallRule -DisplayName "gh-proxy" -Direction Inbound -Protocol TCP -LocalPort 8788 -Action Allow
```

### 클라이언트 PC (GitHub에 접근 불가능한 컴퓨터)

연결 확인:

```sh
curl http://<프록시호스트>:8788/healthz
```

**gh 사용 (모드 ①):**

```powershell
# PowerShell
$env:HTTPS_PROXY = "http://<프록시호스트>:8788"
gh api rate_limit
gh repo clone owner/repo
```

```sh
# bash
export HTTPS_PROXY=http://<프록시호스트>:8788
gh api rate_limit
```

**gh 인증** — 클라이언트의 브라우저는 github.com에 접근할 수 없으므로:

```sh
# 방법 1: 토큰 직접 입력 (서버 PC 등에서 발급한 PAT)
echo <PAT> | gh auth login --with-token        # HTTPS_PROXY 설정 상태에서

# 방법 2: 디바이스 플로우 — 표시되는 코드를 휴대폰 등 다른 기기에서
#         https://github.com/login/device 에 입력
gh auth login
```

**git 사용:**

```sh
# 방법 A: 프록시 환경변수 (HTTPS_PROXY 설정 상태에서 평소처럼)
git clone https://github.com/owner/repo.git

# 방법 B: 리버스 프록시 경로로 직접 (환경변수 불필요)
git clone http://<프록시호스트>:8788/owner/repo.git
```

**curl로 API 직접 호출 (모드 ②):**

```sh
curl -H "Authorization: Bearer <토큰>" http://<프록시호스트>:8788/api/v3/repos/cli/cli
curl -X POST -H "Authorization: Bearer <토큰>" -d '{"query":"query{viewer{login}}"}' \
     http://<프록시호스트>:8788/api/graphql
```

## 스킬 설치 — Claude Code & Codex (클라이언트 PC)

클라이언트 PC의 **Claude Code** 또는 **Codex CLI**가 이 프록시 사용법을 알도록 `gh-proxy`
스킬을 설치합니다. 두 도구는 동일한 `SKILL.md` 포맷을 쓰므로 같은 파일을 각자의 skills
디렉터리(`~/.claude/skills/gh-proxy/`, `~/.codex/skills/gh-proxy/`)에 넣으면 됩니다.

**실행 중인 서버에서 원터치 설치** — 서버가 자기 주소를 채워 넣은 설치 스크립트를 제공합니다:

```sh
# Linux / macOS / WSL  (둘 다 / 한쪽만)
curl -fsSL http://<프록시호스트>:8788/install.sh | sh
curl -fsSL http://<프록시호스트>:8788/install.sh | sh -s -- claude
curl -fsSL http://<프록시호스트>:8788/install.sh | sh -s -- codex
```

```powershell
# Windows
irm http://<프록시호스트>:8788/install.ps1 | iex
```

설치 안내 페이지(HTML)는 브라우저에서 **`<PUBLIC_BASE>/install`** 로 볼 수 있습니다.
토큰이 설정된 프록시라면 설치 후 `GH_PROXY_URL`·`GH_PROXY_TOKEN` 환경변수를 지정하세요(스크립트는 토큰을 포함하지 않습니다).

**저장소 체크아웃에서 설치** (스크립트 사용):

```powershell
.\scripts\install-skill.ps1 -ProxyUrl http://<프록시호스트>:8788 -Target both
```

```sh
./scripts/install-skill.sh http://<프록시호스트>:8788 both
```

수동 설치: `curl -fsSL <PUBLIC_BASE>/skill -o ~/.claude/skills/gh-proxy/SKILL.md`
(Codex는 `~/.codex/skills/gh-proxy/SKILL.md`). 자세한 안내는 `<PUBLIC_BASE>/install` 참고.

## 환경변수 (.env)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `8788` | 리스닝 포트 |
| `BIND_HOST` | `0.0.0.0` | 바인딩 인터페이스 |
| `PUBLIC_HOST` | `localhost:<PORT>` | **클라이언트가 접근하는 외부 호스트명(:포트)**. URL 재작성 기준 |
| `PROXY_TOKEN` | (없음) | 프록시 공유 시크릿. 설정 시 모든 중계 요청에 토큰 필요 |
| `GITHUB_TOKEN` | (없음) | Authorization 없는 REST/GraphQL 요청에 서버가 주입할 GitHub 토큰 |
| `REWRITE_BODY_URLS` | `true` | JSON 본문 내 `api.github.com` URL을 `PUBLIC_HOST`로 재작성 |
| `FOLLOW_REDIRECTS` | `true` | GitHub 리다이렉트(codeload 등)를 서버 측에서 추적 |
| `MAX_REDIRECTS` | `5` | 서버측 리다이렉트 추적 한도 |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 업스트림 요청 타임아웃 |
| `CONNECT_TIMEOUT_MS` | `10000` | CONNECT 터널 연결 타임아웃 |
| `EXTRA_ALLOWED_HOSTS` | (없음) | 터널 허용 호스트 추가(쉼표 구분, `*.` 와일드카드 지원) |
| `LOG_REQUESTS` | `true` | 요청 로그 출력 |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | (없음) | 프록시 자체 TLS (GH_HOST 에뮬레이션 모드에 필요) |

## 보안 주의사항

- 이 프록시는 **신뢰할 수 있는 내부망**에서 쓰는 것을 전제로 합니다. 외부에 노출되는 환경이라면 반드시 `PROXY_TOKEN`을 설정하세요.
- `GITHUB_TOKEN` 주입 기능을 켜면 프록시에 접근 가능한 누구나 그 토큰의 권한으로 GitHub를 사용할 수 있습니다. **`PROXY_TOKEN`과 함께** 사용하세요.
- 터널링은 GitHub 관련 도메인 허용 목록(`github.com`, `*.github.com`, `*.githubusercontent.com`, `ghcr.io`, `githubcopilot.com` 등)으로 제한되어 오픈 프록시로 악용될 수 없습니다.

## 백그라운드 실행

**Windows (작업 스케줄러):**

```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "server.js" -WorkingDirectory "C:\path\to\gh-proxy"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "gh-proxy" -Action $action -Trigger $trigger -RunLevel Limited
Start-ScheduledTask -TaskName "gh-proxy"
```

**Linux (systemd):**

```ini
# /etc/systemd/system/gh-proxy.service
[Unit]
Description=gh-proxy GitHub relay
After=network.target

[Service]
WorkingDirectory=/opt/gh-proxy
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## 기존 웹서버(nginx 등) 뒤에 경로 프리픽스로 배포하기

이미 도메인과 TLS를 가진 nginx가 있다면 `https://example.com/proxy/gh` 같은 경로 아래에 붙일 수 있습니다.

```nginx
location = /proxy/gh { return 301 /proxy/gh/; }
location ^~ /proxy/gh/ {
    proxy_pass http://127.0.0.1:8788/;   # trailing slash → prefix 제거
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-Proto $scheme;

    client_max_body_size 0;          # git push / 릴리스 자산 업로드
    proxy_request_buffering off;     # 업로드 스트리밍
    proxy_buffering off;             # tarball 등 다운로드 스트리밍
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

`.env`의 `PUBLIC_HOST`에는 **경로까지 포함한 전체 URL**을 넣습니다:

```ini
PUBLIC_HOST=https://example.com/proxy/gh
```

Link 헤더·본문 URL이 이 주소 기준으로 재작성되어 페이지네이션·git clone이 그대로 동작합니다.

> **주의**: 경로 프리픽스 배포에서는 모드 ①(CONNECT, `HTTPS_PROXY`)을 쓸 수 없습니다 — nginx는 CONNECT를 중계하지 않습니다. 이 경우 모드 ②(REST/GraphQL/git 경로)가 주 사용법이며, `HTTPS_PROXY`가 필요하면 프록시 포트(8788)에 직접 접근 가능해야 합니다. 또한 인터넷에 공개되는 배포라면 반드시 `PROXY_TOKEN`을 설정하세요.

## Docker / WSL 배포

이미지에 런타임 의존성이 없어 Docker 빌드가 매우 가볍습니다.

```sh
cp .env.example .env        # PUBLIC_HOST, (필요 시) PROXY_TOKEN 설정
docker compose up -d --build
# 기본 compose는 127.0.0.1:8788 로 노출 (standalone)
```

**프론트 nginx가 Docker 컨테이너인 경우** — gh-proxy를 같은 Docker 네트워크에 올리면
nginx가 호스트 게이트웨이 IP 대신 **컨테이너 이름으로 직접** 도달할 수 있어, WSL/호스트
IP가 바뀌어도 끊기지 않습니다. nginx가 속한 외부 네트워크에 join 하는 compose 예시:

```yaml
# docker-compose.ucut.yml  (배포 호스트 전용, 커밋하지 않음)
services:
  gh-proxy:
    build: .
    container_name: gh-proxy
    env_file: [.env]
    environment: { BIND_HOST: 0.0.0.0 }
    restart: unless-stopped
    networks: [nginxnet]
networks:
  nginxnet:
    external: true
    name: <프론트-nginx-의-네트워크>   # 예: nginx-proxy_default
```

```sh
docker compose -f docker-compose.ucut.yml up -d --build
```

그리고 nginx는 컨테이너 이름으로 프록시합니다:

```nginx
location ^~ /proxy/gh/ { proxy_pass http://gh-proxy:8788/; ... }
```

> 이 저장소의 실제 배포(`ucut.in`)가 이 구성입니다: WSL Docker의 nginx가
> `nginx-proxy_default` 네트워크에서 `gh-proxy` 컨테이너로 프록시하고, 백엔드는
> 컨테이너 안에서 GitHub로 중계합니다. (WSL은 Windows 네트워크를 공유하므로
> 컨테이너에서 github.com 도달 가능.)

## 알려진 제약

- `GH_HOST=<프록시호스트>` 방식(GitHub Enterprise 에뮬레이션)은 `gh`가 **HTTPS를 강제**하므로 평문 HTTP로는 동작하지 않습니다
  (`http: server gave HTTP response to HTTPS client` — gh v2.92.0에서 확인).
  이 방식을 쓰려면 `TLS_CERT_FILE`/`TLS_KEY_FILE`로 프록시에 클라이언트가 신뢰하는 인증서를 설정해야 합니다.
  **권장 방식은 `HTTPS_PROXY`(모드 ①)이며, 평문 HTTP로도 안전하게 동작합니다** (TLS가 터널 내부에서 종단간 유지).
- WebSocket이 필요한 기능(`gh codespace` 등)은 모드 ①(CONNECT)로만 동작합니다.

## 라이선스

[MIT](LICENSE)
