pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/b_rep_offset.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopoDS_Face = crate::topo_ds::TopoDS_Face;
        type BRepOffset_Mode = crate::b_rep_offset_api::BRepOffset_Mode;
        type GeomAbs_JoinType = crate::geom_abs::GeomAbs_JoinType;

        type BRepOffset_MakeOffset;
        pub fn BRepOffset_MakeOffset_new() -> UniquePtr<BRepOffset_MakeOffset>;

        #[allow(clippy::too_many_arguments)]
        pub fn BRepOffset_MakeOffset_initialize(
            mk: Pin<&mut BRepOffset_MakeOffset>,
            shape: &TopoDS_Shape,
            offset: f64,
            tol: f64,
            mode: BRepOffset_Mode,
            intersection: bool,
            self_inter: bool,
            join: GeomAbs_JoinType,
            thickening: bool,
            remove_int_edges: bool,
        );
        pub fn BRepOffset_MakeOffset_set_offset_on_face(
            mk: Pin<&mut BRepOffset_MakeOffset>,
            face: &TopoDS_Face,
            offset: f64,
        );
        pub fn BRepOffset_MakeOffset_make(mk: Pin<&mut BRepOffset_MakeOffset>);
        pub fn BRepOffset_MakeOffset_is_done(mk: &BRepOffset_MakeOffset) -> bool;
        pub fn BRepOffset_MakeOffset_shape(mk: &BRepOffset_MakeOffset) -> &TopoDS_Shape;
    }
}
