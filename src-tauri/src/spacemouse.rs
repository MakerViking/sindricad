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
//! device — stop it to let SindriCAD read it directly.
//!
//! Set SINDRICAD_SPACEMOUSE_DEBUG=1 to log raw reports for tuning.

use std::thread;
use std::time::Duration;

use hidapi::{DeviceInfo, HidApi};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// 3Dconnexion vendor ids: 0x256f (current 3Dconnexion), 0x046d (older Logitech-branded)
const VENDORS: [u16; 2] = [0x256f, 0x046d];

// HID usage that DEFINES a 6DOF controller: Generic Desktop (0x01) / Multi-axis
// Controller (0x08). This is the spec's own signal, so it identifies ANY 3D mouse
// — including models we've never heard of — which a product-id allowlist could
// not. Measured on a real SpaceNavigator: 046d:c626 enumerates as usage 1/8,
// while mice report 1/2 and keyboards 1/6.
const USAGE_PAGE_GENERIC_DESKTOP: u16 = 0x01;
const USAGE_MULTI_AXIS: u16 = 0x08;
const USAGE_MOUSE: u16 = 0x02;
const USAGE_KEYBOARD: u16 = 0x06;

/// Rank one HID interface as a 6DOF-controller candidate; `None` = never open it.
/// Higher is better.
///
/// Matching on vendor id ALONE was a real bug: 0x046d is Logitech's, shared with
/// every mouse, keyboard and Unifying receiver they ship, and the old code took
/// the first vendor match in enumeration order. On a machine with a Logitech
/// mouse that either blamed the wrong device in the "can't read it" toast, or —
/// worse — opened the mouse and fed its HID reports through as 6DOF motion.
/// It survived here only because this developer's box has exactly one 0x046d
/// device; Windows boxes with Logitech peripherals are where it would surface.
///
/// Ranking rather than FILTERING is deliberate. Gating on a known-product-id list
/// would reject a SpaceMouse Pro/Enterprise/Wireless whose id we never listed —
/// devices that work today under the vendor match — so the vendor path is kept as
/// a fallback and nothing that currently works regresses.
fn rank(vendor_id: u16, usage_page: u16, usage: u16) -> Option<i32> {
    let multi_axis = usage_page == USAGE_PAGE_GENERIC_DESKTOP && usage == USAGE_MULTI_AXIS;
    let vendor = VENDORS.contains(&vendor_id);
    // A usage that positively says "mouse"/"keyboard" is a definitive NO even
    // under a matching vendor id — that is exactly the Logitech collision.
    let decoy = usage_page == USAGE_PAGE_GENERIC_DESKTOP
        && matches!(usage, USAGE_MOUSE | USAGE_KEYBOARD);
    if decoy {
        return None;
    }
    // usage_page 0 means the platform/hidapi build didn't populate usage info, so
    // we genuinely cannot tell — fall back to the old vendor-only behaviour there
    // rather than refusing a device that used to work.
    let usage_known = usage_page != 0;
    match (multi_axis, vendor, usage_known) {
        (true, true, _) => Some(3),      // a 3D mouse from a vendor we know
        (true, false, _) => Some(2),     // a 3D mouse from a vendor we don't
        (false, true, false) => Some(1), // vendor match, usage unknown
        (false, true, true) => Some(0),  // vendor match on some other collection
        _ => None,
    }
}

fn rank_device(d: &DeviceInfo) -> Option<i32> {
    rank(d.vendor_id(), d.usage_page(), d.usage())
}

/// One line per HID interface for the bug report — vid:pid, usage, product.
fn describe(d: &DeviceInfo) -> String {
    format!(
        "{:04x}:{:04x} usage {}/{} {:?}",
        d.vendor_id(),
        d.product_id(),
        d.usage_page(),
        d.usage(),
        d.product_string().unwrap_or("?")
    )
}

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
    thread::spawn(move || {
        // Emit the "plugged in but unreadable" warning at most ONCE per run. The
        // loop below retries every 3s forever, and this used to be an eprintln!
        // nobody sees — so a user could plug in a SpaceMouse, get silence, and
        // have no way to learn that a udev rule is all that was missing.
        let mut warned = false;
        // The HID inventory goes out once per run too, on the first pass, whatever
        // the outcome — see stream().
        let mut announced = false;
        loop {
            match stream(&app, &mut announced) {
                Ok(()) => warned = false, // clean disconnect: a later failure is news again
                Err(Blocked::NoDevice) => {} // nothing plugged in — normal, stay quiet
                Err(Blocked::Unreadable { name, detail }) => {
                    eprintln!("[spacemouse] found \"{name}\" but could not open it: {detail}");
                    if !warned {
                        warned = true;
                        let _ = app.emit("spacemouse:blocked", DeviceBlocked { name, detail });
                    }
                }
                Err(Blocked::Other(e)) => eprintln!("[spacemouse] {e}"),
            }
            thread::sleep(Duration::from_secs(3));
        }
    });
}

/// Why the reader isn't running. Only `Unreadable` is worth telling the user
/// about: the device IS there and the fix is theirs to apply.
enum Blocked {
    NoDevice,
    Unreadable { name: String, detail: String },
    Other(String),
}

#[derive(Clone, Serialize)]
struct DeviceBlocked {
    name: String,
    detail: String,
}

/// Every HID interface we could see, plus which one we chose. Emitted once per
/// run whatever the outcome, and recorded SILENTLY as a bug-report breadcrumb.
///
/// This exists because the failure mode we most need to debug is the one that
/// reported nothing: `NoDevice` is deliberately quiet (most users own no 3D
/// mouse), so a tester whose device enumerates under an id we don't match — or
/// on a collection we didn't pick — filed a report with no trace of the
/// SpaceMouse at all. The whole point is to see hardware that is NOT ours.
#[derive(Clone, Serialize)]
struct DeviceInventory {
    picked: Option<String>,
    seen: Vec<String>,
}

fn stream(app: &AppHandle, announced: &mut bool) -> Result<(), Blocked> {
    let debug = std::env::var("SINDRICAD_SPACEMOUSE_DEBUG").is_ok();
    let api = HidApi::new().map_err(|e| Blocked::Other(e.to_string()))?;

    // Rank every interface and take the BEST — not the first vendor match. We do
    // NOT fall through to a lower-ranked device when the best one won't open: on
    // Linux "won't open" means the udev rule is missing, and quietly opening some
    // other Logitech device instead is precisely the bug being fixed here.
    let mut ranked: Vec<(i32, &DeviceInfo)> = api
        .device_list()
        .filter_map(|d| rank_device(d).map(|s| (s, d)))
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    let best = ranked.first().map(|&(_, d)| d);

    if !*announced {
        *announced = true;
        let _ = app.emit(
            "spacemouse:devices",
            DeviceInventory {
                picked: best.map(describe),
                seen: api.device_list().map(describe).collect(),
            },
        );
    }

    let info = best.ok_or(Blocked::NoDevice)?;
    let (vid, pid) = (info.vendor_id(), info.product_id());
    let name = info.product_string().unwrap_or("SpaceMouse").to_string();
    // Enumeration only needs the USB node; OPENING needs the hidraw node, which
    // is root-only until the udev rule lands. So "listed but won't open" is the
    // signature of the missing rule (or of spacenavd holding the device).
    let dev = api.open_path(info.path()).map_err(|e| Blocked::Unreadable {
        name: name.clone(),
        detail: e.to_string(),
    })?;
    eprintln!("[spacemouse] connected {vid:04x}:{pid:04x} \"{name}\"");

    // keep the latest translation + rotation so a report carrying only one of
    // them (older devices split them across report ids 1 and 2) still emits a
    // full, consistent 6DOF vector.
    let mut t = [0f32; 3];
    let mut r = [0f32; 3];
    let mut buf = [0u8; 64];
    loop {
        // A read failure after a successful open is an unplug or a transport
        // hiccup, not a permissions problem — reconnect quietly.
        let n = dev
            .read_timeout(&mut buf, 1000)
            .map_err(|e| Blocked::Other(e.to_string()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    // Real ids, read off this developer's machine with a hidapi enumeration probe.
    const SPACENAV: u16 = 0x046d; // 046d:c626 "SpaceNavigator", enumerates usage 1/8
    const LOGI: u16 = 0x046d; // ...the SAME vendor id as every Logitech mouse
    const CONNEXION: u16 = 0x256f;
    const UNKNOWN: u16 = 0x3367;

    #[test]
    fn multi_axis_outranks_everything() {
        let spacenav = rank(SPACENAV, 0x01, 0x08).unwrap();
        assert!(spacenav > rank(CONNEXION, 0xff00, 0x01).unwrap());
        assert!(spacenav > rank(LOGI, 0x00, 0x00).unwrap());
    }

    // The bug this change exists for: vendor 0x046d is Logitech's, so a plain
    // vendor match could pick a MOUSE and feed its reports through as 6DOF.
    #[test]
    fn logitech_mouse_and_keyboard_are_never_opened() {
        assert_eq!(rank(LOGI, 0x01, 0x02), None, "a Logitech mouse");
        assert_eq!(rank(LOGI, 0x01, 0x06), None, "a Logitech keyboard");
    }

    // Ranking, not filtering: a model whose product id we never listed must still
    // work, or we'd regress testers with a SpaceMouse Pro/Enterprise/Wireless.
    #[test]
    fn an_unknown_vendors_3d_mouse_is_still_accepted() {
        assert!(rank(UNKNOWN, 0x01, 0x08).is_some());
    }

    // Where usage info is unavailable we cannot tell, so keep the old behaviour
    // rather than refusing a device that used to work.
    #[test]
    fn vendor_match_survives_when_usage_is_unpopulated() {
        assert_eq!(rank(CONNEXION, 0x00, 0x00), Some(1));
        assert_eq!(rank(UNKNOWN, 0x00, 0x00), None);
    }

    #[test]
    fn unrelated_hardware_is_ignored() {
        assert_eq!(rank(0x1b1c, 0x0c, 0x01), None, "Corsair consumer control");
        assert_eq!(rank(0x3434, 0x01, 0x06), None, "Keychron keyboard");
    }
}
