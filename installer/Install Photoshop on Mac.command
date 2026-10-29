#!/bin/sh
# One-click install of Sudo Liquid Glass into Photoshop, using Adobe's own plugin installer (comes with Creative Cloud).
cd "$(dirname "$0")"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
if [ ! -x "$UPIA" ]; then
  echo "The Creative Cloud desktop app was not found. Install it, or double-click SudoLiquidGlass.ccx instead."
  exit 1
fi
# Remove any older copy first so upgrades always apply.
"$UPIA" --remove "Sudo Liquid Glass" >/dev/null 2>&1
"$UPIA" --install "$PWD/SudoLiquidGlass.ccx" && echo "Done. Restart Photoshop and open Plugins > Sudo Liquid Glass."
