//! Geometry-in-Rust: consume the CAD document and build real geometry in-process
//! via the high-level `opencascade` crate, tessellating it into the render payload
//! (per-B-rep-face `faceId` mesh + edge polylines + bbox) that the frontend's
//! picker/selector depends on.
//!
//! This is the Phase-1/2 port of `sidecar/builder.py` + `sidecar/tessellate.py`
//! + `sidecar/geom_select.py`:
//!   - sketch: rectangle + circle on the BASE planes XY/XZ/YZ
//!   - extrude: prism the sketch profile, op new/join/cut via boolean union/cut
//!   - fillet / chamfer: resolve an edge selector, round/bevel those edges
//!   - mirror: part + mirror(part) about a base plane
//!   - press-pull: local surface offset of a planar/cylindrical face (true
//!     Press/Pull — the face moves and side walls follow)
//!   - every other feature type is SKIPPED (logged) so the model still renders.
//!
//! Selectors (`geom_select.py`) are NEVER stored as indices: they are queryable
//! property descriptors, re-resolved against the freshly built solid each time a
//! feature consumes them.
//!
//! The output JSON mirrors `RebuildResult` in `src/types.ts`.

use glam::{dvec3, DVec3};
use opencascade::angle::Angle;
use opencascade::primitives::{Edge, EdgeConnection, EdgeType, Face, IntoShape, Shape, Solid, SurfaceType, Wire};
use opencascade::workplane::Workplane;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mesh {
    positions: Vec<f64>, // flat [x,y,z, ...]
    indices: Vec<u32>,   // flat [i,j,k, ...] triangle triples
    face_ids: Vec<u32>,  // one B-rep face id per triangle  -> JSON "faceIds"
}

#[derive(Serialize)]
pub struct EdgeOut {
    id: String,
    points: Vec<[f64; 3]>,
}

#[derive(Serialize)]
pub struct Bbox {
    min: [f64; 3],
    max: [f64; 3],
}

/// A selector-resolution diagnostic (selector v2). Mirrors `ResolveDiag` in
/// `src/types.ts`: surfaced when a selector resolved with low confidence or took a
/// lossy / best-effort path, WITHOUT failing the build. The TS interface uses
/// `feature_id` (snake_case), so the field names map directly — no `rename_all`.
#[derive(Serialize)]
pub struct ResolveDiag {
    #[serde(skip_serializing_if = "Option::is_none")]
    feature_id: Option<String>,
    kind: &'static str,
    resolved: u32,
    confidence: f64,
    lossy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Serialize)]
pub struct RebuildResult {
    mesh: Mesh,
    edges: Vec<EdgeOut>,
    bbox: Bbox,
    // selector-resolution diagnostics (selector v2); omitted when empty so a v1
    // result is byte-identical to before.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    diagnostics: Vec<ResolveDiag>,
}

const TESSELLATION_TOLERANCE: f64 = 0.1;
const EDGE_SAMPLES: usize = 24;

/// Rust-backend rebuild. Consumes `document`, builds real geometry, and returns
/// the per-face mesh + edges + bbox. Wired as a Tauri command; the frontend's
/// `TauriGeometry` calls it as `invoke("geom_rebuild", { document })` when
/// `VITE_GEOM=rust`.
#[tauri::command]
pub fn geom_rebuild(document: serde_json::Value) -> Result<RebuildResult, String> {
    let doc: Document = serde_json::from_value(document).map_err(|e| e.to_string())?;
    let mut diagnostics: Vec<ResolveDiag> = Vec::new();
    let shape = build(&doc, &mut diagnostics)?;
    let mut result = tessellate(&shape);
    result.diagnostics = diagnostics;
    Ok(result)
}

/// Rust-backend export. Rebuilds the shape from `document` (same `build` as
/// `geom_rebuild`) and writes it to `path` in `format` ("step"/"stl"/"3mf",
/// case-insensitive). Returns the written path. Wired as a Tauri command; the
/// frontend's `TauriGeometry.export` calls it as
/// `invoke("geom_export", { document, format, path })`.
///
/// This is the Rust port of `sidecar/exporters.py`:
///   - STEP / STL use the fork's high-level `Shape::write_step` / `write_stl`
///     (build123d's `export_step` / `export_stl`).
///   - 3MF has no OCCT writer; build123d uses its `Mesher`. We instead tessellate
///     the solid and write the mesh via the `threemf` crate (a zip of 3D model
///     XML). Units are millimeters on both sides.
#[tauri::command]
pub fn geom_export(
    document: serde_json::Value,
    format: String,
    path: String,
) -> Result<String, String> {
    let doc: Document = serde_json::from_value(document).map_err(|e| e.to_string())?;
    // Export doesn't surface resolver diagnostics; discard them.
    let shape = build(&doc, &mut Vec::new())?;

    match format.to_lowercase().as_str() {
        "step" | "stp" => shape
            .write_step(&path)
            .map_err(|e| format!("STEP export failed: {e}"))?,
        "stl" => shape
            .write_stl(&path)
            .map_err(|e| format!("STL export failed: {e}"))?,
        "3mf" => write_3mf(&shape, &path)?,
        other => return Err(format!("unknown export format: {other}")),
    }

    Ok(path)
}

/// Tessellate `shape` and write it as a 3MF file. OCCT cannot write 3MF, so we
/// build a single welded mesh from the per-face triangulation (`tessellate_faces`,
/// the same source `geom_rebuild` uses for rendering) and serialize it with the
/// `threemf` crate. The 3MF default unit is millimeter, matching our model.
fn write_3mf(shape: &Shape, path: &str) -> Result<(), String> {
    use threemf::model::mesh::{Triangle, Triangles, Vertex, Vertices};
    use threemf::Mesh;

    let mut vertices: Vec<Vertex> = Vec::new();
    let mut triangles: Vec<Triangle> = Vec::new();

    // Each FaceMesh has its own vertex space; offset its indices into the shared
    // vertex list as we concatenate faces (face ids are irrelevant for export).
    let face_meshes = shape
        .tessellate_faces(TESSELLATION_TOLERANCE)
        .map_err(|e| format!("3MF tessellation failed: {e}"))?;
    for fm in face_meshes {
        let base = vertices.len();
        for p in fm.positions.chunks_exact(3) {
            vertices.push(Vertex { x: p[0], y: p[1], z: p[2] });
        }
        for tri in fm.indices.chunks_exact(3) {
            triangles.push(Triangle {
                v1: base + tri[0] as usize,
                v2: base + tri[1] as usize,
                v3: base + tri[2] as usize,
            });
        }
    }

    if triangles.is_empty() {
        return Err("nothing to export — the part has no geometry".to_string());
    }

    let mesh = Mesh {
        vertices: Vertices { vertex: vertices },
        triangles: Triangles { triangle: triangles },
    };

    let file = std::fs::File::create(path).map_err(|e| format!("3MF export failed: {e}"))?;
    threemf::write(file, mesh).map_err(|e| format!("3MF export failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Document model (mirrors src/types.ts; only the fields Phase 1 consumes).
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct Document {
    #[serde(default)]
    parameters: std::collections::HashMap<String, f64>,
    #[serde(default)]
    features: Vec<serde_json::Value>,
}

/// A `Num` is a literal number or a parameter name (resolved like builder.py's
/// `val()`). We accept either JSON shape and resolve against `parameters`.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Num {
    Lit(f64),
    Param(String),
}

impl Num {
    fn resolve(&self, params: &std::collections::HashMap<String, f64>) -> f64 {
        match self {
            Num::Lit(v) => *v,
            Num::Param(name) => *params.get(name).unwrap_or(&0.0),
        }
    }
}

/// Resolve an optional `Num` field from a JSON object, defaulting to 0.0.
fn num_field(obj: &serde_json::Value, key: &str, params: &std::collections::HashMap<String, f64>) -> f64 {
    match obj.get(key) {
        None | Some(serde_json::Value::Null) => 0.0,
        Some(v) => serde_json::from_value::<Num>(v.clone())
            .map(|n| n.resolve(params))
            .unwrap_or(0.0),
    }
}

// ---------------------------------------------------------------------------
// Build pipeline (ports sidecar/builder.py:rebuild).
// ---------------------------------------------------------------------------

/// A built sketch: the union profile face (whole-sketch extrude) — or None if the
/// sketch has no closed profile — plus the per-loop located faces (for region
/// selection) and the sketch plane's normal, which is the extrude direction
/// (build123d's `extrude(sk, amount=d)` prisms along the plane normal, NOT the
/// face's own orientation normal).
struct BuiltSketch {
    face: Option<Face>,
    /// Each closed loop of the sketch, located onto its plane, as an individual
    /// Face. Region/interior-point selection recovers nested profiles (a ring, an
    /// inner disk) from these that the unioned `face` collapses. Mirrors
    /// builder.py's `_build_sketch` "faces" list.
    loops: Vec<Face>,
    normal: DVec3,
}

fn build(doc: &Document, diags: &mut Vec<ResolveDiag>) -> Result<Shape, String> {
    let params = &doc.parameters;
    let mut sketches: std::collections::HashMap<String, BuiltSketch> = std::collections::HashMap::new();
    let mut part: Option<Shape> = None;

    for f in &doc.features {
        let t = f.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "sketch" => {
                let id = f.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                sketches.insert(id, build_sketch(f, params));
            }
            "extrude" => {
                let sketch_id = f.get("sketch").and_then(|v| v.as_str()).unwrap_or("");
                let entry = sketches
                    .get(sketch_id)
                    .ok_or_else(|| format!("extrude references unknown sketch '{sketch_id}'"))?;

                let distance = num_field(f, "distance", params);
                let dir = entry.normal * distance;

                // Region points (one per selected area) pick + combine specific
                // profiles; a ring (annulus) keeps its hole, several areas union.
                // `regions` is the list form, `region` the legacy single-point one.
                // No region points -> extrude the whole-sketch union face.
                let mut pts: Vec<DVec3> = Vec::new();
                if let Some(arr) = f.get("regions").and_then(|v| v.as_array()) {
                    for p in arr {
                        pts.push(json_point(p));
                    }
                } else if let Some(p) = f.get("region") {
                    pts.push(json_point(p));
                }

                let solid_shape: Shape = if pts.is_empty() {
                    let face = entry
                        .face
                        .as_ref()
                        .ok_or_else(|| "sketch has no closed profile to extrude".to_string())?;
                    face.extrude(dir).into_shape()
                } else {
                    // Build a solid per picked region (outer loop minus its nested
                    // holes), then union the per-region solids. Mirrors builder.py's
                    // `_region_face_at` + summed extrude.
                    let mut acc: Option<Shape> = None;
                    for p in &pts {
                        let region = region_face_at(&entry.loops, *p)
                            .ok_or_else(|| "no profile found under the selected area".to_string())?;
                        let solid = region.extrude(dir).into_shape();
                        acc = Some(match acc {
                            None => solid,
                            Some(existing) => existing.union(&solid).into(),
                        });
                    }
                    acc.ok_or_else(|| "no profile found under the selected area".to_string())?
                };

                let op = f.get("operation").and_then(|v| v.as_str()).unwrap_or("new");
                part = Some(match (&part, op) {
                    (None, _) | (_, "new") => solid_shape,
                    // `clean()` unifies coplanar faces left behind by the boolean,
                    // matching build123d's auto-unify (e.g. two abutting boxes
                    // merge their shared face -> fewer faces/edges).
                    (Some(existing), "join") => {
                        let fused: Shape = existing.union(&solid_shape).into();
                        fused.clean()
                    }
                    (Some(existing), "cut") => {
                        let cut: Shape = existing.subtract(&solid_shape).into();
                        cut.clean()
                    }
                    (Some(existing), other) => {
                        eprintln!("geom: unknown extrude operation '{other}', treating as new");
                        let _ = existing;
                        solid_shape
                    }
                });
            }
            "fillet" => {
                let existing = part
                    .as_ref()
                    .ok_or_else(|| "fillet needs an existing body".to_string())?;
                let sel = f
                    .get("edges")
                    .ok_or_else(|| "fillet missing 'edges' selector".to_string())?;
                let edges = resolve_edges(existing, sel, diags, feature_id(f))?;
                if edges.is_empty() {
                    return Err("fillet selector matched no edges".to_string());
                }
                let radius = num_field(f, "radius", params);
                part = Some(existing.fillet_edges(radius, &edges));
            }
            "chamfer" => {
                let existing = part
                    .as_ref()
                    .ok_or_else(|| "chamfer needs an existing body".to_string())?;
                let sel = f
                    .get("edges")
                    .ok_or_else(|| "chamfer missing 'edges' selector".to_string())?;
                let edges = resolve_edges(existing, sel, diags, feature_id(f))?;
                if edges.is_empty() {
                    return Err("chamfer selector matched no edges".to_string());
                }
                // build123d uses `length=` for chamfer; our doc field is "distance".
                let distance = num_field(f, "distance", params);
                part = Some(existing.chamfer_edges(distance, &edges));
            }
            "mirror" => {
                let existing = part
                    .as_ref()
                    .ok_or_else(|| "mirror needs an existing body".to_string())?;
                let plane = f.get("plane").and_then(|v| v.as_str()).unwrap_or("XZ");
                // Mirror about a base plane through the origin: the plane's normal
                // axis. XY -> Z, XZ -> Y, YZ -> X. `part + mirror(part)`.
                let normal = match plane {
                    "XY" => DVec3::Z,
                    "XZ" => DVec3::Y,
                    "YZ" => DVec3::X,
                    other => return Err(format!("unknown mirror plane '{other}'")),
                };
                let mirrored = existing.mirrored_about_plane(DVec3::ZERO, normal);
                let fused: Shape = existing.union(&mirrored).into();
                part = Some(fused.clean());
            }
            "press-pull" => {
                let existing = part
                    .as_ref()
                    .ok_or_else(|| "Press/Pull needs an existing body".to_string())?;
                let sel = f
                    .get("face")
                    .ok_or_else(|| "press-pull missing 'face' selector".to_string())?;
                let faces = resolve_faces(existing, sel, diags, feature_id(f))?;
                let face = faces
                    .first()
                    .ok_or_else(|| "no face found to press/pull".to_string())?;
                let distance = num_field(f, "distance", params);
                part = Some(press_pull(existing, face, distance)?);
            }
            "revolve" => {
                let sketch_id = f.get("sketch").and_then(|v| v.as_str()).unwrap_or("");
                let entry = sketches
                    .get(sketch_id)
                    .ok_or_else(|| format!("revolve references unknown sketch '{sketch_id}'"))?;
                let face = entry
                    .face
                    .as_ref()
                    .ok_or_else(|| "sketch has no closed profile to revolve".to_string())?;

                // Axis defaults to Z, angle to a full 360° turn — matching
                // builder.py's `revolve(sk, axis=AXES[..], revolution_arc=..)`.
                let axis = f.get("axis").and_then(|v| v.as_str()).unwrap_or("Z");
                let axis_dir = match axis {
                    "X" => DVec3::X,
                    "Y" => DVec3::Y,
                    "Z" => DVec3::Z,
                    other => return Err(format!("unknown revolve axis '{other}'")),
                };
                let angle_deg = match f.get("angle") {
                    None | Some(serde_json::Value::Null) => 360.0,
                    Some(_) => num_field(f, "angle", params),
                };
                // OCCT's `Face::revolve` takes None for a full turn; a partial arc
                // is given in radians. Revolve about the axis through the origin.
                let angle = if (angle_deg - 360.0).abs() < 1e-9 {
                    None
                } else {
                    Some(Angle::Degrees(angle_deg))
                };
                let solid = face.revolve(DVec3::ZERO, axis_dir, angle);
                part = Some(solid.into_shape());
            }
            "loft" => {
                let ids = f
                    .get("sketches")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "loft missing 'sketches' list".to_string())?;
                // Loft through each section's outer profile wire. Mirrors
                // builder.py's `loft([sketches[s] for s in f["sketches"]])`.
                let mut wires: Vec<Wire> = Vec::new();
                for id in ids {
                    let sid = id.as_str().unwrap_or("");
                    let entry = sketches
                        .get(sid)
                        .ok_or_else(|| format!("loft references unknown sketch '{sid}'"))?;
                    let face = entry
                        .face
                        .as_ref()
                        .ok_or_else(|| format!("loft section '{sid}' has no closed profile"))?;
                    wires.push(face.outer_wire());
                }
                if wires.len() < 2 {
                    return Err("loft needs at least two sections".to_string());
                }
                let solid = Solid::loft(wires.iter());
                part = Some(solid.into_shape());
            }
            // Primitive bodies (centered at the origin), mirroring builder.py's
            // Box / Cylinder / Sphere. The Rust kernel is still single-body, so a
            // primitive becomes the part if none exists yet, else it's unioned in.
            "box" => {
                let s = Shape::box_centered(
                    num_field(f, "length", params),
                    num_field(f, "width", params),
                    num_field(f, "height", params),
                );
                part = Some(merge_body(part, s));
            }
            "cylinder" => {
                let s = Shape::cylinder_centered(
                    DVec3::ZERO,
                    num_field(f, "radius", params),
                    DVec3::Z,
                    num_field(f, "height", params),
                );
                part = Some(merge_body(part, s));
            }
            "sphere" => {
                let s = Shape::sphere(num_field(f, "radius", params)).build();
                part = Some(merge_body(part, s));
            }
            // Defer/skip every other feature type so the model still renders.
            other => {
                eprintln!("geom: skipping unsupported feature type '{other}'");
            }
        }
    }

    part.ok_or_else(|| "document produced no geometry".to_string())
}

/// Add a fresh base body (a primitive) in the single-body Rust model: it becomes
/// the part if none exists yet, else it's unioned in. (The Python multi-body
/// kernel would keep it as a separate body — Rust multi-body is future work.)
fn merge_body(part: Option<Shape>, s: Shape) -> Shape {
    match part {
        None => s,
        Some(existing) => {
            let fused: Shape = existing.union(&s).into();
            fused.clean()
        }
    }
}

// ---------------------------------------------------------------------------
// Selector resolution (ports sidecar/geom_select.py).
//
// References are property descriptors re-resolved against `part` every rebuild —
// never stored indices. This is SindriCAD's topological-naming mitigation.
// ---------------------------------------------------------------------------

// --- selector-v2 scoring tolerances & weights (mirror geom_select.py) ---------
// World mm; the positional tolerance is bbox-relative so it scales with the part.
const ANG_TOL: f64 = 0.02; // ~1.1deg slack on (1 - |dot|) for dir/normal
const POS_DRIFT: f64 = 0.5; // mm of absolute positional drift budget
const REL_DRIFT: f64 = 1e-3; // + this * bbox diagonal
const LEN_REL_TOL: f64 = 0.02; // 2% on length / radius
const AREA_REL_TOL: f64 = 0.05; // 5% on area
const TIE_BAND: f64 = 0.15; // runner-up within 15% of best => a genuine tie (needs nth)
const ACCEPT_MAX: f64 = 2.5; // best cost above this => resolvable but marginal (lossy)
// per-normalized-error-term weights
const W_POS: f64 = 3.0;
const W_DIR: f64 = 2.0;
const W_LEN: f64 = 1.0;
const W_RAD: f64 = 2.0;
const W_AREA: f64 = 1.0;
const W_TYPE: f64 = 4.0;

/// The feature's `id` (used to tag resolver diagnostics), or `None`.
fn feature_id(f: &serde_json::Value) -> Option<&str> {
    f.get("id").and_then(|v| v.as_str())
}

/// Resolve an edge selector — or a JSON LIST of selectors (union, de-duplicated by
/// geometric key) — to a set of edges of `part`. Mirrors
/// `geom_select.resolve_edges`. `diags`/`fid` collect low-confidence v2 matches
/// without failing the build.
fn resolve_edges(
    part: &Shape,
    sel: &serde_json::Value,
    diags: &mut Vec<ResolveDiag>,
    fid: Option<&str>,
) -> Result<Vec<Edge>, String> {
    // A list of selectors (multi-edge fillet/chamfer): union, de-duplicated by the
    // rounded mid+length key so concentric edges (same center) are NOT collapsed.
    if let Some(list) = sel.as_array() {
        let mut seen: Vec<[i64; 4]> = Vec::new();
        let mut out: Vec<Edge> = Vec::new();
        for s in list {
            for e in resolve_edges(part, s, diags, fid)? {
                let k = edge_dedup_key(&e);
                if !seen.contains(&k) {
                    seen.push(k);
                    out.push(e);
                }
            }
        }
        return Ok(out);
    }

    let by = sel.get("by").and_then(|v| v.as_str()).unwrap_or("");
    match by {
        "axis" => {
            let axis = sel.get("axis").and_then(|v| v.as_str()).unwrap_or("Z");
            let dir = match axis {
                "X" => DVec3::X,
                "Y" => DVec3::Y,
                "Z" => DVec3::Z,
                other => return Err(format!("unknown axis '{other}'")),
            };
            // Edges parallel to the axis: |dir·edgeDir| ~ 1 (line edges only).
            Ok(part
                .edges()
                .filter(|e| {
                    e.line_direction()
                        .map(|d| d.normalize().dot(dir).abs() > 0.99)
                        .unwrap_or(false)
                })
                .collect())
        }
        "all" => Ok(part.edges().collect()),
        "nearest" => {
            let p = point_field(sel, "point")?;
            part.edges()
                .min_by(|a, b| {
                    let da = (a.center() - p).length();
                    let db = (b.center() - p).length();
                    da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|e| vec![e])
                .ok_or_else(|| "no edges to select from".to_string())
        }
        // v2: ONE edge by scored geometric fingerprint.
        "match" => {
            let fp = sel
                .get("fp")
                .ok_or_else(|| "edge match selector missing 'fp'".to_string())?;
            let tol_pos = POS_DRIFT + REL_DRIFT * bbox_diag(part);
            let edges = unique_edges(part);
            let costs: Vec<f64> = edges.iter().map(|e| edge_cost(e, fp, tol_pos)).collect();
            let keys: Vec<[i64; 4]> = edges.iter().map(edge_canon_key).collect();
            let (idx, conf, lossy, reason) = resolve_one(&costs, &keys, nth_field(sel));
            push_diag(diags, fid, "edge", idx.is_some() as u32, conf, lossy, reason);
            Ok(idx.and_then(|i| edges.into_iter().nth(i)).into_iter().collect())
        }
        // v2: all edges bounding a fingerprint-matched face.
        "ofFace" => {
            let face_fp = sel
                .get("face")
                .ok_or_else(|| "ofFace selector missing 'face'".to_string())?;
            let faces = faces_matching(part, face_fp, diags, fid, None);
            let mut seen: Vec<[i64; 4]> = Vec::new();
            let mut out: Vec<Edge> = Vec::new();
            for f in &faces {
                for e in f.edges() {
                    let k = edge_dedup_key(&e);
                    if !seen.contains(&k) {
                        seen.push(k);
                        out.push(e);
                    }
                }
            }
            Ok(out)
        }
        // v2: a seed edge + its tangent-continuous chain.
        "tangentChain" => {
            let fp = sel
                .get("seed")
                .ok_or_else(|| "tangentChain selector missing 'seed'".to_string())?;
            let tol_pos = POS_DRIFT + REL_DRIFT * bbox_diag(part);
            let edges = unique_edges(part);
            let costs: Vec<f64> = edges.iter().map(|e| edge_cost(e, fp, tol_pos)).collect();
            let keys: Vec<[i64; 4]> = edges.iter().map(edge_canon_key).collect();
            let (idx, conf, lossy, reason) = resolve_one(&costs, &keys, None);
            let seed = match idx {
                Some(i) => i,
                None => {
                    push_diag(diags, fid, "edge", 0, 0.0, true, Some("tangentChain seed not found"));
                    return Ok(Vec::new());
                }
            };
            let chain = tangent_chain(&edges, seed);
            push_diag(diags, fid, "edge", chain.len() as u32, conf, lossy, reason);
            Ok(take_indices(edges, &chain))
        }
        other => Err(format!("unknown edge selector: {other}")),
    }
}

/// Resolve a face selector to a set of faces of `part`. Mirrors
/// `geom_select.resolve_faces`.
fn resolve_faces(
    part: &Shape,
    sel: &serde_json::Value,
    diags: &mut Vec<ResolveDiag>,
    fid: Option<&str>,
) -> Result<Vec<Face>, String> {
    let by = sel.get("by").and_then(|v| v.as_str()).unwrap_or("");
    match by {
        "normal" => {
            let d = point_field(sel, "dir")?.normalize();
            // Faces whose outward normal aligns with `dir` (dot > 0.99).
            Ok(part
                .faces()
                .filter(|f| f.normal_at_center().normalize().dot(d) > 0.99)
                .collect())
        }
        "all" => Ok(part.faces().collect()),
        "nearest" => {
            // Surface distance (not center distance): a cylinder's center sits on
            // its axis, far from the clicked wall, so center-distance mis-picks.
            let p = point_field(sel, "point")?;
            part.faces()
                .min_by(|a, b| {
                    a.distance_to(p)
                        .partial_cmp(&b.distance_to(p))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|f| vec![f])
                .ok_or_else(|| "no faces to select from".to_string())
        }
        // v2: ONE face by scored geometric fingerprint.
        "match" => {
            let fp = sel
                .get("fp")
                .ok_or_else(|| "face match selector missing 'fp'".to_string())?;
            Ok(faces_matching(part, fp, diags, fid, nth_field(sel)))
        }
        other => Err(format!("unknown face selector: {other}")),
    }
}

/// Resolve a face fingerprint to (at most) one face, recording a diagnostic.
/// Shared by the face `match` selector and the edge `ofFace` selector. Mirrors
/// `geom_select._faces_matching`.
fn faces_matching(
    part: &Shape,
    fp: &serde_json::Value,
    diags: &mut Vec<ResolveDiag>,
    fid: Option<&str>,
    nth: Option<usize>,
) -> Vec<Face> {
    let tol_pos = POS_DRIFT + REL_DRIFT * bbox_diag(part);
    let faces = unique_faces(part);
    let costs: Vec<f64> = faces.iter().map(|f| face_cost(f, fp, tol_pos)).collect();
    let keys: Vec<[i64; 4]> = faces.iter().map(face_canon_key).collect();
    let (idx, conf, lossy, reason) = resolve_one(&costs, &keys, nth);
    push_diag(diags, fid, "face", idx.is_some() as u32, conf, lossy, reason);
    idx.and_then(|i| faces.into_iter().nth(i)).into_iter().collect()
}

// --- scoring primitives (mirror geom_select.py) ------------------------------

/// Bounding-box diagonal length (>=1.0), for the bbox-relative position tolerance.
fn bbox_diag(part: &Shape) -> f64 {
    let bb = opencascade::bounding_box::aabb(part);
    if bb.is_void() {
        return 1.0;
    }
    let d = (bb.max() - bb.min()).length();
    if d > 0.0 {
        d
    } else {
        1.0
    }
}

/// De-duplicate `part.edges()` by geometric key. OCCT's `Shape::edges()` yields a
/// shared edge once per incident face; the resolver must score each unique edge
/// once (as build123d's `part.edges()` does), else a clean match degrades into a
/// spurious tie against its own twin (wrong confidence + a bogus lossy flag).
fn unique_edges(part: &Shape) -> Vec<Edge> {
    let mut seen: Vec<[i64; 4]> = Vec::new();
    let mut out: Vec<Edge> = Vec::new();
    for e in part.edges() {
        let k = edge_dedup_key(&e);
        if !seen.contains(&k) {
            seen.push(k);
            out.push(e);
        }
    }
    out
}

/// De-duplicate `part.faces()` by geometric key — same per-incident duplication as
/// `unique_edges` (a face can surface more than once via the shape's iterators).
fn unique_faces(part: &Shape) -> Vec<Face> {
    let mut seen: Vec<[i64; 4]> = Vec::new();
    let mut out: Vec<Face> = Vec::new();
    for f in part.faces() {
        let k = face_dedup_key(&f);
        if !seen.contains(&k) {
            seen.push(k);
            out.push(f);
        }
    }
    out
}

fn face_dedup_key(f: &Face) -> [i64; 4] {
    let p = f.center_of_mass();
    [r4(p.x), r4(p.y), r4(p.z), r4(f.surface_area())]
}

/// Symmetric relative error, matching `_rel_err`.
fn rel_err(a: f64, b: f64) -> f64 {
    let d = a.abs().max(b.abs()).max(1e-9);
    (a - b).abs() / d
}

/// Make the first non-tiny component positive, so +dir and -dir hash the same
/// (edges are unoriented). Mirrors `_sign_normalize`.
fn sign_normalize(d: DVec3) -> DVec3 {
    for c in [d.x, d.y, d.z] {
        if c.abs() > 1e-9 {
            return if c > 0.0 { d } else { -d };
        }
    }
    d
}

/// Read a `[x,y,z]` array from a fingerprint field.
fn fp_vec3(fp: &serde_json::Value, key: &str) -> Option<DVec3> {
    let a = fp.get(key)?.as_array()?;
    if a.len() < 3 {
        return None;
    }
    Some(dvec3(a[0].as_f64()?, a[1].as_f64()?, a[2].as_f64()?))
}

fn fp_f64(fp: &serde_json::Value, key: &str) -> Option<f64> {
    fp.get(key).and_then(|v| v.as_f64())
}

fn fp_str<'a>(fp: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    fp.get(key).and_then(|v| v.as_str())
}

fn nth_field(sel: &serde_json::Value) -> Option<usize> {
    sel.get("nth").and_then(|v| v.as_u64()).map(|n| n as usize)
}

/// Coarse curve class matching `EdgeFingerprint.curve`.
fn edge_curve(e: &Edge) -> &'static str {
    match e.edge_type() {
        EdgeType::Line => "line",
        EdgeType::Circle => "circle",
        EdgeType::Ellipse => "ellipse",
        EdgeType::BezierCurve | EdgeType::BSplineCurve => "bspline",
        _ => "other",
    }
}

/// Coarse surface class matching `FaceFingerprint.surface`.
fn face_surface(f: &Face) -> &'static str {
    match f.surface_type() {
        SurfaceType::Plane => "plane",
        SurfaceType::Cylinder => "cylinder",
        SurfaceType::Cone => "cone",
        SurfaceType::Sphere => "sphere",
        SurfaceType::Torus => "torus",
        SurfaceType::BezierSurface | SurfaceType::BSplineSurface => "bspline",
        _ => "other",
    }
}

fn edge_mid(e: &Edge) -> DVec3 {
    e.position_at(0.5)
}

fn edge_dir(e: &Edge) -> DVec3 {
    sign_normalize(e.tangent_at(0.5))
}

/// Score an edge against an `EdgeFingerprint` (lower = better). Mirrors `_edge_cost`.
fn edge_cost(e: &Edge, fp: &serde_json::Value, tol_pos: f64) -> f64 {
    let mut cost =
        W_POS * (edge_mid(e) - fp_vec3(fp, "mid").unwrap_or(DVec3::ZERO)).length() / tol_pos;
    if let Some(dir) = fp_vec3(fp, "dir") {
        let dot = edge_dir(e).dot(dir.normalize()).abs(); // unoriented
        cost += W_DIR * (1.0 - dot) / ANG_TOL;
    }
    if let Some(len) = fp_f64(fp, "length") {
        cost += W_LEN * rel_err(e.length(), len) / LEN_REL_TOL;
    }
    if let Some(curve) = fp_str(fp, "curve") {
        if edge_curve(e) != curve {
            cost += W_TYPE;
        }
    }
    if edge_curve(e) == "circle" {
        if let (Some(r), Some(fr)) = (e.circle_radius(), fp_f64(fp, "radius")) {
            cost += W_RAD * rel_err(r, fr) / LEN_REL_TOL;
        }
        if let (Some(c), Some(fc)) = (e.circle_center(), fp_vec3(fp, "center")) {
            cost += W_POS * (c - fc).length() / tol_pos; // kills concentrics
        }
    }
    cost
}

/// Score a face against a `FaceFingerprint` (lower = better). Mirrors `_face_cost`.
fn face_cost(f: &Face, fp: &serde_json::Value, tol_pos: f64) -> f64 {
    let mut cost =
        W_POS * (f.center_of_mass() - fp_vec3(fp, "centroid").unwrap_or(DVec3::ZERO)).length() / tol_pos;
    if let Some(normal) = fp_vec3(fp, "normal") {
        let dot = f.normal_at_center().normalize().dot(normal.normalize()); // signed
        cost += W_DIR * (1.0 - dot) / ANG_TOL;
    }
    if let Some(area) = fp_f64(fp, "area") {
        cost += W_AREA * rel_err(f.surface_area(), area) / AREA_REL_TOL;
    }
    if let Some(surface) = fp_str(fp, "surface") {
        if face_surface(f) != surface {
            cost += W_TYPE;
        }
    }
    if let Some(fr) = fp_f64(fp, "radius") {
        if let Some(r) = f.cylinder_radius() {
            cost += W_RAD * rel_err(r, fr) / LEN_REL_TOL;
        }
    }
    cost
}

/// Rebuild-stable canonical key (rounded mid + length, ×1e3) for tie-break order.
/// Mirrors `_canonical_key_edge`.
fn edge_canon_key(e: &Edge) -> [i64; 4] {
    let p = edge_mid(e);
    [r3(p.x), r3(p.y), r3(p.z), r3(e.length())]
}

/// List de-dup key (rounded mid + length, ×1e4) — keeps concentric edges (same
/// center, different length). Mirrors `_edge_dedup_key`.
fn edge_dedup_key(e: &Edge) -> [i64; 4] {
    let p = edge_mid(e);
    [r4(p.x), r4(p.y), r4(p.z), r4(e.length())]
}

fn face_canon_key(f: &Face) -> [i64; 4] {
    let p = f.center_of_mass();
    [r3(p.x), r3(p.y), r3(p.z), r3(f.surface_area())]
}

fn r3(v: f64) -> i64 {
    (v * 1e3).round() as i64
}
fn r4(v: f64) -> i64 {
    (v * 1e4).round() as i64
}

/// Pick the lowest-cost candidate by INDEX (best-effort, never fails). A near-tie
/// (runner-up within `TIE_BAND`) is broken by `nth` over the canonical key order.
/// Returns `(index, confidence, lossy, reason)`. Mirrors `_resolve_one`.
fn resolve_one(
    costs: &[f64],
    keys: &[[i64; 4]],
    nth: Option<usize>,
) -> (Option<usize>, f64, bool, Option<&'static str>) {
    if costs.is_empty() {
        return (None, 0.0, true, Some("no candidates on this body"));
    }
    let mut order: Vec<usize> = (0..costs.len()).collect();
    order.sort_by(|&a, &b| costs[a].partial_cmp(&costs[b]).unwrap_or(std::cmp::Ordering::Equal));
    let best = order[0];
    let best_cost = costs[best];
    let runner = if order.len() > 1 { costs[order[1]] } else { f64::INFINITY };
    let margin = if runner.is_finite() {
        (runner - best_cost) / (runner + 1e-9)
    } else {
        1.0
    };

    if margin < TIE_BAND {
        let mut tied: Vec<usize> = order
            .iter()
            .copied()
            .filter(|&i| (costs[i] - best_cost) / (runner + 1e-9) < TIE_BAND)
            .collect();
        tied.sort_by(|&a, &b| keys[a].cmp(&keys[b]));
        let idx = nth.filter(|&k| k < tied.len()).unwrap_or(0);
        let reason = if nth.is_some() { "tie broken by nth" } else { "tie; canonical-first" };
        return (Some(tied[idx]), margin, nth.is_none(), Some(reason));
    }

    let lossy = best_cost > ACCEPT_MAX;
    (Some(best), margin, lossy, if lossy { Some("marginal match") } else { None })
}

/// Append a diagnostic only when the match is lossy or low-confidence (<0.5),
/// matching `_push_diag`.
fn push_diag(
    diags: &mut Vec<ResolveDiag>,
    fid: Option<&str>,
    kind: &'static str,
    resolved: u32,
    confidence: f64,
    lossy: bool,
    reason: Option<&'static str>,
) {
    if !(lossy || confidence < 0.5) {
        return;
    }
    diags.push(ResolveDiag {
        feature_id: fid.map(|s| s.to_string()),
        kind,
        resolved,
        confidence: (confidence * 1e3).round() / 1e3,
        lossy,
        reason: reason.map(|s| s.to_string()),
    });
}

/// Take the edges at `idxs` (in order) out of `edges` by ownership. `idxs` must be
/// unique (tangent_chain guarantees it).
fn take_indices(edges: Vec<Edge>, idxs: &[usize]) -> Vec<Edge> {
    let mut slots: Vec<Option<Edge>> = edges.into_iter().map(Some).collect();
    idxs.iter()
        .filter_map(|&i| slots.get_mut(i).and_then(|s| s.take()))
        .collect()
}

/// Grow a tangent-continuous chain from the seed index: edges connected through a
/// shared endpoint whose tangents are collinear within `ANG_TOL`. Best-effort BFS
/// (OCCT has no tangent walker). Visited tracked by INDEX — safe here because every
/// edge appears once in `edges` and the seed is an index into that same list (the
/// build123d-identity gotcha that forces geometric keys in the sidecar doesn't bite
/// when we never cross two separate edge collections). Mirrors `_tangent_chain`.
fn tangent_chain(edges: &[Edge], seed: usize) -> Vec<usize> {
    let ends: Vec<(DVec3, DVec3)> =
        edges.iter().map(|e| (e.start_point(), e.end_point())).collect();
    let tangent_at_point = |e: &Edge, p: DVec3| -> DVec3 {
        let (a, b) = (e.start_point(), e.end_point());
        let t = if (a - p).length() < (b - p).length() {
            e.tangent_at(0.0)
        } else {
            e.tangent_at(1.0)
        };
        sign_normalize(t)
    };

    let mut seen = vec![false; edges.len()];
    seen[seed] = true;
    let mut chain = vec![seed];
    let mut frontier = vec![seed];
    while let Some(cur) = frontier.pop() {
        let (a, b) = ends[cur];
        for i in 0..edges.len() {
            if seen[i] {
                continue;
            }
            let (ea, eb) = ends[i];
            for shared in [a, b] {
                if (ea - shared).length() < 1e-6 || (eb - shared).length() < 1e-6 {
                    if tangent_at_point(&edges[cur], shared)
                        .dot(tangent_at_point(&edges[i], shared))
                        .abs()
                        > 1.0 - ANG_TOL
                    {
                        seen[i] = true;
                        chain.push(i);
                        frontier.push(i);
                    }
                    break;
                }
            }
        }
    }
    chain
}

/// Read a `[x, y, z]` point/direction array from a selector field.
fn point_field(sel: &serde_json::Value, key: &str) -> Result<DVec3, String> {
    let arr = sel
        .get(key)
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("selector missing '{key}' array"))?;
    if arr.len() < 3 {
        return Err(format!("selector '{key}' needs 3 components"));
    }
    let c = |i: usize| arr[i].as_f64().unwrap_or(0.0);
    Ok(dvec3(c(0), c(1), c(2)))
}

// ---------------------------------------------------------------------------
// Press/Pull (ports sidecar/builder.py:_press_pull + clamps + _offset_face).
// ---------------------------------------------------------------------------

/// Push/pull a single solid face by signed distance `d` (mm). Planar and
/// cylindrical faces use OCCT's local surface offset (the picked face moves along
/// its normal, side walls follow). Offsets are clamped away from degeneracy
/// (collapsing a hole's radius / pushing a face through the body), which would
/// otherwise crash OCCT. Other curved faces are rejected with a clean error.
fn press_pull(part: &Shape, face: &Face, d: f64) -> Result<Shape, String> {
    if d.abs() < 1e-9 {
        return Ok(clone_shape(part));
    }
    match face.surface_type() {
        SurfaceType::Plane => {
            let d = clamp_planar(part, face, d);
            part.offset_face(face, d).map_err(|e| e.to_string())
        }
        SurfaceType::Cylinder => {
            let d = clamp_cylinder(face, d);
            part.offset_face(face, d).map_err(|e| e.to_string())
        }
        _ => Err("Press/Pull supports flat and cylindrical faces only".to_string()),
    }
}

/// Cap `|d|` to 90% of the cylinder radius so an inward offset can't collapse the
/// radius to ~0 (which segfaults OCCT). Mirrors `_clamp_cylinder`.
fn clamp_cylinder(face: &Face, d: f64) -> f64 {
    match face.cylinder_radius() {
        Some(r) if r > 1e-6 => {
            let limit = 0.9 * r;
            d.clamp(-limit, limit)
        }
        _ => d,
    }
}

/// For an inward push (−, toward the body), cap it to 90% of the body's extent
/// along the face normal so the face can't be pushed clean through. Mirrors
/// `_clamp_planar`.
fn clamp_planar(part: &Shape, face: &Face, d: f64) -> f64 {
    if d >= 0.0 {
        return d; // pulling outward is always safe
    }
    let n = face.normal_at_center().normalize();
    // Project every vertex onto the face normal; thickness is the spread.
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut any = false;
    for v in part.faces() {
        for e in v.edges() {
            for p in [e.start_point(), e.end_point()] {
                let proj = p.dot(n);
                lo = lo.min(proj);
                hi = hi.max(proj);
                any = true;
            }
        }
    }
    if !any {
        return d;
    }
    let thickness = hi - lo;
    if thickness > 1e-6 {
        d.max(-0.9 * thickness)
    } else {
        d
    }
}

/// Make an owned copy of a shape (the high-level crate has no `Clone`; round-trip
/// through a no-op translation). Used for the press-pull `d == 0` early return.
fn clone_shape(shape: &Shape) -> Shape {
    shape.translated(DVec3::ZERO)
}

/// Build a sketch's profile on its plane. Handles the BASE planes (XY/XZ/YZ) and
/// derived PlaneDef planes ({origin, normal, xdir}). Primitives (rectangle,
/// circle) plus free-form curves (line, arc, spline) are supported: free-form
/// edges are assembled into closed wires -> faces, so an interactively-drawn
/// polyline / arc / spline profile extrudes like in mainstream MCAD. Construction geometry
/// is skipped. Returns the unioned profile face (whole-sketch extrude) plus each
/// closed loop located onto the plane (region selection).
fn build_sketch(f: &serde_json::Value, params: &std::collections::HashMap<String, f64>) -> BuiltSketch {
    let wp = match plane_of(f.get("plane"), params) {
        Some(wp) => wp,
        None => {
            eprintln!("geom: skipping sketch on unrecognized plane");
            return BuiltSketch { face: None, loops: Vec::new(), normal: DVec3::Z };
        }
    };
    let normal = wp.normal();

    let empty = vec![];
    let entities = f.get("entities").and_then(|v| v.as_array()).unwrap_or(&empty);

    let mut faces: Vec<Face> = Vec::new();
    let mut edges: Vec<Edge> = Vec::new(); // free-form line/arc/spline edges
    for e in entities {
        if e.get("construction").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue; // construction geometry is reference-only, not a profile
        }
        let et = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match et {
            "rectangle" => {
                let x = num_field(e, "x", params);
                let y = num_field(e, "y", params);
                let w = num_field(e, "width", params);
                let h = num_field(e, "height", params);
                faces.push(rect_face(&wp, x, y, w, h));
            }
            "circle" => {
                let x = num_field(e, "x", params);
                let y = num_field(e, "y", params);
                let r = num_field(e, "radius", params);
                faces.push(wp.circle(x, y, r).to_face());
            }
            "line" => {
                let p1 = wp.to_world_pos(dvec3(num_field(e, "x1", params), num_field(e, "y1", params), 0.0));
                let p2 = wp.to_world_pos(dvec3(num_field(e, "x2", params), num_field(e, "y2", params), 0.0));
                edges.push(Edge::segment(p1, p2));
            }
            "arc" => {
                // 3-point arc: start -> through (mx,my) -> end.
                let p1 = wp.to_world_pos(dvec3(num_field(e, "x1", params), num_field(e, "y1", params), 0.0));
                let pm = wp.to_world_pos(dvec3(num_field(e, "mx", params), num_field(e, "my", params), 0.0));
                let p2 = wp.to_world_pos(dvec3(num_field(e, "x2", params), num_field(e, "y2", params), 0.0));
                edges.push(Edge::arc(p1, pm, p2));
            }
            "spline" => {
                let pts: Vec<DVec3> = e
                    .get("points")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .map(|p| wp.to_world_pos(dvec3(num_field(p, "x", params), num_field(p, "y", params), 0.0)))
                            .collect()
                    })
                    .unwrap_or_default();
                if pts.len() >= 2 {
                    edges.push(Edge::spline_from_points(pts, None));
                }
            }
            other => {
                eprintln!("geom: skipping sketch entity type '{other}'");
            }
        }
    }

    // Assemble free-form edges into closed-loop faces (builder.py `_faces_from_edges`).
    if !edges.is_empty() {
        faces.extend(faces_from_edges(edges));
    }

    if faces.is_empty() {
        return BuiltSketch { face: None, loops: Vec::new(), normal };
    }

    // The per-loop located faces (already on the plane) for region selection.
    // `clone` via a no-op translate since Face isn't Clone.
    let loops: Vec<Face> = faces.iter().map(clone_face).collect();

    // Union the profile faces into one (a circle inside a rectangle becomes a
    // ring; disjoint loops union), matching builder.py's `sk = faces[0] + ...`.
    let face = combine_faces(faces);
    BuiltSketch { face: Some(face), loops, normal }
}

/// Resolve a sketch's plane spec to a `Workplane`. A string id selects a BASE
/// plane (XY/XZ/YZ); an object {origin, normal, xdir} builds a derived plane
/// (sketch-on-face / offset plane), mirroring builder.py's `_plane_of`.
fn plane_of(spec: Option<&serde_json::Value>, params: &std::collections::HashMap<String, f64>) -> Option<Workplane> {
    match spec {
        Some(serde_json::Value::String(s)) => match s.as_str() {
            "XY" => Some(Workplane::xy()),
            "XZ" => Some(Workplane::xz()),
            "YZ" => Some(Workplane::yz()),
            _ => None,
        },
        Some(obj @ serde_json::Value::Object(_)) => {
            let origin = obj.get("origin").map(|v| json_point(v))?;
            let normal = obj.get("normal").map(|v| json_point(v))?;
            let xdir = obj.get("xdir").map(|v| json_point(v))?;
            let _ = params; // PlaneDef components are literals in the document
            let mut wp = Workplane::new(xdir, normal);
            wp.set_translation(origin);
            Some(wp)
        }
        _ => None,
    }
}

/// Read a `[x, y, z]` array from JSON into a DVec3 (missing components -> 0).
fn json_point(v: &serde_json::Value) -> DVec3 {
    let arr = match v.as_array() {
        Some(a) => a,
        None => return DVec3::ZERO,
    };
    let c = |i: usize| arr.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0);
    dvec3(c(0), c(1), c(2))
}

/// Assemble free-form edges into faces from their closed loops. Connects edges
/// sharing exact endpoints into wires (OCCT `ConnectEdgesToWires`), keeps the
/// closed ones, and turns each into a face. Mirrors builder.py's
/// `_faces_from_edges` (`Wire.combine` + closed filter + `_face_from_wire`).
fn faces_from_edges(edges: Vec<Edge>) -> Vec<Face> {
    // Build a wire from the edges in document order (they're drawn connected
    // end-to-end). BRepBuilderAPI_MakeWire connects edges by coincident vertices
    // with its own tolerance — the same path the fork's bottle example uses with
    // arcs. If the edges happen to be unordered, fall back to topological
    // connection (build123d's tolerance-based `Wire.combine`).
    let wire = Wire::from_edges(edges.iter());
    if wire.is_closed() {
        return vec![wire.to_face()];
    }
    let reconnected = Wire::from_unordered_edges(edges.iter(), EdgeConnection::default());
    if reconnected.is_closed() {
        return vec![reconnected.to_face()];
    }
    eprintln!("geom: free-form sketch edges do not form a closed loop; skipping");
    Vec::new()
}

/// Pick the region containing `p` (smallest-area located loop that contains it)
/// and cut out its nested holes (a loop strictly inside it becomes a hole, so
/// concentric circles give a ring). Falls back to the nearest loop by center when
/// `p` is inside none. Mirrors builder.py's `_region_face_at`.
fn region_face_at(loops: &[Face], p: DVec3) -> Option<Face> {
    if loops.is_empty() {
        return None;
    }
    let containing: Vec<&Face> = loops.iter().filter(|fc| fc.contains_point(p)).collect();

    let outer: &Face = if containing.is_empty() {
        // Robustness: nearest loop by center when the point isn't inside any.
        loops
            .iter()
            .min_by(|a, b| {
                let da = (a.center_of_mass() - p).length();
                let db = (b.center_of_mass() - p).length();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap()
    } else {
        // Smallest-area containing loop is the region's outer boundary.
        containing
            .into_iter()
            .min_by(|a, b| a.surface_area().partial_cmp(&b.surface_area()).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap()
    };

    let outer_area = outer.surface_area();
    // Collect the holes: smaller loops whose center lies inside the outer loop.
    let holes: Vec<&Face> = loops
        .iter()
        .filter(|fc| !std::ptr::eq(*fc, outer))
        .filter(|fc| fc.surface_area() < outer_area && outer.contains_point(fc.center_of_mass()))
        .collect();

    if holes.is_empty() {
        return Some(clone_face(outer));
    }

    let mut result: Shape = clone_face(outer).into_shape();
    for hole in holes {
        result = result.subtract(&clone_face(hole).into_shape()).into();
    }
    // The outer-minus-holes boolean yields a single ring Face (wrapped in a
    // compound), so pull it out rather than expecting a bare Face.
    result_to_single_face(result)
}

/// Make an owned copy of a Face (so it can be consumed in two places).
fn clone_face(face: &Face) -> Face {
    face.clone()
}

/// Build a rectangle face centered at local (x, y) on the workplane, sized w×h.
/// Matches build123d's `Pos(x,y) * Rectangle(w,h)` (Rectangle is origin-centered).
fn rect_face(wp: &Workplane, x: f64, y: f64, w: f64, h: f64) -> Face {
    let hw = w / 2.0;
    let hh = h / 2.0;
    let p1 = wp.to_world_pos(dvec3(x - hw, y + hh, 0.0));
    let p2 = wp.to_world_pos(dvec3(x + hw, y + hh, 0.0));
    let p3 = wp.to_world_pos(dvec3(x + hw, y - hh, 0.0));
    let p4 = wp.to_world_pos(dvec3(x - hw, y - hh, 0.0));

    let top = Edge::segment(p1, p2);
    let right = Edge::segment(p2, p3);
    let bottom = Edge::segment(p3, p4);
    let left = Edge::segment(p4, p1);

    Wire::from_edges([&top, &right, &bottom, &left]).to_face()
}

/// Combine the sketch's loop faces into one profile. A loop fully contained in
/// another becomes a hole (concentric circle in a rectangle -> ring), like
/// build123d's `+` on the located faces; disjoint loops union. We sort by area
/// descending and subtract each smaller contained loop from its container.
fn combine_faces(faces: Vec<Face>) -> Face {
    if faces.len() == 1 {
        return faces.into_iter().next().unwrap();
    }

    let mut indexed: Vec<(f64, DVec3, Face)> = faces
        .into_iter()
        .map(|f| (f.surface_area(), f.center_of_mass(), f))
        .collect();
    // Largest loop is the outer boundary.
    indexed.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut iter = indexed.into_iter();
    let (outer_area, _outer_center, outer) = iter.next().unwrap();
    let mut result: Shape = outer.into_shape();
    for (area, _center, f) in iter {
        let f_shape = f.into_shape();
        if area < outer_area {
            // Smaller loop -> treat as a hole / overlap and cut it out.
            result = result.subtract(&f_shape).into();
        } else {
            result = result.union(&f_shape).into();
        }
    }
    result_to_single_face(result)
        .expect("combine_faces: profile boolean produced no face")
}

/// Reduce a boolean result to its single profile Face. A face-vs-face boolean
/// (subtract/union) yields a Compound wrapping one face (a ring keeps its hole as
/// an inner wire of that one face), so `Shape::as_face` returns None — pull the
/// face out of the compound instead.
fn result_to_single_face(shape: Shape) -> Option<Face> {
    shape.as_face().or_else(|| shape.faces().next())
}

// ---------------------------------------------------------------------------
// Tessellation (ports sidecar/tessellate.py via the fork helpers).
// ---------------------------------------------------------------------------

fn tessellate(shape: &Shape) -> RebuildResult {
    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut face_ids: Vec<u32> = Vec::new();

    if let Ok(face_meshes) = shape.tessellate_faces(TESSELLATION_TOLERANCE) {
        for fm in face_meshes {
            let base = (positions.len() / 3) as u32;
            positions.extend_from_slice(&fm.positions);
            for tri in fm.indices.chunks_exact(3) {
                indices.push(base + tri[0]);
                indices.push(base + tri[1]);
                indices.push(base + tri[2]);
                face_ids.push(fm.face_id);
            }
        }
    }

    let edges = shape
        .edge_polylines(EDGE_SAMPLES)
        .into_iter()
        .map(|e| EdgeOut {
            id: e.id,
            points: e.points.into_iter().map(|p| [p.x, p.y, p.z]).collect(),
        })
        .collect();

    let bb = opencascade::bounding_box::aabb(shape);
    // A void box (empty geometry) has no corners; report a degenerate bbox.
    let bbox = if bb.is_void() {
        Bbox { min: [0.0; 3], max: [0.0; 3] }
    } else {
        let min = bb.min();
        let max = bb.max();
        Bbox { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] }
    };

    RebuildResult { mesh: Mesh { positions, indices, face_ids }, edges, bbox, diagnostics: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A 20×20×10 box document (rectangle on XY, extruded 10) — shared by the
    /// rebuild and export tests.
    fn box_doc() -> serde_json::Value {
        json!({
            "parameters": {},
            "features": [
                { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "rectangle", "width": 20, "height": 20 }
                ]},
                { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" }
            ]
        })
    }

    /// Export the box to STEP / STL / 3MF in a temp dir; each file must exist and
    /// be non-empty, with format-specific sanity checks: STEP carries the
    /// ISO-10303 header, 3MF is a zip (PK magic) holding the 3D model XML. Mirrors
    /// `sidecar/exporters.py`'s three formats.
    #[test]
    fn export_box_step_stl_3mf() {
        let dir = std::env::temp_dir().join(format!("verxa_export_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let step = dir.join("box.step");
        let stl = dir.join("box.stl");
        let mf = dir.join("box.3mf");

        let step_s = step.to_string_lossy().into_owned();
        let stl_s = stl.to_string_lossy().into_owned();
        let mf_s = mf.to_string_lossy().into_owned();

        assert_eq!(geom_export(box_doc(), "step".into(), step_s.clone()).unwrap(), step_s);
        assert_eq!(geom_export(box_doc(), "stl".into(), stl_s.clone()).unwrap(), stl_s);
        assert_eq!(geom_export(box_doc(), "3mf".into(), mf_s.clone()).unwrap(), mf_s);

        let step_bytes = std::fs::read(&step).unwrap();
        let stl_bytes = std::fs::read(&stl).unwrap();
        let mf_bytes = std::fs::read(&mf).unwrap();

        assert!(!step_bytes.is_empty(), "STEP file is empty");
        assert!(!stl_bytes.is_empty(), "STL file is empty");
        assert!(!mf_bytes.is_empty(), "3MF file is empty");

        let step_text = String::from_utf8_lossy(&step_bytes);
        assert!(step_text.contains("ISO-10303"), "STEP missing ISO-10303 header");

        // 3MF is a zip archive (local-file-header magic "PK\x03\x04"). Verify the
        // magic and that the central directory references the 3D model part.
        assert_eq!(&mf_bytes[..2], b"PK", "3MF is not a zip archive");
        let mf_text = String::from_utf8_lossy(&mf_bytes);
        assert!(mf_text.contains("3D/model.model"), "3MF missing 3D model part");

        // case-insensitivity + unknown-format error path.
        assert!(geom_export(box_doc(), "STL".into(), stl_s.clone()).is_ok());
        let err = geom_export(box_doc(), "obj".into(), stl_s).unwrap_err();
        assert!(err.contains("unknown export format"), "got: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One sketch (rectangle 20×20 on XY) + one extrude (distance 10, op new)
    /// must reproduce what the Python sidecar produces for the same doc: a box —
    /// 6 B-rep faces, 12 triangles, 24 vertices, bbox spanning 20×20×10.
    #[test]
    fn rect_extrude_makes_a_box() {
        let doc = json!({
            "parameters": {},
            "features": [
                { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "rectangle", "width": 20, "height": 20 }
                ]},
                { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" }
            ]
        });

        let result = geom_rebuild(doc).expect("rebuild");
        let tris = result.mesh.indices.len() / 3;
        let verts = result.mesh.positions.len() / 3;
        let distinct: std::collections::BTreeSet<u32> =
            result.mesh.face_ids.iter().copied().collect();

        assert_eq!(result.mesh.face_ids.len(), tris, "one faceId per triangle");
        assert_eq!(distinct.len(), 6, "box has 6 distinct faces");
        assert_eq!(tris, 12, "12 triangles (2 per face)");
        assert_eq!(verts, 24, "24 per-face vertices");

        // bbox is 20×20×10 (rectangle centered at origin -> -10..10 in x,y).
        let span = [
            result.bbox.max[0] - result.bbox.min[0],
            result.bbox.max[1] - result.bbox.min[1],
            result.bbox.max[2] - result.bbox.min[2],
        ];
        assert!((span[0] - 20.0).abs() < 0.05, "x span ~20, got {}", span[0]);
        assert!((span[1] - 20.0).abs() < 0.05, "y span ~20, got {}", span[1]);
        assert!((span[2] - 10.0).abs() < 0.05, "z span ~10, got {}", span[2]);

        // 12 edges, each sampled as a polyline.
        assert_eq!(result.edges.len(), 12, "box has 12 edges");
        assert!(result.edges.iter().all(|e| e.points.len() == EDGE_SAMPLES + 1));
    }

    /// Primitive bodies (box / cylinder / sphere) build directly, mirroring
    /// builder.py's Box / Cylinder / Sphere (centered at the origin). A primitive
    /// unioned onto an existing body merges (single-body Rust kernel).
    #[test]
    fn primitives_box_cylinder_sphere() {
        let bx = geom_rebuild(json!({"parameters": {}, "features": [
            { "id": "b", "type": "box", "length": 20, "width": 20, "height": 10 }]})).expect("box");
        let distinct: std::collections::BTreeSet<u32> = bx.mesh.face_ids.iter().copied().collect();
        assert_eq!(distinct.len(), 6, "box has 6 faces");
        assert!(((bx.bbox.max[2] - bx.bbox.min[2]) - 10.0).abs() < 0.05, "box z span ~10");

        let cy = geom_rebuild(json!({"parameters": {}, "features": [
            { "id": "c", "type": "cylinder", "radius": 5, "height": 20 }]})).expect("cylinder");
        assert!(!cy.mesh.positions.is_empty(), "cylinder produced geometry");
        assert!(((cy.bbox.max[2] - cy.bbox.min[2]) - 20.0).abs() < 0.2, "cylinder z span ~20 (centered)");

        let sp = geom_rebuild(json!({"parameters": {}, "features": [
            { "id": "s", "type": "sphere", "radius": 8 }]})).expect("sphere");
        assert!(((sp.bbox.max[0] - sp.bbox.min[0]) - 16.0).abs() < 0.3, "sphere diameter ~16");

        let combo = geom_rebuild(json!({"parameters": {}, "features": [
            { "id": "b", "type": "box", "length": 20, "width": 20, "height": 20 },
            { "id": "c", "type": "cylinder", "radius": 4, "height": 40 }]})).expect("combo");
        assert!(!combo.mesh.positions.is_empty(), "box+cylinder merged geometry");
    }

    /// A circle hole cut from a rectangle plate: rectangle extrude (new) then a
    /// concentric circle extrude (cut) must leave a hole — more than 6 faces and
    /// a smaller volume than the solid box (here we just assert the cut adds the
    /// cylindrical hole face and keeps the outer bbox).
    #[test]
    fn rect_then_circle_cut_makes_a_hole() {
        let doc = json!({
            "parameters": {},
            "features": [
                { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "rectangle", "width": 20, "height": 20 }
                ]},
                { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" },
                { "id": "s2", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "circle", "radius": 5 }
                ]},
                { "id": "e2", "type": "extrude", "sketch": "s2", "distance": 10, "operation": "cut" }
            ]
        });

        let result = geom_rebuild(doc).expect("rebuild");
        let distinct: std::collections::BTreeSet<u32> =
            result.mesh.face_ids.iter().copied().collect();
        // 6 box faces + the cylindrical hole wall(s) -> strictly more than 6.
        assert!(distinct.len() > 6, "hole adds at least one face, got {}", distinct.len());

        // Outer bbox unchanged at 20×20×10 (loose tolerance: OCCT's `Bnd_Box`
        // adds a small `gap` on curved geometry, ~0.04/side here).
        let span_x = result.bbox.max[0] - result.bbox.min[0];
        let span_z = result.bbox.max[2] - result.bbox.min[2];
        assert!((span_x - 20.0).abs() < 0.1, "x span ~20, got {span_x}");
        assert!((span_z - 10.0).abs() < 0.1, "z span ~10, got {span_z}");
    }

    /// Cross-check harness: print mesh/edge/bbox stats for several docs so they
    /// can be diffed against the Python sidecar. Run with:
    ///   cargo test geom::tests::xcheck -- --ignored --nocapture
    #[test]
    #[ignore]
    fn xcheck() {
        let cases = [
            ("XZ_rect", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XZ","entities":[{"type":"rectangle","width":20,"height":20}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":10,"operation":"new"}]})),
            ("YZ_rect", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"YZ","entities":[{"type":"rectangle","width":20,"height":20}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":10,"operation":"new"}]})),
            ("rect_circle_cut", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XY","entities":[{"type":"rectangle","width":20,"height":20}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":10,"operation":"new"},
                {"id":"s2","type":"sketch","plane":"XY","entities":[{"type":"circle","radius":5}]},
                {"id":"e2","type":"extrude","sketch":"s2","distance":10,"operation":"cut"}]})),
            ("circle_only", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XY","entities":[{"type":"circle","radius":5}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":10,"operation":"new"}]})),
            ("join_two", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XY","entities":[{"type":"rectangle","width":20,"height":20}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":10,"operation":"new"},
                {"id":"s2","type":"sketch","plane":"XY","entities":[{"type":"rectangle","width":10,"height":10,"x":15}]},
                {"id":"e2","type":"extrude","sketch":"s2","distance":10,"operation":"join"}]})),
            // Phase 3 cross-check cases (compare against /tmp/xcheck_phase3.py output).
            ("polyline_square", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XY","entities":[
                    {"type":"line","x1":0,"y1":0,"x2":20,"y2":0},
                    {"type":"line","x1":20,"y1":0,"x2":20,"y2":20},
                    {"type":"line","x1":20,"y1":20,"x2":0,"y2":20},
                    {"type":"line","x1":0,"y1":20,"x2":0,"y2":0}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":10,"operation":"new"}]})),
            ("arc_profile", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XY","entities":[
                    {"type":"line","x1":-10,"y1":0,"x2":10,"y2":0},
                    {"type":"arc","x1":10,"y1":0,"mx":0,"my":10,"x2":-10,"y2":0}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":5,"operation":"new"}]})),
            ("revolve_360", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XZ","entities":[{"type":"rectangle","width":4,"height":10,"x":10,"y":0}]},
                {"id":"r1","type":"revolve","sketch":"s1","axis":"Z","angle":360}]})),
            ("loft_two", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XY","entities":[{"type":"rectangle","width":20,"height":20}]},
                {"id":"s2","type":"sketch","plane":{"origin":[0,0,30],"normal":[0,0,1],"xdir":[1,0,0]},
                    "entities":[{"type":"rectangle","width":10,"height":10}]},
                {"id":"l1","type":"loft","sketches":["s1","s2"]}]})),
            ("region_inner_disk", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XY","entities":[
                    {"type":"rectangle","width":40,"height":40},{"type":"circle","radius":8}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":10,"operation":"new","regions":[[0,0,0]]}]})),
            ("region_outer_ring", json!({"parameters":{},"features":[
                {"id":"s1","type":"sketch","plane":"XY","entities":[
                    {"type":"rectangle","width":40,"height":40},{"type":"circle","radius":8}]},
                {"id":"e1","type":"extrude","sketch":"s1","distance":10,"operation":"new","regions":[[15,15,0]]}]})),
        ];
        for (name, doc) in cases {
            let r = geom_rebuild(doc).expect("rebuild");
            let distinct: std::collections::BTreeSet<u32> = r.mesh.face_ids.iter().copied().collect();
            println!(
                "{name}: verts={} tris={} distinct_faces={} edges={} bbox_min={:?} bbox_max={:?}",
                r.mesh.positions.len() / 3,
                r.mesh.indices.len() / 3,
                distinct.len(),
                r.edges.len(),
                r.bbox.min,
                r.bbox.max
            );
        }
    }

    /// Genuinely unsupported feature types (e.g. `sweep`, `shell`) are skipped,
    /// not errored: the box still builds. (sketch/extrude/fillet/chamfer/mirror/
    /// press-pull/revolve/loft/region-extrude are all implemented and tested
    /// separately.)
    #[test]
    fn unsupported_features_are_skipped() {
        let doc = json!({
            "parameters": { "len": 20 },
            "features": [
                { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "rectangle", "width": "len", "height": "len" }
                ]},
                { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" },
                { "id": "x1", "type": "sweep" },
                { "id": "x2", "type": "shell" }
            ]
        });

        let result = geom_rebuild(doc).expect("rebuild");
        let tris = result.mesh.indices.len() / 3;
        assert_eq!(tris, 12, "still a plain box (sweep/shell skipped)");
        // Parameter resolution worked: 20×20 rectangle.
        let span_x = result.bbox.max[0] - result.bbox.min[0];
        assert!((span_x - 20.0).abs() < 0.05, "param-driven width ~20, got {span_x}");
    }

    // ---------------------------------------------------------------------
    // Phase 2: selectors + fillet/chamfer/mirror/press-pull. Counts/bbox are
    // cross-checked against the Python sidecar (sidecar/builder.py) — see the
    // values inline. Tolerances are loose on curved geometry (OCCT's Bnd_Box
    // adds a small gap; tessellation node/triangle counts can differ slightly
    // between OCCT versions, so curved cases assert ranges, not exact counts).
    // ---------------------------------------------------------------------

    /// A 20×20×10 box on XY (rectangle centered at origin -> z spans 0..10).
    fn box_features() -> Vec<serde_json::Value> {
        vec![
            json!({ "id": "s1", "type": "sketch", "plane": "XY",
                    "entities": [{ "type": "rectangle", "width": 20, "height": 20 }] }),
            json!({ "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" }),
        ]
    }

    fn distinct_faces(r: &RebuildResult) -> usize {
        r.mesh.face_ids.iter().copied().collect::<std::collections::BTreeSet<u32>>().len()
    }

    /// Fillet the 4 vertical (Z-parallel) edges of a box. Python: 10 faces,
    /// 24 edges, bbox unchanged (20×20×10).
    #[test]
    fn fillet_axis_z_edges() {
        let mut features = box_features();
        features.push(json!({ "id": "f1", "type": "fillet",
            "edges": { "kind": "edge", "by": "axis", "axis": "Z" }, "radius": 2 }));
        let doc = json!({ "parameters": {}, "features": features });
        let r = geom_rebuild(doc).expect("rebuild");

        assert_eq!(distinct_faces(&r), 10, "6 box faces + 4 rounded verticals");
        assert_eq!(r.edges.len(), 24, "fillet splits the 12 edges into 24");
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_z - 10.0).abs() < 0.1, "z span ~10, got {span_z}");
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        assert!((span_x - 20.0).abs() < 0.1, "x span ~20, got {span_x}");
    }

    /// Chamfer the 4 vertical edges of a box. Python: 10 faces, 24 edges,
    /// bbox unchanged.
    #[test]
    fn chamfer_axis_z_edges() {
        let mut features = box_features();
        features.push(json!({ "id": "c1", "type": "chamfer",
            "edges": { "kind": "edge", "by": "axis", "axis": "Z" }, "distance": 2 }));
        let doc = json!({ "parameters": {}, "features": features });
        let r = geom_rebuild(doc).expect("rebuild");

        assert_eq!(distinct_faces(&r), 10, "6 box faces + 4 bevels");
        assert_eq!(r.edges.len(), 24, "chamfer splits the 12 edges into 24");
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_z - 10.0).abs() < 0.1, "z span ~10, got {span_z}");
    }

    /// Fillet ALL 12 edges of a box. Face topology is version-stable: 26 faces
    /// (6 originals + 12 edge rounds + 8 spherical corner patches), matching the
    /// Python sidecar exactly. The EDGE count differs by OCCT version — the
    /// sidecar (OCCT 7.8.1) reports 48, system OCCT 7.9.3 reports 56 because 7.9
    /// splits each corner-patch boundary into more segments. We assert the
    /// version-stable face count + bbox and bound the edge count.
    #[test]
    fn fillet_all_edges() {
        let mut features = box_features();
        features.push(json!({ "id": "f1", "type": "fillet",
            "edges": { "kind": "edge", "by": "all" }, "radius": 2 }));
        let doc = json!({ "parameters": {}, "features": features });
        let r = geom_rebuild(doc).expect("rebuild");

        assert_eq!(distinct_faces(&r), 26, "all-edge fillet of a box -> 26 faces");
        // 48 (OCCT 7.8) .. 56 (OCCT 7.9); both describe the same 26-face solid.
        assert!(
            (48..=56).contains(&r.edges.len()),
            "all-edge fillet edges in [48,56] (OCCT-version dependent), got {}",
            r.edges.len()
        );
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        assert!((span_x - 20.0).abs() < 0.1, "x span ~20, got {span_x}");
    }

    /// Mirror a box offset to y=20 about the XZ plane. Python: 12 faces,
    /// 24 edges, y spans -30..30 (the two boxes are disjoint).
    #[test]
    fn mirror_about_xz() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch", "plane": "XY",
              "entities": [{ "type": "rectangle", "width": 20, "height": 20, "y": 20 }] },
            { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" },
            { "id": "m1", "type": "mirror", "plane": "XZ" }
        ]});
        let r = geom_rebuild(doc).expect("rebuild");

        assert_eq!(distinct_faces(&r), 12, "two disjoint boxes -> 12 faces");
        assert_eq!(r.edges.len(), 24, "two disjoint boxes -> 24 edges");
        let span_y = r.bbox.max[1] - r.bbox.min[1];
        assert!((span_y - 60.0).abs() < 0.1, "y span -30..30 = 60, got {span_y}");
    }

    /// Press/Pull the top (+Z) planar face of a box outward by 5: a boss.
    /// Python: 6 faces, 12 edges, z spans 0..15 (the top moves, walls follow).
    #[test]
    fn press_pull_planar_boss() {
        let mut features = box_features();
        features.push(json!({ "id": "p1", "type": "press-pull",
            "face": { "kind": "face", "by": "normal", "dir": [0, 0, 1] }, "distance": 5 }));
        let doc = json!({ "parameters": {}, "features": features });
        let r = geom_rebuild(doc).expect("rebuild");

        assert_eq!(distinct_faces(&r), 6, "still a box (6 faces) after a planar pull");
        assert_eq!(r.edges.len(), 12, "still 12 edges");
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_z - 15.0).abs() < 0.1, "z span 0..15 = 15, got {span_z}");
    }

    /// Press/Pull the top face inward by -3: a pocket (face pushed into body).
    /// Python: 6 faces, 12 edges, z spans 0..7.
    #[test]
    fn press_pull_planar_pocket() {
        let mut features = box_features();
        features.push(json!({ "id": "p1", "type": "press-pull",
            "face": { "kind": "face", "by": "normal", "dir": [0, 0, 1] }, "distance": -3 }));
        let doc = json!({ "parameters": {}, "features": features });
        let r = geom_rebuild(doc).expect("rebuild");

        assert_eq!(distinct_faces(&r), 6, "still a box (6 faces)");
        assert_eq!(r.edges.len(), 12, "still 12 edges");
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_z - 7.0).abs() < 0.1, "z span 0..7 = 7, got {span_z}");
    }

    /// Press/Pull a cylindrical hole wall: resize the hole. The face normal
    /// points inward (toward the axis), so +2 SHRINKS the radius 5 -> 3 and
    /// -2 GROWS it 5 -> 7 (verified against the Python sidecar). Outer bbox and
    /// face/edge counts are unchanged (7 faces, 15 edges).
    #[test]
    fn press_pull_cylindrical_hole_resize() {
        let plate_with_hole = || {
            vec![
                json!({ "id": "s1", "type": "sketch", "plane": "XY",
                        "entities": [{ "type": "rectangle", "width": 40, "height": 40 }] }),
                json!({ "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" }),
                json!({ "id": "s2", "type": "sketch", "plane": "XY",
                        "entities": [{ "type": "circle", "radius": 5 }] }),
                json!({ "id": "e2", "type": "extrude", "sketch": "s2", "distance": 10, "operation": "cut" }),
            ]
        };

        // Helper: rebuild and find the (single) cylindrical face's radius.
        fn hole_radius(doc: serde_json::Value) -> f64 {
            let parsed: Document = serde_json::from_value(doc).unwrap();
            let shape = build(&parsed, &mut Vec::new()).expect("build");
            shape
                .faces()
                .find_map(|f| f.cylinder_radius())
                .expect("a cylindrical hole face")
        }

        // Baseline radius is 5.
        let base = hole_radius(json!({ "parameters": {}, "features": plate_with_hole() }));
        assert!((base - 5.0).abs() < 0.05, "baseline hole radius ~5, got {base}");

        // +2 shrinks 5 -> 3.
        let mut f_shrink = plate_with_hole();
        f_shrink.push(json!({ "id": "p1", "type": "press-pull",
            "face": { "kind": "face", "by": "nearest", "point": [5, 0, 5] }, "distance": 2 }));
        let r_shrink = hole_radius(json!({ "parameters": {}, "features": f_shrink }));
        assert!((r_shrink - 3.0).abs() < 0.05, "hole shrinks to ~3, got {r_shrink}");

        // -2 grows 5 -> 7.
        let mut f_grow = plate_with_hole();
        f_grow.push(json!({ "id": "p1", "type": "press-pull",
            "face": { "kind": "face", "by": "nearest", "point": [5, 0, 5] }, "distance": -2 }));
        let doc_grow = json!({ "parameters": {}, "features": f_grow });
        let r_grow = hole_radius(doc_grow.clone());
        assert!((r_grow - 7.0).abs() < 0.05, "hole grows to ~7, got {r_grow}");

        // Counts/outer-bbox unchanged after the resize (Python: 7 faces, 15 edges).
        let r = geom_rebuild(doc_grow).expect("rebuild");
        assert_eq!(distinct_faces(&r), 7, "plate-with-hole keeps 7 faces");
        assert_eq!(r.edges.len(), 15, "plate-with-hole keeps 15 edges");
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        assert!((span_x - 40.0).abs() < 0.1, "outer x span ~40, got {span_x}");
    }

    /// Press/Pull on a non-planar, non-cylindrical face is a clean error, not a
    /// crash. A sphere's only face is spherical, so `press_pull` must reject it.
    #[test]
    fn press_pull_rejects_other_curved_faces() {
        let sphere = Shape::sphere(5.0).build();
        let face = sphere.faces().next().expect("sphere has a face");
        let err = match press_pull(&sphere, &face, 2.0) {
            Ok(_) => panic!("press_pull should reject a spherical face"),
            Err(e) => e,
        };
        assert!(
            err.contains("flat and cylindrical faces only"),
            "expected a clean rejection, got: {err}"
        );
    }

    /// A cylindrical SIDE wall (not just a hole) is a supported press-pull face:
    /// shrinking a solid cylinder's wall keeps it a solid cylinder.
    #[test]
    fn press_pull_cylindrical_side_wall_supported() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch", "plane": "XY",
              "entities": [{ "type": "circle", "radius": 5 }] },
            { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" },
            { "id": "p1", "type": "press-pull",
              "face": { "kind": "face", "by": "nearest", "point": [5, 0, 5] }, "distance": -1 }
        ]});
        let r = geom_rebuild(doc).expect("cylindrical side press-pull is supported");
        assert!(distinct_faces(&r) >= 3, "still a cylinder-ish solid");
    }

    // ---------------------------------------------------------------------
    // Phase 3: free-form curves, revolve, loft, region extrude, derived
    // planes. Counts/bbox are cross-checked against the Python sidecar
    // (sidecar/builder.py, OCCT 7.8.1 vs the Rust path's OCCT 7.9.3). Face
    // count + bbox are version-stable and asserted exactly; tessellation
    // node/triangle counts on curved geometry can differ slightly so we keep
    // those loose. The cross-check numbers are inline per test.
    // ---------------------------------------------------------------------

    /// A closed polyline (4 line segments) -> a 20×20 square profile, extruded 10.
    /// Python: 6 faces, 12 edges, bbox 0..20 / 0..20 / 0..10 (same as a box).
    #[test]
    fn polyline_square_extrude() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                { "type": "line", "x1": 0, "y1": 0, "x2": 20, "y2": 0 },
                { "type": "line", "x1": 20, "y1": 0, "x2": 20, "y2": 20 },
                { "type": "line", "x1": 20, "y1": 20, "x2": 0, "y2": 20 },
                { "type": "line", "x1": 0, "y1": 20, "x2": 0, "y2": 0 }
            ]},
            { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" }
        ]});
        let r = geom_rebuild(doc).expect("rebuild");
        assert_eq!(distinct_faces(&r), 6, "closed polyline square -> 6 faces");
        assert_eq!(r.edges.len(), 12, "square prism -> 12 edges");
        let span = [
            r.bbox.max[0] - r.bbox.min[0],
            r.bbox.max[1] - r.bbox.min[1],
            r.bbox.max[2] - r.bbox.min[2],
        ];
        assert!((span[0] - 20.0).abs() < 0.05, "x span ~20, got {}", span[0]);
        assert!((span[1] - 20.0).abs() < 0.05, "y span ~20, got {}", span[1]);
        assert!((span[2] - 10.0).abs() < 0.05, "z span ~10, got {}", span[2]);
    }

    /// A profile that mixes a straight base line with a 3-point arc (a "D" half-
    /// disk): line from (-10,0) to (10,0), arc back through (0,10). Python: 4
    /// faces, 6 edges, bbox x -10..10, y 0..10, z 0..5.
    #[test]
    fn arc_profile_extrude() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                { "type": "line", "x1": -10, "y1": 0, "x2": 10, "y2": 0 },
                { "type": "arc", "x1": 10, "y1": 0, "mx": 0, "my": 10, "x2": -10, "y2": 0 }
            ]},
            { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new" }
        ]});
        let r = geom_rebuild(doc).expect("rebuild");
        assert_eq!(distinct_faces(&r), 4, "arc half-disk prism -> 4 faces (Python: 4)");
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        let span_y = r.bbox.max[1] - r.bbox.min[1];
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_x - 20.0).abs() < 0.1, "x span ~20, got {span_x}");
        assert!((span_y - 10.0).abs() < 0.2, "y span ~10 (arc apex), got {span_y}");
        assert!((span_z - 5.0).abs() < 0.15, "z span ~5, got {span_z}");
    }

    /// A spline-topped profile closed by a base line, extruded. The spline fits
    /// (-10,0)->(-5,8)->(5,8)->(10,0). Python: 4 faces, 6 edges; the apex y is
    /// ~9.09 (spline overshoots the control points). We assert the version-stable
    /// face count + the x span and a sane positive y apex.
    #[test]
    fn spline_profile_extrude() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                { "type": "spline", "points": [
                    { "x": -10, "y": 0 }, { "x": -5, "y": 8 },
                    { "x": 5, "y": 8 }, { "x": 10, "y": 0 } ] },
                { "type": "line", "x1": 10, "y1": 0, "x2": -10, "y2": 0 }
            ]},
            { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new" }
        ]});
        let r = geom_rebuild(doc).expect("rebuild");
        assert_eq!(distinct_faces(&r), 4, "spline-topped prism -> 4 faces (Python: 4)");
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        let span_y = r.bbox.max[1] - r.bbox.min[1];
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_x - 20.0).abs() < 0.25, "x span ~20, got {span_x}");
        // Python apex ~9.09; allow a band (curved meshing differs by OCCT version).
        assert!((8.5..9.7).contains(&span_y), "spline apex y in [8.5,9.7], got {span_y}");
        assert!((span_z - 5.0).abs() < 0.25, "z span ~5, got {span_z}");
    }

    /// Revolve a 4×10 rectangle (centered at x=10 on the XZ plane) a full 360°
    /// about the Z axis -> a tube/ring (annulus of revolution). Python: 4 faces
    /// (inner + outer cylinder, top + bottom ring), 6 edges, bbox -12..12 in x,y,
    /// -5..5 in z.
    #[test]
    fn revolve_rect_full_turn() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch", "plane": "XZ",
              "entities": [{ "type": "rectangle", "width": 4, "height": 10, "x": 10, "y": 0 }] },
            { "id": "r1", "type": "revolve", "sketch": "s1", "axis": "Z", "angle": 360 }
        ]});
        let r = geom_rebuild(doc).expect("rebuild");
        assert_eq!(distinct_faces(&r), 4, "full revolve tube -> 4 faces (Python: 4)");
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        let span_y = r.bbox.max[1] - r.bbox.min[1];
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_x - 24.0).abs() < 0.3, "x span -12..12 = 24, got {span_x}");
        assert!((span_y - 24.0).abs() < 0.3, "y span -12..12 = 24, got {span_y}");
        assert!((span_z - 10.0).abs() < 0.15, "z span -5..5 = 10, got {span_z}");
    }

    /// Revolve the same rectangle only 90°: a quarter tube. Python: 6 faces,
    /// 12 edges, bbox 0..12 in x and y, -5..5 in z.
    #[test]
    fn revolve_rect_quarter_turn() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch", "plane": "XZ",
              "entities": [{ "type": "rectangle", "width": 4, "height": 10, "x": 10, "y": 0 }] },
            { "id": "r1", "type": "revolve", "sketch": "s1", "axis": "Z", "angle": 90 }
        ]});
        let r = geom_rebuild(doc).expect("rebuild");
        assert_eq!(distinct_faces(&r), 6, "quarter revolve -> 6 faces (Python: 6)");
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_x - 12.0).abs() < 0.3, "x span 0..12 = 12, got {span_x}");
        assert!((span_z - 10.0).abs() < 0.15, "z span -5..5 = 10, got {span_z}");
    }

    /// Loft a 20×20 square (XY, z=0) up to a 10×10 square on a derived plane at
    /// z=30: a tapered box. Python: 6 faces, 12 edges, bbox -10..10 in x,y and
    /// 0..30 in z. (Also exercises a derived PlaneDef plane for the top section.)
    #[test]
    fn loft_two_sections() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch", "plane": "XY",
              "entities": [{ "type": "rectangle", "width": 20, "height": 20 }] },
            { "id": "s2", "type": "sketch",
              "plane": { "origin": [0, 0, 30], "normal": [0, 0, 1], "xdir": [1, 0, 0] },
              "entities": [{ "type": "rectangle", "width": 10, "height": 10 }] },
            { "id": "l1", "type": "loft", "sketches": ["s1", "s2"] }
        ]});
        let r = geom_rebuild(doc).expect("rebuild");
        assert_eq!(distinct_faces(&r), 6, "tapered box loft -> 6 faces (Python: 6)");
        assert_eq!(r.edges.len(), 12, "tapered box loft -> 12 edges (Python: 12)");
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        let span_z = r.bbox.max[2] - r.bbox.min[2];
        assert!((span_x - 20.0).abs() < 0.5, "x span ~20 (widest section), got {span_x}");
        assert!((span_z - 30.0).abs() < 0.5, "z span 0..30 = 30, got {span_z}");
    }

    /// Multi-region extrude: a 40×40 square with a concentric r=8 circle gives two
    /// loops. An interior point at the center picks the INNER DISK; a point in a
    /// corner picks the OUTER RING (square minus the disk). The two must differ.
    /// Python: inner disk = 3 faces, bbox -8..8; outer ring = 7 faces, bbox -20..20.
    #[test]
    fn extrude_region_inner_disk_vs_outer_ring() {
        let two_loops = || {
            json!([
                { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "rectangle", "width": 40, "height": 40 },
                    { "type": "circle", "radius": 8 } ] }
            ])
        };

        // Inner disk: interior point at the center is inside the circle.
        let mut inner = two_loops().as_array().unwrap().clone();
        inner.push(json!({ "id": "e1", "type": "extrude", "sketch": "s1",
            "distance": 10, "operation": "new", "regions": [[0, 0, 0]] }));
        let r_inner = geom_rebuild(json!({ "parameters": {}, "features": inner })).expect("rebuild inner");
        assert_eq!(distinct_faces(&r_inner), 3, "inner disk -> 3 faces (Python: 3)");
        let inner_x = r_inner.bbox.max[0] - r_inner.bbox.min[0];
        assert!((inner_x - 16.0).abs() < 0.1, "inner disk x span ~16 (r=8), got {inner_x}");

        // Outer ring: interior point in a corner is inside the square but outside
        // the circle, so the picked region is the square with the circle as a hole.
        let mut outer = two_loops().as_array().unwrap().clone();
        outer.push(json!({ "id": "e1", "type": "extrude", "sketch": "s1",
            "distance": 10, "operation": "new", "regions": [[15, 15, 0]] }));
        let r_outer = geom_rebuild(json!({ "parameters": {}, "features": outer })).expect("rebuild outer");
        assert_eq!(distinct_faces(&r_outer), 7, "outer ring -> 7 faces (Python: 7)");
        let outer_x = r_outer.bbox.max[0] - r_outer.bbox.min[0];
        assert!((outer_x - 40.0).abs() < 0.1, "outer ring x span ~40, got {outer_x}");

        // The two picks genuinely differ (disk is solid+small, ring is large+holed).
        assert_ne!(
            distinct_faces(&r_inner),
            distinct_faces(&r_outer),
            "inner-disk and outer-ring region picks must differ"
        );
        assert!(outer_x > inner_x + 10.0, "outer ring is much wider than the inner disk");
    }

    /// A sketch on a derived PlaneDef plane (origin z=5, normal +Z) extruded 10:
    /// a box floating at z 5..15. Python: 6 faces, 12 edges, bbox -10..10 in x,y,
    /// 5..15 in z. Confirms `plane_of` honors the plane origin.
    #[test]
    fn sketch_on_derived_plane() {
        let doc = json!({ "parameters": {}, "features": [
            { "id": "s1", "type": "sketch",
              "plane": { "origin": [0, 0, 5], "normal": [0, 0, 1], "xdir": [1, 0, 0] },
              "entities": [{ "type": "rectangle", "width": 20, "height": 20 }] },
            { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" }
        ]});
        let r = geom_rebuild(doc).expect("rebuild");
        assert_eq!(distinct_faces(&r), 6, "box on derived plane -> 6 faces");
        assert_eq!(r.edges.len(), 12, "box on derived plane -> 12 edges");
        let span_x = r.bbox.max[0] - r.bbox.min[0];
        assert!((span_x - 20.0).abs() < 0.05, "x span ~20, got {span_x}");
        // The plane origin offset must lift the box to z 5..15.
        assert!((r.bbox.min[2] - 5.0).abs() < 0.1, "z min ~5 (plane origin), got {}", r.bbox.min[2]);
        assert!((r.bbox.max[2] - 15.0).abs() < 0.1, "z max ~15, got {}", r.bbox.max[2]);
    }

    /// Capstone: build the app's actual default model (EXAMPLE_BRACKET from
    /// src/document/example.ts) on the Rust kernel and check it matches the Python
    /// sidecar. Rect 40x20 extrude 5, circle r3 @ (-12,0) extrude-cut, fillet on
    /// the axis-Z edges r2. Python reference: 11 faces, bbox -20..20 / -10..10 /
    /// 0..5. (tris/edges are a generous range -- the fillet blend tessellation
    /// differs between OCCT 7.9.3 here and the sidecar's 7.8.1.)
    #[test]
    fn example_bracket_matches_python() {
        let doc = json!({
            "parameters": { "width": 40, "height": 20, "thickness": 5, "hole_d": 6 },
            "features": [
                { "id": "f1", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "rectangle", "width": "width", "height": "height", "x": 0, "y": 0 } ]},
                { "id": "f2", "type": "extrude", "sketch": "f1", "distance": "thickness", "operation": "new" },
                { "id": "f3", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "circle", "radius": 3, "x": -12, "y": 0 } ]},
                { "id": "f4", "type": "extrude", "sketch": "f3", "distance": "thickness", "operation": "cut" },
                { "id": "f5", "type": "fillet", "edges": { "kind": "edge", "by": "axis", "axis": "Z" }, "radius": 2 }
            ]
        });
        let r = geom_rebuild(doc).expect("example bracket builds on the Rust kernel");
        let tris = r.mesh.indices.len() / 3;
        assert_eq!(r.mesh.face_ids.len(), tris, "one faceId per triangle");
        assert_eq!(distinct_faces(&r), 11, "example bracket -> 11 faces (matches Python)");
        assert!((r.bbox.min[0] + 20.0).abs() < 0.05 && (r.bbox.max[0] - 20.0).abs() < 0.05, "x -20..20");
        assert!((r.bbox.min[1] + 10.0).abs() < 0.05 && (r.bbox.max[1] - 10.0).abs() < 0.05, "y -10..10");
        assert!(r.bbox.min[2].abs() < 0.05 && (r.bbox.max[2] - 5.0).abs() < 0.05, "z 0..5");
        assert!(tris > 100, "has real tessellation, got {tris} tris");
        assert!((20..=40).contains(&r.edges.len()), "edge count near Python's 27, got {}", r.edges.len());
    }

    // ---------------------------------------------------------------------
    // Selector v2: the fingerprint resolver ported from sidecar/geom_select.py.
    // These mirror sidecar/test_selector_v2.py (the 6 oracle cases) on solids
    // built in-process. Assertions key on GEOMETRY (picked radius / centroid),
    // not tessellation counts, so the OCCT 7.9.3-vs-7.8.1 skew is a non-issue.
    // ---------------------------------------------------------------------

    /// Build an EdgeFingerprint JSON from a real edge, using the same resolver
    /// helpers (the Rust analog of test_selector_v2.py `edge_fp`).
    fn edge_fp(e: &Edge) -> serde_json::Value {
        let m = edge_mid(e);
        let d = edge_dir(e);
        let mut fp = json!({
            "mid": [m.x, m.y, m.z],
            "dir": [d.x, d.y, d.z],
            "length": e.length(),
            "curve": edge_curve(e),
        });
        if edge_curve(e) == "circle" {
            if let Some(r) = e.circle_radius() {
                fp["radius"] = json!(r);
            }
            if let Some(c) = e.circle_center() {
                fp["center"] = json!([c.x, c.y, c.z]);
            }
        }
        fp
    }

    fn face_fp(f: &Face) -> serde_json::Value {
        let c = f.center_of_mass();
        let n = f.normal_at_center().normalize();
        json!({ "centroid": [c.x, c.y, c.z], "normal": [n.x, n.y, n.z], "area": f.surface_area() })
    }

    fn no_diag() -> Vec<ResolveDiag> {
        Vec::new()
    }

    /// `match` picks ONE edge where the legacy `axis` selector grabs all 4 parallel.
    #[test]
    fn v2_match_picks_one_edge_where_axis_grabs_all() {
        let part = Shape::box_centered(20.0, 20.0, 10.0);

        let x_edges =
            resolve_edges(&part, &json!({"kind":"edge","by":"axis","axis":"X"}), &mut no_diag(), None)
                .unwrap();
        // axis grabs the WHOLE parallel set (>=4; the legacy path doesn't de-dup
        // OCCT's per-incident-face edge twins) — the contrast is that `match`
        // below picks exactly ONE.
        assert!(x_edges.len() >= 4, "axis X should grab the whole parallel set");

        // the top-front X edge (y>0, z>0): match it specifically.
        let target = part
            .edges()
            .find(|e| {
                edge_curve(e) == "line"
                    && edge_dir(e).x.abs() > 0.99
                    && edge_mid(e).y > 0.0
                    && edge_mid(e).z > 0.0
            })
            .expect("a top-front X edge");
        let tmid = edge_mid(&target);

        let got = resolve_edges(
            &part,
            &json!({"kind":"edge","by":"match","fp": edge_fp(&target)}),
            &mut no_diag(),
            None,
        )
        .unwrap();
        assert_eq!(got.len(), 1, "match should pick exactly 1 edge");
        let m = edge_mid(&got[0]);
        assert!(
            (m - tmid).length() < 1e-3,
            "match picked the wrong X edge: {m:?} vs {tmid:?}"
        );
    }

    /// `ofFace` returns exactly the edges bounding the matched (top) face.
    #[test]
    fn v2_offace_returns_face_edges() {
        let part = Shape::box_centered(20.0, 20.0, 10.0);
        let tf = part
            .faces()
            .max_by(|a, b| a.center_of_mass().z.partial_cmp(&b.center_of_mass().z).unwrap())
            .unwrap();
        let tz = tf.center_of_mass().z;

        let got = resolve_edges(
            &part,
            &json!({"kind":"edge","by":"ofFace","face": face_fp(&tf)}),
            &mut no_diag(),
            None,
        )
        .unwrap();
        assert_eq!(got.len(), 4, "ofFace(top) should be 4 edges");
        assert!(
            got.iter().all(|e| (edge_mid(e).z - tz).abs() < 0.05),
            "ofFace edges must lie on the top face"
        );
    }

    /// Concentric top circles of a pipe are disambiguated by radius/center, and a
    /// LIST of both selectors keeps BOTH through de-dup (the old center-only key
    /// dropped one).
    #[test]
    fn v2_concentric_disambiguated_and_dedup() {
        let tube: Shape = Shape::cylinder_centered(DVec3::ZERO, 10.0, DVec3::Z, 10.0)
            .subtract(&Shape::cylinder_centered(DVec3::ZERO, 5.0, DVec3::Z, 10.0))
            .into();

        let top: Vec<Edge> = unique_edges(&tube)
            .into_iter()
            .filter(|e| edge_curve(e) == "circle" && (edge_mid(e).z - 5.0).abs() < 0.05)
            .collect();
        assert_eq!(top.len(), 2, "expected 2 concentric top circles");
        let outer = top
            .iter()
            .max_by(|a, b| a.circle_radius().unwrap().partial_cmp(&b.circle_radius().unwrap()).unwrap())
            .unwrap();
        let inner = top
            .iter()
            .min_by(|a, b| a.circle_radius().unwrap().partial_cmp(&b.circle_radius().unwrap()).unwrap())
            .unwrap();

        let got_outer = resolve_edges(
            &tube,
            &json!({"kind":"edge","by":"match","fp": edge_fp(outer)}),
            &mut no_diag(),
            None,
        )
        .unwrap();
        let got_inner = resolve_edges(
            &tube,
            &json!({"kind":"edge","by":"match","fp": edge_fp(inner)}),
            &mut no_diag(),
            None,
        )
        .unwrap();
        assert!((got_outer[0].circle_radius().unwrap() - 10.0).abs() < 0.05, "match should pick r=10");
        assert!((got_inner[0].circle_radius().unwrap() - 5.0).abs() < 0.05, "match should pick r=5");

        // a LIST of both selectors must keep BOTH.
        let both = resolve_edges(
            &tube,
            &json!([
                {"kind":"edge","by":"match","fp": edge_fp(outer)},
                {"kind":"edge","by":"match","fp": edge_fp(inner)},
            ]),
            &mut no_diag(),
            None,
        )
        .unwrap();
        let mut radii: Vec<f64> =
            both.iter().map(|e| (e.circle_radius().unwrap() * 10.0).round() / 10.0).collect();
        radii.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(radii, vec![5.0, 10.0], "concentric de-dup dropped an edge");
    }

    /// `face` match picks the top face.
    #[test]
    fn v2_face_match_picks_top() {
        let part = Shape::box_centered(20.0, 20.0, 10.0);
        let tf = part
            .faces()
            .max_by(|a, b| a.center_of_mass().z.partial_cmp(&b.center_of_mass().z).unwrap())
            .unwrap();
        let tz = tf.center_of_mass().z;

        let got = resolve_faces(
            &part,
            &json!({"kind":"face","by":"match","fp": face_fp(&tf)}),
            &mut no_diag(),
            None,
        )
        .unwrap();
        assert_eq!(got.len(), 1, "face match should pick one face");
        assert!((got[0].center_of_mass().z - tz).abs() < 1e-3, "and it should be the top face");
    }

    /// On a box (edges meet at 90deg) a tangentChain is just the seed.
    #[test]
    fn v2_tangentchain_on_box_is_single_edge() {
        let part = Shape::box_centered(20.0, 20.0, 10.0);
        let seed = part.edges().find(|e| edge_curve(e) == "line").expect("a line edge");
        let got = resolve_edges(
            &part,
            &json!({"kind":"edge","by":"tangentChain","seed": edge_fp(&seed)}),
            &mut no_diag(),
            None,
        )
        .unwrap();
        assert_eq!(got.len(), 1, "box tangentChain should be 1 edge (no tangent neighbours)");
    }

    /// A fingerprint far from any real edge resolves best-effort (returns the
    /// closest) and records a lossy diagnostic tagged with the feature id.
    #[test]
    fn v2_bad_match_is_best_effort_with_diagnostic() {
        let part = Shape::box_centered(20.0, 20.0, 10.0);
        let mut diag = no_diag();
        let bad = json!({"kind":"edge","by":"match",
            "fp": {"mid":[100,100,100],"dir":[1,0,0],"length":999,"curve":"line"}});
        let got = resolve_edges(&part, &bad, &mut diag, Some("f9")).unwrap();
        assert_eq!(got.len(), 1, "best-effort match still returns a candidate");
        assert!(!diag.is_empty(), "expected a diagnostic");
        assert!(diag[0].lossy, "the diagnostic should be lossy");
        assert_eq!(diag[0].feature_id.as_deref(), Some("f9"), "tagged with the feature id");
    }
}
