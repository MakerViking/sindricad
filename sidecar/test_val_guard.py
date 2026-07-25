# The val() guard: an unresolved string in a numeric field must become a
# per-feature build error (red chip), never leak into OCCT — while legacy
# bare parameter NAMES keep resolving. Run: .venv/bin/python test_val_guard.py

from builder import rebuild


def base_doc(distance):
    return {
        "parameters": {"width": 40},
        "features": [
            {
                "id": "f1",
                "type": "sketch",
                "plane": "XY",
                "entities": [{"type": "rectangle", "id": "e1", "width": 20, "height": 10, "x": 0, "y": 0}],
            },
            {"id": "f2", "type": "extrude", "sketch": "f1", "distance": distance, "operation": "new"},
        ],
    }


# an unevaluated expression string -> feature error, build continues
part, errors, bodies = rebuild(base_doc("width/2+5"))
assert any(e["feature_id"] == "f2" and "unresolved parameter" in e["message"] for e in errors), errors
print("  expression string -> feature error OK:", errors[0]["message"][:60])

# legacy bare name still resolves (old documents)
part, errors, bodies = rebuild(base_doc("width"))
assert errors == [], errors
assert len(bodies) == 1 and abs(part.volume - 20 * 10 * 40) < 1e-6
print("  bare-name legacy resolution OK: vol", part.volume)

print("ALL PASS")
