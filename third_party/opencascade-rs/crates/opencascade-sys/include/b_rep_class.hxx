#include <BRepClass_FaceClassifier.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <TopAbs_State.hxx>
#include <TopExp.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <bindings_common.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>

// Is the 3D point (x, y, z) inside (or on the boundary of) `face`?
//
// Projects the point onto the face's underlying surface to recover its (u, v)
// parameters, then classifies (u, v) against the face's trimming wires with
// BRepClass_FaceClassifier. This is the OCCT analog of build123d's
// `Face.is_inside(point)` used by builder.py's region selection. The point is
// expected to lie on (or very near) the face's plane; a small projection gap is
// tolerated. Returns true for TopAbs_IN and TopAbs_ON, false otherwise.
inline bool face_contains_point(const TopoDS_Face &face, double x, double y,
                                double z, double tol) {
  Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  if (surface.IsNull()) {
    return false;
  }

  gp_Pnt point(x, y, z);
  GeomAPI_ProjectPointOnSurf projector(point, surface);
  if (!projector.IsDone() || projector.NbPoints() < 1) {
    return false;
  }

  Standard_Real u = 0.0;
  Standard_Real v = 0.0;
  projector.LowerDistanceParameters(u, v);

  BRepClass_FaceClassifier classifier(face, gp_Pnt2d(u, v), tol);
  TopAbs_State state = classifier.State();
  return state == TopAbs_IN || state == TopAbs_ON;
}

// Does `wire` form a closed loop? Uses TopExp::Vertices(wire, V1, V2): for a
// closed wire OCCT returns null end-vertices (no free ends); for an open wire it
// returns the two distinct endpoints. We treat null-or-coincident endpoints as
// closed. This is the OCCT analog of build123d's `Wire.is_closed`, used to keep
// only closed free-form loops as profile faces.
inline bool wire_is_closed(const TopoDS_Wire &wire, double tol) {
  TopoDS_Vertex v1;
  TopoDS_Vertex v2;
  TopExp::Vertices(wire, v1, v2);

  if (v1.IsNull() || v2.IsNull()) {
    // A closed wire has no free end vertices.
    return true;
  }
  // Open wire with two ends: closed only if they coincide within tolerance.
  gp_Pnt p1 = BRep_Tool::Pnt(v1);
  gp_Pnt p2 = BRep_Tool::Pnt(v2);
  return p1.Distance(p2) <= tol;
}
