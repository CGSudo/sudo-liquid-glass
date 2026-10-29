// Node check that the wasm bridge renders and matches expectations: node photoshop/engine.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createWasmEngine } = require("./engine.js");

const eng = createWasmEngine(fs.readFileSync(path.join(__dirname, "glass_core.wasm")));
const w = 64, h = 64;
const bd = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));
const disk = (cx, r) => new Uint8Array(w * h).map((_, i) => (Math.hypot((i % w) - cx, Math.floor(i / w) - 32) < r ? 255 : 0));
// Neutral params: no lens, frost, light, tone, shadow, grain, dim -> interior passes through untouched.
const neutral = new Float32Array([-45, 0, 0, 16, 0, 0, 30, 0, 1, 1, 1, 1, 0, 0, 24, 8, 0, 1.5, 0, 40, 0, 0.32, 1.2, 1.5, 1]);
const { glass, under } = eng.render(neutral, bd, disk(32, 24), w, h);
const c = (32 * w + 32) * 4;
assert.deepStrictEqual([...glass.slice(c, c + 4)], [bd[c], bd[c + 1], bd[c + 2], 255]);
assert.strictEqual(glass[3], 0);
assert.strictEqual(under.length, w * h * 4);
// An outdated caller with too few settings is refused instead of reading past its buffer.
assert.throws(() => eng.render(neutral.slice(0, 21), bd, disk(32, 24), w, h), /expected 25 settings/);

// Two disks 4 px apart: with merge the gap at x=32 is filled by glass, without it stays empty.
const two = new Uint8Array(2 * w * h);
two.set(disk(17, 13), 0);
two.set(disk(47, 13), w * h);
const gap = (32 * w + 32) * 4 + 3;
assert.strictEqual(eng.render(neutral, bd, two, w, h).glass[gap], 0);
const merged = Float32Array.from(neutral);
merged[20] = 24;
assert.strictEqual(eng.render(merged, bd, two, w, h).glass[gap], 255);

// Vector fill: a triangle, not its bounding box.
const tri = eng.fill(new Float32Array([0, 1, 3, 10, 10, 50, 10, 10, 50]), w, h);
assert.strictEqual(tri[15 * w + 15], 255);
assert.strictEqual(tri[45 * w + 45], 0, "box corner outside the triangle stays empty");
assert.throws(() => eng.fill(new Float32Array([0, 1, 9, 1]), w, h), /path fill error/);

const t = Date.now();
const big = 1000;
const r = eng.render(new Float32Array([-45, 0.6, 80, 16, 20, 4, 30, 0.06, 1.2, 1, 1, 1, 0, 0.25, 24, 8, 0.2, 1.5, 0.2, 40, 24, 0.32, 1.2, 1.5, 1]),
  new Uint8Array(big * big * 4).fill(200), new Uint8Array(big * big).fill(255), big, big);
assert.strictEqual(r.glass.length, big * big * 4);
console.log(`ok (${eng.kind}); 1000x1000 render ${Date.now() - t} ms`);
