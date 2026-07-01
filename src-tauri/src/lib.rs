//! SindriCAD Tauri shell entry. Spawns the Python geometry sidecar on startup and
//! kills it on exit. The frontend talks to the sidecar over a localhost
//! WebSocket directly (not Tauri IPC); Rust only owns the window, native
//! dialogs, and the sidecar lifecycle.

mod geom;
mod sidecar;
mod spacemouse;

use sidecar::Sidecar;
use tauri::{Manager, RunEvent};

/// Hand the per-launch sidecar WebSocket auth token to the webview so the
/// frontend can append it to its `ws://…?token=` URL. Only the privileged
/// webview can call this (Tauri IPC), which is what keeps the token out of
/// reach of other local processes and web pages.
#[tauri::command]
fn sidecar_token(state: tauri::State<'_, Sidecar>) -> String {
    state.token.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Rust geometry spike: callable as invoke("geom_rebuild") when the
        // frontend runs with VITE_GEOM=rust (else it uses the Python sidecar).
        // `sidecar_token` hands the per-launch WebSocket auth token to the
        // frontend so it can dial the sidecar.
        .invoke_handler(tauri::generate_handler![geom::geom_rebuild, geom::geom_export, sidecar_token])
        .setup(|app| {
            match Sidecar::spawn() {
                Ok(s) => {
                    app.manage(s);
                }
                Err(e) => eprintln!("failed to spawn sidecar: {e}"),
            }
            // stream 3Dconnexion SpaceMouse events to the frontend (best-effort:
            // no-op if no device / no permission — see spacemouse.rs)
            spacemouse::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building SindriCAD");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            if let Some(s) = app_handle.try_state::<Sidecar>() {
                s.kill();
            }
        }
    });
}
