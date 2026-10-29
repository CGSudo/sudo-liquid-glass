# AGENTS.md: guide for AI coding agents

Sudo Liquid Glass recreates Apple's Liquid Glass material inside Adobe apps. It is live and non-destructive: the glass reads what is behind it and re-renders, and it never merges or flattens layers.

- **Today:** Photoshop only, a UXP plugin, at v0.6.0.
- **Goal:** the same engine in **Illustrator, Premiere Pro and After Effects**. These are plans: none of them is released. Never describe them as available.
- **Packaging:** `.ccx` (UXP). ZXP is for CEP extensions and doesn't apply.
- **Platforms:** Windows and macOS. The engine is wasm and there is no platform-specific code, but it has been tested on Windows only.

**New here with zero context?** Read [docs/PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md) first. It explains:
- the mission and every decision;
- every problem the owner reported and how it was fixed;
- the tools installed on the dev machine.

Then read this file, then the top-of-file comments in `core/src/lib.rs` and `photoshop/index.js`.

## Layout
```
core/src/lib.rs          Rust renderer, glass_core: render(), fill_paths(), smooth_union(), C ABI
                         (lg_render, lg_fill, lg_param_count, lg_alloc, lg_free)
core/Cargo.toml          crate types: rlib (preview), cdylib (wasm for Photoshop), staticlib (native hosts)
photoshop/manifest.json  UXP manifest v5 (MUST be saved without a UTF-8 BOM, or Adobe's installer fails with -267)
photoshop/index.html     panel markup and CSS (compact, theme-aware, SUDO brand green #0d4431 / accent #2fae7c)
photoshop/index.js       panel UI, glass detection, history-suspension reads, live poller, Make Glass, preview
photoshop/engine.js      loads glass_core.wasm (or a native addon if one exists); render() and fill()
photoshop/paths.js       Photoshop vector path (batchPlay pathComponents) → fill_paths stream
photoshop/logo.png       SUDO logo shown in the panel header and About page
photoshop/*.test.js      engine.test.js / paths.test.js run the real wasm; ui.test.js loads the panel in jsdom
                         with a fake Photoshop (layer lists are Proxies that behave like Photoshop's)
preview/src/main.rs      renders preview*.png from a synthetic backdrop (engine test renders, not screenshots)
install.ps1 / install.sh package photoshop/ → dist/SudoLiquidGlass.ccx and install via Adobe UPIA (Windows / macOS)
package.json             dev tooling only: `npm install` (jsdom), then `npm test` runs every test
```

## The one contract every host shares: `Params`
`glass_core::Params` is `repr(C)`, 25 × f32, in this order. JS passes it as a `Float32Array`; C/C++ passes `const float*`.
- **Count check:** hosts check the count with `lg_param_count()`, and the wasm bridge throws on a mismatch.
- **Units:** all lengths are in **pixels** at render time; hosts that work in points convert first.

| # | field | default | # | field | default |
|---|---|---|---|---|---|
| 0 | light_angle (deg, 0 = top) | -45 | 13 | shadow_opacity | 0.25 |
| 1 | light_intensity ("Shine") | 0.6 | 14 | shadow_blur (px) | 24 |
| 2 | refraction ("Lens strength") | 80 | 15 | shadow_offset_y (px) | 8 |
| 3 | depth ("Edge width", px) | 16 | 16 | grain (0 = off) | 0 |
| 4 | dispersion ("Dispersion", rainbow) | 20 | 17 | grain_size (px) | 1.5 |
| 5 | frost (blur, px) | 4 | 18 | dim (0 = off) | 0 |
| 6 | splay ("Edge softness") | 30 | 19 | dim_spread (px) | 40 |
| 7 | brightness | 0.06 | 20 | merge (px) | 24 |
| 8 | saturation ("Vividness") | 1.2 | 21 | bevel ("Emboss", advanced) | 0.32 |
| 9 | tint r | 1 | 22 | rim_width ("Rim line", px, advanced) | 1.2 |
| 10 | tint g | 1 | 23 | ior ("Glass type", advanced) | 1.5 |
| 11 | tint b | 1 | 24 | sheen (advanced) | 1 |
| 12 | tint amount | 0 | | | |

To add a parameter:
1. Append it to the end of the list. Never reorder.
2. `PARAM_COUNT` follows from the struct size, so leave it alone.
3. Update `DEFAULTS` in `photoshop/index.js`.
4. Update the `param_layout_matches_js` test and the param arrays in `photoshop/engine.test.js`.

`decodeName` pads older saved glasses (16 or 21 values) with the defaults, so existing documents keep working.

**Render call:** `lg_render(params, backdrop RGBA8, masks A8 × n, n, w, h, out RGBA8, under RGBA8 | null)`.
- **Masks:** several masks fuse into one liquid body (smooth union, `merge` px).
- **With `under`:** `out` is the glass alone, with alpha exactly equal to the shape, and `under` holds the shadow and dim halo.
- **Alpha:** straight, not premultiplied.

## How the Photoshop plugin works
- **Glass structure:** a glass is a layer group, `Liquid Glass`:
  - **Sources:** the user's shape and/or text layers, sitting directly in the group with fill opacity 0. These are what the user moves, edits and styles; Layer Styles on them draw on top of the glass.
  - **`◆ glass render (automatic)`:** a folder at the bottom of the group holding the engine's two layers:
    - `◆glass[json params]`: the glass pixels. Its settings live in this layer name.
    - `◆shadow`: shadow and dim-halo pixels.
  - **Older layouts:** glass from 0.5.0 and earlier kept the engine layers loose in the group; they are packed into the folder on the next render.
  - **Not locked:** the folder is deliberately unlocked. Locked layers make `putPixels` fail with "target sheet is protected". 0.5.1–0.5.4 locked it, and the plugin unlocks such folders.
- **Selection hand-off:** clicking the glass on the canvas lands on an engine layer, so `syncFromSelection` re-selects the glass's sources instead.
- **Peek** (the read step):
  1. `suspendHistory`.
  2. Set each source's fill opacity back to 100. At fill 0, Photoshop reports the layer as empty: no bounds, no pixels. That is the cause of "couldn't read the outline".
  3. Measure the region from the source bounds.
  4. Read the outlines:
     - shapes: batchPlay `get` on `path: vectorMask`;
     - text: `make` a workPath from the text layer, then `get` it;
     - fallback: pixels, then a transparency selection;
     - plain pixel layers are refused, because reading them crashed Photoshop.
  5. Hide the glass group and every layer above it, and read the composite with `imaging.getPixels`.
  6. `resumeHistory(…, false)` rolls everything back, so the document is never modified by a read.
- **Write:** a second suspension does `putPixels` into both engine layers, as one undo step.
- **Live updates:** `poll()` runs every 300 ms. It watches `doc.activeHistoryState`, skips while stepped back in undo, and re-renders every glass from bottom to top.
- **Preview:** after each render the panel shows a JPEG thumbnail of the selected glass: backdrop + shadow + glass, ≤ 320 px wide, made with `imaging.encodeImageData`.
- **Edge effects:** the "Add strokes, glows & shadows…" button opens the Layer Style dialog on a source shape (fill 0 keeps effects visible, and the stroke traces the real vector).

## UXP / Photoshop gotchas (each one cost a bug)
- **Layer collections:** Photoshop's collections (`group.layers`) are not real arrays. `concat` and spread on them throw "Cannot convert a Symbol value to a string". Copy them with `list()`, which copies by index.
- **`require` of a missing native addon** returns `{}` instead of throwing, so check `typeof fn === "function"`.
- **No selection means "everything selected":** a failed transparency load would otherwise fill the whole box, which is where the old "always a rectangle" bug came from.
- **Locked layers** reject `putPixels`.
- **Fill 0 layers** report empty bounds and pixels (see Peek above).
- **Files written from PowerShell 5.1** with `Set-Content`/`Out-File` get re-encoded: README mojibake, and "◆" turned into "?". Edit text files with the editor tools or Node, never PowerShell.
- **Help text:** the panel shows plain-language help on hover. Every slider row needs a help string (`ui.test.js` checks it).

## Commands (run all before you commit)
```bash
npm install
```
```bash
npm test
```
After any change in `core/`, rebuild the wasm and copy it in:
```bash
cargo build -p glass_core --release --target wasm32-unknown-unknown
```
then copy `target/wasm32-unknown-unknown/release/glass_core.wasm` to `photoshop/`. Package without installing:
```bash
powershell -ExecutionPolicy Bypass -File install.ps1 -NoInstall
```

## Conventions
- Small, direct code; no frameworks. Comments explain *why*, in one line.
- A known limitation is marked in code as `// shortcut: <limit>, <when to upgrade>`. Grep for `shortcut:` to find the debt.
- UXP is not a browser. Prefer `setAttribute` and `appendChild`, and keep CSS to flexbox, radius, rgba and host variables.
- Release:
  1. Bump `version` in `photoshop/manifest.json` (no BOM).
  2. Run `npm test`.
  3. Package with `install.ps1 -NoInstall`.
  4. Push, then attach `dist/SudoLiquidGlass.ccx` to a GitHub release.
- Be honest in public text: say "tested on Windows", and label engine renders as test renders, not Photoshop screenshots.

## Roadmap for other hosts (all reuse `lg_render`)
- **Illustrator:** a C++ Live Effect built with the Illustrator SDK. It appears in the Appearance panel and re-runs when the shape changes. A prototype exists only on the owner's machine (not in this repo).
  1. Rasterize the art below the shape (`srcArt`) and the shape itself.
  2. Call `lg_render` (link `glass_core` as a staticlib).
  3. Return the raster.
  - Open issue: when the art *below* the glass changes, a notifier must force the effect to re-run.
- **After Effects and Premiere Pro:** one effect plugin built with the After Effects SDK runs in both apps, because Premiere hosts AE effect plugins.
  - Backdrop: the layer's input.
  - Mask: the layer's alpha.
  - Params: AE effect parameters, keyframeable, which gives animation for free.
  - Render: call `lg_render` per frame, using multi-frame rendering (MFR).
- **Engine work that helps every host:**
  - linear-light blur and refraction;
  - a GPU port of the pipeline;
  - light/dark adaptive tint.

Adobe SDKs are not in this repo: their licence forbids redistribution. Download them from developer.adobe.com/console.
