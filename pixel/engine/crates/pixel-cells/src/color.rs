use pixel_core::HostColors;

use crate::grid::Rgb;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CellColor {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorTier {
    TrueColor,
    Ansi256,
    Ansi16,
    Mono,
}

impl ColorTier {
    pub fn detect(var: impl Fn(&str) -> Option<String>) -> Self {
        if var("NO_COLOR").is_some_and(|v| !v.is_empty()) {
            return ColorTier::Mono;
        }
        if let Some(forced) = var("PIXEL_COLORS") {
            match forced.trim() {
                "truecolor" | "24bit" => return ColorTier::TrueColor,
                "256" => return ColorTier::Ansi256,
                "16" => return ColorTier::Ansi16,
                "mono" | "none" => return ColorTier::Mono,
                _ => {}
            }
        }
        let colorterm = var("COLORTERM").unwrap_or_default().to_lowercase();
        if colorterm == "truecolor" || colorterm == "24bit" {
            return ColorTier::TrueColor;
        }
        let term = var("TERM").unwrap_or_default().to_lowercase();
        let program = var("TERM_PROGRAM").unwrap_or_default();
        if term.contains("direct") || term.contains("truecolor") || term == "xterm-kitty" || term == "xterm-ghostty" {
            return ColorTier::TrueColor;
        }
        if matches!(program.as_str(), "iTerm.app" | "WezTerm" | "ghostty" | "vscode" | "Hyper" | "WarpTerminal") {
            return ColorTier::TrueColor;
        }
        if term.contains("256") || program == "Apple_Terminal" {
            return ColorTier::Ansi256;
        }
        if term == "dumb" {
            return ColorTier::Mono;
        }
        ColorTier::Ansi16
    }

    pub fn name(self) -> &'static str {
        match self {
            ColorTier::TrueColor => "truecolor",
            ColorTier::Ansi256 => "256",
            ColorTier::Ansi16 => "16",
            ColorTier::Mono => "mono",
        }
    }
}

const XTERM_16: [Rgb; 16] = [
    [0, 0, 0],
    [205, 0, 0],
    [0, 205, 0],
    [205, 205, 0],
    [0, 0, 238],
    [205, 0, 205],
    [0, 205, 205],
    [229, 229, 229],
    [127, 127, 127],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [92, 92, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
];

const CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];

#[derive(Debug, Clone)]
pub struct Palette {
    pub tier: ColorTier,
    pub foreground: Rgb,
    pub background: Rgb,
    ansi: [Rgb; 16],
    known_defaults: bool,
}

impl Palette {
    pub fn new(tier: ColorTier, host: &HostColors) -> Self {
        let rgb = |c: [u8; 4]| [c[0], c[1], c[2]];
        let mut ansi = XTERM_16;
        for (slot, color) in ansi.iter_mut().zip(host.palette.iter()) {
            if let Some(color) = color {
                *slot = rgb(*color);
            }
        }
        Self {
            tier,
            foreground: host.foreground.map_or([229, 229, 229], rgb),
            background: host.background.map_or([30, 30, 30], rgb),
            ansi,
            known_defaults: host.foreground.is_some() && host.background.is_some(),
        }
    }

    pub fn ansi(&self, index: u8) -> Rgb {
        self.ansi[index as usize & 15]
    }

    pub fn fg(&self, rgb: Rgb) -> CellColor {
        if self.known_defaults && rgb == self.foreground {
            return CellColor::Default;
        }
        self.quantize(rgb, self.foreground)
    }

    pub fn bg(&self, rgb: Rgb) -> CellColor {
        if self.known_defaults && rgb == self.background || self.tier == ColorTier::Mono {
            return CellColor::Default;
        }
        self.quantize(rgb, self.background)
    }

    fn quantize(&self, rgb: Rgb, default: Rgb) -> CellColor {
        match self.tier {
            ColorTier::TrueColor => CellColor::Rgb(rgb[0], rgb[1], rgb[2]),
            ColorTier::Ansi256 => CellColor::Indexed(nearest_256(rgb)),
            ColorTier::Ansi16 => self.nearest_16(rgb, default),
            ColorTier::Mono => CellColor::Default,
        }
    }

    fn nearest_16(&self, rgb: Rgb, default: Rgb) -> CellColor {
        let best = (0..16u8).min_by_key(|&i| distance(rgb, self.ansi[i as usize])).unwrap_or(7);
        if distance(rgb, default) <= distance(rgb, self.ansi[best as usize]) {
            CellColor::Default
        } else {
            CellColor::Indexed(best)
        }
    }
}

pub fn distance(a: Rgb, b: Rgb) -> u32 {
    let mean_r = (a[0] as i32 + b[0] as i32) / 2;
    let dr = a[0] as i32 - b[0] as i32;
    let dg = a[1] as i32 - b[1] as i32;
    let db = a[2] as i32 - b[2] as i32;
    ((((512 + mean_r) * dr * dr) >> 8) + 4 * dg * dg + (((767 - mean_r) * db * db) >> 8)) as u32
}

pub fn nearest_256(rgb: Rgb) -> u8 {
    let step = |v: u8| -> usize {
        if v < 48 {
            0
        } else if v < 115 {
            1
        } else {
            ((v as usize - 35) / 40).min(5)
        }
    };
    let (r, g, b) = (step(rgb[0]), step(rgb[1]), step(rgb[2]));
    let cube = [CUBE[r], CUBE[g], CUBE[b]];
    let average = (rgb[0] as u32 + rgb[1] as u32 + rgb[2] as u32) / 3;
    let gray_index = if average > 238 { 23 } else { (average.saturating_sub(3)) / 10 };
    let gray_level = (8 + 10 * gray_index) as u8;
    let gray = [gray_level; 3];
    if distance(rgb, gray) < distance(rgb, cube) {
        232 + gray_index as u8
    } else {
        (16 + 36 * r + 6 * g + b) as u8
    }
}

pub fn blend(src: [u8; 4], dst: Rgb) -> Rgb {
    let a = src[3] as u32;
    if a == 255 {
        return [src[0], src[1], src[2]];
    }
    let inv = 255 - a;
    let mix = |s: u8, d: u8| ((s as u32 * a + d as u32 * inv + 127) / 255) as u8;
    [mix(src[0], dst[0]), mix(src[1], dst[1]), mix(src[2], dst[2])]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    #[test]
    fn tiers_follow_the_environment() {
        assert_eq!(ColorTier::detect(env(&[("COLORTERM", "truecolor"), ("TERM", "xterm")])), ColorTier::TrueColor);
        assert_eq!(ColorTier::detect(env(&[("TERM", "xterm-256color")])), ColorTier::Ansi256);
        assert_eq!(ColorTier::detect(env(&[("TERM", "xterm")])), ColorTier::Ansi16);
        assert_eq!(ColorTier::detect(env(&[("COLORTERM", "truecolor"), ("NO_COLOR", "1")])), ColorTier::Mono);
        assert_eq!(ColorTier::detect(env(&[("TERM", "xterm-256color"), ("TERM_PROGRAM", "Apple_Terminal")])), ColorTier::Ansi256);
        assert_eq!(ColorTier::detect(env(&[("TERM", "xterm-256color"), ("PIXEL_COLORS", "16")])), ColorTier::Ansi16);
    }

    #[test]
    fn the_256_cube_and_gray_ramp_are_picked_by_distance() {
        assert_eq!(nearest_256([255, 0, 0]), 196);
        assert_eq!(nearest_256([0, 0, 0]), 16);
        assert_eq!(nearest_256([128, 128, 128]), 244);
        assert_eq!(nearest_256([255, 255, 255]), 231);
    }

    #[test]
    fn sixteen_colors_match_the_terminals_own_palette() {
        let mut host = HostColors::default();
        host.palette[1] = Some([200, 60, 60, 255]);
        host.palette[9] = Some([255, 120, 120, 255]);
        let palette = Palette::new(ColorTier::Ansi16, &host);
        assert_eq!(palette.bg([250, 118, 118]), CellColor::Indexed(9));
        assert_eq!(palette.bg([190, 50, 50]), CellColor::Indexed(1));
        assert_eq!(palette.bg([40, 40, 40]), CellColor::Default, "a faint tint of the background stays the background");
    }

    #[test]
    fn the_hosts_own_colors_become_terminal_defaults() {
        let host = HostColors { foreground: Some([220, 220, 220, 255]), background: Some([20, 20, 20, 255]), palette: [None; 16] };
        let palette = Palette::new(ColorTier::TrueColor, &host);
        assert_eq!(palette.bg([20, 20, 20]), CellColor::Default);
        assert_eq!(palette.fg([220, 220, 220]), CellColor::Default);
        assert_eq!(palette.bg([21, 20, 20]), CellColor::Rgb(21, 20, 20));
    }
}
