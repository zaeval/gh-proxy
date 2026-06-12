---
name: gh-proxy
description: Use GitHub (gh CLI, git, REST/GraphQL API) through a gh-proxy relay server when this machine cannot reach github.com or api.github.com directly. Use when gh or git commands fail with DNS/connection/timeout errors to github.com, when GitHub API calls are blocked, or when the user mentions gh-proxy, a GitHub proxy, or a relay server.
---

# gh-proxy — use GitHub through a relay server

This machine cannot reach `github.com` / `api.github.com` directly, but a
**gh-proxy** relay server (running on a machine that does have GitHub access)
is reachable. Route all GitHub traffic through it.

## 1. Find the proxy

Resolve the proxy base URL in this order:

1. `GH_PROXY_URL` environment variable — may be a bare host
   (`http://proxy.internal:8788`) or include a path prefix when the proxy
   sits behind a fronting web server (`https://example.com/proxy/gh`)
2. Ask the user for the proxy URL

If the proxy requires a token, it is in `GH_PROXY_TOKEN` (or ask the user).

Verify it is alive (no auth needed):

```sh
curl -s $GH_PROXY_URL/healthz
# {"status":"ok",...}  — add ?upstream=1 to also check proxy→GitHub connectivity
```

`curl -s $GH_PROXY_URL/` lists all available endpoints and tells you whether
auth is required (`auth_required`) and whether CONNECT mode is available
(`endpoints.forward_proxy`).

## 2. HTTPS_PROXY method (gh and git work unmodified)

**Only when `GH_PROXY_URL` has NO path component.** A URL with a path prefix
(e.g. `https://example.com/proxy/gh`) cannot be used as `HTTPS_PROXY` — skip
to section 3 in that case.

Set the proxy for the current process only — do NOT change machine-wide
settings unless the user asks:

```powershell
# PowerShell
$env:HTTPS_PROXY = $env:GH_PROXY_URL    # e.g. http://proxy.internal:8788
gh api rate_limit
gh pr list --repo owner/repo
git clone https://github.com/owner/repo.git
```

```sh
# bash — per-command form
HTTPS_PROXY=$GH_PROXY_URL gh api rate_limit
HTTPS_PROXY=$GH_PROXY_URL git push
```

TLS stays end-to-end (CONNECT tunnel); no certificates to install.
Only GitHub-related hosts are allowed through the tunnel — other domains
will fail with `403` from the proxy. That is expected.

If the proxy requires a token (`407 Proxy Authentication Required`), embed it:
`HTTPS_PROXY=http://x:<PROXY_TOKEN>@proxy.internal:8788`.

## 3. Direct REST/GraphQL/git paths (works with any GH_PROXY_URL)

This is the primary method when the proxy is behind a path prefix
(`https://example.com/proxy/gh`). The proxy mirrors GitHub under these paths:

| Path on proxy | Upstream |
|---|---|
| `/api/v3/{path}` | `https://api.github.com/{path}` (REST) |
| `/api/graphql` | `https://api.github.com/graphql` |
| `/api/uploads/{path}` | `https://uploads.github.com/{path}` |
| `/raw/{owner}/{repo}/{ref}/{path}` | raw.githubusercontent.com |
| `/{owner}/{repo}.git` | git smart HTTP (clone/push) |

```sh
curl -H "Authorization: Bearer $GH_TOKEN" $GH_PROXY_URL/api/v3/repos/cli/cli
curl -X POST -H "Authorization: Bearer $GH_TOKEN" \
     -d '{"query":"query{viewer{login}}"}' $GH_PROXY_URL/api/graphql
git clone $GH_PROXY_URL/owner/repo.git
```

Notes:
- Pagination `Link` headers and JSON body URLs are already rewritten to point
  back at the proxy — follow them as-is.
- Tarball/zipball redirects (codeload) are followed server-side; you get the
  bytes directly with `curl -o file.tar.gz .../api/v3/repos/o/r/tarball`.
- If the proxy has a token configured (`GH_PROXY_TOKEN`):
  - curl: add `-H "X-Proxy-Token: $GH_PROXY_TOKEN"`
  - git: `git -c http.extraheader="X-Proxy-Token: $GH_PROXY_TOKEN" clone ...`
    (or set it once per repo: `git config http.extraheader "X-Proxy-Token: ..."`)

## 4. gh authentication on this machine

The browser here cannot reach github.com, so:

- **Token paste (simplest):** with `HTTPS_PROXY` set,
  `echo <PAT> | gh auth login --with-token`, or just export `GH_TOKEN=<PAT>`.
- **Device flow:** run `gh auth login` (with `HTTPS_PROXY` set) and enter the
  shown code at `https://github.com/login/device` on a phone or any device
  that can reach GitHub.

## 5. Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `curl $GH_PROXY_URL/healthz` fails | Proxy down or wrong host/port — ask the user |
| `healthz?upstream=1` → `"reachable": false` | Proxy server itself lost GitHub access |
| `407` on CONNECT / `401` JSON with `X-Gh-Proxy-Error: PROXY_AUTH_REQUIRED` | Proxy token required — use `GH_PROXY_TOKEN` or ask the user |
| `403` CONNECT failure for a non-GitHub host | By design: tunnel allows GitHub hosts only |
| 4xx/5xx **without** `X-Gh-Proxy-Error` header | Real GitHub API error — handle normally (auth, rate limit, etc.) |
| `gh` says `server gave HTTP response to HTTPS client` with `GH_HOST` set | Don't use `GH_HOST` with this proxy — unset it and use `HTTPS_PROXY` instead |

Full contract: `docs/API-CONTRACT.md` in https://github.com/zaeval/gh-proxy
