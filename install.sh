#!/bin/sh
# macOS: packages the Photoshop plugin as dist/SudoLiquidGlass.ccx and installs it with Adobe's installer (UPIA).
#   sh install.sh [--no-install]
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/SudoLiquidGlass.ccx
# A .ccx is a zip of the plugin folder (tests left out).
(cd photoshop && zip -qr ../dist/SudoLiquidGlass.ccx . -x '*.test.js')
echo "Packaged dist/SudoLiquidGlass.ccx"
[ "$1" = "--no-install" ] && exit 0
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
if [ ! -x "$UPIA" ]; then
  echo "Adobe's plugin installer wasn't found. Install the Creative Cloud desktop app, or double-click dist/SudoLiquidGlass.ccx." >&2
  exit 1
fi
"$UPIA" --install "$PWD/dist/SudoLiquidGlass.ccx"
