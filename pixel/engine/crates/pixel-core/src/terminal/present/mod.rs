
use std::borrow::Cow;
use std::io;

use super::{FrameTransport, SessionEnv, Terminal};
use crate::canvas::Canvas;
use crate::surfaces::Rect;

mod cells;
mod flash;
mod animation;
mod full;
mod merge;
mod overlay;
mod patched;
mod transmit_strategy;
mod screen;
mod tiles;

pub(crate) use flash::Flashes;
pub(crate) use animation::Animation;
pub(crate) use cells::Cells;
pub(crate) use overlay::Overlay;
pub(crate) use patched::Patched;

const IDENTITY_PROBE_TIMEOUT_MS: u64 = 150;

const FRAME_EDIT_PROBE_ID: u32 = 302;
const FRAME_EDIT_PROBE_TIMEOUT_MS: u64 = 1200;

// where do u come from
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Presenter {
    Full,
    Patched,
    // https://sw.kovidgoyal.net/kitty/graphics-protocol/#animation
    Animation,
    Cells(crate::cell_graphics::CellProtocol),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Identity {
    Ghostty { version: (u32, u32, u32) },
    Kitty { version: (u32, u32, u32) },
    Unknown,
}

impl Identity {
    // not sure if i want this
    fn animates_frames(self) -> bool {
        !matches!(self, Identity::Kitty { .. })
    }

    // otherwise its unsafe to use the overlaid image strategy
    fn takes_patches(self) -> bool {
        match self {
            Identity::Ghostty { version } => version >= (1, 2, 0),
            Identity::Kitty { .. } => true,
            Identity::Unknown => false,
        }
    }
    pub(crate) fn is_ghostty(self) -> bool {
        matches!(self, Identity::Ghostty { .. })
    }

    pub(super) fn deletes_before_replace(self) -> bool {
        matches!(self, Identity::Ghostty { .. })
    }

    pub(super) fn transient_images(self) -> bool {
        matches!(self, Identity::Kitty { version } if version >= (0, 48, 0))
    }
}

pub(super) fn select(
    forced: Option<&str>,
    relayed: bool,
    transport: FrameTransport,
    identity: Identity,
    frame_edits: bool,
    ssh: bool,
) -> Presenter {
    if relayed {
        return match forced.map(str::trim) {
            Some("animation") if frame_edits => Presenter::Animation,
            _ => Presenter::Full,
        };
    }
    let x = match forced.map(str::trim) {
        Some("full") => Presenter::Full,
        Some("animation") if frame_edits && identity.animates_frames() => Presenter::Animation,
        Some("patched") => Presenter::Patched,
        _ if ssh && identity.takes_patches() => Presenter::Patched,
        _ if transport == FrameTransport::Inline => Presenter::Full,
        _ if identity.takes_patches() => Presenter::Patched,
        _ => Presenter::Full,
    };

    return x;
}

pub(crate) fn straighten(pixels: &mut [u8], premultiplied: bool) {
    if !premultiplied {
        return;
    }
    for px in pixels.chunks_exact_mut(4) {
        let a = u32::from(px[3]);
        if a == 0 || a == 255 {
            continue;
        }
        for c in &mut px[..3] {
            *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

pub(super) fn straight_pixels(canvas: &Canvas, premultiplied: bool) -> Cow<'_, [u8]> {
    if !premultiplied {
        return Cow::Borrowed(&canvas.pixels);
    }
    let mut pixels = canvas.pixels.clone();
    straighten(&mut pixels, true);
    Cow::Owned(pixels)
}

pub(super) fn copy_rect(canvas: &Canvas, rect: Rect, premultiplied: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(rect.area() as usize * 4);
    let stride = canvas.width as usize * 4;
    for row in rect.y..rect.y + rect.h {
        let start = row as usize * stride + rect.x as usize * 4;
        out.extend_from_slice(&canvas.pixels[start..start + rect.w as usize * 4]);
    }
    straighten(&mut out, premultiplied);
    out
}

pub(super) fn over_ssh(env: &SessionEnv) -> bool {
    ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]
        .iter()
        .any(|key| env.var(key).is_some_and(|value| !value.is_empty()))
}

pub(super) fn parse_frame_edit_reply(buf: &[u8]) -> Option<bool> {
    let needle = format!("Gi={FRAME_EDIT_PROBE_ID}");
    let pos = buf.windows(needle.len()).position(|w| w == needle.as_bytes())?;
    let rest = &buf[pos + needle.len()..];
    let semi = rest.iter().position(|&b| b == b';')?;
    let answer = &rest[semi + 1..];
    if answer.len() < 2 {
        return None;
    }
    Some(answer.starts_with(b"OK"))
}

pub(super) fn parse_xtversion(buf: &[u8]) -> Option<Identity> {
    let start = buf.windows(4).position(|w| w == b"\x1bP>|")? + 4;
    let rest = &buf[start..];
    let end = rest.windows(2).position(|w| w == b"\x1b\\")?;
    let text = String::from_utf8_lossy(&rest[..end]);
    let name: String = text
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    let version = parse_version(&text[name.len()..]);
    Some(match name.as_str() {
        "ghostty" => Identity::Ghostty { version },
        "kitty" => Identity::Kitty { version },
        _ => Identity::Unknown,
    })
}

fn parse_version(text: &str) -> (u32, u32, u32) {
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = digits.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

impl Terminal {
    pub(super) fn probe_identity(&mut self, env: &SessionEnv) -> io::Result<Identity> {
        if self.wrapper.relayed() {
            return Ok(Identity::Unknown);
        }
        if env.var("TERM_PROGRAM").as_deref() == Some("ghostty") {
            let version = env
                .var("TERM_PROGRAM_VERSION")
                .map(|v| parse_version(&v))
                .unwrap_or((0, 0, 0));
            return Ok(Identity::Ghostty { version });
        }
        self.io.out().write_all(b"\x1b[>0q")?;
        self.io.out().flush()?;
        Ok(self
            .read_report(IDENTITY_PROBE_TIMEOUT_MS, parse_xtversion)?
            .unwrap_or(Identity::Unknown))
    }

    fn probe_frame_edits(&mut self) -> io::Result<bool> {
        self.io.out().write_all(&self.wrapper.wrap(&crate::kitty::kitty_frame_edit_probe(FRAME_EDIT_PROBE_ID)))?;
        self.io.out().flush()?;
        let reply = self.read_report(FRAME_EDIT_PROBE_TIMEOUT_MS, parse_frame_edit_reply)?;
        self.io.out().write_all(&self.wrapper.wrap(&crate::kitty::kitty_delete_one(FRAME_EDIT_PROBE_ID)))?;
        self.io.out().flush()?;
        Ok(reply.unwrap_or(false))
    }

    pub(super) fn choose_present(&mut self, env: &SessionEnv) -> io::Result<Presenter> {
        if let Some(protocol) = self.cell_protocol {
            return Ok(Presenter::Cells(protocol));
        }
        let forced = env.var("TERMINAL_BROWSER_PRESENT");
        let ssh = over_ssh(env);
        let wants_animation = forced.as_deref().map(str::trim) == Some("animation");
        let frame_edits = wants_animation && self.probe_frame_edits()?;
        if wants_animation && !frame_edits {
            crate::logging::warn("terminal", "animation was asked for but this terminal does not edit frames, choosing normally");
        }
        let chosen = select(forced.as_deref(), self.wrapper.relayed(), self.transport, self.identity, frame_edits, ssh);
        crate::logging::info(
            "terminal",
            format!("presenting frames as {chosen:?} (terminal {:?}, frame edits {frame_edits}, ssh {ssh}, forced {:?})", self.identity, forced),
        );
        Ok(chosen)
    }

    pub(super) fn transmit(&self, canvas: &Canvas, placement: crate::kitty::Placement) -> crate::kitty::Transmit {
        crate::kitty::Transmit {
            image_id: self.image_id,
            width: canvas.width,
            height: canvas.height,
            placement,
            transient: self.identity.transient_images(),
        }
    }
    pub(super) fn write_synchronized(&mut self, body: &[u8]) -> io::Result<usize> {
        if body.is_empty() {
            return Ok(0);
        }
        let mut out = Vec::with_capacity(body.len() + 16);
        out.extend_from_slice(b"\x1b[?2026h");
        out.extend_from_slice(body);
        out.extend_from_slice(b"\x1b[?2026l");
        crate::profiler::span("term.write", || {
            self.io.out().write_all(&out)?;
            self.io.out().flush()
        })?;
        Ok(out.len())
    }

    pub(super) fn place_image(
        &mut self,
        out: &mut Vec<u8>,
        id: u32,
        rect: Rect,
        z: i32,
        replacing: bool,
        fill: impl FnOnce(&mut [u8]),
    ) -> io::Result<()> {
        let (cw, ch) = self.cell();
        if replacing && self.identity.deletes_before_replace() {
            out.extend_from_slice(&crate::kitty::kitty_delete_placement(id));
        }
        out.extend_from_slice(format!("\x1b[{};{}H", rect.y / ch + 1, rect.x / cw + 1).as_bytes());
        let transmit = crate::kitty::Transmit {
            image_id: id,
            width: rect.w,
            height: rect.h,
            placement: crate::kitty::Placement::Cursor { z, offset: (rect.x % cw, rect.y % ch) },
            transient: self.identity.transient_images(),
        };
        let len = rect.area() as usize * 4;
        match self.patch_medium() {
            Some(medium) => {
                let name = crate::profiler::span("kitty.handoff", || self.hand_off_payload(medium, len, fill))?;
                out.extend_from_slice(&crate::kitty::kitty_transmit_named(transmit, &name, medium, self.wrapper));
            }
            None => {
                let mut data = vec![0u8; len];
                fill(&mut data);
                out.extend_from_slice(&crate::kitty::kitty_transmit_placed(transmit, &data, self.wrapper));
            }
        }
        if self.highlight_transmits {
            self.flash(out, rect, false);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xtversion_replies_identify_ghostty_and_kitty() {
        assert_eq!(
            parse_xtversion(b"noise\x1bP>|ghostty 1.3.1\x1b\\"),
            Some(Identity::Ghostty { version: (1, 3, 1) })
        );
        assert_eq!(
            parse_xtversion(b"\x1bP>|kitty(0.48.1)\x1b\\"),
            Some(Identity::Kitty { version: (0, 48, 1) })
        );
        assert_eq!(
            parse_xtversion(b"\x1bP>|WezTerm 20240203\x1b\\"),
            Some(Identity::Unknown)
        );
        assert_eq!(parse_xtversion(b"\x1bP>|ghostty 1.3"), None, "reply mid-arrival");
    }

    #[test]
    fn the_presenter_follows_the_terminal_the_transport_and_ssh() {
        let ghostty = Identity::Ghostty { version: (1, 3, 1) };
        let old_ghostty = Identity::Ghostty { version: (1, 1, 3) };
        let kitty = Identity::Kitty { version: (0, 46, 0) };
        let local = |forced, transport, identity| select(forced, false, transport, identity, true, false);
        assert_eq!(local(None, FrameTransport::File, ghostty), Presenter::Patched);
        assert_eq!(local(None, FrameTransport::Shared, kitty), Presenter::Patched);
        assert_eq!(local(None, FrameTransport::File, old_ghostty), Presenter::Full);
        assert_eq!(local(None, FrameTransport::File, Identity::Unknown), Presenter::Full);
        assert_eq!(local(None, FrameTransport::Inline, ghostty), Presenter::Full);
        assert_eq!(local(Some("full"), FrameTransport::File, ghostty), Presenter::Full);
        assert_eq!(local(Some(" patched "), FrameTransport::File, Identity::Unknown), Presenter::Patched);
        assert_eq!(local(Some("patched"), FrameTransport::Inline, ghostty), Presenter::Patched);
        assert_eq!(local(Some("animation"), FrameTransport::Inline, kitty), Presenter::Full, "kitty never animates, even when asked");
        assert_eq!(local(Some("animation"), FrameTransport::Shared, kitty), Presenter::Patched, "kitty never animates, even when asked");
        assert_eq!(local(Some("animation"), FrameTransport::Inline, ghostty), Presenter::Animation);
        assert_eq!(
            select(Some("animation"), false, FrameTransport::Inline, ghostty, false, false),
            Presenter::Full,
            "asking for animation on a terminal that failed the probe falls back"
        );

        let relayed = |forced, frame_edits| select(forced, true, FrameTransport::File, Identity::Unknown, frame_edits, false);
        assert_eq!(relayed(None, true), Presenter::Full, "through tmux whole frames unless animation is asked for");
        assert_eq!(relayed(Some("animation"), true), Presenter::Animation);
        assert_eq!(relayed(Some("animation"), false), Presenter::Full, "asked for but the probe failed");
        assert_eq!(relayed(Some("patched"), true), Presenter::Full, "patches cannot stack in placeholder cells");
        assert_eq!(relayed(Some("full"), true), Presenter::Full);

        let ssh = |identity| select(None, false, FrameTransport::Inline, identity, true, true);
        assert_eq!(ssh(ghostty), Presenter::Patched);
        assert_eq!(ssh(old_ghostty), Presenter::Full);
        assert_eq!(ssh(kitty), Presenter::Patched);
        assert_eq!(ssh(Identity::Unknown), Presenter::Full);
    }

    #[test]
    fn the_frame_edit_probe_reply_is_read_with_or_without_a_frame_number() {
        assert_eq!(parse_frame_edit_reply(b"\x1b_Gi=302,r=1;OK\x1b\\"), Some(true));
        assert_eq!(parse_frame_edit_reply(b"\x1b_Gi=302;OK\x1b\\"), Some(true));
        assert_eq!(
            parse_frame_edit_reply(b"\x1b_Gi=302;ERROR: unimplemented action\x1b\\"),
            Some(false)
        );
        assert_eq!(parse_frame_edit_reply(b"\x1b_Gi=302,r=1;O"), None);
        assert_eq!(parse_frame_edit_reply(b"\x1b_Gi=301;OK\x1b\\"), None);
    }

    #[test]
    fn straightening_scales_colors_back_up_and_keeps_alpha() {
        let mut px = vec![64, 32, 0, 128, 10, 10, 10, 0, 200, 200, 200, 255];
        straighten(&mut px, true);
        assert_eq!(px, vec![128, 64, 0, 128, 10, 10, 10, 0, 200, 200, 200, 255]);
        let canvas = Canvas::new(2, 1);
        assert!(matches!(straight_pixels(&canvas, false), Cow::Borrowed(_)));
        assert!(matches!(straight_pixels(&canvas, true), Cow::Owned(_)));
    }
}
