//! Embeds the app icon as a Windows exe resource so the binary shows
//! the Hypen mark in Explorer, the taskbar, and installer shortcuts.
//! No-op for every other target OS.

fn main() {
    println!("cargo:rerun-if-changed=assets/icons/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        winresource::WindowsResource::new()
            .set_icon("assets/icons/icon.ico")
            .compile()
            .expect("embed Windows icon resource");
    }
}
