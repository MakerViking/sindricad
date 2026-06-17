"""Configure OpenCASCADE shared-memory parallelism (SMP) once per process.

OCCT is **CPU-only** — there is no GPU path for booleans or meshing. The lever
for "blazingly fast" is therefore scaling across every core/thread:

  * meshing  — `BRepMesh_IncrementalMesh` fans faces across OCCT's thread pool
  * booleans — `BOPAlgo` (fuse/cut/intersect) run multi-threaded

Both draw their worker threads from one global `OSD_ThreadPool`. We point that
pool at all logical CPUs (24 on a 5900X) and flip the parallel-by-default flags,
so a single configure() at startup makes every rebuild use the whole machine.
Override the thread count with the `VERXA_THREADS` env var.

`configure()` is idempotent and must run in *each* process that touches OCCT —
the server process AND every rebuild worker (see server.py's executor initializer).
"""

import os

_configured = False


def thread_count() -> int:
    """Logical CPUs to hand OCCT, overridable via VERXA_THREADS (must be > 0)."""
    raw = os.environ.get("VERXA_THREADS")
    if raw:
        try:
            n = int(raw)
            if n > 0:
                return n
        except ValueError:
            pass
    return os.cpu_count() or 1


def configure() -> int:
    """Point OCCT's global thread pool at all cores and enable parallel
    meshing + booleans. Idempotent; returns the thread count in use."""
    global _configured
    n = thread_count()
    if _configured:
        return n

    from OCP.OSD import OSD_ThreadPool

    OSD_ThreadPool.DefaultPool_s().Init(n)

    # mesh every solid's faces in parallel by default (also covers STL/3MF export)
    from OCP.BRepMesh import BRepMesh_IncrementalMesh

    BRepMesh_IncrementalMesh.SetParallelDefault_s(True)

    # run boolean ops (fuse/cut/intersect, which build123d's +/-/& wrap) parallel
    from OCP.BOPAlgo import BOPAlgo_Options

    BOPAlgo_Options.SetParallelMode_s(True)

    _configured = True
    return n
