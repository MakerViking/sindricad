pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/b_rep_class.hxx");

        type TopoDS_Face = crate::topo_ds::TopoDS_Face;
        type TopoDS_Wire = crate::topo_ds::TopoDS_Wire;

        // Point-in-face test (build123d `Face.is_inside` analog), used by the
        // region selector in the high-level crate.
        fn face_contains_point(face: &TopoDS_Face, x: f64, y: f64, z: f64, tol: f64) -> bool;

        // Closed-loop test for a wire (build123d `Wire.is_closed` analog), used to
        // keep only closed free-form sketch loops as profile faces.
        fn wire_is_closed(wire: &TopoDS_Wire, tol: f64) -> bool;
    }
}
