# Sudo Liquid Glass for Illustrator (Windows and macOS)

Two parts that work together:
- **The plug-in** (`LiquidGlass.aip`, C++, Illustrator SDK): a Live Effect, **Effect › Stylize › Liquid Glass**. It renders the glass and keeps it live.
- **The panel** (`SudoLiquidGlassPanel.zxp`, HTML, CEP): **Window › Extensions › Sudo Liquid Glass**. Make Glass, looks and every setting, like the Photoshop panel. It's the same code on Windows and Mac.

## How it works
- **Rendering** (`Source/LiquidGlassPlugin.cpp`, `RenderGlass`):
  1. rasterize the art *below* the glass (via `srcArt`) as the backdrop, and the shape itself as the mask (one mask per child of a group, so separate shapes merge like liquid; text is one mask, so letters don't melt together);
  2. run `lg_render` from `glass_core` (linked as a static library);
  3. return [shadow raster, glass raster] in place of the shape.
- **Strokes** reach the effect outlined (`kOutlinedStrokeInputArt`), so stroked paths and variable-width profiles become glass too.
- **Panel ↔ plug-in:** the panel calls `lg(selector, input)` in `cep/host.jsx`, which calls `app.sendScriptMessage("LiquidGlass", …)`. The plug-in answers in `Script()`:
  - `state`: what's selected, as JSON (`doc`, `n` objects, `glass` count, `w` document width, `p` settings of the selected glass);
  - `make`: the selected objects become glass with the panel's settings (several objects are grouped first, so they melt together); edge width and blur are sized to the shape;
  - `apply`: the selected glasses take the new settings (a new appearance, one undo step);
  - `refresh`: every glass re-reads what's behind it.
  - The panel polls `state` twice a second and sends changes as you drag (one request at a time, newest wins).
- **Effect menu / Appearance panel:** Effect › Stylize › Liquid Glass applies at once, sized to the shape, and opens the panel. Double-clicking Liquid Glass in the Appearance panel also opens the panel (via PlugPlug `LoadExtension`).
- **Keeping the background current:**
  - automatic: a document-changed notifier compares the newest edit time and item count of the art below each glass, and marks the glass dirty so Illustrator re-runs it;
  - manual: **Refresh** in the panel, or **Object › Refresh All Liquid Glass**.
- **Refused, with the reason shown:** pixel images (raster or placed), groups that contain an image, and a second Liquid Glass on an object that has one. A CMYK document gets a one-time warning that colours are worked out in RGB.
- **Log for bug reports:** Windows `%APPDATA%\Sudo Liquid Glass\log.txt`, macOS `~/Library/Logs/Sudo Liquid Glass.log`.
- **Shared with Photoshop:** the looks, defaults and icons come from `../photoshop/looks.js` (`cep/stage.js` copies it in).

## Tried and removed
- A modal settings window (WebView2, 0.7.0): replaced by the panel in 0.8.0, which works on Mac too and stays open.
- A toolbar tool and Alt + double-click: built during 0.7.0 and removed, because they didn't work for the owner in Illustrator 2026. Illustrator also doesn't let plug-ins add clickable widgets to its Selection tool.

## Build
**Windows** (Visual Studio C++ Build Tools, Node, the [Illustrator SDK](https://developer.adobe.com/console), and `ZXPSignCmd.exe` from [Adobe-CEP/CEP-Resources](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD)):
```bash
powershell -ExecutionPolicy Bypass -File build.ps1 -SDK "<unzipped Illustrator SDK>" -ZXPSignCmd "<path to ZXPSignCmd.exe>"
```
It builds `build\LiquidGlass.aip` and `build\SudoLiquidGlassPanel.zxp` and installs both (one UAC prompt; Illustrator must be closed). Add `-NoInstall` to only build.

**macOS** (Xcode command line tools, Rust with `aarch64-apple-darwin` and `x86_64-apple-darwin`, Node, Python 3):
```bash
sh build-mac.sh "<Mac Illustrator SDK folder>" "<path to ZXPSignCmd>"
```
It builds a universal `dist/mac/LiquidGlass.aip` (Apple Silicon + Intel, ad-hoc signed) and `dist/mac/SudoLiquidGlassPanel.zxp`.

**On GitHub:** `.github/workflows/illustrator-mac.yml` runs `build-mac.sh` on GitHub's Mac machines for every `v*` tag (and pushes to `ci/**` branches) and attaches the Mac files to the release. The Mac SDK comes from a **private** repository (variable `ILLUSTRATOR_SDK_REPO`) through a read-only deploy key (secret `ILLUSTRATOR_SDK_KEY`), because Adobe's licence forbids publishing it.

## Test
```bash
node cep/panel.test.js
```
Loads the panel with a fake Illustrator and checks Make Glass, live editing and loading the selected glass's settings. It's part of `npm test`.

## Status
- **Windows:** built and installed on the dev machine.
- **macOS:** built on GitHub's Mac machines. Not yet tried on a real Mac: please report how it goes.
- Needs Illustrator 2026 (the plug-in is built with the Illustrator 2026 SDK).
