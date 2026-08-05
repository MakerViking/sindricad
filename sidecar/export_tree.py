"""Derive the tree an export should carry, from the document plus its built bodies.

Deliberately format-agnostic and separate from `exporters.py`: 3MF `<components>`
and glTF's node hierarchy want the SAME derivation, and a fourth copy of the
assembly walk is exactly what `step_assembly.py`'s "one walk, one source of
truth" note exists to prevent.

Why this is small: `build123d.export_step` is NOT the flat `STEPControl` writer
it was assumed to be. It builds an XCAF document via `_create_xde(...,
auto_naming=True)` and writes with `STEPCAFControl_Writer`
(exporters3d.py:370-378), and `set_name_and_color` already writes
`TDataStd_Name` onto BOTH the instance label and the referred label "so STEP
PRODUCT names persist" — which is the name-drop workaround this project
otherwise had to hand-roll. So all that is needed here is a `Compound` whose
`children` mirror the assembly, with `.label` and `.color` set. The XCAF work is
upstream's.

Two hazards this module exists to contain:

1. `Compound(children=[...])` MUTATES each child's `.parent`, and setting
   `.label` mutates the shape object too. The shapes handed to an export are the
   LIVE ones from `rebuild_cached`, also referenced by `builder._CACHE` prefix
   snapshots in a long-lived worker — re-parenting them would corrupt the
   rebuild cache. Every leaf is therefore re-wrapped as a FRESH build123d object
   around the same `TopoDS_Shape` before anything is set on it.

2. Per-occurrence placement lives in each leaf's `TopLoc_Location`, not in its
   coordinates (`.Moved()` sets the location field). Measured on asm_nested: 6 of
   7 leaves carry a non-identity location. Nothing here may strip it, or every
   instance of a repeated subassembly collapses onto the same spot.
"""
from __future__ import annotations


def _fresh(shape):
    """A new build123d wrapper around the same TopoDS shape.

    The location rides on the TopoDS shape, so this preserves placement while
    giving us an object whose `.label`/`.parent` we may safely write.
    """
    from builder import _wrap_topods

    return _wrap_topods(shape.wrapped if hasattr(shape, "wrapped") else shape)


def _color_of(hex_color):
    """'#rrggbb' -> a build123d Color, or None. Values are sRGB, matching what
    `step_assembly._label_color` produced on the way in."""
    if not hex_color:
        return None
    try:
        from build123d import Color

        h = hex_color.lstrip("#")
        if len(h) != 6:
            return None
        return Color(int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)
    except Exception:
        return None  # a bad colour must never fail an export


def build_export_tree(document, bodies, root_name="Model"):
    """A labelled shape for `bodies`, ready to hand to build123d's exporters.

    Returns None when there is nothing to export. For a SINGLE body with no
    assembly tree the body itself is returned (merely labelled), so an ordinary
    one-part export keeps its flat shape and only gains a name.
    """
    from build123d import Compound

    live = [b for b in bodies if b.get("shape") is not None]
    if not live:
        return None

    # the assembly manifests, by import-feature id
    trees = {}
    for f in document.get("features", []):
        if f.get("type") == "import" and f.get("nodes"):
            trees[f.get("id")] = f["nodes"]

    def display_name(b):
        return b.get("name") or b.get("id") or "Body"

    # --- no assembly anywhere: a flat list of NAMED bodies ------------------
    if not trees or not any(b.get("node_ref") for b in live):
        if len(live) == 1:
            only = _fresh(live[0]["shape"])
            only.label = display_name(live[0])
            return only
        flat = []
        for b in live:
            s = _fresh(b["shape"])
            s.label = display_name(b)
            flat.append(s)
        root = Compound(children=flat)
        root.label = root_name
        return root

    # --- assembly: rebuild the product tree from the manifest ---------------
    # Built BOTTOM-UP into plain dicts first, then materialised depth-first.
    # A build123d Compound cannot be created empty and filled later: attaching a
    # child runs `_post_attach`, which reads `.wrapped` off every sibling, and an
    # empty Compound has none. So no Compound is constructed until its full child
    # list is known.
    #
    # One node per (feature, index), so two occurrences of the same subassembly
    # stay separate branches — exactly what the Browser shows.
    spec_of = {}
    kids_of = {}
    leaves_of = {}
    roots = []

    def ensure(feature_id, index, nodes):
        key = (feature_id, index)
        if key in spec_of:
            return key
        spec_of[key] = nodes[index]
        kids_of[key] = []
        leaves_of[key] = []
        parent = nodes[index].get("parent")
        if isinstance(parent, int) and 0 <= parent < len(nodes) and parent != index:
            kids_of[ensure(feature_id, parent, nodes)].append(key)
        else:
            roots.append(key)
        return key

    loose = []
    for b in live:
        ref = b.get("node_ref") or ""
        slash = ref.rfind("/")
        feature_id = ref[:slash] if slash > 0 else ""
        nodes = trees.get(feature_id) if feature_id else None
        index = None
        if nodes is not None:
            try:
                index = int(ref[slash + 1:])
            except ValueError:
                index = None
        leaf = _fresh(b["shape"])
        leaf.label = display_name(b)
        if nodes is None or index is None or not 0 <= index < len(nodes):
            loose.append(leaf)  # never drop a body just because its manifest is off
            continue
        colour = _color_of(nodes[index].get("color"))
        if colour is not None:
            leaf.color = colour
        leaves_of[ensure(feature_id, index, nodes)].append(leaf)

    def materialise(key):
        """A Compound for this node, or None when nothing under it survived."""
        parts = [m for m in (materialise(k) for k in kids_of[key]) if m is not None]
        parts.extend(leaves_of[key])
        if not parts:
            return None
        # A product owning exactly one solid needs no wrapper around it: the leaf
        # already carries the body's name, and an extra level would show up in
        # every downstream CAD system as a one-child assembly.
        if len(parts) == 1 and not kids_of[key]:
            return parts[0]
        group = Compound(children=parts)
        group.label = spec_of[key].get("name") or "Part"
        return group

    top = [m for m in (materialise(k) for k in roots) if m is not None]
    top.extend(loose)
    if not top:
        return None
    if len(top) == 1:
        return top[0]
    root = Compound(children=top)
    root.label = root_name
    return root
