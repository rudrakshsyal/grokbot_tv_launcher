#!/bin/sh
# One-time Trakt sign-in for a PKCE Trakt app (no client secret). Run on your computer (macOS, Linux or Git Bash on Windows), in the repo, before packaging:
#   TRAKT_CLIENT_ID=... sh tools/trakt-link.sh
# 1. Prints an authorize URL; open it, sign in, click Yes.
# 2. Trakt redirects to http://localhost/?code=XXXX. The page won't load; that's expected. Copy the address bar.
# 3. Paste the whole URL (or just the code) here. The script swaps it for tokens and saves them to
#    .secrets/trakt-tokens.json (mode 600). tools/make-dist.sh bakes them into dist/js/config.js; the TV then
#    refreshes them on its own (access token: 7 days, refreshed automatically).
# Needs only sh, curl and openssl (all built into macOS). Tokens are never printed.
set -eu
cd "$(dirname "$0")/.."
[ -n "${TRAKT_CLIENT_ID:-}" ] || { echo "Set TRAKT_CLIENT_ID first (your Trakt app's Client ID)."; exit 1; }
REDIRECT="${TRAKT_REDIRECT_URI:-http://localhost}"
API="https://api.trakt.tv"

# PKCE: random verifier (64 chars of A-Z a-z 0-9) and its S256 challenge (base64url, no padding)
VERIFIER=$(openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')
STATE=$(openssl rand -hex 8)
enc() { printf '%s' "$1" | sed 's/:/%3A/g; s#/#%2F#g'; }
URL="https://trakt.tv/oauth/authorize?response_type=code&client_id=$TRAKT_CLIENT_ID&redirect_uri=$(enc "$REDIRECT")&state=$STATE&code_challenge=$CHALLENGE&code_challenge_method=S256"

echo
echo "1) Open this URL, sign in to Trakt and approve your app:"
echo
echo "   $URL"
echo
command -v open >/dev/null 2>&1 && open "$URL" 2>/dev/null || true
echo "2) Your browser then lands on a page that won't load (http://localhost/?code=...). That's expected."
printf "   Paste the whole address-bar URL (or just the code) here: "
read -r INPUT
CODE=$(printf '%s' "$INPUT" | sed -n 's/.*[?&]code=\([^&#]*\).*/\1/p')
[ -n "$CODE" ] || CODE=$(printf '%s' "$INPUT" | tr -d ' \r\n')
GOT_STATE=$(printf '%s' "$INPUT" | sed -n 's/.*[?&]state=\([^&#]*\).*/\1/p')
if [ -n "$GOT_STATE" ] && [ "$GOT_STATE" != "$STATE" ]; then echo "State mismatch: that URL is from a different sign-in. Run again."; exit 1; fi

mkdir -p .secrets && chmod 700 .secrets
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
STATUS=$(curl -sS -o "$TMP" -w '%{http_code}' -X POST "$API/oauth/token" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"client_id\":\"$TRAKT_CLIENT_ID\",\"code_verifier\":\"$VERIFIER\",\"redirect_uri\":\"$REDIRECT\",\"grant_type\":\"authorization_code\"}")
if [ "$STATUS" != "200" ] || ! grep -q '"access_token"' "$TMP"; then
  echo "Trakt refused the code (HTTP $STATUS). Codes are single-use and expire in about 10 minutes; run the script again."
  exit 1
fi
umask 077; cp "$TMP" .secrets/trakt-tokens.json; chmod 600 .secrets/trakt-tokens.json
TOKEN=$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' .secrets/trakt-tokens.json)
USER=$(curl -sS "$API/users/settings" -H "Authorization: Bearer $TOKEN" -H 'trakt-api-version: 2' -H "trakt-api-key: $TRAKT_CLIENT_ID" \
  | sed -n 's/.*"user":{"username":"\([^"]*\)".*/\1/p')
echo
echo "Linked Trakt account: ${USER:-(unknown)}. Tokens saved to .secrets/trakt-tokens.json (not printed)."
echo "Next: sh tools/make-dist.sh   (bakes the tokens into dist/js/config.js; keep dist/ and the .wgt private)"
