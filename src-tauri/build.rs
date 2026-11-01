fn main() {
    // Tauri embeds frontend/dist into the binary at compile time (via generate_context!). Tell cargo to
    // re-run this build script — and so recompile and re-embed — whenever the built frontend changes, so a
    // rebuilt UI is actually baked into the binary instead of a stale one.
    println!("cargo:rerun-if-changed=../frontend/dist");
    tauri_build::build();
}
