//! Renders glass shapes over a busy test backdrop to PNG, and times a large render.
//! Usage: cargo run --release -p preview -- [out.png]

use glass_core::{render, Params};
use std::time::Instant;

fn main() {
    let out = std::env::args().nth(1).unwrap_or_else(|| "preview.png".into());
    let (w, h) = (1200, 700);
    let bd = backdrop(w, h);

    // A capsule tab bar, a round button and a big rounded panel; depth = 25% of the short side, as the plugin sets it.
    let base = Params { refraction: 80.0, ..Params::default() };
    let shapes: [(fn(f32, f32) -> f32, Params); 3] = [
        (|x, y| rounded_box(x, y, 600.0, 110.0, 380.0, 50.0, 50.0), Params { depth: 25.0, ..base }),
        (|x, y| ((x - 1050.0).powi(2) + (y - 110.0).powi(2)).sqrt() - 55.0, Params { depth: 28.0, tint: [0.1, 0.5, 1.0, 0.55], ..base }),
        (|x, y| rounded_box(x, y, 600.0, 450.0, 420.0, 170.0, 44.0), Params { frost: 14.0, depth: 85.0, dispersion: 35.0, ..base }),
    ];

    let mut img = bd.clone();
    for (sd, p) in shapes.iter() {
        let mask: Vec<u8> = (0..w * h).map(|i| cov(sd((i % w) as f32, (i / w) as f32))).collect();
        let mut layer = vec![0u8; w * h * 4];
        let t = Instant::now();
        render(p, &img, &mask, w, h, &mut layer, None);
        eprintln!("shape render {w}x{h}: {:?}", t.elapsed());
        over(&mut img, &layer);
    }
    save(&out, &img, w, h);

    // Big shape, like a Photoshop layer ~1100 px wide, with the plugin's size-scaled depth (20% of short side).
    let (bw, bh) = (1600, 900);
    let mut big = backdrop(bw, bh);
    let mask: Vec<u8> = (0..bw * bh).map(|i| cov(rounded_box((i % bw) as f32, (i / bw) as f32, 800.0, 450.0, 550.0, 300.0, 70.0))).collect();
    let mut layer = vec![0u8; bw * bh * 4];
    let t = Instant::now();
    render(&Params { depth: 120.0, ..Params::default() }, &big, &mask, bw, bh, &mut layer, None);
    eprintln!("big render {bw}x{bh}: {:?}", t.elapsed());
    over(&mut big, &layer);
    let big_out = out.replace(".png", "_big.png");
    save(&big_out, &big, bw, bh);

    // Three shapes in one glass: a panel, an overlapping circle and a pill just beside it. They fuse like liquid.
    let mut liquid = backdrop(bw, bh);
    let sdfs: [fn(f32, f32) -> f32; 3] = [
        |x, y| rounded_box(x, y, 650.0, 450.0, 330.0, 200.0, 60.0),
        |x, y| ((x - 1060.0).powi(2) + (y - 290.0).powi(2)).sqrt() - 130.0,
        |x, y| rounded_box(x, y, 1080.0, 640.0, 120.0, 55.0, 55.0),
    ];
    let masks: Vec<u8> = sdfs.iter().flat_map(|sd| (0..bw * bh).map(move |i| cov(sd((i % bw) as f32, (i / bw) as f32)))).collect();
    let t = Instant::now();
    render(&Params { depth: 90.0, merge: 70.0, grain: 0.25, dim: 0.25, ..Params::default() }, &liquid, &masks, bw, bh, &mut layer, None);
    eprintln!("liquid render (3 shapes) {bw}x{bh}: {:?}", t.elapsed());
    over(&mut liquid, &layer);
    let liquid_out = out.replace(".png", "_liquid.png");
    save(&liquid_out, &liquid, bw, bh);
    eprintln!("wrote {out}, {big_out}, {liquid_out}");
}

fn cov(sd: f32) -> u8 {
    ((0.5 - sd).clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

fn rounded_box(x: f32, y: f32, cx: f32, cy: f32, hw: f32, hh: f32, r: f32) -> f32 {
    let (qx, qy) = ((x - cx).abs() - hw + r, (y - cy).abs() - hh + r);
    (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r
}

/// Colourful gradient, stripes, discs and "text" bars: shows refraction, frost and dispersion clearly.
fn backdrop(w: usize, h: usize) -> Vec<u8> {
    let mut v = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let (u, t) = (x as f32 / w as f32, y as f32 / h as f32);
            let mut c = [0.95 - 0.6 * t, 0.35 + 0.5 * u, 0.55 + 0.4 * (1.0 - u) * t];
            if (x / 18) % 2 == 0 && y > h / 3 {
                c = [c[0] * 0.55, c[1] * 0.55, c[2] * 0.6];
            }
            for (cx, cy, r, col) in [(250.0, 150.0, 90.0, [1.0, 0.85, 0.1]), (820.0, 420.0, 120.0, [0.1, 0.2, 0.9]), (480.0, 520.0, 70.0, [0.95, 0.1, 0.4])] {
                if ((x as f32 - cx * w as f32 / 1200.0).powi(2) + (y as f32 - cy * h as f32 / 700.0).powi(2)).sqrt() < r {
                    c = col;
                }
            }
            if (y % 40) < 6 && (x % 160) < 120 && y < h / 3 {
                c = [0.05, 0.05, 0.08];
            }
            for k in 0..3 {
                v[(y * w + x) * 4 + k] = (c[k].clamp(0.0, 1.0) * 255.0) as u8;
            }
            v[(y * w + x) * 4 + 3] = 255;
        }
    }
    v
}

/// Straight-alpha "over" onto an opaque image.
fn over(dst: &mut [u8], src: &[u8]) {
    for (d, s) in dst.chunks_mut(4).zip(src.chunks(4)) {
        let a = s[3] as f32 / 255.0;
        for k in 0..3 {
            d[k] = (s[k] as f32 * a + d[k] as f32 * (1.0 - a) + 0.5) as u8;
        }
    }
}

fn save(path: &str, rgba: &[u8], w: usize, h: usize) {
    let f = std::io::BufWriter::new(std::fs::File::create(path).expect("create png"));
    let mut e = png::Encoder::new(f, w as u32, h as u32);
    e.set_color(png::ColorType::Rgba);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().unwrap().write_image_data(rgba).unwrap();
}
