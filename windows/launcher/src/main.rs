// The release's terminal-browser command on Windows. It is an executable rather than a batch
// file so its arguments reach the cli without cmd.exe reading them, and so programs that start
// commands without a shell find it on PATH.
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn release_root(exe: &Path) -> Option<PathBuf> {
    Some(exe.parent()?.parent()?.to_path_buf())
}

fn cli_command(root: &Path) -> Command {
    let mut command = Command::new(root.join("electron").join("electron.exe"));
    command
        .arg(root.join("cli").join("dist").join("main.js"))
        .env("TERMINAL_BROWSER_DIST_ROOT", root)
        .env("ELECTRON_RUN_AS_NODE", "1");
    command
}

#[cfg(windows)]
fn leave_ctrl_c_to_the_cli() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }
    // The cli shares this console and gets the same ctrl+c; this process waits for its exit code.
    unsafe { SetConsoleCtrlHandler(None, 1) };
}

#[cfg(not(windows))]
fn leave_ctrl_c_to_the_cli() {}

fn main() -> ExitCode {
    let root = match std::env::current_exe().ok().and_then(|exe| release_root(&exe)) {
        Some(root) => root,
        None => {
            eprintln!("terminal-browser: cannot work out where it is installed");
            return ExitCode::FAILURE;
        }
    };
    leave_ctrl_c_to_the_cli();
    match cli_command(&root).args(std::env::args_os().skip(1)).status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1).clamp(0, 255) as u8),
        Err(error) => {
            eprintln!("terminal-browser: cannot start {}: {error}", root.join("electron").join("electron.exe").display());
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_release_root_is_two_levels_above_the_launcher() {
        let root = release_root(Path::new(r"C:\Users\me\AppData\Local\terminal-browser\app\bin\terminal-browser.exe"));
        assert_eq!(root, Some(PathBuf::from(r"C:\Users\me\AppData\Local\terminal-browser\app")));
    }

    #[test]
    fn the_cli_runs_inside_the_releases_own_electron() {
        let root = Path::new(r"C:\tb");
        let command = cli_command(root);
        assert_eq!(command.get_program(), Path::new(r"C:\tb\electron\electron.exe"));
        assert_eq!(command.get_args().collect::<Vec<_>>(), [Path::new(r"C:\tb\cli\dist\main.js")]);
        let env: Vec<_> = command.get_envs().collect();
        assert!(env.contains(&("TERMINAL_BROWSER_DIST_ROOT".as_ref(), Some(root.as_os_str()))));
        assert!(env.contains(&("ELECTRON_RUN_AS_NODE".as_ref(), Some("1".as_ref()))));
    }
}
