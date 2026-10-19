#!/bin/bash
# Double-click to install ExportX into DaVinci Resolve Studio (macOS).
# It copies the plugin into Resolve's Workflow Integration Plugins folder and
# asks for your password once, because that folder belongs to the system.
# If macOS says the file "cannot be opened because it is from an unidentified
# developer", right-click it and choose Open, then Open again.
cd "$(dirname "$0")" || exit 1
echo "Installing ExportX into DaVinci Resolve Studio..."
echo
if bash scripts/install.sh; then
  echo
  read -r -p "Done. Restart DaVinci Resolve Studio, then open Workspace > Workflow Integrations > ExportX. Press Return to close. "
else
  echo
  echo "Something went wrong; the lines above say what. Is DaVinci Resolve Studio 18 or newer installed?"
  read -r -p "Press Return to close. "
  exit 1
fi
