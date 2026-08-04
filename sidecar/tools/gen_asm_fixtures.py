"""Generate small STEP assembly fixtures for the Phase C assembly-tree work.

Every .step file already in this repo is a single flat part: all nine have
`NEXT_ASSEMBLY_USAGE_OCCURRENCE = 0` and exactly one `PRODUCT_DEFINITION`. So
there is nothing committed that exercises a named XCAF product tree, and the
356 MiB reference assembly is unimportable until the cap raise lands. These
fixtures fill that gap.

Each one isolates a case the import path has to get right:

  asm_flat           3 single-solid products, depth 1 — the baseline.
  asm_multisolid     "M3 Nut (x3)": ONE product label holding 3 disjoint solids,
                     plus a single-solid "Plate". The tree must not flatten this
                     to 4 anonymous bodies nor collapse it to 1.
  asm_nested         Depth 3, with one subassembly instanced TWICE at different
                     world positions. This is the fixture that catches leaves
                     being harvested in their parent's frame instead of world
                     space — a bug that is invisible at depth 1.
  asm_colors         3 products with their own colour + 1 with none under a
                     coloured parent, which is the case that catches reading
                     build123d's inherited `.color` getter instead of the label.
  asm_empty_product  A named product with faces and ZERO solids — the shape of
                     the 11 products the importer silently drops today.

Run with the sidecar venv:
    .venv/bin/python tools/gen_asm_fixtures.py
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "..", "fixtures")


def _doc():
    """A fresh XCAF document plus its shape and colour tools."""
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    doc = TDocStd_Document(TCollection_ExtendedString("XCAF"))
    return (
        doc,
        XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()),
        XCAFDoc_DocumentTool.ColorTool_s(doc.Main()),
    )


def _name(label, text):
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name

    TDataStd_Name.Set_s(label, TCollection_ExtendedString(text))


def _color(color_tool, label, rgb):
    """Attach a generic colour. rgb is a (r, g, b) float triple in 0..1."""
    from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
    from OCP.XCAFDoc import XCAFDoc_ColorType

    color_tool.SetColor(
        label,
        Quantity_Color(rgb[0], rgb[1], rgb[2], Quantity_TOC_sRGB),
        XCAFDoc_ColorType.XCAFDoc_ColorGen,
    )


def _empty_assembly(shape_tool, name):
    """An assembly label with no components yet. XCAF wants a compound shape to
    hang the assembly structure on, so start from an empty one and let
    AddComponent fill it."""
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    comp = TopoDS_Compound()
    BRep_Builder().MakeCompound(comp)
    label = shape_tool.AddShape(comp, True, False)
    _name(label, name)
    return label


def _part(shape_tool, assembly, shape, name):
    """Add a named leaf product as a component of `assembly`, and return its
    referred (product) label so a colour can be attached to it.

    Deliberately NOT `AddShape(shape) -> name it -> AddComponent(label, loc)`:
    a name attached that way is DROPPED by STEPCAFControl_Writer for simple
    solids. Verified — the product comes back out of the file as
    "Open CASCADE STEP translator 7.9 1.1", while compound products written the
    same way keep their names, which is a confusing thing to debug twice.
    Adding the shape through AddComponent and naming the REFERRED label writes
    correctly for both. The cost is that placement has to be baked into `shape`
    instead of passed as a TopLoc_Location; only sub-assemblies, which do keep
    their names, are instanced with an explicit location.

    makeAssembly stays off, which is what keeps a multi-solid compound as ONE
    named product rather than an assembly of anonymous children — the whole
    point of asm_multisolid.
    """
    from OCP.TDF import TDF_Label

    instance = shape_tool.AddComponent(assembly, shape, False)
    referred = TDF_Label()
    shape_tool.GetReferredShape_s(instance, referred)
    _name(referred, name)
    return referred


def _at(x=0.0, y=0.0, z=0.0):
    from OCP.gp import gp_Trsf, gp_Vec
    from OCP.TopLoc import TopLoc_Location

    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(x, y, z))
    return TopLoc_Location(trsf)


def _write(doc, path):
    from OCP.IFSelect import IFSelect_ReturnStatus
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_StepModelType

    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    writer.SetColorMode(True)
    if not writer.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs):
        raise RuntimeError(f"STEPCAFControl_Writer.Transfer failed for {path}")
    status = writer.Write(path)
    if status != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise RuntimeError(f"STEPCAFControl_Writer.Write returned {status} for {path}")


def _boxes(*specs):
    """A compound of boxes. Each spec is (dx, dy, dz, x, y, z)."""
    from build123d import Box, Compound, Pos

    return Compound(
        children=[Pos(x, y, z) * Box(dx, dy, dz) for dx, dy, dz, x, y, z in specs]
    )


# --- the fixtures ------------------------------------------------------------


def asm_flat(path):
    """3 single-solid products under one root. Depth 1."""
    from build123d import Box, Cylinder, Pos

    doc, st, _ct = _doc()
    root = _empty_assembly(st, "Widget")
    _part(st, root, (Pos(0, 0, 0) * Box(20, 20, 2)).wrapped, "Plate")
    _part(st, root, (Pos(30, 0, 0) * Box(6, 6, 10)).wrapped, "Bracket")
    _part(st, root, (Pos(0, 30, 0) * Cylinder(2, 12)).wrapped, "Pin")
    st.UpdateAssemblies()
    _write(doc, path)
    return {"products": 3, "solids": 3}


def asm_multisolid(path):
    """ONE product label holding 3 disjoint solids, plus a single-solid product.
    The real file's "M3 Nut (x20)" is exactly this shape."""
    from build123d import Box, Pos

    doc, st, _ct = _doc()
    root = _empty_assembly(st, "Fasteners")
    nuts = _boxes((3, 3, 2, 0, 20, 0), (3, 3, 2, 8, 20, 0), (3, 3, 2, 16, 20, 0))
    _part(st, root, nuts.wrapped, "M3 Nut (x3)")
    _part(st, root, (Pos(0, 0, 0) * Box(30, 10, 2)).wrapped, "Plate")
    st.UpdateAssemblies()
    _write(doc, path)
    return {"products": 2, "solids": 4}


def asm_nested(path):
    """Depth 3, with the "Board" subassembly instanced TWICE at different world
    positions. A leaf harvested in its parent's frame lands at the wrong place
    here and nowhere in the shallower fixtures — measured: both MCU occurrences
    report the identical local bbox despite being 50mm apart in the file."""
    from build123d import Box, Pos

    doc, st, _ct = _doc()

    board = _empty_assembly(st, "Board")
    _part(st, board, (Pos(1, 1, 0) * Box(4, 4, 1)).wrapped, "MCU")
    _part(st, board, _boxes((1, 1, 3, 6, 1, 0), (1, 1, 3, 8, 1, 0)).wrapped, "Header (x2)")

    electronics = _empty_assembly(st, "Electronics")
    # the same board, twice, 50mm apart — the ONLY thing distinguishing the two
    # occurrences is the component location, so a walk that drops ancestor
    # placement puts both at the same world position instead of two distinct ones
    st.AddComponent(electronics, board, _at(0, 0, 0))
    st.AddComponent(electronics, board, _at(50, 0, 0))

    root = _empty_assembly(st, "Robot")
    st.AddComponent(root, electronics, _at(0, 0, 5))
    _part(st, root, (Pos(0, 0, 0) * Box(80, 20, 2)).wrapped, "Chassis")
    st.UpdateAssemblies()
    _write(doc, path)
    # 2 board occurrences x (1 MCU + 2 header solids) + 1 chassis
    return {"products": 4, "solids": 7}


def asm_colors(path):
    """3 products with their own colour, and one with NONE under a coloured
    parent. build123d's public `.color` getter walks to the nearest coloured
    ancestor and caches the answer onto the shape, so reading it would report
    the parent's colour as the child's own."""
    from build123d import Box, Pos

    doc, st, ct = _doc()
    root = _empty_assembly(st, "Painted")
    _color(ct, root, (0.1, 0.1, 0.9))  # the ancestor colour that must NOT leak down

    box = lambda x: (Pos(x, 0, 0) * Box(5, 5, 5)).wrapped
    _color(ct, _part(st, root, box(0), "Red Part"), (0.9, 0.1, 0.1))
    _color(ct, _part(st, root, box(10), "Green Part"), (0.1, 0.9, 0.1))
    _color(ct, _part(st, root, box(20), "Yellow Part"), (0.9, 0.9, 0.1))
    _part(st, root, box(30), "Uncoloured Part")
    st.UpdateAssemblies()
    _write(doc, path)
    return {"products": 4, "solids": 4}


def asm_empty_product(path):
    """A named product with faces but ZERO solids, alongside a normal one. Today
    the importer drops 11 such products (and 62 faces) from the reference file
    without saying anything."""
    from build123d import Box, Pos

    doc, st, _ct = _doc()
    root = _empty_assembly(st, "WithDecal")
    _part(st, root, (Pos(0, 0, 0) * Box(20, 20, 2)).wrapped, "Panel")
    decal = (Pos(0, 0, 3) * Box(6, 6, 6)).faces()[0]  # a bare Face: no solid, real area
    _part(st, root, decal.wrapped, "Decal")
    st.UpdateAssemblies()
    _write(doc, path)
    return {"products": 2, "solids": 1}


FIXTURES = {
    "asm_flat": asm_flat,
    "asm_multisolid": asm_multisolid,
    "asm_nested": asm_nested,
    "asm_colors": asm_colors,
    "asm_empty_product": asm_empty_product,
}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=FIXTURE_DIR, help="output directory")
    ap.add_argument("--only", help="generate a single fixture by name")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    names = [args.only] if args.only else list(FIXTURES)
    for name in names:
        path = os.path.join(out, f"{name}.step")
        expect = FIXTURES[name](path)
        with open(path) as fh:
            text = fh.read()
        occ = text.count("NEXT_ASSEMBLY_USAGE_OCCURRENCE")
        prod = text.count("PRODUCT_DEFINITION(")
        print(
            f"{name}.step  {os.path.getsize(path) / 1024:6.1f} KB  "
            f"assembly_occurrences={occ}  product_definitions={prod}  "
            f"expect products={expect['products']} solids={expect['solids']}"
        )
        if occ == 0:
            raise SystemExit(
                f"{name}.step carries NO assembly structure — it is the same flat "
                "shape as every .step already in the repo and tests nothing"
            )


if __name__ == "__main__":
    main()
