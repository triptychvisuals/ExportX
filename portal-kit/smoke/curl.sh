#!/usr/bin/env bash
# The ExportX upload flow as curl calls, against a portal (or the reference server).
#   bash curl.sh https://portal.example.com <key> [projectId]
set -euo pipefail
BASE="${1:?portal url}"; TOKEN="${2:?plugin key}"; PROJECT="${3:-}"
BASE="${BASE%/}"; BASE="$(printf '%s' "$BASE" | sed -E 's#/api(/.*)?$##')"
AUTH="Authorization: Bearer $TOKEN"
json() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

echo "1. ping"
curl -fsS -H "$AUTH" "$BASE/api/plugin/ping"; echo

echo "2. projects"
PROJECTS=$(curl -fsS -H "$AUTH" "$BASE/api/plugin/projects")
[ -n "$PROJECT" ] || PROJECT=$(printf '%s' "$PROJECTS" | json 'd["projects"][0]["id"]')
echo "   using project $PROJECT"

echo "3. the project's boxes"
curl -fsS -H "$AUTH" "$BASE/api/plugin/deliverables?projectId=$PROJECT" | json '", ".join(b["name"] for b in d["boxes"]) or "(no boxes)"'

echo "4. upload one file"
TMP="$(mktemp -d)"
printf 'ExportX smoke test, final\n' > "$TMP/261018_Smoke_Final.mp4"
SIZE=$(wc -c < "$TMP/261018_Smoke_Final.mp4" | tr -d ' ')
PLAN=$(curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "{\"action\":\"upload_url\",\"projectId\":\"$PROJECT\",\"filename\":\"261018_Smoke_Final.mp4\",\"size\":$SIZE,\"contentType\":\"video/mp4\"}" "$BASE/api/plugin/deliverables")
MODE=$(printf '%s' "$PLAN" | json 'd["mode"]'); PATH_=$(printf '%s' "$PLAN" | json 'd["path"]')
if [ "$MODE" = "tus" ]; then
  PLAN=$(curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "{\"action\":\"upload_url\",\"projectId\":\"$PROJECT\",\"filename\":\"261018_Smoke_Final.mp4\",\"size\":$SIZE,\"contentType\":\"video/mp4\",\"small\":true,\"path\":\"$PATH_\"}" "$BASE/api/plugin/deliverables")
  MODE=$(printf '%s' "$PLAN" | json 'd["mode"]')
fi
if [ "$MODE" = "put" ]; then
  URL=$(printf '%s' "$PLAN" | json 'd["url"]')
  curl -fsS -X PUT -H 'Content-Type: video/mp4' --data-binary "@$TMP/261018_Smoke_Final.mp4" "$URL" > /dev/null
else
  # multipart: this small file is one part
  URL=$(printf '%s' "$PLAN" | json 'd["parts"][0]["url"]'); UPLOAD=$(printf '%s' "$PLAN" | json 'd["uploadId"]')
  ETAG=$(curl -fsS -D - -o /dev/null -X PUT --data-binary "@$TMP/261018_Smoke_Final.mp4" "$URL" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')
  curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "{\"action\":\"complete_upload\",\"projectId\":\"$PROJECT\",\"path\":\"$PATH_\",\"uploadId\":\"$UPLOAD\",\"parts\":[{\"partNumber\":1,\"etag\":\"${ETAG//\"/\\\"}\"}]}" "$BASE/api/plugin/deliverables" > /dev/null
fi
echo "   bytes at $PATH_ ($MODE)"

echo "5. register"
curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "{\"action\":\"register\",\"projectId\":\"$PROJECT\",\"file_path\":\"$PATH_\",\"fileName\":\"261018_Smoke_Final.mp4\",\"kind\":\"final\",\"size_bytes\":$SIZE,\"content_type\":\"video/mp4\",\"deliverableName\":\"Final 4K\",\"meta\":{\"kind\":\"final\",\"resolveProject\":\"Smoke\"}}" "$BASE/api/plugin/deliverables"; echo

echo "6. batch note"
curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -d "{\"action\":\"batch\",\"projectId\":\"$PROJECT\",\"resolveProject\":\"Smoke\",\"timeline\":\"Smoke\",\"uploaded\":[\"Final 4K · 261018_Smoke_Final.mp4\"],\"failed\":[],\"bytes\":$SIZE}" "$BASE/api/plugin/deliverables"; echo
rm -rf "$TMP"
echo "OK"
