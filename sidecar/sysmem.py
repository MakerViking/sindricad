"""sysmem.py — available physical memory, on all three platforms, without psutil.

`psutil` is NOT available to the shipped sidecar. It appears in the dev lockfile
only as a transitive dependency of ipython, so importing it here would work on a
developer's machine and fail in front of a user. Each platform is read directly
instead:

  Linux    /proc/meminfo MemAvailable — the kernel's own estimate of what can be
           allocated without swapping. NOT MemFree, which excludes reclaimable
           page cache and on a warm machine reads near zero while gigabytes are
           genuinely available.
  macOS    vm_stat: free + inactive + speculative + purgeable pages. Inactive and
           purgeable are reclaimable under pressure, so counting only "free" would
           under-report just as badly as MemFree does.
  Windows  GlobalMemoryStatusEx().ullAvailPhys via ctypes.

EVERY function here returns None rather than raising or guessing. An unknown
memory figure must leave the caller free to proceed: refusing an import because a
probe failed would be a worse failure than the OOM it was meant to prevent.

The parsers take their input as an argument so all three can be tested on any
machine — otherwise two thirds of this file would only ever run in production.
"""

import re
import sys


def _parse_linux_meminfo(text):
    """MemAvailable from /proc/meminfo content, in bytes. Values are in kB."""
    for line in text.splitlines():
        if line.startswith("MemAvailable:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1]) * 1024
    return None


def _parse_macos_vm_stat(text):
    """Reclaimable bytes from `vm_stat` output.

    The page size is in the header ("page size of 16384 bytes") and is NOT always
    4096 — Apple Silicon uses 16384, so assuming 4096 would under-report by 4x."""
    m = re.search(r"page size of (\d+) bytes", text)
    page = int(m.group(1)) if m else 4096
    wanted = ("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable")
    total = 0
    seen = False
    for line in text.splitlines():
        for key in wanted:
            if line.startswith(key + ":"):
                digits = re.search(r"(\d+)", line.split(":", 1)[1])
                if digits:
                    total += int(digits.group(1))
                    seen = True
                break
    return total * page if seen else None


def _linux_available():
    try:
        with open("/proc/meminfo") as fh:
            return _parse_linux_meminfo(fh.read())
    except OSError:
        return None


def _macos_available():
    import subprocess
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return _parse_macos_vm_stat(out.stdout)


def _windows_available():
    import ctypes

    class _MemoryStatusEx(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    try:
        stat = _MemoryStatusEx()
        stat.dwLength = ctypes.sizeof(_MemoryStatusEx)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return None
        return int(stat.ullAvailPhys)
    except Exception:  # noqa: BLE001 — a probe must never break the caller
        return None


def available_bytes():
    """Physical memory that can plausibly be allocated right now, or None if it
    cannot be determined on this platform."""
    try:
        if sys.platform.startswith("linux"):
            return _linux_available()
        if sys.platform == "darwin":
            return _macos_available()
        if sys.platform.startswith("win"):
            return _windows_available()
    except Exception:  # noqa: BLE001
        return None
    return None


def describe(nbytes):
    """Human-readable size for an error message ('1.8 GiB'). Never raises."""
    try:
        n = float(nbytes)
    except (TypeError, ValueError):
        return "unknown"
    for unit in ("B", "KiB", "MiB"):
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.1f} GiB"
