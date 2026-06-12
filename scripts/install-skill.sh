#!/usr/bin/env sh
# Installs the gh-proxy skill into ~/.claude/skills for Claude Code.
#
#   ./scripts/install-skill.sh http://proxy.internal:8788
set -eu

SRC="$(cd "$(dirname "$0")/../skills/gh-proxy" && pwd)"
DST="$HOME/.claude/skills/gh-proxy"

mkdir -p "$DST"
cp -R "$SRC/." "$DST/"
echo "Installed skill: $DST"

if [ "${1:-}" != "" ]; then
    PROFILE="$HOME/.profile"
    if ! grep -qs "GH_PROXY_URL" "$PROFILE"; then
        printf '\nexport GH_PROXY_URL=%s\n' "$1" >> "$PROFILE"
        echo "Added GH_PROXY_URL=$1 to $PROFILE (open a new shell to apply)"
    else
        echo "GH_PROXY_URL already present in $PROFILE — not modified."
    fi
else
    echo "Tip: export GH_PROXY_URL=http://<proxy-host>:8788 so the skill finds the proxy automatically."
fi
