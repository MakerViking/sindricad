//! Broker between an external agent (an MCP client) and the LIVE document.
//!
//! The sidecar is STATELESS: the whole document is sent with every call, and the
//! frontend owns it. So nothing outside the app can see what the user is
//! actually looking at — a process that talks straight to the sidecar can only
//! ask about a document it supplies itself. That is precisely the gap the
//! throwaway `/tmp` probe could never close, and this module is what closes it.
//!
//! ```text
//! sindri_mcp (stdio MCP)  ──AF_UNIX + token──▶  agent_ipc  ──Tauri event──▶  webview
//!                         ◀──── JSON line ────             ◀── agent_result ──
//! ```
//!
//! READ-ONLY BY CONSTRUCTION. This layer forwards a tool name and parameters and
//! returns what the frontend hands back; there is no mutation verb in the
//! protocol and no path into `DocumentStore.mutate()`. That is what collapses
//! most of the security surface — a read-only agent cannot wreck a document.
//!
//! **Why a socket and not loopback HTTP.** The Figma `127.0.0.1:3845` shape
//! produced MCP Inspector CVE-2025-49596. Origin validation does not save you:
//! under DNS rebinding the request genuinely IS same-origin. A Unix socket
//! removes the entire class, because a web page cannot open one.
//!
//! Be honest about what the token is: **filesystem-mode security**. Any process
//! running as this user can read the handshake file and drive this socket. It
//! defends against other users and against web content, not against you.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

/// How long the broker waits for the webview to answer one request.
///
/// Generous on purpose, and sized off measured work rather than a round number:
/// `massProperties` on the 356 MiB reference assembly takes 86 s, and a cold
/// `query` against it 44 s. A timeout under those turns "this is a big
/// assembly" into "the agent bridge is broken".
///
/// It exists at all because the failure it bounds is worse than a slow answer: a
/// webview that never replies (a modal dialog mid-frame, a wedged rebuild) would
/// otherwise hang the MCP client forever with no diagnosis.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// Refuse an oversized request line rather than buffer it. Nothing legitimate
/// comes close: the biggest real parameter set is a selector fingerprint.
const MAX_REQUEST_BYTES: usize = 256 * 1024;

/// The event the webview listens on, and the command it answers with.
const REQUEST_EVENT: &str = "agent://request";

#[derive(Debug, Deserialize)]
struct WireRequest {
    token: String,
    /// The CLIENT's id. Echoed back untouched so the shim can correlate; never
    /// used as a key on this side, because it is attacker-chosen and two
    /// connections may reuse the same one.
    id: Value,
    tool: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Clone, Serialize)]
struct RequestEvent {
    /// OUR id — a monotonic counter, the key into `pending`.
    seq: u64,
    tool: String,
    params: Value,
}

pub struct AgentIpc {
    token: String,
    seq: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    handshake: PathBuf,
}

impl AgentIpc {
    /// Park a slot for one in-flight request and return its key + receiver.
    fn park(&self) -> (u64, oneshot::Receiver<Value>) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        // A poisoned lock here means a previous holder panicked while holding it.
        // Recover rather than propagate: the map is a plain HashMap of senders,
        // so there is no torn invariant to protect, and panicking every
        // subsequent request would turn one bad frame into a dead bridge.
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(seq, tx);
        (seq, rx)
    }

    /// Drop a parked slot without answering it (timeout, or a dead connection).
    fn abandon(&self, seq: u64) {
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&seq);
    }
}

/// The webview's answer to one request. Called from TS via privileged Tauri IPC,
/// which is what keeps every other local process off this end of the bridge.
#[tauri::command]
pub fn agent_result(state: tauri::State<'_, AgentIpc>, seq: u64, payload: Value) {
    let tx = {
        let mut map = state.pending.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&seq)
    };
    // A missing entry is normal, not an error: the request timed out, or its
    // connection dropped, and the slot was already abandoned. Saying nothing is
    // correct — the client has long since been told.
    if let Some(tx) = tx {
        let _ = tx.send(payload);
    }
}

/// Hand one request to the webview and wait for its answer.
async fn dispatch(app: &AppHandle, tool: String, params: Value) -> Value {
    let Some(state) = app.try_state::<AgentIpc>() else {
        return err("bridgeUnavailable", "the agent bridge is not running");
    };
    let (seq, rx) = state.park();

    if app.emit(REQUEST_EVENT, RequestEvent { seq, tool, params }).is_err() {
        state.abandon(seq);
        return err("bridgeUnavailable", "the app window is not accepting requests");
    }

    match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
        Ok(Ok(v)) => v,
        // The sender was dropped without sending: the webview reloaded, or the
        // app is shutting down. Distinct from a timeout and worth saying so.
        Ok(Err(_)) => {
            state.abandon(seq);
            err("bridgeUnavailable", "the app window went away mid-request")
        }
        Err(_) => {
            state.abandon(seq);
            err(
                "timedOut",
                &format!(
                    "the app did not answer within {}s — it may be mid-rebuild on a large document",
                    REQUEST_TIMEOUT.as_secs()
                ),
            )
        }
    }
}

fn err(code: &str, message: &str) -> Value {
    json!({ "ok": false, "error": { "code": code, "message": message } })
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("OS CSPRNG unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compare two tokens without leaking their prefix length through timing.
///
/// The threat is thin (a local attacker who can already see the socket could
/// usually just read the handshake file), but a variable-time `==` on a secret
/// is the kind of thing that is free to get right and awkward to explain later.
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Where the socket and handshake file live: under app-data, which is per-user
/// and not world-writable.
///
/// NOT the system temp dir, which is world-writable — an attacker who can
/// pre-create our socket path there gets to decide what the shim connects to.
///
/// The directory itself is narrowed to 0700 so no other local user can even
/// traverse to the socket. That is the barrier that does the real work; the
/// socket's own mode is belt and braces.
fn agent_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Err(e) = restrict(&dir, 0o700) {
        // Not fatal — the token still stands — but never silent.
        eprintln!("[agent] WARNING: could not narrow {dir:?} to 0700: {e}");
    }
    Ok(dir)
}

/// Write the handshake file so it is NEVER briefly world-readable.
///
/// `create_new(true)` + `.mode(0o600)` sets the permissions in the same syscall
/// that creates the file. The pattern to avoid is in `tinkeratlas.rs`
/// (`write_account`): it writes at the umask, THEN chmods, and swallows the
/// chmod failure with `let _`. That leaves a window where the secret is
/// world-readable, and no signal at all when the narrowing fails.
#[cfg(unix)]
fn write_handshake(path: &PathBuf, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    // A leftover from a previous launch is ours to clear: the single-instance
    // plugin guarantees no other copy of the app is running.
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(body.as_bytes())
}

/// Windows has no mode bits; the equivalent guarantee comes from the file
/// living under the per-user AppData root, which is already ACL'd to this user.
///
/// `create_new` is kept for the part that DOES carry over: it refuses to write
/// through a file (or symlink) something else planted at this path.
#[cfg(windows)]
fn write_handshake(path: &PathBuf, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(body.as_bytes())
}

/// Start the broker. Best-effort: a failure here costs the agent bridge, not the
/// app.
///
/// `catch_unwind` because that sentence was once FALSE. `setup` panicked on
/// launch (a tokio bind with no reactor) and took the whole app down with it —
/// a dead window, from an optional feature. The panic itself is fixed, but the
/// guarantee is what this function advertises, so it is enforced here rather
/// than left to every future line inside `setup` being careful.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| setup(&handle)));
    match outcome {
        Ok(Ok(path)) => println!("[agent] bridge ready — handshake at {}", path.display()),
        Ok(Err(e)) => eprintln!("[agent] bridge unavailable: {e}"),
        Err(_) => eprintln!("[agent] bridge PANICKED during setup; the app continues without it"),
    }
}

#[cfg(unix)]
fn setup(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = agent_dir(app)?;
    let sock = dir.join("sock");
    let handshake = dir.join("handshake.json");
    let token = random_token();

    let body = serde_json::to_string_pretty(&json!({
        "version": 1,
        "socket": sock.to_string_lossy(),
        "token": token,
        "pid": std::process::id(),
    }))
    .map_err(|e| e.to_string())?;
    write_handshake(&handshake, &body).map_err(|e| format!("handshake {handshake:?}: {e}"))?;

    app.manage(AgentIpc {
        token,
        seq: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        handshake: handshake.clone(),
    });

    // BIND INSIDE THE RUNTIME, not here. `tauri::Builder::setup` runs before the
    // async runtime is entered on this thread, and `tokio::net::UnixListener::bind`
    // does not return an error there — it PANICS with "there is no reactor
    // running", which took the whole app down on launch while `cargo check`,
    // `cargo test` and the CI gate all stayed green. Nothing but starting the app
    // catches that.
    let app2 = app.clone();
    let hs = handshake.clone();
    tauri::async_runtime::spawn(async move {
        // A socket file always outlives the process that made it (there is no
        // unlink-on-close), and bind fails on an existing path.
        let _ = std::fs::remove_file(&sock);
        let listener = match tokio::net::UnixListener::bind(&sock) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[agent] cannot bind {sock:?}: {e} — bridge unavailable");
                // Take the handshake back down. Leaving it would advertise a
                // bridge that is not there, and the shim would report a
                // connection failure instead of "the app is not running".
                let _ = std::fs::remove_file(&hs);
                return;
            }
        };
        // The socket lands at the umask (0755 was observed), which lets any
        // local user CONNECT and spend the token check. The directory is 0700 so
        // they cannot traverse to it anyway; this narrows the socket itself as
        // well, and is checked rather than swallowed — a silent failure here is
        // the whole tinkeratlas.rs mistake in a different place.
        if let Err(e) = restrict(&sock, 0o600) {
            eprintln!("[agent] WARNING: could not narrow {sock:?}: {e} — the token is now the only barrier");
        }
        println!("[agent] bridge listening on {}", sock.display());
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app3 = app2.clone();
                    tauri::async_runtime::spawn(async move { serve(app3, stream).await });
                }
                Err(e) => {
                    eprintln!("[agent] accept failed, bridge stopping: {e}");
                    return;
                }
            }
        }
    });
    Ok(handshake)
}

/// chmod, reported rather than ignored.
#[cfg(unix)]
fn restrict(path: &std::path::Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

/// One connection: newline-delimited JSON in, newline-delimited JSON out.
///
/// Generic over the stream so the Unix socket and the Windows named pipe share
/// it. Only the transport differs between platforms; none of the protocol,
/// the auth, or the dispatch does, and duplicating this per platform is how the
/// two halves drift.
///
/// Requests on a single connection are served CONCURRENTLY rather than in
/// lockstep — each reply carries the client's own `id`, so a slow `geom.measure`
/// must not block a `build.status` behind it.
async fn serve<S>(app: AppHandle, stream: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    use tokio::io::{AsyncBufReadExt, BufReader};

    let (read_half, write_half) = tokio::io::split(stream);
    let mut lines = BufReader::new(read_half).lines();
    // Shared because concurrent replies interleave on one stream; the lock is
    // held only for the length of a single `write_all`, so a whole line is
    // never split by another task.
    let out = std::sync::Arc::new(tokio::sync::Mutex::new(write_half));

    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => return, // client hung up
            Err(e) => {
                eprintln!("[agent] read failed: {e}");
                return;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > MAX_REQUEST_BYTES {
            let _ = write_line(&out, &json!({
                "id": Value::Null, "ok": false,
                "error": { "code": "badRequest", "message": "request too large" }
            })).await;
            return; // the stream framing is no longer trustworthy
        }

        let req: WireRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let _ = write_line(&out, &json!({
                    "id": Value::Null, "ok": false,
                    "error": { "code": "badRequest", "message": format!("not a request: {e}") }
                })).await;
                continue;
            }
        };

        let authed = app
            .try_state::<AgentIpc>()
            .map(|s| token_eq(&s.token, &req.token))
            .unwrap_or(false);
        if !authed {
            // Say nothing about WHY beyond "bad token", and close. An
            // authentication failure is not a place to be helpful.
            let _ = write_line(&out, &json!({
                "id": req.id, "ok": false,
                "error": { "code": "unauthorized", "message": "bad token" }
            })).await;
            return;
        }

        let app2 = app.clone();
        let out2 = out.clone();
        tauri::async_runtime::spawn(async move {
            let mut reply = dispatch(&app2, req.tool, req.params).await;
            // The frontend answers with the body only; the envelope is ours, and
            // the client's id goes back untouched.
            if let Some(obj) = reply.as_object_mut() {
                obj.insert("id".into(), req.id);
            }
            let _ = write_line(&out2, &reply).await;
        });
    }
}

async fn write_line<W>(out: &std::sync::Arc<tokio::sync::Mutex<W>>, v: &Value) -> std::io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    let mut buf = serde_json::to_vec(v).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    buf.push(b'\n');
    let mut w = out.lock().await;
    w.write_all(&buf).await
}

// --- Windows ------------------------------------------------------------------
// Only the TRANSPORT differs. `serve` above is generic over the stream, so the
// protocol, the auth and the dispatch are literally the same code on both
// platforms rather than two implementations that drift.
#[cfg(windows)]
fn setup(app: &AppHandle) -> Result<PathBuf, String> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let dir = agent_dir(app)?;
    let handshake = dir.join("handshake.json");
    let token = random_token();
    // A per-launch name, so a stale pipe from a crashed instance can never be
    // mistaken for this one. Unlike a Unix socket there is no file to unlink:
    // a named pipe disappears with its last handle.
    let pipe = format!(r"\\.\pipe\sindricad-agent-{}-{}", std::process::id(), &token[..16]);

    let body = serde_json::to_string_pretty(&json!({
        "version": 1,
        "socket": pipe,           // same field: "the address to connect to"
        "token": token,
        "pid": std::process::id(),
    }))
    .map_err(|e| e.to_string())?;
    write_handshake(&handshake, &body).map_err(|e| format!("handshake {handshake:?}: {e}"))?;

    app.manage(AgentIpc {
        token,
        seq: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        handshake: handshake.clone(),
    });

    let app2 = app.clone();
    let hs = handshake.clone();
    tauri::async_runtime::spawn(async move {
        // `first_pipe_instance` makes creation FAIL if something already owns
        // this name, rather than quietly joining it — which is the Windows
        // shape of the squatting attack the Unix side avoids by not using
        // world-writable /tmp.
        let mut server = match ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(&pipe)
        {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[agent] cannot create {pipe}: {e} — bridge unavailable");
                let _ = std::fs::remove_file(&hs);
                return;
            }
        };
        println!("[agent] bridge listening on {pipe}");
        loop {
            if let Err(e) = server.connect().await {
                eprintln!("[agent] accept failed, bridge stopping: {e}");
                return;
            }
            // The connected instance becomes this client's stream, so the NEXT
            // instance has to be created before serving it — otherwise the
            // pipe name has no listener and the next client is refused. This is
            // the shape that differs from an accept() loop, and getting it
            // wrong means only one client ever connects.
            let connected = server;
            server = match ServerOptions::new().reject_remote_clients(true).create(&pipe) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[agent] cannot re-arm {pipe}: {e} — bridge stopping");
                    let app3 = app2.clone();
                    tauri::async_runtime::spawn(async move { serve(app3, connected).await });
                    return;
                }
            };
            let app3 = app2.clone();
            tauri::async_runtime::spawn(async move { serve(app3, connected).await });
        }
    });
    Ok(handshake)
}

// Neither Unix nor Windows: nothing to do, and the app runs exactly as before.
#[cfg(not(any(unix, windows)))]
fn setup(_app: &AppHandle) -> Result<PathBuf, String> {
    Err("the agent bridge has no transport on this platform".into())
}

/// Remove the handshake file on exit. The socket goes too — a stale one would
/// make the next launch's shim connect to nothing.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AgentIpc>() {
        let _ = std::fs::remove_file(&state.handshake);
        if let Some(dir) = state.handshake.parent() {
            let _ = std::fs::remove_file(dir.join("sock"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_eq_matches_only_identical_tokens() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "ab")); // length differs
        assert!(!token_eq("", "a"));
        assert!(token_eq("", ""));
    }

    #[test]
    fn a_token_is_long_and_not_repeated() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 64, "32 bytes hex-encoded");
        assert_ne!(a, b, "two launches must not share a token");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// The property the whole handshake rests on: the secret is never briefly
    /// world-readable. Asserted on the real filesystem, because the bug this
    /// prevents is a permissions window, not a code shape.
    #[cfg(unix)]
    #[test]
    fn the_handshake_file_is_never_group_or_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("sindri-agent-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("handshake.json");

        write_handshake(&path, "{\"token\":\"secret\"}").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "handshake must be owner-only, got {mode:o}");

        // ...and writing over a leftover from a previous launch still lands at
        // 0600 rather than inheriting the old file's mode.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_handshake(&path, "{\"token\":\"secret2\"}").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a stale world-readable file must not survive, got {mode:o}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
