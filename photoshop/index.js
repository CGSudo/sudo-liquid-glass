// Liquid Glass for Photoshop: live, non-destructive glass. No layer merging.
//
// A glass is a layer group:  Liquid Glass ┬ ◆glass[...]   ← the glass (engine pixels; settings in its name; add Layer Styles here)
//                                         ├ ◆shadow       ← shadow + dim halo (engine pixels)
//                                         ├ <shape layer> ← sources: shape/pixel/text layers; their outlines fuse into
//                                         └ <shape layer>    one liquid body (fills hidden, still fully editable)
// Outlines: shape layers are read as their actual vector paths and filled exactly by the engine; pixel layers by
// their own pixels. Every edit adds a history state; a poller notices it and re-renders. To read what lies *below*
// a glass it briefly hides the glass and everything above it inside a history suspension that is rolled back.

const { app, core, action, imaging, constants } = require("photoshop");
const { loadEngine } = require("./engine.js");
const { pathStream } = require("./paths.js");
// Defaults, built-in looks and icons are shared with the Illustrator plug-in.
const { DEFAULTS, LOOKS, icon, pad, applyLook, lookOf } = require("./looks.js");

const ANGLE = 0, DEPTH = 3, SHADOW = 13, GRAIN = 16, GRAIN_SIZE = 17, DIM = 18, GLOW = 25, STROKE = 31;
const BLENDS = ["Normal", "Screen", "Overlay", "Soft light", "Add", "Multiply"];
// Film formats by frame width (mm). Grain clumps ~0.018 mm, scaled by how many mm the document width represents.
const FORMATS = [["Super 8", 5.79], ["16 mm", 10.26], ["35 mm (36×24)", 36], ["Medium format 6×6", 56], ["Large format 4×5", 120]];
const GRAIN_MM = 0.018;
// Panel layout: tabs of sections; items are [param index, label, min, max, step, help, icon]. Objects are special controls.
const TABS = [["Glass", "glass"], ["Light", "sun"], ["Shadow", "shadow"], ["Finish", "finish"]];
const ICON_COLOR = "#8c9691"; // reads on both the light and the dark Photoshop theme
const SECTIONS = [
  // Always on screen, above the tabs: what people change most, so any look can be fine-tuned at once.
  { tab: -1, title: "Quick", items: [
    [5, "Frost", 0, 200, 1, "How frosted the glass is: blurs everything behind it, in pixels. 0 = crystal clear.", "frost"],
    [2, "Lens", 0, 200, 1, "How much the glass bends the picture behind it, like a magnifying lens. 0 = flat window.", "lens"],
    [3, "Edge width", 1, 300, 1, "How wide the rounded rim is, in pixels. Wider = rounder glass, but a smaller clear middle.", "edge"],
    [1, "Shine", 0, 1, 0.01, "How bright the shiny highlights on the edge are.", "sparkle"],
  ] },
  { tab: 0, title: "Lens", icon: "lens", items: [
    [6, "Edge softness", 0, 100, 1, "Low = a crisp, sharp rim. High = a soft, bubble-like rim.", "soft"],
    [4, "Dispersion", 0, 100, 1, "Light dispersion: splits light into a thin rainbow where the edge bends it, like a prism.", "prism"],
  ] },
  { tab: 0, title: "Liquid merge", icon: "merge", items: [
    [20, "Merge", 0, 200, 1, "Shapes closer than this many pixels melt together like drops of liquid.", "merge"],
  ] },
  { tab: 0, title: "Advanced", icon: "advanced", collapsed: true, help: "Fine control of the glass optics. Click to open or close.", items: [
    [21, "Emboss", 0, 1, 0.01, "How raised the edge looks: the side facing the light gets brighter, the far side darker.", "emboss"],
    [22, "Rim line", 0.2, 8, 0.1, "Width of the thin bright line that runs around the edge, in pixels.", "rim"],
    [23, "Glass type", 1, 2.4, 0.01, "How strongly the material bends light: 1.0 = air (no bend), 1.5 = glass, 2.4 = diamond.", "diamond"],
    [24, "Sheen", 0, 2, 0.01, "Soft, broad shine across the curved edge. 1 = default, 0 = none.", "sheen"],
  ] },
  { tab: 1, title: "Light", icon: "sun", items: [
    { dial: ANGLE, label: "Direction", icon: "direction", help: "Where the light comes from. Drag the dial; 0° is the top." },
  ] },
  { tab: 1, title: "Colour", icon: "palette", items: [
    [7, "Brightness", -1, 1, 0.01, "Makes the glass darker (left) or lighter (right).", "bright"],
    [8, "Vividness", 0, 2, 0.01, "How colourful things look through the glass. 1 = unchanged.", "drop"],
    { color: [9, 10, 11], label: "Tint colour", icon: "palette", help: "Colours the glass, like tinted sunglasses. Type a hex colour such as #3388ff." },
    [12, "Tint amount", 0, 1, 0.01, "How strongly the tint colour shows. 0 = no tint.", "amount"],
  ] },
  { tab: 2, title: "Drop shadow", icon: "shadow", toggle: SHADOW, on: 0.25, help: "A soft shadow under the glass, so it seems to float.", items: [
    [13, "Darkness", 0, 1, 0.01, "How dark the shadow under the glass is. 0 = no shadow.", "amount"],
    [14, "Softness", 0, 100, 1, "How blurry the shadow's edge is, in pixels.", "blur"],
    [15, "Drop", -50, 50, 1, "How far the shadow falls below the glass, in pixels.", "down"],
  ] },
  { tab: 2, title: "Dim background", icon: "moon", toggle: DIM, on: 0.3, help: "Darkens what's behind and around the glass so it stands out on busy images.", items: [
    [18, "Amount", 0, 1, 0.01, "How much the background behind the glass is darkened.", "amount"],
    [19, "Spread", 0, 200, 1, "How far the darkening reaches outside the glass, in pixels.", "spread"],
  ] },
  { tab: 3, title: "Inner glow", icon: "glow", toggle: GLOW, on: 0.5, help: "A soft light just inside the edge, like light caught inside the glass.", items: [
    [25, "Amount", 0, 1, 0.01, "How strong the glow is.", "amount"],
    [26, "Size", 1, 100, 1, "How far the glow reaches in from the edge, in pixels.", "inward"],
    { color: [27, 28, 29], label: "Glow colour", icon: "palette", help: "The colour of the glow. Type a hex colour such as #ffffff." },
    { select: 30, label: "Blend mode", icon: "blend", options: BLENDS, help: "How the glow mixes with the glass. Normal paints the colour; Screen and Add only brighten; Overlay and Soft light add contrast; Multiply darkens." },
  ] },
  { tab: 3, title: "Stroke", icon: "stroke", toggle: STROKE, on: 2, help: "A line just inside the edge of the glass, in one colour or a gradient.", items: [
    [31, "Width", 0, 50, 0.5, "How thick the stroke is, in pixels. It sits just inside the edge.", "width"],
    { select: 34, label: "Fill", icon: "fill", options: ["Solid colour", "Gradient"], help: "Solid: one colour. Gradient: blends from the colour to the end colour across the shape." },
    { color: [36, 37, 38], label: "Colour", icon: "palette", help: "The stroke colour (where a gradient starts). Type a hex colour such as #ffffff." },
    [32, "Opacity", 0, 1, 0.01, "How solid the stroke is (where a gradient starts).", "opacity"],
    { color: [39, 40, 41], label: "End colour", icon: "gradient", help: "Gradient only: the colour the stroke blends to." },
    [33, "End opacity", 0, 1, 0.01, "Gradient only: how solid the stroke is where the gradient ends. Low = a line that fades away.", "opacity"],
    [35, "Angle", -180, 180, 1, "Gradient only: which way the gradient runs. 0 puts the start colour at the top.", "angle"],
  ] },
  { tab: 3, title: "Film grain", icon: "grain", toggle: GRAIN, on: 0.25, help: "Adds a fine film-photo texture to the glass.", items: [
    { formats: true, icon: "film", help: "Pick a film size. Smaller film (Super 8) = bigger, rougher grain; large format = very fine grain." },
    [16, "Amount", 0, 1, 0.01, "How visible the grain is.", "amount"],
    [17, "Size", 0.5, 12, 0.1, "Size of each grain speck, in pixels. Set by the film format; fine-tune here.", "size"],
  ] },
  { tab: 3, title: "Edge effects", icon: "pen", items: [{ effects: true }] },
];
// shortcut: params live in the render layer name (survives save/copy/other machines); move to layer XMP once verified in PS.
const TAG = "◆glass", UNDER = "◆shadow";
// The engine's two layers live in one folder at the bottom of the glass group, so the Layers panel shows the
// user's shapes (what they move and style) and a single "don't touch" folder. Photoshop can't hide layers outright.
const BOX = "◆ glass render (automatic)";

const $ = (id) => document.getElementById(id);
// While the pointer is over a setting the status bar shows its explanation; real status waits in lastStatus.
let lastStatus = "", hovering = false;
const status = (s) => {
  lastStatus = s;
  if (!hovering) $("status").textContent = s;
};
let engine, engineError = "";
let params = DEFAULTS.slice();
let busy = false, queued = null, timer = null;
let seen = ""; // last history state handled by the live poller

// Current step, named in error alerts; also traced to the console (UDT › Debug).
let step = "start";
function at(s) {
  step = s;
  console.log("[liquid-glass] " + s);
}
// Host APIs sometimes reject with plain objects or numbers, which have no .message.
function describe(e) {
  if (e && e.message) return e.message;
  try {
    return JSON.stringify(e) || String(e);
  } catch (x) {
    return String(e);
  }
}

const encodeName = (p) => TAG + JSON.stringify(p.map((v) => Math.round(v * 100) / 100));
function decodeName(name) {
  try {
    const a = JSON.parse(name.slice(TAG.length));
    // Older glass stored fewer values (16, 21, 25 or 30): pad() fills the newer settings with defaults.
    return pad(a);
  } catch (e) {
    return null;
  }
}
const isOurs = (l) => l.name.startsWith(TAG) || l.name.startsWith(UNDER) || l.name === BOX;
// Plain pixel layers crash Photoshop when read as a glass outline: only shapes (and text/smart objects) are sources.
const isRaster = (l) => l.kind === constants.LayerKind.NORMAL || l.kind === "pixel";
const isText = (l) => l.kind === constants.LayerKind.TEXT || l.kind === "text";

// Photoshop's layer collections aren't real arrays (concat/spread on them throw "Cannot convert a Symbol value
// to a string"): copy by index before using array-only operations.
function list(layers) {
  const out = [];
  for (let i = 0; i < layers.length; i++) out.push(layers[i]);
  return out;
}

function glassParts(group) {
  if (!group || !group.layers) return null;
  const box = group.layers.find((l) => l.name === BOX && l.layers);
  // Glass from 0.5 and earlier keeps its engine layers directly in the group; they move into the box on next render.
  const pool = box ? list(box.layers).concat(list(group.layers)) : group.layers;
  const render = pool.find((l) => l.name.startsWith(TAG));
  const under = pool.find((l) => l.name.startsWith(UNDER));
  const sources = group.layers.filter((l) => !isOurs(l) && !l.layers && !isRaster(l));
  return render && sources.length ? { group, box, render, under, sources } : null;
}
function allGlass(layers, out = []) {
  for (const l of layers) {
    const g = glassParts(l);
    if (g) out.push(g);
    else if (l.layers) allGlass(l.layers, out);
  }
  return out; // top to bottom
}
function glassOf(layer) {
  for (let l = layer; l; l = l.parent) {
    const g = glassParts(l);
    if (g) return g;
  }
  return null;
}
const contains = (group, id) => group.layers.some((l) => l.id === id || (l.layers && contains(l, id)));
function layersAbove(list, id, out = []) {
  for (const l of list) {
    if (l.id === id) return out;
    if (l.layers && contains(l, id)) return layersAbove(l.layers, id, out);
    out.push(l);
  }
  return out;
}

// Copies a getPixels/getSelection result into a region-sized buffer (zero where there is no data):
// RGBA when `ch` = 4, a single channel when `ch` = 1 (`pick` = which source component).
async function toRegion(res, region, ch, pick) {
  const w = region.right - region.left, h = region.bottom - region.top;
  const out = new Uint8Array(w * h * ch);
  try {
    const d = res.imageData, b = res.sourceBounds, n = d.components;
    const src = await d.getData({ chunky: true });
    const ox = b.left - region.left, oy = b.top - region.top;
    const k = pick === "alpha" ? (n === 4 || n === 2 ? n - 1 : -1) : 0;
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const s = (y * d.width + x) * n, o = ((oy + y) * w + ox + x) * ch;
        if (ch === 1) {
          out[o] = k < 0 ? 255 : src[s + k];
        } else {
          out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2];
          out[o + 3] = n === 4 ? src[s + 3] : 255;
        }
      }
    }
  } finally {
    res.imageData.dispose();
  }
  return out;
}

// Exact outline of a layer's vector mask (shape layers, live shapes, pen paths), filled by the engine.
// Returns null when the layer has no vector mask (or it can't be placed reliably: pixels are used instead).
async function readVectorMask(doc, layer, region) {
  const [r] = await action.batchPlay([{
    _obj: "get",
    _target: [{ _ref: "path", _enum: "path", _value: "vectorMask" }, { _ref: "layer", _id: layer.id }],
  }], {});
  const comps = r && r.pathContents && r.pathContents.pathComponents;
  const stream = pathStream(comps, layer.boundsNoEffects || layer.bounds, doc.resolution, region);
  return stream && engine.fill(stream, region.right - region.left, region.bottom - region.top);
}

// Shape mask of one source layer: vector path → own pixels → transparency selection. null = nothing here.
// Exact letter outlines of a text layer: make a work path from the text and read it. Runs inside the peek
// suspension, which is rolled back, so the work path never stays in the document and the text stays editable.
async function readTextMask(doc, layer, region) {
  await action.batchPlay([
    { _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false },
    { _obj: "make", _target: [{ _ref: "path", _property: "workPath" }], from: { _ref: "textLayer", _enum: "ordinal", _value: "targetEnum" } },
  ], {});
  const [r] = await action.batchPlay([{ _obj: "get", _target: [{ _ref: "path", _property: "workPath" }] }], {});
  const comps = r && r.pathContents && r.pathContents.pathComponents;
  const stream = pathStream(comps, layer.boundsNoEffects || layer.bounds, doc.resolution, region);
  return stream && engine.fill(stream, region.right - region.left, region.bottom - region.top);
}

async function readShapeMask(doc, layer, region) {
  let mask = null;
  try {
    mask = isText(layer) ? await readTextMask(doc, layer, region) : await readVectorMask(doc, layer, region);
  } catch (e) {
    at("vector outline not readable, using pixels: " + describe(e));
  }
  if (!mask) {
    try {
      mask = await toRegion(await imaging.getPixels({ documentID: doc.id, layerID: layer.id, sourceBounds: region, componentSize: 8 }), region, 1, "alpha");
    } catch (e) {
      at("no pixel data, using transparency: " + describe(e));
    }
  }
  if (!mask || !mask.some((v) => v > 0)) {
    // Last resort (e.g. text layers): load the layer's transparency as a selection.
    await action.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "channel", _property: "selection" }],
      to: { _ref: [{ _ref: "channel", _enum: "channel", _value: "transparencyEnum" }, { _ref: "layer", _id: layer.id }] },
    }], {});
    try {
      mask = await toRegion(await imaging.getSelection({ documentID: doc.id, sourceBounds: region }), region, 1);
    } catch (e) {
      return null;
    }
    // With no selection Photoshop reports "everything selected": a full box means the outline wasn't read.
    if (mask.every((v) => v === 255)) throw new Error(`couldn't read the outline of "${layer.name}"`);
  }
  return mask.some((v) => v > 0) ? mask : null;
}

// Moves the engine layers into the folder at the bottom of the glass group (shapes sit above it with
// fill 0, so the glass still shows through and any styles on the shapes draw on top of the glass).
async function packEngineLayers(doc, g, under) {
  const box = await doc.createLayerGroup({ name: BOX, fromLayers: [g.render, under] });
  const last = g.group.layers[g.group.layers.length - 1];
  if (last.id !== box.id) box.move(last, constants.ElementPlacement.PLACEAFTER);
  return box;
}

// Small picture of the render for the panel: backdrop, then shadow, then glass, scaled to ≤ 320 px wide, as JPEG.
const PREVIEW_W = 320;
function previewPixels(backdrop, out, w, h) {
  const s = Math.max(1, w / PREVIEW_W, h / 200);
  const tw = Math.max(1, Math.floor(w / s)), th = Math.max(1, Math.floor(h / s));
  const rgb = new Uint8Array(tw * th * 3);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const i = (Math.floor(y * s) * w + Math.floor(x * s)) * 4, o = (y * tw + x) * 3;
      const ua = out.under[i + 3] / 255, ga = out.glass[i + 3] / 255;
      for (let c = 0; c < 3; c++) {
        const v = backdrop[i + c] * (1 - ua) + out.under[i + c] * ua;
        rgb[o + c] = v * (1 - ga) + out.glass[i + c] * ga;
      }
    }
  }
  return { rgb, tw, th };
}
async function showPreview(backdrop, out, w, h) {
  const { rgb, tw, th } = previewPixels(backdrop, out, w, h);
  const img = await imaging.createImageDataFromBuffer(rgb, { width: tw, height: th, components: 3, chunky: true, colorSpace: "RGB" });
  try {
    const b64 = await imaging.encodeImageData({ imageData: img, base64: true });
    $("preview").setAttribute("src", "data:image/jpeg;base64," + b64);
    $("previewBox").style.display = "block";
  } finally {
    img.dispose();
  }
}

// Union of the shapes plus room for lens reach, shadow, dim halo and liquid bridges, clipped to the document.
function regionOf(doc, bs, p) {
  const b = {
    left: Math.min(...bs.map((x) => x.left)), top: Math.min(...bs.map((x) => x.top)),
    right: Math.max(...bs.map((x) => x.right)), bottom: Math.max(...bs.map((x) => x.bottom)),
  };
  // The blur reaches p[5] px, so read that much extra backdrop: content just outside the shape blurs in too.
  const lens = Math.min(300, ((Math.min(p[3], 24) + Math.max(0, p[3] - 24) * 0.25) * p[2]) / 100 * 4);
  const m = Math.ceil(Math.max(p[3], lens, p[14] * 1.5 + Math.abs(p[15]), p[18] > 0 ? p[19] * 1.5 : 0, p[20]) + p[5] * 2) + 4;
  return {
    left: Math.max(0, Math.floor(b.left - m)), top: Math.max(0, Math.floor(b.top - m)),
    right: Math.min(doc.width, Math.ceil(b.right + m)), bottom: Math.min(doc.height, Math.ceil(b.bottom + m)),
  };
}

async function renderGlass(ctx, doc, g) {
  const p = decodeName(g.render.name) || DEFAULTS;
  if (!engine) throw new Error("glass engine failed to load: " + engineError);

  // Peek: measure shapes, read outlines + backdrop, then roll back (restores fill, selection and visibility)
  // so the document is untouched.
  const peek = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Liquid Glass" });
  const masks = [];
  let backdrop, region, w = 0, h = 0;
  try {
    // Sources sit at fill 0 (they are the glass), and Photoshop then reports them as empty: no bounds, no pixels.
    // Give them their fill back for the peek so they measure and read correctly; the rollback restores fill 0.
    at("measure shapes");
    for (const s of g.sources) if (s.fillOpacity !== 100) s.fillOpacity = 100;
    region = regionOf(doc, g.sources.map((s) => s.bounds), p);
    w = region.right - region.left;
    h = region.bottom - region.top;
    if (w <= 0 || h <= 0) return;
    at(`render "${g.group.name}" (${g.sources.length} shapes) region ${JSON.stringify(region)}`);
    at("read shape outlines");
    for (const s of g.sources) {
      const mk = await readShapeMask(doc, s, region);
      if (mk) masks.push(mk);
    }
    at("hide glass and layers above");
    for (const l of [g.group, ...layersAbove(doc.layers, g.group.id)]) if (l.visible) l.visible = false;
    at("read backdrop composite");
    const composite = { documentID: doc.id, sourceBounds: region, componentSize: 8, colorSpace: "RGB" };
    backdrop = await toRegion(await imaging.getPixels(composite), region, 4);
  } finally {
    at("roll back peek");
    await ctx.hostControl.resumeHistory(peek, false);
  }
  if (!masks.length) throw new Error(`"${g.group.name}" has no visible shape to turn into glass`);

  at(`engine render ${w}x${h} (${engine.kind})`);
  const all = new Uint8Array(masks.length * w * h);
  masks.forEach((mk, i) => all.set(mk, i * w * h));
  const out = engine.render(new Float32Array(p), backdrop, all, w, h);
  // Panel preview shows the selected glass (or, with nothing selected, the last one rendered).
  const sel = doc.activeLayers.length && glassOf(doc.activeLayers[0]);
  if (!sel || sel.group.id === g.group.id) {
    try {
      await showPreview(backdrop, out, w, h);
    } catch (e) {
      at("preview skipped: " + describe(e)); // cosmetic: never block the render
    }
  }
  const opts = { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB" };
  const glassImg = await imaging.createImageDataFromBuffer(out.glass, opts);
  const underImg = await imaging.createImageDataFromBuffer(out.under, opts);
  try {
    at("write glass and shadow layers");
    const keep = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Liquid Glass" });
    // Glass made before 0.4 has no separate shadow layer: add it under the glass.
    let under = g.under;
    if (!under) {
      under = await (doc.createPixelLayer ? doc.createPixelLayer({ name: UNDER }) : doc.createLayer({ name: UNDER }));
      under.move(g.render, constants.ElementPlacement.PLACEAFTER);
    }
    const box = g.box || (await packEngineLayers(doc, g, under));
    // 0.5.1–0.5.4 locked this folder, which makes Photoshop refuse our writes: unlock it (and its layers) for good.
    for (const l of [box, g.render, under]) {
      try {
        if (l.allLocked) l.allLocked = false;
      } catch (e) { /* older Photoshop without lock properties: nothing was locked */ }
    }
    // Shapes dragged into the glass later still show their fill: hide it, they're glass now.
    for (const s of g.sources) if (s.fillOpacity !== 0) s.fillOpacity = 0;
    const at0 = { left: region.left, top: region.top };
    await imaging.putPixels({ documentID: doc.id, layerID: g.render.id, imageData: glassImg, replace: true, targetBounds: at0 });
    await imaging.putPixels({ documentID: doc.id, layerID: under.id, imageData: underImg, replace: true, targetBounds: at0 });
    await ctx.hostControl.resumeHistory(keep, true);
    at("done");
  } finally {
    glassImg.dispose();
    underImg.dispose();
  }
}

const historyKey = (doc) => doc.id + ":" + doc.activeHistoryState.id;

// Runs `fn(ctx, doc)` modally, then re-renders every glass bottom-to-top (lower glass is backdrop for upper).
async function run(name, fn) {
  const doc = app.activeDocument;
  if (!doc) return;
  // Latest request wins, but a plain refresh never replaces a queued edit (edits refresh too).
  if (busy) return void (!queued || fn ? (queued = [name, fn]) : 0);
  busy = true;
  const t = Date.now();
  try {
    let n = 0;
    await core.executeAsModal(async (ctx) => {
      if (fn) await fn(ctx, doc);
      const list = allGlass(doc.layers).reverse();
      for (const g of list) await renderGlass(ctx, doc, g);
      n = list.length;
    }, { commandName: name });
    if (n) status(`${n} glass updated in ${Date.now() - t} ms (${engine.kind})`);
  } catch (e) {
    const msg = `failed at "${step}": ${describe(e)}`;
    at("ERROR " + msg + (e && e.stack ? "\n" + e.stack : ""));
    status(msg);
    core.showAlert({ message: "Liquid Glass " + msg });
  } finally {
    try {
      seen = historyKey(doc); // our own history state must not trigger another render
    } catch (e) { /* document closed meanwhile */ }
    busy = false;
    if (queued) {
      const q = queued;
      queued = null;
      run(...q);
    }
  }
}

// Live updates: every edit (move, transform, path/point edits, live-shape changes, paint…) adds a history state.
// shortcut: re-renders every glass on any change; dirty-region tracking when docs get heavy.
function poll() {
  try {
    if (busy || !engine || !$("live").checked) return;
    const doc = app.activeDocument;
    if (!doc) return;
    const key = historyKey(doc);
    if (key === seen) return;
    seen = key;
    const states = doc.historyStates;
    // Stepped back with undo: never render there, or the redo steps would be lost.
    if (states[states.length - 1].id !== doc.activeHistoryState.id) return;
    if (allGlass(doc.layers).length) run("Update Liquid Glass");
  } catch (e) {
    // Usually a document closing or switching; retried next tick. Shown so a real failure isn't silent.
    status("Live update check failed: " + describe(e));
  }
}

// Selected layers become one glass; selected layers plus an existing glass are added to that glass.
function makeGlass() {
  const doc = app.activeDocument;
  if (!doc || !doc.activeLayers.length) return status("Select one or more shape or text layers first.");
  if (doc.mode !== constants.DocumentMode.RGB) return status("Liquid Glass needs an RGB document.");
  const target = doc.activeLayers.map(glassOf).find(Boolean);
  const shapes = doc.activeLayers.filter((l) => !glassOf(l) && !l.layers && !l.isBackgroundLayer);
  if (!shapes.length) return status(target ? "Also select the shapes to add to this glass." : "Pick shape or text layers (not the background or groups).");
  const raster = shapes.filter(isRaster);
  if (raster.length) {
    const msg = `"${raster[0].name}" is a pixel (raster) layer. Liquid Glass needs a shape or text layer: draw one with a Shape tool, the Pen tool in Shape mode, or the Type tool.`;
    status(msg);
    return void core.showAlert({ message: msg });
  }

  run(target ? "Add to Liquid Glass" : "Make Liquid Glass", async (ctx) => {
    const h = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: target ? "Add to Liquid Glass" : "Make Liquid Glass" });
    if (target) {
      at("add shapes to glass");
      for (const s of shapes) s.move(target.group.layers[0], constants.ElementPlacement.PLACEBEFORE); // above the engine folder
    } else {
      at("create group");
      const group = await doc.createLayerGroup({ name: "Liquid Glass", fromLayers: shapes });
      // Edge thickness scales with the shapes (a quarter of the smallest short side), so big layers get a strong lens too.
      const short = Math.min(...shapes.map((s) => Math.min(s.bounds.right - s.bounds.left, s.bounds.bottom - s.bounds.top)));
      params[DEPTH] = Math.round(Math.min(200, Math.max(8, 0.25 * short)));
      // Blur scales the same way, so big glass is as frosted as small glass (unless Clear style turned it off).
      if (params[5] > 0) params[5] = Math.round(Math.min(200, Math.max(8, 0.06 * short)));
      showParams();
      at("create glass layers");
      const make = (name) => (doc.createPixelLayer ? doc.createPixelLayer({ name }) : doc.createLayer({ name }));
      const render = await make(encodeName(params));
      render.move(group.layers[0], constants.ElementPlacement.PLACEBEFORE);
      const under = await make(UNDER);
      under.move(render, constants.ElementPlacement.PLACEAFTER);
      const g = glassParts(group);
      if (!g) throw new Error("could not build glass group");
      await packEngineLayers(doc, g, under);
    }
    await ctx.hostControl.resumeHistory(h, true);
  });
}

// Writes panel params onto the selected glass, then re-renders.
function applyParams() {
  const g = app.activeDocument && glassOf(app.activeDocument.activeLayers[0]);
  if (!g) return;
  run("Liquid Glass Settings", async (ctx, doc) => {
    const h = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Liquid Glass Settings" });
    g.render.name = encodeName(params);
    await ctx.hostControl.resumeHistory(h, true);
  });
}
function applySoon() {
  clearTimeout(timer);
  timer = setTimeout(applyParams, 120);
}

// Opens Photoshop's Layer Style dialog on a glass shape: strokes (solid/gradient), glows, shadows, all stackable.
async function editEffects() {
  const doc = app.activeDocument;
  const g = doc && ((doc.activeLayers.length && glassOf(doc.activeLayers[0])) || allGlass(doc.layers)[0]);
  if (!g) return status("Make a glass first.");
  // Effects go on a shape (the selected one, else the first): shape layers keep their effects at fill 0, and a
  // stroke there traces the real vector edge.
  const shape = doc.activeLayers.find((l) => g.sources.some((s) => s.id === l.id)) || g.sources[0];
  const ref = [{ _ref: "layer", _id: shape.id }];
  try {
    await core.executeAsModal(async () => {
      await action.batchPlay([{ _obj: "select", _target: ref, makeVisible: false }], {});
      // Start the dialog from the layer's existing effects so nothing is lost.
      const [cur] = await action.batchPlay([{ _obj: "get", _target: [{ _property: "layerEffects" }, ...ref] }], {});
      const existing = cur && cur.layerEffects ? cur.layerEffects : { _obj: "layerEffects", scale: { _unit: "percentUnit", _value: 100 } };
      await action.batchPlay([{
        _obj: "set",
        _target: [{ _ref: "property", _property: "layerEffects" }, ...ref],
        to: existing,
        _options: { dialogOptions: "display" },
      }], {});
    }, { commandName: "Glass edge effects", interactive: true });
  } catch (e) {
    status(`"${shape.name}" is selected: double-click it (or click fx in the Layers panel) to add strokes, glows and shadows.`);
  }
}

// ---- Panel ----

const fmt = (v) => String(Math.round(v * 100) / 100);

function showParams() {
  if ($("strip").firstChild) markLook();
  // Gradient-only stroke settings show only while the stroke is a gradient.
  for (const id of ["p33", "p35", "hex39"]) {
    const r = id.startsWith("hex") ? $(id).parentNode.parentNode : $(id).parentNode;
    r.style.display = params[34] >= 0.5 ? "" : "none";
  }
  for (const s of SECTIONS) {
    for (const it of s.items) {
      if (Array.isArray(it)) {
        $("p" + it[0]).value = params[it[0]];
        $("n" + it[0]).value = fmt(params[it[0]]);
      } else if (it.dial !== undefined) {
        const a = (params[it.dial] * Math.PI) / 180;
        $("knob").style.left = 10 + 9 * Math.sin(a) + "px"; // 28 px dial, 6 px knob
        $("knob").style.top = 10 - 9 * Math.cos(a) + "px";
        $("n" + it.dial).value = fmt(params[it.dial]);
      } else if (it.select !== undefined) {
        $("s" + it.select).value = String(Math.round(params[it.select]));
      } else if (it.color) {
        const hex = "#" + it.color.map((i) => Math.round(Math.min(1, Math.max(0, params[i])) * 255).toString(16).padStart(2, "0")).join("");
        $("hex" + it.color[0]).value = hex;
        $("sw" + it.color[0]).style.backgroundColor = hex;
      }
    }
    if (s.toggle !== undefined) {
      $("t" + s.toggle).checked = params[s.toggle] > 0;
      $("b" + s.toggle).style.opacity = params[s.toggle] > 0 ? "1" : "0.4";
    }
  }
}
function syncFromSelection() {
  const doc = app.activeDocument;
  const g = doc && doc.activeLayers.length && glassOf(doc.activeLayers[0]);
  const p = g && decodeName(g.render.name);
  if (p) {
    params = p;
    showParams();
  }
  // Clicking the glass on the canvas lands on an engine layer; hand the selection to the shapes, which are what
  // the user moves, reshapes and styles.
  if (g && !busy && doc.activeLayers.every(isOurs)) {
    core.executeAsModal(async () => {
      await action.batchPlay(g.sources.map((s, i) => ({
        _obj: "select", _target: [{ _ref: "layer", _id: s.id }], makeVisible: false,
        ...(i && { selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" } }),
      })), {});
    }, { commandName: "Select glass shapes" }).catch((e) => status("Select the shape layers to move the glass. (" + describe(e) + ")"));
  }
}

function setParam(i, v) {
  params[i] = v;
  showParams();
  applySoon();
}

function numberBox(i, min, max) {
  const n = document.createElement("input");
  n.setAttribute("type", "number");
  n.id = "n" + i;
  n.className = "num";
  n.addEventListener("change", () => {
    const v = Number(n.value);
    if (Number.isFinite(v)) setParam(i, Math.min(max, Math.max(min, v)));
    else showParams();
  });
  return n;
}

// Hovering a setting explains it in plain words in the status bar (and as a tooltip); leaving restores the status.
function explain(el, title, help) {
  if (!help) return;
  el.setAttribute("title", help);
  el.addEventListener("mouseenter", () => {
    hovering = true;
    $("status").textContent = `${title}: ${help}`;
    $("status").className = "status tip";
  });
  el.addEventListener("mouseleave", () => {
    hovering = false;
    $("status").textContent = lastStatus;
    $("status").className = "status";
  });
}

// One compact line: label, then its controls.
function row(label, help, ...controls) {
  const r = document.createElement("div");
  r.className = "param";
  const l = document.createElement("span");
  l.className = "label";
  l.textContent = label;
  if (row.icon) l.insertBefore(iconEl(row.icon), l.firstChild);
  r.appendChild(l);
  for (const c of controls) r.appendChild(c);
  explain(r, label, help);
  return r;
}

function sliderRow([i, label, min, max, stepSize, help]) {
  const s = document.createElement("input");
  for (const [k, v] of [["type", "range"], ["id", "p" + i], ["min", min], ["max", max], ["step", stepSize]]) s.setAttribute(k, String(v));
  s.className = "slider";
  s.addEventListener("input", () => setParam(i, Number(s.value)));
  return row(label, help, s, numberBox(i, min, max));
}

function dialRow({ dial, label, help }) {
  const dialEl = document.createElement("div");
  dialEl.className = "dial";
  dialEl.innerHTML = `<div id="knob" class="knob"></div>`;
  const angleAt = (e) => {
    const r = dialEl.getBoundingClientRect();
    return Math.round((Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI);
  };
  let dragging = false;
  dialEl.addEventListener("mousedown", (e) => { dragging = true; setParam(dial, angleAt(e)); });
  document.addEventListener("mousemove", (e) => dragging && setParam(dial, angleAt(e)));
  document.addEventListener("mouseup", () => (dragging = false));
  const gap = document.createElement("span");
  gap.className = "grow";
  return row(label, help, dialEl, gap, numberBox(dial, -180, 180));
}

function colorRow({ color, label, help }) {
  const box = document.createElement("span");
  box.className = "tintbox";
  box.innerHTML = `<span id="sw${color[0]}" class="swatch"></span><input id="hex${color[0]}" class="hex" type="text" value="#ffffff">`;
  box.querySelector("input").addEventListener("change", (e) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(e.target.value.trim());
    if (!m) return status("Colours are hex codes like #3388ff.");
    color.forEach((idx, k) => (params[idx] = parseInt(m[1].slice(k * 2, k * 2 + 2), 16) / 255));
    showParams();
    applyParams();
  });
  return row(label, help, box);
}

function selectRow({ select: i, label, options, help }) {
  const sel = document.createElement("select");
  sel.className = "pick";
  sel.id = "s" + i;
  sel.innerHTML = options.map((o, k) => `<option value="${k}">${o}</option>`).join("");
  sel.addEventListener("change", () => {
    params[i] = Number(sel.value);
    showParams();
    applyParams();
  });
  return row(label, help, sel);
}

function formatsRow({ help }) {
  const sel = document.createElement("select");
  sel.className = "pick";
  sel.innerHTML = `<option value="">Choose…</option>` + FORMATS.map(([n, mm]) => `<option value="${mm}">${n}</option>`).join("");
  sel.addEventListener("change", () => {
    const doc = app.activeDocument;
    if (!sel.value || !doc) return;
    // The document width stands for the frame width: smaller formats → bigger grain.
    params[GRAIN_SIZE] = Math.round(Math.min(12, Math.max(0.5, (doc.width / Number(sel.value)) * GRAIN_MM)) * 10) / 10;
    if (params[GRAIN] <= 0) params[GRAIN] = 0.25;
    showParams();
    applyParams();
  });
  return row("Film size", help, sel);
}

function effectsRow() {
  const b = document.createElement("sp-button");
  b.id = "effects";
  b.setAttribute("variant", "secondary");
  b.setAttribute("size", "s");
  b.className = "wide";
  b.textContent = "Add strokes, glows & shadows…";
  b.addEventListener("click", editEffects);
  explain(b, "Edge effects", "Opens Photoshop's Layer Style on your shape: outlines (solid or gradient), glows and extra shadows. They follow the shape as you edit it.");
  return b;
}

function iconEl(name) {
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = icon(name, ICON_COLOR);
  return s;
}

// ---- Looks: built-in and saved looks as cards, one page at a time ----
let userLooks = [], lookPage = 0, activeLook = "";
const LOOKS_KEY = "sudoLiquidGlass.looks";
function loadUserLooks() {
  try {
    const list = JSON.parse(localStorage.getItem(LOOKS_KEY) || "[]");
    userLooks = Array.isArray(list) ? list.filter((l) => l && typeof l.name === "string" && pad(l.values)).map((l) => ({ name: l.name.slice(0, 40), values: pad(l.values) })) : [];
  } catch (e) {
    userLooks = []; // no storage (tests) or a damaged entry: start empty
  }
}
function saveUserLooks() {
  try {
    localStorage.setItem(LOOKS_KEY, JSON.stringify(userLooks));
  } catch (e) {
    status("Couldn't save your look: " + describe(e));
  }
  drawLooks();
}

// A real engine render of each look on a small, colourful test scene (lengths scaled down to the card size).
const thumbCache = new Map();
async function lookThumb(values) {
  const key = values.join(",");
  if (thumbCache.has(key)) return thumbCache.get(key);
  const w = 120, h = 72;
  const bd = new Uint8Array(w * h * 4), mask = new Uint8Array(w * h);
  const blobs = [[26, 24, 15, [255, 95, 109]], [94, 52, 18, [255, 195, 113]], [74, 13, 10, [54, 209, 220]]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, t = (x + y) / (w + h);
      let c = [30 + 61 * t, 60 - 18 * t, 114 + 20 * t];
      for (const [bx, by, r, col] of blobs) if ((x - bx) ** 2 + (y - by) ** 2 < r * r) c = col;
      if (x % 7 === 0) c = c.map((v) => v + (255 - v) * 0.15);
      bd.set([c[0], c[1], c[2], 255], i);
      // Rounded rectangle, 16 px in from the sides, corner radius 12.
      const dx = Math.max(0, Math.abs(x + 0.5 - w / 2) - (w / 2 - 16 - 12)), dy = Math.max(0, Math.abs(y + 0.5 - h / 2) - (h / 2 - 12 - 12));
      mask[y * w + x] = Math.round(255 * Math.min(1, Math.max(0, 12.5 - Math.hypot(dx, dy))));
    }
  }
  const p = values.slice();
  p[3] = 9;
  for (const i of [5, 14, 15, 19, 26]) p[i] *= 0.35;
  p[17] *= 0.5;
  p[31] = Math.min(p[31], 2);
  const out = engine.render(new Float32Array(p), bd, mask, w, h);
  const { rgb, tw, th } = previewPixels(bd, out, w, h);
  const img = await imaging.createImageDataFromBuffer(rgb, { width: tw, height: th, components: 3, chunky: true, colorSpace: "RGB" });
  try {
    const src = "data:image/jpeg;base64," + (await imaging.encodeImageData({ imageData: img, base64: true }));
    thumbCache.set(key, src);
    return src;
  } finally {
    img.dispose();
  }
}

function lookCard(look, user) {
  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute("data-name", look.name);
  const th = document.createElement("div");
  th.className = "thumb";
  card.appendChild(th);
  const name = document.createElement("span");
  name.className = "cname";
  name.textContent = look.name;
  card.appendChild(name);
  if (engine) lookThumb(look.values).then((src) => (th.innerHTML = `<img src="${src}" alt="">`)).catch(() => {});
  card.addEventListener("click", () => {
    params = applyLook(params, look);
    activeLook = look.name;
    showParams();
    applyParams();
  });
  explain(card, look.name, user ? "Your saved look. Click to apply, then fine-tune it below. × deletes it."
    : "Click to apply, then fine-tune it with the sliders below. Edge width and merge stay as they are.");
  if (user) {
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      userLooks = userLooks.filter((l) => l !== look);
      saveUserLooks();
    });
    card.appendChild(x);
  }
  return card;
}

const PER_PAGE = 4;
function showLookPage(p) {
  const cards = Array.from($("strip").children), pages = Math.ceil(cards.length / PER_PAGE);
  lookPage = Math.max(0, Math.min(pages - 1, p));
  cards.forEach((c, i) => (c.style.display = Math.floor(i / PER_PAGE) === lookPage ? "flex" : "none"));
  $("prev").style.opacity = lookPage === 0 ? "0.2" : "1";
  $("next").style.opacity = lookPage >= pages - 1 ? "0.2" : "1";
  $("dots").innerHTML = pages > 1 ? Array.from({ length: pages }, (_, i) => `<span class="dot${i === lookPage ? " on" : ""}"></span>`).join("") : "";
}

function drawLooks() {
  const strip = $("strip");
  strip.innerHTML = "";
  for (const l of LOOKS) strip.appendChild(lookCard(l, false));
  for (const l of userLooks) strip.appendChild(lookCard(l, true));
  const add = document.createElement("div");
  add.className = "card add";
  add.innerHTML = `<div class="thumb plus">${icon("plus", ICON_COLOR)}</div><span class="cname">Save look</span>`;
  add.addEventListener("click", () => {
    $("saveBox").style.display = "flex";
    $("saveName").value = "";
    $("saveName").focus();
  });
  explain(add, "Save look", "Saves the current settings as your own look, for every document.");
  strip.appendChild(add);
  markLook();
  const on = Array.from(strip.children).findIndex((c) => c.className.includes(" on"));
  showLookPage(on >= 0 ? Math.floor(on / PER_PAGE) : lookPage);
}

function markLook() {
  activeLook = lookOf(params, LOOKS.concat(userLooks));
  for (const c of Array.from($("strip").children)) c.className = c.className.replace(" on", "") + (activeLook && c.getAttribute("data-name") === activeLook ? " on" : "");
}

function saveLook() {
  const name = $("saveName").value.trim();
  if (!name) return status("Type a name for your look first.");
  if (LOOKS.some((l) => l.name.toLowerCase() === name.toLowerCase())) return status(`"${name}" is a built-in look. Pick another name.`);
  userLooks = userLooks.filter((l) => l.name !== name).concat({ name, values: params.slice() });
  $("saveBox").style.display = "none";
  saveUserLooks();
  status(`Saved your look "${name}".`);
}

function buildLooks() {
  $("prev").innerHTML = icon("left", ICON_COLOR);
  $("next").innerHTML = icon("right", ICON_COLOR);
  $("looksTitle").insertBefore(iconEl("presets"), $("looksTitle").firstChild);
  $("prev").addEventListener("click", () => showLookPage(lookPage - 1));
  $("next").addEventListener("click", () => showLookPage(lookPage + 1));
  $("resetLook").addEventListener("click", () => $("strip").firstChild.click());
  $("saveOk").addEventListener("click", saveLook);
  $("saveNo").addEventListener("click", () => ($("saveBox").style.display = "none"));
  $("saveName").addEventListener("keydown", (e) => e.key === "Enter" && saveLook());
  explain($("resetLook"), "Reset", "Back to the default Liquid Glass look.");
  loadUserLooks();
  drawLooks();
}

function buildUI() {
  // One pane per tab; only the active one is shown.
  const panes = TABS.map(([name, ico], t) => {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.textContent = name;
    tab.insertBefore(iconEl(ico), tab.firstChild);
    $("tabs").appendChild(tab);
    const pane = document.createElement("div");
    $("params").appendChild(pane);
    tab.addEventListener("click", () => show(t));
    return [tab, pane];
  });
  const show = (t) => panes.forEach(([tab, pane], i) => {
    tab.className = i === t ? "tab on" : "tab";
    pane.style.display = i === t ? "block" : "none";
  });
  show(0);
  for (const s of SECTIONS) {
    const sec = document.createElement("div");
    sec.className = "section";
    const head = document.createElement("div");
    head.className = "shead";
    head.innerHTML = `<span class="stitle">${s.title}</span>`;
    if (s.icon) head.insertBefore(iconEl(s.icon), head.firstChild);
    const body = document.createElement("div");
    if (s.collapsed !== undefined) {
      // Collapsible section (Advanced): closed by default to keep the panel simple.
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      head.appendChild(arrow);
      head.style.cursor = "pointer";
      const set = (open) => {
        body.style.display = open ? "block" : "none";
        arrow.textContent = open ? "▾" : "▸";
      };
      set(!s.collapsed);
      head.addEventListener("click", () => set(body.style.display === "none"));
      explain(head, s.title, s.help);
    }
    if (s.toggle !== undefined) {
      body.id = "b" + s.toggle;
      // On/off switch in the header; on = a pleasant starting intensity.
      const t = document.createElement("input");
      t.setAttribute("type", "checkbox");
      t.id = "t" + s.toggle;
      t.addEventListener("change", () => setParam(s.toggle, t.checked ? s.on : 0));
      head.appendChild(t);
      explain(head, s.title, s.help + " Tick to turn on.");
    }
    for (const it of s.items) {
      row.icon = Array.isArray(it) ? it[6] : it.icon; // read by row() for the label icon
      body.appendChild(Array.isArray(it) ? sliderRow(it) : it.dial !== undefined ? dialRow(it) : it.color ? colorRow(it) : it.select !== undefined ? selectRow(it)
        : it.formats ? formatsRow(it) : effectsRow());
      row.icon = null;
    }
    if (s.tab < 0) {
      $("quick").appendChild(body);
      continue;
    }
    sec.appendChild(head);
    sec.appendChild(body);
    panes[s.tab][1].appendChild(sec);
  }
  $("make").addEventListener("click", makeGlass);
  $("refresh").addEventListener("click", () => run("Update Liquid Glass"));
  explain($("refresh"), "Refresh", "Re-renders every glass now. Use it after painting with a brush, which Photoshop doesn't report.");
  explain($("previewBox"), "Preview", "A small live picture of the selected glass, so you can see changes even when it is off-screen.");
  explain($("liveBox"), "Live updates", "When on, the glass redraws by itself whenever you change anything in the document.");
  buildBrand();
  buildLooks();
  showParams();
}

// Brand: logo (logo.png in the plugin folder, else the monogram), version, About page and links.
const LINKS = {
  linkedin: "https://www.linkedin.com/in/cgsudo",
  github: "https://github.com/CGSudo/sudo-liquid-glass",
  issues: "https://github.com/CGSudo/sudo-liquid-glass/issues",
};
function buildBrand() {
  const fs = require("fs");
  try {
    fs.readFileSync("plugin:/logo.png");
    for (const id of ["mark", "aboutMark"]) $(id).innerHTML = `<img src="logo.png" alt="">`;
  } catch (e) { /* no logo shipped: keep the monogram */ }
  try {
    const v = "v" + JSON.parse(fs.readFileSync("plugin:/manifest.json", { encoding: "utf-8" })).version;
    $("version").textContent = v;
    $("footVersion").textContent = v;
  } catch (e) { /* version is cosmetic */ }
  const about = (on) => {
    $("about").style.display = on ? "block" : "none";
    $("params").style.display = on ? "none" : "block";
    $("tabs").style.display = on ? "none" : "flex";
  };
  $("infoBtn").addEventListener("click", () => about($("about").style.display === "none"));
  $("credit").addEventListener("click", () => about(true));
  $("back").addEventListener("click", () => about(false));
  // Opens in the user's browser; Photoshop asks once for permission (manifest: launchProcess https).
  const open = (url) => require("uxp").shell.openExternal(url).catch((e) => status("Couldn't open the link: " + describe(e)));
  for (const key of Object.keys(LINKS)) $(key).addEventListener("click", () => open(LINKS[key]));
  $("brandLink").addEventListener("click", () => open(LINKS.linkedin));
  explain($("brandLink"), "CGSudo", "Click to visit the maker on LinkedIn.");
  explain($("infoBtn"), "About", "About Sudo Liquid Glass, updates and help.");
  lastStatus = $("status").textContent;
}

buildUI();
try {
  engine = loadEngine();
  drawLooks(); // again, now with engine-rendered thumbnails
} catch (e) {
  engineError = e.message;
  status("Engine failed to load: " + e.message);
}
action.addNotificationListener(["select"], syncFromSelection);
setInterval(poll, 300);
