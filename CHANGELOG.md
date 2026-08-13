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

- **Option/Alt + left-drag now orbits, for mice and trackballs with no middle
  button.** Reported on a Mac trackball. Panning was fine, because that is
  right-drag, but nothing could free-orbit: the view could only ever jump between
  the standard views on the ViewCube, which is not a way to model.

  Holding Option (Alt on Windows and Linux) makes the left button behave exactly
  like the middle one, Shift-to-pan and the sketch's lock-to-plane included, so
  there is one rule to remember rather than a second set of gestures. It is the
  same combination Blender and FreeCAD use for the same hardware.

  Left-click still selects whenever Option is not held, and the mouse map is now
  worked out from the click itself rather than tracked as you press and release
  the key, so switching away from the app mid-drag cannot leave the button stuck
  in a mode where clicking no longer selects anything.

### Fixed

- **Textured surfaces no longer export broken geometry, and build twice as
  fast.** Two faults, both in the mesh a texture produces.

  The mesh contained triangles with no area at all: 458 on a 110mm hexagon-
  textured plate, 220 on ribs. They were invisible on screen, but each one made
  the mesh **non-manifold**, which is the kind of defect a slicer is entitled to
  refuse. A further 9,906 triangles on the same plate were not quite flat, and
  1,450 of those collapsed to nothing anyway once written into an STL or 3MF,
  because those formats store less precision than SindriCAD works in. Both
  sources are gone: the mesh now measures zero degenerate triangles across every
  pattern, sharpness and angle.

  **This changes the exported mesh for any document with a texture**, which is
  the point, and it means the first rebuild after updating is a slow one for
  those documents while the texture cache refills.

  The same work made large textures much faster. Repairing the pattern across a
  crease was measuring the surface one candidate at a time, which on that plate
  meant 181,224 separate measurements and 96% of the whole build. It now measures
  a whole pass at once: **10.2 seconds down to 4.2 seconds** on the same plate,
  with the same result.

- **Edges on the far side of a model no longer steal clicks from the face in
  front of them.** Selecting a small face was unreliable, and it got worse the
  more the view was tilted: an edge you could not see, on the back of the body,
  could still take the click. It was never drawn where it was winning, so there
  was nothing on screen to explain why the click missed.

  Edges hidden behind the surface are now ignored when selecting, which is
  exactly how they already behave when drawn. Edges you can see are unaffected,
  including the ones lying on the face they bound.

- **"Open in Orca" now finds OrcaSlicer when it is installed as a Flatpak.**
  Reported on Fedora 44. There were two reasons it found nothing, and the second
  one mattered more: only the system-wide Flatpak location was checked, and
  Fedora's Software app installs per-user by default; and the app id being looked
  for was OrcaSlicer's old one, retired before 2.3.2, so an Orca installed today
  was missed in both locations. All four combinations are checked now, and a
  Flatpak found this way also has its presets read from the right place, so the
  handoff opens on your own printer instead of on nothing.

  If Orca still is not found, the message now names the settings file you can put
  a path in, rather than quoting one specific AppImage you have probably never
  heard of.

## 0.1.128 (2026-08-12)

### Changed

- **Properties measures the model, not its picture.** Volume, area and centre of
  mass were read off the on-screen triangles, which under-report anything curved:
  a sphere by about 1.4%, a cylinder by about 1%. The figures still appear
  instantly, then settle to the exact answer from the geometry kernel. Flat parts
  never differed; curved ones were quietly wrong every time.
- **A body that is not closed no longer reports a volume of zero.** An imported
  part whose surfaces do not seal into a solid has no volume to measure, but the
  Properties figures showed `0` for it — and a centre of mass at the origin, which
  on one real part sat 36 mm outside the part itself. Such a body now says it
  could not be measured, and why, instead of showing numbers that look real.
  A part with no measurable extent no longer drags the model's overall size to a
  nonsense value either.

- **Shell, Draft, Offset face and Texture no longer grab a rounded face you did
  not pick.** Picking a flat face records it by its direction, and that test was
  being applied to curved faces too, where a single direction does not mean
  anything. A cylinder lying on its side reports "up" at one point on its
  barrel, so selecting the flat top of a bracket with a horizontal boss quietly
  selected both boss barrels as well. On a real machined part in the test
  corpus, asking for the upward faces returned two flat faces and a 587 mm²
  cylinder, and handing that to Shell failed with nothing more than "offset
  Error".

  **This changes what some existing documents select.** The direction test now
  only applies to flat faces. Almost every model is unaffected. But if a feature
  in an older document was reaching a rounded face this way, that face is no
  longer included, so the feature either starts working (it was probably failing
  before) or reports "no face found" and asks you to pick again. In that case
  you will need to delete and redo the feature. Selecting a curved face by
  clicking it still works as it always did.

  Two things that used to happen quietly now speak up. A Shell whose opening no
  longer resolves refuses, instead of returning a sealed solid that exports and
  prints with no hint anything was lost. And a texture whose face has been
  consumed by a later feature reports that it was dropped, instead of leaving a
  smooth surface you would only find after slicing.

  **The first time you open each saved document after this update it will
  rebuild from scratch.** That is a one-off and has nothing to do with the
  document.

- **Texture cells no longer break up around embossed text, or against any
  edge.** Two separate faults, both in the band where the pattern is stitched to
  the edge of a face. Text sitting on a textured face puts one such edge around
  every letter, which is where it showed: a ring of shattered, half-melted cells
  hugging the lettering while the rest of the pattern was clean.

  **This changes how existing documents look.** Any texture left at the default
  Edge blend of 0 now meets the edge of its face cleanly instead of sagging into
  it, so a model you saved before this build will rebuild slightly differently
  around every textured boundary. That is the fix working, but it is a visible
  change to work you have already done, so it is worth knowing before you open
  an old file.

  The pattern now runs at full height right up to the boundary, with a vertical
  wall closing the step, so a partial cell looks like a cell that has simply been
  cut rather than one that has been dragged down into the surface. And the
  honeycomb pattern now places its own corner points where its creases meet an
  edge, so the cells beside a letter follow the pattern instead of being
  triangulated across it. Measured on a real document: cells that fail to follow
  the pattern fell from 35% of the band to 1.7%, and the worst deviation nearly
  halved. Small enclosed shapes — the middle of an "A" or a "D" — carry the
  pattern properly now instead of coming out as noise.

  Textures still meet neighbouring untextured faces exactly, so nothing leaks and
  exports stay watertight. Big textured faces take a little longer to build than
  before, which is the repair pass now having real work to do.

  If you preferred the old softened edge, the Edge blend setting under Advanced
  still does it — it now means what it says, rather than 0 producing a hard step
  the pattern could not absorb.

### Added

- **Text on a face.** Click any face of a body, type, and the text is embossed
  (raised) or engraved (cut) straight into it — no sketch step. Pick the font,
  size, depth, alignment and angle, with bold and italic and optional word
  wrapping, and edit any of it later from the timeline.

  Curved faces work too: text wraps onto cylinders, cones and spheres, not just
  flat faces.

  Letters can be given a bevelled edge — rounded, chamfered or sloped-wall —
  sized in millimetres rather than degrees, so changing the depth never changes
  how the bevel looks. Not every font can bevel every letter at every size, and
  where one can't, SindriCAD says so and leaves the text alone rather than
  quietly shipping a word with three rounded letters and two sharp ones.

  The text lands where you click, and it stays put: the reference is stored as a
  queryable face selector, so upstream edits that renumber the model don't move
  it. If an edit actually moves the face out from under the text, the feature
  says so and offers a re-pick instead of quietly leaving the letters floating
  in mid-air. And if the text runs off the edge of the face it tells you, rather
  than silently shearing off the letters that didn't fit.

  Engraving deeper than the material is allowed and cuts clean through, which is
  how you get stencil lettering. What it refuses is a cut that would break the
  body into loose pieces.

- **Model size is no longer a hard limit on what you can open.** Until now the
  finished geometry had to reach the 3D view as one piece, and there was a
  ceiling on how big that piece could be — about 128 MB. The 356 MB reference
  assembly came in at 95% of it, so a model only a few per cent larger simply
  refused to open, with a message telling you to hide some bodies in a document
  you could not open in the first place.

  The geometry is now sent in pieces and put back together as it arrives, so
  there is no ceiling to hit. Nothing about the models you already have changes —
  the same geometry, drawn the same way — but a document that used to be turned
  away now opens. A single body that is enormous on its own is still refused,
  and that message now tells you which body it is.

- **A large assembly now appears piece by piece instead of all at once.** The
  last stretch of opening a big model used to be one long pause with the
  previous document still on screen. Parts now fill in as they arrive, and the
  view frames the finished model before the first one lands, so the camera
  settles once and stays put while the rest appears. Measured on a 3,000-part
  assembly: it fills in over eight steps rather than arriving in a single jump.
  Picking and tools stay off until it has finished loading, which is when a
  selection would have survived anyway.

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

- **A very large assembly opens about 40% faster.** Opening the 356 MB,
  3,000-part reference assembly for the first time went from roughly five
  minutes to under three, measured end to end on the same machine. Two things
  accounted for nearly all of it. Extracting the model's edge lines was spending
  almost all of its time on bookkeeping rather than on geometry, and is now
  about eleven times faster. And every surface in the model was being measured
  twice on every open, once to track which feature created it and once to draw
  it; the second measurement now reuses the first. What ends up on screen is
  unchanged: the same parts, the same edges, the same level of detail, down to
  the last point.

  Importing the STEP file itself is not part of that saving and is unchanged.
  That stage is almost entirely inside the geometry kernel, and every setting
  that could shorten it either made no difference or quietly dropped parts of
  the model, which is not a trade worth making. It is also paid only once per
  file: reopening a document you have already imported does not repeat it.

- **Progress while a large model is prepared for drawing now means something.**
  After the feature history finishes rebuilding there is a further stage that
  prepares every part for display, which on a large assembly runs for over two
  minutes. That entire stage showed the word "meshing" with the bar sitting at
  zero and offered no way to stop it. It now counts the parts as it works
  through them, and a Stop button appears for any rebuild long enough to want
  one.

- **Hiding and showing bodies is instant on a large assembly.** Clicking the eye
  next to a body rebuilt the whole 3D scene, which on a 3,000-part assembly
  locked the window up for about two thirds of a second every time. Hiding parts
  is the normal way to work with an assembly that size. Toggling visibility
  changes no geometry, so nothing is rebuilt for it now.

- **Importing an STL or 3MF is faster.** The same bookkeeping problem behind the
  edge-line saving above was also sitting in the mesh import path. A prismatic
  part imports between 1.3 and 6 times faster depending on its size, and the
  resulting model is identical.

- **The geometry cache no longer grows without limit.** SindriCAD keeps prepared
  geometry on disk so that a document you have opened before opens quickly.
  Nothing ever removed the older parts of it, so on a machine used for large
  assemblies it could reach several gigabytes and carry on from there. The cache
  is now given a size budget worked out from the free space on the drive it sits
  on, between 512 MB and 8 GB, and the least recently used entries are dropped
  once that is exceeded. What goes first is whatever is cheapest to recreate, so
  a dropped entry costs a moment of extra work rather than a full rebuild. Saved
  documents are never touched by this. Setting `SINDRI_CACHE_MAX_GB` overrides
  the budget for anyone who wants a specific size.

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

- **Sketch constraints, dimensions and point dragging work again.** In every
  installed build, the constraint solver never started. Constraint tools did
  nothing, a typed dimension was applied once rather than staying live, and an
  unconstrained point or line could not be dragged at all. The app blamed your
  webview and told you to update it. That was wrong, and I am sorry: the fault
  was SindriCAD's own security policy blocking the code the solver needs to
  start. Nothing on your machine ever needed changing, and at least one person
  reinstalled the Microsoft Edge WebView2 runtime for nothing.

  This only ever affected installed builds and never a development run, which is
  why it lasted as long as it did.

- **Zooming no longer throws the view somewhere else.** The wheel dived the
  camera straight down the middle of the screen instead of moving toward
  whatever the pointer was over, so the thing you were aiming at drifted
  outward, left the viewport after a few notches, and the view filled with
  unrelated geometry. The point under the cursor now stays under the cursor.

- **STL files saved in the text format import.** ASCII STL could not be read at
  all, and the progress bar stopped at 44% on the way to failing. Both are
  fixed, and the bar now moves through the whole import instead of parking at
  44% whatever happens.

- **Taking the last area off an extrude no longer discards it.** Ctrl-clicking
  areas off an extrude in progress until none were left kept the depth box on
  screen, and pressing Enter there quietly threw the whole extrude away. That
  step also never mentioned that Ctrl-click adds and removes areas, so the other
  closed shapes in a sketch looked as though they simply could not be chosen.

- **The Linux AppImage installs with desktop integration tools again.** Its icon
  was a link pointing into a directory on the machine that built it, so it
  resolved nowhere else and AppImage managers refused to install it.

- **Moving a sketched shape no longer moves the extrude onto something else.**
  Extrude a circle sitting inside a rectangle, go back to the sketch and drag
  that circle somewhere else, and the extrude jumped to the rectangle: you came
  back to a block with a hole in it instead of the peg you made. The selected
  area was remembered as a point in space, and the point stayed behind when the
  circle moved, landing inside whatever profile then covered it. An extrude now
  also remembers which sketch shapes formed the area, so it follows them.

  Where the shapes cannot identify one area on their own — the two halves of a
  square split by a line, for instance — it still uses the point, because a
  confidently wrong area is worse than the old behaviour. Extrudes made before
  this build keep working exactly as they did; the new reference is recorded the
  next time the extrude is created or edited.

  Reopening such an extrude to edit it can still highlight the old area even
  though the model is now correct. That half is not fixed yet.

- **An extrude covering several areas can be edited down to fewer.** Reopening an
  extrude offered "Ctrl-click areas to add/remove" and then committed the extrude
  on the very first Ctrl-click, so an extrude made across two profiles could not
  be reduced to one — the only way out was to delete it and start again.
  Ctrl-click, Shift-click and Cmd-click now change the area set; a plain click
  still commits. Removing the last area returns to picking rather than leaving a
  preview of nothing on screen.

- **The keyboard works again.** A change in the previous build added a trail of
  breadcrumbs to the status line so that a bug report would carry the message
  that prompted it. The state that trail keeps was declared near the bottom of
  the startup file, but the status line is written to near the top, before the
  app has reached the sidecar — and the very first thing it writes, "connecting
  to sidecar…", is exactly what tripped over it. Startup stopped there every
  time, part-way through wiring the app up, so everything set up after that
  point was never set up at all.

  In practice that meant the keyboard: every shortcut, from Escape and the
  single-key tool keys to Ctrl+N, Ctrl+O, Ctrl+S and Ctrl+E. The sketch palette
  stopped following the tool you were using, and the toolbar stopped switching
  to its sketch row when you entered a sketch. An unexplained "Something went
  wrong — check console" appeared alongside it. The menus and the toolbar
  buttons kept working, which is why it looked like a handful of unrelated
  faults rather than one.

- **No more "Something went wrong" for something that did not go wrong.** Opening
  the app and touching nothing could raise a string of error toasts saying
  something had broken and to check the console. Behind each one was a
  ResizeObserver notification: a routine browser signal that a resize spilled
  into the next frame, emitted by anything that resizes a 3D view, and harmless.
  The catch-all that turns unexpected errors into a toast now ignores it, and so
  does the bug-report trail, where a run of them was pushing out the entries that
  actually explain a problem.

- **A Linux user is no longer told to update Microsoft Edge.** When the webview
  refuses to compile the constraint solver, the message named Microsoft Edge
  WebView2, because the first machine this ever happened on ran Windows. On Linux
  it now names WebKitGTK, and on macOS the system webview. Sketching still works
  without constraints in every case, and the message still says so.

- **Bug reports now carry enough to diagnose a stall.** When an operation stalls
  and the geometry engine is restarted, that is now written to the log; it used
  to happen silently, so a report filed about a stall could arrive with a log
  holding nothing but the engine starting up. The warning banner is recorded in
  the report trail too, and reports now include the OS build and webview version,
  which is what decides whether a machine can run the constraint solver at all.

- **The Linux .deb now says which system libraries it needs.** It declared
  WebKitGTK and GTK but nothing about the C library, so on a distribution too old
  to run SindriCAD at all the package installed happily and the app then died at
  launch with a `GLIBC_2.34 not found` message that pointed at nothing useful.
  The package now requires glibc 2.34 or newer, which is the same bar the
  requirements table has always described, so apt refuses up front and says why.
  Nothing changes on a supported distribution: Ubuntu 22.04 and newer, Debian 12
  and newer already satisfy it.

- **Shell now asks for the wall thickness instead of choosing it for you.**
  Picking a face to open committed the shell immediately with a 2 mm wall, and
  nothing on screen ever said so — the only way to find the number, let alone
  change it, was to select the feature afterwards and look in the inspector.
  Shell now shows the same thickness box every other tool that takes a value
  uses, seeded at 2 mm so pressing Enter straight away does what it always did.
  Type a value, or press Escape to back out without creating anything.

- **A few refused connections no longer wedge the geometry engine for good.**
  Every connection the sidecar rejected leaked one slot of its concurrent
  connection limit, because the cleanup that releases the slot sat below a line
  that raised on the reject path and never ran. Eight rejects and the sidecar
  turned away everything that followed, the real app included, with "geometry
  engine connection lost" until it was restarted. Nothing an ordinary session
  does reaches this, since the app holds one connection and presents a valid
  token; it took a stale token retrying to burn through the limit. Rejected
  connections now release their slot.

- **An empty document now shows the grid and the origin instead of nothing.**
  With no geometry to frame, the view was pointed away from the scene entirely,
  so a new document looked like a black window with no way to tell what had
  gone wrong. It now settles on a hand-sized view of the origin, which puts the
  ground grid at a legible scale. This was never visible while SindriCAD opened
  on a built-in example part, and appeared as soon as it started empty.

- **Choosing a sketch plane from the Browser no longer disables every tool.**
  Answering "select a plane" by clicking the plane in the Browser tree, rather
  than in the 3D view, left the plane picker running underneath. From then on
  every tool that first checks whether another tool is busy, extrude, fillet,
  shell, press/pull, measure and section among them, did nothing at all when
  clicked, gave no message explaining why, and stayed that way until SindriCAD
  was restarted.

- **The Units dropdown is no longer white with grey text on the dark title
  bar.** Native controls, a dropdown and its popup list among them, are drawn
  by the browser engine rather than by SindriCAD, and they default to the light
  palette however dark the page around them is. The dropdowns are now told to
  use the dark palette, so the closed control, its list and its scrollbars all
  match the rest of the window.

- **The panels no longer paint over the timeline.** In a short window the
  browser, the 3D view and the inspector stretched to the height of whichever
  panel had the most content in it, ran past the bottom of the window, and
  covered the timeline underneath, hiding the buttons in the bottom-left corner
  with nothing to indicate they were still there. The panels are now bounded by
  the space they are given rather than by what is inside them.

- **Leaving a sketch clears its prompt.** The hint line kept telling you to
  click two corners and type a width long after the sketch had closed and the
  toolbar had switched back to solid tools, so the app was asking for something
  it had stopped listening for.

- **Starting a new document, or opening one, no longer leaves the old model on
  screen.** If a rebuild was still running, "New" emptied the document but left
  the previous model in the 3D view, said nothing about it, and hiding the body
  did not remove it, because there was no longer a body in the document to hide.
  On a large assembly the rebuild can run for minutes, and for all of that time
  the app looked broken. Replacing the document now clears the view and stops
  the build that belonged to the old one, so the new document appears straight
  away.

- **SindriCAD opens on an empty canvas.** It used to start by loading a built-in
  example part, so every launch began by building geometry you had not asked
  for, and "New" was the first thing most people pressed. Anything you were
  working on when SindriCAD last closed is still restored as before.


- **Exporting a large assembly now produces a file.** On an assembly of about
  3,000 parts, exporting to STEP wrote nothing at all. The export was working
  fine: it simply takes about a minute to write a file that size, and the
  watchdog that looks for a wedged geometry engine gives up after one minute. So
  the export was killed seconds before it finished, you were told the geometry
  engine had been restarted, and the file you asked for was never created.
  Export now gets a time budget scaled to the size of the document, the way
  import already did. The same assembly exports in about 48 seconds and writes a
  984 MB file.

- **Importing an OBJ file works.** OBJ was listed in both the Open and Import
  file pickers and failed every single time with a raw developer error, because
  the reader underneath only ever accepted STL and 3MF. OBJ files now import
  properly, including ones whose faces are quads or larger polygons.

- **A dense mesh no longer crashes the geometry engine.** Importing a detailed
  scanned or organic STL of around 150,000 triangles killed the geometry engine
  outright after about half a minute. Just below that size it did not crash, but
  it worked for two minutes before reporting that the model was not something
  SindriCAD can edit. Both cases are answered immediately now: the shape of the
  mesh is checked first, and a curved or organic surface that cannot become an
  editable model is refused in well under a second. Meshes that did import
  before are unaffected, including detailed prismatic parts with many holes.

- **A very large assembly now opens every time, and reopens in seconds.** The
  previous build could open a 356 MB assembly of about 3,000 parts, but only
  around two attempts in five. The others failed silently: the model never
  appeared, nothing was written to the log, and the app sat showing the previous
  document with no error to go on.

  The cause was the step that restores a previous build from the on-disk cache.
  On a document that size it took over two minutes, and it ran without reporting
  any progress, so the watchdog that looks for a stuck geometry engine assumed
  the worst and restarted it. That happened before the rebuild had printed
  anything at all, which is why there was never a message to find. The restore
  now reports progress as it works, and the identity check it spent almost all
  of that time on has been replaced with a far cheaper one, so the same step
  finishes in about two seconds.

  Reopening a document of that size went from roughly 48 seconds to under 11.
  Most of the rest of that saving is in the drawing data: on a large assembly it
  is now kept on disk between sessions, where before nearly all of it was thrown
  away and rebuilt from scratch on every open. Opening such a file for the first
  time is unchanged, and still takes a few minutes.

  Two other operations could fail the same silent way on an assembly of this
  size, checking for clashes and running a cut or join against thousands of
  bodies. Both now report progress instead of being mistaken for a hang.
- **The group names under the toolbar are no longer cut in half.** CREATE,
  MODIFY, CONSTRUCT and INSPECT were sitting in a toolbar of fixed height with
  slightly more content than would fit, so the bottom of the lettering was
  simply clipped. How much you lost depended on the font your system draws with,
  which is why it showed up on macOS and on Linux and was easy to miss
  elsewhere. Measured here at 7 pixels of a 13 pixel caption, so a little over
  half. The toolbar now takes the height its contents actually need, on every
  platform and at any window size, and still scrolls sideways when the window is
  too narrow for every tool. Reported from macOS and, separately, as
  [#10](https://github.com/MakerViking/sindricad/issues/10).

- **A circle diameter now takes a typed value even where the constraint solver
  will not start.** On a machine whose WebView2 refuses to run the sketch
  solver, typing a new diameter on a circle did nothing at all: no change, no
  message. Rectangles kept working, which made it look like a problem with
  circles specifically, and that is how it was reported. The cause is that a
  circle's diameter and a line's length are the only two dimensions applied by
  the solver rather than written straight to the shape, so they were the only
  two that vanished when it was missing.

  Both are now applied to the shape directly when there is no solver, and
  SindriCAD says once that it has done so. The dimension is still recorded, so
  it drives the geometry properly as soon as the solver is available, and a
  sketch made this way is no different from one made on a working machine.

  If you see the message about the solver not starting, updating the Microsoft
  Edge WebView2 Runtime is still the real fix: without it, dimensions do not
  hold when other geometry moves.

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
