use pixel_bridge::HostOps;
use pixel_core::Engine;
use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;

use crate::terminal;

#[derive(Deserialize)]
pub struct RetargetHost {
    socket: String,
    pane: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum TerminalOp {
    Retarget {
        tty: Option<String>,
        wrapper: Option<String>,
        host: Option<RetargetHost>,
    },
    #[serde(rename_all = "camelCase")]
    Presenter {
        #[serde(default)]
        highlight_transmits: Option<bool>,
        #[serde(default)]
        frame_events: Option<bool>,
        #[serde(default)]
        tiles: Option<Tiles>,
        #[serde(default)]
        image_rate: Option<ImageRate>,
    },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ImageRate {
    Auto(Auto),
    MegabytesPerSec(f32),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Auto {
    Auto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Tiles {
    Auto,
    On,
    Off,
}

pub struct TerminalOps;

impl HostOps for TerminalOps {
    fn apply(&mut self, engine: &mut Engine, op: &RawValue, replies: &mut Vec<String>) -> bool {
        let Ok(op) = serde_json::from_str::<TerminalOp>(op.get()) else {
            return false;
        };
        match op {
            TerminalOp::Presenter { highlight_transmits, frame_events, tiles, image_rate } => {
                if let Some(on) = highlight_transmits
                    && let Some(terminal) = terminal(engine)
                {
                    terminal.set_highlight_transmits(on);
                }
                if let Some(tiles) = tiles
                    && let Some(terminal) = terminal(engine)
                {
                    terminal.set_force_tiles(match tiles {
                        Tiles::Auto => None,
                        Tiles::On => Some(true),
                        Tiles::Off => Some(false),
                    });
                }
                if let Some(rate) = image_rate
                    && let Some(terminal) = terminal(engine)
                {
                    terminal.set_image_rate_limit(match rate {
                        ImageRate::Auto(Auto::Auto) => None,
                        ImageRate::MegabytesPerSec(mb) => Some(mb * 1_000_000.0),
                    });
                }
                if let Some(on) = frame_events {
                    let font = on.then(|| engine.fonts[0].clone());
                    if let Some(terminal) = terminal(engine) {
                        terminal.set_frame_events(font);
                    }
                    pixel_core::logging::info("engine", if on { "showing presenter events on screen" } else { "presenter events hidden" });
                }
            }
            TerminalOp::Retarget { tty, wrapper, host } => replies.push(retarget(engine, tty, wrapper, host).to_string()),
        }
        true
    }
}

fn retarget(engine: &mut Engine, tty: Option<String>, wrapper: Option<String>, host: Option<RetargetHost>) -> serde_json::Value {
    let target = match (host, tty) {
        (Some(host), _) => pixel_terminal::Retarget::Host { socket: host.socket, pane: host.pane, name: host.name },
        (None, Some(path)) => pixel_terminal::Retarget::Tty { path, wrapper: pixel_terminal::Wrapper::named(wrapper.as_deref()) },
        (None, None) => return json!({ "type": "retargeted", "ok": false, "error": "retarget needs a tty or a host" }),
    };
    let retargeted = match terminal(engine) {
        Some(terminal) => terminal.retarget(target),
        None => Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "this backend can't be retargeted")),
    };
    match retargeted.and_then(|()| engine.host_changed()) {
        Ok(()) => json!({ "type": "retargeted", "ok": true, "info": pixel_bridge::engine_info(engine) }),
        Err(error) => json!({ "type": "retargeted", "ok": false, "error": error.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalOp;

    #[test]
    fn presenter_reads_camel_cased_fields_and_leaves_missing_ones_unset() {
        let op: TerminalOp = serde_json::from_str(r#"{"op":"presenter","highlightTransmits":true}"#).unwrap();
        let TerminalOp::Presenter { highlight_transmits, frame_events, .. } = op else {
            panic!("parsed as another op");
        };
        assert_eq!(highlight_transmits, Some(true));
        assert_eq!(frame_events, None);
    }

    #[test]
    fn presenter_reads_an_image_rate_as_auto_or_megabytes_per_second() {
        let rate = |json: &str| {
            let TerminalOp::Presenter { image_rate, .. } = serde_json::from_str(json).unwrap() else {
                panic!("parsed as another op");
            };
            image_rate
        };
        assert!(matches!(rate(r#"{"op":"presenter","imageRate":"auto"}"#), Some(super::ImageRate::Auto(_))));
        assert!(matches!(rate(r#"{"op":"presenter","imageRate":600}"#), Some(super::ImageRate::MegabytesPerSec(mb)) if mb == 600.0));
        assert!(rate(r#"{"op":"presenter"}"#).is_none());
    }
}
