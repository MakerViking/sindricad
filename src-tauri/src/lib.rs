//! SindriCAD Tauri shell entry. Spawns the Python geometry sidecar on startup and
//! kills it on exit. The frontend talks to the sidecar over a localhost
//! WebSocket directly (not Tauri IPC); Rust only owns the window, native
//! dialogs, and the sidecar lifecycle.

#[cfg(feature = "rust-geom")]
mod geom;
mod printer;
mod sidecar;
mod slicer;
mod spacemouse;
mod tinkeratlas;

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

// --- crash-recovery snapshots -------------------------------------------------
// Autosave lives OUTSIDE the webview's tightened fs scope on purpose: widening
// `fs:scope` to an app-data dir would re-open part of the post-XSS persistence
// channel the security round closed. Instead the frontend calls these commands
// (privileged IPC, same pattern as `sidecar_token`) and Rust owns the recovery
// directory under app_data_dir()/recovery/. Writes are atomic (tmp + rename).

fn recovery_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// slot names are caller-chosen but sanitized hard: they become file names.
fn slot_file(app: &tauri::AppHandle, slot: &str) -> Result<std::path::PathBuf, String> {
    let safe: String = slot
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    if safe.is_empty() {
        return Err("empty recovery slot".into());
    }
    Ok(recovery_dir(app)?.join(format!("{safe}.sindri")))
}

#[tauri::command]
fn recovery_write(app: tauri::AppHandle, slot: String, json: String) -> Result<(), String> {
    let path = slot_file(&app, &slot)?;
    let tmp = path.with_extension("sindri.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn recovery_read(app: tauri::AppHandle, slot: String) -> Result<Option<String>, String> {
    let path = slot_file(&app, &slot)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// list slots with their last-modified time (ms since epoch), newest first.
#[tauri::command]
fn recovery_list(app: tauri::AppHandle) -> Result<Vec<(String, u64)>, String> {
    let dir = recovery_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("sindri") {
            continue;
        }
        let name = match p.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push((name, mtime));
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(out)
}

#[tauri::command]
fn recovery_clear(app: tauri::AppHandle, slot: String) -> Result<(), String> {
    let path = slot_file(&app, &slot)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // The Rust/OCCT geometry commands (`geom_rebuild`/`geom_export`) only exist when
    // the `rust-geom` feature is on (VITE_GEOM=rust). generate_handler! won't accept
    // #[cfg] on individual entries, so we register the command set in two whole-list
    // arms: with the geom pair when the feature is on, without it (the shipping
    // Python-sidecar build) when it's off. `sidecar_token` hands the per-launch
    // WebSocket auth token to the frontend so it can dial the sidecar.
    #[cfg(feature = "rust-geom")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        geom::geom_rebuild,
        geom::geom_export,
        sidecar_token,
        recovery_write,
        recovery_read,
        recovery_list,
        recovery_clear,
        printer::printers_list,
        printer::printers_upsert,
        printer::printers_remove,
        printer::printer_probe,
        printer::printer_filaments,
        printer::printer_status,
        printer::printer_upload_and_print,
        printer::printer_set_filament,
        printer::printer_monitor_start,
        printer::printer_monitor_stop,
        slicer::settings_get,
        slicer::settings_set,
        slicer::print_staging_path,
        slicer::slicer_open,
        slicer::slicer_project_settings,
        tinkeratlas::ta_account,
        tinkeratlas::ta_sign_in,
        tinkeratlas::ta_sign_out,
        tinkeratlas::ta_ping,
        tinkeratlas::ta_staging_path,
        tinkeratlas::ta_publish,
        tinkeratlas::ta_avatar
    ]);
    #[cfg(not(feature = "rust-geom"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        sidecar_token,
        recovery_write,
        recovery_read,
        recovery_list,
        recovery_clear,
        printer::printers_list,
        printer::printers_upsert,
        printer::printers_remove,
        printer::printer_probe,
        printer::printer_filaments,
        printer::printer_status,
        printer::printer_upload_and_print,
        printer::printer_set_filament,
        printer::printer_monitor_start,
        printer::printer_monitor_stop,
        slicer::settings_get,
        slicer::settings_set,
        slicer::print_staging_path,
        slicer::slicer_open,
        slicer::slicer_project_settings,
        tinkeratlas::ta_account,
        tinkeratlas::ta_sign_in,
        tinkeratlas::ta_sign_out,
        tinkeratlas::ta_ping,
        tinkeratlas::ta_staging_path,
        tinkeratlas::ta_publish,
        tinkeratlas::ta_avatar
    ]);

    let app = builder
        .manage(printer::Monitors::default())
        .setup(|app| {
            match Sidecar::spawn(app.handle()) {
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
