//! Command-line renderer for engine test renders (e.g. comparing settings on a test image). Params: all PARAM_COUNT values.
//! Usage: lgcli <backdrop.png> <out.png> <comma-separated params> <mask.png> [more masks...]
//! Mask = alpha channel; several masks fuse into one liquid body. Images may differ by a pixel from host
//! rounding; the overlap is used.
//! Writes <out.png>.done when finished so the caller can poll.

use glass_core::{render, Params, PARAM_COUNT};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Err(e) = run(&args) {
        eprintln!("lgcli: {e}");
        if let Some(out) = args.get(2) {
            let _ = std::fs::write(format!("{out}.done"), format!("error: {e}"));
        }
        std::process::exit(1);
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let [_, bd_path, out, ps, mask_paths @ ..] = args else {
        return Err("usage: lgcli <backdrop.png> <out.png> <p1,...,pN> <mask.png> [more masks...]".into());
    };
    if mask_paths.is_empty() {
        return Err("at least one mask is required".into());
    }
    let v: Vec<f32> = ps.split(',').map(|s| s.trim().parse::<f32>()).collect::<Result<_, _>>().map_err(|e| format!("params: {e}"))?;
    if v.len() != PARAM_COUNT || v.iter().any(|x| !x.is_finite()) {
        return Err(format!("expected {PARAM_COUNT} finite params, got {}", v.len()));
    }
    // Params is repr(C), all f32, PARAM_COUNT long (checked above): read it straight from the list.
    let p: Params = unsafe { std::ptr::read_unaligned(v.as_ptr() as *const Params) };
    let (bd, bw, bh) = read_rgba(bd_path)?;
    let mks = mask_paths.iter().map(|m| read_rgba(m)).collect::<Result<Vec<_>, _>>()?;
    let w = mks.iter().fold(bw, |a, m| a.min(m.1));
    let h = mks.iter().fold(bh, |a, m| a.min(m.2));
    let backdrop = crop(&bd, bw, w, h, 4);
    let masks: Vec<u8> = mks.iter().flat_map(|(px, mw, _)| crop(px, *mw, w, h, 4).chunks(4).map(|c| c[3]).collect::<Vec<_>>()).collect();
    let mut layer = vec![0u8; w * h * 4];
    render(&p, &backdrop, &masks, w, h, &mut layer, None);
    write_rgba(out, &layer, w, h)?;
    std::fs::write(format!("{out}.done"), "ok").map_err(|e| e.to_string())
}

fn crop(px: &[u8], src_w: usize, w: usize, h: usize, n: usize) -> Vec<u8> {
    (0..h).flat_map(|y| px[y * src_w * n..(y * src_w + w) * n].iter().copied()).collect()
}

fn read_rgba(path: &str) -> Result<(Vec<u8>, usize, usize), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut dec = png::Decoder::new(std::io::BufReader::new(file));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut r = dec.read_info().map_err(|e| format!("{path}: {e}"))?;
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).map_err(|e| format!("{path}: {e}"))?;
    let (w, h) = (info.width as usize, info.height as usize);
    let src = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => src.to_vec(),
        png::ColorType::Rgb => src.chunks(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => src.chunks(2).flat_map(|c| [c[0], c[0], c[0], c[1]]).collect(),
        png::ColorType::Grayscale => src.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err(format!("{path}: unexpanded palette")),
    };
    Ok((rgba, w, h))
}

fn write_rgba(path: &str, rgba: &[u8], w: usize, h: usize) -> Result<(), String> {
    let f = std::fs::File::create(path).map_err(|e| format!("{path}: {e}"))?;
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), w as u32, h as u32);
    e.set_color(png::ColorType::Rgba);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().and_then(|mut wr| wr.write_image_data(rgba)).map_err(|e| e.to_string())
}
