pub use inner::*;

#[cxx::bridge]
mod inner {
    #[derive(Debug)]
    #[repr(u32)]
    pub enum GeomAbs_CurveType {
        GeomAbs_Line,
        GeomAbs_Circle,
        GeomAbs_Ellipse,
        GeomAbs_Hyperbola,
        GeomAbs_Parabola,
        GeomAbs_BezierCurve,
        GeomAbs_BSplineCurve,
        GeomAbs_OffsetCurve,
        GeomAbs_OtherCurve,
    }

    #[repr(u32)]
    #[derive(Debug)]
    pub enum GeomAbs_JoinType {
        GeomAbs_Arc,
        GeomAbs_Tangent,
        GeomAbs_Intersection,
    }

    #[repr(u32)]
    #[derive(Debug)]
    pub enum GeomAbs_SurfaceType {
        GeomAbs_Plane,
        GeomAbs_Cylinder,
        GeomAbs_Cone,
        GeomAbs_Sphere,
        GeomAbs_Torus,
        GeomAbs_BezierSurface,
        GeomAbs_BSplineSurface,
        GeomAbs_SurfaceOfRevolution,
        GeomAbs_SurfaceOfExtrusion,
        GeomAbs_OffsetSurface,
        GeomAbs_OtherSurface,
    }

    unsafe extern "C++" {
        include!("opencascade-sys/include/geom_abs.hxx");

        type GeomAbs_CurveType;
        type GeomAbs_JoinType;
        type GeomAbs_SurfaceType;
    }
}
