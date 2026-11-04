#![allow(unsafe_code, clippy::undocumented_unsafe_blocks)]

use napi::{Error, Result};
use napi_derive::napi;

/// Marks a downloaded file as coming from `source` (and the page at `referrer`),
/// the way Chrome does: the quarantine flag plus "where from" on macOS, the
/// origin extended attributes on Linux. Both URLs may be empty.
#[napi]
pub fn quarantine_file(path: String, source: String, referrer: String, agent: String) -> Result<()> {
    platform::quarantine(&path, &source, &referrer, &agent).map_err(Error::from_reason)
}

/// Whether the file carries macOS's quarantine flag; null where the system has none.
#[napi]
pub fn quarantined(path: String) -> Option<bool> {
    platform::quarantined(&path)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{CString, c_void};
    use std::ptr;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFIndex = isize;
    type Boolean = u8;

    const UTF8: u32 = 0x0800_0100;

    #[repr(C)]
    struct Opaque {
        _private: [u8; 0],
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: Opaque;
        static kCFTypeDictionaryValueCallBacks: Opaque;
        static kCFTypeArrayCallBacks: Opaque;
        static kCFURLQuarantinePropertiesKey: CFStringRef;
        fn CFStringCreateWithBytes(
            alloc: CFAllocatorRef,
            bytes: *const u8,
            len: CFIndex,
            encoding: u32,
            external: Boolean,
        ) -> CFStringRef;
        fn CFURLCreateFromFileSystemRepresentation(
            alloc: CFAllocatorRef,
            buffer: *const u8,
            len: CFIndex,
            directory: Boolean,
        ) -> CFTypeRef;
        fn CFURLSetResourcePropertyForKey(
            url: CFTypeRef,
            key: CFStringRef,
            value: CFTypeRef,
            error: *mut CFTypeRef,
        ) -> Boolean;
        fn CFErrorGetCode(error: CFTypeRef) -> CFIndex;
        fn CFDictionaryCreateMutable(
            alloc: CFAllocatorRef,
            capacity: CFIndex,
            keys: *const Opaque,
            values: *const Opaque,
        ) -> CFTypeRef;
        fn CFDictionarySetValue(dict: CFTypeRef, key: CFTypeRef, value: CFTypeRef);
        fn CFArrayCreate(
            alloc: CFAllocatorRef,
            values: *const CFTypeRef,
            count: CFIndex,
            callbacks: *const Opaque,
        ) -> CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
    }

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        static kLSQuarantineAgentNameKey: CFStringRef;
        static kLSQuarantineTypeKey: CFStringRef;
        static kLSQuarantineTypeWebDownload: CFStringRef;
        static kLSQuarantineTypeOtherDownload: CFStringRef;
        static kLSQuarantineDataURLKey: CFStringRef;
        static kLSQuarantineOriginURLKey: CFStringRef;
        static kMDItemWhereFroms: CFStringRef;
        fn MDItemCreate(alloc: CFAllocatorRef, path: CFStringRef) -> CFTypeRef;
        fn MDItemSetAttribute(item: CFTypeRef, name: CFStringRef, value: CFTypeRef) -> Boolean;
    }

    struct Owned(CFTypeRef);

    impl Owned {
        fn new(value: CFTypeRef) -> Option<Self> {
            (!value.is_null()).then_some(Self(value))
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    fn string(value: &str) -> Option<Owned> {
        Owned::new(unsafe {
            CFStringCreateWithBytes(ptr::null(), value.as_ptr(), value.len() as CFIndex, UTF8, 0)
        })
    }


    const QUARANTINE: &std::ffi::CStr = c"com.apple.quarantine";

    fn read_quarantine(path: &CString) -> Option<String> {
        let mut buffer = [0u8; 1024];
        let size = unsafe {
            libc::getxattr(path.as_ptr(), QUARANTINE.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len(), 0, 0)
        };
        let size = usize::try_from(size).ok().filter(|size| *size > 0)?;
        Some(String::from_utf8_lossy(&buffer[..size]).into_owned())
    }

    // The flag reads "flags;time;agent;event id". Set through the API by a
    // process without an app bundle, macOS leaves the agent empty, and the
    // agent is the name its "downloaded from the Internet" warning shows.
    fn name_agent(path: &str, agent: &str) -> Result<(), String> {
        let path = CString::new(path).map_err(|_| "path contains NUL".to_string())?;
        let value = read_quarantine(&path).ok_or("quarantine flag missing after set")?;
        let mut fields: Vec<&str> = value.split(';').collect();
        if fields.len() < 4 || !fields[2].is_empty() {
            return Ok(());
        }
        let agent = agent.replace(';', " ");
        fields[2] = &agent;
        let named = fields.join(";");
        let result = unsafe {
            libc::setxattr(path.as_ptr(), QUARANTINE.as_ptr(), named.as_ptr().cast(), named.len(), 0, 0)
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    // Chrome writes these too, through Spotlight; Finder shows them under "Where from".
    fn add_where_froms(path: &str, source: &str, referrer: &str) {
        let Some(path) = string(path) else { return };
        let Some(item) = Owned::new(unsafe { MDItemCreate(ptr::null(), path.0) }) else { return };
        let urls: Vec<Owned> = [source, referrer]
            .into_iter()
            .filter(|url| !url.is_empty())
            .filter_map(string)
            .collect();
        if urls.is_empty() {
            return;
        }
        let values: Vec<CFTypeRef> = urls.iter().map(|url| url.0).collect();
        let Some(list) = Owned::new(unsafe {
            CFArrayCreate(ptr::null(), values.as_ptr(), values.len() as CFIndex, &kCFTypeArrayCallBacks)
        }) else {
            return;
        };
        unsafe { MDItemSetAttribute(item.0, kMDItemWhereFroms, list.0) };
    }

    pub fn quarantined(path: &str) -> Option<bool> {
        Some(CString::new(path).ok().and_then(|path| read_quarantine(&path)).is_some())
    }

    pub fn quarantine(path: &str, source: &str, referrer: &str, agent: &str) -> Result<(), String> {
        if !std::path::Path::new(path).is_file() {
            return Err("file missing".to_string());
        }
        let file = Owned::new(unsafe {
            CFURLCreateFromFileSystemRepresentation(ptr::null(), path.as_ptr(), path.len() as CFIndex, 0)
        })
        .ok_or("invalid path")?;
        let properties = Owned::new(unsafe {
            CFDictionaryCreateMutable(
                ptr::null(),
                0,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            )
        })
        .ok_or("out of memory")?;
        let web = source.starts_with("http://") || source.starts_with("https://");
        let agent_name = string(agent).ok_or("invalid agent name")?;
        let data_url = (!source.is_empty()).then(|| string(source)).flatten();
        let origin_url = (!referrer.is_empty()).then(|| string(referrer)).flatten();
        unsafe {
            CFDictionarySetValue(properties.0, kLSQuarantineAgentNameKey, agent_name.0);
            let kind = if web { kLSQuarantineTypeWebDownload } else { kLSQuarantineTypeOtherDownload };
            CFDictionarySetValue(properties.0, kLSQuarantineTypeKey, kind);
            if let Some(data_url) = &data_url {
                CFDictionarySetValue(properties.0, kLSQuarantineDataURLKey, data_url.0);
            }
            if let Some(origin_url) = &origin_url {
                CFDictionarySetValue(properties.0, kLSQuarantineOriginURLKey, origin_url.0);
            }
        }
        let mut error: CFTypeRef = ptr::null();
        let set = unsafe {
            CFURLSetResourcePropertyForKey(file.0, kCFURLQuarantinePropertiesKey, properties.0, &mut error)
        };
        if set == 0 {
            let code = if error.is_null() {
                0
            } else {
                let code = unsafe { CFErrorGetCode(error) };
                unsafe { CFRelease(error) };
                code
            };
            return Err(format!("quarantine failed ({code})"));
        }
        name_agent(path, agent)?;
        add_where_froms(path, source, referrer);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::ffi::CString;

    fn set(path: &CString, name: &std::ffi::CStr, value: &str) -> Result<(), String> {
        let result = unsafe {
            libc::setxattr(path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0)
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    pub fn quarantined(_path: &str) -> Option<bool> {
        None
    }

    pub fn quarantine(path: &str, source: &str, referrer: &str, _agent: &str) -> Result<(), String> {
        let path = CString::new(path).map_err(|_| "path contains NUL".to_string())?;
        if !source.is_empty() {
            set(&path, c"user.xdg.origin.url", source)?;
        }
        if !referrer.is_empty() {
            set(&path, c"user.xdg.referrer.url", referrer)?;
        }
        Ok(())
    }
}
