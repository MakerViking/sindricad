#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Builder.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <TopoDS_Compound.hxx>
#include <bindings_common.hxx>

// OCCT 7.9 turned `TopoDS` from a class with static cast methods into a
// namespace of free functions. cxx can only bind these as a type with
// `#[Self]` methods, so wrap the namespace casts in free-function shims.
inline const TopoDS_Vertex &topods_cast_to_vertex(const TopoDS_Shape &shape) {
  return TopoDS::Vertex(shape);
}
inline const TopoDS_Edge &topods_cast_to_edge(const TopoDS_Shape &shape) {
  return TopoDS::Edge(shape);
}
inline const TopoDS_Wire &topods_cast_to_wire(const TopoDS_Shape &shape) {
  return TopoDS::Wire(shape);
}
inline const TopoDS_Face &topods_cast_to_face(const TopoDS_Shape &shape) {
  return TopoDS::Face(shape);
}
inline const TopoDS_Shell &topods_cast_to_shell(const TopoDS_Shape &shape) {
  return TopoDS::Shell(shape);
}
inline const TopoDS_Solid &topods_cast_to_solid(const TopoDS_Shape &shape) {
  return TopoDS::Solid(shape);
}
inline const TopoDS_Compound &topods_cast_to_compound(const TopoDS_Shape &shape) {
  return TopoDS::Compound(shape);
}
