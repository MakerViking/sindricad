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
        pal.append({
            "name": str(slot.get("name") or f"Filament {len(pal) + 1}")[:MAX_NAME],
            "color": _norm_color(slot.get("color")),
        })
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


def _mesh_xml(positions, indices):
    verts = "".join(
        f'<vertex x="{positions[i]:.6g}" y="{positions[i + 1]:.6g}" z="{positions[i + 2]:.6g}"/>'
        for i in range(0, len(positions), 3)
    )
    tris = "".join(
        f'<triangle v1="{indices[i]}" v2="{indices[i + 1]}" v3="{indices[i + 2]}"/>'
        for i in range(0, len(indices), 3)
    )
    return f"<mesh><vertices>{verts}</vertices><triangles>{tris}</triangles></mesh>"


def write_project_3mf(bodies, path, palette, body_colors, body_names, settings,
                      bed=(270.0, 270.0)):
    """Write an Orca-project 3MF. Returns `path`.

    bodies      : [{"id", "name", "positions", "indices"}] — flat mm/Z-up lists
                  straight from tessellate() (face_ids unused here)
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

    objects_xml, items_xml, cfg_objects = [], [], []
    for n, b in enumerate(bodies):
        oid = n + 2  # id 1 = the basematerials resource
        slot = body_colors.get(str(b["id"]), 0) if palette else 0
        name = body_names.get(str(b["id"])) or b.get("name") or f"Body{n + 1}"
        name = name[:MAX_NAME]
        pid = f' pid="1" pindex="{slot}"' if palette else ""
        objects_xml.append(
            f'<object id="{oid}" type="model" name={quoteattr(name)}{pid}>'
            f"{_mesh_xml(b['positions'], b['indices'])}</object>"
        )
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

    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US"'
        ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
        ' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"'
        f' xmlns:BambuStudio="{_BBS_NS}">\n'
        ' <metadata name="Application">SindriCAD</metadata>\n'
        ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
        f" <resources>{basematerials}{''.join(objects_xml)}</resources>\n"
        f" <build>{''.join(items_xml)}</build>\n"
        "</model>"
    )

    model_settings = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<config>\n" + "\n".join(cfg_objects) + "\n</config>"
    )

    # filament_colour length defines how many filament slots Orca shows; keep it
    # exactly the palette. Caller settings (e.g. a fully flattened profile in the
    # CLI path) override anything we derive here.
    proj = {"filament_colour": [s["color"] for s in palette]} if palette else {}
    proj.update(settings or {})

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", model_settings)
        z.writestr("Metadata/project_settings.config", json.dumps(proj, indent=1))
    return path
