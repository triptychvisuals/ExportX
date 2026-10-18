#!/usr/bin/env bash
# Build dist/exportx-portal-kit.zip: everything the portal team (or Claude Code in
# the portal repo) needs to implement the ExportX ingest API. Standalone: the
# plugin's client is copied in, so nothing references the rest of this repo.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version")"
OUT="$HERE/dist"
STAGE="$OUT/exportx-portal-kit"
rm -rf "$STAGE"
mkdir -p "$STAGE/client"
cp -R "$HERE/portal-kit/README.md" "$HERE/portal-kit/CLAUDE_CODE_PROMPT.md" "$HERE/portal-kit/openapi.yaml" \
      "$HERE/portal-kit/schema" "$HERE/portal-kit/examples" "$HERE/portal-kit/reference-server" "$HERE/portal-kit/smoke" "$STAGE/"
cp "$HERE/src/portal.js" "$STAGE/client/portal.js"
cp "$HERE/LICENSE" "$STAGE/LICENSE"
cat > "$STAGE/VERSION" <<TXT
ExportX portal kit
protocol: 1
exportx: $VERSION
source: https://github.com/triptychvisuals/ExportX/tree/main/portal-kit
TXT
(cd "$OUT" && rm -f exportx-portal-kit.zip && zip -qr exportx-portal-kit.zip exportx-portal-kit -x '*.DS_Store')
rm -rf "$STAGE"
echo "Wrote $OUT/exportx-portal-kit.zip"
