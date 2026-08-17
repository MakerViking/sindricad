"""Read a STEP file's XCAF product tree: names, colours, placement.

Why this exists instead of `build123d.import_step`: that function is a fine
geometry reader but it is lossy in two ways that matter for assemblies.

1. It MANGLES names. `get_name` runs `translate(str.maketrans(" .()", "____"))`
   to appease an unrelated viewer, so a product the file calls "M3 Nut (x20)"
   comes back as "M3_Nut__x20_". Since the whole point of keeping the assembly
   tree is showing the user the names their CAD system wrote, that is the one
   thing that cannot be lossy.
2. Its `.children` are NOT world-placed. `Shape.move` mutates only the parent
   compound's TopLoc_Location, so harvesting a leaf's `.wrapped` from a
   `.children` walk yields it in its PARENT's frame. Measured on a depth-3
   fixture: the same subassembly instanced twice 50mm apart produced two leaves
   with identical bounding boxes. Composing locations while walking XCAF avoids
   ever creating that hazard, rather than guarding against it afterwards.

Reading XCAF directly also removes a structural risk. Only the XCAF layer knows
which compounds are assemblies and which are multi-solid products — both are
TopAbs_COMPOUND to OCCT — so any design that reads structure from one tree and
geometry from another has to keep two walks in lockstep. On the reference file
493 of 1,293 leaf products are compounds, i.e. exactly the nodes where such
walks diverge. One walk, one source of truth.

This module owns no geometry operations; it reads and returns shapes.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import untrusted


@dataclass
class AssemblyNode:
    """One product in the tree. `parent` indexes into the same node list, or is
    None for a root. `color` is "#rrggbb" or None — read from this label only,
    never inherited from an ancestor."""

    name: str
    parent: int | None
    color: str | None = None


@dataclass
class Assembly:
    """A STEP file's product tree plus its geometry, flattened.

    `leaves` is the ordered list of (node index, world-placed TopoDS_Shape)
    occurrences: one entry per SOLID of a leaf product, so a product holding 20
    solids contributes 20 leaves that all name the same node. A product with no
    solids at all contributes ONE leaf carrying its whole shape, which is how
    products that today vanish silently stay in the document.
    """

    nodes: list[AssemblyNode] = field(default_factory=list)
    leaves: list[tuple[int, object]] = field(default_factory=list)
    #: True when the file carries real assembly structure. When False the caller
    #: should stay on the historical single-shape import path.
    is_assembly: bool = False
    #: The file's free (top-level) shapes, placed. Kept so a non-assembly file
    #: can go down the historical path without paying for a SECOND full read —
    #: on a large single-part STEP that second read would double import time.
    roots: list[object] = field(default_factory=list)

    @property
    def product_count(self) -> int:
        return len(self.nodes)


def _clean(name: str) -> str:
    """Strip Unicode control characters and bound the length.

    Control characters are removed because they can break rendering and are
    never meaningful in a product name. Spaces, dots and brackets are KEPT —
    losing them is the bug this module exists to avoid.

    The rule now lives in `untrusted.clean`, which applies it to every
    document-derived string rather than only to the ones that arrive via STEP,
    and adds the length cap this function never had: a product name is
    attacker-supplied and was previously unbounded.
    """
    return untrusted.clean(name, untrusted.MAX_SUBJECT)


def _label_name(label) -> str:
    from OCP.TCollection import TCollection_AsciiString
    from OCP.TDataStd import TDataStd_Name

    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        return _clean(TCollection_AsciiString(attr.Get()).ToCString())
    return ""


def _label_color(label) -> str | None:
    """The colour attached to THIS label, as '#rrggbb', or None.

    Deliberately does not fall back to an ancestor's colour: build123d's public
    `.color` getter does, and also caches the answer onto the shape, so it
    reports a parent's colour as the child's own and mutates the tree while you
    walk it.

    OCCT stores colour components linear; '#rrggbb' everywhere else in this
    codebase means sRGB, so convert rather than scaling the raw values (a
    mid-grey would otherwise come out visibly too dark).
    """
    from OCP.Quantity import Quantity_Color, Quantity_ColorRGBA
    from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType

    rgba = Quantity_ColorRGBA()
    for kind in (
        XCAFDoc_ColorType.XCAFDoc_ColorSurf,
        XCAFDoc_ColorType.XCAFDoc_ColorGen,
        XCAFDoc_ColorType.XCAFDoc_ColorCurv,
    ):
        if not XCAFDoc_ColorTool.GetColor_s(label, kind, rgba):
            continue
        linear = rgba.GetRGB()
        to_srgb = Quantity_Color.Convert_LinearRGB_To_sRGB_s  # per component
        return "#{:02x}{:02x}{:02x}".format(
            *(
                max(0, min(255, round(to_srgb(v) * 255)))
                for v in (linear.Red(), linear.Green(), linear.Blue())
            )
        )
    return None


def _solids_of(shape):
    """Every solid in a shape, each carrying its composed location."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    out = []
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def read_assembly(path: str) -> Assembly:
    """Read `path` and return its product tree with world-placed leaf geometry.

    Uses the same STEPCAFControl_Reader build123d uses, so this costs one read,
    not two, and inherits the same unit and tolerance handling.
    """
    from OCP.IFSelect import IFSelect_ReturnStatus
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDF import TDF_Label, TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    doc = TDocStd_Document(TCollection_ExtendedString("XCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(True)
    if reader.ReadFile(path) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise ValueError("could not read the STEP file (it may be truncated or not STEP)")
    if not reader.Transfer(doc):
        raise ValueError("the STEP file was read but contained no transferable shape")

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    asm = Assembly()

    def resolve(label):
        """A component label points at the product it instances; a free shape is
        its own product. Returns the product (referred) label."""
        if shape_tool.IsReference_s(label):
            referred = TDF_Label()
            shape_tool.GetReferredShape_s(label, referred)
            return referred
        return label

    def visit(label, parent: int | None, location: TopLoc_Location):
        referred = resolve(label)
        # Name: prefer the product's own label. Fall back to the instance label,
        # then to a positional placeholder — an unnamed product must still be
        # addressable rather than collapsing into its neighbour.
        name = _label_name(referred) or _label_name(label)
        # Colour: the per-instance override wins over the product's own, which
        # is the same precedence STEP itself defines.
        color = _label_color(label) or _label_color(referred)
        index = len(asm.nodes)
        asm.nodes.append(
            AssemblyNode(name=name or f"Part {index + 1}", parent=parent, color=color)
        )

        if shape_tool.IsAssembly_s(referred):
            asm.is_assembly = True
            components = TDF_LabelSequence()
            shape_tool.GetComponents_s(referred, components)
            for i in range(components.Length()):
                component = components.Value(i + 1)
                visit(
                    component,
                    index,
                    location * shape_tool.GetLocation_s(component),
                )
            return

        shape = shape_tool.GetShape_s(referred).Moved(location)
        solids = _solids_of(shape)
        if solids:
            asm.leaves.extend((index, s) for s in solids)
        else:
            asm.leaves.append((index, shape))

    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() == 0:
        raise ValueError("the STEP file contains no shapes")
    for i in range(roots.Length()):
        label = roots.Value(i + 1)
        location = TopLoc_Location()
        asm.roots.append(shape_tool.GetShape_s(resolve(label)).Moved(location))
        visit(label, None, location)

    # More products than roots means there is real structure to keep. A single
    # unnested product is an ordinary part file and must stay on the historical
    # import path, unchanged.
    if len(asm.nodes) > roots.Length():
        asm.is_assembly = True
    return asm
