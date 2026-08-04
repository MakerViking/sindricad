//! WebKitGTK GPU workarounds, applied before the webview starts (Linux only).
//!
//! macOS (WKWebView) and Windows (WebView2) are different engines entirely and
//! read none of these variables, which is why the whole module is Linux-gated.
//!
//! Split into a pure `decide` plus a thin applier for the same reason
//! `sidecar::configure_env` is split out: this is behaviour that only misfires
//! on hardware nobody here builds on, so the decision has to be assertable
//! without the hardware. Nothing in this file has been exercised against an
//! actual Nvidia GPU by me — see the test module.

use std::path::Path;

/// Our own opt-out. A user whose machine is made *worse* by the workaround
/// needs an escape hatch, and the obvious one — setting
/// `WEBKIT_DISABLE_DMABUF_RENDERER=0` — does not work: WebKit's own checks are
/// presence-based in places, so "0" can read as "yes, disable it". A separate
/// variable of ours has no such ambiguity.
const OPT_OUT: &str = "SINDRICAD_NO_GPU_WORKAROUND";

/// The WebKitGTK knob we set. Deliberately NOT
/// `WEBKIT_DISABLE_COMPOSITING_MODE`, which also avoids the crash but turns off
/// accelerated compositing wholesale — a bad trade for an app whose main view is
/// a WebGL canvas, and the mode under which the reporter of issue #6 also saw
/// viewport pointer capture stick (that is bug 2 of the same issue, unfixed).
///
/// This one is narrower: it does not disable WebGL or compositing, only the
/// DMA-BUF path that carries composited frames from the web process to the GTK
/// widget. It is not free, though. Without it, GTK3 (which is what
/// webkit2gtk-4.1 gives us) downloads each buffer to the CPU and paints it with
/// Cairo, so GPU-heavy content pays a per-frame cost. For the viewport that is a
/// smoothness cost, not a correctness one, and it beats not launching.
///
/// WebKit documents the variable as a transitional debugging escape hatch that
/// will eventually be removed. When it goes, this module has to be revisited
/// rather than quietly stop working.
const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Whether to disable the DMABUF renderer, and why. The reason is carried so the
/// startup log says what happened; a silent environment change is exactly the
/// kind of thing that makes a later field report unreadable.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Disable,
    /// Left alone, for one of the `SKIP_*` reasons below.
    Skip(&'static str),
}

// Named so the applier can match on them instead of repeating the prose, which
// would drift apart from `decide` the first time either is reworded.
const SKIP_OPT_OUT: &str = "opted out via SINDRICAD_NO_GPU_WORKAROUND";
const SKIP_ALREADY_SET: &str = "WEBKIT_DISABLE_DMABUF_RENDERER already set by the environment";
const SKIP_NO_NVIDIA: &str = "no Nvidia driver";

/// Issue #6 (Nobara/Fedora 44, RTX 5080, driver 595.84, Wayland):
/// `WebKitWebProcess` takes a SIGSEGV inside `libnvidia-eglcore` on launch and
/// the app dies before painting anything — no dialog, no message, nothing the
/// user can act on. The reporter confirmed that EITHER
/// `WEBKIT_DISABLE_DMABUF_RENDERER=1` or `WEBKIT_DISABLE_COMPOSITING_MODE=1`
/// avoids it; we pick the narrower one.
///
/// This fires for every Nvidia machine, not only broken ones, because there is
/// no way to tell them apart before the crash. That costs the working majority
/// the per-frame cost described on `DMABUF`; the alternative costs the affected
/// minority the entire application. The size of that cost is documented by
/// WebKit, not measured by me — there is no Nvidia hardware here to measure on.
fn decide(nvidia_present: bool, dmabuf_already_set: bool, opted_out: bool) -> Decision {
    // Precedence: an explicit human beats our guess, both ways round. Someone
    // running with the variable already set is mid-workaround (the issue #6
    // reporter is, right now) and must not have it changed under them.
    if opted_out {
        return Decision::Skip(SKIP_OPT_OUT);
    }
    if dmabuf_already_set {
        return Decision::Skip(SKIP_ALREADY_SET);
    }
    if !nvidia_present {
        return Decision::Skip(SKIP_NO_NVIDIA);
    }
    Decision::Disable
}

/// Is the Nvidia userspace driver in play?
///
/// `/proc/driver/nvidia/version` is the canonical marker for the loaded Nvidia
/// kernel module, proprietary or open-kernel — both ship the same
/// `libnvidia-eglcore`, which is where the crash lives, so both must match.
/// Nouveau creates neither path and is unaffected.
///
/// Takes a root so a test can point it at a fixture; production passes "/".
fn nvidia_driver_present_under(root: &Path) -> bool {
    root.join("proc/driver/nvidia/version").exists()
        || root.join("sys/module/nvidia/version").exists()
}

/// Apply the workaround. MUST run before the webview is created: WebKit reads
/// these variables when it spawns its web process, and the process inherits the
/// environment as it stood at that moment.
pub fn apply_gpu_workarounds() {
    let decision = decide(
        nvidia_driver_present_under(Path::new("/")),
        std::env::var_os(DMABUF).is_some(),
        std::env::var_os(OPT_OUT).is_some(),
    );

    match decision {
        Decision::Disable => {
            std::env::set_var(DMABUF, "1");
            // Logged unconditionally: when this machine later files a bug, the
            // terminal output needs to show that we changed the renderer.
            println!(
                "[gpu] Nvidia driver detected — disabling the WebKitGTK DMABUF renderer \
                 (issue #6). Set {OPT_OUT}=1 to keep it."
            );
        }
        // The two environment-driven skips are worth a line for the same reason;
        // "no Nvidia driver" is the ordinary case and stays quiet.
        Decision::Skip(SKIP_NO_NVIDIA) => {}
        Decision::Skip(reason) => {
            println!("[gpu] leaving the WebKitGTK renderer alone: {reason}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reason this module exists: an Nvidia machine must come up with the
    /// DMABUF renderer off, or WebKit segfaults before the app paints (#6).
    #[test]
    fn nvidia_machine_disables_the_dmabuf_renderer() {
        assert_eq!(decide(true, false, false), Decision::Disable);
    }

    /// Everyone else keeps the fast path. A blanket disable would have been the
    /// easy fix and would have cost every Linux user buffer sharing for a fault
    /// only Nvidia has.
    #[test]
    fn non_nvidia_machines_are_untouched() {
        assert_eq!(decide(false, false, false), Decision::Skip(SKIP_NO_NVIDIA));
    }

    /// A human who has already set the variable — like the #6 reporter running
    /// his workaround today — outranks the probe, on Nvidia and off it. Changing
    /// it under him would silently swap the configuration he reported against.
    #[test]
    fn an_existing_setting_is_never_overridden() {
        assert!(matches!(decide(true, true, false), Decision::Skip(_)));
        assert!(matches!(decide(false, true, false), Decision::Skip(_)));
    }

    /// And the escape hatch has to beat the probe, or a machine the workaround
    /// harms has no way out.
    #[test]
    fn the_opt_out_beats_detection() {
        assert_eq!(decide(true, false, true), Decision::Skip(SKIP_OPT_OUT));
        // …and beats an existing setting too, so one variable always wins.
        assert_eq!(decide(true, true, true), Decision::Skip(SKIP_OPT_OUT));
    }

    /// The probe is filesystem shape, so it is worth pinning: a bare
    /// `/sys/module/nvidia` directory (nvidia_drm can appear on hybrid systems)
    /// is not enough — we look for the version files the real driver writes.
    #[test]
    fn the_probe_matches_the_paths_the_nvidia_driver_actually_writes() {
        let tmp = std::env::temp_dir().join("sindricad-webkit-probe-test");
        let _ = std::fs::remove_dir_all(&tmp);

        std::fs::create_dir_all(tmp.join("sys/module/nvidia")).unwrap();
        assert!(
            !nvidia_driver_present_under(&tmp),
            "an empty module directory must not count as the driver"
        );

        std::fs::create_dir_all(tmp.join("proc/driver/nvidia")).unwrap();
        std::fs::write(tmp.join("proc/driver/nvidia/version"), "NVRM version …").unwrap();
        assert!(
            nvidia_driver_present_under(&tmp),
            "/proc/driver/nvidia/version is the canonical marker"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// `decide` being right is worth nothing if the applier reads the wrong
    /// variables, so exercise the real entry point once. The opt-out path is the
    /// one that can be asserted on any machine: it must leave the environment
    /// untouched whatever hardware the test happens to run on.
    ///
    /// This mutates process-wide environment, which is why it restores what it
    /// found and why nothing else in this crate reads these two variables.
    #[test]
    fn the_applier_reads_the_variables_it_documents() {
        let restore = std::env::var_os(DMABUF);
        std::env::remove_var(DMABUF);
        std::env::set_var(OPT_OUT, "1");

        apply_gpu_workarounds();
        assert!(
            std::env::var_os(DMABUF).is_none(),
            "the opt-out must stop the applier setting {DMABUF}, on Nvidia hardware or not"
        );

        std::env::remove_var(OPT_OUT);
        if let Some(v) = restore {
            std::env::set_var(DMABUF, v);
        }
    }
}
