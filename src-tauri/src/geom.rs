//! Geometry-in-Rust spike: build a box and tessellate it into a render payload
//! (per-triangle faceIds), driving OCCT directly via `opencascade-sys`.
//!
//! This proves the in-process Rust path can reproduce the Python sidecar's
//! per-face `faceId` mesh (one B-rep face id per triangle) that the frontend's
//! picker/selector system depends on. It deliberately ignores the document and
//! returns a hardcoded 20×20×10 box; real document rebuild is a later phase.
//!
//! The output JSON mirrors `RebuildResult` in `src/types.ts`.

use opencascade_sys as occ;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mesh {
    positions: Vec<f64>, // flat [x,y,z, ...]
    indices: Vec<u32>,   // flat [i,j,k, ...] triangle triples
    face_ids: Vec<u32>,  // one B-rep face id per triangle  -> JSON "faceIds"
}

#[derive(Serialize)]
pub struct Edge {
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
    edges: Vec<Edge>,
    bbox: Bbox,
}

/// Rust-backend rebuild. Spike: ignores `document`, returns a tessellated box.
/// Wired as a Tauri command; the frontend's `TauriGeometry` calls it as
/// `invoke("geom_rebuild", { document })` when `VITE_GEOM=rust`.
#[tauri::command]
pub fn geom_rebuild(document: serde_json::Value) -> Result<RebuildResult, String> {
    let _ = document; // spike: document not consumed yet
    let mesh = tessellate_box(20.0, 20.0, 10.0, 0.1)?;
    let bbox = bbox_of(&mesh.positions);
    Ok(RebuildResult { mesh, edges: Vec::new(), bbox })
}

/// Build an axis-aligned box at the origin and tessellate it, tagging each
/// triangle with its B-rep face index (0..5). Mirrors `sidecar/tessellate.py`:
/// mesh the whole solid, then read each face's triangulation back, transform
/// nodes by the face location, and flip winding on REVERSED faces.
fn tessellate_box(dx: f64, dy: f64, dz: f64, deflection: f64) -> Result<Mesh, String> {
    let origin = occ::gp::new_point(0.0, 0.0, 0.0);
    let mut make_box = occ::b_rep_prim_api::BRepPrimAPI_MakeBox_new(&origin, dx, dy, dz);

    // Mesh in place (BRepMesh stores triangulation on the shared TShape).
    let mesher = occ::b_rep_mesh::IncrementalMesh_new(make_box.pin_mut().Shape(), deflection);
    if !mesher.IsDone() {
        return Err("BRepMesh failed".into());
    }
    let shape = mesher.Shape();

    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut face_ids: Vec<u32> = Vec::new();

    let mut explorer =
        occ::top_exp::TopExp_Explorer_new(shape, occ::top_abs::TopAbs_ShapeEnum::TopAbs_FACE);
    let mut face_index: u32 = 0;
    while explorer.More() {
        {
            let face = occ::topo_ds::Face(explorer.Current());
            let mut location = occ::top_loc::Location_new();
            let handle = occ::b_rep::BRep_Tool_Triangulation(face, location.pin_mut());
            if let Ok(tri) = occ::poly::Handle_Poly_Triangulation_Get(&handle) {
                let trsf = occ::top_loc::TopLoc_Location_Transformation(&location);
                let base = (positions.len() / 3) as u32;

                // nodes (1-based), placed into world via the face location
                for i in 1..=tri.NbNodes() {
                    let mut p = occ::poly::Poly_Triangulation_Node(tri, i);
                    p.pin_mut().Transform(&trsf);
                    positions.push(p.X());
                    positions.push(p.Y());
                    positions.push(p.Z());
                }

                // REVERSED face -> flip winding so client normals point outward
                let reversed = face.Orientation()
                    == occ::top_abs::TopAbs_Orientation::TopAbs_REVERSED;
                for i in 1..=tri.NbTriangles() {
                    let t = tri.Triangle(i);
                    let a = base + (t.Value(1) - 1) as u32;
                    let b = base + (t.Value(2) - 1) as u32;
                    let c = base + (t.Value(3) - 1) as u32;
                    if reversed {
                        indices.extend_from_slice(&[c, b, a]);
                    } else {
                        indices.extend_from_slice(&[a, b, c]);
                    }
                    face_ids.push(face_index);
                }
            }
        }
        face_index += 1;
        explorer.pin_mut().Next();
    }

    Ok(Mesh { positions, indices, face_ids })
}

fn bbox_of(positions: &[f64]) -> Bbox {
    if positions.is_empty() {
        return Bbox { min: [0.0; 3], max: [0.0; 3] };
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for p in positions.chunks_exact(3) {
        for k in 0..3 {
            min[k] = min[k].min(p[k]);
            max[k] = max[k].max(p[k]);
        }
    }
    Bbox { min, max }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The spike's diff-against-Python check: a 20×20×10 box must tessellate to
    /// per-face data identical to the Python sidecar — 6 B-rep faces, 12 triangles
    /// (2 per quad face), 24 vertices (per-face split), one faceId per triangle.
    #[test]
    fn box_tessellation_has_per_face_ids() {
        let m = tessellate_box(20.0, 20.0, 10.0, 0.1).expect("tessellate");
        let tris = m.indices.len() / 3;
        let verts = m.positions.len() / 3;
        let distinct: std::collections::BTreeSet<u32> = m.face_ids.iter().copied().collect();

        assert_eq!(m.face_ids.len(), tris, "one faceId per triangle");
        assert_eq!(distinct.len(), 6, "box has 6 distinct faces");
        assert_eq!(tris, 12, "12 triangles (2 per face)");
        assert_eq!(verts, 24, "24 per-face vertices");

        let b = bbox_of(&m.positions);
        assert_eq!(b.min, [0.0, 0.0, 0.0]);
        assert_eq!(b.max, [20.0, 20.0, 10.0]);
    }
}

