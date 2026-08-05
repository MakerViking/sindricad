"""Memory-refusal tests: the pre-import RAM check and the three platform probes.

Run: uv run python test_sysmem.py   (or .venv/bin/python test_sysmem.py)

An OOM kill reaches the supervisor as a bare SIGKILL with no traceback, so it can
only be reported as "the geometry kernel crashed" — a geometry fault named for
what is really a machine limit. `_refuse_if_memory_is_short` exists to turn that
into a sentence the user can act on, BEFORE OCCT starts.

The platform parsers take their input as an argument precisely so all three can
be exercised here. Otherwise the macOS and Windows halves would only ever run in
front of a user, which is the same "ships untested" trap that left six suites out
of CI. The fixtures below are real captured output.
"""

import os
import shutil
import sys

os.environ.setdefault("SINDRI_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sysmem  # noqa: E402
from builder import _refuse_if_memory_is_short, IMPORT_RSS_PER_FILE_BYTE  # noqa: E402

PASS = "  ok"
MIB = 1024 * 1024

# --- captured fixtures --------------------------------------------------------

LINUX_MEMINFO = """MemTotal:       32659372 kB
MemFree:          438220 kB
MemAvailable:   18446744 kB
Buffers:          182364 kB
Cached:         20118792 kB
SwapCached:            0 kB
"""

# Apple Silicon: page size 16384, NOT 4096. Assuming 4096 under-reports 4x.
MACOS_VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               21514.
Pages active:                            412233.
Pages inactive:                          388119.
Pages speculative:                         4402.
Pages throttled:                              0.
Pages wired down:                        144815.
Pages purgeable:                          10175.
"""


def test_linux_parses_mem_available_not_mem_free():
    got = sysmem._parse_linux_meminfo(LINUX_MEMINFO)
    assert got == 18446744 * 1024, got
    # The distinction is the whole point: MemFree here is 428 MiB while
    # MemAvailable is 17.6 GiB. Reading MemFree would refuse nearly every import
    # on a warm machine, where the page cache holds most of RAM.
    free = 438220 * 1024
    assert got > free * 40, "parsed MemFree, not MemAvailable"
    print(f"{PASS} linux: MemAvailable {sysmem.describe(got)} (MemFree was only "
          f"{sysmem.describe(free)})")


def test_linux_returns_none_when_the_field_is_absent():
    assert sysmem._parse_linux_meminfo("MemTotal: 100 kB\nMemFree: 50 kB\n") is None
    assert sysmem._parse_linux_meminfo("") is None
    print(f"{PASS} linux: a meminfo without MemAvailable reads None, not 0")


def test_macos_sums_reclaimable_pages_at_the_real_page_size():
    got = sysmem._parse_macos_vm_stat(MACOS_VM_STAT)
    expected = (21514 + 388119 + 4402 + 10175) * 16384
    assert got == expected, f"{got} != {expected}"
    # Wired and active pages are NOT available and must not be counted.
    assert got < (21514 + 412233 + 388119 + 144815) * 16384
    print(f"{PASS} macos: {sysmem.describe(got)} from free+inactive+speculative+purgeable")


def test_macos_honours_the_header_page_size():
    """A 4096-byte page machine must not be read with Apple Silicon's 16384."""
    small = MACOS_VM_STAT.replace("page size of 16384 bytes", "page size of 4096 bytes")
    assert sysmem._parse_macos_vm_stat(small) * 4 == sysmem._parse_macos_vm_stat(MACOS_VM_STAT)
    print(f"{PASS} macos: page size is read from the header, never assumed")


def test_macos_returns_none_on_junk():
    assert sysmem._parse_macos_vm_stat("") is None
    assert sysmem._parse_macos_vm_stat("not vm_stat output at all") is None
    print(f"{PASS} macos: unparseable output reads None")


def test_available_bytes_is_sane_on_this_machine():
    """The live probe for whichever platform this actually runs on."""
    got = sysmem.available_bytes()
    assert got is not None, f"no memory probe for sys.platform={sys.platform!r}"
    assert got > 0
    assert got < 1024 * 1024 * MIB, f"{got} bytes is implausible (>1 PiB)"
    print(f"{PASS} live probe on {sys.platform}: {sysmem.describe(got)} available")


# --- the refusal itself -------------------------------------------------------


def _refuses(size, available):
    try:
        _refuse_if_memory_is_short(size, available=available)
        return None
    except ValueError as ex:
        return str(ex)


def test_a_file_that_cannot_fit_is_refused_before_occt_runs():
    # 100 MiB file needs ~1000 MiB; only 500 MiB free.
    msg = _refuses(100 * MIB, 500 * MIB)
    assert msg is not None, "should have refused"
    assert "not enough memory" in msg, msg
    # The message has to carry both numbers, or the user cannot tell whether
    # closing a browser tab would be enough.
    assert "GiB" in msg or "MiB" in msg, msg
    print(f"{PASS} refused: {msg[:78]}…")


def test_a_file_that_fits_is_allowed():
    # 10 MiB file needs ~100 MiB, with 8 GiB free.
    assert _refuses(10 * MIB, 8192 * MIB) is None
    print(f"{PASS} a file that comfortably fits is not refused")


def test_headroom_is_left_for_the_rest_of_the_machine():
    """An import that would consume ALL available memory is still refused — it
    would take the desktop down with it even though it technically 'fits'."""
    size = 100 * MIB
    exactly_enough = size * IMPORT_RSS_PER_FILE_BYTE
    assert _refuses(size, exactly_enough) is not None, \
        "an import sized to consume literally all free memory must still refuse"
    assert _refuses(size, int(exactly_enough * 1.5)) is None
    print(f"{PASS} headroom enforced: exactly-enough is refused, 1.5x is allowed")


def test_an_unknown_memory_figure_never_refuses():
    """A failed probe must not block an import. Refusing on a number we could
    not read is a worse failure than the OOM this guards against."""
    import builtins
    real_open = builtins.open

    def _no_meminfo(path, *a, **k):
        if str(path) == "/proc/meminfo":
            raise OSError("no such file")
        return real_open(path, *a, **k)

    builtins.open = _no_meminfo
    try:
        assert sysmem._linux_available() is None
        # available=None forces the live probe; on a platform with no probe, or a
        # failed one, the import must proceed.
        _refuse_if_memory_is_short(1, available=None)
    finally:
        builtins.open = real_open
    print(f"{PASS} an unreadable probe proceeds instead of refusing")


def test_a_zero_size_file_is_never_refused():
    """getsize() returns 0 on an OSError upstream — that must not become a
    refusal, and must not divide anything by zero."""
    assert _refuses(0, 1) is None
    assert _refuses(-1, 1) is None
    print(f"{PASS} an unknown/zero file size is never refused")


def test_describe_never_raises():
    for v in (0, 1, 1023, 1024, 5 * MIB, 12.5 * 1024 * MIB, None, "x"):
        out = sysmem.describe(v)
        assert isinstance(out, str) and out
    assert sysmem.describe(None) == "unknown"
    assert sysmem.describe(5 * MIB) == "5 MiB"
    print(f"{PASS} describe() survives every input including None")


def test_import_geometry_refuses_before_it_parses_anything():
    """The wiring, not just the helper. Uses a file of pure GARBAGE: if the
    refusal fires the error is about memory, and if the gate were missing (or
    ran too late) OCCT would reach the bytes and complain about the format
    instead. That difference is what makes this a test of ordering."""
    import tempfile

    import builder
    import sysmem as _sysmem

    real = _sysmem.available_bytes
    d = tempfile.mkdtemp(prefix="sindri-mem-")
    try:
        path = os.path.join(d, "junk.step")
        with open(path, "wb") as fh:
            fh.write(b"\0" * (2 * MIB))  # not a STEP file in any sense
        _sysmem.available_bytes = lambda: 4 * MIB  # 2 MiB file needs ~20 MiB
        try:
            builder.import_geometry(path, "step")
            assert False, "should have refused on memory"
        except ValueError as ex:
            msg = str(ex)
        assert "not enough memory" in msg, f"refused for the wrong reason: {msg}"

        # And with memory plentiful the SAME file gets far enough to be judged on
        # its contents — proving the gate is what stopped it above, not the junk.
        _sysmem.available_bytes = lambda: 64 * 1024 * MIB
        try:
            builder.import_geometry(path, "step")
            reached = "no error"
        except Exception as ex:  # noqa: BLE001
            reached = str(ex)
        assert "not enough memory" not in reached, \
            "still refused on memory when plenty was free"
    finally:
        _sysmem.available_bytes = real
        shutil.rmtree(d, ignore_errors=True)
    print(f"{PASS} import_geometry refuses on memory BEFORE parsing the file")


if __name__ == "__main__":
    print("memory probes and the pre-import refusal")
    test_linux_parses_mem_available_not_mem_free()
    test_linux_returns_none_when_the_field_is_absent()
    test_macos_sums_reclaimable_pages_at_the_real_page_size()
    test_macos_honours_the_header_page_size()
    test_macos_returns_none_on_junk()
    test_available_bytes_is_sane_on_this_machine()
    test_a_file_that_cannot_fit_is_refused_before_occt_runs()
    test_a_file_that_fits_is_allowed()
    test_headroom_is_left_for_the_rest_of_the_machine()
    test_an_unknown_memory_figure_never_refuses()
    test_a_zero_size_file_is_never_refused()
    test_describe_never_raises()
    test_import_geometry_refuses_before_it_parses_anything()
    print("all memory tests passed")
