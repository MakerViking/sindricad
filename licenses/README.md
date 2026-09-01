# Canonical license texts, checked in

Texts that have to ship with a build and that **no dependency provides**, so they cannot be
collected from `node_modules` or the sidecar runtime's `site-packages`. Everything else
`scripts/collect-licenses.mjs` copies out of the dependency that actually carries it, which
is always better: a text taken from the shipped artefact cannot drift from what shipped.

Only add a file here when a dependency genuinely ships none. Two do.

## `OCCT-LGPL-2.1.txt` and `OCCT-exception-1.0.txt`

OpenCASCADE reaches a build inside the `cadquery-ocp-novtk` wheel as compiled object code.
**That wheel carries no license file at all** — its `METADATA` declares `License: Apache-2.0`,
which covers the Python wrapper and says nothing about the OCCT it bundles. OCCT itself is
LGPL-2.1 with the Open CASCADE Exception, so both texts have to come from somewhere else.

Fetched 2026-09-02 from the OCCT repository at the tag `NOTICE.md` names:

```
https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_9_3/LICENSE_LGPL_21.txt
https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_9_3/OCCT_LGPL_EXCEPTION.txt
```

**Re-fetch these if the pinned OCCT version in `sidecar/uv.lock` moves**, and use the
matching tag rather than `master`. The exception text is the one that matters: it is what
permits OCCT headers to be incorporated into object code under our own terms, and it is
short enough that nobody notices it is missing until someone asks.
