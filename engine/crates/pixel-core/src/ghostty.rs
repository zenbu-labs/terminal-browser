use std::io;
use std::path::PathBuf;
#[cfg(unix)]
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    NotGhostty,
    AlreadySet,
    Updated { reloaded: bool },
}

pub fn claim_keybinds(app_name: &str, keybinds: &[&str]) -> io::Result<Claim> {
    if !is_ghostty() {
        return Ok(Claim::NotGhostty);
    }
    let path = config_path().ok_or_else(|| io::Error::other("no home directory"))?;
    let current = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let Some(updated) = upsert_block(&current, app_name, keybinds) else {
        return Ok(Claim::AlreadySet);
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, updated)?;
    std::fs::rename(&tmp, &path)?;
    Ok(Claim::Updated {
        reloaded: reload()?,
    })
}

pub fn is_ghostty() -> bool {
    std::env::var("TERM_PROGRAM").is_ok_and(|v| v == "ghostty")
}

pub fn config_path() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let xdg = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("ghostty/config");
    if !cfg!(target_os = "macos") {
        return Some(xdg);
    }
    let app_support = home.join("Library/Application Support/com.mitchellh.ghostty/config");
    if !app_support.exists() && xdg.exists() {
        return Some(xdg);
    }
    Some(app_support)
}

fn markers(app_name: &str) -> (String, String) {
    (
        format!("# >>> {app_name}: managed keybinds >>>"),
        format!("# <<< {app_name}: managed keybinds <<<"),
    )
}

fn upsert_block(config: &str, app_name: &str, keybinds: &[&str]) -> Option<String> {
    let (begin, end) = markers(app_name);
    let mut block = String::new();
    block.push_str(&begin);
    block.push('\n');
    for keybind in keybinds {
        block.push_str("keybind = ");
        block.push_str(keybind);
        block.push('\n');
    }
    block.push_str(&end);
    block.push('\n');

    if let Some(start) = config.find(&begin) {
        let stop = match config[start..].find(&end) {
            Some(i) => {
                let stop = start + i + end.len();
                stop + usize::from(config[stop..].starts_with('\n'))
            }
            None => config.len(),
        };
        if config[start..stop] == block {
            return None;
        }
        let mut updated = String::with_capacity(config.len() + block.len());
        updated.push_str(&config[..start]);
        updated.push_str(&block);
        updated.push_str(&config[stop..]);
        return Some(updated);
    }

    let mut updated = config.to_string();
    if !updated.is_empty() {
        if !updated.ends_with('\n') {
            updated.push('\n');
        }
        updated.push('\n');
    }
    updated.push_str(&block);
    Some(updated)
}

// this makes me uncomfortable, id like to have a link in ghosttys github of
// where they respect this
#[cfg(windows)]
pub fn reload() -> io::Result<bool> {
    Ok(false)
}

#[cfg(unix)]
pub fn reload() -> io::Result<bool> {
    let mut pid = std::process::id() as i32;
    for _ in 0..16 {
        let Some((ppid, _)) = process_info(pid)? else {
            return Ok(false);
        };
        if ppid <= 1 {
            return Ok(false);
        }
        let Some((_, parent_name)) = process_info(ppid)? else {
            return Ok(false);
        };
        let basename = parent_name.rsplit('/').next().unwrap_or(&parent_name);
        if basename.eq_ignore_ascii_case("ghostty") {
            let pid = rustix::process::Pid::from_raw(ppid)
                .ok_or_else(|| io::Error::other("invalid ghostty pid"))?;
            rustix::process::kill_process(pid, rustix::process::Signal::USR2)?;
            return Ok(true);
        }
        pid = ppid;
    }
    Ok(false)
}

#[cfg(unix)]
fn process_info(pid: i32) -> io::Result<Option<(i32, String)>> {
    let output = Command::new("ps")
        .args(["-o", "ppid=,comm=", "-p", &pid.to_string()])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.trim();
    let Some((ppid, comm)) = line.split_once(char::is_whitespace) else {
        return Ok(None);
    };
    match ppid.trim().parse() {
        Ok(ppid) => Ok(Some((ppid, comm.trim().to_string()))),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BINDS: &[&str] = &["super+z=unbind", "super+a=unbind"];

    #[test]
    fn appends_a_block_to_existing_content() {
        let updated = upsert_block("theme = Vercel\n", "demo", BINDS).unwrap();
        assert_eq!(
            updated,
            "theme = Vercel\n\n\
             # >>> demo: managed keybinds >>>\n\
             keybind = super+z=unbind\n\
             keybind = super+a=unbind\n\
             # <<< demo: managed keybinds <<<\n"
        );
        assert!(
            upsert_block("", "demo", BINDS)
                .unwrap()
                .starts_with("# >>>"),
            "empty config gets just the block"
        );
    }

    #[test]
    fn matching_block_is_left_alone() {
        let config = upsert_block("theme = Vercel\n", "demo", BINDS).unwrap();
        assert_eq!(upsert_block(&config, "demo", BINDS), None);
    }

    #[test]
    fn stale_block_is_replaced_in_place() {
        let old = upsert_block("before = 1\n", "demo", &["super+q=unbind"]).unwrap();
        let old = old + "after = 2\n";
        let updated = upsert_block(&old, "demo", BINDS).unwrap();
        assert!(updated.starts_with("before = 1\n"));
        assert!(updated.ends_with("# <<< demo: managed keybinds <<<\nafter = 2\n"));
        assert!(!updated.contains("super+q"), "old binds are gone");
        assert!(updated.contains("keybind = super+z=unbind"));
        assert_eq!(
            updated.matches("# >>>").count(),
            1,
            "still exactly one block"
        );
    }

    #[test]
    fn blocks_for_different_apps_coexist() {
        let one = upsert_block("", "app-one", BINDS).unwrap();
        let both = upsert_block(&one, "app-two", &["super+q=unbind"]).unwrap();
        assert!(both.contains("app-one: managed keybinds"));
        assert!(both.contains("app-two: managed keybinds"));
        assert_eq!(upsert_block(&both, "app-one", BINDS), None);
    }
}
