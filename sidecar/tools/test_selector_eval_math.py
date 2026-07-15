"""Hand-computed metric-math pins for the selector-survival oracle (Norn INIT item 2).

These assert aggregate()'s survival arithmetic against values computed by hand, covering
the edge semantics where a survival rate can silently flatter: invalid cases must leave
BOTH numerator and denominator (not count as survivals, not merely drop from the top),
empty denominators must yield 0.0 (never crash or default to 1.0), and rounding is fixed
at 6 places.

Run: .venv/bin/python tools/test_selector_eval_math.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_selector_survival import aggregate  # noqa: E402

PASS = "  ok"


def _approx(a, b, tol=1e-9):
    return abs(a - b) <= tol


def test_mixed_with_invalid_exclusion():
    # concentric: survive,survive,miss -> 2/3 ; mirrored_twin: survive,invalid -> 1/1 (invalid dropped)
    # boolean_stack: miss -> 0/1 ; others empty -> 0.0
    outcomes = [
        ("concentric", "survive"), ("concentric", "survive"), ("concentric", "miss"),
        ("mirrored_twin", "survive"), ("mirrored_twin", "invalid"),
        ("boolean_stack", "miss"),
    ]
    out = aggregate(outcomes)
    # by hand: total_survive = 2+1+0 = 3 ; total_valid = 3+1+1 = 5 ; 3/5 = 0.6
    assert _approx(out["v2_rate"], 0.6), out["v2_rate"]
    assert _approx(out["concentric"], 0.666667), out["concentric"]      # 2/3, rounded
    assert _approx(out["mirrored_twin"], 1.0), out["mirrored_twin"]     # invalid excluded from denom
    assert _approx(out["boolean_stack"], 0.0), out["boolean_stack"]     # 0/1
    assert _approx(out["moved_sketch"], 0.0), out["moved_sketch"]       # empty -> 0.0
    assert out["invalid_count"] == 1.0, out["invalid_count"]
    print(PASS, "mixed set: invalid excluded from numerator AND denominator; 3/5=0.6")


def test_all_invalid_is_zero_not_crash():
    out = aggregate([("concentric", "invalid"), ("concentric", "invalid")])
    assert _approx(out["v2_rate"], 0.0), out["v2_rate"]       # 0 valid -> 0.0, not ZeroDivision, not 1.0
    assert _approx(out["concentric"], 0.0), out["concentric"]
    assert out["invalid_count"] == 2.0, out["invalid_count"]
    print(PASS, "all-invalid: empty denominators yield 0.0, not a crash or 1.0")


def test_rounding_six_places():
    out = aggregate([("concentric", "survive"), ("concentric", "miss"), ("concentric", "miss")])
    assert _approx(out["concentric"], 0.333333), out["concentric"]     # 1/3 -> 0.333333
    assert _approx(out["v2_rate"], 0.333333), out["v2_rate"]
    print(PASS, "rounding: 1/3 pins to 0.333333 at 6 places")


def test_perfect_and_zero():
    assert _approx(aggregate([("moved_sketch", "survive")])["v2_rate"], 1.0)
    assert _approx(aggregate([("moved_sketch", "miss")])["v2_rate"], 0.0)
    print(PASS, "1/1 -> 1.0 and 0/1 -> 0.0")


def main():
    print("Selector-survival metric-math pins")
    test_mixed_with_invalid_exclusion()
    test_all_invalid_is_zero_not_crash()
    test_rounding_six_places()
    test_perfect_and_zero()
    print("ALL PASS")


if __name__ == "__main__":
    main()
