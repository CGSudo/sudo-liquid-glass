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

// Order = glass_core::Params.
const DEFAULTS = [-45, 0.6, 80, 16, 20, 4, 30, 0.06, 1.2, 1, 1, 1, 0, 0.25, 24, 8, 0, 1.5, 0, 40, 24];
const LOOK = 16; // presets set the first 16 (the look) and keep depth, grain, dim and merge
const ANGLE = 0, DEPTH = 3, GRAIN = 16, GRAIN_SIZE = 17, DIM = 18;
const PRESETS = {
  regular: DEFAULTS,
  // Clear: no frost, more transparent, light dimming for legibility (Apple's rule for clear glass).
  clear: [-45, 0.7, 90, 16, 25, 0, 30, -0.08, 1.05, 1, 1, 1, 0, 0.15, 24, 8],
};
// Film formats by frame width (mm). Grain clumps ~0.018 mm, scaled by how many mm the document width represents.
const FORMATS = [["Super 8", 5.79], ["16 mm", 10.26], ["35 mm (36×24)", 36], ["Medium format 6×6", 56], ["Large format 4×5", 120]];
const GRAIN_MM = 0.018;
// Panel layout: tabs of sections; items are [param index, label, min, max, step, help]. Objects are special controls.
const TABS = ["Glass", "Light", "Shadow", "Finish"];
const SECTIONS = [
  { tab: 0, title: "Look", items: [{ presets: true }] },
  { tab: 0, title: "Lens", items: [
    [2, "Lens strength", 0, 200, 1, "How strongly the edge bends what's behind"],
    [3, "Edge thickness", 1, 300, 1, "Width of the curved rim, px"],
    [6, "Edge curve", 0, 100, 1, "0 = sharp rim, 100 = soft dome"],
    [4, "Rainbow edge", 0, 100, 1, "Colour fringing where light bends"],
    [5, "Blur", 0, 60, 0.5, "Frosting of the background, px"],
  ] },
  { tab: 0, title: "Liquid merge", items: [
    [20, "Merge distance", 0, 200, 1, "Shapes closer than this flow together, px"],
  ] },
  { tab: 1, title: "Light", items: [
    { dial: ANGLE, label: "Direction", help: "Where the light comes from" },
    [1, "Intensity", 0, 1, 0.01, "Brightness of the edge highlights"],
  ] },
  { tab: 1, title: "Colour", items: [
    [7, "Brightness", -1, 1, 0.01, "Darker ↔ lighter glass"],
    [8, "Vividness", 0, 2, 0.01, "Saturation of what's seen through"],
    { tint: true },
    [12, "Tint strength", 0, 1, 0.01, "How much of the tint colour"],
  ] },
  { tab: 2, title: "Drop shadow", items: [
    [13, "Opacity", 0, 1, 0.01, ""], [14, "Softness", 0, 100, 1, "px"], [15, "Distance", -50, 50, 1, "px, downwards"],
  ] },
  { tab: 2, title: "Dim background", toggle: DIM, on: 0.3, items: [
    [18, "Intensity", 0, 1, 0.01, "Darkens what's behind the glass"], [19, "Halo reach", 0, 200, 1, "Soft dimming past the edge, px"],
  ] },
  { tab: 3, title: "Film grain", toggle: GRAIN, on: 0.25, items: [
    { formats: true },
    [16, "Intensity", 0, 1, 0.01, ""], [17, "Grain size", 0.5, 12, 0.1, "px (set by the format, fine-tune here)"],
  ] },
  { tab: 3, title: "Edge effects", items: [{ effects: true }] },
];
// shortcut: params live in the render layer name (survives save/copy/other machines); move to layer XMP once verified in PS.
const TAG = "◆glass", UNDER = "◆shadow";

const $ = (id) => document.getElementById(id);
const status = (s) => ($("status").textContent = s);
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
    if (!Array.isArray(a) || !a.every(Number.isFinite)) return null;
    // Glass made by 0.1.x/0.2.0 stored 16 values: keep them, take the newer settings from the defaults.
    if (a.length === LOOK) return a.concat(DEFAULTS.slice(LOOK));
    return a.length === DEFAULTS.length ? a : null;
  } catch (e) {
    return null;
  }
}
const isOurs = (l) => l.name.startsWith(TAG) || l.name.startsWith(UNDER);
// Plain pixel layers crash Photoshop when read as a glass outline: only shapes (and text/smart objects) are sources.
const isRaster = (l) => l.kind === constants.LayerKind.NORMAL || l.kind === "pixel";

function glassParts(group) {
  if (!group || !group.layers) return null;
  const render = group.layers.find((l) => l.name.startsWith(TAG));
  const under = group.layers.find((l) => l.name.startsWith(UNDER));
  const sources = group.layers.filter((l) => !isOurs(l) && !l.layers && !isRaster(l));
  return render && sources.length ? { group, render, under, sources } : null;
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
async function readShapeMask(doc, layer, region) {
  let mask = null;
  try {
    mask = await readVectorMask(doc, layer, region);
  } catch (e) {
    at("vector path not readable, using pixels: " + describe(e));
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

async function renderGlass(ctx, doc, g) {
  const p = decodeName(g.render.name) || DEFAULTS;
  const bs = g.sources.map((s) => s.bounds);
  const b = {
    left: Math.min(...bs.map((x) => x.left)), top: Math.min(...bs.map((x) => x.top)),
    right: Math.max(...bs.map((x) => x.right)), bottom: Math.max(...bs.map((x) => x.bottom)),
  };
  // Room for lens reach, shadow, dim halo and liquid bridges.
  const m = Math.ceil(Math.max(p[3], p[14] * 1.5 + Math.abs(p[15]), p[18] > 0 ? p[19] * 1.5 : 0, p[20])) + 4;
  const region = {
    left: Math.max(0, Math.floor(b.left - m)), top: Math.max(0, Math.floor(b.top - m)),
    right: Math.min(doc.width, Math.ceil(b.right + m)), bottom: Math.min(doc.height, Math.ceil(b.bottom + m)),
  };
  const w = region.right - region.left, h = region.bottom - region.top;
  if (w <= 0 || h <= 0) return;
  if (!engine) throw new Error("glass engine failed to load: " + engineError);

  at(`render "${g.group.name}" (${g.sources.length} shapes) region ${JSON.stringify(region)}`);

  // Peek: read shapes + backdrop, then roll back (restores selection and visibility) so the document is untouched.
  const peek = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Liquid Glass" });
  const masks = [];
  let backdrop;
  try {
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
  if (!doc || !doc.activeLayers.length) return status("Select one or more shape layers first.");
  if (doc.mode !== constants.DocumentMode.RGB) return status("Liquid Glass needs an RGB document.");
  const target = doc.activeLayers.map(glassOf).find(Boolean);
  const shapes = doc.activeLayers.filter((l) => !glassOf(l) && !l.layers && !l.isBackgroundLayer);
  if (!shapes.length) return status(target ? "Also select the shapes to add to this glass." : "Pick shape layers (not the background or groups).");
  const raster = shapes.filter(isRaster);
  if (raster.length) {
    const msg = `"${raster[0].name}" is a pixel (raster) layer. Liquid Glass needs a shape layer: draw one with a Shape tool or the Pen tool in Shape mode.`;
    status(msg);
    return void core.showAlert({ message: msg });
  }

  run(target ? "Add to Liquid Glass" : "Make Liquid Glass", async (ctx) => {
    const h = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: target ? "Add to Liquid Glass" : "Make Liquid Glass" });
    if (target) {
      at("add shapes to glass");
      for (const s of shapes) s.move(target.render, constants.ElementPlacement.PLACEAFTER);
    } else {
      at("create group");
      const group = await doc.createLayerGroup({ name: "Liquid Glass", fromLayers: shapes });
      // Edge thickness scales with the shapes (a quarter of the smallest short side), so big layers get a strong lens too.
      const short = Math.min(...shapes.map((s) => Math.min(s.bounds.right - s.bounds.left, s.bounds.bottom - s.bounds.top)));
      params[DEPTH] = Math.round(Math.min(200, Math.max(8, 0.25 * short)));
      showParams();
      at("create glass layers");
      const make = (name) => (doc.createPixelLayer ? doc.createPixelLayer({ name }) : doc.createLayer({ name }));
      const render = await make(encodeName(params));
      render.move(group.layers[0], constants.ElementPlacement.PLACEBEFORE);
      const under = await make(UNDER);
      under.move(render, constants.ElementPlacement.PLACEAFTER);
      if (!glassParts(group)) throw new Error("could not build glass group");
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

// Opens Photoshop's Layer Style dialog on the glass layer: strokes (solid/gradient), glows, shadows, all stackable.
async function editEffects() {
  const doc = app.activeDocument;
  const g = doc && ((doc.activeLayers.length && glassOf(doc.activeLayers[0])) || allGlass(doc.layers)[0]);
  if (!g) return status("Make a glass first.");
  const ref = [{ _ref: "layer", _id: g.render.id }];
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
    status("Glass layer selected: double-click it (or click fx in the Layers panel) to add strokes, glows and shadows.");
  }
}

// ---- Panel ----

const fmt = (v) => String(Math.round(v * 100) / 100);

function showParams() {
  for (const s of SECTIONS) {
    for (const it of s.items) {
      if (Array.isArray(it)) {
        $("p" + it[0]).value = params[it[0]];
        $("n" + it[0]).value = fmt(params[it[0]]);
      } else if (it.dial !== undefined) {
        const a = (params[it.dial] * Math.PI) / 180;
        $("knob").style.left = 20 + 16 * Math.sin(a) + "px";
        $("knob").style.top = 20 - 16 * Math.cos(a) + "px";
        $("n" + it.dial).value = fmt(params[it.dial]);
      }
    }
    if (s.toggle !== undefined) {
      $("t" + s.toggle).checked = params[s.toggle] > 0;
      $("b" + s.toggle).style.opacity = params[s.toggle] > 0 ? "1" : "0.4";
    }
  }
  $("tint").value = "#" + [9, 10, 11].map((i) => Math.round(params[i] * 255).toString(16).padStart(2, "0")).join("");
  $("swatch").style.backgroundColor = $("tint").value;
}
function syncFromSelection() {
  const doc = app.activeDocument;
  const g = doc && doc.activeLayers.length && glassOf(doc.activeLayers[0]);
  const p = g && decodeName(g.render.name);
  if (p) {
    params = p;
    showParams();
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

function sliderRow([i, label, min, max, stepSize, help]) {
  const row = document.createElement("div");
  row.className = "param";
  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = `<span>${label}</span>`;
  head.appendChild(numberBox(i, min, max));
  const r = document.createElement("input");
  for (const [k, v] of [["type", "range"], ["id", "p" + i], ["min", min], ["max", max], ["step", stepSize]]) r.setAttribute(k, String(v));
  r.addEventListener("input", () => setParam(i, Number(r.value)));
  row.appendChild(head);
  row.appendChild(r);
  if (help) {
    const hint = document.createElement("div");
    hint.className = "help";
    hint.textContent = help;
    row.appendChild(hint);
  }
  return row;
}

function dialRow({ dial, label, help }) {
  const row = document.createElement("div");
  row.className = "param dialrow";
  row.innerHTML = `<div id="dial" class="dial"><div id="knob" class="knob"></div></div>
    <div class="dialtext"><div class="head"><span>${label}</span></div><div class="help">${help} (0° = top, drag the dial)</div></div>`;
  row.querySelector(".head").appendChild(numberBox(dial, -180, 180));
  const dialEl = row.querySelector("#dial");
  const angleAt = (e) => {
    const r = dialEl.getBoundingClientRect();
    return Math.round((Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI);
  };
  let dragging = false;
  dialEl.addEventListener("mousedown", (e) => { dragging = true; setParam(dial, angleAt(e)); });
  document.addEventListener("mousemove", (e) => dragging && setParam(dial, angleAt(e)));
  document.addEventListener("mouseup", () => (dragging = false));
  return row;
}

function tintRow() {
  const row = document.createElement("div");
  row.className = "param head";
  row.innerHTML = `<span>Tint colour</span><span class="tintbox"><span id="swatch" class="swatch"></span><input id="tint" type="text" value="#ffffff"></span>`;
  row.querySelector("#tint").addEventListener("change", (e) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(e.target.value.trim());
    if (!m) return status("Tint must be a hex colour like #3388ff.");
    [9, 10, 11].forEach((idx, k) => (params[idx] = parseInt(m[1].slice(k * 2, k * 2 + 2), 16) / 255));
    showParams();
    applyParams();
  });
  return row;
}

function formatsRow() {
  const row = document.createElement("div");
  row.className = "param head";
  const sel = document.createElement("select");
  sel.innerHTML = `<option value="">Film format…</option>` + FORMATS.map(([n, mm]) => `<option value="${mm}">${n}</option>`).join("");
  sel.addEventListener("change", () => {
    const doc = app.activeDocument;
    if (!sel.value || !doc) return;
    // The document width stands for the frame width: smaller formats → bigger grain.
    params[GRAIN_SIZE] = Math.round(Math.min(12, Math.max(0.5, (doc.width / Number(sel.value)) * GRAIN_MM)) * 10) / 10;
    if (params[GRAIN] <= 0) params[GRAIN] = 0.25;
    showParams();
    applyParams();
  });
  row.innerHTML = "<span>Film format</span>";
  row.appendChild(sel);
  return row;
}

function effectsRow() {
  const row = document.createElement("div");
  row.className = "param";
  row.innerHTML = `<sp-button id="effects" variant="secondary">Strokes, glows & shadows…</sp-button>
    <div class="help">Opens Photoshop's Layer Style on the glass: solid or gradient strokes, inner/outer glow,
    extra drop shadows. Stack as many as you like; they follow the glass shape live.</div>`;
  row.querySelector("#effects").addEventListener("click", editEffects);
  return row;
}

function presetsRow() {
  const row = document.createElement("div");
  row.className = "row";
  for (const k of Object.keys(PRESETS)) {
    const b = document.createElement("sp-action-button");
    b.textContent = k[0].toUpperCase() + k.slice(1);
    b.addEventListener("click", () => {
      params = params.map((v, i) => (i < LOOK && i !== DEPTH ? PRESETS[k][i] : v));
      showParams();
      applyParams();
    });
    row.appendChild(b);
  }
  return row;
}

function buildUI() {
  // One pane per tab; only the active one is shown.
  const panes = TABS.map((name, t) => {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.textContent = name;
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
    const body = document.createElement("div");
    if (s.toggle !== undefined) {
      body.id = "b" + s.toggle;
      // On/off switch in the header; on = a pleasant starting intensity.
      const t = document.createElement("input");
      t.setAttribute("type", "checkbox");
      t.id = "t" + s.toggle;
      t.title = "On / off";
      t.addEventListener("change", () => setParam(s.toggle, t.checked ? s.on : 0));
      head.appendChild(t);
    }
    for (const it of s.items) {
      body.appendChild(Array.isArray(it) ? sliderRow(it) : it.dial !== undefined ? dialRow(it) : it.tint ? tintRow()
        : it.formats ? formatsRow() : it.presets ? presetsRow() : effectsRow());
    }
    sec.appendChild(head);
    sec.appendChild(body);
    panes[s.tab][1].appendChild(sec);
  }
  $("make").addEventListener("click", makeGlass);
  $("refresh").addEventListener("click", () => run("Update Liquid Glass"));
  showParams();
}

buildUI();
try {
  engine = loadEngine();
} catch (e) {
  engineError = e.message;
  status("Engine failed to load: " + e.message);
}
action.addNotificationListener(["select"], syncFromSelection);
setInterval(poll, 300);
