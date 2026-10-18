#!/usr/bin/env bash
# The ExportX upload flow as four curl calls.
#   bash curl.sh https://portal.example.com <token>
set -euo pipefail
BASE="${1:?portal url}"; TOKEN="${2:?token}"
BASE="${BASE%/}"; case "$BASE" in */api/exportx) ;; *) BASE="$BASE/api/exportx";; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH="Authorization: Bearer $TOKEN"

echo "1. ping"
curl -fsS -H "$AUTH" "$BASE/ping"; echo

echo "2. create batch"
TMP="$(mktemp -d)"
printf 'ExportX smoke test, final\n' > "$TMP/261018_Smoke_Final.mp4"
SIZE=$(wc -c < "$TMP/261018_Smoke_Final.mp4" | tr -d ' ')
MANIFEST=$(cat <<JSON
{"source":"exportx","exportxVersion":"smoke","project":"ExportX smoke","timeline":"Smoke Test","fps":24,
 "exportedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","namePattern":"{yymmdd}_{project}_{label}","category":null,
 "files":[{"key":"smoke-1","fileName":"261018_Smoke_Final.mp4","kind":"final","label":"Final","deliverableId":"final-4k-h265",
  "deliverableName":"Final 4K","timeline":"Smoke Test","format":"mp4","codec":"H265","width":3840,"height":2160,
  "tcIn":null,"tcOut":null,"durationFrames":null,"markIndex":null,"bytes":$SIZE,"modifiedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}]}
JSON
)
RESP=$(curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "$MANIFEST" "$BASE/batches"); echo "$RESP"
BATCH=$(printf '%s' "$RESP" | sed -n 's/.*"batchId":"\([^"]*\)".*/\1/p')
[ -n "$BATCH" ] || { echo "no batchId in response"; exit 1; }

echo "3. upload file"
curl -fsS -X PUT -H "$AUTH" -H 'Content-Type: application/octet-stream' -H 'X-ExportX-Filename: 261018_Smoke_Final.mp4' \
  --data-binary "@$TMP/261018_Smoke_Final.mp4" "$BASE/batches/$BATCH/files/smoke-1"; echo

echo "4. complete"
curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d '{"uploaded":["smoke-1"],"failed":[]}' "$BASE/batches/$BATCH/complete"; echo
rm -rf "$TMP"
echo "OK"
