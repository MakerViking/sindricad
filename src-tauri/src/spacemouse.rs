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
use tauri::{AppHandle, Emitter, Manager};

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
///
/// Ranking rather than FILTERING is deliberate. Gating on a known-product-id list
/// would reject a SpaceMouse Pro/Enterprise/Wireless whose id we never listed —
/// devices that work today under the vendor match — so the vendor path is kept as
/// a fallback and nothing that currently works regresses.
///
/// A field report (0.1.85, Linux: "it think my logitech mx anywhere 3s is a space
/// mouse ... any movement of the mouse rotate the world") showed the decoy check
/// above was not enough, because it can only fire when the platform populated the
/// usage. Two changes came out of it:
///   * a vendor match whose usage IS known and is not multi-axis now scores
///     `None`. That collection has told us what it is, and it is not a 6DOF
///     controller, so there is nothing left to fall back FOR.
///   * the remaining fallback — vendor match, usage unavailable — no longer
///     streams on trust: `stream()` reads the device's own report descriptor
///     after opening and drops it unless it declares Multi-axis. See
///     `declares_multi_axis`.
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
    // we genuinely cannot tell from enumeration alone — keep the vendor fallback,
    // but stream() must confirm it against the report descriptor.
    let usage_known = usage_page != 0;
    match (multi_axis, vendor, usage_known) {
        (true, true, _) => Some(3),      // a 3D mouse from a vendor we know
        (true, false, _) => Some(2),     // a 3D mouse from a vendor we don't
        (false, true, false) => Some(1), // vendor match, usage unknown — UNPROVEN
        _ => None,
    }
}

/// Scores at or below this were matched on vendor id alone and have NOT proven
/// they are 6DOF controllers. `stream()` makes them prove it before streaming.
const UNPROVEN: i32 = 1;

fn rank_device(d: &DeviceInfo) -> Option<i32> {
    rank(d.vendor_id(), d.usage_page(), d.usage())
}

/// Does this HID report descriptor declare a 6DOF controller?
///
/// This is the device describing ITSELF, which is the only evidence that settles
/// the Logitech vendor-id collision on a platform that does not fill in usage
/// info during enumeration. Walks the HID short-item encoding: each item is a
/// prefix byte carrying tag/type/size, then 0, 1, 2 or 4 data bytes. We track the
/// current Usage Page (global item, tag 0x0 type 0x1) and look for a Usage
/// (local item, tag 0x0 type 0x2) of Multi-axis Controller under Generic Desktop.
fn declares_multi_axis(desc: &[u8]) -> bool {
    const ITEM_USAGE_PAGE: u8 = 0x04; // 0b0000_01_00
    const ITEM_USAGE: u8 = 0x08; // 0b0000_10_00
    const LONG_ITEM: u8 = 0xfe;

    let mut page: u16 = 0;
    let mut i = 0usize;
    while i < desc.len() {
        let prefix = desc[i];
        if prefix == LONG_ITEM {
            // [0xfe, dataSize, tag, data...] — nothing we need, step over it.
            let size = match desc.get(i + 1) {
                Some(&n) => n as usize,
                None => return false,
            };
            i += 3 + size;
            continue;
        }
        let size = match prefix & 0x03 {
            3 => 4, // a size field of 3 means FOUR bytes, not three
            n => n as usize,
        };
        if i + 1 + size > desc.len() {
            return false; // truncated descriptor — do not guess
        }
        let mut value: u32 = 0;
        for (k, &b) in desc[i + 1..i + 1 + size].iter().enumerate() {
            value |= (b as u32) << (8 * k); // HID data is little-endian
        }
        match prefix & 0xfc {
            ITEM_USAGE_PAGE => page = value as u16,
            ITEM_USAGE => {
                // A 4-byte usage is "extended": it carries its own page in the
                // high half and ignores the current one.
                let (p, u) = if size == 4 {
                    ((value >> 16) as u16, value as u16)
                } else {
                    (page, value as u16)
                };
                if p == USAGE_PAGE_GENERIC_DESKTOP && u == USAGE_MULTI_AXIS {
                    return true;
                }
            }
            _ => {}
        }
        i += 1 + size;
    }
    false
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
        // The HID inventory is published whenever it CHANGES — see stream().
        let mut last_inventory: Option<String> = None;
        loop {
            match stream(&app, &mut last_inventory) {
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

/// Every HID interface we could see, plus which one we chose. Recorded SILENTLY
/// as a bug-report breadcrumb — never a toast.
///
/// This exists because the failure mode we most need to debug is the one that
/// reported nothing: `NoDevice` is deliberately quiet (most users own no 3D
/// mouse), so a tester whose device enumerates under an id we don't match — or
/// on a collection we didn't pick — filed a report with no trace of the
/// SpaceMouse at all. The whole point is to see hardware that is NOT ours.
#[derive(Clone, Serialize)]
pub struct DeviceInventory {
    picked: Option<String>,
    seen: Vec<String>,
    /// Why the best candidate was NOT used, when that happened.
    note: Option<String>,
}

/// The last inventory, kept so the frontend can ASK for it.
///
/// Emitting it as an event was not enough: `spacemouse::start` runs in Tauri's
/// `setup`, and the reader's first pass emits within milliseconds — long before
/// the webview has run main.ts and registered a listener. Tauri does not replay
/// events to listeners that arrive later, so the one diagnostic built for this
/// exact situation was being dropped every single run. That is why the Logitech
/// MX Anywhere report (0.1.85) arrived with no `[spacemouse]` breadcrumb at all
/// and could not be told apart from an unrelated stuck-orbit bug.
#[derive(Default)]
pub struct Inventory(std::sync::Mutex<Option<DeviceInventory>>);

/// The frontend's pull of the above, called once the page is actually listening.
#[tauri::command]
pub fn spacemouse_inventory(state: tauri::State<'_, Inventory>) -> Option<DeviceInventory> {
    state.0.lock().ok().and_then(|held| held.clone())
}

/// Publish the inventory both ways: stored for whoever asks later, emitted for
/// whoever is already listening.
fn publish(app: &AppHandle, inventory: DeviceInventory) {
    if let Some(state) = app.try_state::<Inventory>() {
        if let Ok(mut held) = state.0.lock() {
            *held = Some(inventory.clone());
        }
    }
    let _ = app.emit("spacemouse:devices", inventory);
}

/// Did the device confirm, in its own report descriptor, that it is 6DOF?
enum Proof {
    Yes,
    No,
    /// The platform would not give us the descriptor, so this proves nothing.
    Unavailable(String),
}

fn proves_multi_axis(dev: &hidapi::HidDevice) -> Proof {
    let mut buf = [0u8; 4096]; // HID caps a report descriptor well below this
    match dev.get_report_descriptor(&mut buf) {
        Ok(n) if declares_multi_axis(&buf[..n]) => Proof::Yes,
        Ok(_) => Proof::No,
        Err(e) => Proof::Unavailable(e.to_string()),
    }
}

fn stream(app: &AppHandle, last: &mut Option<String>) -> Result<(), Blocked> {
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

    // Open and VERIFY before publishing the inventory, so it records what
    // actually happened rather than what we were about to try.
    let mut note: Option<String> = None;
    let mut chosen: Option<(&DeviceInfo, hidapi::HidDevice)> = None;
    let mut blocked: Option<Blocked> = None;

    if let Some(&(score, info)) = ranked.first() {
        let name = info.product_string().unwrap_or("SpaceMouse").to_string();
        // Enumeration only needs the USB node; OPENING needs the hidraw node,
        // which is root-only until the udev rule lands. So "listed but won't
        // open" is the signature of the missing rule (or of spacenavd holding
        // the device).
        match api.open_path(info.path()) {
            Err(e) => blocked = Some(Blocked::Unreadable { name, detail: e.to_string() }),
            Ok(dev) => {
                if score > UNPROVEN {
                    chosen = Some((info, dev)); // it declared Multi-axis during enumeration
                } else {
                    match proves_multi_axis(&dev) {
                        Proof::Yes => chosen = Some((info, dev)),
                        Proof::No => {
                            note = Some(format!(
                                "ignoring {} — matched only on vendor id, and its report \
                                 descriptor declares no multi-axis usage, so it is an \
                                 ordinary HID device rather than a 3D mouse",
                                describe(info)
                            ));
                        }
                        Proof::Unavailable(why) => {
                            // Can't tell. Keep the old behaviour rather than
                            // regress a device that works today, but SAY so:
                            // this is the one path that can still misfire.
                            note = Some(format!(
                                "streaming {} on its vendor id alone — the report \
                                 descriptor was unavailable ({why})",
                                describe(info)
                            ));
                            chosen = Some((info, dev));
                        }
                    }
                }
            }
        }
    }

    let inventory = DeviceInventory {
        picked: chosen.as_ref().map(|(info, _)| describe(info)),
        seen: api.device_list().map(describe).collect(),
        note,
    };
    // Publish on CHANGE, not once per run: a device plugged in later, or newly
    // rejected, is news — while the no-device case retries every 3s forever and
    // must not spam the log or the event channel.
    let fingerprint = format!(
        "{:?}|{:?}|{}",
        inventory.picked,
        inventory.note,
        inventory.seen.len()
    );
    if last.as_deref() != Some(fingerprint.as_str()) {
        *last = Some(fingerprint);
        if let Some(n) = &inventory.note {
            eprintln!("[spacemouse] {n}");
        }
        publish(app, inventory);
    }

    if let Some(b) = blocked {
        return Err(b);
    }
    let (info, dev) = chosen.ok_or(Blocked::NoDevice)?;
    let (vid, pid) = (info.vendor_id(), info.product_id());
    let name = info.product_string().unwrap_or("SpaceMouse");
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
        assert!(spacenav > rank(LOGI, 0x00, 0x00).unwrap());
        assert!(spacenav > UNPROVEN, "a declared 6DOF device needs no further proof");
    }

    // The bug this change exists for: vendor 0x046d is Logitech's, so a plain
    // vendor match could pick a MOUSE and feed its reports through as 6DOF.
    #[test]
    fn logitech_mouse_and_keyboard_are_never_opened() {
        assert_eq!(rank(LOGI, 0x01, 0x02), None, "a Logitech mouse");
        assert_eq!(rank(LOGI, 0x01, 0x06), None, "a Logitech keyboard");
    }

    // A collection that told us what it is, and it is not 6DOF. There is nothing
    // to fall back FOR, so it must not be opened — this is the branch that used
    // to score 0 and let a Logitech HID++ / vendor-defined collection through.
    #[test]
    fn a_known_non_multi_axis_usage_is_rejected_even_from_our_vendors() {
        assert_eq!(rank(LOGI, 0xff00, 0x01), None, "Logitech HID++ collection");
        assert_eq!(rank(CONNEXION, 0xff00, 0x01), None, "3Dconnexion vendor collection");
        assert_eq!(rank(LOGI, 0x0c, 0x01), None, "consumer control collection");
    }

    // Ranking, not filtering: a model whose product id we never listed must still
    // work, or we'd regress testers with a SpaceMouse Pro/Enterprise/Wireless.
    #[test]
    fn an_unknown_vendors_3d_mouse_is_still_accepted() {
        assert!(rank(UNKNOWN, 0x01, 0x08).is_some());
    }

    // Where usage info is unavailable we cannot tell from enumeration, so the
    // vendor fallback stays — but only as UNPROVEN, which stream() then makes
    // the device justify against its own report descriptor.
    #[test]
    fn vendor_match_survives_when_usage_is_unpopulated() {
        assert_eq!(rank(CONNEXION, 0x00, 0x00), Some(UNPROVEN));
        assert_eq!(rank(UNKNOWN, 0x00, 0x00), None);
    }

    #[test]
    fn unrelated_hardware_is_ignored() {
        assert_eq!(rank(0x1b1c, 0x0c, 0x01), None, "Corsair consumer control");
        assert_eq!(rank(0x3434, 0x01, 0x06), None, "Keychron keyboard");
    }

    // --- report descriptors -------------------------------------------------
    // The second half of the MX Anywhere fix: when enumeration gives us no usage,
    // the device's own descriptor decides.

    // Generic Desktop / Multi-axis Controller, the opening of every 3D mouse's
    // descriptor.
    const SPACEMOUSE_DESC: &[u8] = &[
        0x05, 0x01, // Usage Page (Generic Desktop)
        0x09, 0x08, // Usage (Multi-axis Controller)
        0xa1, 0x01, // Collection (Application)
        0xa1, 0x00, //   Collection (Physical)
        0x85, 0x01, //     Report ID (1)
        0x09, 0x30, //     Usage (X)
        0x09, 0x31, //     Usage (Y)
        0xc0, 0xc0,
    ];

    // A bog-standard boot mouse — what an MX Anywhere 3s presents.
    const MOUSE_DESC: &[u8] = &[
        0x05, 0x01, // Usage Page (Generic Desktop)
        0x09, 0x02, // Usage (Mouse)
        0xa1, 0x01, // Collection (Application)
        0x09, 0x01, //   Usage (Pointer)
        0xa1, 0x00, //   Collection (Physical)
        0x05, 0x09, //     Usage Page (Button)
        0x19, 0x01, //     Usage Minimum (1)
        0x29, 0x03, //     Usage Maximum (3)
        0x05, 0x01, //     Usage Page (Generic Desktop)
        0x09, 0x30, //     Usage (X)
        0x09, 0x31, //     Usage (Y)
        0x09, 0x38, //     Usage (Wheel)
        0xc0, 0xc0,
    ];

    #[test]
    fn a_3d_mouse_descriptor_is_recognised() {
        assert!(declares_multi_axis(SPACEMOUSE_DESC));
    }

    #[test]
    fn a_mouse_descriptor_is_not() {
        assert!(!declares_multi_axis(MOUSE_DESC));
    }

    // Usage 0x08 means Multi-axis ONLY under Generic Desktop. Under the Button
    // page it is button 8, and reading it as a 3D mouse is the same class of
    // mistake as trusting the vendor id.
    #[test]
    fn usage_8_on_another_page_is_not_multi_axis() {
        assert!(!declares_multi_axis(&[0x05, 0x09, 0x09, 0x08]));
    }

    // A 4-byte usage carries its own page in the high half and ignores the
    // current one.
    #[test]
    fn an_extended_usage_carries_its_own_page() {
        assert!(declares_multi_axis(&[0x0b, 0x08, 0x00, 0x01, 0x00]));
        assert!(!declares_multi_axis(&[0x0b, 0x08, 0x00, 0x09, 0x00]));
    }

    // Never guess from a descriptor we could not read to the end.
    #[test]
    fn a_truncated_descriptor_proves_nothing() {
        assert!(!declares_multi_axis(&[0x05]));
        assert!(!declares_multi_axis(&[0x05, 0x01, 0x09]));
        assert!(!declares_multi_axis(&[]));
        assert!(!declares_multi_axis(&[0xfe])); // long item with no length byte
    }

    // The size field encodes 4 bytes as 3; reading it literally would desync the
    // walk and miss everything after the first long value.
    #[test]
    fn a_four_byte_item_does_not_desync_the_walk() {
        let desc = &[
            0x27, 0xff, 0xff, 0x00, 0x00, // Logical Maximum, 4 bytes
            0x05, 0x01, 0x09, 0x08, // ...then the usage that matters
        ];
        assert!(declares_multi_axis(desc));
    }
}

