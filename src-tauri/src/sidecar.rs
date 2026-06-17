//! Spawn, supervise, and reliably kill the Python geometry sidecar.
//!
//! Dev: launch the uv-venv Python directly (`sidecar/.venv/bin/python
//! sidecar/server.py`) in its OWN process group so we can group-kill on exit.
//! The Python side also sets PR_SET_PDEATHSIG, so it dies if we crash. Between
//! the two, the sidecar never orphans. (Prod will switch to a bundled
//! externalBin sidecar — deferred.)

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Handle to the running sidecar, stored in Tauri managed state.
pub struct Sidecar(pub Mutex<Option<Child>>);

impl Sidecar {
    pub fn spawn() -> std::io::Result<Self> {
        // project root = parent of this crate's manifest dir (dev layout)
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let sidecar_dir = root.join("sidecar");
        let venv_python = sidecar_dir.join(".venv").join("bin").join("python");
        let python = if venv_python.exists() {
            venv_python
        } else {
            PathBuf::from("python")
        };

        let mut cmd = Command::new(&python);
        cmd.arg("server.py")
            .current_dir(&sidecar_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // own process group so we can SIGTERM the whole tree at once
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn()?;

        // drain stdout/stderr so the pipe never fills, and surface logs
        if let Some(out) = child.stdout.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
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

        println!("[sidecar] spawned pid {}", child.id());
        Ok(Sidecar(Mutex::new(Some(child))))
    }

    /// Kill the sidecar and its whole process group.
    pub fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
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

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill();
    }
}
