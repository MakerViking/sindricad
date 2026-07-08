//! Printer device layer — talk Moonraker (Snapmaker U1 now, Qidi/other Moonraker
//! machines later) from the NATIVE side. The webview never reaches the LAN: it
//! calls these Tauri commands by printer *id*, and Rust resolves the host from a
//! Rust-owned registry (`app_data_dir()/printers.json`). This keeps the strict
//! webview CSP (connect-src localhost only) intact — native reqwest is not
//! subject to it.
//!
//! Facts pinned to the U1's shipped firmware (fw 1.3.0, verified against
//! Snapmaker's open-sourced u1-moonraker/u1-klipper): LAN is fully trusted
//! (no API key), filament state lives in the `print_task_config` printer object,
//! and a job is sent by POST /server/files/upload then
//! POST /server/files/start_local_print with a `map_table` filament remap.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

// --- config registry ----------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrinterKind {
    /// Snapmaker U1: Moonraker + the extra start_local_print/map_table endpoints.
    MoonrakerU1,
    /// Plain Klipper/Moonraker (e.g. Qidi X-Plus 4) — upload + print/start only.
    Moonraker,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrinterConfig {
    pub id: String,
    pub name: String,
    /// bare host or IP — validated: no scheme, slash, '@', or whitespace.
    pub host: String,
    pub port: u16,
    pub kind: PrinterKind,
}

// --- error taxonomy (mapped to toasts on the frontend) ------------------------

#[derive(Serialize, Clone, Copy, Debug)]
pub enum ErrCode {
    Unreachable,
    Busy,
    NozzleMismatch,
    Rejected,
    Protocol,
    Config,
}

#[derive(Serialize, Clone, Debug)]
pub struct PrinterError {
    pub code: ErrCode,
    pub message: String,
}

impl PrinterError {
    fn new(code: ErrCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

type PResult<T> = Result<T, PrinterError>;

// --- registry storage ---------------------------------------------------------

fn registry_path(app: &AppHandle) -> PResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| PrinterError::new(ErrCode::Config, e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| PrinterError::new(ErrCode::Config, e.to_string()))?;
    Ok(dir.join("printers.json"))
}

/// The user's two machines, seeded on first run (the file is then user-owned and
/// editable through the commands). The Qidi's Moonraker sits on :10088.
fn seed_registry() -> Vec<PrinterConfig> {
    vec![
        PrinterConfig {
            id: "u1".into(),
            name: "Snapmaker U1".into(),
            host: "192.168.0.46".into(),
            port: 7125,
            kind: PrinterKind::MoonrakerU1,
        },
        PrinterConfig {
            id: "qidi-xplus4".into(),
            name: "Qidi X-Plus 4".into(),
            host: "192.168.0.76".into(),
            port: 10088,
            kind: PrinterKind::Moonraker,
        },
    ]
}

fn read_registry(app: &AppHandle) -> PResult<Vec<PrinterConfig>> {
    let path = registry_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| PrinterError::new(ErrCode::Config, format!("printers.json: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let seed = seed_registry();
            write_registry(app, &seed)?;
            Ok(seed)
        }
        Err(e) => Err(PrinterError::new(ErrCode::Config, e.to_string())),
    }
}

fn write_registry(app: &AppHandle, list: &[PrinterConfig]) -> PResult<()> {
    let path = registry_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(list)
        .map_err(|e| PrinterError::new(ErrCode::Config, e.to_string()))?;
    std::fs::write(&tmp, json).map_err(|e| PrinterError::new(ErrCode::Config, e.to_string()))?;
    std::fs::rename(&tmp, &path).map_err(|e| PrinterError::new(ErrCode::Config, e.to_string()))
}

/// A host must be a bare IP/hostname — never a URL. Rejecting scheme/slash/@/space
/// is what lets us build `http://{host}:{port}` safely from webview-supplied data
/// (the webview only ever sends an id, but upsert takes a host from a settings UI).
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

fn resolve(app: &AppHandle, id: &str) -> PResult<PrinterConfig> {
    read_registry(app)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| PrinterError::new(ErrCode::Config, format!("no printer with id {id:?}")))
}

fn base_url(cfg: &PrinterConfig) -> String {
    format!("http://{}:{}", cfg.host, cfg.port)
}

fn http() -> PResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| PrinterError::new(ErrCode::Protocol, e.to_string()))
}

fn unreachable(e: reqwest::Error) -> PrinterError {
    PrinterError::new(ErrCode::Unreachable, e.to_string())
}

// --- payload types -------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct ProbeInfo {
    pub online: bool,
    pub klippy_state: String,
    pub moonraker_version: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ToolheadFilament {
    pub index: u8,
    pub vendor: String,
    pub material: String,
    pub sub_type: String,
    pub color: String, // "#RRGGBB"
    pub present: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct PrintStatus {
    pub state: String,     // "printing" | "paused" | "complete" | "standby" | ...
    pub filename: String,
    pub progress: f32,     // 0..1
    pub print_duration: f64,
    pub total_duration: f64,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartOpts {
    #[serde(default)]
    pub bed_level: bool,
    #[serde(default)]
    pub flow_calibrate: bool,
    #[serde(default)]
    pub time_lapse_camera: bool,
}

// --- Moonraker helpers ---------------------------------------------------------

/// GET a printer-objects query and return the `result.status` value.
async fn query_status(client: &reqwest::Client, base: &str, objects: &str) -> PResult<serde_json::Value> {
    let url = format!("{base}/printer/objects/query?{objects}");
    let resp = client.get(&url).send().await.map_err(unreachable)?;
    if !resp.status().is_success() {
        return Err(PrinterError::new(ErrCode::Protocol, format!("HTTP {}", resp.status())));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| PrinterError::new(ErrCode::Protocol, e.to_string()))?;
    Ok(body.get("result").and_then(|r| r.get("status")).cloned().unwrap_or(serde_json::Value::Null))
}

fn argb_to_hex(color: &str) -> String {
    // print_task_config gives "RRGGBBAA"; take RGB. Fall back to a neutral grey.
    let s = color.trim_start_matches('#');
    if s.len() >= 6 && s[..6].chars().all(|c| c.is_ascii_hexdigit()) {
        format!("#{}", s[..6].to_uppercase())
    } else {
        "#808080".into()
    }
}

// --- commands ------------------------------------------------------------------

#[tauri::command]
pub fn printers_list(app: AppHandle) -> PResult<Vec<PrinterConfig>> {
    read_registry(&app)
}

#[tauri::command]
pub fn printers_upsert(app: AppHandle, cfg: PrinterConfig) -> PResult<()> {
    if cfg.id.trim().is_empty() {
        return Err(PrinterError::new(ErrCode::Config, "printer id required"));
    }
    if !valid_host(&cfg.host) {
        return Err(PrinterError::new(ErrCode::Config, format!("invalid host {:?} (bare IP/hostname only)", cfg.host)));
    }
    let mut list = read_registry(&app)?;
    match list.iter_mut().find(|p| p.id == cfg.id) {
        Some(existing) => *existing = cfg,
        None => list.push(cfg),
    }
    write_registry(&app, &list)
}

#[tauri::command]
pub fn printers_remove(app: AppHandle, id: String) -> PResult<()> {
    let mut list = read_registry(&app)?;
    list.retain(|p| p.id != id);
    write_registry(&app, &list)
}

#[tauri::command]
pub async fn printer_probe(app: AppHandle, id: String) -> PResult<ProbeInfo> {
    let cfg = resolve(&app, &id)?;
    let client = http()?;
    let url = format!("{}/server/info", base_url(&cfg));
    let resp = client.get(&url).send().await.map_err(unreachable)?;
    let body: serde_json::Value = resp.json().await.map_err(|e| PrinterError::new(ErrCode::Protocol, e.to_string()))?;
    let r = body.get("result").cloned().unwrap_or(serde_json::Value::Null);
    Ok(ProbeInfo {
        online: r.get("klippy_connected").and_then(|v| v.as_bool()).unwrap_or(false),
        klippy_state: r.get("klippy_state").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        moonraker_version: r.get("moonraker_version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    })
}

#[tauri::command]
pub async fn printer_filaments(app: AppHandle, id: String) -> PResult<Vec<ToolheadFilament>> {
    let cfg = resolve(&app, &id)?;
    let client = http()?;
    let status = query_status(&client, &base_url(&cfg), "print_task_config").await?;
    let ptc = status.get("print_task_config").cloned().unwrap_or(serde_json::Value::Null);

    let arr = |k: &str| -> Vec<serde_json::Value> {
        ptc.get(k).and_then(|v| v.as_array()).cloned().unwrap_or_default()
    };
    let vendors = arr("filament_vendor");
    let types = arr("filament_type");
    let subs = arr("filament_sub_type");
    let colors = arr("filament_color_rgba");
    let exists = arr("filament_exist");

    let n = types.len().max(colors.len());
    if n == 0 {
        return Err(PrinterError::new(ErrCode::Protocol, "printer returned no filament slots (print_task_config empty)"));
    }
    let s = |v: &[serde_json::Value], i: usize| v.get(i).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok((0..n)
        .map(|i| ToolheadFilament {
            index: i as u8,
            vendor: s(&vendors, i),
            material: s(&types, i),
            sub_type: s(&subs, i),
            color: argb_to_hex(&s(&colors, i)),
            present: exists.get(i).and_then(|x| x.as_bool()).unwrap_or(false),
        })
        .collect())
}

#[tauri::command]
pub async fn printer_status(app: AppHandle, id: String) -> PResult<PrintStatus> {
    let cfg = resolve(&app, &id)?;
    let client = http()?;
    status_once(&client, &base_url(&cfg)).await
}

async fn status_once(client: &reqwest::Client, base: &str) -> PResult<PrintStatus> {
    let status = query_status(client, base, "print_stats&virtual_sdcard&display_status").await?;
    let ps = status.get("print_stats").cloned().unwrap_or_default();
    let vs = status.get("virtual_sdcard").cloned().unwrap_or_default();
    Ok(PrintStatus {
        state: ps.get("state").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
        filename: ps.get("filename").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        progress: vs.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
        print_duration: ps.get("print_duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
        total_duration: ps.get("total_duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
    })
}

/// Serialize a filament remap as the Python-literal-ish string the U1 firmware
/// parses: `[[logical,physical],...]`. It is a JSON string nested inside the
/// start_local_print JSON body — a serialization that is easy to get subtly
/// wrong, hence the dedicated helper + unit test.
fn map_table_string(map_table: &[(u8, u8)]) -> String {
    let pairs: Vec<[u8; 2]> = map_table.iter().map(|&(l, p)| [l, p]).collect();
    serde_json::to_string(&pairs).unwrap_or_else(|_| "[]".into())
}

/// The gcode file the frontend hands us must be a real, existing .gcode. The
/// path arrives from a native file dialog (user intent = the trust boundary,
/// same as the export save dialog), so Rust only checks kind + existence.
fn validate_gcode_path(gcode_path: &str) -> PResult<PathBuf> {
    let p = PathBuf::from(gcode_path);
    if p.extension().and_then(|e| e.to_str()) != Some("gcode") {
        return Err(PrinterError::new(ErrCode::Config, "expected a .gcode file"));
    }
    if !p.is_file() {
        return Err(PrinterError::new(ErrCode::Config, format!("no such file: {gcode_path}")));
    }
    Ok(p)
}

#[tauri::command]
pub async fn printer_upload_and_print(
    app: AppHandle,
    id: String,
    gcode_path: String,
    remote_name: String,
    map_table: Vec<(u8, u8)>,
    opts: StartOpts,
) -> PResult<()> {
    let cfg = resolve(&app, &id)?;
    let path = validate_gcode_path(&gcode_path)?;
    let bytes = std::fs::read(&path).map_err(|e| PrinterError::new(ErrCode::Config, e.to_string()))?;
    // remote name is a bare filename on the printer's gcodes root.
    let remote: String = remote_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let remote = if remote.ends_with(".gcode") { remote } else { format!("{remote}.gcode") };

    let client = http()?;
    let base = base_url(&cfg);

    // 1) upload (print=false) — start separately so we can pass the map_table.
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(remote.clone())
        .mime_str("application/octet-stream")
        .map_err(|e| PrinterError::new(ErrCode::Protocol, e.to_string()))?;
    let form = reqwest::multipart::Form::new().text("print", "false").part("file", part);
    let up = client
        .post(format!("{base}/server/files/upload"))
        .multipart(form)
        .send()
        .await
        .map_err(unreachable)?;
    if !up.status().is_success() {
        let msg = up.text().await.unwrap_or_default();
        return Err(PrinterError::new(ErrCode::Rejected, format!("upload failed: {msg}")));
    }

    // 2) start. The U1 accepts start_local_print with a filament map_table; a
    // plain Moonraker machine only knows printer/print/start.
    match cfg.kind {
        PrinterKind::MoonrakerU1 => {
            let mut options = serde_json::Map::new();
            options.insert("map_table".into(), serde_json::Value::String(map_table_string(&map_table)));
            options.insert("bed_level".into(), (opts.bed_level as u8).into());
            options.insert("flow_calibrate".into(), (opts.flow_calibrate as u8).into());
            options.insert("time_lapse_camera".into(), (opts.time_lapse_camera as u8).into());
            let body = serde_json::json!({ "path": remote, "options": options });
            let resp = client
                .post(format!("{base}/server/files/start_local_print"))
                .json(&body)
                .send()
                .await
                .map_err(unreachable)?;
            let v: serde_json::Value = resp.json().await.map_err(|e| PrinterError::new(ErrCode::Protocol, e.to_string()))?;
            interpret_start_reply(&v)
        }
        PrinterKind::Moonraker => {
            let resp = client
                .post(format!("{base}/printer/print/start?filename={remote}"))
                .send()
                .await
                .map_err(unreachable)?;
            if resp.status().is_success() {
                Ok(())
            } else {
                let msg = resp.text().await.unwrap_or_default();
                Err(PrinterError::new(ErrCode::Rejected, msg))
            }
        }
    }
}

/// start_local_print answers `{state: success|error|busy, message}`. Map the
/// failure kinds so the UI can distinguish "printer busy" from a nozzle mismatch.
fn interpret_start_reply(v: &serde_json::Value) -> PResult<()> {
    let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("");
    let msg = v.get("message").and_then(|s| s.as_str()).unwrap_or("").to_string();
    match state {
        "success" => Ok(()),
        "busy" => Err(PrinterError::new(ErrCode::Busy, if msg.is_empty() { "printer is busy".into() } else { msg })),
        _ => {
            let low = msg.to_lowercase();
            let code = if low.contains("busy") || low.contains("printing") || low.contains("not ready") {
                ErrCode::Busy
            } else if low.contains("nozzle") {
                ErrCode::NozzleMismatch
            } else {
                ErrCode::Rejected
            };
            Err(PrinterError::new(code, if msg.is_empty() { "printer rejected the job".into() } else { msg }))
        }
    }
}

/// Write filament config back to a U1 toolhead (SET_PRINT_FILAMENT_CONFIG). Not
/// wired to UI this round; the device layer exposes it for a future push-sync.
#[tauri::command]
pub async fn printer_set_filament(
    app: AppHandle,
    id: String,
    extruder: u8,
    vendor: String,
    material: String,
    sub_type: String,
    color: String,
    force: bool,
) -> PResult<()> {
    let cfg = resolve(&app, &id)?;
    let hex = color.trim_start_matches('#').to_uppercase();
    // guard the script fields — they are interpolated into a gcode command.
    let clean = |s: &str| -> String {
        s.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '+')).take(48).collect()
    };
    let mut script = format!(
        "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER={} VENDOR=\"{}\" FILAMENT_TYPE=\"{}\" FILAMENT_SUBTYPE=\"{}\" FILAMENT_COLOR_RGBA={}",
        extruder, clean(&vendor), clean(&material), clean(&sub_type), clean(&hex),
    );
    if force {
        script.push_str(" FORCE=1");
    }
    let client = http()?;
    let resp = client
        .post(format!("{}/printer/gcode/script?script={}", base_url(&cfg), urlencode(&script)))
        .send()
        .await
        .map_err(unreachable)?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(PrinterError::new(ErrCode::Rejected, resp.text().await.unwrap_or_default()))
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// --- status monitor (poll → emit "printer:status") ----------------------------

#[derive(Default)]
pub struct Monitors(pub Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

#[derive(Serialize, Clone)]
struct StatusEvent {
    id: String,
    #[serde(flatten)]
    status: PrintStatus,
}

#[tauri::command]
pub fn printer_monitor_start(app: AppHandle, id: String) -> PResult<()> {
    let cfg = resolve(&app, &id)?;
    let base = base_url(&cfg);
    let monitors = app.state::<Monitors>();
    // replace any existing monitor for this id.
    if let Some(h) = monitors.0.lock().unwrap().remove(&id) {
        h.abort();
    }
    let app2 = app.clone();
    let id2 = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let client = match http() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut fails = 0u8;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            match status_once(&client, &base).await {
                Ok(st) => {
                    fails = 0;
                    let terminal = !matches!(st.state.as_str(), "printing" | "paused");
                    let _ = app2.emit("printer:status", StatusEvent { id: id2.clone(), status: st });
                    if terminal {
                        break; // idle/complete/error — stop polling until asked again
                    }
                }
                Err(_) => {
                    fails += 1;
                    if fails >= 3 {
                        let _ = app2.emit("printer:offline", id2.clone());
                        break;
                    }
                }
            }
        }
        // self-remove so a later start re-spawns cleanly.
        if let Some(m) = app2.try_state::<Monitors>() {
            m.0.lock().unwrap().remove(&id2);
        }
    });
    monitors.0.lock().unwrap().insert(id, handle);
    Ok(())
}

#[tauri::command]
pub fn printer_monitor_stop(app: AppHandle, id: String) -> PResult<()> {
    if let Some(h) = app.state::<Monitors>().0.lock().unwrap().remove(&id) {
        h.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_table_serializes_as_nested_json_string() {
        assert_eq!(map_table_string(&[(0, 2), (1, 0), (2, 1), (3, 3)]), "[[0,2],[1,0],[2,1],[3,3]]");
        assert_eq!(map_table_string(&[]), "[]");
        assert_eq!(map_table_string(&[(0, 0)]), "[[0,0]]");
    }

    #[test]
    fn argb_takes_rgb() {
        assert_eq!(argb_to_hex("6C5BB1FF"), "#6C5BB1");
        assert_eq!(argb_to_hex("#39ff14ff"), "#39FF14");
        assert_eq!(argb_to_hex("bad"), "#808080");
    }

    #[test]
    fn host_validation_rejects_urls() {
        assert!(valid_host("192.168.0.46"));
        assert!(valid_host("printer.local"));
        assert!(!valid_host("http://192.168.0.46"));
        assert!(!valid_host("192.168.0.46/x"));
        assert!(!valid_host("a@b"));
        assert!(!valid_host(""));
    }
}
