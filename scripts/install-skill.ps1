# Installs the gh-proxy skill into ~/.claude/skills for Claude Code,
# and optionally records the proxy URL in the user environment.
#
#   .\scripts\install-skill.ps1 -ProxyUrl http://proxy.internal:8788
param(
    [string]$ProxyUrl = "",
    [string]$ProxyToken = ""
)

$ErrorActionPreference = "Stop"

$src = Join-Path $PSScriptRoot "..\skills\gh-proxy"
$dst = Join-Path $env:USERPROFILE ".claude\skills\gh-proxy"

New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
Write-Host "Installed skill: $dst"

if ($ProxyUrl) {
    [Environment]::SetEnvironmentVariable("GH_PROXY_URL", $ProxyUrl, "User")
    Write-Host "Set user environment variable GH_PROXY_URL=$ProxyUrl"
    if ($ProxyToken) {
        [Environment]::SetEnvironmentVariable("GH_PROXY_TOKEN", $ProxyToken, "User")
        Write-Host "Set user environment variable GH_PROXY_TOKEN=***"
    }
    Write-Host "(restart terminals for it to take effect)"
} else {
    Write-Host "Tip: set GH_PROXY_URL so the skill can find the proxy automatically:"
    Write-Host '  [Environment]::SetEnvironmentVariable("GH_PROXY_URL", "http://<proxy-host>:8788", "User")'
}
