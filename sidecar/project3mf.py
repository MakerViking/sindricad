"""Orca-project 3MF writer: one object per body, per-object extruder (= palette
slot) assignments, palette colors as filament slots.

Why hand-written: build123d's Mesher emits no color, and Orca ignores generic 3MF
color on import anyway — what survives an "open as project" round-trip is the
Bambu/Orca PROJECT layout: per-object `<metadata key="extruder">` rows in
Metadata/model_settings.config plus a filament_colour array in
Metadata/project_settings.config. Objects also carry plain m:basematerials so the
file still renders colored in generic 3MF viewers.

Indexing convention (easy to get wrong): SindriCAD palette slots and the
project_settings filament_colour array are 0-based; the model_settings "extruder"
metadata is 1-based. A body with no palette assignment goes to extruder 1.
"""

import json
import os
import zipfile
from xml.sax.saxutils import escape, quoteattr

# Orca/BambuStudio treat a 3MF as *their* project format when this marker
# metadata is present in the model; without it the file risks the plain-3MF
# import path, which drops extruder assignments.
_BBS_NS = "http://schemas.bambulab.com/package/2021"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""

# Slot cap matches the palette (≤4 U1 toolheads) with headroom; server-side
# validation, not a format limit.
MAX_SLOTS = 8
MAX_NAME = 100


def _norm_color(c, fallback="#808080"):
    """Accept '#RRGGBB'/'RRGGBB' (case-insensitive); return '#RRGGBB' upper."""
    s = str(c or "").strip().lstrip("#")
    if len(s) == 8:  # tolerate RRGGBBAA from printer-side sources
        s = s[:6]
    if len(s) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in s):
        return fallback
    return "#" + s.upper()


def sanitize_inputs(palette, body_colors, body_names):
    """Clamp untrusted request fields to what the writer expects. Returns
    (palette, body_colors, body_names) with colors normalized, names capped and
    slot indices restricted to the palette range (out-of-range → unassigned)."""
    pal = []
    for slot in list(palette or [])[:MAX_SLOTS]:
        slot = slot if isinstance(slot, dict) else {}
        entry = {
            "name": str(slot.get("name") or f"Filament {len(pal) + 1}")[:MAX_NAME],
            "color": _norm_color(slot.get("color")),
        }
        material = str(slot.get("material") or "").strip()[:MAX_NAME]
        if material:
            entry["material"] = material
        pal.append(entry)
    colors = {}
    for bid, idx in dict(body_colors or {}).items():
        try:
            idx = int(idx)
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(pal):
            colors[str(bid)] = idx
    names = {str(k): str(v)[:MAX_NAME] for k, v in dict(body_names or {}).items()}
    return pal, colors, names


def _bbox(bodies):
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for b in bodies:
        pos = b["positions"]
        for i in range(0, len(pos), 3):
            for a in range(3):
                v = pos[i + a]
                if v < lo[a]:
                    lo[a] = v
                if v > hi[a]:
                    hi[a] = v
    return lo, hi


def _paint_attr(slot):
    """The `paint_color` value for a 0-based palette slot.

    Bambu/Orca store per-face painting as a `paint_color` attribute on
    <triangle>; PrusaSlicer spells the identical encoding
    `slic3rpe:mmu_segmentation`. The value is a SLOT INDEX, never a colour — the
    RGB always comes from filament_colour in project_settings.config, which this
    writer already emits. Documented values, by 1-based extruder:

        1 -> "4"    2 -> "8"    3 -> "0C"    4 -> "1C"    5 -> "2C"

    i.e. 1 and 2 are `n << 2`, and everything from 3 up is `((n - 3) << 4) | 0xC`
    zero-padded to two hex digits.

    Extruder 1 encodes as "4" like any other — whether to emit it at all is the
    CALLER's decision, taken by comparing against the object's own extruder, not
    something to smuggle in here as an empty string. A face explicitly on slot 0
    of an object whose base is slot 2 genuinely needs "4" written out.

    UPPERCASE, and that is not cosmetic: Bambu Studio's parser accepts only
    A-F and silently ignores lowercase, which is a documented cause of a painted
    model importing as a single colour. Never `.lower()` this.

    Whole faces only. A brush stroke that splits a triangle makes the slicer emit
    long strings encoding a recursive subdivision tree, which is undocumented and
    reverse-engineered; painting whole B-rep faces never reaches that encoding.
    """
    n = int(slot) + 1
    if n <= 1:
        return "4"
    if n == 2:
        return "8"
    return f"{((n - 3) << 4) | 0xC:02X}"


def _mesh_xml(positions, indices, face_ids=None, face_slots=None, base_slot=0):
    """The whole mesh as one string. Kept for callers with small meshes and for
    the tests; `_mesh_chunks` is what the writer uses."""
    return "".join(_mesh_chunks(positions, indices, face_ids, face_slots, base_slot))


# Vertices per emitted chunk. Large enough that the per-chunk overhead is noise,
# small enough that peak memory stays flat regardless of body size.
_XML_CHUNK_VERTS = 4096


def _mesh_chunks(positions, indices, face_ids=None, face_slots=None, base_slot=0):
    """Yield a body's <mesh> XML in bounded pieces.

    Built as a generator rather than one string because the caller streams it
    straight into the zip. A 3,000-body assembly at export grade is millions of
    triangles, and materialising that as a single Python str (plus the list of
    per-element strings "".join consumes) costs many times the mesh itself — on
    the one path that has no triangle budget of its own.

    `face_ids` is tessellate()'s third return, one B-rep face id PER TRIANGLE, and
    `face_slots` a dense per-face palette slot (None where unpainted). Together
    they paint whole faces without touching a vertex. A face whose slot equals
    `base_slot` emits no attribute: the object already carries that extruder, so
    writing it again would be noise on every triangle of the common case.
    """
    yield "<mesh><vertices>"
    buf = []
    for i in range(0, len(positions) - 2, 3):
        buf.append(
            f'<vertex x="{positions[i]:.6g}" y="{positions[i + 1]:.6g}" '
            f'z="{positions[i + 2]:.6g}"/>'
        )
        if len(buf) >= _XML_CHUNK_VERTS:
            yield "".join(buf)
            buf = []
    if buf:
        yield "".join(buf)
    yield "</vertices><triangles>"
    # Precompute slot -> attribute once; per-triangle f-strings are the hot loop
    # on a multi-million-triangle assembly.
    attrs = {}
    if face_ids is not None and face_slots:
        for s in set(s for s in face_slots if s is not None):
            if s != base_slot:
                v = _paint_attr(s)
                if v:
                    attrs[s] = f' paint_color="{v}"'
    buf = []
    for i in range(0, len(indices) - 2, 3):
        paint = ""
        if attrs:
            t = i // 3
            if t < len(face_ids):
                fid = face_ids[t]
                if 0 <= fid < len(face_slots):
                    paint = attrs.get(face_slots[fid], "")
        buf.append(
            f'<triangle v1="{indices[i]}" v2="{indices[i + 1]}" v3="{indices[i + 2]}"{paint}/>'
        )
        if len(buf) >= _XML_CHUNK_VERTS:
            yield "".join(buf)
            buf = []
    if buf:
        yield "".join(buf)
    yield "</triangles></mesh>"


def write_project_3mf(bodies, path, palette, body_colors, body_names, settings,
                      bed=(270.0, 270.0), face_slots=None):
    """Write an Orca-project 3MF. Returns `path`.

    bodies      : [{"id", "name", "positions", "indices", "faceIds"}] — flat
                  mm/Z-up lists straight from tessellate(); "faceIds" is its
                  third return, one B-rep face id per triangle
    face_slots  : {body id → dense per-face palette slot, None where unpainted}
                  — per-FACE colour, written as per-triangle `paint_color`. The
                  object's own extruder stays the base layer, so a face whose
                  slot equals it emits nothing
    palette     : [{"name", "color"}] 0-based slots (sanitize_inputs first)
    body_colors : {body id → slot index}; missing → slot 0 (extruder 1)
    body_names  : {body id → display name} (sidebar renames win over b["name"])
    settings    : dict merged into project_settings.config; caller-provided keys
                  win, filament_colour is derived from the palette when absent
    bed         : (x, y) mm — the assembly is centered on it, z-min dropped to 0
    """
    if not bodies:
        raise ValueError("nothing to export — no bodies")

    # One SHARED translation for all build items: relative body positions are an
    # assembly and must survive; only the group as a whole moves onto the plate.
    lo, hi = _bbox(bodies)
    tx = bed[0] / 2 - (lo[0] + hi[0]) / 2
    ty = bed[1] / 2 - (lo[1] + hi[1]) / 2
    tz = -lo[2]
    transform = f"1 0 0 0 1 0 0 0 1 {tx:.6g} {ty:.6g} {tz:.6g}"

    mats = "".join(
        f'<m:base name={quoteattr(s["name"])} displaycolor="{s["color"]}FF"/>'
        for s in palette
    )
    basematerials = f'<m:basematerials id="1">{mats}</m:basematerials>' if palette else ""

    objects_meta, items_xml, cfg_objects = [], [], []
    for n, b in enumerate(bodies):
        oid = n + 2  # id 1 = the basematerials resource
        slot = body_colors.get(str(b["id"]), 0) if palette else 0
        name = body_names.get(str(b["id"])) or b.get("name") or f"Body{n + 1}"
        name = name[:MAX_NAME]
        pid = f' pid="1" pindex="{slot}"' if palette else ""
        # Header only. The MESH is streamed later, straight into the zip, so it
        # is never held here alongside every other body's.
        objects_meta.append((b, f'<object id="{oid}" type="model" name={quoteattr(name)}{pid}>', slot))
        items_xml.append(f'<item objectid="{oid}" transform="{transform}" printable="1"/>')
        cfg_objects.append(
            f'  <object id="{oid}">\n'
            f"    <metadata key=\"name\" value={quoteattr(name)}/>\n"
            f'    <metadata key="extruder" value="{slot + 1}"/>\n'
            f'    <part id="1" subtype="normal_part">\n'
            f"      <metadata key=\"name\" value={quoteattr(name)}/>\n"
            f"    </part>\n"
            f"  </object>"
        )

    def _model_chunks():
        """The 3dmodel.model document, in bounded pieces."""
        yield (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<model unit="millimeter" xml:lang="en-US"'
            ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
            ' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"'
            f' xmlns:BambuStudio="{_BBS_NS}">\n'
            ' <metadata name="Application">SindriCAD</metadata>\n'
            ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
            f" <resources>{basematerials}"
        )
        for b, header, base in objects_meta:
            yield header
            yield from _mesh_chunks(
                b["positions"], b["indices"], b.get("faceIds"),
                (face_slots or {}).get(str(b["id"])), base,
            )
            yield "</object>"
        yield f"</resources>\n <build>{''.join(items_xml)}</build>\n</model>"

    model_settings = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<config>\n" + "\n".join(cfg_objects) + "\n</config>"
    )

    # filament_colour length defines how many filament slots Orca shows; keep it
    # exactly the palette. Caller settings (e.g. a fully flattened profile in the
    # CLI path) override anything we derive here.
    proj = {"filament_colour": [s["color"] for s in palette]} if palette else {}
    # filament_type parallels filament_colour when the palette knows materials
    # (printer-synced slots carry them). Slots without one fall back to PLA —
    # Orca's own default for an unconfigured slot.
    if palette and any(s.get("material") for s in palette):
        proj["filament_type"] = [s.get("material") or "PLA" for s in palette]
    proj.update(settings or {})

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        # Streamed, not writestr'd: the mesh XML for a large assembly is far
        # bigger than the mesh, and writestr would need all of it in memory at
        # once on top of the meshes themselves.
        with z.open("3D/3dmodel.model", "w") as fh:
            for chunk in _model_chunks():
                fh.write(chunk.encode("utf-8"))
        z.writestr("Metadata/model_settings.config", model_settings)
        z.writestr("Metadata/project_settings.config", json.dumps(proj, indent=1))
    return path
