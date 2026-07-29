pub fn in_tmux() -> bool {
    std::env::var_os("TMUX").is_some()
}

/**
 * id like to get the exact patch (of tmux 3.3) of what added support for this
 * 
 * also we should tell the user this explicitly that they should upgrade tmux if lower version
 */
pub fn enable_passthrough() {
    let _ = std::process::Command::new("tmux")
        .args(["set", "-p", "allow-passthrough", "on"])
        .output();
}

/// Turns passthrough on for whichever pane owns this tty. `set -p` alone would target the pane the
/// caller happens to be sitting in, which is the wrong one when a browser is handed a tty belonging
/// to a pane somewhere else.
pub fn enable_passthrough_for_tty(tty_path: &str) {
    let Ok(panes) = std::process::Command::new("tmux")
        .args(["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"])
        .output()
    else {
        return;
    };
    let listing = String::from_utf8_lossy(&panes.stdout);
    let pane = listing.lines().find_map(|line| {
        let (tty, id) = line.split_once(' ')?;
        (tty == tty_path).then_some(id)
    });
    match pane {
        Some(pane) => {
            let _ = std::process::Command::new("tmux")
                .args(["set", "-t", pane, "-p", "allow-passthrough", "on"])
                .output();
        }
        None => enable_passthrough(),
    }
}

pub fn passthrough(seq: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(seq.len() + 16);
    out.extend_from_slice(b"\x1bPtmux;");
    for &byte in seq {
        if byte == 0x1b {
            out.push(0x1b);
        }
        out.push(byte);
    }
    out.extend_from_slice(b"\x1b\\");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_doubles_escapes_and_wraps() {
        assert_eq!(
            passthrough(b"\x1b_Gi=1;AA\x1b\\"),
            b"\x1bPtmux;\x1b\x1b_Gi=1;AA\x1b\x1b\\\x1b\\"
        );
    }
}
