const LOCAL_SERVER_COMMANDS: &[&str] = &[
    "pure_tavern_local_start_request",
    "pure_tavern_local_cancel_request",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(LOCAL_SERVER_COMMANDS));
    tauri_build::try_build(attributes).expect("failed to prepare PureTavern desktop permissions");
}
