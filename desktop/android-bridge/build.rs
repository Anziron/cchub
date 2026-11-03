fn main() {
    // 插件只由 Rust 调用，不给前端开放命令。
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .build();
}
