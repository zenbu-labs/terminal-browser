fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    println!("cargo:rerun-if-changed=native-scroll-helper.swift");
    let out = format!("{}/native-scroll-helper", std::env::var("OUT_DIR").unwrap());
    let compiled = std::process::Command::new("swiftc")
        .args(["-O", "native-scroll-helper.swift", "-o", &out])
        .status()
        .is_ok_and(|status| status.success());
    if compiled {
        println!("cargo:rustc-env=NATIVE_SCROLL_HELPER={out}");
    }
}
