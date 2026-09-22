# sidecar/fixtures

Geometry the tests load instead of building. `test_assembly.py` owns the
`asm_*.step` files; `test_smoke.py` owns the `offset_*.brep` files.

The rule for putting a file here is narrow: **if a test can build the shape from
primitives, it builds it.** A committed file is only justified when the stored
representation is itself the thing under test. Each entry below says which side
of that line it falls on and what it cost to find out, so nothing here is
load-bearing on faith.

## offset_*.brep — the offset ladder (`_offset_faces`)

These back `test_offset_imported_bore_keeps_its_lip`,
`test_offset_refuses_an_undercut_and_a_taper`,
`test_offset_probe_survives_a_segfault` and `test_offset_rules_are_pinned`.

### offset_chamfer_bore.brep — 5.8 KB, THIRD PARTY, IRREPLACEABLE

A fragment lifted from a vendor's STEP file: a chamfered 4 mm bushing, cut down
to one solid and re-saved as BREP. 6 faces, 28.236634770 mm3, outer cylinder
r=2 h=4, bore r=1.3 length 3.4, a 0.3 mm 45-degree chamfer at each end.

It is the only file here that cannot be replaced by primitives, and the reason
is measured. `Cylinder(2, 4) - Cylinder(1.3, 4)` chamfered 0.3 gives the same
6 faces and the same volume **to 1e-9** (28.236634770 either way) — and then the
two bodies behave differently under `BRepOffset`:

| built how | `_brep_offset_pass` on the r=1.3 bore at +0.15 |
|---|---|
| build123d primitives, in process | returns, `is_valid` true, volume 31.992409 (wrong: the chamfer grew 0.3 -> 0.45) |
| this file | **exit 139, SIGSEGV** |

The probe (`_probe_offsets`) exists for the second row, so a test for it has to
use the second row. Nothing synthetic reproduces it.

### offset_fillet_bore.brep — 10 KB, imported, REPRODUCIBLE (droppable)

8 faces, 513.879261923 mm3: a 4 mm tall disc, outer r=6.5 and bore r=1.1, all
four rims rounded 0.3. It is the body on which `BRepOffset` silently offsets the
**whole solid** — every torus minor radius 0.3 -> 0.45 and the outer wall
6.5 -> 6.65, dV +67.173728 against the correct +3.900565 — while reporting
`IsDone()` and a valid result in about 4 ms.

Kept for provenance only. `Cylinder(6.5, 4) - Cylinder(1.1, 4)` filleted 0.3 on
all four rims matches it to 1e-9 (513.879261923 either way, 8 faces) and
reproduces that defect identically, so unlike the bushing above this file proves
nothing the test could not build.

### offset_cbore_break.brep — 5.3 KB and offset_taper_lip.brep — 2.8 KB

Recorded as authored in this project by the correctness judge during the offset
design bake-off rather than taken from anyone's part, and the evidence agrees:
each is a handful of Box/Cylinder/Cone primitives, which is not what an
extracted vendor solid looks like. They are the two shapes on which
shipped-looking designs produced a wrong body:

- `offset_cbore_break` — 10912.796114 mm3, 10 faces. A 3.0 mm bore with a 0.3
  chamfer sitting under a 3.5 mm counterbore. Growing the bore to 3.15 is still
  clear; growing it to 3.2 puts the chamfer's top edge on the counterbore wall
  and 3.25 puts it through, at 3.55.
- `offset_taper_lip` — 33916.761837 mm3, 5 faces. A 3.0 mm bore whose neighbour
  is an 8-degree **functional taper**, 22 mm long. Every candidate design read
  it as a chamfer and moved its far end with the wall, 6.09 -> 6.34.

`test_retune_screens` builds both from primitives (`_cbore_break`,
`_taper_bore`): measured this session, the synthetic twins match these files to
1.8e-12 and 1.5e-11 mm3 with identical face counts. So these two are droppable
as well; they are kept as the exact bytes the wrong answers were measured on.

## Dropping the imported ones

Two files came in from outside. `offset_chamfer_bore.brep` is recorded as a
vendor STEP fragment; `offset_fillet_bore.brep` is recorded only as "imported",
which is not enough to say it is not, so treat both as third party:

    git rm sidecar/fixtures/offset_chamfer_bore.brep sidecar/fixtures/offset_fillet_bore.brep

That costs the live-SIGSEGV coverage in `test_offset_probe_survives_a_segfault`,
which no synthetic body in this build reproduces, and the imported-provenance
half of the other three. `test_smoke._fixture_shape` asserts the file exists and
names it, so the suite fails saying what it lost rather than passing quietly.
