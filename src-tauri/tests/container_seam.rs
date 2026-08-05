//! End-to-end check of the Rust<->Python seam for the `.sindri` container.
//!
//! Everything else is verified on one side of the boundary: `container.rs`'s unit
//! tests round-trip synthetic bytes, and the sidecar's `test_blob_rebuild.py`
//! rebuilds from a blob the sidecar itself wrote. Neither proves the two halves
//! compose — that a blob PYTHON produced survives RUST's zip round-trip and is
//! still readable by Python afterwards. A mismatch in the hash, the filename
//! convention, or the byte handling would slip through both suites and show up
//! as "the geometry vanished" on a user's machine.
//!
//! SKIPS (rather than fails) when the sidecar venv is absent, so a Rust-only
//! checkout still runs `cargo test` clean.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn sidecar_python() -> Option<PathBuf> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("sidecar/.venv/bin/python");
    p.exists().then_some(p)
}

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sindri_seam_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Run a snippet inside the sidecar, with the blob store pointed at `blobs`.
fn py(python: &Path, blobs: &Path, code: &str) -> String {
    let sidecar = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("sidecar");
    let out = Command::new(python)
        .arg("-c")
        .arg(code)
        .current_dir(&sidecar)
        .env("SINDRI_BLOB_DIR", blobs)
        .output()
        .expect("failed to run the sidecar python");
    assert!(
        out.status.success(),
        "sidecar snippet failed:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().lines().last().unwrap_or("").to_string()
}

#[test]
fn a_python_blob_survives_the_container_and_rebuilds() {
    let Some(python) = sidecar_python() else {
        eprintln!("skipping: sidecar/.venv not present");
        return;
    };
    let dir = tmpdir("e2e");
    let blobs_a = dir.join("blobs_a"); // the "authoring machine"
    let blobs_b = dir.join("blobs_b"); // a machine that has never seen this file
    std::fs::create_dir_all(&blobs_a).unwrap();

    // 1. Python imports a real STEP assembly and stores its geometry.
    let hash = py(
        &python,
        &blobs_a,
        "import sys; sys.path.insert(0,'.'); import builder; \
         print(builder.import_geometry('fixtures/asm_nested.step','step')['geom'])",
    );
    assert_eq!(hash.len(), 32, "expected a blake2b-128 hex hash, got {hash:?}");

    // The filename convention has to match on both sides or every reference
    // dangles; assert it rather than trusting two independent format! calls.
    let blob = blobs_a.join(format!("{hash}.bbrep"));
    assert!(blob.exists(), "sidecar did not write {}", blob.display());

    // 2. Rust packages it, exactly as `container_save` does.
    let doc = format!(
        r#"{{"version":5,"parameters":{{}},"features":[{{"id":"f1","type":"import","name":"Asm","geom":"{hash}"}}]}}"#
    );
    let mut map = BTreeMap::new();
    map.insert(hash.clone(), blob);
    let dest = dir.join("part.sindri");
    sindricad_lib::container::write_container(&dest, &doc, &map, &BTreeMap::new(), "seam-test")
        .expect("write_container failed");

    // 3. Rust opens it somewhere that has never seen this geometry.
    let (got_doc, manifest) =
        sindricad_lib::container::read_container(&dest, &blobs_b, None).expect("read_container");
    assert_eq!(got_doc, doc, "document did not survive the round trip");
    assert_eq!(manifest.blobs.len(), 1);
    assert!(blobs_b.join(format!("{hash}.bbrep")).exists());

    // 4. Python rebuilds from the EXTRACTED blob, with no other geometry around.
    //    Prints the body count; asm_nested is a 7-body assembly.
    let bodies = py(
        &python,
        &blobs_b,
        &format!(
            "import sys,json; sys.path.insert(0,'.'); import builder; \
             d={{'parameters':{{}},'features':[{{'id':'f1','type':'import','name':'Asm','geom':'{hash}'}}]}}; \
             p,e,b=builder.rebuild(d); \
             print(json.dumps({{'n':len(b),'errors':[str(x) for x in e]}}))"
        ),
    );
    let v: serde_json::Value = serde_json::from_str(&bodies).expect("rebuild output");
    assert_eq!(
        v["errors"].as_array().map(|a| a.len()),
        Some(0),
        "rebuild reported errors: {}",
        v["errors"]
    );
    assert!(
        v["n"].as_u64().unwrap_or(0) > 0,
        "the extracted blob produced no bodies"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
