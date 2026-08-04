# Changelog

What changed in each SindriCAD build, newest first. Everything under
**Unreleased** ships in the next rolling beta, and the release notes on the
[beta release](https://github.com/MakerViking/sindricad/releases/tag/beta) are
generated from that section.

Builds are versioned `0.1.<build number>` and every green `main` produces one, so
most entries land under Unreleased and stay there until a milestone is worth
naming. To draw that line, rename the heading to `## 0.1.NN (YYYY-MM-DD)` and
open a fresh `## Unreleased` above it. Cutting in the same commit as the last
change is tidiest, but not required: when Unreleased is empty the release job
falls back to the newest named section, so the build carrying a cut still
publishes real notes.

This file starts on 2026-08-03. For anything before that, see the
[commit history](https://github.com/MakerViking/sindricad/commits/main).

## Unreleased

### Added

- **Imported STEP assemblies keep their structure.** A STEP file that contains an
  assembly is no longer flattened into a pile of bodies called Body1, Body2,
  Body3. The Browser now shows the tree the CAD system wrote: subassemblies as
  collapsible groups, parts under them with the names from the file, and each
  part still individually selectable. A product holding several solids, the
  common "M3 Nut (x20)" pattern, stays one named group whose pieces can be picked
  apart. Assembly groups start collapsed, and the eye on a group shows or hides
  everything inside it in one step.

  Two things came out of this that are worth naming. Parts that a file describes
  but that contain no solid used to be dropped without a word; they are kept now,
  so nothing in a file silently fails to arrive. And importing a large assembly
  got substantially faster as a side effect of the rework: on a 356 MB test
  assembly the import went from about 190 seconds to about 99.

  Two limits to be aware of. Subassembly names come from the file and cannot be
  renamed in the Browser, though individual bodies still can. And STEP export
  does not yet write names or colours back out, so a round trip through export
  still loses the tree. Part colours from the file are recorded but not shown,
  because colour in SindriCAD means which filament prints a body.

### Fixed

- **SindriCAD starts on machines with Nvidia graphics.** On Linux with the Nvidia
  driver, the window process could crash inside the driver the moment the app
  launched, before anything was drawn, so SindriCAD quit with no window and no
  message at all ([#6](https://github.com/MakerViking/sindricad/issues/6)). The
  crash comes from one specific way WebKit hands rendered frames to the window,
  and that path is now switched off when an Nvidia driver is present. Other
  graphics drivers are unaffected and keep it. The 3D viewport is still drawn by
  the GPU, but frames take a slower route to the window without it, so a heavy
  model may not feel quite as smooth on Nvidia as it otherwise would. If your
  machine does not need the fix, starting SindriCAD with
  `SINDRICAD_NO_GPU_WORKAROUND=1` leaves the setting untouched.

- **A model too large for the geometry engine now says so, instead of looking
  like a broken connection.** Opening a very large file could produce a model
  bigger than the geometry engine accepts in one message. The engine responded by
  closing the connection, and because the oversized body stayed in the document,
  every following rebuild closed it again, so the app sat there reporting
  "geometry engine connection lost" with no hint that the file was the problem
  ([#4](https://github.com/MakerViking/sindricad/issues/4)). The size is now
  checked before anything is sent, and the message names both the size of the
  model and the limit. Raising that limit is a separate piece of work.

- **A second copy of SindriCAD no longer breaks the first one's geometry engine.**
  Opening the app twice started two engines, and the second could not take the
  port the first was already using, so it died and the app reported "The geometry
  engine crashed (exit code 1)" with nothing pointing at the real cause. Launching
  SindriCAD again now brings the window you already have to the front instead of
  starting a second copy. If the port is unavailable for any other reason, the
  message now names the port and says what to do about it rather than blaming the
  geometry engine.

- **The geometry engine starts on NixOS, and anywhere else PYTHONHOME is set.**
  Running the AppImage through `appimage-run` exports `PYTHONHOME` pointing at
  the AppDir, and the bundled interpreter inherited it, went looking for its
  standard library in the wrong place and died with "No module named 'encodings'"
  before running a line. The app then opened with a dead engine
  ([#3](https://github.com/MakerViking/sindricad/issues/3)). The sidecar is now
  started with `PYTHONHOME` cleared, since the bundled runtime works out its own
  location. Packages installed with `pip install --user` are also kept off its
  path now, so a mismatched numpy in a home directory can no longer shadow the
  bundled one.
- **An engine crash now says how it died.** The message read only "The geometry
  engine crashed", and the exit status went to standard error, which a packaged
  build discards. So it never reached `sidecar.log`, the file a bug report
  attaches, and a report of a crash could not distinguish a fault in the geometry
  kernel from the system killing the process for using too much memory. On Linux
  and macOS the status is `None` for every signal death, which is precisely those
  two cases. The crash and its signal are now written to `sidecar.log`, and the
  message names the cause ("killed by SIGSEGV (11) — geometry kernel fault"), so
  even a screenshot of it is enough to triage from.
- **A bug reported from inside the sketcher now carries the sketch.** An open
  sketch lives in the sketch session, not in the document, until you finish it,
  and the report attached the document. So a report filed while sketching
  carried a stale sketch, or an entirely empty document when the sketch was the
  first thing in the file, which is what happened to a dimension report on
  2026-08-02. Reports now include the sketch as it stands, and say that one was
  open, how much was in it, and whether it was new or an edit. That last part is
  recorded even when the document is not attached, since it tells you the repro
  starts by opening a sketch.

## 0.1.81 (2026-08-03)

### Changed

- **Waves is its own texture kind.** Faceted `waves` and `ribs` were producing
  byte-identical geometry: both height functions returned the same trapezoid, so
  a relief the UI names and stores separately drew exactly the other one. Faceted
  waves is now a sine polyline with eight joins per period, a rounded undulation
  against ribs' flat-topped prisms. **Existing waves documents rebuild and change
  shape.** Waves under the faceted profile takes no Land/Sharp parameter, and the
  texture panel hides that field rather than showing a control that does nothing.
- **README reorganized.** It read as Linux-only in three places and buried the
  installers two thirds of the way down. There is now a "Get it" section near the
  top, a section nav bar, per-platform install steps folded into collapsible
  blocks, and the architecture notes moved down with the other reference
  material. Offset Face, Thicken and BREP import were missing from the feature
  list and have been added.

### Added

- **Dimensions can be deleted.** Right-click a dimension for "Delete dimension",
  or select one and press Delete. Dimensional constraints draw as value badges
  rather than constraint glyphs, and the glyph click was the only delete path, so
  an unwanted or duplicated dimension used to be permanent unless you deleted the
  geometry under it. A circle's diameter badge is a property of the circle rather
  than a constraint, so it offers the action disabled instead of silently doing
  nothing.

### Fixed

- **A sketch made on a face now shares the model's grid.** The sketch plane was
  anchored on the face's own centroid, which is derived from the mesh and snaps
  to the nearest triangle centre, so it sat an arbitrary fraction of a millimetre
  off. Grid snapping rounds in plane-local coordinates, which gave every
  sketch-on-face a lattice of its own: draw one sketch snapped to the grid,
  extrude it, sketch on the new face, and the first sketch's centre was no longer
  on grid. The origin is now the global origin projected onto the face's plane,
  the same rule offset and datum planes already used, so every plane parallel to
  a base plane shares one grid. Existing documents are unaffected, since a
  sketch's plane is stored explicitly and never recomputed.
- **Dimensions can be edited without leaving the dimension tool.** The tool
  re-arms after every commit so you can dimension a whole sketch in one go, but
  labels and constraint glyphs only accepted clicks in the select tool. Anyone
  who finished dimensioning and tried to correct a value found every label inert,
  with no cursor change to explain why. Labels and glyphs are now live in the
  dimension tool as well, and dimensioning still wins the clicks it needs: a
  click that lands on geometry, or one made while a dimension is part-placed,
  goes to the tool rather than the label.
- **Double-clicking a dimension always opens its editor.** A label that sits on
  top of the geometry it measures used to lose every click to the pick
  underneath, which could leave it permanently uneditable.
- **"Open in OrcaSlicer" now works on Windows and macOS.** The default slicer
  path had no per-platform branching, so every install pointed at a Linux
  AppImage under the user's home directory. On Windows and macOS that file
  cannot exist, and since nothing in the UI writes a settings file, the default
  was the only value and the handoff was dead. SindriCAD now looks in the usual
  install locations per platform and picks the first that exists. Orca's preset
  directory was wrong in the same way and follows the same rule.
- User presets are recognised on Windows again. The check for "is this the
  user's own preset" matched the substring `/user/`, which no Windows path
  contains, so user presets were treated as system ones and lost their
  preference during preset selection.
- The texture documentation claimed every pattern closes on itself at any angle.
  Ribs and waves do; the 2D lattices (knurl, hexagon) close only at multiples of
  90 degrees, which is a property of the geometry rather than a bug.

### Security

- **postcss 8.5.15 to 8.5.25** ([GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849),
  high). A crafted `sourceMappingURL` comment could walk out of its directory and
  disclose the contents of any `.map` file on the machine running the build. This
  is a build-time dependency and the build parses no untrusted CSS, so shipped
  applications were never exposed.
