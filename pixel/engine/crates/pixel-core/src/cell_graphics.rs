use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rayon::prelude::*;

/// Image protocols that paint pixels into the cells under the cursor, with no ids, layers or
/// deletes: https://vt100.net/docs/vt3xx-gp/chapter14.html and https://iterm2.com/documentation-images.html
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CellProtocol {
    Sixel,
    Iterm2,
}

impl CellProtocol {
    pub(crate) fn encode(self, rgb: &[u8], width: u32, height: u32) -> Vec<u8> {
        match self {
            CellProtocol::Sixel => sixel(rgb, width, height),
            CellProtocol::Iterm2 => iterm2(rgb, width, height),
        }
    }
}

/// Drops alpha by laying the pixels over black, which for premultiplied pixels is just their color.
pub(crate) fn over_black(rgba: &[u8], premultiplied: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3);
    for px in rgba.chunks_exact(4) {
        if premultiplied || px[3] == 255 {
            out.extend_from_slice(&px[..3]);
        } else {
            let a = u32::from(px[3]);
            out.extend(px[..3].iter().map(|&c| ((u32::from(c) * a + 127) / 255) as u8));
        }
    }
    out
}

const BAND: u32 = 6;
const LEVELS: [u32; 3] = [6, 7, 6];
const BAYER: [[i32; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

struct Palette {
    colors: Vec<[u8; 3]>,
    indices: Vec<u8>,
}

fn exact_palette(rgb: &[u8]) -> Option<Palette> {
    let mut lookup = std::collections::HashMap::new();
    let mut colors = Vec::new();
    let mut indices = Vec::with_capacity(rgb.len() / 3);
    for px in rgb.chunks_exact(3) {
        let key = [px[0], px[1], px[2]];
        let index = match lookup.get(&key) {
            Some(&index) => index,
            None => {
                if colors.len() == 256 {
                    return None;
                }
                let index = colors.len() as u8;
                lookup.insert(key, index);
                colors.push(key);
                index
            }
        };
        indices.push(index);
    }
    Some(Palette { colors, indices })
}

fn level(value: u8, levels: u32, threshold: i32) -> u32 {
    let steps = levels - 1;
    let scaled = i32::from(value) * steps as i32 * 16 + threshold * 255 / 16 + 255 * 8;
    ((scaled / (255 * 16)) as u32).min(steps)
}

fn dithered_palette(rgb: &[u8], width: u32) -> Palette {
    let mut colors = Vec::with_capacity(252);
    for r in 0..LEVELS[0] {
        for g in 0..LEVELS[1] {
            for b in 0..LEVELS[2] {
                let scale = |v: u32, levels: u32| (v * 255 / (levels - 1)) as u8;
                colors.push([scale(r, LEVELS[0]), scale(g, LEVELS[1]), scale(b, LEVELS[2])]);
            }
        }
    }
    let indices = rgb
        .chunks_exact(3)
        .enumerate()
        .map(|(i, px)| {
            let (x, y) = (i as u32 % width, i as u32 / width);
            let threshold = BAYER[(y % 4) as usize][(x % 4) as usize] * 16 - 120;
            let r = level(px[0], LEVELS[0], threshold);
            let g = level(px[1], LEVELS[1], threshold);
            let b = level(px[2], LEVELS[2], threshold);
            ((r * LEVELS[1] + g) * LEVELS[2] + b) as u8
        })
        .collect();
    Palette { colors, indices }
}

fn push_run(out: &mut Vec<u8>, ch: u8, count: usize) {
    if count > 3 {
        out.extend_from_slice(format!("!{count}").as_bytes());
        out.push(ch);
    } else {
        out.extend(std::iter::repeat_n(ch, count));
    }
}

fn encode_band(indices: &[u8], width: usize, rows: usize, palette_len: usize) -> Vec<u8> {
    let mut slot = vec![u16::MAX; palette_len];
    let mut used: Vec<(u8, usize, usize)> = Vec::new();
    for row in 0..rows {
        for (x, &c) in indices[row * width..(row + 1) * width].iter().enumerate() {
            match slot[c as usize] {
                u16::MAX => {
                    slot[c as usize] = used.len() as u16;
                    used.push((c, x, x));
                }
                s => {
                    let entry = &mut used[s as usize];
                    entry.1 = entry.1.min(x);
                    entry.2 = entry.2.max(x);
                }
            }
        }
    }
    let mut masks = vec![0u8; used.len() * width];
    for row in 0..rows {
        for (x, &c) in indices[row * width..(row + 1) * width].iter().enumerate() {
            masks[slot[c as usize] as usize * width + x] |= 1 << row;
        }
    }
    let mut out = Vec::new();
    for (s, &(color, min_x, max_x)) in used.iter().enumerate() {
        if s > 0 {
            out.push(b'$');
        }
        out.extend_from_slice(format!("#{color}").as_bytes());
        push_run(&mut out, b'?', min_x);
        let line = &masks[s * width + min_x..=s * width + max_x];
        let mut run_ch = line[0] + 63;
        let mut run = 0;
        for &mask in line {
            let ch = mask + 63;
            if ch == run_ch {
                run += 1;
            } else {
                push_run(&mut out, run_ch, run);
                run_ch = ch;
                run = 1;
            }
        }
        push_run(&mut out, run_ch, run);
    }
    out.push(b'-');
    out
}

pub(crate) fn sixel(rgb: &[u8], width: u32, height: u32) -> Vec<u8> {
    assert_eq!(rgb.len(), (width * height * 3) as usize);
    let palette = crate::profiler::span("sixel.palette", || {
        exact_palette(rgb).unwrap_or_else(|| dithered_palette(rgb, width))
    });
    let w = width as usize;
    let bands: Vec<Vec<u8>> = crate::profiler::span("sixel.bands", || {
        palette
            .indices
            .par_chunks(w * BAND as usize)
            .map(|band| encode_band(band, w, band.len() / w, palette.colors.len()))
            .collect()
    });
    // P2=1 keeps cells we leave unpainted as they were instead of filling them with color 0.
    let mut out = format!("\x1bP0;1;0q\"1;1;{width};{height}").into_bytes();
    let percent = |v: u8| (u32::from(v) * 100 + 127) / 255;
    for (i, [r, g, b]) in palette.colors.iter().enumerate() {
        out.extend_from_slice(format!("#{i};2;{};{};{}", percent(*r), percent(*g), percent(*b)).as_bytes());
    }
    for band in bands {
        out.extend_from_slice(&band);
    }
    out.extend_from_slice(b"\x1b\\");
    out
}

fn png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, png::EncodingError> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    // Measured on a phone: a third of the bytes of the fastest setting for a few more milliseconds,
    // and every byte has to be parsed by the terminal.
    encoder.set_filter(png::Filter::Up);
    encoder.set_deflate_compression(png::DeflateCompression::Level(1));
    encoder.write_header()?.write_image_data(rgb)?;
    Ok(out)
}

pub(crate) fn iterm2(rgb: &[u8], width: u32, height: u32) -> Vec<u8> {
    let Ok(png) = crate::profiler::span("iterm2.png", || png(rgb, width, height)) else {
        return Vec::new();
    };
    iterm2_file(&png, width, height)
}

const SOFT_JPEG_QUALITY: u8 = 70;

/// A JPEG at half the size, which the terminal stretches back over the same cells. Far fewer bytes
/// to send and decode for video, at the cost of a blur that text should not have to live with.
pub(crate) fn iterm2_soft(rgb: &[u8], width: u32, height: u32) -> Vec<u8> {
    let (small, small_width, small_height) = crate::profiler::span("iterm2.halve", || halve(rgb, width, height));
    let mut jpeg = Vec::new();
    let encoded = crate::profiler::span("iterm2.jpeg", || {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, SOFT_JPEG_QUALITY).encode(
            &small,
            small_width,
            small_height,
            image::ExtendedColorType::Rgb8,
        )
    });
    if encoded.is_err() {
        return iterm2(rgb, width, height);
    }
    iterm2_file(&jpeg, width, height)
}

fn iterm2_file(file: &[u8], width: u32, height: u32) -> Vec<u8> {
    let payload = crate::profiler::span("iterm2.base64", || BASE64.encode(file));
    let mut out = format!(
        "\x1b]1337;File=inline=1;size={};width={width}px;height={height}px;preserveAspectRatio=0:",
        file.len()
    )
    .into_bytes();
    out.extend_from_slice(payload.as_bytes());
    out.push(0x07);
    out
}

/// Averages each 2x2 block of pixels into one.
fn halve(rgb: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let (w, h) = (width as usize, height as usize);
    let (half_w, half_h) = (w.div_ceil(2), h.div_ceil(2));
    let mut out = vec![0u8; half_w * half_h * 3];
    out.par_chunks_mut(half_w * 3).enumerate().for_each(|(y, row)| {
        let rows = [2 * y, (2 * y + 1).min(h - 1)];
        for x in 0..half_w {
            let cols = [2 * x, (2 * x + 1).min(w - 1)];
            for c in 0..3 {
                let sum: u32 = rows
                    .iter()
                    .flat_map(|&sy| cols.iter().map(move |&sx| u32::from(rgb[(sy * w + sx) * 3 + c])))
                    .sum();
                row[x * 3 + c] = ((sum + 2) / 4) as u8;
            }
        }
    });
    (out, half_w as u32, half_h as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_sixel(seq: &[u8], width: usize, height: usize) -> Vec<[u8; 3]> {
        let body = std::str::from_utf8(seq).unwrap();
        let body = body.strip_prefix("\x1bP0;1;0q").unwrap().strip_suffix("\x1b\\").unwrap();
        let mut colors = std::collections::HashMap::new();
        let mut out = vec![[0u8; 3]; width * height];
        let (mut x, mut band, mut color) = (0usize, 0usize, 0u32);
        let bytes = body.as_bytes();
        let mut i = 0;
        let number = |i: &mut usize| {
            let start = *i;
            while *i < bytes.len() && bytes[*i].is_ascii_digit() {
                *i += 1;
            }
            body[start..*i].parse::<u32>().unwrap()
        };
        while i < bytes.len() {
            match bytes[i] {
                b'"' => {
                    while bytes[i] != b'#' {
                        i += 1;
                    }
                }
                b'#' => {
                    i += 1;
                    color = number(&mut i);
                    if bytes.get(i) == Some(&b';') {
                        i += 3;
                        let r = number(&mut i);
                        i += 1;
                        let g = number(&mut i);
                        i += 1;
                        let b = number(&mut i);
                        let back = |p: u32| (p * 255 / 100) as u8;
                        colors.insert(color, [back(r), back(g), back(b)]);
                    }
                }
                b'$' => {
                    x = 0;
                    i += 1;
                }
                b'-' => {
                    x = 0;
                    band += 1;
                    i += 1;
                }
                b'!' => {
                    i += 1;
                    let count = number(&mut i) as usize;
                    let mask = bytes[i] - 63;
                    for _ in 0..count {
                        paint(&mut out, width, height, x, band, mask, colors[&color]);
                        x += 1;
                    }
                    i += 1;
                }
                ch => {
                    paint(&mut out, width, height, x, band, ch - 63, colors[&color]);
                    x += 1;
                    i += 1;
                }
            }
        }
        out
    }

    fn paint(out: &mut [[u8; 3]], width: usize, height: usize, x: usize, band: usize, mask: u8, rgb: [u8; 3]) {
        for bit in 0..6 {
            let y = band * 6 + bit;
            if mask & (1 << bit) != 0 && y < height && x < width {
                out[y * width + x] = rgb;
            }
        }
    }

    #[test]
    fn few_colors_round_trip_exactly_through_sixel() {
        let (w, h) = (7usize, 9usize);
        let mut rgb = Vec::new();
        for y in 0..h {
            for x in 0..w {
                rgb.extend_from_slice(if (x + y) % 3 == 0 { &[255, 0, 0] } else if x < 3 { &[0, 0, 255] } else { &[255, 255, 255] });
            }
        }
        let decoded = decode_sixel(&sixel(&rgb, w as u32, h as u32), w, h);
        let expected: Vec<[u8; 3]> = rgb.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
        assert_eq!(decoded, expected);
    }

    #[test]
    fn many_colors_are_dithered_close_to_the_source() {
        let (w, h) = (64usize, 13usize);
        let rgb: Vec<u8> = (0..w * h).flat_map(|i| [(i % 256) as u8, (i * 7 % 256) as u8, (i / w * 19 % 256) as u8]).collect();
        let decoded = decode_sixel(&sixel(&rgb, w as u32, h as u32), w, h);
        for (px, source) in decoded.iter().zip(rgb.chunks_exact(3)) {
            for c in 0..3 {
                assert!((i32::from(px[c]) - i32::from(source[c])).abs() <= 52, "{px:?} vs {source:?}");
            }
        }
    }

    #[test]
    fn iterm2_wraps_a_png_sized_in_pixels() {
        let out = String::from_utf8(iterm2(&[10, 20, 30, 40, 50, 60], 2, 1)).unwrap();
        assert!(out.starts_with("\x1b]1337;File=inline=1;size="));
        assert!(out.contains(";width=2px;height=1px;preserveAspectRatio=0:"));
        let payload = out.split_once(':').unwrap().1.strip_suffix('\x07').unwrap();
        let png = BASE64.decode(payload).unwrap();
        let image = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!(image.into_raw(), vec![10, 20, 30, 40, 50, 60]);
    }

    #[test]
    fn soft_images_are_half_size_jpegs_stretched_over_the_same_pixels() {
        let rgb: Vec<u8> = (0..40 * 21).flat_map(|_| [200, 100, 50]).collect();
        let out = String::from_utf8(iterm2_soft(&rgb, 40, 21)).unwrap();
        assert!(out.contains(";width=40px;height=21px;preserveAspectRatio=0:"));
        let payload = out.split_once(':').unwrap().1.strip_suffix('\x07').unwrap();
        let jpeg = BASE64.decode(payload).unwrap();
        assert_eq!(image::guess_format(&jpeg).unwrap(), image::ImageFormat::Jpeg);
        let image = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (20, 11));
        assert!(image.pixels().all(|p| p.0.iter().zip([200, 100, 50]).all(|(&a, b)| a.abs_diff(b) <= 4)));
    }

    #[test]
    fn halving_averages_each_block_and_keeps_odd_edges() {
        let rgb = [0, 0, 0, 100, 100, 100, 7, 7, 7, 200, 200, 200, 0, 0, 0, 9, 9, 9];
        assert_eq!(halve(&rgb, 3, 2), (vec![75, 75, 75, 8, 8, 8], 2, 1));
    }

    #[test]
    fn straight_alpha_is_laid_over_black() {
        assert_eq!(over_black(&[200, 100, 50, 128, 1, 2, 3, 255], false), vec![100, 50, 25, 1, 2, 3]);
        assert_eq!(over_black(&[100, 50, 25, 128], true), vec![100, 50, 25]);
    }
}
