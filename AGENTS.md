# AGENTS.md: guide for AI coding agents

Sudo Liquid Glass recreates Apple's Liquid Glass material inside Adobe apps. It is live and non-destructive: the glass reads what is behind it and re-renders, and it never merges or flattens layers.

- **Today:** Photoshop only, a UXP plugin.
- **Goal:** the same engine in **Illustrator, Premiere Pro and After Effects**. These are plans: none of them is released. Never describe them as available.
- **Packaging:** `.ccx` (UXP). ZXP is for CEP extensions and doesn't apply. Platforms are Windows and macOS: wasm, with no platform-specific code. So far it has been tested on Windows only.

Read this file first. Then read the top-of-file comment in `core/src/lib.rs` and `photoshop/index.js`.

## Layout
```
core/src/lib.rs        Rust renderer, glass_core: render(), fill_paths(), smooth_union(), C ABI (lg_render, lg_fill, lg_alloc, lg_free)
core/Cargo.toml        crate types: rlib (preview), cdylib (wasm for Photoshop), staticlib (native hosts)
photoshop/manifest.json  UXP manifest v5 (MUST be saved without a UTF-8 BOM, or Adobe's installer fails with -267)
photoshop/index.js     panel UI, glass detection, history-suspension backdrop read, live poller, Make Glass
photoshop/engine.js    loads glass_core.wasm (or a native addon if one exists); render() and fill()
photoshop/paths.js     Photoshop vector path (batchPlay pathComponents) → fill_paths stream
photoshop/*.test.js    Node tests that run the real wasm
preview/src/main.rs    renders preview*.png from a synthetic backdrop
install.ps1 / install.sh  package photoshop/ → dist/SudoLiquidGlass.ccx and install it via Adobe UPIA (Windows / macOS)
```

## The one contract every host shares: `Params`
`glass_core::Params` is `repr(C)`, 21 × f32, in this order. JS passes it as a `Float32Array`; C/C++ passes `const float*`. All lengths are in **pixels** at render time; hosts that work in points convert first.

| # | field | default | # | field | default |
|---|---|---|---|---|---|
| 0 | light_angle (deg, 0 = top) | -45 | 11 | tint b | 1 |
| 1 | light_intensity | 0.6 | 12 | tint amount | 0 |
| 2 | refraction | 80 | 13 | shadow_opacity | 0.25 |
| 3 | depth (rim width, px) | 16 | 14 | shadow_blur (px) | 24 |
| 4 | dispersion | 20 | 15 | shadow_offset_y (px) | 8 |
| 5 | frost (blur, px) | 4 | 16 | grain (0 = off) | 0 |
| 6 | splay (edge curve) | 30 | 17 | grain_size (px) | 1.5 |
| 7 | brightness | 0.06 | 18 | dim (0 = off) | 0 |
| 8 | saturation | 1.2 | 19 | dim_spread (px) | 40 |
| 9 | tint r | 1 | 20 | merge (px) | 24 |
| 10 | tint g | 1 | | | |

To add a parameter:
1. Append it to the end of the list. Never reorder.
2. `PARAM_COUNT` follows from the struct size, so leave it alone.
3. Update `DEFAULTS` in `photoshop/index.js`.
4. Update the `param_layout_matches_js` test.

`decodeName` pads older saved glasses with the defaults, so existing documents keep working.

**Render call:** `lg_render(params, backdrop RGBA8, masks A8 × n, n, w, h, out RGBA8, under RGBA8 | null)`.
- **Masks:** several masks fuse into one liquid body (smooth union, `merge` px).
- **With `under`:** `out` is the glass alone, with alpha exactly equal to the shape, and `under` holds the shadow and dim halo.
- **Alpha:** straight, not premultiplied.

## How the Photoshop plugin works
- **Glass structure:** a glass is a layer group with three kinds of children:
  - `◆glass[json params]`: engine pixels. Its settings live in its layer name.
  - `◆shadow`: engine pixels for the shadow and dim halo.
  - One or more source shape layers, with their fill opacity set to 0.
- **Reading the outline:** the vector path is read with batchPlay `get` on `path: vectorMask`, converted by `paths.js`, then filled by `engine.fill`. Plain pixel layers are refused, because reading them crashed Photoshop.
- **Reading the backdrop:** `suspendHistory` → hide the glass and every layer above it → `imaging.getPixels` of the composite → `resumeHistory(…, false)`, which rolls back. The document is never modified by a read.
- **Writing:** a second suspension does `putPixels` into both engine layers, as one undo step.
- **Live updates:** `poll()` runs every 300 ms. It watches `doc.activeHistoryState`, skips while stepped back in undo, and re-renders every glass from bottom to top.

## Commands (run all before you commit)
```bash
cargo test -p glass_core
```
```bash
cargo build -p glass_core --release --target wasm32-unknown-unknown
```
After any change in `core/`, copy `target/wasm32-unknown-unknown/release/glass_core.wasm` to `photoshop/`.
```bash
node photoshop/engine.test.js
```
```bash
node photoshop/paths.test.js
```
```bash
powershell -ExecutionPolicy Bypass -File install.ps1 -NoInstall
```

## Conventions
- Small, direct code; no frameworks. Comments explain *why*, in one line.
- A known limitation is marked in code as `// shortcut: <limit>, <when to upgrade>`. Grep for `shortcut:` to find the debt.
- UXP is not a browser. Prefer `setAttribute` and `appendChild`, and avoid modern DOM APIs.
- Release:
  1. Bump `version` in `photoshop/manifest.json` (no BOM).
  2. Package with `install.ps1 -NoInstall`.
  3. Attach `dist/SudoLiquidGlass.ccx` to a GitHub release.

## Roadmap for other hosts (all reuse `lg_render`)
- **Illustrator:** a C++ Live Effect built with the Illustrator SDK. It appears in the Appearance panel and re-runs when the shape changes.
  1. Rasterize the art below the shape (`srcArt`) and the shape itself.
  2. Call `lg_render` (link `glass_core` as a staticlib).
  3. Return the raster.
  - In early development: it builds, but it is not published and not yet verified in Illustrator. Open issue: when the art *below* the glass changes, a notifier must force the effect to re-run.
- **After Effects and Premiere Pro:** one effect plugin built with the After Effects SDK runs in both apps, because Premiere hosts AE effect plugins.
  - Backdrop: the layer's input (or a checked-out layer below).
  - Mask: the layer's alpha, or an effect parameter that picks a layer.
  - Params: AE effect parameters, keyframeable, which gives animation for free.
  - Render: on a frame, call `lg_render` per frame, using multi-frame rendering (MFR) for speed.
- **Engine work that helps every host:**
  - linear-light blur and refraction;
  - GPU paths (a wgpu/Metal compute port of the same pipeline);
  - light/dark adaptive tint.

Adobe SDKs are not in this repo: their licence forbids redistribution. Download them from developer.adobe.com/console.
