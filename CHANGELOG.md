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

- **A very large assembly now opens instead of killing the app.** Importing the
  file worked, but on a 356 MB assembly of about 3,000 parts the app then died
  partway through drawing it, with no message. Two separate causes, both fixed.

  The finished geometry was too big to hand to the 3D view in one piece. Most of
  that turned out to be the model's edge lines, which were being sent as text;
  they are now sent in a compact binary form, about a quarter of the size and
  visually identical. On top of that, a document with more than about a thousand
  parts is now drawn at a slightly coarser level of detail, and above roughly two
  thousand parts coarser again. Curved surfaces on those very large assemblies
  are therefore a little less smooth than on an ordinary document, which is the
  trade that lets them open at all. Documents below that size are drawn exactly
  as before.

  The second cause was the step that works out how big the model is, so the view
  knows where to point the camera. On an assembly this size that single
  calculation took over a minute and a half, long enough that the geometry engine
  was assumed to have hung and was restarted, every time. It now measures the
  model already prepared for drawing, which takes no measurable time at all.

  If a model is still too large to display, SindriCAD now says so and names the
  size, rather than closing the connection to the geometry engine and leaving the
  app looking like it crashed.

- **Large STEP assemblies import.** A STEP file over 256 MB was refused outright,
  which ruled out most real assemblies exported from a full CAD system. STEP,
  STP and BREP files can now be up to 1 GB. Mesh formats keep the old limit on
  purpose: an STL of the same size is a far larger triangle count and a much
  heavier document, so the number that is safe for one is not safe for the other.

  Two things came with it. Before an import starts, SindriCAD works out roughly
  how much memory the file will need and checks that against what your machine
  actually has free. If it will not fit, you get a sentence saying how much is
  needed and how much is available, instead of the app being killed partway
  through and reporting that the geometry engine crashed. And once a large
  assembly is in, SindriCAD tells you what to expect from it rather than letting
  you discover it: above about a thousand bodies the 3D view starts to lag when
  you orbit, and above three thousand it is slow. Everything else, including
  modelling, export and printing, is unaffected at any of those sizes.

- **Exports show that they are running, and can be stopped.** Exporting replays
  your whole feature history, so on a large document it takes as long as an
  import does. Until now it did that with nothing on screen to say so and no way
  to stop it. Both the model export and the print-project export now show
  progress and have a working Stop button.

- **Exporting a STEP assembly keeps its structure.** Opening an assembly kept its
  tree, names and colours; exporting one then flattened all three, so a file you
  could open was a file you could not ship. A STEP export now carries the
  assembly hierarchy, the per-part names, the colours the original file
  carried, and the position of every part, including repeated subassemblies that
  appear in several places. Re-importing your own export gives you back what you
  started with: same parts, same names, same colours, same positions, same face
  count.

  Parts that contain no solid survive the round trip too. They used to vanish on
  the way in; now they make it all the way back out.

  Documents you modelled yourself also carry their body names into the exported
  file, so a part arrives called "Base Plate" rather than "Solid".

  Still not there: 3MF and glTF exports do not yet carry the tree, only STEP
  does, and a subassembly still cannot be renamed.

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
  renamed in the Browser, though individual bodies still can. And part colours
  from the file are recorded but not shown on screen, because colour in SindriCAD
  means which filament prints a body.

### Changed

- **A saved `.sindri` file is now a container, and is much smaller.** Geometry
  used to be written into the document as text, which made files far bigger than
  the geometry in them and meant a part used twice was stored twice. A `.sindri`
  is now an archive holding the document and its geometry separately, with each
  distinct piece of geometry stored once. On the test documents the saved file is
  about a sixth of its former size.

  **Files you already have still open**, and are quietly upgraded to the new
  layout when you save them. The one thing to know before you update: a file
  saved by this build **cannot be opened by an older build of SindriCAD**. If you
  need to move a document back to an older version, keep a copy before saving it
  here.

- **"Each body separately" writes a folder.** Choosing to export each body to its
  own file used to scatter the files next to the name you picked, so choosing
  `parts.step` produced `parts-Body1.step`, `parts-Body2.step` and so on. The
  file the save dialog asked you to confirm overwriting was never actually
  written, which meant it was the only one that could not be overwritten: the
  files that were written replaced any existing ones of the same name without
  asking. The export now creates a folder named after your chosen file and puts
  the parts inside it, and if a folder of that name already exists it stops and
  says so rather than writing over what is in it.

  Body names that a filesystem cannot take are handled properly now too: very
  long names in non-Latin scripts are trimmed to fit, and names that Windows
  reserves, such as a body called "Con" or "Aux", no longer produce an
  unexplained failure on that platform.

- **STL and 3MF exports use one quality setting.** Untextured models took a
  different route out of SindriCAD from textured ones and were tessellated at a
  different setting. Both now use the same export quality. For most shapes the
  result is identical; for a strongly curved one, such as a torus, the exported
  mesh has roughly half as many triangles. The largest deviation from the true
  surface is 0.02 mm either way, which is far below what any printer can
  resolve, so this shows up as a smaller file rather than a visibly coarser part.

### Fixed

- **A long export is no longer cut off partway.** Exporting, checking for
  clashes, and projecting geometry each had two minutes to finish, whatever the
  document. A large assembly can legitimately need longer, and the failure fed
  itself: giving up restarted the geometry engine, which discarded the cached
  work, so every retry started from cold and hit the same wall. These now run
  for as long as they are making progress, and are only stopped if the geometry
  engine genuinely gets stuck, which is now noticed in one minute rather than two.

- **Running out of memory says so.** A file too large for the machine's memory
  ended with the operating system killing the geometry engine, which SindriCAD
  could only report as "the geometry kernel crashed". That sent people looking
  for a fault in their model when there was none. The cause is named now, before
  the work starts.

- **Stopping an export is no longer reported as a failure.** Pressing Stop
  produced an error dialog reading "Export failed: cancelled", which is your own
  action handed back to you as a problem. It now just stops.
- **The geometry engine starts on Windows machines whose font folder holds a file
  it cannot read.** Starting SindriCAD could fail outright with "the geometry
  engine could not start on this computer", and the message blamed your
  installation, which was wrong and left nothing to act on. The real cause was
  one file in `C:\Windows\Fonts`. The geometry library scans that folder the
  moment it loads, and a single font it cannot parse took the whole engine down
  with it: either a font collection saved under a plain `.ttf` name, or an old
  bitmap font that is not really a font file at all. Both are ordinary things to
  have on a Windows install, and neither has anything to do with your model. The
  scan now skips a file it cannot read instead of giving up, and names the
  skipped file in the engine log. Reported by four people across four builds.

- **An ordinary mouse is no longer mistaken for a 3D mouse.** SindriCAD looks for
  a 3Dconnexion SpaceMouse at startup, and 3Dconnexion's older devices share a
  manufacturer id with every Logitech mouse and keyboard ever made. On a machine
  where the system does not say what a device is for, SindriCAD trusted that id
  alone, opened whatever it found and fed the result to the camera, so moving an
  ordinary mouse could spin the model. It now asks the device itself what it is
  and ignores anything that does not declare itself a multi-axis controller. A
  real SpaceMouse is unaffected, including models not known by name.

  The list of what was found is also recorded reliably now. It was being gathered
  before the window existed and then thrown away, so a bug report about a 3D
  mouse arrived with no trace of any hardware in it.

- **The AppImage starts on distributions that ship a current WebKit.** It carried its
  own copy of WebKit and the GTK stack around it, and on a system whose own WebKit is
  newer, that bundled copy killed its rendering process the moment the app launched. The
  window opened and stayed blank, with nothing in the log to explain it
  ([#3](https://github.com/MakerViking/sindricad/issues/3)). The AppImage now uses the
  WebKit your distribution ships, the same as the `.deb` and `.rpm` always have, and it
  is about 100 MB smaller for it. **It is no longer fully self-contained:** a system
  without WebKitGTK 4.1 and libsoup 3 installed needs them added first. The
  [Requirements](https://github.com/MakerViking/sindricad#requirements) section of the
  README lists what each build needs, and now carries a confirmed NixOS recipe.

  Thanks to [@boustanihani](https://github.com/boustanihani) for reporting this and
  for sticking with it through several rounds of diagnostics. The detail that
  cracked it came from those reports: the `.deb` worked where the AppImage did
  not, on the same machine and the same build. The fix is confirmed on NixOS
  25.05, and the `appimage-run` configuration it needed came back with that
  confirmation, which is what the README recipe is built from.

- **A window that opens without its interface now says so.** If the app failed to
  load its own page, the result was a blank window and no explanation anywhere.
  The geometry engine logs happily right up to "LISTENING 8765" above it, so the
  log read like an engine fault when it was nothing of the kind, and a report of
  it took days to place ([#3](https://github.com/MakerViking/sindricad/issues/3)).
  The app now waits twelve seconds for the interface to start, and if it has not,
  writes that plainly to `sidecar.log` along with the fact that the geometry
  engine is not the problem. This changes nothing when the app starts normally.

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
  model and the limit. That limit is on a single message rather than on the file
  you opened, and it is a different one from the import size described above.
  Now that geometry no longer travels inside the document, a model is much less
  likely to reach it.

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
