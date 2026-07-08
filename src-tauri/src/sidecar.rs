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
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Handle to the running sidecar, stored in Tauri managed state. Carries the
/// per-launch WebSocket auth token so the frontend can fetch it via the
/// `sidecar_token` command and dial the sidecar with `?token=…`.
pub struct Sidecar {
    pub child: Mutex<Option<Child>>,
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

/// Prefer the bundled runtime (shipped app); fall back to the dev `.venv`; otherwise
/// a clear error. The old silent bare-`python`-on-PATH fallback is gone: it produced
/// broken bundles on clean machines.
fn resolve_runtime(app: &AppHandle) -> std::io::Result<Runtime> {
    if let Ok(res) = app.path().resource_dir() {
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
    let sidecar_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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
        Ok(Sidecar {
            child: Mutex::new(Some(child)),
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
        let job = CreateJobObjectW(None, None).ok()?;
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
