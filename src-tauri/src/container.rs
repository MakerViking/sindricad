//! The `.sindri` container: a ZIP holding the document JSON plus the geometry it
//! references by content hash.
//!
//! WHY THIS EXISTS. Geometry used to live *inside* the document as base64 ASCII
//! BREP. On the reference 356 MiB STEP assembly that is 541.8 MiB of JSON — 4.2x
//! over the 128 MiB websocket frame cap, and 6.4x over the 64 MiB embedded-BREP
//! cap that is re-checked on every rebuild. Measured on that file: binary
//! BinTools is 224.1 MiB and deflates to 83.5 MiB, and reloading from the blob
//! takes 1.9 s against 189.0 s to re-import from STEP.
//!
//! WHY RUST OWNS IT, not the Python sidecar. `sidecar.rs` deliberately does not
//! auto-respawn, so a dead sidecar is permanent for the session — a save routed
//! through it would leave the user unable to save at all, with unsaved work in
//! front of them. Saving needs no geometry: the document comes from the frontend
//! and the blobs are already bytes on disk. Rust also already owns durable
//! document persistence (`recovery_write` in lib.rs), so this sits next to it.
//! This does NOT breach "Rust never touches geometry" — nothing here interprets
//! a shape, exactly as printer.rs moves gcode and tinkeratlas.rs moves 3MF.
//!
//! TWO RULES, both load-bearing rather than stylistic:
//!
//! 1. **Hash the STORED bytes once, at write time, and carry that hash.** Never
//!    re-derive one by re-serialising a shape: `write(read(x)) != x` byte-wise
//!    for BREP (reading rebuilds the shape graph in a different but equivalent
//!    order), so a re-derived hash changes every generation and every lookup
//!    would miss. The sidecar computes the hash when it first produces the bytes;
//!    this module only ever carries or VERIFIES it.
//! 2. **Never use a name from inside the archive as a path.** Extracted blobs are
//!    published under the hash we computed ourselves over the inflated bytes, so
//!    zip-slip is structurally impossible rather than filtered.
//!
//! LAYOUT (entry order matters only for the first entry):
//!
//! ```text
//! manifest.json        STORED, first — readable without a decompressor
//! document.json        DEFLATE — the CadDocument, carrying its own `version`
//! geom/<hash>.bbrep    DEFLATE — binary OCCT BinTools; the NAME is the hash
//! mesh/<key>.bin       DEFLATE(1) — packed f32/u32; optional by design, a
//!                      reader that skips this section is still correct
//! ```

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use blake2::digest::consts::U16;
use blake2::{Blake2b, Digest};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

/// Bumped only when the ZIP LAYOUT changes. Distinct from the document's own
/// `version` (src/document/migrate.ts FORMAT_VERSION), which moves for different
/// reasons: a document migration does not reshape the archive, and vice versa.
pub const CONTAINER_VERSION: u32 = 1;

pub const HASH_ALG: &str = "blake2b-128";

const MANIFEST_NAME: &str = "manifest.json";
const DOCUMENT_NAME: &str = "document.json";

/// Zip-bomb guard: the DECLARED uncompressed sizes live in the central
/// directory, so we can refuse before inflating a single byte.
///
/// The cap is ABSOLUTE, not a compression ratio. A ratio test was tried in the
/// Python prototype and removed: it fires on legitimate data (a sparse or highly
/// repetitive blob deflates ~1000x, as does pretty-printed JSON) while adding
/// nothing, because what makes a bomb dangerous is the expanded SIZE and that is
/// already bounded here. Extraction also streams to disk rather than memory, so
/// the worst case is bounded disk use on a file the user chose to open.
const MAX_TOTAL_UNCOMPRESSED: u64 = 8 << 30; // 8 GiB

type Blake2b128 = Blake2b<U16>;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BlobRow {
    pub entry: String,
    pub hash: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MeshRow {
    pub entry: String,
    pub key: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Manifest {
    pub container: u32,
    #[serde(rename = "hashAlg")]
    pub hash_alg: String,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub blobs: Vec<BlobRow>,
    #[serde(default)]
    pub meshes: Vec<MeshRow>,
}

/// The durable blob store: content-addressed geometry, one file per hash.
///
/// Under `app_data_dir()`, deliberately NOT `$XDG_CACHE_HOME`. `geomstore` lives
/// in the cache and is free to reclaim: its `evict()` drops any blob with a
/// refcount of 0, and `purge()` is wired to the Compute All button — a container
/// blob living there would be deleted by a user pressing a button. The container
/// is the source of truth for a user's geometry, so its blobs must be somewhere
/// nothing sweeps.
///
/// This directory is the SEAM between the two languages: Rust writes it when
/// opening a container, the Python sidecar writes it at import time, and both
/// read it. That is safe without any locking because the path is a pure function
/// of the content hash — two writers racing on the same hash are writing
/// byte-identical data, and each publishes via rename.
///
/// Flat, not sharded like geomstore's `blobs/<key[:2]>/`: that store holds one
/// blob per BODY (3,060 for the reference assembly), this one holds one per
/// IMPORT FEATURE, so directory sizes stay in the hundreds.
pub fn blob_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("blobs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Packed viewport meshes carried alongside the blobs. Purely a reopen-speed
/// cache — losing this costs re-tessellation time, never data — but it lives
/// next to the blobs rather than in geomstore so a container can seed it.
pub fn mesh_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("meshes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The content hash of a blob. See rule 1 in the module docs: call this once, on
/// the bytes as they are first produced.
///
/// Not called on any production path — Rust only ever VERIFIES a hash, and does
/// that while streaming, so it hashes incrementally rather than over a slice.
/// This is kept as the executable statement of which digest the format uses, and
/// is what `hash_matches_python` pins against the sidecar's copy.
#[allow(dead_code)]
pub fn hash_bytes(data: &[u8]) -> String {
    let mut h = Blake2b128::new();
    h.update(data);
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// True if `path` is a ZIP. Cheap: reads two bytes. Used to tell a v5 container
/// from a legacy plain-JSON `.sindri` without parsing either.
pub fn looks_like_container(path: &Path) -> bool {
    let mut buf = [0u8; 2];
    File::open(path)
        .and_then(|mut f| f.read_exact(&mut buf))
        .map(|_| &buf == b"PK")
        .unwrap_or(false)
}

fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && !key.contains("..")
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// fsync a directory so a rename INTO it is durable across a crash. Tolerant of
/// filesystems that refuse the operation outright.
fn fsync_dir(dir: &Path) {
    if let Ok(f) = File::open(dir) {
        let _ = f.sync_all();
    }
}

/// A temp path that cannot collide, in the SAME directory as the target — a temp
/// dir on another filesystem would make the rename fail with EXDEV.
fn temp_sibling(target: &Path) -> PathBuf {
    let mut n = target.as_os_str().to_os_string();
    n.push(format!(".tmp-{}", uuid_hex()));
    PathBuf::from(n)
}

fn uuid_hex() -> String {
    let mut b = [0u8; 16];
    // Failure here would mean no entropy source at all; a timestamp is a fine
    // fallback for a name that only has to be unique within one directory.
    if getrandom::getrandom(&mut b).is_err() {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        b[..16].copy_from_slice(&t.to_le_bytes()[..16.min(16)]);
    }
    hex(&b)
}

/// Publish a container at `dest`, atomically.
///
/// `blob_paths` maps content hash -> a readable path holding EXACTLY the bytes
/// that hash was computed over. `mesh_paths` maps a mesh key -> path and is
/// optional: meshes are a reopen-speed cache, and a container without them is
/// fully valid.
///
/// The archive is built at a sibling temp path, fsynced, then renamed over the
/// target. A crash leaves either the old file or the new one, never a torn one —
/// which matters because this file IS the user's geometry.
pub fn write_container(
    dest: &Path,
    document_json: &str,
    blob_paths: &BTreeMap<String, PathBuf>,
    mesh_paths: &BTreeMap<String, PathBuf>,
    app: &str,
) -> Result<Manifest, String> {
    let mut manifest = Manifest {
        container: CONTAINER_VERSION,
        hash_alg: HASH_ALG.to_string(),
        app: app.to_string(),
        blobs: Vec::new(),
        meshes: Vec::new(),
    };
    for (h, src) in blob_paths {
        let bytes = std::fs::metadata(src)
            .map_err(|e| format!("could not read geometry {}: {e}", src.display()))?
            .len();
        manifest.blobs.push(BlobRow {
            entry: format!("geom/{h}.bbrep"),
            hash: h.clone(),
            bytes,
        });
    }
    for (k, src) in mesh_paths {
        let bytes = match std::fs::metadata(src) {
            Ok(m) => m.len(),
            Err(_) => continue, // a cache entry that vanished is not an error
        };
        manifest.meshes.push(MeshRow {
            entry: format!("mesh/{k}.bin"),
            key: k.clone(),
            bytes,
        });
    }

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let tmp = temp_sibling(dest);

    // Any failure past this point must not leave a temp file behind, and must
    // leave the previous file untouched.
    let build = || -> Result<(), String> {
        let file = File::create(&tmp).map_err(|e| e.to_string())?;
        let mut z = zip::ZipWriter::new(file);

        // STORED and first, so the manifest is readable by a hex dump or a
        // minimal reader with no decompressor in the loop.
        let stored = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .large_file(true);
        let deflated = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        // Packed f32/u32 barely compresses; level 1 keeps the write fast.
        let deflated_fast = deflated.compression_level(Some(1));

        z.start_file(MANIFEST_NAME, stored).map_err(|e| e.to_string())?;
        let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        z.write_all(manifest_json.as_bytes()).map_err(|e| e.to_string())?;

        z.start_file(DOCUMENT_NAME, deflated).map_err(|e| e.to_string())?;
        z.write_all(document_json.as_bytes()).map_err(|e| e.to_string())?;

        for row in &manifest.blobs {
            z.start_file(&row.entry, deflated).map_err(|e| e.to_string())?;
            copy_into(&mut z, &blob_paths[&row.hash])?;
        }
        for row in &manifest.meshes {
            z.start_file(&row.entry, deflated_fast).map_err(|e| e.to_string())?;
            copy_into(&mut z, &mesh_paths[&row.key])?;
        }

        let mut file = z.finish().map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    };

    if let Err(e) = build() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Some(parent) = dest.parent() {
        fsync_dir(parent);
    }
    Ok(manifest)
}

fn copy_into<W: Write + Seek>(z: &mut zip::ZipWriter<W>, src: &Path) -> Result<(), String> {
    let mut f = File::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
    std::io::copy(&mut f, z).map_err(|e| e.to_string())?;
    Ok(())
}

fn open_archive(path: &Path) -> Result<zip::ZipArchive<File>, String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    zip::ZipArchive::new(f).map_err(|_| "This document is damaged and cannot be opened.".to_string())
}

/// Refuse a bomb BEFORE inflating anything.
fn guard(z: &mut zip::ZipArchive<File>) -> Result<(), String> {
    let mut total: u64 = 0;
    for i in 0..z.len() {
        total = total.saturating_add(z.by_index_raw(i).map_err(|e| e.to_string())?.size());
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err(format!(
                "This document expands to more than {} GiB and was refused.",
                MAX_TOTAL_UNCOMPRESSED >> 30
            ));
        }
    }
    Ok(())
}

/// The manifest alone, without inflating any geometry. The error strings are
/// user-facing.
pub fn read_manifest(path: &Path) -> Result<Manifest, String> {
    let mut z = open_archive(path)?;
    guard(&mut z)?;
    let mut raw = String::new();
    z.by_name(MANIFEST_NAME)
        .map_err(|_| "This document is missing its manifest and cannot be opened.".to_string())?
        .read_to_string(&mut raw)
        .map_err(|_| "This document has an unreadable manifest and cannot be opened.".to_string())?;
    let manifest: Manifest = serde_json::from_str(&raw)
        .map_err(|_| "This document has an unreadable manifest and cannot be opened.".to_string())?;

    if manifest.container > CONTAINER_VERSION {
        return Err(format!(
            "This document uses a newer SindriCAD container format (v{}). \
             Update SindriCAD to open it.",
            manifest.container
        ));
    }
    if manifest.hash_alg != HASH_ALG {
        return Err(format!(
            "This document uses an unsupported hash ({}).",
            manifest.hash_alg
        ));
    }
    Ok(manifest)
}

/// Open a container: extract its geometry into `blob_dir` and return
/// `(document_json, manifest)`.
///
/// Every blob is streamed to a temp file while being hashed, and is published
/// only once the hash MATCHES the one the manifest declared. The published
/// filename is derived from that verified hash, never from the zip entry name.
///
/// A hash mismatch is a HARD error: it means truncation or tampering, and
/// silently accepting the bytes would put wrong geometry in front of the user.
pub fn read_container(
    path: &Path,
    blob_dir: &Path,
    mesh_dir: Option<&Path>,
) -> Result<(String, Manifest), String> {
    let manifest = read_manifest(path)?;
    std::fs::create_dir_all(blob_dir).map_err(|e| e.to_string())?;
    if let Some(d) = mesh_dir {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }

    let mut z = open_archive(path)?;
    let mut document_json = String::new();
    z.by_name(DOCUMENT_NAME)
        .map_err(|_| "This document is missing its contents and cannot be opened.".to_string())?
        .read_to_string(&mut document_json)
        .map_err(|_| "This document is damaged and cannot be opened.".to_string())?;

    for row in &manifest.blobs {
        let final_path = blob_dir.join(format!("{}.bbrep", row.hash));
        if final_path.exists() {
            continue; // same hash => same bytes; nothing to do
        }
        extract_verified(&mut z, &row.entry, Some(&row.hash), &final_path, blob_dir)?;
    }

    if let Some(dir) = mesh_dir {
        for row in &manifest.meshes {
            // Keys are ours, but they land in a filename, so validate rather
            // than trust the file. Meshes are derived data: a bad row costs a
            // re-tessellation and must never fail an open.
            if !is_safe_key(&row.key) {
                continue;
            }
            let dest = dir.join(format!("{}.bin", row.key));
            let _ = extract_verified(&mut z, &row.entry, None, &dest, dir);
        }
    }

    Ok((document_json, manifest))
}

fn extract_verified(
    z: &mut zip::ZipArchive<File>,
    entry: &str,
    want_hash: Option<&str>,
    final_path: &Path,
    dest_dir: &Path,
) -> Result<(), String> {
    let tmp = temp_sibling(final_path);
    let mut run = || -> Result<(), String> {
        let mut src = z
            .by_name(entry)
            .map_err(|_| format!("This document is missing part of its geometry ({entry})."))?;
        let mut out = File::create(&tmp).map_err(|e| e.to_string())?;
        let mut h = Blake2b128::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = src.read(&mut buf).map_err(|_| {
                "This document is damaged and cannot be opened.".to_string()
            })?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
        out.flush().map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        if let Some(want) = want_hash {
            if hex(&h.finalize()) != want {
                return Err("This document's geometry does not match its manifest — the file \
                            is damaged or was modified. Opening it was refused rather than \
                            showing you the wrong shape."
                    .to_string());
            }
        }
        Ok(())
    };
    if let Err(e) = run() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, final_path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    fsync_dir(dest_dir);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands. Privileged IPC, the same pattern as `recovery_write` — the
// webview holds only `fs:allow-read-text-file` / `fs:allow-write-text-file`, so
// it could not read or write a ZIP itself even if we wanted it to. Widening that
// to the binary APIs would reopen the post-XSS persistence channel the security
// round deliberately closed.

/// Write the document and the geometry it references to `path`, atomically.
///
/// `hashes` are the content hashes the document's import features carry; the
/// frontend collects them because it owns the document. Deliberately does NOT
/// consult the sidecar: `sidecar.rs` does not auto-respawn, so a save that
/// needed it would be impossible for the rest of the session.
#[tauri::command]
pub async fn container_save(
    app: tauri::AppHandle,
    path: String,
    document_json: String,
    hashes: Vec<String>,
    mesh_keys: Vec<String>,
) -> Result<(), String> {
    let blobs_root = blob_dir(&app)?;
    let meshes_root = mesh_dir(&app)?;

    let mut blobs = BTreeMap::new();
    let mut missing = Vec::new();
    for h in hashes {
        let p = blobs_root.join(format!("{h}.bbrep"));
        if p.exists() {
            blobs.insert(h, p);
        } else {
            missing.push(h);
        }
    }
    // Refuse rather than write a document whose geometry is not in it. The
    // atomic publish means the user still has their previous file, and the
    // in-memory document is untouched — both strictly better than a saved file
    // that opens with missing bodies somewhere else.
    if !missing.is_empty() {
        return Err(format!(
            "{} of this document's imported bodies could not be found in local storage, \
             so saving was stopped rather than writing a file with missing geometry. \
             The previous file is unchanged.",
            missing.len()
        ));
    }

    let mut meshes = BTreeMap::new();
    for k in mesh_keys {
        let p = meshes_root.join(format!("{k}.bin"));
        if p.exists() {
            meshes.insert(k, p); // absent meshes are a cache miss, never an error
        }
    }

    let app_version = app.package_info().version.to_string();
    write_container(
        std::path::Path::new(&path),
        &document_json,
        &blobs,
        &meshes,
        &app_version,
    )
    .map(|_| ())
}

/// Read a container at `path`: extract its geometry into the blob store and
/// return the document JSON. The blobs land before this returns, so the rebuild
/// the frontend kicks off on load can resolve them immediately.
#[tauri::command]
pub async fn container_open(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let blobs = blob_dir(&app)?;
    let meshes = mesh_dir(&app)?;
    read_container(std::path::Path::new(&path), &blobs, Some(&meshes)).map(|(doc, _)| doc)
}

/// True if `path` is a container rather than a legacy plain-JSON document.
#[tauri::command]
pub fn container_is_container(path: String) -> bool {
    looks_like_container(std::path::Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sindri_container_{tag}_{}", uuid_hex()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn blob(dir: &Path, name: &str, data: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, data).unwrap();
        p
    }

    /// The blob store is written by BOTH Rust (extracting a container) and the
    /// Python sidecar (importing geometry), and addressed purely by content
    /// hash. If the two languages ever disagree about that hash, every container
    /// reference dangles and it looks to the user like the geometry vanished.
    /// These vectors are duplicated verbatim in sidecar/test_blobstore.py so
    /// both sides are pinned to the same constants.
    #[test]
    fn hash_matches_python() {
        assert_eq!(hash_bytes(b""), "cae66941d9efbd404e4d88758ea67670");
        assert_eq!(hash_bytes(b"sindricad"), "dc82074d29de5d86a53adf0120a12de8");
        assert_eq!(
            hash_bytes(&[0x00u8, 0xff].repeat(8)),
            "2a7271a37f134cb3bfb8ff7e507e0da7"
        );
        assert_eq!(hash_bytes(b"x").len(), 32, "blake2b-128 as hex");
    }

    #[test]
    fn roundtrip_preserves_bytes_exactly() {
        let dir = tmpdir("rt");
        // One incompressible blob and one that deflates ~1000x, so both sides of
        // the compression path are covered.
        let a: Vec<u8> = (0..200_000u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
        let b = vec![0u8; 500_000];
        let (ha, hb) = (hash_bytes(&a), hash_bytes(&b));

        let mut blobs = BTreeMap::new();
        blobs.insert(ha.clone(), blob(&dir, "a.bin", &a));
        blobs.insert(hb.clone(), blob(&dir, "b.bin", &b));
        let mut meshes = BTreeMap::new();
        meshes.insert("deadbeef-t0".to_string(), blob(&dir, "m.bin", b"MESHDATA".repeat(1000).as_slice()));

        let doc = format!(r#"{{"version":5,"features":[{{"type":"import","geom":"{ha}"}}]}}"#);
        let dest = dir.join("part.sindri");
        write_container(&dest, &doc, &blobs, &meshes, "test").unwrap();

        assert!(looks_like_container(&dest), "written file is a zip");

        // The manifest must be first AND stored, or a minimal reader needs a
        // decompressor just to learn the format version.
        {
            let mut z = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
            assert_eq!(z.by_index(0).unwrap().name(), MANIFEST_NAME);
            assert_eq!(
                z.by_name(MANIFEST_NAME).unwrap().compression(),
                zip::CompressionMethod::Stored
            );
            assert!(
                z.by_name(&format!("geom/{hb}.bbrep")).unwrap().compressed_size() < 500_000,
                "the compressible blob should actually have shrunk"
            );
        }

        let out = dir.join("blobs");
        let meshes_out = dir.join("meshes");
        let (got_doc, manifest) = read_container(&dest, &out, Some(&meshes_out)).unwrap();

        assert_eq!(got_doc, doc, "document survives byte-for-byte");
        assert_eq!(manifest.container, CONTAINER_VERSION);
        assert_eq!(std::fs::read(out.join(format!("{ha}.bbrep"))).unwrap(), a);
        assert_eq!(std::fs::read(out.join(format!("{hb}.bbrep"))).unwrap(), b);
        assert!(meshes_out.join("deadbeef-t0.bin").exists());

        // Meshes are a cache: the same container must open fine without them.
        let out2 = dir.join("blobs2");
        let (got2, _) = read_container(&dest, &out2, None).unwrap();
        assert_eq!(got2, doc);

        // Re-reading is idempotent, not a duplicate-write, and leaves no litter.
        read_container(&dest, &out, Some(&meshes_out)).unwrap();
        let names: Vec<_> = std::fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 2, "re-read did not duplicate: {names:?}");
        assert!(!names.iter().any(|n| n.contains(".tmp-")), "temp files left: {names:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The one that must never silently pass: a valid zip with a valid manifest
    /// but wrong bytes. Nothing else in the stack would notice, and the user
    /// would be shown the wrong shape.
    #[test]
    fn tampered_geometry_is_refused_and_nothing_is_published() {
        let dir = tmpdir("tamper");
        let data = vec![7u8; 50_000];
        let h = hash_bytes(&data);
        let mut blobs = BTreeMap::new();
        blobs.insert(h.clone(), blob(&dir, "d.bin", &data));
        let good = dir.join("ok.sindri");
        write_container(&good, r#"{"version":5}"#, &blobs, &BTreeMap::new(), "t").unwrap();

        let tampered = dir.join("bad.sindri");
        {
            let mut zin = zip::ZipArchive::new(File::open(&good).unwrap()).unwrap();
            let mut zout = zip::ZipWriter::new(File::create(&tampered).unwrap());
            let opts = SimpleFileOptions::default();
            for i in 0..zin.len() {
                let mut e = zin.by_index(i).unwrap();
                let name = e.name().to_string();
                let mut payload = Vec::new();
                e.read_to_end(&mut payload).unwrap();
                if name.starts_with("geom/") {
                    payload = vec![9u8; payload.len()]; // same size, different bytes
                }
                zout.start_file(&name, opts).unwrap();
                zout.write_all(&payload).unwrap();
            }
            zout.finish().unwrap();
        }

        let out = dir.join("blobs");
        let err = read_container(&tampered, &out, None).unwrap_err();
        assert!(err.contains("does not match"), "unexpected message: {err}");
        assert!(
            !out.join(format!("{h}.bbrep")).exists(),
            "a mismatching blob must never be published"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncated_file_is_refused_not_crashed_on() {
        let dir = tmpdir("trunc");
        let data = vec![3u8; 50_000];
        let mut blobs = BTreeMap::new();
        blobs.insert(hash_bytes(&data), blob(&dir, "d.bin", &data));
        let good = dir.join("ok.sindri");
        write_container(&good, r#"{"version":5}"#, &blobs, &BTreeMap::new(), "t").unwrap();

        let whole = std::fs::read(&good).unwrap();
        let trunc = dir.join("trunc.sindri");
        std::fs::write(&trunc, &whole[..whole.len() / 2]).unwrap();

        assert!(read_container(&trunc, &dir.join("blobs"), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Zip-slip: an archive naming its blob `../../evil` must not write there.
    /// The destination comes from the hash WE computed, so the name is inert.
    #[test]
    fn entry_names_are_never_used_as_paths() {
        let dir = tmpdir("slip");
        let data = b"payload".repeat(100);
        let h = hash_bytes(&data);
        let evil = dir.join("evil.sindri");
        {
            let mut z = zip::ZipWriter::new(File::create(&evil).unwrap());
            let opts = SimpleFileOptions::default();
            let manifest = Manifest {
                container: 1,
                hash_alg: HASH_ALG.to_string(),
                app: String::new(),
                blobs: vec![BlobRow {
                    entry: "../../../../tmp/pwned.bbrep".into(),
                    hash: h.clone(),
                    bytes: data.len() as u64,
                }],
                meshes: vec![MeshRow {
                    entry: "m".into(),
                    key: "../../pwned".into(),
                    bytes: 1,
                }],
            };
            z.start_file(MANIFEST_NAME, opts).unwrap();
            z.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
            z.start_file(DOCUMENT_NAME, opts).unwrap();
            z.write_all(br#"{"version":5}"#).unwrap();
            z.start_file("../../../../tmp/pwned.bbrep", opts).unwrap();
            z.write_all(&data).unwrap();
            z.finish().unwrap();
        }

        let out = dir.join("blobs");
        read_container(&evil, &out, Some(&dir.join("meshes"))).unwrap();
        let names: Vec<_> = std::fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![format!("{h}.bbrep")], "nothing escaped the store");
        assert!(!is_safe_key("../../pwned"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_leaves_the_previous_file_intact() {
        let dir = tmpdir("atomic");
        let dest = dir.join("part.sindri");
        std::fs::write(&dest, b"PREVIOUS GOOD FILE").unwrap();

        let mut blobs = BTreeMap::new();
        blobs.insert("deadbeef".to_string(), PathBuf::from("/nonexistent/x"));
        assert!(write_container(&dest, r#"{"version":5}"#, &blobs, &BTreeMap::new(), "t").is_err());

        assert_eq!(std::fs::read(&dest).unwrap(), b"PREVIOUS GOOD FILE");
        let litter: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(litter.is_empty(), "temp files left behind: {litter:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_newer_container_version_says_so_plainly() {
        let dir = tmpdir("newer");
        let p = dir.join("newer.sindri");
        {
            let mut z = zip::ZipWriter::new(File::create(&p).unwrap());
            z.start_file(MANIFEST_NAME, SimpleFileOptions::default()).unwrap();
            let m = format!(
                r#"{{"container":{},"hashAlg":"{}","blobs":[],"meshes":[]}}"#,
                CONTAINER_VERSION + 1,
                HASH_ALG
            );
            z.write_all(m.as_bytes()).unwrap();
            z.finish().unwrap();
        }
        let err = read_manifest(&p).unwrap_err();
        assert!(err.contains("Update SindriCAD"), "unexpected message: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_legacy_plain_json_document_is_not_mistaken_for_a_container() {
        let dir = tmpdir("legacy");
        let p = dir.join("legacy.sindri");
        std::fs::write(&p, br#"{"version": 4, "features": []}"#).unwrap();
        assert!(!looks_like_container(&p));
        assert!(read_manifest(&p).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
