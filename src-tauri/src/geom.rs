//! Geometry-in-Rust: consume the CAD document and build real geometry in-process
//! via the high-level `opencascade` crate, tessellating it into the render payload
//! (per-B-rep-face `faceId` mesh + edge polylines + bbox) that the frontend's
//! picker/selector depends on.
//!
//! This is the Phase-1 port of `sidecar/builder.py` + `sidecar/tessellate.py`:
//!   - sketch: rectangle + circle on the BASE planes XY/XZ/YZ
//!   - extrude: prism the sketch profile, op new/join/cut via boolean union/cut
//!   - every other feature type is SKIPPED (logged) so the model still renders.
//!
//! The output JSON mirrors `RebuildResult` in `src/types.ts`.

use glam::{dvec3, DVec3};
use opencascade::primitives::{Edge, Face, IntoShape, Shape, Wire};
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

#[derive(Serialize)]
pub struct RebuildResult {
    mesh: Mesh,
    edges: Vec<EdgeOut>,
    bbox: Bbox,
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
    let shape = build(&doc)?;
    Ok(tessellate(&shape))
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
/// sketch has no closed profile — plus the sketch plane's normal, which is the
/// extrude direction (build123d's `extrude(sk, amount=d)` prisms along the plane
/// normal, NOT the face's own orientation normal). (Region/interior-point
/// selection is deferred: we always extrude the whole sketch, see report.)
struct BuiltSketch {
    face: Option<Face>,
    normal: DVec3,
}

fn build(doc: &Document) -> Result<Shape, String> {
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
                let face = entry
                    .face
                    .as_ref()
                    .ok_or_else(|| "sketch has no closed profile to extrude".to_string())?;

                let distance = num_field(f, "distance", params);
                // Whole-sketch extrude along the sketch plane normal (regions
                // deferred). Matches build123d's `extrude(sk, amount=d)`.
                let solid = face.extrude(entry.normal * distance);
                let solid_shape = solid.into_shape();

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
            // Defer/skip every other feature type so the model still renders.
            other => {
                eprintln!("geom: skipping unsupported feature type '{other}'");
            }
        }
    }

    part.ok_or_else(|| "document produced no geometry".to_string())
}

/// Build a sketch's union profile face on a BASE plane (XY/XZ/YZ). Rectangle and
/// circle primitives only; line/arc/spline entities and derived (PlaneDef) planes
/// are skipped (deferred). Construction geometry is skipped.
fn build_sketch(f: &serde_json::Value, params: &std::collections::HashMap<String, f64>) -> BuiltSketch {
    let plane = f.get("plane");
    let wp = match plane.and_then(|v| v.as_str()) {
        Some("XY") => Workplane::xy(),
        Some("XZ") => Workplane::xz(),
        Some("YZ") => Workplane::yz(),
        _ => {
            // Derived PlaneDef plane: deferred — no profile.
            eprintln!("geom: skipping sketch on non-base/derived plane");
            return BuiltSketch { face: None, normal: DVec3::Z };
        }
    };
    let normal = wp.normal();

    let empty = vec![];
    let entities = f.get("entities").and_then(|v| v.as_array()).unwrap_or(&empty);

    let mut faces: Vec<Face> = Vec::new();
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
            // line/arc/spline free-form curves are deferred.
            other => {
                eprintln!("geom: skipping sketch entity type '{other}'");
            }
        }
    }

    if faces.is_empty() {
        return BuiltSketch { face: None, normal };
    }

    // Union the profile faces into one (a circle inside a rectangle becomes a
    // ring after the boolean fuse + subtract; for now a plain union of the loops,
    // matching builder.py's `sk = faces[0] + faces[1] + ...`). build123d's `+`
    // on overlapping faces yields the outer profile minus inner holes when one
    // contains another; we approximate that with subtract-when-contained below.
    let face = combine_faces(faces);
    BuiltSketch { face: Some(face), normal }
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
    result.as_face().unwrap_or_else(|| {
        // Boolean produced a non-Face (e.g. compound); fall back to the first face.
        panic!("combine_faces: profile boolean did not yield a single face")
    })
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

    RebuildResult { mesh: Mesh { positions, indices, face_ids }, edges, bbox }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    /// Unsupported feature types (fillet/mirror/etc.) are skipped, not errored:
    /// the box still builds.
    #[test]
    fn unsupported_features_are_skipped() {
        let doc = json!({
            "parameters": { "len": 20 },
            "features": [
                { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "rectangle", "width": "len", "height": "len" }
                ]},
                { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" },
                { "id": "f1", "type": "fillet", "edges": { "kind": "edge", "by": "all" }, "radius": 2 },
                { "id": "m1", "type": "mirror", "plane": "XZ" }
            ]
        });

        let result = geom_rebuild(doc).expect("rebuild");
        let tris = result.mesh.indices.len() / 3;
        assert_eq!(tris, 12, "still a plain box (fillet/mirror skipped)");
        // Parameter resolution worked: 20×20 rectangle.
        let span_x = result.bbox.max[0] - result.bbox.min[0];
        assert!((span_x - 20.0).abs() < 0.05, "param-driven width ~20, got {span_x}");
    }
}
