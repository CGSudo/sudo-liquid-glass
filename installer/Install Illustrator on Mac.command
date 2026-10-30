#!/bin/sh
# One-click install of Sudo Liquid Glass into Illustrator on macOS: the plug-in (LiquidGlass.aip) into every
# Illustrator's Plug-ins folder, then the panel (.zxp) with Adobe's own installer.
cd "$(dirname "$0")"
if pgrep -x "Adobe Illustrator" >/dev/null; then
  echo "Please quit Illustrator first, then run this again."
  exit 1
fi
if [ ! -f LiquidGlass-mac.aip.zip ] || [ ! -f SudoLiquidGlassPanel-mac.zxp ]; then
  echo "LiquidGlass-mac.aip.zip or SudoLiquidGlassPanel-mac.zxp is missing. Unzip the whole download first."
  exit 1
fi
TMP="$(mktemp -d)"
ditto -x -k LiquidGlass-mac.aip.zip "$TMP"
FOUND=0
for AI in /Applications/Adobe\ Illustrator*; do
  [ -d "$AI/Plug-ins" ] || continue
  echo "Installing into $AI (macOS may ask for your password)."
  DEST="$AI/Plug-ins/Liquid Glass"
  sudo mkdir -p "$DEST"
  sudo rm -rf "$DEST/LiquidGlass.aip"
  sudo ditto "$TMP/LiquidGlass.aip" "$DEST/LiquidGlass.aip"
  # Downloaded files are quarantined by macOS; Illustrator can't load a quarantined plug-in.
  sudo xattr -dr com.apple.quarantine "$DEST/LiquidGlass.aip"
  FOUND=1
done
rm -rf "$TMP"
[ "$FOUND" = 1 ] || echo "No Illustrator was found in /Applications."
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
if [ -x "$UPIA" ]; then
  "$UPIA" --install "$PWD/SudoLiquidGlassPanel-mac.zxp"
else
  echo "The Creative Cloud desktop app was not found, so the panel wasn't installed."
fi
echo "Done. Start Illustrator, then open Window > Extensions > Sudo Liquid Glass."
