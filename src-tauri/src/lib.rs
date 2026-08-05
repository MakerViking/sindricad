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
// WebKitGTK only exists on Linux; macOS and Windows use WKWebView and WebView2.
#[cfg(target_os = "linux")]
mod webkit;

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

/// Restart the app after an update, tearing down the geometry engine and
/// releasing the single-instance lock first, so the replacement process comes up
/// clean. Neither step can be left to a destructor — see the body.
#[tauri::command]
fn restart_for_update(app: tauri::AppHandle) {
    // Kill the geometry engine EXPLICITLY rather than trusting a platform backstop.
    // `app.restart()` ends this process through exit(), which does not run
    // destructors, so `Sidecar::drop` never fires. Each platform has a fallback for
    // that, but they are timing-dependent: macOS has no PR_SET_PDEATHSIG and polls
    // getppid() once a SECOND (see `_die_with_parent` in sidecar/server.py), so the
    // replacement process can start, find port 8765 still held by the old sidecar,
    // and come up with a dead engine — reporting "another copy is already running"
    // immediately after an update, which is both wrong and alarming.
    // `Sidecar::kill` waits for the child, so the port is free before we return.
    if let Some(sidecar) = app.try_state::<Sidecar>() {
        sidecar.kill();
    }
    // Then release the single-instance lock. The frontend used to call the process
    // plugin's `relaunch()` directly, which maps to `app.request_restart()` and
    // spawns the replacement while this process is still shutting down — so with a
    // single-instance guard in place the NEW instance can find the lock still held
    // and exit immediately, leaving the user with no app at all after an update.
    // `destroy` is synchronous on every platform (D-Bus release_name on Linux,
    // ReleaseMutex + DestroyWindow on Windows), so it completes before the spawn.
    tauri_plugin_single_instance::destroy(&app);
    app.restart();
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
// async: Tauri runs sync commands on the MAIN thread — a multi-MB snapshot
// write would stall the UI for its full fs time. async moves it to the runtime
// pool; the tmp-write + rename stays atomic either way.
async fn recovery_write(app: tauri::AppHandle, slot: String, json: String) -> Result<(), String> {
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

/// In-app updates only apply to formats the Tauri updater can replace: the NSIS
/// install on Windows, the .app on macOS, and the AppImage on Linux. A deb/rpm
/// install belongs to the package manager, so the frontend hides the update UI
/// when this is false.
#[tauri::command]
fn updates_supported() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

// --- frontend load watchdog ---------------------------------------------------
// A webview that never loads its page shows a blank window and says NOTHING.
// Issue #3 spent four rounds on that: the geometry engine was up and logging
// happily, the window painted, and there was no way to tell from the outside
// whether the document had failed to load, or had loaded and thrown. Every reply
// was a guess at an environment variable.
//
// So the frontend reports in, and Rust says so when it does not.

/// Set by `frontend_ready`. `AtomicBool` rather than a channel because the
/// watchdog only ever asks one yes/no question, and a channel would have to be
/// kept alive for a message that normally never comes.
struct FrontendReady(std::sync::atomic::AtomicBool);

/// How long to wait before concluding the interface is not coming.
///
/// Generous on purpose. A cold first launch on a slow disk has to parse and
/// execute the whole bundle, and the cost of being wrong is asymmetric: a late
/// line in a log is harmless, while crying wolf on a working app would teach
/// people to ignore the one message that matters. This is why the watchdog only
/// logs and does not raise a dialog.
const FRONTEND_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// Called by `src/boot.ts` as the document loads. Its only job is to prove the
/// webview got far enough to run our code and reach Tauri IPC.
#[tauri::command]
fn frontend_ready(state: tauri::State<'_, FrontendReady>) {
    state.0.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Watch for the frontend checking in, and write a diagnosis if it never does.
///
/// The message deliberately rules the geometry engine out by name. That is the
/// wrong turn this is built to prevent: the sidecar is the loudest thing in the
/// log, so a blank window with a healthy `[sidecar] LISTENING 8765` above it
/// reads as an engine problem to everyone who sees it, and it is not one.
fn watch_frontend_load(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FRONTEND_READY_TIMEOUT);

        let ready = app
            .try_state::<FrontendReady>()
            .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(false);
        if ready {
            return;
        }

        let secs = FRONTEND_READY_TIMEOUT.as_secs();
        let lines = [
            format!("[ui] WARNING: the interface has not loaded after {secs}s."),
            "[ui] The window opened but the page never started, so this is NOT a geometry".to_string(),
            "[ui] engine problem — the engine's own status is logged separately above."
                .to_string(),
            "[ui] Either the document failed to load, or a script threw while loading it."
                .to_string(),
            "[ui] Please report this log at https://github.com/MakerViking/sindricad/issues"
                .to_string(),
        ];
        // Through the sidecar so the warning reaches sidecar.log, which is the
        // file a bug report attaches. Without the sidecar (it failed to spawn)
        // stdout is all there is, and that is still better than silence.
        match app.try_state::<Sidecar>() {
            Some(sidecar) => lines.iter().for_each(|l| sidecar.log_line(l)),
            None => lines.iter().for_each(|l| println!("{l}")),
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FIRST, before any GTK/WebKit type is touched: the web process inherits this
    // environment when WebKit spawns it, so a variable set later is a variable the
    // renderer never sees. See webkit.rs for what it changes and why (issue #6).
    #[cfg(target_os = "linux")]
    webkit::apply_gpu_workarounds();

    let builder = tauri::Builder::default()
        // MUST be registered before every other plugin (Tauri's documented
        // requirement). A second launch focuses the window that is already open
        // instead of starting an app whose sidecar cannot take port 8765.
        // No `fileAssociations` exist, so `argv` carries nothing worth forwarding;
        // if one is ever added, this callback has to hand it to the running
        // instance or double-clicking a .sindri file will silently do nothing.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize(); // a minimized window would otherwise just blink
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

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
        restart_for_update,
        updates_supported,
        frontend_ready,
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
        printer::printer_camera_start,
        printer::printer_camera_stop,
        slicer::settings_get,
        slicer::settings_set,
        slicer::print_staging_path,
        slicer::slicer_open,
        slicer::slicer_project_settings,
        tinkeratlas::ta_account,
        tinkeratlas::ta_sign_in,
        tinkeratlas::ta_browser_sign_in,
        tinkeratlas::ta_sign_out,
        tinkeratlas::ta_ping,
        tinkeratlas::ta_staging_path,
        tinkeratlas::ta_publish,
        tinkeratlas::ta_avatar,
        tinkeratlas::ta_bug_report,
        spacemouse::spacemouse_inventory
    ]);
    #[cfg(not(feature = "rust-geom"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        sidecar_token,
        restart_for_update,
        updates_supported,
        frontend_ready,
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
        printer::printer_camera_start,
        printer::printer_camera_stop,
        slicer::settings_get,
        slicer::settings_set,
        slicer::print_staging_path,
        slicer::slicer_open,
        slicer::slicer_project_settings,
        tinkeratlas::ta_account,
        tinkeratlas::ta_sign_in,
        tinkeratlas::ta_browser_sign_in,
        tinkeratlas::ta_sign_out,
        tinkeratlas::ta_ping,
        tinkeratlas::ta_staging_path,
        tinkeratlas::ta_publish,
        tinkeratlas::ta_avatar,
        tinkeratlas::ta_bug_report,
        spacemouse::spacemouse_inventory
    ]);

    let app = builder
        .manage(printer::Monitors::default())
        .manage(printer::Cameras::default())
        .manage(spacemouse::Inventory::default())
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
            // LAST, so the sidecar is already managed and the warning can reach
            // sidecar.log. Started here rather than before the builder because
            // the clock should run from the window existing, not from process
            // start: everything above it is work the frontend has to wait for
            // anyway, and counting it would eat into the timeout.
            app.manage(FrontendReady(std::sync::atomic::AtomicBool::new(false)));
            watch_frontend_load(app.handle().clone());
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
