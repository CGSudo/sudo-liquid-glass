// Panel test: node photoshop/ui.test.js (needs `npm install` once for jsdom). Loads the panel in jsdom with a fake Photoshop: UI builds, About page, glass layer layouts, selection hand-off.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const ps = __dirname;
const html = fs.readFileSync(path.join(ps, "index.html"), "utf8").replace(/<script.*<\/script>/, "");
const win = new JSDOM(html, { runScripts: "outside-only" }).window;
const calls = [];
const fakePS = {
  app: { activeDocument: null },
  core: { executeAsModal: async (f) => f({}), showAlert: (m) => calls.push(["alert", m]) },
  action: { addNotificationListener() {}, batchPlay: async (d) => (calls.push(["batchPlay", d]), [{}]) },
  imaging: {},
  constants: { LayerKind: { NORMAL: "pixel" }, ElementPlacement: {}, DocumentMode: { RGB: "RGB" } },
};
const opened = [];
win.require = (m) => {
  if (m === "photoshop") return fakePS;
  if (m === "uxp") return { shell: { openExternal: async (u) => opened.push(u) } };
  if (m === "fs") return { readFileSync: (p, o) => fs.readFileSync(p.replace("plugin:/", ps + "/"), o && o.encoding) };
  if (m.startsWith("./")) {
    const mod = { exports: {} };
    new Function("module", "exports", "require", fs.readFileSync(path.join(ps, m), "utf8"))(mod, mod.exports, win.require);
    return mod.exports;
  }
  throw new Error("no module " + m);
};
win.setInterval = () => 0;
win.eval(fs.readFileSync(path.join(ps, "index.js"), "utf8") + "\n;window.T = (s) => eval(s);");
const $ = (id) => win.document.getElementById(id);
const click = (el) => el.dispatchEvent(new win.Event("click"));

// Panel and brand.
assert.deepStrictEqual([...win.document.querySelectorAll("#tabs .tab")].map((t) => t.textContent), ["Glass", "Light", "Shadow", "Finish"]);
assert(win.document.querySelector("#mark img"), "logo shown");
assert.strictEqual($("footVersion").textContent, "v0.6.1");
assert.strictEqual([...win.document.querySelectorAll(".param")].filter((r) => !r.title).length, 0, "every setting explains itself");
click($("brandLink"));
click($("infoBtn"));
assert.strictEqual($("about").style.display, "block");
assert.strictEqual($("params").style.display, "none");
assert.notStrictEqual($("linkedin").style.display, "none");
click($("github")); click($("linkedin"));
click($("back"));
assert.strictEqual($("about").style.display, "none");
assert.strictEqual($("tabs").style.display, "flex");

// Advanced section starts closed and opens on click; its sliders exist.
const adv = [...win.document.querySelectorAll(".section")].find((s) => s.textContent.includes("Advanced"));
const advBody = adv.children[1];
assert.strictEqual(advBody.style.display, "none", "Advanced starts closed");
click(adv.children[0]);
assert.strictEqual(advBody.style.display, "block");
for (const i of [21, 22, 23, 24]) assert($("p" + i) && $("n" + i), "advanced control " + i);
assert.strictEqual($("n23").value, "1.5");
// A glass saved by 0.5.x (21 values) loads with the new settings at their defaults.
const old21 = win.T("decodeName(\"◆glass[-45,0.6,80,16,20,4,30,0.06,1.2,1,1,1,0,0.25,24,8,0,1.5,0,40,24]\")");
assert.strictEqual(JSON.stringify(old21.slice(21)), "[0.32,1.2,1.5,1]");
// Photoshop layer collections throw on symbol keys other than the iterator (that broke concat in 0.5.3).
const PSList = (arr) => new Proxy(arr, { get(o, k) { if (typeof k === "symbol" && k !== Symbol.iterator) throw new TypeError("Cannot convert a Symbol value to a string"); return o[k]; } });
assert.throws(() => [].concat(PSList([1])), /Symbol/, "fake reproduces the Photoshop failure");
// Layer layouts: new (engine layers in the locked folder) and old (engine layers loose in the group).
const L = (name, id, extra = {}) => ({ name, id, kind: "solidColor", ...extra });
const shapeA = L("Rectangle 1", 1), shapeB = L("Ellipse 1", 2);
const render = L("◆glass[-45,0.6,80,16,20,4,30,0.06,1.2,1,1,1,0,0.25,24,8,0,1.5,0,40,24]", 3, { kind: "pixel" });
const under = L("◆shadow", 4, { kind: "pixel" });
const box = L("◆ glass render (automatic)", 5, { kind: "group", layers: PSList([render, under]) });
const group = L("Liquid Glass", 6, { kind: "group", layers: PSList([shapeA, shapeB, box]) });
for (const l of [shapeA, shapeB, box]) l.parent = group;
render.parent = under.parent = box;
win.__group = group;
const g = win.T("glassParts(window.__group)");
assert(g && g.box === box && g.render === render && g.under === under);
assert.deepStrictEqual(g.sources.map((s) => s.name), ["Rectangle 1", "Ellipse 1"], "only the user's shapes are sources");
win.__render = render;
assert.strictEqual(win.T("glassOf(window.__render)").group, group, "engine layer inside the folder belongs to the glass");
assert.strictEqual(win.T("allGlass([window.__group])").length, 1, "the folder itself is not mistaken for a glass");
const old = L("Old Glass", 7, { kind: "group", layers: PSList([L("◆glass[1]", 8, { kind: "pixel" }), L("◆shadow", 9, { kind: "pixel" }), L("Shape", 10, { kind: "text" })]) });
win.__old = old;
const og = win.T("glassParts(window.__old)");
assert(og && !og.box && og.sources.length === 1, "pre-0.5.1 layout still recognised, packed on next render");

// Text layers count as glass sources; preview composites backdrop, shadow and glass.
win.__t = { kind: "text" };
assert.strictEqual(win.T("isText(window.__t)"), true);
win.__px = { bd: new Uint8Array(400 * 4).fill(255), out: { under: new Uint8Array(400 * 4), glass: new Uint8Array(400 * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)) } };
const pv = win.T("previewPixels(window.__px.bd, window.__px.out, 20, 20)");
assert.strictEqual(pv.tw, 20);
assert.deepStrictEqual([...pv.rgb.slice(0, 3)], [255, 0, 0], "glass over white shows the glass colour");
assert.strictEqual(win.T("previewPixels(new Uint8Array(4000*10*4), {under:new Uint8Array(4000*10*4),glass:new Uint8Array(4000*10*4)}, 4000, 10)").tw, 320, "wide renders are scaled to 320 px");
// Clicking the glass on canvas (engine layer selected) hands the selection to the shapes.
fakePS.app.activeDocument = { activeLayers: [render], layers: [group] };
calls.length = 0;
win.T("syncFromSelection()");
setTimeout(() => {
  const sel = calls.find((c) => c[0] === "batchPlay");
  assert(sel, "selection redirected");
  assert.deepStrictEqual(sel[1].map((d) => d._target[0]._id), [1, 2]);
  assert(!sel[1][0].selectionModifier && sel[1][1].selectionModifier, "first replaces, second adds to selection");
  // Selecting a shape directly leaves the selection alone.
  fakePS.app.activeDocument = { activeLayers: [shapeA], layers: [group] };
  calls.length = 0;
  win.T("syncFromSelection()");
  setTimeout(() => {
    assert.strictEqual(calls.filter((c) => c[0] === "batchPlay").length, 0);
    assert.deepStrictEqual(opened, ["https://www.linkedin.com/in/cgsudo", "https://github.com/CGSudo/sudo-liquid-glass", "https://www.linkedin.com/in/cgsudo"]);
    console.log("ui ok");
  }, 10);
}, 10);
