//! Slicer handoff — Stage D.v1: write the exported project into a staging dir and
//! open it in the user's OrcaSlicer (GUI), where their U1 preset + print host are
//! already configured so they can Slice → Upload & Print. The AppImage path is
//! Rust-owned app settings, not a webview-supplied argument, so the webview can
//! never spawn an arbitrary binary.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    /// path to the OrcaSlicer binary/AppImage used to open exported projects.
    pub slicer_path: String,
    /// the user's Orca datadir (their presets) — used by the future CLI path.
    pub orca_datadir: String,
}

fn default_settings(app: &AppHandle) -> AppSettings {
    let home = app.path().home_dir().ok();
    let join = |rel: &str| home.as_ref().map(|h| h.join(rel).to_string_lossy().into_owned()).unwrap_or_default();
    AppSettings {
        slicer_path: join("Applications/OrcaSlicer_V2.4.0-alpha.AppImage"),
        orca_datadir: join(".config/OrcaSlicer"),
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default_settings(&app)),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn settings_set(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Return a staging path `app_data_dir()/print/<name>.3mf` for the sidecar to
/// write the export into (the sidecar takes any path). Name is sanitized like a
/// recovery slot so the webview can't escape the dir.
#[tauri::command]
pub fn print_staging_path(app: AppHandle, name: String, ext: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("print");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    let stem = if safe.is_empty() { "part".to_string() } else { safe };
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let ext = if ext.is_empty() { "3mf".into() } else { ext };
    Ok(dir.join(format!("{stem}.{ext}")).to_string_lossy().into_owned())
}

/// Open a project file in OrcaSlicer's GUI. Detached spawn — we don't wait.
#[tauri::command]
pub fn slicer_open(app: AppHandle, path: String) -> Result<(), String> {
    let slicer = settings_get(app.clone())?.slicer_path;
    if slicer.is_empty() {
        return Err("no slicer configured — set the OrcaSlicer path in settings".into());
    }
    let bin = PathBuf::from(&slicer);
    if !bin.is_file() {
        return Err(format!("slicer not found at {slicer}"));
    }
    if PathBuf::from(&path).extension().and_then(|e| e.to_str()) != Some("3mf") {
        return Err("expected a .3mf project".into());
    }
    std::process::Command::new(&bin)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch OrcaSlicer: {e}"))
}

// --- Orca preset flattening (so a handoff project selects the user's U1 preset) -
//
// A minimal `printer_model` stub is NOT enough for OrcaSlicer to bind a machine
// preset on "open as project" — it falls back to "-" (no printer, no print host).
// So we flatten the user's ACTIVE machine preset (resolving its `inherits` chain
// the same way Orca does) plus a compatible process/filament, and embed that in
// Metadata/project_settings.config. Orca then selects the U1 (with its print_host
// 192.168.0.46), and the palette still owns the colors.

/// preset fields that are per-file metadata, not effective config — dropped after
/// the inherits chain is merged (mirrors the Orca preset model).
const META_KEYS: &[&str] = &[
    "inherits", "from", "name", "setting_id", "filament_id", "renamed_from",
    "is_custom_defined", "version", "upward_compatible_machine", "instantiation",
];

/// name → path for every preset of a kind. System first, then user/default so a
/// user preset shadows a same-named system one.
fn index_presets(datadir: &Path, kind: &str) -> HashMap<String, PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let sysroot = datadir.join("system");
    if let Ok(vendors) = std::fs::read_dir(&sysroot) {
        for v in vendors.flatten() {
            let kd = v.path().join(kind);
            if kd.is_dir() {
                dirs.push(kd.clone());
                if let Ok(subs) = std::fs::read_dir(&kd) {
                    for s in subs.flatten() {
                        if s.path().is_dir() {
                            dirs.push(s.path()); // one level of vendor subdirs (e.g. Polymaker)
                        }
                    }
                }
            }
        }
    }
    dirs.push(datadir.join("user/default").join(kind)); // user last → wins

    let mut idx = HashMap::new();
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let name = std::fs::read_to_string(&p)
                    .ok()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string));
                if let Some(n) = name {
                    idx.insert(n, p);
                }
            }
        }
    }
    idx
}

/// Flatten one preset by walking its `inherits` chain (root first, child overrides
/// parent). Returns the merged config and the set of names in the chain.
fn resolve_chain(
    idx: &HashMap<String, PathBuf>,
    name: &str,
) -> Result<(serde_json::Map<String, serde_json::Value>, HashSet<String>), String> {
    let mut chain: Vec<serde_json::Value> = Vec::new();
    let mut names = HashSet::new();
    let mut cur = Some(name.to_string());
    while let Some(n) = cur {
        if !names.insert(n.clone()) {
            break; // cycle guard
        }
        let path = idx.get(&n).ok_or_else(|| format!("preset not found: {n}"))?;
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(path).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        cur = v.get("inherits").and_then(|i| i.as_str()).map(str::to_string);
        chain.push(v);
    }
    let mut out = serde_json::Map::new();
    for v in chain.into_iter().rev() {
        if let Some(o) = v.as_object() {
            for (k, val) in o {
                out.insert(k.clone(), val.clone());
            }
        }
    }
    for k in META_KEYS {
        out.remove(*k);
    }
    Ok((out, names))
}

/// True if a preset (of the same kind as `idx`) is compatible with the machine.
/// Resolves the candidate's inherits chain first, so a sparse user override
/// inherits `compatible_printers` from its system parent.
fn is_compatible(idx: &HashMap<String, PathBuf>, name: &str, chain: &HashSet<String>) -> bool {
    resolve_chain(idx, name)
        .ok()
        .and_then(|(cfg, _)| cfg.get("compatible_printers").and_then(|c| c.as_array()).cloned())
        .map(|cp| cp.iter().filter_map(|x| x.as_str()).any(|s| chain.contains(s)))
        .unwrap_or(false)
}

/// Best preset of a kind for the machine: compatible with it, preferring the
/// user's own presets, then a name hint (e.g. "0.20"), then alphabetical.
fn pick_preset(idx: &HashMap<String, PathBuf>, chain: &HashSet<String>, hints: &[&str]) -> Option<String> {
    let mut user: Vec<String> = Vec::new();
    let mut sys: Vec<String> = Vec::new();
    for (name, path) in idx {
        if is_compatible(idx, name, chain) {
            if path.to_string_lossy().contains("/user/") {
                user.push(name.clone());
            } else {
                sys.push(name.clone());
            }
        }
    }
    for mut pool in [user, sys] {
        pool.sort();
        if let Some(h) = pool.iter().find(|n| hints.iter().all(|x| n.contains(x))).cloned() {
            return Some(h);
        }
        if let Some(f) = pool.first().cloned() {
            return Some(f);
        }
    }
    None
}

/// Build the project_settings config for a handoff: the user's ACTIVE machine
/// preset PLUS a compatible process and filament (preferring the user's own
/// tuned presets), all flattened. Embedding all three is what makes OrcaSlicer
/// bind real named presets on "open as project" (a machine-only config makes it
/// invent blank project-custom process/filament named after the file). The
/// palette owns `filament_colour`, so it is stripped here.
#[tauri::command]
pub fn slicer_project_settings(app: AppHandle, filament_count: usize) -> Result<serde_json::Value, String> {
    let datadir = PathBuf::from(settings_get(app.clone())?.orca_datadir);
    if !datadir.is_dir() {
        return Err(format!("Orca datadir not found: {}", datadir.display()));
    }
    let conf: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(datadir.join("OrcaSlicer.conf")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let machine = conf
        .get("presets")
        .and_then(|p| p.get("machine"))
        .and_then(|m| m.as_str())
        .ok_or("no active machine preset in OrcaSlicer.conf")?
        .to_string();

    let m_idx = index_presets(&datadir, "machine");
    let (mut cfg, chain) = resolve_chain(&m_idx, &machine)?;

    // process (prefer a 0.2mm profile) — merged over machine keys, brings real
    // line widths/speeds so Orca doesn't show a blank project process.
    let p_idx = index_presets(&datadir, "process");
    if let Some(proc_name) = pick_preset(&p_idx, &chain, &["0.20"]) {
        if let Ok((pcfg, _)) = resolve_chain(&p_idx, &proc_name) {
            for (k, v) in pcfg {
                cfg.insert(k, v);
            }
            cfg.insert("print_settings_id".into(), serde_json::Value::String(proc_name));
        }
    }
    // filament → per-slot arrays (one entry per toolhead / palette slot).
    let n = filament_count.max(1);
    let f_idx = index_presets(&datadir, "filament");
    if let Some(fil_name) = pick_preset(&f_idx, &chain, &["PLA"]) {
        if let Ok((fcfg, _)) = resolve_chain(&f_idx, &fil_name) {
            for (k, v) in fcfg {
                let one = match &v {
                    serde_json::Value::Array(a) if !a.is_empty() => a[0].clone(),
                    _ => v.clone(),
                };
                cfg.insert(k, serde_json::Value::Array(vec![one; n]));
            }
            cfg.insert(
                "filament_settings_id".into(),
                serde_json::Value::Array(vec![serde_json::Value::String(fil_name); n]),
            );
        }
    }

    if !cfg.contains_key("printer_settings_id") {
        cfg.insert("printer_settings_id".into(), serde_json::Value::String(machine));
    }
    cfg.remove("filament_colour"); // palette owns the colors
    cfg.remove("compatible_printers"); // not meaningful in a project config
    Ok(serde_json::Value::Object(cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Integration check against the user's real Orca datadir (skips cleanly on a
    // machine without it). Confirms the flatten binds the U1: printer_model set
    // and the print_host present so "Upload & Print" knows where to send.
    #[test]
    fn flatten_binds_u1_from_real_datadir() {
        let dd = match dirs_home() {
            Some(h) => h.join(".config/OrcaSlicer"),
            None => return,
        };
        if !dd.join("OrcaSlicer.conf").is_file() {
            return; // not this machine — skip
        }
        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dd.join("OrcaSlicer.conf")).unwrap()).unwrap();
        let machine = conf["presets"]["machine"].as_str().unwrap().to_string();
        let m_idx = index_presets(&dd, "machine");
        let (cfg, chain) = resolve_chain(&m_idx, &machine).unwrap();
        assert_eq!(cfg.get("printer_model").and_then(|v| v.as_str()), Some("Snapmaker U1"));
        assert!(cfg.get("print_host").and_then(|v| v.as_str()).is_some(), "print_host must survive the flatten");
        assert!(!cfg.contains_key("inherits"), "meta keys must be stripped");

        // the picker must bind a REAL, compatible process + filament (not blanks),
        // preferring the user's own tuned presets, with real line widths.
        let proc = pick_preset(&index_presets(&dd, "process"), &chain, &["0.20"]).expect("a process");
        assert!(proc.contains("Snapmaker U1"), "process should target the U1: {proc}");
        let (pcfg, _) = resolve_chain(&index_presets(&dd, "process"), &proc).unwrap();
        assert!(
            pcfg.get("line_width").and_then(|v| v.as_str()).map(|s| s != "0").unwrap_or(false),
            "process must carry a real line width, got {:?}",
            pcfg.get("line_width"),
        );
        let fil = pick_preset(&index_presets(&dd, "filament"), &chain, &["PLA"]).expect("a filament");
        eprintln!("picked process={proc:?} filament={fil:?}");
    }

    fn dirs_home() -> Option<PathBuf> {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}
