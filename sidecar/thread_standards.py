"""Thread standard sizes: one JSON file at the project root
(`thread_standards.json`) is the single source for both this module and the
frontend's `src/features/threadStandards.ts`, so the two can never drift
apart on a pitch or a diameter. Each side only adds the arithmetic its own
language needs (mm conversion for the inch families here; nothing extra on
the TS side, which only lists and displays designations).

v1 scope, per the approved plan: ISO metric coarse M1.6-M64 (preferred
sizes), ISO metric fine with one representative pitch per diameter from M8
up, UNC/UNF #2-1" at their standard TPI, and exactly the five named
trapezoidal sizes (Tr8x8, Tr8x2, Tr10x2, Tr12x3, Tr16x4). Not a complete
engineering reference: a size missing here is a size this tool refuses by
not listing it, not a bug.

Tr8x8 is the real 3D-printer Z-axis leadscrew: a 4-start thread, 2 mm
PITCH, 8 mm LEAD. A record's own `pitch` is always the single-start pitch
(what one helix profile is built at and advances by per revolution); a
`starts` count (default 1 when the field is absent) multiplies that into
the LEAD the builder sweeps along, then repeats the profile `starts` times
around the axis — see builder.py's `_handle_thread`. Tr8x8 is the only
table entry with `starts` > 1; no other listed size is multi-start.

Every record `lookup()` returns is normalized to the same shape in mm,
regardless of family:
    family, designation, majorDiameter, pitch, starts, halfAngleDeg, depthFrac

`halfAngleDeg` is the flank half-angle from the thread axis (30 degrees for
every 60-degree-included family: ISO metric and UN; 15 degrees for the
30-degree-included trapezoidal family). `depthFrac` is how far the minor
radius sits below the major radius, as a fraction of the pitch:
`minorRadius = majorRadius - depthFrac * pitch`. For the 60-degree families
this is 0.541266 (= 5/8 of the ISO 68-1 fundamental triangle height
sqrt(3)/2, i.e. the exact constant already shipped in test_sweep_path.py's
M6_MINOR). For trapezoidal it is a flat 0.5: ISO 2904's real ac-allowance
tables are NOT implemented here (a deliberate simplification - the v1 plan's
Exact/Print fit clearance already covers the user-facing mating fit, and a
trapezoidal thread is rarely the tight-tolerance case this would matter for).
"""

import json
import math
import os

_PATH = os.path.join(os.path.dirname(__file__), "..", "thread_standards.json")

_MM_PER_INCH = 25.4


def _load():
    with open(_PATH, "r") as fh:
        return json.load(fh)


_DATA = _load()
_FAMILIES = _DATA["families"]


def _normalize(family, rec):
    fam = _FAMILIES[family]
    if "diameterIn" in rec:
        major = rec["diameterIn"] * _MM_PER_INCH
        pitch = _MM_PER_INCH / rec["tpi"]
    else:
        major = rec["diameter"]
        pitch = rec["pitch"]
    return {
        "family": family,
        "designation": rec["designation"],
        "majorDiameter": major,
        "pitch": pitch,
        "starts": rec.get("starts", 1),
        "halfAngleDeg": fam["halfAngleDeg"],
        "depthFrac": fam["depthFrac"],
    }


_BY_DESIGNATION = {}
for _family in ("metric", "metricFine", "unc", "unf", "trapezoidal"):
    for _rec in _DATA[_family]:
        _norm = _normalize(_family, _rec)
        _BY_DESIGNATION[_norm["designation"]] = _norm


def lookup(designation):
    """The normalized record for a designation, e.g. "M6x1" or "1/4-20 UNC",
    or None if it is not one of the sizes this tool knows."""
    return _BY_DESIGNATION.get(designation)


def all_designations():
    """Every known designation, in table order (the UI's dropdown order)."""
    out = []
    for family in ("metric", "metricFine", "unc", "unf", "trapezoidal"):
        for rec in _DATA[family]:
            out.append(rec["designation"])
    return out


def nearest(major_diameter_mm, families=None):
    """The designation whose major diameter is closest to `major_diameter_mm`,
    restricted to `families` if given. Used to preselect a standard from a
    picked hole or shaft's measured radius; the caller still shows the exact
    diameter so the user can tell a near-miss from an exact match."""
    best = None
    best_err = None
    for designation, rec in _BY_DESIGNATION.items():
        if families is not None and rec["family"] not in families:
            continue
        err = abs(rec["majorDiameter"] - major_diameter_mm)
        if best_err is None or err < best_err:
            best, best_err = designation, err
    return best


def minor_diameter(rec):
    """The minor diameter for a looked-up record, in mm."""
    return rec["majorDiameter"] - 2 * rec["depthFrac"] * rec["pitch"]


def half_angle_rad(rec):
    return math.radians(rec["halfAngleDeg"])
