// Photoshop vector path (pathContents from batchPlay) → glass_core::fill_paths stream, in region pixels.

const SHAPE_OPS = { add: 0, subtract: 1, interfaceIconFrameDimmed: 2, intersect: 2, xor: 3 };
const num = (v) => (typeof v === "number" ? v : v && v._value);
const pt = (p) => p && p.horizontal && [num(p.horizontal), num(p.vertical)];

// comps: pathContents.pathComponents. bounds: the layer's {left, top, right, bottom} in px.
// Returns a Float32Array stream, or null if the path can't be placed reliably on the layer.
function pathStream(comps, bounds, resolution, region) {
  if (!comps || !comps.length) return null;
  // Path coordinates come either in px or in points (1/72 in); take the scale whose bounds match the layer.
  const anchors = comps.flatMap((c) => (c.subpathListKey || []).flatMap((s) => (s.points || []).map((p) => pt(p.anchor))));
  if (!anchors.length || anchors.some((a) => !a || !a.every(Number.isFinite))) return null;
  const ax = anchors.map((a) => a[0]), ay = anchors.map((a) => a[1]);
  const box = [Math.min(...ax), Math.min(...ay), Math.max(...ax), Math.max(...ay)];
  const misfit = (s) => Math.abs(box[0] * s - bounds.left) + Math.abs(box[1] * s - bounds.top) +
    Math.abs(box[2] * s - bounds.right) + Math.abs(box[3] * s - bounds.bottom);
  const scale = [1, resolution / 72].reduce((a, b) => (misfit(b) < misfit(a) ? b : a));
  const size = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top, 1);
  if (misfit(scale) > Math.max(16, size * 0.2)) return null;

  const stream = [];
  for (const c of comps) {
    const subs = (c.subpathListKey || []).filter((s) => s.points && s.points.length > 1);
    const op = SHAPE_OPS[c.shapeOperation && c.shapeOperation._value];
    stream.push(op === undefined ? 0 : op, subs.length);
    for (const s of subs) {
      const poly = [];
      const P = s.points;
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        const p0 = pt(a.anchor), p3 = pt(b.anchor);
        const p1 = pt(a.forward) || p0, p2 = pt(b.backward) || p3;
        // Flatten each cubic Bézier segment finely enough for a smooth outline (~3 px steps).
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
        const n = p1 === p0 && p2 === p3 ? 1 : Math.min(96, Math.max(8, Math.ceil((len * scale) / 3)));
        for (let k = 0; k < n; k++) {
          const t = k / n, u = 1 - t;
          for (let d = 0; d < 2; d++) {
            const q = u * u * u * p0[d] + 3 * u * u * t * p1[d] + 3 * u * t * t * p2[d] + t * t * t * p3[d];
            poly.push(q * scale - (d === 0 ? region.left : region.top));
          }
        }
      }
      stream.push(poly.length / 2, ...poly);
    }
  }
  return new Float32Array(stream);
}

module.exports = { pathStream };
