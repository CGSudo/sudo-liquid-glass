# Sudo Liquid Glass for Illustrator (Windows)

A native Illustrator **Live Effect**: **Effect › Stylize › Liquid Glass…**. It lives in the Appearance panel, and Illustrator re-runs it whenever the shape changes.

## How it works
- **Go** (`Source/LiquidGlassPlugin.cpp`, `RenderGlass`):
  1. rasterize the art *below* the glass (via `srcArt`) as the backdrop, and the shape itself as the mask (one mask per child of a group, so separate shapes merge like liquid; text is one mask, so letters don't melt together);
  2. run `lg_render` from `glass_core` (linked as a static library);
  3. return [shadow raster, glass raster] in place of the shape.
- **Strokes** reach the effect outlined (`kOutlinedStrokeInputArt`), so stroked paths and variable-width profiles become glass too.
- **Settings window** (`Source/LiquidGlassDialog.cpp`): `ui/panel.html` in a WebView2 control inside a modal popup.
  - Looks, defaults and icons come from `../photoshop/looks.js`, which `build.ps1` inlines, so Photoshop and Illustrator always match.
  - Quick controls, tabs, hover help, inner glow, stroke, saved looks (`%APPDATA%\Sudo Liquid Glass\presets.json`).
  - One window at a time and truly modal: while it's open the rest of Illustrator ignores clicks, so a second click in the Appearance panel can't open a second copy.
- **Opening the settings:** double-click Liquid Glass in the Appearance panel, or **Object › Edit Liquid Glass…** (assign a shortcut in Edit › Keyboard Shortcuts).
- **Keeping the background current:**
  - automatic: a document-changed notifier compares the newest edit time and item count of the art below each glass, and marks the glass dirty so Illustrator re-runs it;
  - manual: **Object › Refresh All Liquid Glass**, or **Refresh** in the settings window.
- **Refused, with the reason shown:** pixel images (raster or placed), groups that contain an image, and a second Liquid Glass on an object that has one. A CMYK document gets a one-time warning that colours are worked out in RGB.
- **Log for bug reports:** `%APPDATA%\Sudo Liquid Glass\log.txt`.

## Tried and removed
- **A toolbar tool** and **Alt + double-click** to open the settings were built in 0.7.0 development and removed: the owner found neither worked reliably in Illustrator 2026. Illustrator also doesn't let plug-ins add clickable widgets to its own Selection tool.

## Build and install
Needs:
- Visual Studio C++ Build Tools 2019 or 2022;
- the [Illustrator SDK](https://developer.adobe.com/console) (not in this repo: its licence forbids redistribution);
- the Microsoft.Web.WebView2 NuGet package, unpacked (`nuget.org/packages/Microsoft.Web.WebView2`).

```bash
powershell -ExecutionPolicy Bypass -File build.ps1 -SDK "<unzipped Illustrator SDK>" -WebView2 "<unpacked WebView2 package>"
```
The script builds the Rust engine, writes the PIPL, builds `build\LiquidGlass.aip`, and installs it into every `C:\Program Files\Adobe\Adobe Illustrator *\Plug-ins` folder (one UAC prompt). Add `-NoInstall` to only build. Illustrator must be closed to install.

## Test without Illustrator
```bash
powershell -ExecutionPolicy Bypass -File test/run_test.ps1
```
Runs the settings window on its own, applies a look, turns the stroke on, sets the glow blend, presses OK and checks the values that come back.

## Status
- Windows only. A Mac build needs Xcode on a Mac, the Mac Illustrator SDK and a WKWebView version of the settings window.
- Needs Windows 10 or 11 with the Microsoft Edge WebView2 Runtime (built into Windows 11).
