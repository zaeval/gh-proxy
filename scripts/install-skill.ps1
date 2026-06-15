# Installs the gh-proxy skill into Claude Code and Codex from a repo checkout,
# and optionally records the proxy URL/token in the user environment.
# (For a running server you can instead use: irm <base>/install.ps1 | iex)
#
#   .\scripts\install-skill.ps1 -ProxyUrl http://proxy.internal:8788 -Target both
param(
    [string]$ProxyUrl = "",
    [string]$ProxyToken = "",
    [ValidateSet("claude", "codex", "both")]
    [string]$Target = "both"
)

$ErrorActionPreference = "Stop"

$src = Join-Path $PSScriptRoot "..\skills\gh-proxy"

function Install-To($label, $dst) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    Write-Host "Installed $label skill: $dst"
}

if ($Target -in @("claude", "both")) {
    Install-To "Claude Code" (Join-Path $env:USERPROFILE ".claude\skills\gh-proxy")
}
if ($Target -in @("codex", "both")) {
    Install-To "Codex CLI" (Join-Path $env:USERPROFILE ".codex\skills\gh-proxy")
}

if ($ProxyUrl) {
    [Environment]::SetEnvironmentVariable("GH_PROXY_URL", $ProxyUrl, "User")
    Write-Host "Set user environment variable GH_PROXY_URL=$ProxyUrl"
    if ($ProxyToken) {
        [Environment]::SetEnvironmentVariable("GH_PROXY_TOKEN", $ProxyToken, "User")
        Write-Host "Set user environment variable GH_PROXY_TOKEN=***"
    }
    Write-Host "(restart terminals for it to take effect)"
} else {
    Write-Host "Tip: set GH_PROXY_URL (and GH_PROXY_TOKEN if required) so the skill finds the proxy:"
    Write-Host '  [Environment]::SetEnvironmentVariable("GH_PROXY_URL", "http://<proxy-host>:8788", "User")'
}
Write-Host "Restart Claude Code / Codex to load the skill."
