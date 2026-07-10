//! TinkerAtlas account + publish layer — all tinkeratlas.com HTTP happens HERE,
//! on the native side. The webview never talks to tinkeratlas.com (its CSP
//! connect-src is localhost-only, by design); it calls these commands and Rust
//! owns the network, the desktop token, and the identity cache — the same
//! privilege split printer.rs uses for LAN Moonraker access.
//!
//! The desktop token (`ta_scad_…`, minted on tinkeratlas.com/sindricad/connect)
//! is stored with the cached identity in `app_data_dir()/tinkeratlas.json`,
//! written atomically (tmp + rename) and chmod 600 on unix. Signed-out is the
//! normal state: every command except `ta_publish` works without an account.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Compile-time override for staging/local testing:
/// `SINDRICAD_TA_BASE=http://localhost:3000 cargo tauri dev`.
const BASE: &str = match option_env!("SINDRICAD_TA_BASE") {
    Some(s) => s,
    None => "https://tinkeratlas.com",
};

// --- error taxonomy (mapped to toasts on the frontend) ------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaErrCode {
    Unreachable,
    Unauthorized,
    Rejected,
    Protocol,
    Config,
}

#[derive(Serialize, Clone, Debug)]
pub struct TaError {
    pub code: TaErrCode,
    pub message: String,
}

impl TaError {
    fn new(code: TaErrCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

type TResult<T> = Result<T, TaError>;

// --- account store -------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TaUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Account {
    token: String,
    user: TaUser,
}

fn account_path(app: &AppHandle) -> TResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    Ok(dir.join("tinkeratlas.json"))
}

fn read_account(app: &AppHandle) -> TResult<Option<Account>> {
    let path = account_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| TaError::new(TaErrCode::Config, format!("tinkeratlas.json: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(TaError::new(TaErrCode::Config, e.to_string())),
    }
}

fn write_account(app: &AppHandle, account: &Account) -> TResult<()> {
    let path = account_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(account)
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    std::fs::write(&tmp, json).map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))
}

// --- helpers --------------------------------------------------------------------

fn http(timeout: Duration) -> TResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))
}

fn unreachable(e: reqwest::Error) -> TaError {
    TaError::new(TaErrCode::Unreachable, e.to_string())
}

/// A pasted token must be a single printable ASCII word (the real ones are
/// `ta_scad_` + hex). Trims whitespace; rejects anything with spaces or
/// control chars so a garbled paste fails here, not as a confusing 401.
fn sanitize_token(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 200 {
        return None;
    }
    if !t.chars().all(|c| c.is_ascii_graphic()) {
        return None;
    }
    Some(t.to_string())
}

/// URLs we return to the webview (and later hand to the system browser) must
/// point back at the TinkerAtlas base — never anywhere a compromised response
/// could redirect the user.
fn valid_ta_url(url: &str) -> bool {
    url.starts_with(&format!("{BASE}/")) || url == BASE
}

// --- commands --------------------------------------------------------------------

/// Cached identity from disk — NO network, so startup stays offline-safe.
#[tauri::command]
pub fn ta_account(app: AppHandle) -> TResult<Option<TaUser>> {
    Ok(read_account(&app)?.map(|a| a.user))
}

/// Validate a pasted desktop token against /api/desktop/me and persist it.
#[tauri::command]
pub async fn ta_sign_in(app: AppHandle, token: String) -> TResult<TaUser> {
    let token = sanitize_token(&token)
        .ok_or_else(|| TaError::new(TaErrCode::Unauthorized, "that doesn't look like a token"))?;
    let client = http(Duration::from_secs(10))?;
    let resp = client
        .get(format!("{BASE}/api/desktop/me"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(unreachable)?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(TaError::new(TaErrCode::Unauthorized, "token was not accepted"));
    }
    if !status.is_success() {
        let msg = resp.text().await.unwrap_or_default();
        return Err(TaError::new(TaErrCode::Rejected, format!("{status}: {msg}")));
    }
    #[derive(Deserialize)]
    struct MeResponse {
        user: TaUser,
    }
    let me: MeResponse = resp
        .json()
        .await
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
    write_account(&app, &Account { token, user: me.user.clone() })?;
    Ok(me.user)
}

/// Forget the stored token + identity. Missing file is fine (already signed out).
#[tauri::command]
pub fn ta_sign_out(app: AppHandle) -> TResult<()> {
    let path = account_path(&app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(TaError::new(TaErrCode::Config, e.to_string())),
    }
}

/// Is tinkeratlas.com reachable? Drives the welcome screen's iframe-vs-fallback
/// decision (a cross-origin iframe never reports its own load failure).
#[tauri::command]
pub async fn ta_ping() -> bool {
    let Ok(client) = http(Duration::from_secs(3)) else { return false };
    match client.get(format!("{BASE}/sindricad/welcome")).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Staging path `app_data_dir()/publish/<name>.<ext>` for the sidecar to write
/// the export into. Same sanitization as slicer.rs `print_staging_path`; the
/// separate dir is what `ta_publish` enforces containment against.
#[tauri::command]
pub fn ta_staging_path(app: AppHandle, name: String, ext: String) -> TResult<String> {
    let dir = publish_dir(&app)?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    let stem = if safe.is_empty() { "design".to_string() } else { safe };
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let ext = if ext.is_empty() { "3mf".into() } else { ext };
    Ok(dir.join(format!("{stem}.{ext}")).to_string_lossy().into_owned())
}

fn publish_dir(app: &AppHandle) -> TResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?
        .join("publish");
    std::fs::create_dir_all(&dir).map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    Ok(dir)
}

fn model_mime(ext: &str) -> &'static str {
    match ext {
        "3mf" => "model/3mf",
        "stl" => "model/stl",
        "step" | "stp" => "application/step",
        _ => "application/octet-stream",
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct TaPublishResult {
    pub url: String,
}

#[derive(Serialize, Clone)]
struct PublishProgress {
    stage: &'static str,
}

/// Upload a staged export + cover screenshot as a 3D model on TinkerAtlas.
/// `model_path` must be a file `ta_staging_path` produced — enforced by
/// canonicalized containment in the publish dir, so even a compromised webview
/// can't use this command to exfiltrate arbitrary files.
#[tauri::command]
pub async fn ta_publish(
    app: AppHandle,
    title: String,
    description: String,
    publish: bool,
    model_path: String,
    cover_png_base64: String,
) -> TResult<TaPublishResult> {
    let account = read_account(&app)?
        .ok_or_else(|| TaError::new(TaErrCode::Unauthorized, "not signed in to TinkerAtlas"))?;

    let title = title.trim().to_string();
    if title.len() < 3 || title.len() > 200 {
        // mirrors the models_3d CHECK constraint on the server
        return Err(TaError::new(TaErrCode::Config, "title must be 3–200 characters"));
    }

    let dir = publish_dir(&app)?
        .canonicalize()
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    let path = Path::new(&model_path)
        .canonicalize()
        .map_err(|e| TaError::new(TaErrCode::Config, format!("staged model: {e}")))?;
    if !path.starts_with(&dir) {
        return Err(TaError::new(TaErrCode::Config, "model path is outside the staging dir"));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("design.3mf")
        .to_string();

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;

    let _ = app.emit("ta:publish", PublishProgress { stage: "uploading" });

    let model_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(model_mime(&ext))
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
    let mut form = reqwest::multipart::Form::new()
        .text("title", title)
        .text("description", description)
        .text("publish", if publish { "true" } else { "false" })
        .part("model", model_part);

    if !cover_png_base64.is_empty() {
        use base64::Engine;
        let cover = base64::engine::general_purpose::STANDARD
            .decode(cover_png_base64.as_bytes())
            .map_err(|e| TaError::new(TaErrCode::Config, format!("cover image: {e}")))?;
        let cover_part = reqwest::multipart::Part::bytes(cover)
            .file_name("cover.png")
            .mime_str("image/png")
            .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
        form = form.part("cover", cover_part);
    }

    // uploads can be tens of MB — give them a generous timeout of their own.
    let client = http(Duration::from_secs(180))?;
    let resp = client
        .post(format!("{BASE}/api/desktop/publish"))
        .bearer_auth(&account.token)
        .multipart(form)
        .send()
        .await
        .map_err(unreachable)?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // token was revoked server-side; keep the file so the UI can offer re-sign-in.
        return Err(TaError::new(TaErrCode::Unauthorized, "sign-in expired or was revoked"));
    }
    if !status.is_success() {
        let msg = resp.text().await.unwrap_or_default();
        return Err(TaError::new(TaErrCode::Rejected, format!("{status}: {msg}")));
    }

    #[derive(Deserialize)]
    struct PublishResponse {
        url: String,
    }
    let out: PublishResponse = resp
        .json()
        .await
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
    if !valid_ta_url(&out.url) {
        return Err(TaError::new(TaErrCode::Protocol, "unexpected result URL"));
    }

    let _ = app.emit("ta:publish", PublishProgress { stage: "done" });
    Ok(TaPublishResult { url: out.url })
}

/// Fetch the signed-in user's avatar and return it as a data: URL. The webview's
/// CSP img-src deliberately excludes tinkeratlas.com, but allows data: — so the
/// image rides through here instead of loosening the CSP.
#[tauri::command]
pub async fn ta_avatar(app: AppHandle) -> TResult<Option<String>> {
    let Some(account) = read_account(&app)? else { return Ok(None) };
    let url = account.user.avatar_url;
    if url.is_empty() {
        return Ok(None);
    }
    if !avatar_url_allowed(&url) {
        return Ok(None);
    }
    let client = http(Duration::from_secs(10))?;
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None), // avatar is decorative — never fail the caller over it
    };
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .to_string();
    if !mime.starts_with("image/") {
        return Ok(None);
    }
    let bytes = match resp.bytes().await {
        Ok(b) if b.len() <= 1_000_000 => b,
        _ => return Ok(None),
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

/// Avatars live on tinkeratlas.com or its storage subdomains (api.tinkeratlas.com).
/// The URL comes from the (trusted) server response we persisted, but keeping the
/// fetch pinned to the platform's hosts costs nothing and closes an SSRF channel
/// if the stored file is ever tampered with.
fn avatar_url_allowed(url: &str) -> bool {
    if url.starts_with(&format!("{BASE}/")) {
        return true;
    }
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    parsed.scheme() == "https"
        && parsed
            .host_str()
            .map(|h| h == "tinkeratlas.com" || h.ends_with(".tinkeratlas.com"))
            .unwrap_or(false)
}

// --- tests -----------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_sanitization() {
        assert_eq!(sanitize_token("  ta_scad_abc123  ").as_deref(), Some("ta_scad_abc123"));
        assert_eq!(sanitize_token(""), None);
        assert_eq!(sanitize_token("   "), None);
        assert_eq!(sanitize_token("two words"), None);
        assert_eq!(sanitize_token("tab\there"), None);
        assert_eq!(sanitize_token("ctrl\u{7}char"), None);
        assert_eq!(sanitize_token(&"x".repeat(201)), None);
    }

    #[test]
    fn ta_url_validation() {
        assert!(valid_ta_url(&format!("{BASE}/profile?tab=3d-models")));
        assert!(valid_ta_url(BASE));
        assert!(!valid_ta_url("https://evil.example/phish"));
        assert!(!valid_ta_url("https://tinkeratlas.com.evil.example/"));
    }

    #[test]
    fn avatar_hosts() {
        assert!(avatar_url_allowed("https://tinkeratlas.com/a.png"));
        assert!(avatar_url_allowed("https://api.tinkeratlas.com/storage/v1/a.png"));
        assert!(!avatar_url_allowed("https://nottinkeratlas.com/a.png"));
        assert!(!avatar_url_allowed("http://api.tinkeratlas.com/a.png"));
        assert!(!avatar_url_allowed("file:///etc/passwd"));
    }

    #[test]
    fn model_mimes() {
        assert_eq!(model_mime("3mf"), "model/3mf");
        assert_eq!(model_mime("stl"), "model/stl");
        assert_eq!(model_mime("step"), "application/step");
        assert_eq!(model_mime("weird"), "application/octet-stream");
    }
}
