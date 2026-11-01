use std::ffi::{CStr, c_char};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, Once};

static CRASH_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static HOOK: Once = Once::new();

pub(crate) fn install_hook() {
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            write_report(info);
            previous(info);
        }));
    });
}

fn write_report(info: &std::panic::PanicHookInfo<'_>) {
    pixel_core::logging::error("panic", info.to_string());
    let Some(dir) = CRASH_DIR.lock().ok().and_then(|dir| dir.clone()) else {
        return;
    };
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let report = serde_json::json!({
        "kind": "rust-panic",
        "at": at,
        "thread": std::thread::current().name().unwrap_or("unnamed"),
        "message": info.to_string(),
        "backtrace": std::backtrace::Backtrace::force_capture().to_string(),
    });
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::File::create(dir.join(format!("rust-panic-{}-{at}.json", std::process::id()))) {
        let _ = file.write_all(report.to_string().as_bytes());
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pixel_set_crash_dir(path: *const c_char) {
    if path.is_null() {
        return;
    }
    // SAFETY: the host passes a NUL terminated string that lives for the duration of the call.
    let dir = unsafe { CStr::from_ptr(path) }.to_string_lossy().into_owned();
    install_hook();
    if let Ok(mut slot) = CRASH_DIR.lock() {
        *slot = Some(PathBuf::from(dir));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_at_the_c_boundary_is_contained_and_written_to_the_crash_folder() {
        let dir = std::env::temp_dir().join(format!("pixel-crashes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = std::ffi::CString::new(dir.to_string_lossy().into_owned()).unwrap();
        pixel_set_crash_dir(path.as_ptr());
        let survived = crate::guard::guarded("test", 7, || panic!("boom"));
        assert_eq!(survived, 7);
        let reports: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(reports.len(), 1);
        let body = std::fs::read_to_string(reports[0].path()).unwrap();
        assert!(body.contains("\"kind\":\"rust-panic\"") && body.contains("boom"), "{body}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
