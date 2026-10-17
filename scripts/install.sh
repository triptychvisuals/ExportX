#!/usr/bin/env bash
# Install ExportX into DaVinci Resolve's Workflow Integration Plugins folder (macOS / Linux).
#
#   bash scripts/install.sh           copy the plugin (release-style install)
#   bash scripts/install.sh --link    symlink the repo instead (edits take effect on next launch)
#   bash scripts/install.sh --uninstall
#
# The folder is usually root-owned, so expect a sudo prompt.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="copy"
case "${1:-}" in
  --link) MODE="link" ;;
  --uninstall) MODE="uninstall" ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

case "$(uname -s)" in
  Darwin)
    PLUGIN_ROOT="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins"
    DEV_ROOT="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer"
    ;;
  Linux)
    PLUGIN_ROOT="/opt/resolve/Workflow Integration Plugins"
    DEV_ROOT="/opt/resolve/Developer"
    ;;
  *)
    echo "Use scripts/install.ps1 on Windows." >&2; exit 1 ;;
esac

TARGET="$PLUGIN_ROOT/ExportX"
NODE_MODULE="$DEV_ROOT/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"
SUDO=""
if [ ! -w "$PLUGIN_ROOT" ] 2>/dev/null; then SUDO="sudo"; fi

if [ "$MODE" = "uninstall" ]; then
  echo "Removing $TARGET"
  $SUDO rm -rf "$TARGET"
  echo "Done. Restart Resolve."
  exit 0
fi

if [ ! -d "$DEV_ROOT" ]; then
  echo "Resolve's Developer folder was not found at: $DEV_ROOT" >&2
  echo "Is DaVinci Resolve Studio 18 or newer installed?" >&2
  exit 1
fi

# Make sure the native binding is available next to main.js.
if [ ! -f "$HERE/WorkflowIntegration.node" ]; then
  if [ -f "$NODE_MODULE" ]; then
    echo "Copying WorkflowIntegration.node from Resolve's sample plugin"
    cp "$NODE_MODULE" "$HERE/WorkflowIntegration.node"
  else
    echo "WorkflowIntegration.node not found at: $NODE_MODULE" >&2
    echo "Copy it from your Resolve install into $HERE and run this again." >&2
    exit 1
  fi
fi

$SUDO mkdir -p "$PLUGIN_ROOT"

if [ "$MODE" = "link" ]; then
  echo "Linking $TARGET -> $HERE"
  $SUDO rm -rf "$TARGET"
  $SUDO ln -s "$HERE" "$TARGET"
else
  echo "Installing to $TARGET"
  $SUDO rm -rf "$TARGET"
  $SUDO mkdir -p "$TARGET"
  for item in manifest.xml package.json main.js preload.js WorkflowIntegration.node src ui profiles LICENSE; do
    $SUDO cp -R "$HERE/$item" "$TARGET/"
  done
fi

echo
echo "Installed. Restart DaVinci Resolve Studio, then open Workspace > Workflow Integrations > ExportX."
