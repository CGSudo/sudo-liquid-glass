#!/bin/sh
# Builds the Illustrator plug-in for macOS (universal: Apple Silicon + Intel) and the signed panel.
#   sh illustrator/build-mac.sh <unzipped Mac Illustrator SDK> [<ZXPSignCmd>]
# Output: dist/mac/LiquidGlass.aip (a bundle) and dist/mac/SudoLiquidGlassPanel.zxp.
# Needs Xcode command line tools, Rust (targets aarch64-apple-darwin + x86_64-apple-darwin), Node and Python 3.
set -eu
SDK="$(cd "$1" && pwd)"
SIGN="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/dist/mac"
OBJ="$OUT/obj"
rm -rf "$OUT" && mkdir -p "$OBJ"

# Rust engine: one static library holding both architectures.
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  MACOSX_DEPLOYMENT_TARGET=12.0 cargo build -p glass_core --release --target "$t" --manifest-path "$ROOT/Cargo.toml"
done
lipo -create "$ROOT/target/aarch64-apple-darwin/release/libglass_core.a" "$ROOT/target/x86_64-apple-darwin/release/libglass_core.a" \
  -output "$OBJ/libglass_core.a"

# Plug-in sources + the SDK's shared plug-in code, compiled as Objective-C++ like Adobe's sample projects.
# The SDK folder name has spaces ("Adobe Illustrator 2026 SDK"): reach it through a space-free link for the flags below.
LINK="$(mktemp -d)/sdk"
ln -s "$SDK" "$LINK"
COMMON="$LINK/samplecode/common"
API="$LINK/illustratorapi"
SRC="$HERE/Source/LiquidGlassPlugin.cpp $HERE/Source/LiquidGlassSuites.cpp \
  $COMMON/source/AppContext.cpp $COMMON/source/IllustratorSDK.cpp $COMMON/source/Main.cpp $COMMON/source/Plugin.cpp \
  $COMMON/source/Suites.cpp $COMMON/source/SDKPlugPlug.cpp $API/illustrator/IAIUnicodeString.cpp $API/illustrator/IAIFilePath.cpp"
FLAGS="-arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -std=c++17 -stdlib=libc++ -x objective-c++ -O2 -fvisibility=default
  -I$HERE/Source -I$COMMON/includes -I$API/ate -I$API/illustrator -I$API/illustrator/actions -I$API/pica_sp -I$API/illustrator/legacy
  -include $COMMON/includes/IllustratorSDK.h -Wno-deprecated-declarations"
OBJS=""
for f in $SRC; do
  o="$OBJ/$(basename "$f" .cpp).o"
  clang++ $FLAGS -c "$f" -o "$o"
  OBJS="$OBJS $o"
done

# Bundle: Contents/MacOS/LiquidGlass, Info.plist, PkgInfo and the PiPL Illustrator reads to load it.
B="$OUT/LiquidGlass.aip/Contents"
mkdir -p "$B/MacOS" "$B/Resources/pipl"
clang++ -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -bundle -stdlib=libc++ $OBJS "$OBJ/libglass_core.a" \
  -framework CoreFoundation -framework Cocoa -o "$B/MacOS/LiquidGlass"
(cd "$OBJ" && python3 "$SDK/tools/pipl/create_pipl.py" -input '[{"name":"LiquidGlass","entry_point":"PluginMain"}]' && cp plugin.pipl "$B/Resources/pipl/plugin.pipl")
VERSION="$(sed -n 's/.*kVersion = "\([^"]*\)".*/\1/p' "$HERE/Source/LiquidGlass.h")"
cat > "$B/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>LiquidGlass</string>
  <key>CFBundleIdentifier</key><string>com.cgsudo.illustrator.liquidglass</string>
  <key>CFBundleName</key><string>LiquidGlass</string>
  <key>CFBundlePackageType</key><string>ARPI</string>
  <key>CFBundleSignature</key><string>ART5</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
</dict></plist>
EOF
printf 'ARPIART5' > "$B/PkgInfo"
# Ad-hoc signature: Apple Silicon refuses to load unsigned code.
codesign --force --deep --sign - "$OUT/LiquidGlass.aip"
lipo -info "$B/MacOS/LiquidGlass"
echo "Built $OUT/LiquidGlass.aip"

# Panel: same files as on Windows, signed on macOS (Adobe recommends signing on the platform that installs it).
if [ -n "$SIGN" ]; then
  node "$HERE/cep/stage.js" "$OUT/cep"
  PASS="$(openssl rand -hex 16)"
  "$SIGN" -selfSignedCert US CA CGSudo "Sudo Liquid Glass" "$PASS" "$OBJ/cert.p12" >/dev/null
  "$SIGN" -sign "$OUT/cep" "$OUT/SudoLiquidGlassPanel.zxp" "$OBJ/cert.p12" "$PASS" >/dev/null
  rm -f "$OBJ/cert.p12"
  "$SIGN" -verify "$OUT/SudoLiquidGlassPanel.zxp"
  echo "Built $OUT/SudoLiquidGlassPanel.zxp"
fi
