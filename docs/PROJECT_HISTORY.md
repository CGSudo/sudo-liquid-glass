# Sudo Liquid Glass: project history and handoff

This document lets a person or AI with **zero context** understand the whole project:
- what it is for;
- what the owner asked for, in order;
- how each request was understood;
- what broke and how it was fixed;
- what is installed on the development machine;
- what is still open.

For the code-level contract, read [AGENTS.md](../AGENTS.md) next.

---

## 1. Mission and vision

**Mission.** Give designers Apple's **Liquid Glass** look (iOS 26 / macOS Tahoe) inside Adobe apps as a **live, non-destructive, one-click effect**, the way Figma does it.
- Today in Photoshop, designers fake glass: merge a copy of the background, blur it, clip it to a shape and paint highlights. Every edit means redoing it.
- Sudo Liquid Glass reads whatever is behind the shape and re-renders whenever anything changes.

**Vision.**
- **One engine, every Adobe app.** A single fast Rust renderer serves every host through a tiny C ABI:
  - Photoshop (done, Windows and macOS);
  - Illustrator (done on Windows; Mac planned);
  - After Effects and Premiere Pro (planned: one AE-SDK effect plugin works in both).
- **High-end, branded, simple to use.** It's a SUDO brand asset: compact, with plain-language explanations on hover, so non-experts understand every control.
- **Honest and open.** MIT licence. Public claims must match tested reality.

**Owner:** CGSudo.
- LinkedIn: https://www.linkedin.com/in/cgsudo
- Repo: https://github.com/CGSudo/sudo-liquid-glass
- Brand: the "SUDO" white wordmark on dark green **#0d4431**; the UI accent is **#2fae7c**.

**How the owner works with the AI:**
- **Communication:** the owner writes in short, informal messages. Understand the *intent* behind each message, not only the literal words (they asked for this explicitly).
- **Style:** prefer terse replies and minimal, complete changes, and always verify.
- **Local first:** work locally until the owner says to publish.
- **Honesty:** never overclaim. Say "tested on Windows", and label engine renders as test renders, not screenshots.

---

## 2. What the product does (as of v0.8.0)

Both apps share the same engine, the same 42 settings, the same looks and the same icons (`photoshop/looks.js`). Shared since 0.7.0:
- **Looks:** Liquid Glass, Clear, Frosted, Glassmorphism, Ice, Smoked, Crystal, Bubble, Film frost, shown as preview cards a page at a time (arrows and dots, no scrollbar). **Save look** keeps your own looks for every document.
- **Quick controls** above the tabs: Frost, Lens, Edge width, Shine.
- **Inner glow** (amount, size, colour, blend mode), **stroke** inside the edge (solid or gradient, with end opacity and angle), **drop shadow on/off**.
- A small line icon for every setting.
- The engine limits how far the lens reaches on wide edges, so a big Edge width no longer hazes the background.

**Illustrator (Windows and macOS):** a panel (Window › Extensions › Sudo Liquid Glass) with Make Glass, looks and all settings, editing the selected glass live; the glass itself is a Live Effect (Effect › Stylize › Liquid Glass, in the Appearance panel). The Mac build is made by GitHub Actions and not yet tried on a real Mac. Details in [illustrator/README.md](../illustrator/README.md).

**Photoshop:**

- **Make Glass:** select shape and/or text layers, click **Make Glass**, and they become one glass group.
- **Real optics:**
  - Snell refraction at the rim (index of refraction adjustable, default 1.5);
  - per-channel dispersion (rainbow);
  - frosted blur of everything under the glass (radius 0–200 px), vividness, tint;
  - two rim lights with a direction dial, plus a **bevel/emboss** shading of the rim;
  - drop shadow;
  - optional **Dim background** halo;
  - optional **monochrome film grain**, sized by film format (Super 8 → 4×5).
- **Liquid merge:** several shapes in one glass fuse with rounded "liquid bridges" (smooth union of distance fields).
- **Live:** the glass re-renders after any edit (move, transform, path edit, text edit). Brush strokes need **Refresh**.
- **Exact outlines:** vector paths of shapes (rectangles, live rounded rectangles, ellipses, Pen paths with path operations) and the letter outlines of text.
- **Clean layers:** the user sees their shapes plus one folder, `◆ glass render (automatic)`. Clicking the glass on the canvas selects the shapes.
- **Edge effects:** Photoshop Layer Styles on the user's shapes (strokes, glows, shadows), opened from a panel button.
- **Panel:**
  - Brand header: logo plus name; clicking it opens LinkedIn.
  - Make Glass, Refresh, Live updates, a status bar, and a live **preview** thumbnail.
  - Tabs: Glass (with a collapsible **Advanced** section) / Light / Shadow / Finish.
  - About page with LinkedIn, GitHub and issues links.
  - Hovering any setting explains it in plain words.
- **Install:** `SudoLiquidGlass.ccx` from GitHub Releases. Double-click it, and Creative Cloud installs it. Photoshop 24.2 or newer.

---

## 3. Timeline: requests → understanding → result

Versions in brackets.

### Phase 1: Research
- **Ask:** "Collect all actual data about how Apple's Liquid Glass is made: science, settings, interaction, animation." Then "get a complete understanding of how to create plugins for Adobe, specifically Photoshop."
- **Done:** two reference documents on the owner's machine, outside this repo:
  - `E:\AI\liquid-glass-reference.md` covers the reverse-engineered rendering. Shapes are signed distance fields, drawn with `CABackdropLayer` + the `glassBackground` filter, with rim lights at 45° / −135° and the backdrop sampled at 0.25 scale.
  - `E:\AI\photoshop-plugin-reference.md` covers UXP, manifest v5, batchPlay, the Imaging API, executeAsModal and UPIA install.

### Phase 2: Architecture decision
- **Ask:** "Build this for Photoshop and Illustrator, in the fastest language, compatible with recent versions. A completely new non-destructive system: in Photoshop you normally have to merge layers, in Figma it's one click."
- **Choices (owner picked):** native Rust; Photoshop first, then Illustrator.
- **Understanding:** UXP plugins are JavaScript, so a native renderer needs Adobe's Hybrid SDK, which sits behind an Adobe login. The same Rust core is therefore compiled to **WebAssembly** and runs inside UXP. That gives one codebase, and one C ABI for future native hosts.
- **Non-destructive design:**
  - The glass is its own group, and its settings live in a layer name, so they survive save and copy.
  - To read the backdrop, the plugin hides the glass and everything above it inside a **history suspension that is rolled back**, so the document never changes.

### Phase 3: First working plugin [0.1–0.3]
Problems the owner reported, and their fixes:

| Owner saw | Cause | Fix |
|---|---|---|
| "Make Glass creates a folder and a layer that does nothing" | the shape read came back empty (`getPixels` returns no data for vector layers) | read the outline another way (later: real vector paths) |
| `Liquid Glass: undefined` | host APIs reject with plain objects that have no `.message` | `describe(e)`; every step is named in error alerts (`at("…")`) |
| Installer failed (UPIA −267) | `manifest.json` written with a UTF-8 BOM by PowerShell | write without BOM; `/remove` before `/install` |
| `native.render is not a function` | UXP `require` of a missing addon returns `{}` | check `typeof` before using it |
| "Effect very subtle, not the exact shape" | weak lens; creases along the distance field's diagonals | normals from a blurred height field; auto Edge width = 25% of the shape's short side |

### Phase 4: Exact shapes, live, multi-shape, grain, dim [0.4.0]
- **Ask:** follow the shape exactly, auto-update on move and edit, several shapes that merge like liquid, film grain, a dim background, intensity controls, film formats, stackable strokes, glows and shadows, and a good cascaded UI.
- **"Always a rectangle":** a failed transparency load means "no selection", and Photoshop treats that as *everything* selected. Fix: read the **real vector path** (`paths.js` → `engine.fill`), plus a guard that errors if the outline comes back as a full box.
- **Live updates:** poll `activeHistoryState` every 300 ms, and never render while stepped back in undo.
- **Several shapes:** smooth union of distance fields → **liquid merge**.
- **Separate `◆shadow` layer:** the glass alpha now equals the exact shape, so Layer Styles trace it.
- **Other features:** film-format grain, Dim background, sectioned UI with a light dial.

### Phase 5: Tabs, scrolling, raster safety [0.4.1]
- **Ask:** "Can't scroll; make it unified and segregated, maybe tabs. Stop it on raster layers, it crashes."
- **Done:**
  - Four tabs (Glass / Light / Shadow / Finish).
  - Only the controls scroll.
  - Plain pixel layers are refused with a message.

### Phase 6: Illustrator, first attempts (later replaced, see Phase 13)
- **Script** (`illustrator/Liquid Glass.jsx`, ExtendScript): exports PNGs, renders with `lgcli.exe` (`preview/src/bin/lgcli.rs`, kept out of git), then places and embeds the result.
  - A "Renderer not found" error was fixed by also copying `lgcli.exe` next to the script.
  - The owner then reported: not live, no live preview, not in the Appearance panel, heavy, no update on move.
- **Native Live Effect** (`illustrator-native/`, now `illustrator/`): the owner downloaded the Illustrator SDK, and the AI built `LiquidGlass.aip`.
  - Effect › Stylize › Liquid Glass, shown in the Appearance panel, with a Win32 tabbed dialog and preview.
  - It rasterizes `srcArt`'s backdrop and calls `lg_render` in-process.
  - Built with VS 2019 Build Tools (toolset v142). The PIPL resource is generated by `build.ps1`, so no Python is needed.
  - **Status:** built and installed but **never confirmed in Illustrator**.
  - **Open issue:** edits to the art *under* a glass don't re-run the effect.
- The owner then said to focus on Photoshop only.

### Phase 7: Publishing [0.5.0]
- **Ask:** "Package the Photoshop version and publish it to my GitHub. I don't know anything about it. Name: Sudo Liquid Glass. Make the code easy to understand for other AI. The aim is Illustrator, Premiere and After Effects. Proper SEO."
- **Done:**
  - Public repo `CGSudo/sudo-liquid-glass`, MIT licence (© CGSudo).
  - AGENTS.md, a search-focused README, 20 topics, and release **v0.5.0** with the `.ccx`.
  - Pushing used Git Credential Manager; the owner signed in. The `gh` CLI was installed and uses Git's stored credential.
- **Corrections the owner asked for:**
  - "**Don't fake it**": the Illustrator, After Effects and Premiere tags were removed and the roadmap is marked "planned"; Mac is marked untested; preview images are labelled as engine test renders.
  - "**ZXP version**": not possible. ZXP is for CEP extensions, and a UXP plugin ships as `.ccx`. Explained in the README.
  - "**Optimized for Mac**": there is no platform code. Added `install.sh` and manual install commands.
- **Mistake caught:** editing the README through PowerShell garbled its UTF-8 characters. Fixed, and now listed as a known gotcha.

### Phase 8: "Cosmic" exploration (shelved, local branch `cosmic` only)
- **Ask:** reproduce the look of a commercial After Effects gradient-glow plugin, offered as three styles (Cosmic, Liquid Glass, Cosmic Glass).
- **Done:**
  - The look was studied visually from a tutorial video only. No third-party code or binaries were used.
  - An original implementation was built: palette bands bent by the distance field, bloom, hue-preserving soft clip, lens diffusion, and 52 parameters.
- **Status:** the owner then said "work on our normal version, no cosmic for now". It lives only on the local branch `cosmic` (v0.6.0-cosmic), not on GitHub.
- **Before reviving it:** settle the naming. "Cosmic" is the other product's name.

### Phase 9: Refinement of the normal version [0.5.1–0.5.4]
- **Ask:** "Three layers confuse me: which one do I move? Show only my shapes. Brand it high-end with my logo and LinkedIn."
- **Understanding:** Photoshop cannot hide layers from the Layers panel. The closest result is the user's shapes plus one folder holding the engine layers, with canvas clicks redirected to the shapes.
- **Done:**
  - Engine layers moved into the folder.
  - Canvas clicks hand the selection to the shapes.
  - Layer Styles moved onto the shapes.
  - SUDO logo, brand green, About page.
- **Follow-up ask:** padding problems (numbers touching their boxes), too much empty space, not compact, needs hover explanations in simple language, responsiveness. Also: "the plugin opens by itself when Photoshop starts".
- **Done:**
  - One-line rows with padded number boxes.
  - Plain-language help on hover, shown in the status bar and as tooltips.
  - Clicking the brand opens LinkedIn.
  - Sliders that shrink on narrow panels.
- **Startup behaviour:** that is Photoshop restoring the workspace. Close the panel before quitting.
- **Next ask:** a preview window, a default panel size, and text support.
- **Done:**
  - Live JPEG preview.
  - Default size 300 × 720.
  - Text layers read via a temporary work path.

### Phase 10: Bugs found by the owner and fixed [0.5.4–0.5.5]
| Owner saw | Cause | Fix |
|---|---|---|
| `failed at "create glass layers": Cannot convert a Symbol value to a string` | `box.layers.concat(group.layers)`: Photoshop layer lists throw on `concat` and spread | `list()` copies by index; the test fakes Photoshop lists with a Proxy |
| `target sheet is protected and cannot be modified` | the engine folder was locked, and locked layers reject `putPixels` | no lock; old locked folders are unlocked automatically |
| `couldn't read the outline of "Shape 1"`; glass not following moved shapes; text edits not updating; extra shapes not taking the effect | sources at fill 0 report empty bounds and pixels | restore fill to 100 inside the rolled-back peek, then measure and read |
| "Bevel/emboss edge bump missing" | only a thin highlight, no rim shading | bevel shading: the lit side of the rim is brighter and the far side darker |
| "Grain must be monochrome, not colour noise" | the grain was already an equal RGB offset, but clipping one channel could tint it | the offset is limited so no channel clips; a test checks equal R/G/B shifts |

The owner confirmed: **"All working"** (v0.5.5).

### Phase 11: Advanced options and this handoff [0.6.0]
- **Ask:** "Have you removed light dispersion and some effects? I want them, maybe in an advanced option. Publish to GitHub, and create a full handoff package."
- **Understanding:** nothing was removed, only renamed ("Rainbow" → "Dispersion"). The fixed optics constants are now exposed in a collapsible **Advanced** section:
  - Emboss (bevel strength);
  - Rim line (highlight width);
  - Glass type (index of refraction 1.0–2.4);
  - Sheen.
- **Done:** a parameter-count guard (`lg_param_count`), `npm test` running all four test suites, this document, an updated AGENTS.md, and release v0.6.0.

---

### Phase 12: Blur, one-click install, developer kit [0.6.1]
- **"It's not blurring all stuff underneath it."** The cause: the default Frost was 4, and the engine used half of it as the blur radius, so it was barely visible.
  - Blur is now the real radius in px, default 12, and auto-scales with the shape on Make Glass (6% of the short side).
  - The range is 0–200, and the control comes first in Lens.
  - Extra backdrop is read around the shape so the edges blur naturally.
  - A test checks that the centre of the glass is blurred.
- **"Make it one-click like a ZXP."** A real ZXP is impossible for UXP. Each release ships:
  - `SudoLiquidGlass.ccx` (double-click to install);
  - `SudoLiquidGlass-<ver>-installer.zip` with `Install on Windows.bat` and `Install on Mac.command`, renamed in 0.7.0 to `Install Photoshop on …` (both call Adobe UPIA and remove any old copy first).
  - The Windows script was verified on the dev machine; the Mac script is untested.
- **"Give me a package zip with all the knowledge."** The developer kit zip (owner's machine, `E:\AI\SudoLiquidGlass-devkit-<ver>.zip`) contains:
  - this repo with full git history of every branch (a git bundle, including the local-only `cosmic` branch);
  - the research references;
  - the Illustrator prototypes (no Adobe SDK).

### Phase 13: Illustrator for real, and feature parity [0.7.0]
- **"Let's work on the Illustrator version, keeping all the features in mind."** The native Live Effect was brought up to the 25 (then 30, then 42) settings, with the blur fix, text as one shape, auto edge width and blur, and a **document-changed notifier**: it compares the newest edit time and item count of the art below each glass and marks the glass dirty, so the glass follows changes behind it.
- **"The previous one wasn't working; it asked for File › Scripts. The panel looks basic and white. Add inner glow, presets, save your own presets, a refresh option."**
  - The old File › Scripts prototype is removed (and deleted from Illustrator by the installer).
  - The settings window became an HTML panel in **WebView2**: dark, SUDO green, logo, LinkedIn link, tabs, hover help.
  - **Inner glow** added to the engine (amount, size, colour), then **blend modes**.
  - Nine built-in looks plus **save your own** (`%APPDATA%\Sudo Liquid Glass\presets.json`).
  - **Refresh** in the window and **Object › Refresh All Liquid Glass**; **Object › Edit Liquid Glass…**.
  - Pushed back: plug-ins can't add clickable widgets to Illustrator's Selection tool (the corner widgets are built in).
- **"Drop shadow on/off; inner glow blending; strokes with colour or gradient; and in Photoshop too."** Engine params 30–41 (glow blend, stroke width, start/end opacity, solid/gradient, angle, two colours); both panels got the controls. The stroke sits inside the edge so the glass alpha stays exactly the shape.
- **"I can't change the frost of the Frosted preset; edge width hides the background; make it a toolbar tool; Alt + double-click should open the settings; the panel opens twice; the panel jumps around; add icons; restrictions for silly things."**
  - **Quick controls** (Frost, Lens, Edge width, Shine) always visible under the looks.
  - **Wide edges:** test renders showed the lens pulling the picture from far outside and the sheen covering the whole glass. Fixed in the engine: `lens_reach` grows 1:1 to 24 px then a quarter as fast, and the sheen fades past ~24 px. Both hosts read extra backdrop for the lens.
  - **One window at a time,** truly modal (all Illustrator windows disabled while open), reopening where it was left.
  - **Fixed layout:** two-line help bar, stable scrollbar, no hover jumps.
  - **Icons** for every setting.
  - **Refusals with reasons:** pixel images, groups with images, a second Liquid Glass; CMYK warning.
  - **Strokes and width profiles** become glass (`kOutlinedStrokeInputArt`).
  - A **toolbar tool** and **Alt + double-click** were built, then **removed** at the owner's request: neither worked for them in Illustrator 2026.
- **"The preset scrollbar looks amateur; bring all of this to Photoshop and Mac; publish everything."**
  - Looks are shown a page at a time with arrows, dots and the mouse wheel; no scrollbar.
  - Photoshop got the looks (thumbnails are real engine renders of each look), saved looks (`localStorage`), quick controls and icons. Shared data moved to `photoshop/looks.js`.
  - **Mac:** the Photoshop `.ccx` already runs on macOS (untested there). Illustrator for Mac can't be built on Windows: it needs Xcode, the Mac SDK and a WKWebView window. Not started; stated honestly.
  - Published as **v0.7.0** with `installer/Install Illustrator on Windows.bat` (verified: it installed the plug-in after the UAC prompt).

### Phase 14: Illustrator panel and Mac [0.8.0]
- **"The plugin is not showing for Illustrator; update it like Photoshop; Mac compatible."** The plug-in loaded fine (its log showed clean starts), so the owner was asked what was missing: they wanted a **panel like Photoshop's**. For Mac, they chose **GitHub's Mac machines** with the Mac SDK kept private.
- **Decision:** the panel is a **CEP extension** (Illustrator's HTML panel format, Window › Extensions). It's the same code on Windows and Mac, ships as a signed `.zxp` (the format the owner first asked for), and replaces the Windows-only WebView2 window, so the C++ plug-in no longer has any platform UI code.
  - The panel talks to the plug-in with `app.sendScriptMessage("LiquidGlass", state | make | apply | refresh)`; the plug-in edits the selected glass by replacing the effect's parameters in its art style.
  - **Make Glass** groups several selected objects so they melt together, and sizes edge width and blur to the shape, like Photoshop.
  - Effect › Stylize › Liquid Glass now applies at once and opens the panel; double-clicking the effect in the Appearance panel opens the panel (PlugPlug `LoadExtension`).
  - The panel and the Photoshop plugin had the same name in Adobe's installer, and `/remove` by name removed the wrong one in a test: the panel is now "Sudo Liquid Glass for Illustrator".
- **Mac:** `illustrator/build-mac.sh` builds a universal (Apple Silicon + Intel), ad-hoc signed `LiquidGlass.aip` bundle with the Mac PiPL, and signs the panel on macOS. GitHub Actions runs it; the Mac SDK .dmg is in the **private** repo `CGSudo/illustrator-sdk-private`, read through a read-only deploy key. First runs failed on the SDK folder's spaces and a relative path; the third built cleanly. **Not yet tried on a real Mac.**
- **Tests:** `illustrator/cep/panel.test.js` runs the panel against a fake plug-in (Make Glass, live edit, loading the selected glass, no document).

## 4. Fundamentals installed on the dev machine (Windows 11)

| Tool | Why | Notes |
|---|---|---|
| Rust (stable) + `wasm32-unknown-unknown` target | engine, wasm build | `cargo test -p glass_core`, release profile with LTO |
| Node.js 24 | JS tests, packaging scripts | `npm install` brings jsdom for `ui.test.js` |
| Git for Windows + Git Credential Manager | version control, GitHub sign-in | the owner signed in once through the browser |
| GitHub CLI (`gh`, winget `GitHub.cli`) | releases, repo metadata | not logged in itself; gets `GH_TOKEN` from `git credential fill` (never printed) |
| FFmpeg (winget `Gyan.FFmpeg`) | extracting video frames, converting the logo | optional |
| Visual Studio 2019 Build Tools (C++) | Illustrator native plugin (v142 toolset) | `illustrator/build.ps1` finds it with vswhere |
| ZXPSignCmd 4.1.3 (`E:\AI\SDK\zxpsign`, from Adobe-CEP/CEP-Resources) | signs the Illustrator panel `.zxp` | a fresh self-signed certificate per build |
| Adobe Photoshop 2026, Illustrator 2026 | hosts | Photoshop plugin installed via UPIA |
| Adobe UPIA (`UnifiedPluginInstallerAgent`) | installs `.ccx` from the command line | Windows: `/install`, `/remove`, `/list all`; macOS: `--install` |
| Illustrator SDK 2026 (owner download, `E:\AI\SDK`) | Illustrator Live Effect | licence forbids committing it |

Dev loop for Photoshop:
1. Edit the code.
2. Run `npm test`. If `core/` changed, rebuild the wasm and copy it into `photoshop/`.
3. Install it:
   ```bash
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
   UPIA refuses a downgrade, so use `/remove "Sudo Liquid Glass"` first if needed.
4. Restart Photoshop and test.

---

## 5. Repository and branch map
- `main` (GitHub): the published Photoshop and Illustrator plugins.
- `backup/liquid-glass-v0.5.0` (GitHub): a snapshot before the Cosmic and refine work.
- `cosmic` (**local only**): the shelved Cosmic styles.
- `refine` (local): the development branch merged into `main` for v0.6.0.
- **Local only:** `E:\AI\liquid-glass-archive\illustrator-script` (the old ExtendScript prototype); `E:\AI\SDK` (Adobe SDK, never committed); the developer kit zips in `E:\AI`.

---

## 6. Open items and good next steps
1. **Real screenshots and demo video:** replace the engine test renders in the README with real Photoshop captures (FocuSee or OBS).
2. **macOS test:** the same `.ccx`, never run on a Mac.
3. **Illustrator:**
   - try the Mac build on a real Mac (built by CI, never run);
   - confirm the background notifier and the refusals on more documents;
   - optional: engine-rendered look thumbnails in the Illustrator window (Photoshop has them).
4. **After Effects / Premiere:** design one AE-SDK effect plugin that reuses `lg_render`.
5. **Engine:**
   - linear-light blending;
   - GPU path;
   - light/dark adaptive tint;
   - dirty-region re-rendering instead of re-rendering every glass on every change.
6. **Settings storage:** settings live in the layer name. Moving them to layer XMP would be more robust (marked `shortcut:` in the code).
7. **Cosmic:** if revived, choose a distinct name first.
