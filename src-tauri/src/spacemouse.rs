//! Native 3Dconnexion SpaceMouse reader.
//!
//! Tauri's Linux webview (WebKitGTK) has no WebHID, so the page can't read the
//! device itself. We read its HID reports here in a background thread and
//! forward 6DOF motion + button state to the frontend via Tauri events
//! (`spacemouse:motion`, `spacemouse:button`); the frontend maps them onto the
//! camera + actions.
//!
//! Linux permissions: hidapi opens the `/dev/hidrawN` node, so the udev rule
//! MUST target `SUBSYSTEM=="hidraw"` — a `SUBSYSTEM=="usb"` rule changes the usb
//! node, not hidraw, and will NOT grant access. See `packaging/99-spacemouse.rules`:
//!   KERNEL=="hidraw*", ATTRS{idVendor}=="046d", MODE="0660", GROUP="input", TAG+="uaccess"
//!   KERNEL=="hidraw*", ATTRS{idVendor}=="256f", MODE="0660", GROUP="input", TAG+="uaccess"
//! Install: copy to `/etc/udev/rules.d/`, then
//! `sudo udevadm control --reload && sudo udevadm trigger`, then replug. If
//! `spacenavd` or the 3Dconnexion driver is running it may already hold the
//! device — stop it to let Verxa read it directly.
//!
//! Set VERXA_SPACEMOUSE_DEBUG=1 to log raw reports for tuning.

use std::thread;
use std::time::Duration;

use hidapi::HidApi;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// 3Dconnexion vendor ids: 0x256f (current 3Dconnexion), 0x046d (older Logitech-branded)
const VENDORS: [u16; 2] = [0x256f, 0x046d];

#[derive(Clone, Serialize)]
struct Motion {
    tx: f32,
    ty: f32,
    tz: f32,
    rx: f32,
    ry: f32,
    rz: f32,
}

#[derive(Clone, Serialize)]
struct Buttons {
    mask: u32,
}

/// Spawn a background thread that connects to the first 3Dconnexion device and
/// streams events. Reconnects (every 3s) if the device is missing/unplugged.
pub fn start(app: AppHandle) {
    thread::spawn(move || loop {
        if let Err(e) = stream(&app) {
            eprintln!("[spacemouse] {e}");
        }
        thread::sleep(Duration::from_secs(3));
    });
}

fn stream(app: &AppHandle) -> Result<(), String> {
    let debug = std::env::var("VERXA_SPACEMOUSE_DEBUG").is_ok();
    let api = HidApi::new().map_err(|e| e.to_string())?;
    let info = api
        .device_list()
        .find(|d| VENDORS.contains(&d.vendor_id()))
        .ok_or("no 3Dconnexion device found")?;
    let (vid, pid) = (info.vendor_id(), info.product_id());
    let name = info.product_string().unwrap_or("SpaceMouse").to_string();
    let dev = api.open_path(info.path()).map_err(|e| e.to_string())?;
    eprintln!("[spacemouse] connected {vid:04x}:{pid:04x} \"{name}\"");

    // keep the latest translation + rotation so a report carrying only one of
    // them (older devices split them across report ids 1 and 2) still emits a
    // full, consistent 6DOF vector.
    let mut t = [0f32; 3];
    let mut r = [0f32; 3];
    let mut buf = [0u8; 64];
    loop {
        let n = dev.read_timeout(&mut buf, 1000).map_err(|e| e.to_string())?;
        if n == 0 {
            continue; // timeout, device idle — loop and read again
        }
        if debug {
            eprintln!("[spacemouse] report {:?}", &buf[..n]);
        }
        // signed 16-bit little-endian axis at byte offset i
        let axis = |i: usize| -> f32 {
            if i + 1 < n {
                i16::from_le_bytes([buf[i], buf[i + 1]]) as f32
            } else {
                0.0
            }
        };
        match buf[0] {
            1 => {
                t = [axis(1), axis(3), axis(5)];
                if n >= 13 {
                    r = [axis(7), axis(9), axis(11)]; // device packs rotation in the same report
                }
                emit_motion(app, t, r);
            }
            2 => {
                r = [axis(1), axis(3), axis(5)];
                emit_motion(app, t, r);
            }
            3 => {
                let mut mask = 0u32;
                for k in 1..n.min(5) {
                    mask |= (buf[k] as u32) << (8 * (k - 1));
                }
                let _ = app.emit("spacemouse:button", Buttons { mask });
            }
            _ => {}
        }
    }
}

fn emit_motion(app: &AppHandle, t: [f32; 3], r: [f32; 3]) {
    let _ = app.emit(
        "spacemouse:motion",
        Motion { tx: t[0], ty: t[1], tz: t[2], rx: r[0], ry: r[1], rz: r[2] },
    );
}
