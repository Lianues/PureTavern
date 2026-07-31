#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod local_server;

use local_server::{
    pure_tavern_local_cancel_request, pure_tavern_local_start_request, LocalServerState,
};
use tauri::Manager;

fn main() {
    let local_server =
        LocalServerState::new().expect("error while initializing PureTavern desktop networking");
    tauri::Builder::default()
        .plugin(local_server::bridge_plugin())
        .manage(local_server)
        .invoke_handler(tauri::generate_handler![
            pure_tavern_local_start_request,
            pure_tavern_local_cancel_request
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<LocalServerState>().cancel_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running PureTavern desktop shell");
}
