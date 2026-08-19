use napi::{Error, Result};
use napi_derive::napi;

/// Reads a generic-password keychain item in this process, so macOS attributes the
/// access prompt to this app rather than to a shared command line tool.
#[napi]
pub fn keychain_generic_password(service: String, account: String) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        let password = security_framework::passwords::get_generic_password(&service, &account)
            .map_err(|error| {
                Error::from_reason(format!("keychain item {service}/{account} unavailable: {error}"))
            })?;
        String::from_utf8(password)
            .map_err(|_| Error::from_reason(format!("keychain item {service}/{account} is not text")))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, account);
        Err(Error::from_reason(
            "reading a keychain item is only supported on macOS",
        ))
    }
}
