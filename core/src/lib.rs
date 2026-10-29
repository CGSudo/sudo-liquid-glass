//! Liquid Glass renderer.
//!
//! Input: an RGBA8 backdrop region (everything *below* the glass) and an A8 coverage mask of the glass
//! shape, same size. Output: the glass layer as RGBA8 with straight alpha — refracted, frosted backdrop
//! inside the shape, drop shadow outside. The host composites it above the backdrop, so nothing is merged.
//!
//! Pipeline (mirrors Apple's private `glassBackground` filter):
//! shape → distance field → squircle bevel height → surface normal → Snell refraction (n = 1.5)
//! → per-channel dispersion → frost blur → saturation/brightness → tint → two opposed rim lights → shadow.

const BIG: f32 = 1e20;

/// All lengths in pixels. Layout is `repr(C)` and all-f32 so JS can pass a Float32Array of `PARAM_COUNT` values.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Degrees, 0 = light from top, -45 = top-left (Figma convention).
    pub light_angle: f32,
    /// Rim light strength, 0..1.
    pub light_intensity: f32,
    /// Lens strength, 0..100.
    pub refraction: f32,
    /// Bevel width in px: how far in from the edge the glass curves.
    pub depth: f32,
    /// Chromatic fringing on the bent edge, 0..100.
    pub dispersion: f32,
    /// Backdrop blur radius in px (0 = clear glass).
    pub frost: f32,
    /// How far the bend spreads toward the middle, 0..100.
    pub splay: f32,
    /// -1..1: veil toward black (<0) or white (>0).
    pub brightness: f32,
    /// 1 = unchanged.
    pub saturation: f32,
    /// Tint rgb 0..1, `tint[3]` = amount 0..1.
    pub tint: [f32; 4],
    pub shadow_opacity: f32,
    pub shadow_blur: f32,
    pub shadow_offset_y: f32,
    /// Film grain strength, 0 = off.
    pub grain: f32,
    /// Grain particle size in px.
    pub grain_size: f32,
    /// Dims the content behind the glass and a soft halo around it, 0 = off (Apple's clear-glass dimming).
    pub dim: f32,
    /// How far the dim halo reaches past the edge, px.
    pub dim_spread: f32,
    /// Liquid merge distance between shapes, px: closer shapes fuse and inner corners round off. 0 = plain union.
    pub merge: f32,
    /// Advanced: emboss strength of the rim (lit side brighter, far side shaded), 0..1.
    pub bevel: f32,
    /// Advanced: width of the thin bright highlight that runs around the edge, px.
    pub rim_width: f32,
    /// Advanced: index of refraction (1.0 = no bending, 1.5 = glass, 2.4 = diamond).
    pub ior: f32,
    /// Advanced: strength of the broad soft highlight across the curved rim, 0..2.
    pub sheen: f32,
    /// Inner glow strength, 0 = off: a soft light just inside the edge.
    pub inner_glow: f32,
    /// How far the inner glow reaches inward, px.
    pub inner_glow_size: f32,
    /// Inner glow colour, RGB 0..1.
    pub inner_glow_color: [f32; 3],
    /// Inner glow blend mode: 0 normal, 1 screen, 2 overlay, 3 soft light, 4 add, 5 multiply.
    pub inner_glow_blend: f32,
    /// Stroke width inside the edge, px, 0 = off. Inside only, so the glass alpha stays exactly the shape.
    pub stroke_width: f32,
    /// Stroke opacity at the start and end of the gradient (solid strokes use the start).
    pub stroke_opacity: [f32; 2],
    /// Stroke fill: 0 solid colour, 1 linear gradient.
    pub stroke_type: f32,
    /// Gradient direction, degrees, 0 = start colour at the top (same convention as `light_angle`).
    pub stroke_angle: f32,
    /// Stroke start colour (the solid colour), RGB 0..1.
    pub stroke_color: [f32; 3],
    /// Stroke gradient end colour, RGB 0..1.
    pub stroke_color2: [f32; 3],
}

pub const PARAM_COUNT: usize = std::mem::size_of::<Params>() / 4;

impl Default for Params {
    /// Apple "regular" look.
    fn default() -> Self {
        Params {
            light_angle: -45.0,
            light_intensity: 0.6,
            refraction: 80.0,
            depth: 16.0,
            dispersion: 20.0,
            frost: 12.0,
            splay: 30.0,
            brightness: 0.06,
            saturation: 1.2,
            tint: [1.0, 1.0, 1.0, 0.0],
            shadow_opacity: 0.25,
            shadow_blur: 24.0,
            shadow_offset_y: 8.0,
            grain: 0.0,
            grain_size: 1.5,
            dim: 0.0,
            dim_spread: 40.0,
            merge: 24.0,
            bevel: 0.32,
            rim_width: 1.2,
            ior: 1.5,
            sheen: 1.0,
            inner_glow: 0.0,
            inner_glow_size: 12.0,
            inner_glow_color: [1.0, 1.0, 1.0],
            inner_glow_blend: 0.0,
            stroke_width: 0.0,
            stroke_opacity: [1.0, 0.2],
            stroke_type: 0.0,
            stroke_angle: -45.0,
            stroke_color: [1.0, 1.0, 1.0],
            stroke_color2: [1.0, 1.0, 1.0],
        }
    }
}

/// Renders the glass layer. `masks` holds one or more shape masks of `w * h` bytes each, back to back; they
/// fuse into one liquid body. With `under`, the shadow and dim halo go there and `out` holds the glass alone
/// (alpha = exact shape, so host layer styles like strokes trace the shape); without it they're composited
/// into `out`. Panics if buffer sizes don't match.
pub fn render(p: &Params, backdrop: &[u8], masks: &[u8], w: usize, h: usize, out: &mut [u8], under: Option<&mut [u8]>) {
    let n = w * h;
    assert!(backdrop.len() == n * 4 && out.len() == n * 4, "buffer size mismatch");
    assert!(under.as_ref().map_or(true, |u| u.len() == n * 4), "under buffer size mismatch");
    assert!(!masks.is_empty() && masks.len() % n == 0, "masks must be one or more w*h planes");
    let union;
    let mask = if masks.len() == n {
        masks
    } else {
        union = smooth_union(masks, w, h, p.merge.max(0.0));
        &union[..]
    };
    let depth = p.depth.max(1.0);

    // Distance from each inside pixel to the shape edge (half-pixel bias removed).
    let mut dist = inside_distance(mask, w, h);
    for d in dist.iter_mut() {
        *d = (*d - 0.5).max(0.0);
    }
    // Surface height in px: squircle bevel h(t) = (1 - (1-t)^k)^(1/k) over the edge distance, then blurred.
    // Normals come from this field, so corners round off instead of creasing along the distance field's diagonals.
    let k = 3.0 - 1.8 * (p.splay / 100.0).clamp(0.0, 1.0); // higher = bend hugs the edge
    let mut height: Vec<f32> = dist
        .iter()
        .map(|&d| if d <= 0.0 { 0.0 } else { depth * (1.0 - (1.0 - (d / depth).min(1.0)).powf(k)).powf(1.0 / k) })
        .collect();
    box_blur(&mut height, w, h, (depth / 6.0).round().max(1.0) as usize, 2);

    // Backdrop planes (sRGB, 0..1), frosted if asked.
    let mut planes = [vec![0f32; n], vec![0f32; n], vec![0f32; n]];
    for i in 0..n {
        for c in 0..3 {
            planes[c][i] = backdrop[i * 4 + c] as f32 / 255.0;
        }
    }
    // `frost` is the blur radius in px: three box passes approximate a Gaussian over everything behind the glass.
    if p.frost >= 0.5 {
        let r = p.frost.round().max(1.0) as usize;
        std::thread::scope(|s| {
            if threads() > 1 {
                for pl in planes.iter_mut() {
                    s.spawn(move || box_blur(pl, w, h, r, 3));
                }
            } else {
                for pl in planes.iter_mut() {
                    box_blur(pl, w, h, r, 3);
                }
            }
        });
    }

    // Shadow = blurred coverage, sampled with a vertical offset. Dim halo = blurred coverage, no offset.
    let cov: Vec<f32> = mask.iter().map(|&m| m as f32 / 255.0).collect();
    let blurred = |radius: f32, on: bool| {
        let mut v = cov.clone();
        if on {
            box_blur(&mut v, w, h, (radius / 2.0).round().max(1.0) as usize, 3);
        }
        v
    };
    let shadow = blurred(p.shadow_blur, p.shadow_opacity > 0.0);
    let halo = blurred(p.dim_spread, p.dim > 0.0);

    let th = std::f32::consts::PI / 180.0 * p.light_angle;
    let light = (th.sin(), -th.cos()); // screen space, y down
    let strength = lens_reach(depth) * (p.refraction / 100.0).max(0.0) * 4.0;
    let disp_c = (p.dispersion / 100.0).clamp(0.0, 1.0) * 0.25;
    let separate = under.is_some();
    // Shape bounds, so a gradient stroke spans the shape rather than the whole canvas.
    let (mut bx0, mut by0, mut bx1, mut by1) = (w, h, 0, 0);
    for (i, _) in mask.iter().enumerate().filter(|(_, &m)| m > 0) {
        let (x, y) = (i % w, i / w);
        (bx0, by0, bx1, by1) = (bx0.min(x), by0.min(y), bx1.max(x), by1.max(y));
    }
    let bounds = [bx0 as f32, by0 as f32, bx1 as f32, by1 as f32];
    let ctx = Ctx { p, w, h, depth, strength, disp_c, light, planes: &planes, dist: &dist, height: &height, shadow: &shadow, halo: &halo, mask, separate, bounds };

    par_rows(out, w * 4, h, |y, row| ctx.shade_row(y, row));
    if let Some(u) = under {
        par_rows(u, w * 4, h, |y, row| {
            for x in 0..w {
                row[x * 4..x * 4 + 4].copy_from_slice(&[0, 0, 0, to_u8(ctx.under_alpha(x, y))]);
            }
        });
    }
}

struct Ctx<'a> {
    p: &'a Params,
    w: usize,
    h: usize,
    depth: f32,
    strength: f32,
    disp_c: f32,
    light: (f32, f32),
    planes: &'a [Vec<f32>; 3],
    dist: &'a [f32],
    height: &'a [f32],
    shadow: &'a [f32],
    halo: &'a [f32],
    mask: &'a [u8],
    separate: bool,
    bounds: [f32; 4],
}

/// How far the lens reaches, px, for an edge `depth` px wide: grows 1:1 up to 24 px, then a quarter as fast, so
/// wide edges stay round without pulling the picture from far outside the glass (which reads as haze).
pub fn lens_reach(depth: f32) -> f32 {
    depth.min(24.0) + (depth - 24.0).max(0.0) * 0.25
}

/// One channel of `top` blended onto `base` (Photoshop-style modes), 0..1.
fn blend(mode: f32, base: f32, top: f32) -> f32 {
    match mode.round() as i32 {
        1 => 1.0 - (1.0 - base) * (1.0 - top),
        2 => if base < 0.5 { 2.0 * base * top } else { 1.0 - 2.0 * (1.0 - base) * (1.0 - top) },
        3 => (1.0 - 2.0 * top) * base * base + 2.0 * top * base,
        4 => (base + top).min(1.0),
        5 => base * top,
        _ => top,
    }
}

impl Ctx<'_> {
    /// Shadow and dim halo combined (both black).
    fn under_alpha(&self, x: usize, y: usize) -> f32 {
        let p = self.p;
        let sa = p.shadow_opacity * sample(self.shadow, self.w, self.h, x as f32, y as f32 - p.shadow_offset_y);
        let da = p.dim.clamp(0.0, 1.0) * self.halo[y * self.w + x];
        1.0 - (1.0 - sa) * (1.0 - da)
    }

    fn shade_row(&self, y: usize, row: &mut [u8]) {
        let (w, h, p) = (self.w, self.h, self.p);
        for x in 0..w {
            let i = y * w + x;
            let cov = self.mask[i] as f32 / 255.0;
            let under = if self.separate { 0.0 } else { self.under_alpha(x, y) };
            let o = &mut row[x * 4..x * 4 + 4];
            if cov <= 0.0 {
                o.copy_from_slice(&[0, 0, 0, to_u8(under)]);
                continue;
            }

            let d = self.dist[i];
            let t = (d / self.depth).min(1.0);

            // Surface slope = height gradient; (gx, gy) = inward unit direction.
            let hx = (self.height[y * w + (x + 1).min(w - 1)] - self.height[y * w + x.saturating_sub(1)]) * 0.5;
            let hy = (self.height[(y + 1).min(h - 1) * w + x] - self.height[y.saturating_sub(1) * w + x]) * 0.5;
            let sl = (hx * hx + hy * hy).sqrt();
            let (gx, gy) = if sl > 1e-4 { (hx / sl, hy / sl) } else { (0.0, 0.0) };
            let slope = sl.min(3.0);

            // Normal tilts outward where the surface rises inward; refract the view ray I = (0,0,-1).
            let (nx, ny, nz) = normalize(-slope * gx, -slope * gy, 1.0);
            let eta = 1.0 / p.ior.clamp(1.0, 3.0);
            let k2 = 1.0 - eta * eta * (1.0 - nz * nz);
            let f = eta * nz - k2.max(0.0).sqrt();
            let (rx, ry, rz) = (f * nx, f * ny, -eta + f * nz);
            let (dx, dy) = (rx / -rz * self.strength, ry / -rz * self.strength);

            // Red bends least, blue most.
            let (fx, fy) = (x as f32, y as f32);
            let cr = sample(&self.planes[0], w, h, fx + dx * (1.0 - self.disp_c), fy + dy * (1.0 - self.disp_c));
            let cg = sample(&self.planes[1], w, h, fx + dx, fy + dy);
            let cb = sample(&self.planes[2], w, h, fx + dx * (1.0 + self.disp_c), fy + dy * (1.0 + self.disp_c));
            let dim = 1.0 - p.dim.clamp(0.0, 1.0);
            let mut c = [cr * dim, cg * dim, cb * dim];

            let lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            for v in c.iter_mut() {
                *v = lum + (*v - lum) * p.saturation;
                *v = if p.brightness >= 0.0 { *v + (1.0 - *v) * p.brightness } else { *v * (1.0 + p.brightness) };
            }
            // Tint maps to content brightness, like coloured glass.
            let ta = p.tint[3].clamp(0.0, 1.0);
            if ta > 0.0 {
                for j in 0..3 {
                    c[j] += (p.tint[j] * (0.35 + 0.9 * lum) - c[j]) * ta;
                }
            }

            // Two opposed lights (Apple uses +45° / -135°): a crisp 1-2 px specular edge all round, strongest
            // facing the light, plus a broad sheen across the bevel.
            let face = -(gx * self.light.0 + gy * self.light.1); // outward normal · light
            let (lit, back) = (face.max(0.0).powf(1.5), (-face).max(0.0).powf(1.5));
            let edge = (-d / p.rim_width.max(0.1)).exp();
            // Fades past ~24 px in, so a wide edge doesn't wash the whole glass out with shine.
            let sheen = (1.0 - t) * (1.0 - t) * slope.min(1.0) * (-(d / 24.0)).exp().max(0.15);
            let spec = p.light_intensity * (edge * (0.5 + 0.9 * lit + 0.6 * back) + p.sheen * sheen * (0.6 * lit + 0.25 * back));
            let spec = spec.clamp(0.0, 1.0);
            for v in c.iter_mut() {
                let hc = 0.75 + 0.25 * *v; // highlight picks up the colour behind it
                *v += (hc - *v) * spec;
            }

            // Bevel: the rounded rim catches the light on the lit side and falls into shade on the far side, so the
            // edge reads as a raised, embossed bump rather than a flat outline.
            let bevel = p.light_intensity * face * (slope / 1.5).min(1.0) * p.bevel;
            for v in c.iter_mut() {
                *v += bevel;
            }

            // Inner glow: the edge colour fades inward, like light caught inside the glass.
            if p.inner_glow > 0.0 {
                let gl = p.inner_glow.min(1.0) * (-d / p.inner_glow_size.max(0.5)).exp();
                for j in 0..3 {
                    c[j] += (blend(p.inner_glow_blend, c[j], p.inner_glow_color[j]) - c[j]) * gl;
                }
            }

            // Film grain: monochrome (one value for all three channels, never per-channel colour noise), two
            // octaves of clumps, strongest in the midtones like silver halide; fixed to the glass so it never flickers.
            if p.grain > 0.0 {
                let s = p.grain_size;
                let n = 0.65 * grain_noise(x as f32, y as f32, s) + 0.35 * grain_noise(x as f32 + 71.3, y as f32 + 19.7, s * 0.5);
                let l = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).clamp(0.0, 1.0);
                let g = (n - 0.5) * p.grain * (0.35 + 2.6 * l * (1.0 - l)) * 0.9;
                // Limit the shift so no channel clips: clipping one channel but not the others would tint the grain.
                let (hi, lo) = (c[0].max(c[1]).max(c[2]), c[0].min(c[1]).min(c[2]));
                let g = g.min((1.0 - hi).max(0.0)).max(-lo.max(0.0));
                for v in c.iter_mut() {
                    *v += g;
                }
            }

            // Stroke: a band just inside the edge, solid or a linear gradient across the shape's bounds.
            if p.stroke_width > 0.0 {
                let band = (p.stroke_width - d).clamp(0.0, 1.0);
                let mut t = 0.0;
                if p.stroke_type >= 0.5 {
                    let [x0, y0, x1, y1] = self.bounds;
                    let a = std::f32::consts::PI / 180.0 * p.stroke_angle;
                    let (dx, dy) = (a.sin(), -a.cos());
                    let reach = ((x1 - x0) * 0.5 * dx).abs() + ((y1 - y0) * 0.5 * dy).abs();
                    let s = ((x as f32 - (x0 + x1) * 0.5) * dx + (y as f32 - (y0 + y1) * 0.5) * dy) / reach.max(1.0);
                    t = (0.5 - 0.5 * s).clamp(0.0, 1.0); // start colour where the angle points
                }
                let op = p.stroke_opacity[0] + (p.stroke_opacity[1] - p.stroke_opacity[0]) * t;
                let k = band * op.clamp(0.0, 1.0);
                for j in 0..3 {
                    let sc = p.stroke_color[j] + (p.stroke_color2[j] - p.stroke_color[j]) * t;
                    c[j] += (sc - c[j]) * k;
                }
            }

            // Glass over its shadow and dim halo (both black, so they only add alpha).
            let a = cov + under * (1.0 - cov);
            let s = cov / a.max(1e-6);
            o.copy_from_slice(&[to_u8(c[0] * s), to_u8(c[1] * s), to_u8(c[2] * s), to_u8(a)]);
        }
    }
}

/// Value noise in 0..1 with feature size `size` px.
fn grain_noise(x: f32, y: f32, size: f32) -> f32 {
    let (u, v) = (x / size.max(0.5), y / size.max(0.5));
    let (x0, y0) = (u.floor(), v.floor());
    let (fx, fy) = (u - x0, v - y0);
    let hash = |a: f32, b: f32| {
        let mut n = (a as i32 as u32).wrapping_mul(0x27d4_eb2d) ^ (b as i32 as u32).wrapping_mul(0x1656_67b1);
        n ^= n >> 15;
        n = n.wrapping_mul(0x2c1b_3c6d);
        n ^= n >> 12;
        (n & 0xffff) as f32 / 65535.0
    };
    let top = hash(x0, y0) * (1.0 - fx) + hash(x0 + 1.0, y0) * fx;
    let bot = hash(x0, y0 + 1.0) * (1.0 - fx) + hash(x0 + 1.0, y0 + 1.0) * fx;
    top * (1.0 - fy) + bot * fy
}

/// Fuses several shape masks into one liquid body: signed distance fields joined with a polynomial smooth
/// minimum, so shapes within `k` px grow a bridge and the inner corners where they meet round off.
fn smooth_union(masks: &[u8], w: usize, h: usize, k: f32) -> Vec<u8> {
    let n = w * h;
    let mut sd = vec![f32::MAX; n];
    for m in masks.chunks(n) {
        let (inside, outside) = (distance_to(m, w, h, false), distance_to(m, w, h, true));
        for i in 0..n {
            let b = if m[i] >= 128 { -(inside[i] - 0.5) } else { outside[i] - 0.5 };
            let a = sd[i];
            sd[i] = if a == f32::MAX {
                b
            } else if k > 0.0 {
                let hh = (k - (a - b).abs()).max(0.0) / k;
                a.min(b) - hh * hh * k * 0.25
            } else {
                a.min(b)
            };
        }
    }
    sd.iter().map(|&s| to_u8(0.5 - s)).collect()
}

/// Rasterizes vector shapes to an anti-aliased mask (exact outlines; no host selection involved).
///
/// `stream` = components back to back: `op, subpath_count, then per subpath: point_count, x0, y0, x1, y1, …`
/// (closed polygons in pixel coordinates, curves already flattened). Components combine in order like
/// Photoshop's path operations: op 0 = add, 1 = subtract, 2 = intersect, 3 = exclude. Nonzero winding.
pub fn fill_paths(stream: &[f32], w: usize, h: usize) -> Result<Vec<u8>, &'static str> {
    fn take<'a>(stream: &'a [f32], i: &mut usize, count: usize) -> Result<&'a [f32], &'static str> {
        let s = stream.get(*i..*i + count).ok_or("truncated path stream")?;
        *i += count;
        Ok(s)
    }
    let mut acc = vec![0f32; w * h];
    let mut i = 0;
    let mut first = true;
    while i < stream.len() {
        let head = take(stream, &mut i, 2)?;
        let (op, subpaths) = (head[0] as u32, head[1] as usize);
        let mut edges = Vec::new();
        for _ in 0..subpaths {
            let np = take(stream, &mut i, 1)?[0] as usize;
            let pts = take(stream, &mut i, np * 2)?;
            for k in 0..np {
                let j = (k + 1) % np; // closed
                edges.push((pts[k * 2], pts[k * 2 + 1], pts[j * 2], pts[j * 2 + 1]));
            }
        }
        if edges.iter().any(|e| !(e.0.is_finite() && e.1.is_finite() && e.2.is_finite() && e.3.is_finite())) {
            return Err("non-finite path coordinate");
        }
        let cov = coverage(&edges, w, h);
        for (a, b) in acc.iter_mut().zip(cov) {
            *a = match (op, first) {
                (_, true) | (0, _) => a.max(b),
                (1, _) => *a * (1.0 - b),
                (2, _) => a.min(b),
                (3, _) => (*a - b).abs(),
                _ => return Err("unknown path operation"),
            };
        }
        first = false;
    }
    Ok(acc.iter().map(|&v| to_u8(v)).collect())
}

/// Anti-aliased nonzero coverage of a polygon set: 4 sub-scanlines per row, exact horizontal span coverage.
fn coverage(edges: &[(f32, f32, f32, f32)], w: usize, h: usize) -> Vec<f32> {
    const S: usize = 4;
    let mut cov = vec![0f32; w * h];
    let mut xs: Vec<(f32, i32)> = Vec::new();
    for y in 0..h {
        let row = &mut cov[y * w..(y + 1) * w];
        for k in 0..S {
            let sy = y as f32 + (k as f32 + 0.5) / S as f32;
            xs.clear();
            for &(x0, y0, x1, y1) in edges {
                if (y0 <= sy && sy < y1) || (y1 <= sy && sy < y0) {
                    xs.push((x0 + (sy - y0) * (x1 - x0) / (y1 - y0), if y1 > y0 { 1 } else { -1 }));
                }
            }
            xs.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut wind = 0;
            for pair in xs.windows(2) {
                wind += pair[0].1;
                if wind != 0 {
                    add_span(row, pair[0].0, pair[1].0, 1.0 / S as f32);
                }
            }
        }
    }
    cov
}

/// Adds `weight` × horizontal coverage of [xa, xb) to the row's pixels.
fn add_span(row: &mut [f32], xa: f32, xb: f32, weight: f32) {
    let (xa, xb) = (xa.max(0.0), xb.min(row.len() as f32));
    if xb <= xa {
        return;
    }
    let (ia, ib) = (xa.floor() as usize, (xb.ceil() as usize).min(row.len()));
    for (px, v) in row.iter_mut().enumerate().take(ib).skip(ia) {
        let l = xa.max(px as f32);
        let r = xb.min(px as f32 + 1.0);
        *v += (r - l).max(0.0) * weight;
    }
}

fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get())
}

/// Runs `f(y, row)` over rows, split across cores. Single-threaded where threads don't exist (wasm).
fn par_rows(out: &mut [u8], stride: usize, h: usize, f: impl Fn(usize, &mut [u8]) + Sync) {
    let t = threads().min(h.max(1));
    if t <= 1 {
        for (y, row) in out.chunks_mut(stride).enumerate() {
            f(y, row);
        }
        return;
    }
    let rows_per = h.div_ceil(t);
    std::thread::scope(|s| {
        for (ci, chunk) in out.chunks_mut(stride * rows_per).enumerate() {
            let f = &f;
            s.spawn(move || {
                for (j, row) in chunk.chunks_mut(stride).enumerate() {
                    f(ci * rows_per + j, row);
                }
            });
        }
    });
}

fn normalize(x: f32, y: f32, z: f32) -> (f32, f32, f32) {
    let l = (x * x + y * y + z * z).sqrt();
    (x / l, y / l, z / l)
}

fn to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// Bilinear sample with edge clamping.
fn sample(pl: &[f32], w: usize, h: usize, x: f32, y: f32) -> f32 {
    let x = x.clamp(0.0, (w - 1) as f32);
    let y = y.clamp(0.0, (h - 1) as f32);
    let (x0, y0) = (x as usize, y as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let top = pl[y0 * w + x0] * (1.0 - fx) + pl[y0 * w + x1] * fx;
    let bot = pl[y1 * w + x0] * (1.0 - fx) + pl[y1 * w + x1] * fx;
    top * (1.0 - fy) + bot * fy
}

/// Euclidean distance from each inside pixel (mask >= 128) to the nearest outside pixel; 0 outside.
pub fn inside_distance(mask: &[u8], w: usize, h: usize) -> Vec<f32> {
    distance_to(mask, w, h, false)
}

/// Distance from every pixel to the nearest inside pixel (`to_inside`) or outside pixel (`!to_inside`);
/// pixels beyond the buffer count as outside. Exact separable transform (Felzenszwalb & Huttenlocher), O(w*h).
fn distance_to(mask: &[u8], w: usize, h: usize, to_inside: bool) -> Vec<f32> {
    // Pad by one so the border behaves as outside.
    let (pw, ph) = (w + 2, h + 2);
    let mut g = vec![if to_inside { BIG } else { 0.0 }; pw * ph];
    for y in 0..h {
        for x in 0..w {
            let feature = (mask[y * w + x] >= 128) == to_inside;
            g[(y + 1) * pw + x + 1] = if feature { 0.0 } else { BIG };
        }
    }
    let m = pw.max(ph);
    let (mut f, mut d, mut v, mut z) = (vec![0f32; m], vec![0f32; m], vec![0usize; m], vec![0f32; m + 1]);
    for x in 0..pw {
        for y in 0..ph {
            f[y] = g[y * pw + x];
        }
        edt_1d(&f[..ph], &mut d[..ph], &mut v, &mut z);
        for y in 0..ph {
            g[y * pw + x] = d[y];
        }
    }
    for y in 0..ph {
        f[..pw].copy_from_slice(&g[y * pw..(y + 1) * pw]);
        edt_1d(&f[..pw], &mut d[..pw], &mut v, &mut z);
        g[y * pw..(y + 1) * pw].copy_from_slice(&d[..pw]);
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            out[y * w + x] = g[(y + 1) * pw + x + 1].sqrt();
        }
    }
    out
}

fn edt_1d(f: &[f32], d: &mut [f32], v: &mut [usize], z: &mut [f32]) {
    let n = f.len();
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -1e30;
    z[1] = 1e30;
    for q in 1..n {
        let fq = f[q] + (q * q) as f32;
        loop {
            let p = v[k];
            let s = (fq - (f[p] + (p * p) as f32)) / (2.0 * (q - p) as f32);
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = 1e30;
            break;
        }
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let p = v[k];
        let dq = q as f32 - p as f32;
        d[q] = dq * dq + f[p];
    }
}

/// `passes` box blurs of radius `r` (3 passes ≈ Gaussian). Running sums, edge-clamped, O(w*h) per pass.
pub fn box_blur(pl: &mut [f32], w: usize, h: usize, r: usize, passes: usize) {
    let mut tmp = vec![0f32; pl.len()];
    let norm = 1.0 / (2 * r + 1) as f32;
    for _ in 0..passes {
        for y in 0..h {
            let row = &pl[y * w..(y + 1) * w];
            let at = |i: isize| row[i.clamp(0, w as isize - 1) as usize];
            let mut acc: f32 = (-(r as isize)..=r as isize).map(at).sum();
            for x in 0..w {
                tmp[y * w + x] = acc * norm;
                acc += at(x as isize + r as isize + 1) - at(x as isize - r as isize);
            }
        }
        // Vertical pass row by row with per-column sums: cache friendly.
        let at = |y: isize, x: usize| tmp[y.clamp(0, h as isize - 1) as usize * w + x];
        let mut acc: Vec<f32> = (0..w).map(|x| (-(r as isize)..=r as isize).map(|y| at(y, x)).sum()).collect();
        for y in 0..h {
            for x in 0..w {
                pl[y * w + x] = acc[x] * norm;
                acc[x] += at(y as isize + r as isize + 1, x) - at(y as isize - r as isize, x);
            }
        }
    }
}

// ---- C ABI: used by the Photoshop hybrid addon, the Illustrator plugin and the wasm build ----

/// Returns 0 on success, -1 on bad arguments, -2 if rendering panicked.
///
/// # Safety
/// `backdrop` and `out` must point to `w*h*4` bytes, `masks` to `n_masks*w*h` bytes, `p` to a valid `Params`.
/// `under` is null (shadow composited into `out`) or `w*h*4` bytes for the separate shadow/dim layer.
#[no_mangle]
pub unsafe extern "C" fn lg_render(
    p: *const Params, backdrop: *const u8, masks: *const u8, n_masks: u32, w: u32, h: u32, out: *mut u8, under: *mut u8,
) -> i32 {
    let (w, h, nm) = (w as usize, h as usize, n_masks as usize);
    if p.is_null() || backdrop.is_null() || masks.is_null() || out.is_null() || w == 0 || h == 0 || nm == 0 {
        return -1;
    }
    let Some(n) = w.checked_mul(h).filter(|n| n.checked_mul(4).is_some() && n.checked_mul(nm).is_some()) else { return -1 };
    let (p, bd, m) = (&*p, std::slice::from_raw_parts(backdrop, n * 4), std::slice::from_raw_parts(masks, n * nm));
    let o = std::slice::from_raw_parts_mut(out, n * 4);
    let u = (!under.is_null()).then(|| std::slice::from_raw_parts_mut(under, n * 4));
    // Unwinding across the FFI boundary is UB, so stop it here.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render(p, bd, m, w, h, o, u))) {
        Ok(()) => 0,
        Err(_) => -2,
    }
}

/// Rasterizes a path stream (see `fill_paths`) into `out` (`w*h` bytes). 0 = ok, -1 = bad arguments,
/// -3 = malformed stream.
///
/// # Safety
/// `stream` must point to `len` floats and `out` to `w*h` bytes.
#[no_mangle]
pub unsafe extern "C" fn lg_fill(stream: *const f32, len: u32, w: u32, h: u32, out: *mut u8) -> i32 {
    let (w, h) = (w as usize, h as usize);
    if stream.is_null() || out.is_null() || w == 0 || h == 0 {
        return -1;
    }
    let Some(n) = w.checked_mul(h) else { return -1 };
    match fill_paths(std::slice::from_raw_parts(stream, len as usize), w, h) {
        Ok(mask) => {
            std::slice::from_raw_parts_mut(out, n).copy_from_slice(&mask);
            0
        }
        Err(_) => -3,
    }
}

fn layout(len: usize) -> std::alloc::Layout {
    // 8-aligned so the same block can hold `Params` (f32s) or pixels.
    std::alloc::Layout::from_size_align(len.max(1), 8).expect("layout")
}

/// Number of f32 values `lg_render` reads from `p`; hosts check it so an outdated caller can't overread.
#[no_mangle]
pub extern "C" fn lg_param_count() -> u32 {
    PARAM_COUNT as u32
}

/// Allocator for hosts that share linear memory (wasm). Returns null on failure.
#[no_mangle]
pub extern "C" fn lg_alloc(len: usize) -> *mut u8 {
    unsafe { std::alloc::alloc(layout(len)) }
}

/// # Safety
/// `ptr`/`len` must come from `lg_alloc`.
#[no_mangle]
pub unsafe extern "C" fn lg_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        std::alloc::dealloc(ptr, layout(len));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(w: usize, h: usize, cx: f32, cy: f32, r: f32) -> Vec<u8> {
        let mut m = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                m[y * w + x] = to_u8(r - d + 0.5);
            }
        }
        m
    }

    fn stripes(w: usize, h: usize) -> Vec<u8> {
        (0..w * h).flat_map(|i| { let v = if (i % w / 4) % 2 == 0 { 230 } else { 20 }; [v, 255 - v, 128, 255] }).collect()
    }

    fn neutral() -> Params {
        Params { light_intensity: 0.0, refraction: 0.0, dispersion: 0.0, frost: 0.0, brightness: 0.0, saturation: 1.0, shadow_opacity: 0.0, ..Params::default() }
    }

    #[test]
    fn distance_of_disk_center_is_radius() {
        let m = disk(64, 64, 32.0, 32.0, 20.0);
        let d = inside_distance(&m, 64, 64);
        assert!((d[32 * 64 + 32] - 20.5).abs() < 1.0, "{}", d[32 * 64 + 32]);
        assert_eq!(d[0], 0.0);
    }

    #[test]
    fn neutral_params_pass_backdrop_through() {
        let (w, h) = (64, 64);
        let (bd, m) = (stripes(w, h), disk(w, h, 32.0, 32.0, 24.0));
        let mut out = vec![0u8; w * h * 4];
        render(&neutral(), &bd, &m, w, h, &mut out, None);
        for i in [32 * w + 32, 20 * w + 30, 40 * w + 25] {
            assert_eq!(&out[i * 4..i * 4 + 4], &[bd[i * 4], bd[i * 4 + 1], bd[i * 4 + 2], 255]);
        }
        assert_eq!(out[3], 0, "outside must stay transparent without shadow");
    }

    #[test]
    fn refraction_bends_edge_not_center() {
        let (w, h) = (96, 96);
        let (bd, m) = (stripes(w, h), disk(w, h, 48.0, 48.0, 36.0));
        let (mut a, mut b) = (vec![0u8; w * h * 4], vec![0u8; w * h * 4]);
        render(&neutral(), &bd, &m, w, h, &mut a, None);
        render(&Params { refraction: 100.0, ..neutral() }, &bd, &m, w, h, &mut b, None);
        let c = 48 * w + 48;
        assert_eq!(&a[c * 4..c * 4 + 3], &b[c * 4..c * 4 + 3], "flat center must not move");
        let edge_changed = (0..w * h).filter(|&i| m[i] == 255 && a[i * 4..i * 4 + 3] != b[i * 4..i * 4 + 3]).count();
        assert!(edge_changed > 200, "only {edge_changed} pixels bent");
    }

    #[test]
    fn shadow_falls_below_shape() {
        let (w, h) = (96, 96);
        let (bd, m) = (stripes(w, h), disk(w, h, 48.0, 40.0, 20.0));
        let mut out = vec![0u8; w * h * 4];
        render(&Params { shadow_opacity: 0.5, shadow_offset_y: 8.0, ..neutral() }, &bd, &m, w, h, &mut out, None);
        let below = out[(66 * w + 48) * 4 + 3];
        let above = out[(14 * w + 48) * 4 + 3];
        assert!(below > above && below > 10, "below {below} above {above}");
    }

    #[test]
    fn ffi_rejects_bad_args() {
        let p = Params::default();
        let buf = [0u8; 4];
        let mut out = [0u8; 4];
        assert_eq!(unsafe { lg_render(&p, buf.as_ptr(), buf.as_ptr(), 1, 0, 1, out.as_mut_ptr(), std::ptr::null_mut()) }, -1);
        assert_eq!(unsafe { lg_render(&p, buf.as_ptr(), buf.as_ptr(), 0, 1, 1, out.as_mut_ptr(), std::ptr::null_mut()) }, -1);
        assert_eq!(unsafe { lg_render(std::ptr::null(), buf.as_ptr(), buf.as_ptr(), 1, 1, 1, out.as_mut_ptr(), std::ptr::null_mut()) }, -1);
        assert_eq!(unsafe { lg_render(&p, buf.as_ptr(), buf.as_ptr(), 1, 1, 1, out.as_mut_ptr(), std::ptr::null_mut()) }, 0);
    }

    #[test]
    fn param_layout_matches_js() {
        assert_eq!(PARAM_COUNT, 42);
    }

    #[test]
    fn close_shapes_fuse_with_a_liquid_bridge() {
        let (w, h) = (120, 60);
        let mut masks = disk(w, h, 40.0, 30.0, 18.0);
        masks.extend(disk(w, h, 80.0, 30.0, 18.0)); // 4 px gap between the disks at x = 58..62
        let gap = 30 * w + 60;
        assert_eq!(smooth_union(&masks, w, h, 0.0)[gap], 0, "plain union keeps the gap");
        assert_eq!(smooth_union(&masks, w, h, 24.0)[gap], 255, "merge fills the gap");
        // Far from both shapes nothing appears.
        assert_eq!(smooth_union(&masks, w, h, 24.0)[2 * w + 60], 0);
    }

    fn circle_stream(cx: f32, cy: f32, r: f32, op: f32) -> Vec<f32> {
        let mut s = vec![op, 1.0, 256.0];
        for k in 0..256 {
            let a = k as f32 / 256.0 * std::f32::consts::TAU;
            s.extend([cx + r * a.cos(), cy + r * a.sin()]);
        }
        s
    }

    #[test]
    fn paths_fill_exactly() {
        // Square 10..30: inside full, outside empty, a half-covered edge pixel at 50%.
        let sq = [0.0, 1.0, 4.0, 10.0, 10.0, 30.0, 10.0, 30.0, 30.0, 10.0, 30.0];
        let m = fill_paths(&sq, 40, 40).unwrap();
        assert_eq!((m[20 * 40 + 20], m[5 * 40 + 5], m[20 * 40 + 30]), (255, 0, 0));
        let half = [0.0, 1.0, 4.0, 10.5, 10.0, 30.0, 10.0, 30.0, 30.0, 10.5, 30.0];
        assert!((fill_paths(&half, 40, 40).unwrap()[20 * 40 + 10] as i32 - 128).abs() <= 2);

        // Circle area matches pi r^2 to within 0.5%; corners of its box stay empty (not a rectangle).
        let c = fill_paths(&circle_stream(50.0, 50.0, 30.0, 0.0), 100, 100).unwrap();
        let area: f32 = c.iter().map(|&v| v as f32 / 255.0).sum();
        assert!((area / (std::f32::consts::PI * 900.0) - 1.0).abs() < 0.005, "area {area}");
        assert_eq!(c[22 * 100 + 22], 0);

        // Subtract punches a hole: a ring.
        let mut ring = circle_stream(50.0, 50.0, 30.0, 0.0);
        ring.extend(circle_stream(50.0, 50.0, 15.0, 1.0));
        let r = fill_paths(&ring, 100, 100).unwrap();
        assert_eq!((r[50 * 100 + 50], r[50 * 100 + 25]), (0, 255));

        assert!(fill_paths(&[0.0, 1.0, 9.0, 1.0], 10, 10).is_err(), "truncated stream");
    }

    #[test]
    fn separate_under_layer_keeps_glass_alpha_exact() {
        let (w, h) = (96, 96);
        let (bd, m) = (stripes(w, h), disk(w, h, 48.0, 40.0, 20.0));
        let (mut glass, mut under) = (vec![0u8; w * h * 4], vec![0u8; w * h * 4]);
        render(&Params { shadow_opacity: 0.5, dim: 0.3, ..neutral() }, &bd, &m, w, h, &mut glass, Some(&mut under));
        for i in 0..w * h {
            assert_eq!(glass[i * 4 + 3], m[i], "glass alpha must equal the shape at {i}");
        }
        assert!(under[(66 * w + 48) * 4 + 3] > 10, "shadow went to the under layer");
    }

    #[test]
    fn grain_and_dim_only_when_enabled() {
        let (w, h) = (64, 64);
        let (bd, m) = (stripes(w, h), disk(w, h, 32.0, 32.0, 20.0));
        let (mut plain, mut grainy, mut dimmed) = (vec![0u8; w * h * 4], vec![0u8; w * h * 4], vec![0u8; w * h * 4]);
        render(&neutral(), &bd, &m, w, h, &mut plain, None);
        render(&Params { grain: 0.5, ..neutral() }, &bd, &m, w, h, &mut grainy, None);
        render(&Params { dim: 0.5, ..neutral() }, &bd, &m, w, h, &mut dimmed, None);
        let c = (32 * w + 32) * 4;
        assert!(dimmed[c] < plain[c] / 2 + 2, "content behind glass is dimmed");
        assert!(dimmed[(32 * w + 56) * 4 + 3] > 0, "dim halo reaches outside the edge");
        assert_eq!(plain[(32 * w + 56) * 4 + 3], 0);
        assert!((0..w * h).filter(|&i| m[i] == 255 && grainy[i * 4] != plain[i * 4]).count() > 300, "grain shows");
    }

    #[test]
    fn grain_is_monochrome() {
        let (w, h) = (64, 64);
        let (bd, m) = (stripes(w, h), disk(w, h, 32.0, 32.0, 24.0));
        let (mut plain, mut grainy) = (vec![0u8; w * h * 4], vec![0u8; w * h * 4]);
        render(&neutral(), &bd, &m, w, h, &mut plain, None);
        render(&Params { grain: 0.8, ..neutral() }, &bd, &m, w, h, &mut grainy, None);
        let mut changed = 0;
        for i in (0..w * h).filter(|&i| m[i] == 255) {
            let d: Vec<i32> = (0..3).map(|c| grainy[i * 4 + c] as i32 - plain[i * 4 + c] as i32).collect();
            assert!((d[0] - d[1]).abs() <= 1 && (d[1] - d[2]).abs() <= 1, "grain tinted a pixel: {d:?}");
            changed += (d[0] != 0) as usize;
        }
        assert!(changed > 300, "grain shows");
    }

    #[test]
    fn bevel_lights_one_side_of_the_rim_and_shades_the_other() {
        let (w, h) = (96, 96);
        let bd = [128u8, 128, 128, 255].repeat(w * h);
        let m = disk(w, h, 48.0, 48.0, 36.0);
        let mut out = vec![0u8; w * h * 4];
        // Light from the top (0°), no lens, no specular sheen on flat areas: only the bevel differs top vs bottom.
        render(&Params { light_angle: 0.0, light_intensity: 1.0, ..neutral() }, &bd, &m, w, h, &mut out, None);
        let px = |x: usize, y: usize| out[(y * w + x) * 4] as i32;
        assert!(px(48, 18) > px(48, 78) + 20, "top rim {} vs bottom rim {}", px(48, 18), px(48, 78));
    }

    #[test]
    fn index_of_refraction_one_means_no_bending() {
        let (w, h) = (64, 64);
        let (bd, m) = (stripes(w, h), disk(w, h, 32.0, 32.0, 24.0));
        let mut out = vec![0u8; w * h * 4];
        render(&Params { refraction: 150.0, ior: 1.0, ..neutral() }, &bd, &m, w, h, &mut out, None);
        let rim = (32 * w + 10) * 4; // inside the rim, where glass bends the most
        assert_eq!(&out[rim..rim + 3], &bd[rim..rim + 3]);
    }

    #[test]
    fn blur_softens_everything_under_the_glass() {
        let (w, h) = (96, 96);
        let (bd, m) = (stripes(w, h), disk(w, h, 48.0, 48.0, 40.0));
        let mut out = vec![0u8; w * h * 4];
        render(&Params { frost: 8.0, ..neutral() }, &bd, &m, w, h, &mut out, None);
        // Neighbouring-pixel contrast across the middle of the glass, against the same row of the raw backdrop.
        let contrast = |img: &[u8]| (30..66).map(|x| (img[(48 * w + x) * 4] as i32 - img[(48 * w + x + 1) * 4] as i32).abs()).sum::<i32>();
        assert!(contrast(&out) * 4 < contrast(&bd), "centre not blurred: {} vs {}", contrast(&out), contrast(&bd));
    }

    #[test]
    fn inner_glow_colours_the_edge_not_the_centre() {
        let (w, h) = (96, 96);
        let bd: Vec<u8> = (0..w * h).flat_map(|_| [0, 0, 0, 255]).collect();
        let m = disk(w, h, 48.0, 48.0, 40.0);
        let mut out = vec![0u8; w * h * 4];
        let glow = Params { inner_glow: 1.0, inner_glow_size: 4.0, inner_glow_color: [1.0, 0.0, 0.0], ..neutral() };
        render(&glow, &bd, &m, w, h, &mut out, None);
        let (edge, centre) = ((48 * w + 9) * 4, (48 * w + 48) * 4);
        assert!(out[edge] > 150 && out[edge + 1] < 30, "edge not red: {:?}", &out[edge..edge + 4]);
        assert!(out[centre] < 5, "centre glows: {:?}", &out[centre..centre + 4]);
    }

    #[test]
    fn wide_edges_keep_the_lens_close() {
        assert_eq!(lens_reach(16.0), 16.0);
        assert_eq!(lens_reach(100.0), 43.0);
    }

    #[test]
    fn glow_blend_screen_never_darkens() {
        let (w, h) = (96, 96);
        let bd: Vec<u8> = (0..w * h).flat_map(|_| [200, 120, 40, 255]).collect();
        let m = disk(w, h, 48.0, 48.0, 40.0);
        let mut out = vec![0u8; w * h * 4];
        let glow = Params { inner_glow: 1.0, inner_glow_size: 4.0, inner_glow_color: [0.2, 0.2, 0.2], inner_glow_blend: 1.0, ..neutral() };
        render(&glow, &bd, &m, w, h, &mut out, None);
        let edge = (48 * w + 9) * 4;
        assert!((0..3).all(|j| out[edge + j] >= bd[edge + j]), "screen darkened: {:?}", &out[edge..edge + 4]);
    }

    #[test]
    fn stroke_paints_inside_edge_with_gradient() {
        let (w, h) = (96, 96);
        let bd: Vec<u8> = (0..w * h).flat_map(|_| [0, 0, 0, 255]).collect();
        let m = disk(w, h, 48.0, 48.0, 40.0);
        let mut out = vec![0u8; w * h * 4];
        // Red at the top fading to blue at the bottom, 3 px wide.
        let s = Params { stroke_width: 3.0, stroke_type: 1.0, stroke_angle: 0.0, stroke_opacity: [1.0, 1.0],
            stroke_color: [1.0, 0.0, 0.0], stroke_color2: [0.0, 0.0, 1.0], ..neutral() };
        render(&s, &bd, &m, w, h, &mut out, None);
        let (top, bottom, centre) = ((10 * w + 48) * 4, (86 * w + 48) * 4, (48 * w + 48) * 4);
        assert!(out[top] > 200 && out[top + 2] < 50, "top not red: {:?}", &out[top..top + 4]);
        assert!(out[bottom + 2] > 200 && out[bottom] < 50, "bottom not blue: {:?}", &out[bottom..bottom + 4]);
        assert!(out[centre] < 5 && out[centre + 2] < 5, "stroke inside the glass: {:?}", &out[centre..centre + 4]);
        assert_eq!(out[(48 * w + 5) * 4 + 3], 0, "nothing outside the shape");
    }
}
