#!/usr/bin/env bash
# Build dist/ExportX-<version>.zip containing only what Resolve needs.
# WorkflowIntegration.node is NOT included: it is Blackmagic's binary and is
# platform specific; the install scripts copy it from the local Resolve install.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version")"
OUT="$HERE/dist"
STAGE="$OUT/ExportX"
rm -rf "$STAGE"
mkdir -p "$STAGE"
for item in manifest.xml package.json main.js preload.js src ui profiles LICENSE README.md docs scripts python; do
  cp -R "$HERE/$item" "$STAGE/"
done
(cd "$OUT" && rm -f "ExportX-$VERSION.zip" && zip -qr "ExportX-$VERSION.zip" ExportX)
rm -rf "$STAGE"
echo "Wrote $OUT/ExportX-$VERSION.zip"
