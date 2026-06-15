#!/usr/bin/env sh
# Installs the gh-proxy skill into Claude Code and Codex from a repo checkout.
# (For a running server you can instead use: curl -fsSL <base>/install.sh | sh)
#
#   ./scripts/install-skill.sh [proxy-url] [claude|codex|both]
set -eu

SRC="$(cd "$(dirname "$0")/../skills/gh-proxy" && pwd)"
PROXY_URL="${1:-}"
TARGET="${2:-both}"

install_to() {
    label="$1"; dst="$2"
    mkdir -p "$dst"
    cp -R "$SRC/." "$dst/"
    echo "Installed $label skill: $dst"
}

case "$TARGET" in
    claude|both) install_to "Claude Code" "$HOME/.claude/skills/gh-proxy" ;;
esac
case "$TARGET" in
    codex|both) install_to "Codex CLI" "$HOME/.codex/skills/gh-proxy" ;;
esac

if [ "$PROXY_URL" != "" ]; then
    PROFILE="$HOME/.profile"
    if ! grep -qs "GH_PROXY_URL" "$PROFILE"; then
        printf '\nexport GH_PROXY_URL=%s\n' "$PROXY_URL" >> "$PROFILE"
        echo "Added GH_PROXY_URL=$PROXY_URL to $PROFILE (open a new shell to apply)"
    else
        echo "GH_PROXY_URL already present in $PROFILE — not modified."
    fi
else
    echo "Tip: export GH_PROXY_URL=http://<proxy-host>:8788 (and GH_PROXY_TOKEN if required)."
fi
echo "Restart Claude Code / Codex to load the skill."
