use std::io::Write as _;

use crate::canvas::Canvas;
use crate::surfaces::Rect;

const CUBE_LEVELS: u32 = 6;
const CUBE_SIZE: usize = 216;
const GRAY_LEVELS: u32 = 40;
const PALETTE_SIZE: usize = CUBE_SIZE + GRAY_LEVELS as usize;
// Below this spread between channels a pixel is drawn from the gray ramp, which keeps text crisp.
const GRAY_CHROMA: u8 = 12;
const BAND: u32 = 6;
const NOT_SHOWN: u16 = u16::MAX;

const BAYER: [[u32; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

pub(crate) const GRAPHICS_PROBE_ID: u32 = 31;

/// Asks for kitty graphics and then for the device attributes, which every terminal answers,
/// so the attributes reply arriving first means kitty graphics are unsupported.
pub(crate) fn graphics_probe() -> Vec<u8> {
    format!("\x1b_Gi={GRAPHICS_PROBE_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c").into_bytes()
}

pub(crate) fn draws_sixels(buf: &[u8]) -> Option<bool> {
    let start = buf.windows(3).position(|w| w == b"\x1b[?")? + 3;
    let params = &buf[start..];
    let end = params.iter().position(|b| !(b.is_ascii_digit() || *b == b';'))?;
    if params[end] != b'c' {
        return draws_sixels(&params[end..]);
    }
    let sixel = params[..end].split(|&b| b == b';').any(|attribute| attribute == b"4");
    let kitty_reply = format!("\x1b_Gi={GRAPHICS_PROBE_ID};OK");
    let kitty = buf.windows(kitty_reply.len()).any(|w| w == kitty_reply.as_bytes());
    Some(sixel && !kitty)
}

fn cube_level(value: u8, threshold: u32) -> usize {
    ((u32::from(value) * (CUBE_LEVELS - 1) * 16 + threshold * 255) / (255 * 16)).min(CUBE_LEVELS - 1) as usize
}

pub(crate) fn quantize(r: u8, g: u8, b: u8, x: u32, y: u32) -> u8 {
    let chroma = r.max(g).max(b) - r.min(g).min(b);
    if chroma < GRAY_CHROMA {
        let luma = (u32::from(r) + u32::from(g) + u32::from(b)) / 3;
        return (CUBE_SIZE as u32 + (luma * (GRAY_LEVELS - 1) + 127) / 255) as u8;
    }
    let threshold = BAYER[(y % 4) as usize][(x % 4) as usize];
    (cube_level(r, threshold) * 36 + cube_level(g, threshold) * 6 + cube_level(b, threshold)) as u8
}

fn palette_rgb(index: u8) -> (u32, u32, u32) {
    let index = usize::from(index);
    if index < CUBE_SIZE {
        let level = |l: usize| l as u32 * 255 / (CUBE_LEVELS - 1);
        return (level(index / 36), level(index / 6 % 6), level(index % 6));
    }
    let gray = (index - CUBE_SIZE) as u32 * 255 / (GRAY_LEVELS - 1);
    (gray, gray, gray)
}

fn push_run(out: &mut Vec<u8>, sixel: u8, count: u32) {
    match count {
        0 => {}
        1..=3 => out.extend(std::iter::repeat_n(sixel, count as usize)),
        _ => {
            let _ = write!(out, "!{count}");
            out.push(sixel);
        }
    }
}

/// What the terminal currently shows, so each frame only paints the pixels whose color changed.
#[derive(Debug, Default)]
pub(crate) struct Screen {
    width: u32,
    height: u32,
    shown: Vec<u16>,
}

impl Screen {
    /// Returns one sixel image anchored at the top left corner, or nothing when no pixel changed.
    /// Unpainted pixels stay transparent, so the terminal keeps what it drew before under them.
    pub(crate) fn update(&mut self, canvas: &Canvas, premultiplied: bool, damage: &[Rect]) -> Vec<u8> {
        let (width, height) = (canvas.width, canvas.height);
        let whole = [Rect::sized(width, height)];
        let damage: &[Rect] = if self.width != width || self.height != height || self.shown.is_empty() {
            self.width = width;
            self.height = height;
            self.shown = vec![NOT_SHOWN; width as usize * height as usize];
            &whole
        } else {
            damage
        };
        let damage: Vec<Rect> = damage.iter().map(|r| r.clamped(width, height)).filter(|r| !r.is_empty()).collect();
        if damage.is_empty() {
            return Vec::new();
        }

        let mut bands: Vec<Vec<u8>> = Vec::new();
        let mut used = [false; PALETTE_SIZE];
        let mut right = 0u32;
        let mut last_band = None;
        let mut colors: Vec<Vec<(u32, u8)>> = vec![Vec::new(); PALETTE_SIZE];
        for band in 0..height.div_ceil(BAND) {
            let top = band * BAND;
            let bottom = (top + BAND).min(height);
            let Some((x0, x1)) = damage
                .iter()
                .filter(|r| r.y < bottom && r.y + r.h > top)
                .map(|r| (r.x, r.x + r.w))
                .reduce(|a, b| (a.0.min(b.0), a.1.max(b.1)))
            else {
                bands.push(Vec::new());
                continue;
            };
            for list in &mut colors {
                list.clear();
            }
            for x in x0..x1 {
                for y in top..bottom {
                    let at = (y * width + x) as usize;
                    let index = quantize_pixel(&canvas.pixels[at * 4..at * 4 + 4], premultiplied, x, y);
                    if self.shown[at] == u16::from(index) {
                        continue;
                    }
                    self.shown[at] = u16::from(index);
                    let bit = 1u8 << (y - top);
                    let list = &mut colors[usize::from(index)];
                    match list.last_mut() {
                        Some((last, bits)) if *last == x => *bits |= bit,
                        _ => list.push((x, bit)),
                    }
                }
            }
            let mut body = Vec::new();
            for (index, list) in colors.iter().enumerate().filter(|(_, list)| !list.is_empty()) {
                used[index] = true;
                right = right.max(list.last().map_or(0, |&(x, _)| x + 1));
                if !body.is_empty() {
                    body.push(b'$');
                }
                let _ = write!(body, "#{index}");
                let mut cursor = 0;
                let mut run: Option<(u8, u32)> = None;
                for &(x, bits) in list {
                    let sixel = 63 + bits;
                    match run {
                        Some((same, count)) if same == sixel && cursor == x => run = Some((same, count + 1)),
                        _ => {
                            if let Some((previous, count)) = run {
                                push_run(&mut body, previous, count);
                            }
                            push_run(&mut body, b'?', x - cursor);
                            run = Some((sixel, 1));
                        }
                    }
                    cursor = x + 1;
                }
                if let Some((previous, count)) = run {
                    push_run(&mut body, previous, count);
                }
            }
            if !body.is_empty() {
                last_band = Some(band);
            }
            bands.push(body);
        }

        let Some(last_band) = last_band else {
            return Vec::new();
        };
        let image_height = ((last_band + 1) * BAND).min(height);
        let mut out = Vec::new();
        let _ = write!(out, "\x1bP0;1;0q\"1;1;{right};{image_height}");
        for (index, _) in used.iter().enumerate().filter(|(_, used)| **used) {
            let (r, g, b) = palette_rgb(index as u8);
            let _ = write!(out, "#{index};2;{};{};{}", r * 100 / 255, g * 100 / 255, b * 100 / 255);
        }
        for (band, body) in bands.iter().enumerate().take(last_band as usize + 1) {
            if band > 0 {
                out.push(b'-');
            }
            out.extend_from_slice(body);
        }
        out.extend_from_slice(b"\x1b\\");
        out
    }
}

fn quantize_pixel(px: &[u8], premultiplied: bool, x: u32, y: u32) -> u8 {
    let alpha = u32::from(px[3]);
    let over_black = |c: u8| if premultiplied { c } else { (u32::from(c) * alpha / 255) as u8 };
    quantize(over_black(px[0]), over_black(px[1]), over_black(px[2]), x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canvas(width: u32, height: u32, color: [u8; 4]) -> Canvas {
        let mut canvas = Canvas::new(width, height);
        for px in canvas.pixels.chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
        canvas
    }

    fn paint(canvas: &mut Canvas, x: u32, y: u32, color: [u8; 4]) {
        let at = ((y * canvas.width + x) * 4) as usize;
        canvas.pixels[at..at + 4].copy_from_slice(&color);
    }

    fn text(bytes: &[u8]) -> String {
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    const WHITE: [u8; 4] = [255, 255, 255, 255];
    const BLACK: [u8; 4] = [0, 0, 0, 255];
    const RED: [u8; 4] = [255, 0, 0, 255];

    #[test]
    fn the_device_attributes_reply_settles_whether_to_draw_sixels() {
        let windows_terminal = b"\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c";
        assert_eq!(draws_sixels(windows_terminal), Some(true));
        assert_eq!(draws_sixels(b"\x1b[?62;22c"), Some(false), "no sixel attribute");
        assert_eq!(draws_sixels(b"\x1b_Gi=31;OK\x1b\\\x1b[?62;4c"), Some(false), "kitty graphics win when both answer");
        assert_eq!(draws_sixels(b"\x1b[?1016;2$y\x1b[?64;4"), None, "reply still arriving");
        assert_eq!(draws_sixels(b"\x1b[?14;42c"), Some(false), "4 only counts as a whole attribute");
    }

    #[test]
    fn grays_come_from_the_ramp_and_colors_from_the_cube() {
        assert_eq!(quantize(255, 255, 255, 0, 0), 255);
        assert_eq!(quantize(0, 0, 0, 0, 0), 216);
        assert_eq!(quantize(128, 130, 126, 0, 0), 216 + 20);
        assert_eq!(quantize(255, 0, 0, 0, 0), 5 * 36);
        assert_eq!(quantize(0, 0, 255, 3, 3), 5);
        assert_eq!(palette_rgb(5 * 36), (255, 0, 0));
        assert_eq!(palette_rgb(255), (255, 255, 255));
    }

    #[test]
    fn a_color_between_cube_levels_dithers_by_position() {
        let tones: std::collections::HashSet<u8> = (0..4).flat_map(|y| (0..4).map(move |x| quantize(150, 30, 30, x, y))).collect();
        assert!(tones.len() > 1, "a flat area should mix neighbouring levels: {tones:?}");
    }

    #[test]
    fn the_first_frame_paints_every_pixel_with_runs() {
        let mut screen = Screen::default();
        let frame = screen.update(&canvas(10, 6, WHITE), false, &[]);
        assert_eq!(text(&frame), "\x1bP0;1;0q\"1;1;10;6#255;2;100;100;100#255!10~\x1b\\");
    }

    #[test]
    fn an_unchanged_frame_sends_nothing() {
        let mut screen = Screen::default();
        let canvas = canvas(10, 6, WHITE);
        screen.update(&canvas, false, &[]);
        assert!(screen.update(&canvas, false, &[Rect::sized(10, 6)]).is_empty());
    }

    #[test]
    fn a_changed_pixel_is_sent_alone_after_a_transparent_gap() {
        let mut screen = Screen::default();
        let mut canvas = canvas(10, 12, WHITE);
        screen.update(&canvas, false, &[]);
        paint(&mut canvas, 7, 8, BLACK);
        let frame = screen.update(&canvas, false, &[Rect::sized(10, 12)]);
        assert_eq!(text(&frame), "\x1bP0;1;0q\"1;1;8;12#216;2;0;0;0-#216!7?C\x1b\\");
    }

    #[test]
    fn colors_in_one_band_are_overlaid_with_carriage_returns() {
        let mut screen = Screen::default();
        let mut canvas = canvas(4, 6, WHITE);
        for y in 0..6 {
            paint(&mut canvas, 0, y, RED);
        }
        let frame = screen.update(&canvas, false, &[]);
        assert_eq!(text(&frame), "\x1bP0;1;0q\"1;1;4;6#180;2;100;0;0#255;2;100;100;100#180~$#255?~~~\x1b\\");
    }

    #[test]
    fn changes_outside_the_damage_wait_for_a_later_frame() {
        let mut screen = Screen::default();
        let mut canvas = canvas(10, 6, WHITE);
        screen.update(&canvas, false, &[]);
        paint(&mut canvas, 1, 0, BLACK);
        paint(&mut canvas, 8, 0, BLACK);
        let frame = text(&screen.update(&canvas, false, &[Rect { x: 0, y: 0, w: 4, h: 6 }]));
        assert!(frame.contains("#216?@") && !frame.contains("!7?"), "{frame}");
        let later = text(&screen.update(&canvas, false, &[Rect::sized(10, 6)]));
        assert!(later.contains("#216!8?@"), "{later}");
    }

    #[test]
    fn a_height_off_the_band_grid_ends_in_a_partial_band() {
        let mut screen = Screen::default();
        let frame = screen.update(&canvas(2, 8, BLACK), false, &[]);
        assert_eq!(text(&frame), "\x1bP0;1;0q\"1;1;2;8#216;2;0;0;0#216~~-#216BB\x1b\\");
    }

    #[test]
    fn a_resize_repaints_everything() {
        let mut screen = Screen::default();
        screen.update(&canvas(4, 6, WHITE), false, &[]);
        let frame = text(&screen.update(&canvas(5, 6, WHITE), false, &[]));
        assert!(frame.contains("\"1;1;5;6") && frame.contains("!5~"), "{frame}");
    }

    #[test]
    fn straight_alpha_is_drawn_over_black() {
        let mut screen = Screen::default();
        let frame = text(&screen.update(&canvas(1, 1, [255, 255, 255, 0]), false, &[]));
        assert!(frame.contains("#216;2;0;0;0"), "{frame}");
    }
}
