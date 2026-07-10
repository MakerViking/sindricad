# Third-Party Notices

SindriCAD incorporates the following third-party components. This file satisfies the
attribution and source-availability requirements of their licenses. Full license texts
are bundled under `LICENSES/` in distributed builds.

No dependency is under the GPL or AGPL; nothing here requires SindriCAD's own source to
be published. The copyleft components below are **weak-copyleft** (LGPL, plus one
file-level copyleft component, certifi's MPL-2.0) and are used in a license-compatible
way (dynamic linking / separate process / unmodified redistribution), which permits
distributing SindriCAD under its own terms.

## Geometry kernel

- **Open CASCADE Technology (OCCT)** 7.9.3 - LGPL-2.1 **with the Open CASCADE Exception**.
  Source: https://github.com/Open-Cascade-SAS/OCCT (tag V7_9_3).
  Linked **dynamically** (system shared library); users may relink with a compatible
  modified OCCT. The Open CASCADE Exception additionally permits incorporating OCCT header
  material into the application.
- **opencascade-rs / opencascade-sys** (vendored fork, `third_party/opencascade-rs/`) -
  LGPL-2.1. Upstream: https://github.com/bschwind/opencascade-rs (fork patched for OCCT 7.9).
- **OCP** (OpenCASCADE Python bindings, used by the geometry sidecar) - LGPL-2.1.
  Source: https://github.com/CadQuery/OCP. Runs as a **separate process** (the sidecar),
  communicating over a local WebSocket - not linked into the application binary.

## 2D constraint solver

- **PlaneGCS** (from FreeCAD), via **@salusoft89/planegcs** - LGPL-2.0-or-later.
  Source: https://github.com/FreeCAD/FreeCAD (src/Mod/Sketcher/App/PlaneGCS) and
  https://github.com/Salusoft89/planegcs. Used as a WebAssembly module.

## Permissively licensed components

- **build123d** - Apache-2.0 - https://github.com/gumyr/build123d
- **cadquery-ocp-novtk** (also published as "OCP"; the Python OCCT wrapper the sidecar
  imports) - Apache-2.0 for the wrapper code - https://github.com/CadQuery/OCP. It
  bundles compiled OCCT 7.9.3 object code, which is LGPL-2.1 with the Open CASCADE
  Exception (see "Geometry kernel" above); the written offer there covers this build too.
- **cadquery-ocp-proxy** (version-tracking stub, no OCCT code) - Apache-2.0 -
  https://pypi.org/project/cadquery-ocp-proxy/
- **three.js** - MIT - https://github.com/mrdoob/three.js
- **camera-controls** - MIT - https://github.com/yomotsu/camera-controls
- **Tauri** and official plugins (`tauri`, `tauri-plugin-fs`, `tauri-plugin-dialog`,
  `@tauri-apps/*`) - MIT OR Apache-2.0 - https://github.com/tauri-apps/tauri
- **hidapi** (Rust crate) - MIT - https://github.com/ruabmbua/hidapi-rs
- **threemf** (Rust crate) - 0BSD - https://crates.io/crates/threemf
- **websockets** (Python) - BSD-3-Clause - https://github.com/python-websockets/websockets
- **serde / serde_json / glam / libc** - MIT OR Apache-2.0

## Sidecar runtime dependencies (bundled Python packages)

The shipped sidecar runtime bundles build123d's full dependency closure (numeric,
CAD-adjacent, and REPL/introspection libraries it pulls in transitively), resolved and
pinned in `sidecar/uv.lock`. All of the following are permissively licensed:

- **anytree** - Apache-2.0 - https://github.com/c0fec0de/anytree
- **asttokens** - Apache-2.0 - https://github.com/gristlabs/asttokens
- **certifi** - MPL-2.0 (Mozilla's CA bundle, redistributed unmodified) -
  https://github.com/certifi/python-certifi
- **charset-normalizer** - MIT - https://github.com/jawah/charset_normalizer
- **colorama** (Windows builds only) - BSD-3-Clause - https://github.com/tartley/colorama
- **decorator** - BSD-2-Clause - https://pypi.org/project/decorator/
- **executing** - MIT - https://github.com/alexmojaki/executing
- **ezdxf** - MIT - https://github.com/mozman/ezdxf
- **fonttools** - MIT - https://github.com/fonttools/fonttools
- **idna** - BSD-3-Clause - https://github.com/kjd/idna
- **ipython** - BSD-3-Clause - https://github.com/ipython/ipython
- **ipython-pygments-lexers** - BSD-3-Clause -
  https://github.com/ipython/ipython-pygments-lexers
- **jedi** - MIT - https://github.com/davidhalter/jedi
- **joblib** - BSD-3-Clause - https://github.com/joblib/joblib
- **lib3mf** - BSD-3-Clause - https://pypi.org/project/lib3mf/
- **matplotlib-inline** - BSD-3-Clause - https://github.com/ipython/matplotlib-inline
- **mpmath** - BSD-3-Clause - https://github.com/fredrik-johansson/mpmath
- **narwhals** - MIT - https://github.com/narwhals-dev/narwhals
- **numpy** - BSD-3-Clause (core), plus 0BSD/MIT/Zlib/CC0-1.0 for a few vendored
  components (per numpy's own `License-Expression`) - https://github.com/numpy/numpy
- **ocp-gordon** - Apache-2.0 - https://github.com/gongfan99/ocp_gordon
- **ocpsvg** - Apache-2.0 - https://pypi.org/project/ocpsvg/
- **parso** - MIT - https://github.com/davidhalter/parso
- **pexpect** - ISC - https://pexpect.readthedocs.io/
- **prompt-toolkit** - BSD-3-Clause -
  https://github.com/prompt-toolkit/python-prompt-toolkit
- **psutil** - BSD-3-Clause - https://github.com/giampaolo/psutil
- **ptyprocess** - ISC - https://github.com/pexpect/ptyprocess
- **pure-eval** - MIT - https://github.com/alexmojaki/pure_eval
- **pygments** - BSD-2-Clause - https://github.com/pygments/pygments
- **pyparsing** - MIT - https://github.com/pyparsing/pyparsing
- **requests** - Apache-2.0 - https://github.com/psf/requests
- **scikit-learn** - BSD-3-Clause - https://github.com/scikit-learn/scikit-learn
- **scipy** - BSD-3-Clause - https://github.com/scipy/scipy
- **stack-data** - MIT - https://github.com/alexmojaki/stack_data
- **svgelements** - MIT - https://github.com/meerk40t/svgelements
- **svgpathtools** - MIT - https://github.com/mathandy/svgpathtools
- **svgwrite** - MIT - https://github.com/mozman/svgwrite
- **sympy** - BSD-3-Clause - https://github.com/sympy/sympy
- **threadpoolctl** - BSD-3-Clause - https://github.com/joblib/threadpoolctl
- **traitlets** - BSD-3-Clause - https://github.com/ipython/traitlets
- **trianglesolver** - MIT - https://pypi.org/project/trianglesolver/
- **typing-extensions** - PSF-2.0 - https://github.com/python/typing_extensions
- **urllib3** - MIT - https://github.com/urllib3/urllib3
- **wcwidth** - MIT - https://github.com/jquast/wcwidth
- **webcolors** - BSD-3-Clause - https://github.com/ubernostrum/webcolors

This list was compiled by reading each package's installed `*.dist-info/METADATA`
(`License`/`License-Expression`/license classifiers) against `sidecar/uv.lock`, and should
be regenerated the same way whenever `uv.lock` changes.

## Written offer (LGPL source availability)

For the LGPL components above (OCCT, OCP, PlaneGCS), the corresponding source code is
available at the URLs listed. For any distributed binary build, the complete corresponding
source of these libraries is also available from the project for a period of at least three
(3) years upon request. SindriCAD links OCCT dynamically and runs OCP as a separate process,
so users may replace these libraries with compatible modified versions.
