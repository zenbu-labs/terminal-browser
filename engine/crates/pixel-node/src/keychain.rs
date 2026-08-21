use napi::{Error, Result};
use napi_derive::napi;

/// The Safe Storage items this binding may read, keyed by the browser slug
/// `browser/src/cookies.ts` detects. The item names live here rather than in the caller so a
/// caller cannot name an item — it can only pick a row of this table.
const SAFE_STORAGE_BROWSERS: &[(&str, &[&str])] = &[
    ("google-chrome", &["Google Chrome", "Chrome"]),
    ("brave", &["Brave", "Brave Browser"]),
    ("microsoft-edge", &["Microsoft Edge"]),
    ("arc", &["Arc"]),
    ("opera", &["Opera"]),
    ("opera-gx", &["Opera GX"]),
    ("vivaldi", &["Vivaldi"]),
    ("dia", &["Dia"]),
    ("perplexity-comet", &["Perplexity Comet", "Comet"]),
    ("sigmaos", &["SigmaOS"]),
    ("sidekick", &["Sidekick"]),
    ("helium", &["Helium"]),
    ("atlas", &["Atlas"]),
    ("chromium", &["Chromium"]),
];

/// Chromium keeps the key under "<name> Safe Storage"; older builds used "<name> Storage Key".
/// The account is the name on its own.
const SERVICE_SUFFIXES: [&str; 2] = ["Storage Key", "Safe Storage"];

fn safe_storage_names(browser: &str) -> Result<&'static [&'static str]> {
    SAFE_STORAGE_BROWSERS
        .iter()
        .find(|(slug, _)| *slug == browser)
        .map(|(_, names)| *names)
        .ok_or_else(|| {
            Error::from_reason(format!(
                "{browser} is not a browser whose Safe Storage key can be read"
            ))
        })
}

/// Reads a known Chromium-family browser's Safe Storage secret in this process, so macOS
/// attributes the access prompt to this app rather than to a shared command line tool.
/// Errors when no such item exists, and when one exists but the keychain refuses it.
#[napi]
pub fn chromium_safe_storage_secret(browser: String) -> Result<String> {
    // errSecItemNotFound from <Security/SecBase.h>.
    const ITEM_NOT_FOUND: i32 = -25300;

    let mut tried: Vec<String> = Vec::new();
    for &name in safe_storage_names(&browser)? {
        for suffix in SERVICE_SUFFIXES {
            let service = format!("{name} {suffix}");
            match security_framework::passwords::get_generic_password(&service, name) {
                Ok(password) => {
                    return String::from_utf8(password).map_err(|_| {
                        Error::from_reason(format!("the key in {service} is not text"))
                    });
                }
                Err(error) if error.code() == ITEM_NOT_FOUND => tried.push(service),
                Err(error) => {
                    let code = error.code();
                    return Err(Error::from_reason(format!(
                        "macOS refused {service}: {error} (OSStatus {code})"
                    )));
                }
            }
        }
    }
    Err(Error::from_reason(format!(
        "no Safe Storage item in the login keychain — tried {}",
        tried.join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::safe_storage_names;

    #[test]
    fn only_table_rows_resolve() {
        assert!(safe_storage_names("google-chrome").is_ok());
        // Naming an item directly must not work — that is the whole restriction.
        assert!(safe_storage_names("Chrome Safe Storage").is_err());
        assert!(safe_storage_names("login").is_err());
    }
}
