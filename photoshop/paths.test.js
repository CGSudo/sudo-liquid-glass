// Node check of path reading with Photoshop-shaped data: node photoshop/paths.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathStream } = require("./paths.js");
const { createWasmEngine } = require("./engine.js");
const eng = createWasmEngine(fs.readFileSync(path.join(__dirname, "glass_core.wasm")));

// Photoshop stores points in "distanceUnit" (pt = 1/72 in); at 144 ppi, px = pt * 2.
const D = (v) => ({ _unit: "distanceUnit", _value: v });
const P = (x, y, fx, fy, bx, by) => ({
  anchor: { horizontal: D(x), vertical: D(y) },
  ...(fx !== undefined && { forward: { horizontal: D(fx), vertical: D(fy) }, backward: { horizontal: D(bx), vertical: D(by) } }),
});
// Circle of radius 25 pt around (50, 50) pt with the standard 4-point Bézier (k = 0.5523).
const k = 25 * 0.5523;
const circle = [{
  shapeOperation: { _enum: "shapeOperation", _value: "add" },
  subpathListKey: [{ closedSubpath: true, points: [
    P(50, 25, 50 + k, 25, 50 - k, 25), P(75, 50, 75, 50 + k, 75, 50 - k),
    P(50, 75, 50 - k, 75, 50 + k, 75), P(25, 50, 25, 50 - k, 25, 50 + k),
  ] }],
}];
const bounds = { left: 50, top: 50, right: 150, bottom: 150 }; // the layer in px at 144 ppi
const region = { left: 40, top: 40, right: 160, bottom: 160 };
const w = 120, h = 120;
const s = pathStream(circle, bounds, 144, region);
assert(s, "circle path placed");
const m = eng.fill(s, w, h);
const area = m.reduce((a, v) => a + v / 255, 0);
assert(Math.abs(area / (Math.PI * 50 * 50) - 1) < 0.01, "circle area " + area); // radius 50 px
assert.strictEqual(m[(60 - 40) * w + 60], 255, "inside");
assert.strictEqual(m[(52 - 40) * w + (52 - 40)], 0, "corner of the box is NOT glass (no rectangles)");

// Rectangle without handles, in px units, with a subtracted hole.
const PX = (v) => ({ _unit: "pixelsUnit", _value: v });
const Q = (x, y) => ({ anchor: { horizontal: PX(x), vertical: PX(y) } });
const rect = (x0, y0, x1, y1, op) => ({ shapeOperation: { _value: op }, subpathListKey: [{ points: [Q(x0, y0), Q(x1, y0), Q(x1, y1), Q(x0, y1)] }] });
const s2 = pathStream([rect(0, 0, 100, 100, "add"), rect(40, 40, 60, 60, "subtract")], { left: 0, top: 0, right: 100, bottom: 100 }, 300, { left: 0, top: 0, right: 100, bottom: 100 });
const m2 = eng.fill(s2, 100, 100);
assert.strictEqual(m2[10 * 100 + 10], 255);
assert.strictEqual(m2[50 * 100 + 50], 0, "subtracted hole");

// A path that doesn't line up with the layer is refused (falls back to pixels) instead of drawn wrong.
assert.strictEqual(pathStream(circle, { left: 900, top: 900, right: 1000, bottom: 1000 }, 144, region), null);
assert.strictEqual(pathStream(undefined, bounds, 144, region), null);
console.log("paths ok");
