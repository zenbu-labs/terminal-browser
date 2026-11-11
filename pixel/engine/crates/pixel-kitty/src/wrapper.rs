#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Wrapper {
    #[default]
    None,
    Tmux,
}

impl Wrapper {
    pub fn relayed(self) -> bool {
        self != Wrapper::None
    }

    pub fn wrap(self, seq: &[u8]) -> Vec<u8> {
        match self {
            Wrapper::None => seq.to_vec(),
            Wrapper::Tmux => tmux(seq),
        }
    }

    pub fn named(name: Option<&str>) -> Self {
        match name {
            Some("tmux") => Wrapper::Tmux,
            _ => Wrapper::None,
        }
    }
}
fn tmux(seq: &[u8]) -> Vec<u8> {
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
    fn wrapping_is_the_relays_own_encoding() {
        assert_eq!(Wrapper::None.wrap(b"\x1b_Gi=1;AA\x1b\\"), b"\x1b_Gi=1;AA\x1b\\");
        assert_eq!(
            Wrapper::Tmux.wrap(b"\x1b_Gi=1;AA\x1b\\"),
            b"\x1bPtmux;\x1b\x1b_Gi=1;AA\x1b\x1b\\\x1b\\"
        );
        assert!(!Wrapper::None.relayed());
        assert!(Wrapper::Tmux.relayed());
    }

}
