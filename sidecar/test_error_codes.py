"""Machine-readable error codes survive every hop to the wire (sidecar/errors.py).

Run: uv run python test_error_codes.py

A `code` is only useful if it arrives. It is re-projected SIX times between the
raise site and the client — _reply_for, the four `errors[0]` fatal copies, the
blanket `except` in each aux job fn, the mid-stream cancel dict, rebuild's
per-feature errors.append, and any re-raise that rebuilds the exception — and
each hop that enumerates fields by hand drops anything it does not name. Three
of those hops were dropping it while the other three looked correct.

The pickle test is not paranoia: these exceptions cross a ProcessPoolExecutor
boundary, and BaseException.__reduce__ returns (cls, self.args), so an __init__
with a required second positional raises TypeError while being UNPICKLED in the
parent — turning a clear geometry error into CPython noise.
"""

import os
import pickle

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

import errors  # noqa: E402
import geom_select  # noqa: E402
import server  # noqa: E402

PASS = "  ok"


def test_geom_error_survives_a_pickle_round_trip():
    ex = errors.GeomError("ambiguous edge reference at (1,2,3)", errors.AMBIGUOUS_REFERENCE)
    back = pickle.loads(pickle.dumps(ex))
    assert isinstance(back, errors.GeomError), type(back)
    assert str(back) == str(ex), (str(back), str(ex))
    assert back.code == errors.AMBIGUOUS_REFERENCE, back.code
    # the bare form is what __reduce__ actually reconstructs with
    bare = pickle.loads(pickle.dumps(errors.GeomError("boom")))
    assert bare.code is None and str(bare) == "boom"
    # and it must still be catchable as a ValueError, or rebuild's handler misses it
    assert isinstance(ex, ValueError)
    print(PASS, "GeomError pickles round trip with its code, and is still a ValueError")


def _literal_codes(src):
    """Bare string codes assigned to a `code` key, which the constant walk below
    cannot see. Kept as a function so the scan itself can be tested."""
    import re

    return (set(re.findall(r'\["code"\]\s*=\s*"([A-Za-z]+)"', src))
            | set(re.findall(r'"code":\s*"([A-Za-z]+)"', src)))


def test_every_code_raised_in_the_tree_is_in_the_vocabulary():
    """Guards against a typo'd literal at a raise site: a code that is not in
    errors.ALL reaches the client as an unrecognised string and silently
    degrades to 'unclassified' rather than failing loudly.

    Two scans, because the first one alone validated the module against ITSELF.
    Walking `errors.NAME` references can only ever find codes that already went
    through errors.py — it was structurally blind to a bare string literal, and
    two of them ("expectFailed", "budgetExhausted") lived in query_geometry for
    exactly that reason, documented on the wire and absent from the vocabulary.
    """
    import re

    files = ("geom_select.py", "server.py", "builder.py")
    seen = set()
    for path in files:
        src = open(os.path.join(os.path.dirname(__file__), path)).read()
        seen |= set(re.findall(r"errors(?:_mod)?\.([A-Z][A-Z_]+)", src))
    seen -= {"ALL"}
    for name in seen:
        assert hasattr(errors, name), f"{name} is not defined in errors.py"
        assert getattr(errors, name) in errors.ALL, f"{name} is missing from errors.ALL"
    assert seen, "found no code constants at all — the regex or the wiring is wrong"

    literals = set()
    for path in files:
        src = open(os.path.join(os.path.dirname(__file__), path)).read()
        literals |= _literal_codes(src)
    for lit in literals:
        assert lit in errors.ALL, (
            f'the literal code "{lit}" is not in errors.ALL — add a constant for '
            f"it, or the client sees an unclassified string")

    # A CONTROL. The tree currently contains no bare literal, so the loop above
    # is vacuously true and would keep passing if the regex rotted. Prove the
    # scan still catches the exact shape that got past the constant walk.
    planted = _literal_codes('rec["code"] = "expectFailed"\n    x = {"code": "wibble"}')
    assert planted == {"expectFailed", "wibble"}, planted
    assert "wibble" not in errors.ALL
    print(PASS, f"all {len(seen)} constants and {len(literals)} literal codes are in "
                f"errors.ALL (scan verified against a planted literal)")


def test_reply_for_forwards_the_code():
    import json

    out = json.loads(server._reply_for("r1", {"error": {"message": "boom", "code": "badRequest"}}))
    assert out["ok"] is False and out["error"]["code"] == "badRequest", out
    # ...and a cancel carries BOTH the shipped boolean and the code
    out = json.loads(server._reply_for("r2", {"cancelled": True, "error": {"message": "cancelled"}}))
    assert out["cancelled"] is True, out
    assert out["error"]["code"] == errors.CANCELLED, out
    # an uncoded error must not grow an empty key
    out = json.loads(server._reply_for("r3", {"error": {"message": "plain"}}))
    assert "code" not in out["error"], out
    print(PASS, "_reply_for forwards code, keeps `cancelled`, and omits an absent code")


def test_fatal_from_copies_the_whole_error():
    res = server._fatal_from([{"feature_id": "f1", "message": "boom", "code": "referenceNotFound"}])
    assert res["error"]["code"] == "referenceNotFound", res
    assert res["error"]["feature_id"] == "f1", res
    # a plain entry must not sprout keys
    res = server._fatal_from([{"feature_id": "f2", "message": "plain"}])
    assert set(res["error"]) == {"feature_id", "message"}, res
    print(PASS, "_fatal_from copies code and feature_id without inventing keys")


def test_error_from_preserves_a_coded_exception():
    res = server._error_from(errors.GeomError("nope", errors.AMBIGUOUS_REFERENCE))
    assert res["error"]["code"] == errors.AMBIGUOUS_REFERENCE, res
    # a plain exception stays uncoded unless a default is supplied
    assert "code" not in server._error_from(ValueError("plain"))["error"]
    assert server._error_from(ValueError("plain"), errors.BAD_REQUEST)["error"]["code"] \
        == errors.BAD_REQUEST
    # and the message never comes back empty
    assert server._error_from(ValueError(""))["error"]["message"] == "ValueError"
    print(PASS, "_error_from preserves a coded exception and never empties the message")


def test_an_ambiguous_pick_codes_both_the_raise_and_the_diagnostic():
    """The two channels matter for different consumers: the RAISE becomes the
    feature error, and the DIAGNOSTIC is what the Re-pick UI reads. A code on
    only one of them leaves the other consumer exactly as blind as before."""
    from build123d import Box

    # two equidistant vertical edges: the point sits on the box's axis
    part = Box(20, 20, 20)
    diag = []
    try:
        geom_select.resolve_edges(
            part, {"kind": "edge", "by": "nearest", "point": [0, 0, 0]},
            diag=diag, feature_id="fx")
        raise AssertionError("an equidistant pick must refuse")
    except errors.GeomError as ex:
        assert ex.code == errors.AMBIGUOUS_REFERENCE, ex.code
        # the prose must survive too — it is the toast the user reads
        assert "re-pick" in str(ex).lower(), str(ex)

    amb = [d for d in diag if d.get("code") == errors.AMBIGUOUS_REFERENCE]
    assert len(amb) == 1, f"the diagnostic must carry the code too: {diag}"
    assert amb[0]["lossy"] is True and amb[0]["feature_id"] == "fx", amb[0]
    print(PASS, "an ambiguous pick codes BOTH the raise and the ResolveDiag entry")


def test_the_head_gate_still_records_nothing_for_a_confident_pick():
    """Adding `code` must not have widened _push_diag. A confident resolution
    still records nothing at all — builder._project_source refuses on any lossy
    entry, so informational entries here become hard failures there."""
    diag = []
    geom_select._push_diag(diag, "f", "face", 1, 0.99, False, "fine",
                           code=errors.AMBIGUOUS_REFERENCE)
    assert diag == [], f"a confident pick must record nothing, got {diag}"
    geom_select._push_diag(diag, "f", "face", 0, 0.1, True, "bad")
    assert len(diag) == 1 and "code" not in diag[0], diag
    print(PASS, "the _push_diag head gate is unchanged and code stays optional")


def test_a_feature_failure_carries_its_code_into_featureErrors():
    """The ok:true path. A feature that fails mid-build reports in `featureErrors`,
    NOT in `error` — so a code applied only to the fatal never reaches the case
    that matters most."""
    from builder import rebuild

    doc = {"parameters": {}, "features": [
        {"id": "b", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "fl", "type": "fillet", "radius": 1,
         "edges": [{"kind": "edge", "by": "nearest", "point": [0, 0, 0]}]},
    ]}
    _part, errs, _bodies = rebuild(doc)
    assert errs, "the ambiguous fillet reference should have failed the feature"
    assert errs[0]["feature_id"] == "fl", errs[0]
    assert errs[0].get("code") == errors.AMBIGUOUS_REFERENCE, \
        f"the code must ride into featureErrors, got {errs[0]}"
    print(PASS, "a failed feature carries its code into featureErrors (the ok:true path)")


def main():
    print("Error-code plumbing tests")
    test_geom_error_survives_a_pickle_round_trip()
    test_every_code_raised_in_the_tree_is_in_the_vocabulary()
    test_reply_for_forwards_the_code()
    test_fatal_from_copies_the_whole_error()
    test_error_from_preserves_a_coded_exception()
    test_an_ambiguous_pick_codes_both_the_raise_and_the_diagnostic()
    test_the_head_gate_still_records_nothing_for_a_confident_pick()
    test_a_feature_failure_carries_its_code_into_featureErrors()
    print("ALL PASS")


if __name__ == "__main__":
    main()
