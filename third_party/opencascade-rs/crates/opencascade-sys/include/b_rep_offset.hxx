#include <BRepOffset_MakeOffset.hxx>
#include <BRepOffset_Mode.hxx>
#include <GeomAbs_JoinType.hxx>
#include <Standard_Real.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <bindings_common.hxx>

// Local single-face surface offset (the "true" Press/Pull for curved faces).
// Mirrors sidecar/builder.py:_offset_face — BRepOffset_MakeOffset in Skin mode
// with a global offset of 0 plus a per-face offset, GeomAbs_Intersection join.
inline std::unique_ptr<BRepOffset_MakeOffset> BRepOffset_MakeOffset_new() {
  return std::unique_ptr<BRepOffset_MakeOffset>(new BRepOffset_MakeOffset());
}

inline void BRepOffset_MakeOffset_initialize(
    BRepOffset_MakeOffset &mk,
    const TopoDS_Shape &shape,
    const Standard_Real offset,
    const Standard_Real tol,
    const BRepOffset_Mode mode,
    const Standard_Boolean intersection,
    const Standard_Boolean self_inter,
    const GeomAbs_JoinType join,
    const Standard_Boolean thickening,
    const Standard_Boolean remove_int_edges) {
  mk.Initialize(shape, offset, tol, mode, intersection, self_inter, join, thickening, remove_int_edges);
}

inline void BRepOffset_MakeOffset_set_offset_on_face(
    BRepOffset_MakeOffset &mk,
    const TopoDS_Face &face,
    const Standard_Real offset) {
  mk.SetOffsetOnFace(face, offset);
}

inline void BRepOffset_MakeOffset_make(BRepOffset_MakeOffset &mk) {
  mk.MakeOffsetShape();
}

inline bool BRepOffset_MakeOffset_is_done(const BRepOffset_MakeOffset &mk) {
  return mk.IsDone();
}

inline const TopoDS_Shape &BRepOffset_MakeOffset_shape(const BRepOffset_MakeOffset &mk) {
  return mk.Shape();
}
