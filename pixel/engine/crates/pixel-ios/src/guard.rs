use std::panic::{AssertUnwindSafe, catch_unwind};

pub(crate) fn guarded<T>(name: &str, fallback: T, body: impl FnOnce() -> T) -> T {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(value) => value,
        Err(_) => {
            pixel_core::logging::error("ios", format!("{name} panicked; the call was dropped"));
            fallback
        }
    }
}

pub(crate) fn catching(body: impl FnOnce()) -> bool {
    catch_unwind(AssertUnwindSafe(body)).is_ok()
}
