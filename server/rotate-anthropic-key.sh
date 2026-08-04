#!/bin/bash
# Rotate the Anthropic API key used by slamado.ng.
#
# One key serves two consumers, and both read the SAME file:
#   - nginx's /api/anthropic/ proxy (the astrology site) — via `include`
#   - the wheel's image service (server/llm.mjs) — parsed straight out of it
# So this script edits exactly one file, then reloads nginx. The image service
# re-reads the file per call and needs no restart.
#
# Run it on the Mac mini:
#   ssh -t macmini "~/Sites/wheel-of-the-year/server/rotate-anthropic-key.sh"
#
# It prompts for the key with echo off, so the secret never reaches your shell
# history or the process list. The new key is verified against the API BEFORE
# the file is overwritten — a typo can't take the sites down.

set -euo pipefail

KEY_FILE="${ANTHROPIC_KEY_FILE:-/opt/homebrew/etc/nginx/anthropic-key.conf}"
NGINX="${NGINX_BIN:-/opt/homebrew/bin/nginx}"
PROXY_URL="${PROXY_URL:-http://127.0.0.1:8080/api/anthropic/v1/models}"

die() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

[ -d "$(dirname "$KEY_FILE")" ] || die "No nginx config dir at $(dirname "$KEY_FILE") — is this the Mac mini?"
[ -x "$NGINX" ] || die "nginx not found at $NGINX (set NGINX_BIN=...)"

# ── 1. Read the new key (hidden) ─────────────────────────────────────────────
printf 'Paste the new Anthropic key (input hidden), then press Return:\n> '
read -rs NEW_KEY
printf '\n'

NEW_KEY="${NEW_KEY//[[:space:]]/}"                       # strip stray whitespace/newlines
[ -n "$NEW_KEY" ] || die "No key entered."
case "$NEW_KEY" in
  sk-ant-*) ;;
  *) die "That doesn't look like an Anthropic key (expected it to start with 'sk-ant-')." ;;
esac
case "$NEW_KEY" in
  *'"'*|*';'*) die "Key contains a quote or semicolon — that would break the nginx directive." ;;
esac
[ "${#NEW_KEY}" -ge 50 ] || die "Key looks truncated (${#NEW_KEY} chars)."

printf 'Key read: %s…%s (%d chars)\n' "${NEW_KEY:0:14}" "${NEW_KEY: -4}" "${#NEW_KEY}"

# ── 2. Verify it BEFORE writing anything ─────────────────────────────────────
# GET /v1/models is a pure auth check — no tokens generated, nothing billed.
printf 'Verifying against api.anthropic.com… '
code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' https://api.anthropic.com/v1/models \
  -H "x-api-key: $NEW_KEY" -H 'anthropic-version: 2023-06-01' || echo 000)
case "$code" in
  200) printf 'OK (200)\n' ;;
  000) die "Couldn't reach api.anthropic.com. Nothing was changed." ;;
  *)   die "API rejected the key (HTTP $code). Nothing was changed." ;;
esac

# ── 3. Back up, then write atomically with 600 perms ─────────────────────────
if [ -f "$KEY_FILE" ]; then
  backup="${KEY_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$KEY_FILE" "$backup"
  chmod 600 "$backup"
  printf 'Backed up old key → %s\n' "$backup"
fi

umask 077
tmp="${KEY_FILE}.tmp.$$"
cat > "$tmp" <<EOF
# Anthropic API key for the /api/anthropic/ proxy AND the wheel image service.
# ROTATE at console.anthropic.com, then re-run:
#   ~/Sites/wheel-of-the-year/server/rotate-anthropic-key.sh
# Rotated $(date '+%Y-%m-%d %H:%M:%S %Z')
proxy_set_header x-api-key "$NEW_KEY";
EOF
chmod 600 "$tmp"
mv "$tmp" "$KEY_FILE"
printf 'Wrote %s (chmod 600)\n' "$KEY_FILE"

# ── 4. Test the config, then reload nginx ────────────────────────────────────
printf 'Testing nginx config… '
"$NGINX" -t >/dev/null 2>&1 || { "$NGINX" -t; die "nginx config test FAILED — key file written but NOT reloaded."; }
printf 'OK\n'

printf 'Reloading nginx… '
"$NGINX" -s reload
sleep 1
printf 'done\n'

# ── 5. Verify through the proxy the astrology site actually uses ─────────────
printf 'Checking the /api/anthropic/ proxy… '
code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$PROXY_URL" || echo 000)
case "$code" in
  200) printf 'OK (200)\n' ;;
  *)   die "Proxy returned HTTP $code. The key is valid, so check the nginx include in daily-astrology.conf." ;;
esac

cat <<'EOF'

✓ Key rotated.
  · Astrology site  — live now (nginx reloaded).
  · Wheel of the Year — picks it up on its next LLM call; the image service
    re-reads this file every time, so there is nothing to restart.

Confirm the wheel is on Claude rather than the Ollama fallback by watching for
"[llm] Anthropic call failed" the next time a new city loads:

  tail -f ~/Library/Logs/wheel-image-server.log
EOF
