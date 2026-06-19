#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <bindings_common.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

inline std::unique_ptr<gp_Pnt> BRepAdaptor_Curve_value(const BRepAdaptor_Curve &curve, const Standard_Real U) {
  return std::unique_ptr<gp_Pnt>(new gp_Pnt(curve.Value(U)));
}

// Direction of a line edge (only valid when GetType() == GeomAbs_Line).
inline std::unique_ptr<gp_Dir> BRepAdaptor_Curve_line_direction(const BRepAdaptor_Curve &curve) {
  return std::unique_ptr<gp_Dir>(new gp_Dir(curve.Line().Direction()));
}

// Radius of a cylindrical surface (only valid when GetType() == GeomAbs_Cylinder).
inline Standard_Real BRepAdaptor_Surface_cylinder_radius(const BRepAdaptor_Surface &surface) {
  return surface.Cylinder().Radius();
}
