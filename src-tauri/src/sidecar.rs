//! Spawn, supervise, and reliably kill the Python geometry sidecar.
//!
//! In a packaged app the interpreter + deps ship as a bundled resource
//! (`sidecar-runtime/`, built by `scripts/build-sidecar-runtime.sh`) resolved via
//! Tauri's resource dir. In dev we fall back to the uv `.venv` next to the source.
//! The child never orphans: it runs in its own process group (Unix) or a Job Object
//! with KILL_ON_JOB_CLOSE (Windows), and the Python side ALSO dies with the parent
//! (PR_SET_PDEATHSIG on Linux, a getppid watchdog on macOS; see server.py).
//!
//! NOTE: the Windows Job Object path is `#[cfg(windows)]` and can only be
//! compile-verified on a Windows target / in CI.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Handle to the running sidecar, stored in Tauri managed state. Carries the
/// per-launch WebSocket auth token so the frontend can fetch it via the
/// `sidecar_token` command and dial the sidecar with `?token=…`.
pub struct Sidecar {
    pub child: Arc<Mutex<Option<Child>>>,
    pub token: String,
    /// Windows Job Object owning the child tree; closing it (kill/Drop) reaps the
    /// sidecar AND its ProcessPoolExecutor workers.
    #[cfg(windows)]
    job: Mutex<Option<windows::Win32::Foundation::HANDLE>>,
}

// The raw job HANDLE is only touched under the Mutex during the spawn/kill lifecycle.
#[cfg(windows)]
unsafe impl Send for Sidecar {}
#[cfg(windows)]
unsafe impl Sync for Sidecar {}

/// 256-bit shared secret for the sidecar WebSocket, from the OS CSPRNG (portable:
/// Windows/macOS/Linux). A failure here is treated as fatal rather than falling back
/// to a guessable token.
fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("OS CSPRNG unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Where the interpreter, entry script, working dir, and (bundled only) the
/// site-packages to put on PYTHONPATH live.
#[cfg_attr(test, derive(Debug))]
struct Runtime {
    python: PathBuf,
    script: PathBuf,
    cwd: PathBuf,
    pythonpath: Option<PathBuf>,
}

// interpreter path within the bundled `sidecar-runtime/python/`
#[cfg(windows)]
const BUNDLED_PY: &str = "python.exe";
#[cfg(not(windows))]
const BUNDLED_PY: &str = "bin/python3.12";
// interpreter path within the dev uv `.venv`
#[cfg(windows)]
const VENV_PY: &str = "Scripts/python.exe";
#[cfg(not(windows))]
const VENV_PY: &str = "bin/python";

/// Pure fallback chain (bundled resource -> dev venv -> error), taking plain paths
/// so it's unit-testable without an `AppHandle`. `resource_dir` mirrors
/// `app.path().resource_dir().ok()`; `manifest_dir` mirrors `CARGO_MANIFEST_DIR`.
/// The old silent bare-`python`-on-PATH fallback is gone: it produced broken
/// bundles on clean machines.
fn pick_runtime(resource_dir: Option<PathBuf>, manifest_dir: &Path) -> std::io::Result<Runtime> {
    if let Some(res) = resource_dir {
        let base = res.join("sidecar-runtime");
        let python = base.join("python").join(BUNDLED_PY);
        if python.exists() {
            return Ok(Runtime {
                python,
                script: base.join("app").join("server.py"),
                cwd: base.join("app"),
                pythonpath: Some(base.join("site-packages")),
            });
        }
    }
    // dev layout: project root = parent of this crate's manifest dir
    let sidecar_dir = manifest_dir
        .parent()
        .map(|p| p.join("sidecar"))
        .unwrap_or_else(|| PathBuf::from("sidecar"));
    let venv_python = sidecar_dir.join(".venv").join(VENV_PY);
    if venv_python.exists() {
        return Ok(Runtime {
            python: venv_python,
            script: PathBuf::from("server.py"),
            cwd: sidecar_dir,
            pythonpath: None,
        });
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no Python sidecar runtime found (neither the bundled resource nor a dev .venv)",
    ))
}

fn resolve_runtime(app: &AppHandle) -> std::io::Result<Runtime> {
    let resource_dir = app.path().resource_dir().ok();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    pick_runtime(resource_dir, &manifest_dir)
}

/// Poll the child every ~2s so a sidecar death is noticed instead of silently
/// leaving the frontend spinning against a closed socket. `kill()` takes the
/// `Child` out of the `Mutex` before terminating it, so an empty slot here means
/// an intentional shutdown (Drop/exit) — not a crash — and the loop just stops.
/// Auto-respawn is deliberately NOT implemented: the token/CSP contract (a fresh
/// per-launch `SINDRI_SIDECAR_TOKEN` the frontend must re-fetch and re-dial with)
/// makes a live respawn non-trivial; revisit once the frontend can rotate tokens
/// without a full reload.
fn spawn_supervisor(app: AppHandle, child: Arc<Mutex<Option<Child>>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let died = match child.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => Some(status),
                    Ok(None) => None, // still running
                    Err(e) => {
                        eprintln!("[sidecar] supervisor: try_wait failed: {e}");
                        None
                    }
                },
                None => break, // kill() already took it — intentional shutdown
            },
            Err(_) => break, // Mutex poisoned; nothing productive left to do
        };
        if let Some(status) = died {
            eprintln!("[sidecar] CRASHED: exited unexpectedly ({status})");
            let _ = app.emit("sidecar:died", status.code());
            break;
        }
    });
}

impl Sidecar {
    pub fn spawn(app: &AppHandle) -> std::io::Result<Self> {
        let token = random_token();
        let rt = resolve_runtime(app)?;

        let mut cmd = Command::new(&rt.python);
        cmd.arg(&rt.script)
            .env("SINDRI_SIDECAR_TOKEN", &token) // hand the secret to the sidecar
            .env("PYTHONDONTWRITEBYTECODE", "1") // read-only bundle: never write .pyc
            .current_dir(&rt.cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(pp) = &rt.pythonpath {
            cmd.env("PYTHONPATH", pp); // bundled site-packages (dir install, no venv)
        }

        // own process group so we can SIGTERM the whole tree at once (Unix)
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn()?;

        // Windows: put the child (and its future pool workers) in a kill-on-close job.
        #[cfg(windows)]
        let job = assign_kill_job(&child);

        // Readiness: the sidecar prints `LISTENING <port>` once the WS is bound. Flip a
        // flag on that line, and warn loudly if it never comes (a broken bundled
        // runtime otherwise shows only as the frontend's endless reconnect).
        let ready = Arc::new(AtomicBool::new(false));
        if let Some(out) = child.stdout.take() {
            let ready = ready.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if line.contains("LISTENING") {
                        ready.store(true, Ordering::SeqCst);
                    }
                    println!("[sidecar] {line}");
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    eprintln!("[sidecar:err] {line}");
                }
            });
        }
        {
            let ready = ready.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(20));
                if !ready.load(Ordering::SeqCst) {
                    eprintln!(
                        "[sidecar] WARNING: no LISTENING after 20s — the geometry engine \
                         may have failed to start (check [sidecar:err] above)"
                    );
                }
            });
        }

        println!("[sidecar] spawned pid {}", child.id());
        let child = Arc::new(Mutex::new(Some(child)));
        spawn_supervisor(app.clone(), child.clone());
        Ok(Sidecar {
            child,
            token,
            #[cfg(windows)]
            job: Mutex::new(job),
        })
    }

    /// Kill the sidecar and its whole process tree.
    pub fn kill(&self) {
        #[cfg(windows)]
        if let Ok(mut jg) = self.job.lock() {
            if let Some(job) = jg.take() {
                // KILL_ON_JOB_CLOSE: closing the handle terminates the child tree.
                unsafe {
                    let _ = windows::Win32::Foundation::CloseHandle(job);
                }
            }
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let pid = child.id();
                #[cfg(unix)]
                unsafe {
                    // negative pid => signal the entire process group
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
                let _ = child.kill(); // direct child as a fallback
                let _ = child.wait();
                println!("[sidecar] killed pid {pid}");
            }
        }
    }
}

/// Create a Job Object with KILL_ON_JOB_CLOSE and assign the freshly-spawned child to
/// it, so the sidecar and its multiprocessing workers die with the app. Returns None
/// on failure (the direct `child.kill()` fallback still applies).
///
/// Known limitation: the child is assigned right after spawn rather than created
/// suspended, so a pool worker spawned in the first instants could in theory escape.
/// In practice the sidecar imports for ~1s before spawning any worker, so the window
/// is not hit; CREATE_SUSPENDED hardening is a follow-up to verify in CI.
#[cfg(windows)]
fn assign_kill_job(child: &Child) -> Option<windows::Win32::Foundation::HANDLE> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .ok()?;
        let proc = HANDLE(child.as_raw_handle() as _);
        AssignProcessToJobObject(job, proc).ok()?;
        Some(job)
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh, empty scratch dir under the OS temp dir, wiped on both entry and Drop
    /// so repeated runs (and a prior crashed run) never see stale fixture files.
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("sindricad-test-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create tmp fixture dir");
            TmpDir(dir)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create fixture parent dir");
        }
        std::fs::write(path, b"").expect("write fixture file");
    }

    #[test]
    fn pick_runtime_prefers_bundled_resource_when_present() {
        let tmp = TmpDir::new("bundled");
        let resource_dir = tmp.0.join("resource");
        touch(&resource_dir.join("sidecar-runtime").join("python").join(BUNDLED_PY));
        // manifest_dir is irrelevant once the bundled runtime is found — point it
        // somewhere that doesn't even exist to prove it's never consulted.
        let manifest_dir = tmp.0.join("does-not-exist");

        let rt = pick_runtime(Some(resource_dir.clone()), &manifest_dir).expect("bundled runtime resolves");
        assert_eq!(rt.python, resource_dir.join("sidecar-runtime").join("python").join(BUNDLED_PY));
        assert_eq!(rt.script, resource_dir.join("sidecar-runtime").join("app").join("server.py"));
        assert_eq!(rt.cwd, resource_dir.join("sidecar-runtime").join("app"));
        assert_eq!(rt.pythonpath, Some(resource_dir.join("sidecar-runtime").join("site-packages")));
    }

    #[test]
    fn pick_runtime_falls_back_to_dev_venv_when_no_bundle() {
        let tmp = TmpDir::new("venv");
        let manifest_dir = tmp.0.join("src-tauri"); // parent (tmp.0) is the "project root"
        std::fs::create_dir_all(&manifest_dir).expect("create manifest dir");
        let sidecar_dir = tmp.0.join("sidecar");
        touch(&sidecar_dir.join(".venv").join(VENV_PY));

        // No resource dir (dev run) and no bundled runtime under it either.
        let rt = pick_runtime(None, &manifest_dir).expect("dev venv resolves");
        assert_eq!(rt.python, sidecar_dir.join(".venv").join(VENV_PY));
        assert_eq!(rt.script, PathBuf::from("server.py"));
        assert_eq!(rt.cwd, sidecar_dir);
        assert_eq!(rt.pythonpath, None);
    }

    #[test]
    fn pick_runtime_errors_when_neither_runtime_exists() {
        let tmp = TmpDir::new("neither");
        let manifest_dir = tmp.0.join("src-tauri");
        std::fs::create_dir_all(&manifest_dir).expect("create manifest dir");
        // deliberately: no sidecar-runtime under any resource dir, no sidecar/.venv

        let err = pick_runtime(None, &manifest_dir).expect_err("neither runtime present");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }
}
