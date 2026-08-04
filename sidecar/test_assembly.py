"""Assembly-tree tests (Phase C).

The gate this file exists for: the document stores imported geometry as ONE
base64 BREP string, and the assembly tree is recovered by binding manifest row i
to top-level child i of that blob. That binding is only sound if a flat
compound's child COUNT and ORDER survive `_shape_to_brep_b64` ->
`_brep_b64_to_shape` unchanged. Nothing else in the repo demonstrates it: the
one real blob committed here (src-tauri/1.sindri) holds a single flat compound,
and `write(read(x)) != x` byte-wise is already a recorded property of this
format. So it is asserted here rather than assumed, across three generations,
against real STEP assemblies rather than a synthetic Compound of boxes.

Run with the sidecar venv:
    .venv/bin/python test_assembly.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
FIXTURE_NAMES = [
    "asm_flat",
    "asm_multisolid",
    "asm_nested",
    "asm_colors",
    "asm_empty_product",
]


def _occt_children(shape):
    """Direct children of a TopoDS shape, each with its ancestor placement
    already composed. Used here to read back what came out of the blob."""
    from OCP.TopoDS import TopoDS_Iterator

    out = []
    it = TopoDS_Iterator(shape)
    while it.More():
        out.append(it.Value())
        it.Next()
    return out


def leaf_occurrences(path):
    """The ordered leaf occurrences of a STEP assembly, as (node, shape).

    Delegates to step_assembly.read_assembly so there is exactly ONE walk in the
    codebase — a second copy here would drift from the one that actually builds
    documents, and the drift would show up as mis-named bodies, not as a test
    failure.
    """
    from step_assembly import read_assembly

    asm = read_assembly(path)
    return [(asm.nodes[i], shape) for i, shape in asm.leaves]


def _fingerprint(shape):
    """Identity of one blob child that is independent of byte layout: face count
    plus rounded volume plus rounded bbox. Volume is what actually proves ORDER —
    face count alone matches between two different boxes."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    n_faces = 0
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        n_faces += 1
        exp.Next()

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    volume = round(props.Mass(), 6)

    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    bbox = None if box.IsVoid() else tuple(round(v, 6) for v in box.Get())
    return (n_faces, volume, bbox)


def _wrap(topods_shape):
    """Wrap a raw TopoDS shape in its build123d class.

    `Shape.cast` is an abstractmethod on the base class and silently returns
    None, and TopoDS_Iterator/TopExp_Explorer hand back generic TopoDS_Shape
    handles, so both a downcast and an explicit lookup are needed. Reuses
    build123d's own `topods_lut` rather than restating the mapping."""
    from build123d.importers import topods_lut
    from build123d.topology import downcast

    concrete = downcast(topods_shape)
    return topods_lut[type(concrete)](concrete)


def _flat_blob(leaves):
    """Serialise the leaf occurrences as ONE flat compound, the way the import
    feature's `brep` field carries them."""
    import builder
    from build123d import Compound

    return builder._shape_to_brep_b64(
        Compound(children=[_wrap(s) for _node, s in leaves])
    )


def test_flat_compound_order_survives_the_brep_round_trip():
    """THE GATE. If this fails, binding manifest row i to blob child i is unsound
    and the geometry has to move to content-addressed storage (Phase D) first."""
    import builder

    for name in FIXTURE_NAMES:
        path = os.path.join(FIXTURES, f"{name}.step")
        leaves = leaf_occurrences(path)
        expected = [_fingerprint(s) for _n, s in leaves]
        assert expected, f"{name}: no leaf occurrences at all"
        # Without this, the order assertion below could pass vacuously: if every
        # leaf fingerprinted the same, any permutation would compare equal. The
        # fixtures are built so no two leaves coincide (a real file could contain
        # two identical parts at the same point; these deliberately do not).
        assert len(set(expected)) == len(expected), (
            f"{name}: leaf fingerprints are not unique, so this fixture cannot "
            f"detect a reordering — fix the fixture, not the assertion"
        )

        b64 = _flat_blob(leaves)
        for generation in (1, 2, 3):
            shape = builder._brep_b64_to_shape(b64)
            kids = _occt_children(shape.wrapped)
            assert len(kids) == len(expected), (
                f"{name} gen{generation}: {len(expected)} children in, "
                f"{len(kids)} out — the blob does not preserve child COUNT"
            )
            got = [_fingerprint(k) for k in kids]
            assert got == expected, (
                f"{name} gen{generation}: child ORDER or identity changed across "
                f"the round trip.\n  in:  {expected}\n  out: {got}"
            )
            # re-serialise what we just read, so generation N+1 tests the blob
            # this code would actually store, not the original one again
            b64 = builder._shape_to_brep_b64(shape)
        print(f"  {name}: {len(expected)} leaves, order stable over 3 generations")


def test_leaf_walk_places_every_occurrence_in_world_space():
    """The transform regression test. asm_nested instances the same "Board"
    subassembly twice, 50mm apart. Harvesting leaves from build123d's `.children`
    returns both occurrences at the SAME local position — measured, not
    theorised: both MCUs report bbox (-1,-1,-0.5)-(3,3,0.5). Only the OCCT walk
    composes the ancestor location."""
    leaves = leaf_occurrences(os.path.join(FIXTURES, "asm_nested.step"))
    by_name = {}
    for node, shape in leaves:
        by_name.setdefault(node.name, []).append(_fingerprint(shape)[2])

    mcus = by_name.get("MCU", [])
    assert len(mcus) == 2, f"expected 2 MCU occurrences, got {len(mcus)}"
    assert mcus[0] != mcus[1], (
        "both MCU occurrences share a bounding box — ancestor placement was "
        f"dropped and every instance is stacked at the same point: {mcus[0]}"
    )
    xs = sorted(b[0] for b in mcus)
    assert abs((xs[1] - xs[0]) - 50.0) < 1e-6, (
        f"the two Board instances should be 50mm apart in world space, got {xs[1] - xs[0]}"
    )
    print(f"  asm_nested: 2 MCU occurrences 50mm apart in world space {xs}")


def test_solid_less_products_are_not_dropped():
    """asm_empty_product's "Decal" is a named product with faces and no solid.
    `_explode_solids` loses it silently; the reference file loses 11 products and
    62 faces the same way."""
    from build123d import import_step

    root = import_step(os.path.join(FIXTURES, "asm_empty_product.step"))
    leaves = leaf_occurrences(os.path.join(FIXTURES, "asm_empty_product.step"))
    names = [n.name for n, _s in leaves]
    assert "Decal" in names, f"the solid-less product was dropped: {names}"

    total = sum(_fingerprint(s)[0] for _n, s in leaves)
    assert total == len(root.faces()), (
        f"face conservation failed: {total} faces across leaves vs "
        f"{len(root.faces())} in the imported shape"
    )
    print(f"  asm_empty_product: kept {names}, {total} faces conserved")


def test_multi_solid_product_stays_one_product_with_many_leaves():
    """"M3 Nut (x3)" is ONE label holding 3 disjoint solids. It must become 3
    selectable bodies that all trace back to the single product name — not 3
    anonymous bodies, and not 1 body."""
    leaves = leaf_occurrences(os.path.join(FIXTURES, "asm_multisolid.step"))
    assert len(leaves) == 4, f"expected 4 leaf occurrences, got {len(leaves)}"
    nut_paths = [n.name for n, _s in leaves if "Nut" in n.name]
    assert len(nut_paths) == 3, f"expected 3 nut solids, got {len(nut_paths)}"
    assert len(set(nut_paths)) == 1, (
        f"the 3 nut solids should share ONE product path, got {set(nut_paths)}"
    )
    print(f"  asm_multisolid: 4 leaves, 3 of them under {nut_paths[0]}")


def test_names_are_verbatim():
    """The names are the whole point of the phase. build123d's import_step runs
    translate(maketrans(" .()", "____")) on every label, which turns the file's
    "M3 Nut (x3)" into "M3_Nut__x3_" — so the tree is read through XCAF directly
    and this asserts nothing mangles it on the way."""
    from step_assembly import read_assembly

    names = [n.name for n in read_assembly(os.path.join(FIXTURES, "asm_multisolid.step")).nodes]
    assert "M3 Nut (x3)" in names, f"the product name was altered: {names}"
    nested = [n.name for n in read_assembly(os.path.join(FIXTURES, "asm_nested.step")).nodes]
    assert "Header (x2)" in nested, f"the product name was altered: {nested}"
    print(f"  verbatim: {[n for n in names if 'Nut' in n]} and {[n for n in nested if 'Header' in n]}")


def test_colour_is_read_per_label_not_inherited():
    """A colour belongs to the label that carries it. build123d's `.color` getter
    walks to the nearest coloured ancestor AND caches the answer onto the shape,
    which both misreports provenance and mutates the tree mid-walk.

    LIMITATION, stated rather than implied: this does not exercise inheritance
    from a coloured ANCESTOR, because STEPCAFControl_Writer did not write the
    assembly-root colour the fixture sets (the file carries 3 COLOUR_RGB entries,
    one per part). What it does prove is that colour is per-product: three
    siblings each keep their own and the fourth reports none. Inheritance is
    structurally impossible here anyway — `_label_color` reads exactly one label.
    """
    from step_assembly import read_assembly

    by_name = {n.name: n.color for n in read_assembly(os.path.join(FIXTURES, "asm_colors.step")).nodes}
    assert by_name["Red Part"] == "#e51919", by_name
    assert by_name["Green Part"] == "#19e519", by_name
    assert by_name["Yellow Part"] == "#e5e519", by_name
    assert by_name["Uncoloured Part"] is None, (
        f"a product with no colour of its own reported one: {by_name['Uncoloured Part']}"
    )
    print(f"  per-label colours: {by_name}")


def test_a_single_part_step_is_not_treated_as_an_assembly():
    """The manifest path must be opt-in on the file actually carrying a tree.
    Ordinary part files stay on the historical import path with nothing changed —
    every .step already committed here is one of these."""
    from step_assembly import read_assembly

    for name in ("parts3-Split.step", "RAM1-ddr_1.step"):
        path = os.path.join(os.path.dirname(FIXTURES), "..", "src-tauri", name)
        if not os.path.exists(path):
            print(f"  (skipped {name}: not present)")
            continue
        asm = read_assembly(path)
        assert not asm.is_assembly, (
            f"{name} is a single-part file but was classified as an assembly "
            f"({asm.product_count} products) — this would change the import path "
            f"for every ordinary STEP"
        )
        print(f"  {name}: is_assembly=False ({asm.product_count} product)")


def _import_doc(fixture):
    """A one-feature document holding an imported fixture, as the frontend would
    build it."""
    import builder

    payload = builder.import_geometry(os.path.join(FIXTURES, f"{fixture}.step"), "step")
    return payload, {
        "version": 1,
        "parameters": {},
        "features": [dict(payload, id="f1", type="import", format="step")],
    }


def _rebuild(doc, diagnostics=None):
    import builder

    _part, errors, out_bodies = builder.rebuild(doc, diagnostics=diagnostics)
    assert not errors, f"rebuild reported errors: {errors}"
    return out_bodies


def test_rebuild_names_bodies_from_the_manifest():
    """The headline outcome: a multi-solid product yields individually selectable
    bodies that all carry the product's own name, instead of Body1..BodyN."""
    _payload, doc = _import_doc("asm_multisolid")
    bodies = _rebuild(doc)
    names = [b["name"] for b in bodies]
    assert names == ["M3 Nut (x3) 1", "M3 Nut (x3) 2", "M3 Nut (x3) 3", "Plate"], names
    # every body traces back to the tree node it came from
    refs = [b.get("node_ref") for b in bodies]
    assert refs == ["f1/1", "f1/1", "f1/1", "f1/2"], refs
    print(f"  {names}")


def test_rebuild_keeps_each_occurrence_of_a_repeated_subassembly_distinct():
    """asm_nested instances "Board" twice. The two occurrences must be separate
    tree nodes, so selecting one MCU does not select the other."""
    _payload, doc = _import_doc("asm_nested")
    bodies = _rebuild(doc)
    mcus = [b for b in bodies if b["name"] == "MCU"]
    assert len(mcus) == 2, [b["name"] for b in bodies]
    assert mcus[0]["node_ref"] != mcus[1]["node_ref"], (
        f"both MCU occurrences share one tree node: {mcus[0]['node_ref']}"
    )
    print(f"  MCU occurrences: {[b['node_ref'] for b in mcus]}")


def test_rebuild_keeps_the_solid_less_product_as_a_body():
    """Today `_explode_solids` drops these without a word — 11 products and 62
    faces on the reference file."""
    _payload, doc = _import_doc("asm_empty_product")
    names = [b["name"] for b in _rebuild(doc)]
    assert names == ["Panel", "Decal"], names
    print(f"  {names}")


def test_a_manifest_that_disagrees_with_the_geometry_falls_back_loudly():
    """A wrong tree is worse than no tree: every body still builds, just wearing
    another part's name. So a mismatch must degrade to the historical unnamed
    bodies AND say why."""
    _payload, doc = _import_doc("asm_multisolid")
    doc["features"][0]["parts"][2]["faces"] = 999  # geometry says 6

    diagnostics = []
    bodies = _rebuild(doc, diagnostics=diagnostics)
    names = [b["name"] for b in bodies]
    assert all("M3 Nut" not in n for n in names), (
        f"a manifest that disagrees with the geometry was used anyway: {names}"
    )
    assert not any(b.get("node_ref") for b in bodies), (
        "bodies were bound to tree nodes despite the mismatch"
    )
    assert any(d.get("kind") == "import" for d in diagnostics), (
        f"the fallback was silent — nothing recorded in diagnostics: {diagnostics}"
    )
    reason = next(d["reason"] for d in diagnostics if d.get("kind") == "import")
    assert "999" in reason and "6" in reason, reason
    print(f"  fell back to {names} — {reason}")


def test_an_import_without_a_manifest_rebuilds_exactly_as_before():
    """Every document saved before this existed, and every ordinary part file.
    Body ids are positional and eight feature handlers resolve a body by id with
    no identity check, so a shifted id silently edits the WRONG body."""
    import builder

    path = os.path.join(os.path.dirname(FIXTURES), "..", "src-tauri", "parts3-ddr_2.step")
    if not os.path.exists(path):
        print("  (skipped: fixture not present)")
        return
    payload = builder.import_geometry(path, "step")
    assert "nodes" not in payload and "parts" not in payload, (
        "a single-part STEP grew an assembly manifest"
    )
    doc = {
        "version": 1,
        "parameters": {},
        "features": [dict(payload, id="f1", type="import", format="step")],
    }
    bodies = _rebuild(doc)
    assert [b["id"] for b in bodies] == [f"body{i + 1}" for i in range(len(bodies))]
    assert [b["name"] for b in bodies] == [
        f"{payload['name']} {i + 1}" for i in range(len(bodies))
    ], [b["name"] for b in bodies]
    assert not any("node_ref" in b for b in bodies)
    print(f"  {len(bodies)} bodies, ids and names unchanged")


def test_part_names_do_not_leak_into_the_parameter_scope():
    """`_feature_scope` regex-scans every short string for parameter identifiers.
    A real product called "Bracket t Left" would otherwise drag parameter `t`
    into this import's invalidation scope, so moving an unrelated slider would
    force a cold re-import of the most expensive feature in the document."""
    import builder

    feature = {
        "id": "f1",
        "type": "import",
        "format": "step",
        "name": "Imported",
        "brep": "",
        "nodes": [{"name": "Bracket t Left", "parent": None}],
        "parts": [{"node": 0, "faces": 6}],
    }
    params = {"t": 5.0}
    # also compiles builder's lazily-built identifier regex
    closure = builder._param_closure(params)
    scope_at_5 = builder._feature_scope(feature, params, closure, "{}")
    scope_at_6 = builder._feature_scope(feature, {"t": 6.0}, closure, "{}")
    assert scope_at_5 == scope_at_6, (
        f"a product name pulled parameter `t` into the import's cache key: "
        f"{scope_at_5!r} vs {scope_at_6!r}"
    )
    print("  product names stay out of the parameter scope")


def test_node_ref_survives_a_disk_checkpoint_resume():
    """The assembly tree must survive reopening the document.

    This is the likeliest place for the whole phase to fail silently. An import
    always blows the checkpoint budget, so a DISK resume is the normal way an
    assembly document reopens — and `_body_fingerprint` compares geometry only,
    so a dropped metadata key produces no mismatch, no error, and a browser tree
    that is simply flat again. The same bug already shipped once for `_textures`
    (see the comment at builder.py's `_save_checkpoint`).
    """
    import shutil
    import tempfile

    import builder
    import geomstore

    _payload, doc = _import_doc("asm_multisolid")
    tmp = tempfile.mkdtemp(prefix="sindri_asm_ckpt_")
    orig_store = builder._disk_store
    orig_cache = builder._CACHE
    try:
        store = geomstore.Store(root=tmp)
        builder._disk_store = lambda: store
        keys = builder._chain_keys_scoped(doc, builder._feature_sigs(doc["features"]))
        _p, errors, bodies = builder.rebuild(
            doc,
            persist={"store": store, "keys": keys, "mod": {},
                     "acc_ms": 0.0, "budget_ms": 0.0},
        )
        assert not errors, errors
        cold = [(b["name"], b.get("node_ref")) for b in bodies]
        assert all(ref for _n, ref in cold), f"the cold build lost node_ref: {cold}"

        hit = builder._restore_from_disk(store, keys)
        assert hit is not None, "no restorable checkpoint was written"
        restored = [(b["name"], b.get("node_ref")) for b in hit[1]["bodies"]]
        assert restored == cold, f"the checkpoint dropped the tree: {restored} != {cold}"

        # production path: RAM cleared, so this resumes from disk
        builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
        _p2, _e2, b2 = builder.rebuild_cached(doc)
        assert [(b["name"], b.get("node_ref")) for b in b2] == cold, (
            f"a disk-resumed build came back flat: "
            f"{[(b['name'], b.get('node_ref')) for b in b2]}"
        )
        print(f"  survived a disk resume: {cold}")
    finally:
        builder._disk_store = orig_store
        builder._CACHE = orig_cache
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    missing = [
        n for n in FIXTURE_NAMES if not os.path.exists(os.path.join(FIXTURES, f"{n}.step"))
    ]
    if missing:
        raise SystemExit(
            f"missing fixtures {missing} — run: .venv/bin/python tools/gen_asm_fixtures.py"
        )
    failures = 0
    for fn in [
        test_flat_compound_order_survives_the_brep_round_trip,
        test_leaf_walk_places_every_occurrence_in_world_space,
        test_solid_less_products_are_not_dropped,
        test_multi_solid_product_stays_one_product_with_many_leaves,
        test_names_are_verbatim,
        test_colour_is_read_per_label_not_inherited,
        test_a_single_part_step_is_not_treated_as_an_assembly,
        test_rebuild_names_bodies_from_the_manifest,
        test_rebuild_keeps_each_occurrence_of_a_repeated_subassembly_distinct,
        test_rebuild_keeps_the_solid_less_product_as_a_body,
        test_a_manifest_that_disagrees_with_the_geometry_falls_back_loudly,
        test_an_import_without_a_manifest_rebuilds_exactly_as_before,
        test_part_names_do_not_leak_into_the_parameter_scope,
        test_node_ref_survives_a_disk_checkpoint_resume,
    ]:
        print(f"{fn.__name__} …")
        try:
            fn()
        except AssertionError as exc:
            failures += 1
            print(f"  FAIL: {exc}")
    print("FAILED" if failures else "all assembly tests passed")
    sys.exit(1 if failures else 0)
