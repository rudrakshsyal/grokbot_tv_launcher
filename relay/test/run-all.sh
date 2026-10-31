#!/usr/bin/env bash
# Runs every offline relay test. Real keys are removed from the environment so nothing can reach a paid or live API.
cd "$(dirname "$0")/.." || exit 1
fail=0
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# GNU timeout guards against a hung test; macOS has none unless coreutils is installed (gtimeout), so run without it there
TO=$(command -v timeout || command -v gtimeout); TO=${TO:+$TO 180}
export LOG_DIR="$tmp/logs" METRICS_DIR="$tmp/metrics" DATA_DIR="$tmp/data" CHATS_DIR="$tmp/chats"
for t in parser chats metrics budget llm llm-multiturn tv-remote tv-power wol play stt tv-show; do
  out=$(env -u GEMINI_API_KEY -u GOOGLE_API_KEY -u LLM_API_KEY -u TMDB_API_KEY -u TMDB_READ_TOKEN -u OMDB_API_KEY -u YT_API_KEY -u STT_GEMINI_KEY \
        STT_LOG=1 $TO node "test/$t.test.js" 2>&1); code=$?
  if [ $code -eq 0 ]; then echo "PASS  $t: $(printf '%s\n' "$out" | tail -1)"; else fail=1; echo "FAIL  $t"; printf '%s\n' "$out" | tail -15; fi
done
exit $fail
