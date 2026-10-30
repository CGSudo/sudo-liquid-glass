// Panel test: node illustrator/cep/panel.test.js. Loads the Illustrator panel in jsdom with a fake CEP bridge that plays
// the LiquidGlass plug-in, then checks Make Glass, live editing and loading the selected glass's settings.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const here = __dirname;
const looks = fs.readFileSync(path.join(here, "..", "..", "photoshop", "looks.js"), "utf8");
const html = fs.readFileSync(path.join(here, "index.html"), "utf8").replace('<script src="looks.js"></script>', `<script>${looks}</script>`);

const calls = [];
let state = { doc: 1, n: 0, glass: 0, w: 800, p: null };
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "http://localhost/",
  beforeParse(win) {
    win.__adobe_cep__ = {
      evalScript(script, done) {
        const m = /^lg\(("[^"]*"), (".*")\)$/.exec(script);
        assert(m, "panel calls lg(selector, input): " + script);
        const sel = JSON.parse(m[1]), input = JSON.parse(m[2]);
        calls.push([sel, input]);
        const out = sel === "state" ? JSON.stringify(state) : sel === "make" ? "Done." : sel === "refresh" ? "Every glass re-read what's behind it." : "";
        setTimeout(() => done(out), 0);
      },
    };
    win.setInterval = () => 0; // the test drives poll() itself
  },
});
const win = dom.window, $ = (id) => win.document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 20));
const poll = () => win.eval("poll()");

(async () => {
  await tick();
  // Nothing selected: Make Glass is off and the status says what to do.
  await poll();
  assert.strictEqual($("make").disabled, true);
  assert.match($("statusText").textContent, /Select a shape/);

  // A shape selected: Make Glass sends the 42 current settings.
  state = { doc: 1, n: 1, glass: 0, w: 800, p: null };
  await poll();
  assert.strictEqual($("make").disabled, false);
  $("make").dispatchEvent(new win.Event("click"));
  await tick();
  const make = calls.find((c) => c[0] === "make");
  assert(make, "make was called");
  assert.strictEqual(make[1].split(",").length, 42);
  assert.strictEqual($("statusText").textContent, "Done.");

  // A glass selected: its settings load into the panel, and changes go straight to it.
  const p = win.SudoLooks.DEFAULTS.slice();
  p[5] = 33;
  state = { doc: 1, n: 1, glass: 1, w: 800, p };
  win.eval("lastEdit = 0");
  await poll();
  assert.strictEqual(win.eval("params[5]"), 33, "selected glass settings loaded");
  assert.match($("statusText").textContent, /Editing the selected glass/);
  const frost = $("quick").querySelector("input[type=range]");
  frost.value = "50";
  frost.dispatchEvent(new win.Event("input"));
  await new Promise((r) => setTimeout(r, 150));
  const apply = calls.filter((c) => c[0] === "apply").pop();
  assert(apply, "apply was called");
  assert.strictEqual(+apply[1].split(",")[5], 50, "the new frost reached the glass");
  // While the user is editing, a poll must not pull the old value back.
  await poll();
  assert.strictEqual(win.eval("params[5]"), 50);

  // No document open.
  state = { doc: 0 };
  await poll();
  assert.match($("statusText").textContent, /Open or create a document/);

  // Looks and saved looks still work in the panel.
  assert.strictEqual($("strip").children.length, 10);
  console.log("panel ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
