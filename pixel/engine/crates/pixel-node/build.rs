fn main() {
    napi_build::setup();
    // Test binaries link the napi registrations too; node provides those symbols at load time.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
}
