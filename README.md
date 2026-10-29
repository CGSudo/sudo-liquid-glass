# Liquid Glass for Photoshop: Sudo Liquid Glass (Apple iOS 26 glass effect plugin)

**Stop faking glass. Make it real, keep it live.**

You know the routine. Merge a copy of the background, blur it, clip it to a shape, paint in some highlights, and it looks… fine. Then the client moves one element and you get to do it all again.

**Sudo Liquid Glass** is a free, open-source Photoshop plugin that turns your own shape and text layers into real, live glass in one click. It's Apple's **Liquid Glass** look from iOS 26 and macOS Tahoe, with true refraction. Nothing gets merged or flattened, and it re-renders whenever anything changes.

> One click. Real refraction. Zero flattened layers.

![Sudo Liquid Glass: engine test render](preview_liquid.png)

**Download:** [latest release (SudoLiquidGlass.ccx)](../../releases/latest) · Photoshop 2023 (v24.2) or newer · Windows and macOS (Intel and Apple Silicon)

> **Honest status:**
> - Tested in Photoshop on Windows.
> - The macOS package has no platform-specific code, but it hasn't been tested on a Mac yet. If you try it, please [open an issue](../../issues).
> - The images here are renders from the plugin's own engine on test shapes, not Photoshop screenshots. Real screenshots and a demo video are coming.

## Why designers switch
- **"I re-did that glass five times today."** Sudo Liquid Glass reads the layers behind your shape on every change. Move the photo, edit the text, nudge the shape: the glass catches up by itself.
- **"Glassmorphism always looks flat."** Real glass *bends* light. The rim refracts what's behind it, splits it into a subtle rainbow, and catches the light like an embossed edge, the way Apple's Liquid Glass does.
- **"Merging layers wrecks my file."** Your shapes and text stay fully editable layers. Undo, re-edit, and hand the file off without fear.
- **"Which layer do I even move?"** Your Layers panel shows your own shapes plus one tidy folder. Clicking the glass selects your shapes, so you always move the right thing.

## Features
- **One click, non-destructive:** select shape or text layers and click **Make Glass**.
- **Live updates:** move, resize or reshape the glass, edit the text, or change anything behind it, and the glass re-renders.
- **Exact outlines:** rectangles, rounded rectangles, ellipses, any Pen tool path (including combined shapes), and the letter outlines of **text**.
- **Liquid merge:** several shapes melt together, growing liquid bridges with rounded inner corners.
- **Real optics:**
  - lens refraction;
  - light dispersion (rainbow edge);
  - frost, vividness, tint;
  - two rim lights with a direction dial;
  - a bevel/emboss that makes the edge look raised.
- **Advanced controls:** emboss strength, rim line width, glass type (index of refraction 1.0 to 2.4, from air to diamond), and sheen.
- **Shadow and Dim background:** a soft drop shadow, plus a dimming halo that keeps glass legible on busy photos.
- **Film grain by film format:** monochrome grain sized from Super 8 to 4×5 large format.
- **Edge effects with Layer Styles:** add strokes (solid or gradient), glows and shadows to your shapes; they follow the real vector edge.
- **Live preview:** a small picture of the selected glass right in the panel.
- **Explained in plain words:** hover over any setting to see what it does.
- **Fast:** the renderer is written in **Rust** and runs as **WebAssembly**. A 1000×1000 render takes about a third of a second.

## Install (Windows and macOS)
1. Download `SudoLiquidGlass.ccx` from the [latest release](../../releases/latest).
2. Double-click it. The Creative Cloud desktop app installs the plugin.
3. Restart Photoshop and open **Plugins › Sudo Liquid Glass**.

If double-clicking doesn't install it, use Adobe's own installer from the command line (Creative Cloud must be installed):
- **macOS:**
  ```bash
  "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" --install ~/Downloads/SudoLiquidGlass.ccx
  ```
- **Windows** (Command Prompt):
  ```bat
  "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install %USERPROFILE%\Downloads\SudoLiquidGlass.ccx
  ```

**Why `.ccx` and not `.zxp`?** ZXP is the package format for Adobe's older CEP extensions. Sudo Liquid Glass is a modern UXP plugin, and Adobe packages those as `.ccx`, the same format its own plugin marketplace uses.

## How to use
1. Draw shapes with a Shape tool or the Pen tool in Shape mode, or type some text.
2. Select one or more of those layers and click **Make Glass**.
3. Fine-tune in the tabs, and hover over any setting for a plain-language explanation:

| Tab | Controls |
|---|---|
| **Glass** | Regular / Clear style, lens strength, edge width, edge softness, dispersion, frost, merge; **Advanced:** emboss, rim line, glass type, sheen |
| **Light** | light direction dial, shine, brightness, vividness, tint |
| **Shadow** | drop shadow; Dim background with spread |
| **Finish** | film grain by film size; strokes, glows and shadows |

- **Adding more:** to add shapes to an existing glass, select the glass plus the new layers and click **Make Glass**, or drag them into the glass group.
- **Moving:** move your shapes or the whole group. Leave the `◆ glass render (automatic)` folder alone; the plugin manages it.
- **Pixel layers:** plain pixel layers can't become glass. Use a shape or text layer.

## How to make Apple's Liquid Glass effect in Photoshop
Without a plugin, you blur a merged copy of the background, clip it to a shape, and add bevels and highlights by hand. That's a static fake, and it breaks the moment anything moves. Sudo Liquid Glass computes real refraction from the live layers behind your shape and keeps it up to date.

## Roadmap
**Today Sudo Liquid Glass is for Photoshop only.** Other apps are plans, not releases:
- [x] **Photoshop**: available now
- [ ] **Illustrator**: planned; early development, not released
- [ ] **After Effects** and **Premiere Pro**: planned, not started
- [ ] GPU rendering, linear-light blending, light/dark adaptive tint

## How it works
```
core/        Rust renderer (glass_core): backdrop + shape masks → glass layer + shadow layer
photoshop/   UXP plugin: panel, live updates, vector and text outline reader, WebAssembly bridge
preview/     renders the preview images from test shapes
docs/        full project history and handoff notes
```
1. Each shape becomes a signed distance field. Several shapes join through a smooth union, which makes the liquid merge.
2. A squircle bevel gives surface normals. Those drive Snell refraction with per-channel dispersion, then bevel shading and two rim lights.
3. The refracted backdrop is frosted, colour-graded and tinted. The shadow and dim halo go on their own layer.
4. To read the backdrop, the plugin hides the glass and everything above it inside a Photoshop history step, then rolls that step back, so your document is never changed by a read.
5. Settings are stored in the glass layer's name, so they survive saving and opening the file on other machines.

Working on the code, or pointing an AI coding agent at it? Start with [AGENTS.md](AGENTS.md) and [docs/PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md).

## Build from source
Needs [Rust](https://rustup.rs) and Node.js. Run `rustup target add wasm32-unknown-unknown` once.
```bash
npm install
```
```bash
npm test
```
After changing the engine, rebuild it and copy `target/wasm32-unknown-unknown/release/glass_core.wasm` into `photoshop/`:
```bash
cargo build -p glass_core --release --target wasm32-unknown-unknown
```
To load it unpackaged, add `photoshop/manifest.json` in Adobe's **UXP Developer Tool**. To package it as `dist/SudoLiquidGlass.ccx` and install it:
- **Windows:**
  ```bash
  powershell -ExecutionPolicy Bypass -File install.ps1
  ```
- **macOS:**
  ```bash
  sh install.sh
  ```

Add `-NoInstall` (Windows) or `--no-install` (macOS) to only build the package.

## Known limits
- RGB documents only.
- Updates land when you release the mouse: Photoshop doesn't run plugins mid-drag.
- Each live update is a history step, so undoing an edit takes two steps.
- Brush strokes don't trigger an update: press **Refresh**.
- Photoshop reopens panels that were open when you quit. Close the panel first if you don't want it at startup.

## About
Made by **CGSudo**. [Connect on LinkedIn](https://www.linkedin.com/in/cgsudo).

## License
[MIT](LICENSE) © CGSudo. Not affiliated with Apple or Adobe. "Liquid Glass" refers to Apple's design material; Photoshop is a trademark of Adobe.
