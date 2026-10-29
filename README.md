# Sudo Liquid Glass: Apple Liquid Glass effect for Photoshop

**Sudo Liquid Glass** is a free, open-source Photoshop plugin that recreates Apple's **Liquid Glass** material from iOS 26 and macOS Tahoe. You get real, live, refracting glass from your own shape layers in one click, like the glass effect in Figma.

- Not a fake glassmorphism blur: the edges bend light (Snell refraction) and split it into a rainbow (dispersion).
- No merging or flattening layers.
- It updates live when you move or edit anything.

![Sudo Liquid Glass: Apple-style liquid glass effect in Photoshop](preview.png)

**Download:** [latest release (SudoLiquidGlass.ccx)](../../releases/latest) Â· Photoshop 2023 (v24.2) or newer Â· Windows (macOS should work, not yet tested)

## Features
- **One click, non-destructive:** select shape layers and click **Make Glass**. Your shapes stay fully editable vector layers.
- **Live updates:** move, resize or reshape the glass, or anything behind it, and it re-renders by itself.
- **Exact shape:** rectangles, rounded rectangles, ellipses and any Pen tool path, including combined shapes (add, subtract, intersect, exclude).
- **Liquid merge:** several shapes in one glass melt together. Where they come close they grow a liquid bridge and the inner corners round off, like Apple's morphing glass.
- **Real optics:**
  - lens refraction at the rim (index of refraction 1.5),
  - chromatic dispersion,
  - frosted blur,
  - vividness and tint,
  - two rim lights with a light direction dial.
- **Shadow and Dim background:** a soft drop shadow, plus an optional dimming halo that keeps glass legible on busy photos.
- **Film grain:** grain sized by film format: Super 8, 16 mm, 35 mm, 6Ã—6 medium format, 4Ã—5 large format.
- **Edge effects with Layer Styles:** the glass layer is exactly your shape, so Photoshop's own strokes (solid or gradient), glows and shadows trace it and stack.
- **Fast:** the renderer is written in **Rust** and runs as **WebAssembly**. A 1000Ã—1000 glass renders in about 0.3 s.

## Install
1. Download `SudoLiquidGlass.ccx` from the [latest release](../../releases/latest).
2. Double-click it. Creative Cloud installs the plugin.
3. Restart Photoshop and open **Plugins â€º Sudo Liquid Glass**.

## How to use
1. Draw shapes with a Shape tool, or with the Pen tool in Shape mode.
2. Select one or more shape layers and click **Make Glass**.
3. Change the look in the panel's tabs:

| Tab | Controls |
|---|---|
| **Glass** | Regular / Clear look, lens strength, edge thickness, edge curve, rainbow edge, blur, merge distance |
| **Light** | light direction dial, intensity, brightness, vividness, tint colour and strength |
| **Shadow** | drop shadow opacity, softness, distance; Dim background on/off, intensity, halo reach |
| **Finish** | film grain on/off, film format, intensity, grain size; strokes, glows and shadows |

- To add shapes to an existing glass, select the glass plus the new shapes, then click **Make Glass**.
- Plain pixel layers can't become glass: use a shape layer.

## Roadmap
Sudo Liquid Glass aims to bring the same live glass to every Adobe app:
- [x] **Photoshop**: UXP plugin (this repo)
- [ ] **Illustrator**: native Live Effect in the Appearance panel (working prototype)
- [ ] **After Effects** and **Premiere Pro**: one native effect plugin with keyframeable, animatable glass
- [ ] GPU rendering, linear-light blending, light/dark adaptive tint

## How it works
```
core/        Rust renderer (glass_core): backdrop + shape masks â†’ glass layer + shadow layer
photoshop/   UXP plugin: panel, live updates, vector path reader, WebAssembly bridge
preview/     renders the preview images from a test backdrop
```
1. Each shape becomes a signed distance field with a squircle bevel.
2. Several shapes join through a smooth union, which makes the liquid merge.
3. Surface normals drive Snell refraction, with per-channel dispersion.
4. The refracted backdrop is frosted, colour-graded and tinted.
5. Rim lights, the shadow and the film grain are added on top.
6. To read the backdrop, the plugin hides the glass and everything above it inside a Photoshop history step, then rolls that step back, so your document is never changed by a read.
7. Settings are stored in the glass layer's name, so they survive saving and opening the file on other machines.

Working on the code, or pointing an AI coding agent at it? Start with [AGENTS.md](AGENTS.md).

## Build from source
Needs [Rust](https://rustup.rs) and Node.js. Run `rustup target add wasm32-unknown-unknown` once.
```bash
cargo test -p glass_core
```
```bash
cargo build -p glass_core --release --target wasm32-unknown-unknown
```
Copy `target/wasm32-unknown-unknown/release/glass_core.wasm` into `photoshop/`, then run the plugin tests:
```bash
node photoshop/engine.test.js
```
```bash
node photoshop/paths.test.js
```
To load it unpackaged, add `photoshop/manifest.json` in Adobe's **UXP Developer Tool**. To package and install it on Windows (this writes `dist/SudoLiquidGlass.ccx`):
```bash
powershell -ExecutionPolicy Bypass -File install.ps1
```

## Known limits
- RGB documents only.
- Updates land when you release the mouse: Photoshop doesn't run plugins mid-drag.
- Each live update is a history step, so undoing an edit takes two steps.
- Brush strokes don't trigger an update: press **Refresh**.

## License
[MIT](LICENSE) Â© CGSudo. Not affiliated with Apple or Adobe. "Liquid Glass" refers to Apple's design material; Photoshop is a trademark of Adobe.
