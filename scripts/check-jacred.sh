#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${JACRED_URL:-http://127.0.0.1:9117}"
QUERY="${1:-matrix}"

echo "JacRed: ${BASE_URL}"
echo

echo "[1/4] health"
curl -fsS --max-time 15 "${BASE_URL}/health"
echo
echo

echo "[2/4] parser/database stats"
curl -fsS --max-time 30 "${BASE_URL}/stats/torrents" | tee /tmp/jacred-stats.json
echo
echo

echo "[3/4] stats metadata"
curl -fsS --max-time 15 "${BASE_URL}/stats/meta"
echo
echo

echo "[4/4] Lampac-compatible search: ${QUERY}"
curl -fsS --max-time 60 -G \
  --data-urlencode "query=${QUERY}" \
  "${BASE_URL}/api/v2.0/indexers/all/results" \
  | tee /tmp/jacred-search.json
echo

if command -v jq >/dev/null 2>&1; then
  echo
  echo "Search result count:"
  jq -r 'if (.Results | type) == "array" then (.Results | length) else "Results array not found" end' /tmp/jacred-search.json
fi

echo
echo "Smoke check completed."
