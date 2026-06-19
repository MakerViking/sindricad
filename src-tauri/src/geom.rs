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
use opencascade::primitives::{Edge, Face, IntoShape, Shape, SurfaceType, Wire};
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
            "fillet" => {
                let existing = part
                    .as_ref()
                    .ok_or_else(|| "fillet needs an existing body".to_string())?;
                let sel = f
                    .get("edges")
                    .ok_or_else(|| "fillet missing 'edges' selector".to_string())?;
                let edges = resolve_edges(existing, sel)?;
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
                let edges = resolve_edges(existing, sel)?;
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
                let faces = resolve_faces(existing, sel)?;
                let face = faces
                    .first()
                    .ok_or_else(|| "no face found to press/pull".to_string())?;
                let distance = num_field(f, "distance", params);
                part = Some(press_pull(existing, face, distance)?);
            }
            // Defer/skip every other feature type so the model still renders.
            other => {
                eprintln!("geom: skipping unsupported feature type '{other}'");
            }
        }
    }

    part.ok_or_else(|| "document produced no geometry".to_string())
}

// ---------------------------------------------------------------------------
// Selector resolution (ports sidecar/geom_select.py).
//
// References are property descriptors re-resolved against `part` every rebuild —
// never stored indices. This is SindriCAD's topological-naming mitigation.
// ---------------------------------------------------------------------------

/// Two edge/face centers are "the same" within this tolerance (for de-duping a
/// union of selectors), matching geom_select.py's `round(c, 4)` key.
const SELECT_EPS: f64 = 1e-4;

/// Resolve an edge selector — or a JSON LIST of selectors (union, de-duplicated
/// by edge center) — to a set of edges of `part`. Mirrors
/// `geom_select.resolve_edges`.
fn resolve_edges(part: &Shape, sel: &serde_json::Value) -> Result<Vec<Edge>, String> {
    // A list of selectors (multi-edge fillet/chamfer): union, de-duplicated.
    if let Some(list) = sel.as_array() {
        let mut seen_centers: Vec<DVec3> = Vec::new();
        let mut out: Vec<Edge> = Vec::new();
        for s in list {
            for e in resolve_edges(part, s)? {
                let c = e.center();
                if !seen_centers.iter().any(|p| (*p - c).length() < SELECT_EPS) {
                    seen_centers.push(c);
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
        other => Err(format!("unknown edge selector: {other}")),
    }
}

/// Resolve a face selector to a set of faces of `part`. Mirrors
/// `geom_select.resolve_faces`.
fn resolve_faces(part: &Shape, sel: &serde_json::Value) -> Result<Vec<Face>, String> {
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
        other => Err(format!("unknown face selector: {other}")),
    }
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

    /// Genuinely unsupported feature types (revolve/loft) are skipped, not
    /// errored: the box still builds. (fillet/chamfer/mirror/press-pull are now
    /// implemented and tested separately.)
    #[test]
    fn unsupported_features_are_skipped() {
        let doc = json!({
            "parameters": { "len": 20 },
            "features": [
                { "id": "s1", "type": "sketch", "plane": "XY", "entities": [
                    { "type": "rectangle", "width": "len", "height": "len" }
                ]},
                { "id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new" },
                { "id": "r1", "type": "revolve", "sketch": "s1", "angle": 90 },
                { "id": "l1", "type": "loft", "sketches": ["s1"] }
            ]
        });

        let result = geom_rebuild(doc).expect("rebuild");
        let tris = result.mesh.indices.len() / 3;
        assert_eq!(tris, 12, "still a plain box (revolve/loft skipped)");
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
            let shape = build(&parsed).expect("build");
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
}
