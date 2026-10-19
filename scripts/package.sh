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
for item in manifest.xml package.json main.js preload.js src ui profiles LICENSE README.md docs scripts python "Install ExportX.command" "Install ExportX.cmd"; do
  cp -R "$HERE/$item" "$STAGE/"
done
# The browser preview and the screenshots are for the repository, not the plugin folder.
rm -rf "$STAGE/docs/screenshots" "$STAGE/docs/preview.html"
chmod +x "$STAGE/Install ExportX.command" "$STAGE/scripts/install.sh"
(cd "$OUT" && rm -f "ExportX-$VERSION.zip" && zip -qr "ExportX-$VERSION.zip" ExportX)
rm -rf "$STAGE"
echo "Wrote $OUT/ExportX-$VERSION.zip"
