use napi::{Error, Result};
use napi_derive::napi;

/// Reads a generic-password keychain item in this process, so macOS attributes the
/// access prompt to this app rather than to a shared command line tool. Returns null when
/// the item does not exist; a denied prompt or a locked keychain is an error instead.
#[napi]
pub fn keychain_generic_password(service: String, account: String) -> Result<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        // errSecItemNotFound from <Security/SecBase.h>.
        const ITEM_NOT_FOUND: i32 = -25300;
        let password = match security_framework::passwords::get_generic_password(&service, &account)
        {
            Ok(password) => password,
            Err(error) if error.code() == ITEM_NOT_FOUND => return Ok(None),
            Err(error) => {
                let code = error.code();
                return Err(Error::from_reason(format!(
                    "keychain item {service}/{account} unavailable: {error} (OSStatus {code})"
                )));
            }
        };
        String::from_utf8(password).map(Some).map_err(|_| {
            Error::from_reason(format!("keychain item {service}/{account} is not text"))
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, account);
        Err(Error::from_reason(
            "reading a keychain item is only supported on macOS",
        ))
    }
}
