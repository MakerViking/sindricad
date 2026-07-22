"""Stage-0 spike: hand-write colored 3MF variants and check which encoding
Snapmaker Orca round-trips (colors shown + mapped to toolheads).

A 3MF is just a zip with [Content_Types].xml, _rels/.rels and 3D/3dmodel.model.
build123d's Mesher does NOT emit color and lib3mf can't set triangle props after
mesh creation, so we write the model XML by hand — which is also the basis for the
production exporter.

Run:  cd sidecar && uv run python spike_color3mf.py
Then open the three files in /tmp/sindri-color-spike/ in Snapmaker Orca and report
which show the two colors correctly assigned to separate toolheads.
"""

import os
import zipfile

OUT = "/tmp/sindri-color-spike"

CT = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""


def _box(ox=0.0, oy=0.0, oz=0.0, s=20.0):
    """8 verts + 12 triangles for an s mm cube at offset (ox,oy,oz)."""
    v = [(ox + x * s, oy + y * s, oz + z * s)
         for (x, y, z) in [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
                            (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]]
    # 6 faces, 2 triangles each (face index = i // 2)
    t = [(0, 2, 1), (0, 3, 2),   # bottom (z-)
         (4, 5, 6), (4, 6, 7),   # top (z+)
         (0, 1, 5), (0, 5, 4),   # front (y-)
         (2, 3, 7), (2, 7, 6),   # back (y+)
         (1, 2, 6), (1, 6, 5),   # right (x+)
         (0, 4, 7), (0, 7, 3)]   # left (x-)
    return v, t


def _verts_xml(v):
    return "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for (x, y, z) in v)


def _write_3mf(path, model_xml):
    os.makedirs(OUT, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", model_xml)
    print(f"  wrote {path}")


# --- Variant A: two OBJECTS, each a basematerials displaycolor -----------------
def variant_objects():
    va, ta = _box(0, 0, 0)
    vb, tb = _box(25, 0, 0)  # second box beside the first
    tris_a = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for (a, b, c) in ta)
    tris_b = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for (a, b, c) in tb)
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
 xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
 xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
 <resources>
  <m:basematerials id="1">
   <m:base name="Red" displaycolor="#E03030FF"/>
   <m:base name="Blue" displaycolor="#3050E0FF"/>
  </m:basematerials>
  <object id="2" type="model" pid="1" pindex="0"><mesh><vertices>{_verts_xml(va)}</vertices><triangles>{tris_a}</triangles></mesh></object>
  <object id="3" type="model" pid="1" pindex="1"><mesh><vertices>{_verts_xml(vb)}</vertices><triangles>{tris_b}</triangles></mesh></object>
 </resources>
 <build><item objectid="2"/><item objectid="3"/></build>
</model>"""
    _write_3mf(f"{OUT}/A_two_objects.3mf", xml)


# --- Variant B: ONE object, per-triangle slic3rpe:mmu_segmentation -------------
# Extruder hex sequence per research: 4=ext1, 8=ext2, C=ext3, 1C=ext4.
def variant_mmuseg():
    v, t = _box(0, 0, 0)
    seg = ["4", "4", "8", "8", "4", "4", "8", "8", "4", "4", "8", "8"]  # alternate by face
    tris = "".join(
        f'<triangle v1="{a}" v2="{b}" v3="{c}" slic3rpe:mmu_segmentation="{seg[i]}"/>'
        for i, (a, b, c) in enumerate(t))
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
 xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
 xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
 xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <resources>
  <m:basematerials id="1">
   <m:base name="Red" displaycolor="#E03030FF"/>
   <m:base name="Blue" displaycolor="#3050E0FF"/>
  </m:basematerials>
  <object id="2" type="model" pid="1" pindex="0"><mesh><vertices>{_verts_xml(v)}</vertices><triangles>{tris}</triangles></mesh></object>
 </resources>
 <build><item objectid="2"/></build>
</model>"""
    _write_3mf(f"{OUT}/B_mmu_segmentation.3mf", xml)


# --- Variant C: ONE object, standard m:colorgroup per-triangle (flat p1) -------
def variant_colorgroup():
    v, t = _box(0, 0, 0)
    idx = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]  # color index per triangle, by face
    tris = "".join(
        f'<triangle v1="{a}" v2="{b}" v3="{c}" pid="1" p1="{idx[i]}"/>'
        for i, (a, b, c) in enumerate(t))
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
 xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
 xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
 <resources>
  <m:colorgroup id="1">
   <m:color color="#E03030FF"/>
   <m:color color="#3050E0FF"/>
  </m:colorgroup>
  <object id="2" type="model"><mesh><vertices>{_verts_xml(v)}</vertices><triangles>{tris}</triangles></mesh></object>
 </resources>
 <build><item objectid="2"/></build>
</model>"""
    _write_3mf(f"{OUT}/C_colorgroup.3mf", xml)


# --- Variant D: Orca PROJECT format (per-object extruder assignments) ----------
# Calls the PRODUCTION writer (project3mf.py) so the manual Orca check validates
# real exporter output. Pass = Orca 2.4.0-alpha opens it AS A PROJECT (not plain
# geometry), selects the Snapmaker U1 printer preset, and shows RedCube on
# extruder 1 / BlueCube on extruder 2 with the palette colors as filaments.
def variant_project():
    from project3mf import sanitize_inputs, write_project_3mf

    def flat(v, t):
        return [c for p in v for c in p], [i for tri in t for i in tri]

    pa, ia = flat(*_box(0, 0, 0))
    pb, ib = flat(*_box(25, 0, 0))
    bodies = [
        {"id": "b1", "name": "RedCube", "positions": pa, "indices": ia},
        {"id": "b2", "name": "BlueCube", "positions": pb, "indices": ib},
    ]
    palette, colors, names = sanitize_inputs(
        [{"name": "Red", "color": "#E03030"}, {"name": "Blue", "color": "#3050E0"}],
        {"b2": 1},
        {},
    )
    settings = {"printer_model": "Snapmaker U1", "printer_variant": "0.4",
                "version": "2.4.0.0"}
    os.makedirs(OUT, exist_ok=True)
    path = write_project_3mf(bodies, f"{OUT}/D_orca_project.3mf",
                             palette, colors, names, settings)
    print(f"  wrote {path}")


# --- Variant E: PROJECT format + per-triangle mmu_segmentation (F2 Stage 4 gate)
# The unverified combination the two-tone texture export depends on: ONE object
# inside the BambuStudio-flavored project layout (model_settings extruder rows,
# project_settings filament slots) whose top-face triangles carry
# slic3rpe:mmu_segmentation. PASS = Orca opens it as a U1 project AND slices the
# top face on extruder 2 while the body stays on extruder 1.
def variant_project_mmuseg():
    v, t = _box(0, 0, 0)
    # every triangle tagged explicitly (no fallback ambiguity): body=ext1 ("4"),
    # top face (triangles 2,3) = ext2 ("8") — mirrors what the production
    # exporter will emit for a colorSlot-tagged textured face.
    seg = ["4"] * 12
    seg[2] = seg[3] = "8"
    tris = "".join(
        f'<triangle v1="{a}" v2="{b}" v3="{c}" slic3rpe:mmu_segmentation="{seg[i]}"/>'
        for i, (a, b, c) in enumerate(t))
    verts = _verts_xml(v)
    model = f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
 xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
 xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
 xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"
 xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">SindriCAD</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <m:basematerials id="1">
   <m:base name="Red" displaycolor="#E03030FF"/>
   <m:base name="Blue" displaycolor="#3050E0FF"/>
  </m:basematerials>
  <object id="2" type="model" name="TwoToneCube" pid="1" pindex="0"><mesh><vertices>{verts}</vertices><triangles>{tris}</triangles></mesh></object>
 </resources>
 <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 125 125 0" printable="1"/></build>
</model>"""
    model_settings = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="TwoToneCube"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="TwoToneCube"/>
    </part>
  </object>
</config>"""
    import json
    proj = json.dumps({
        "filament_colour": ["#E03030", "#3050E0"],
        "printer_model": "Snapmaker U1", "printer_variant": "0.4",
        "version": "2.4.0.0",
    }, indent=1)
    os.makedirs(OUT, exist_ok=True)
    path = f"{OUT}/E_project_mmuseg.3mf"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", model_settings)
        z.writestr("Metadata/project_settings.config", proj)
    print(f"  wrote {path}")


if __name__ == "__main__":
    print("colored-3MF spike → " + OUT)
    variant_objects()
    variant_mmuseg()
    variant_colorgroup()
    variant_project()
    variant_project_mmuseg()
    print("Open all five in OrcaSlicer; report which show Red+Blue mapped to "
          "separate toolheads/filaments. D must open AS A PROJECT with the "
          "Snapmaker U1 preset selected. E is the F2-Stage-4 gate: PASS = the "
          "cube opens as a project on the U1 preset AND its top shows the "
          "second filament color (per-triangle paint inside a project 3MF).")
