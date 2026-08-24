// Minimal stroke icons (24×24, currentColor) for the whole UI — ribbon, timeline,
// browser tree, and the window chrome. Each entry is the inner SVG markup; icon()
// wraps it.
//
// House style, hold to it when adding entries: 24×24 viewBox with a ~20×20 live
// area, stroke-width 1.6 (set once on the wrapper), round caps and joins, fill="none"
// with fill="currentColor" only for solid dots, and NO colour values anywhere — every
// icon takes its colour from the parent's `color`, which is what makes hover/selected
// states work without touching the markup.

const PATHS = {
  // The pointer arrow, drawn as an outline so it takes the same stroke weight as
  // every other entry. Deliberately the plain cursor and nothing else: it is the
  // one glyph a user already reads as "stop drawing, let me click things", which
  // is exactly what field report c9db7ec2 could not find a control for.
  select: `<path d="M5 3.2L5 19.4l4-3.9 2.7 5.3 2.8-1.4-2.7-5.2 5.2-0.5z"/>`,

  // sketch create
  line: `<line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="1.6" fill="currentColor"/><circle cx="20" cy="4" r="1.6" fill="currentColor"/>`,
  rectangle: `<rect x="4" y="6" width="16" height="12" rx="0.5"/>`,
  circle: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1" fill="currentColor"/>`,
  arc: `<path d="M4 19 A 14 14 0 0 1 20 11"/><circle cx="4" cy="19" r="1.5" fill="currentColor"/><circle cx="20" cy="11" r="1.5" fill="currentColor"/>`,
  spline: `<path d="M3 17 C 7 5, 11 5, 13 12 S 19 19, 21 7" fill="none"/><circle cx="3" cy="17" r="1.5" fill="currentColor"/><circle cx="13" cy="12" r="1.5" fill="currentColor"/><circle cx="21" cy="7" r="1.5" fill="currentColor"/>`,
  polygon: `<polygon points="12,3 20,9 17,19 7,19 4,9"/>`,
  point: `<circle cx="12" cy="12" r="2.2" fill="currentColor"/>`,
  text: `<path d="M4 6 H20 M12 6 V19" fill="none"/>`,
  slot: `<path d="M8 8 A 4 4 0 0 0 8 16 L16 16 A 4 4 0 0 0 16 8 Z"/>`,
  patternRect: `<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>`,
  patternCircular: `<circle cx="12" cy="4" r="2.4"/><circle cx="19" cy="9" r="2.4"/><circle cx="16.5" cy="18" r="2.4"/><circle cx="7.5" cy="18" r="2.4"/><circle cx="5" cy="9" r="2.4"/>`,
  boltCircle: `<circle cx="12" cy="12" r="9" fill="none"/><circle cx="12" cy="3.5" r="1.8" fill="currentColor"/><circle cx="19.4" cy="8.3" r="1.8" fill="currentColor"/><circle cx="19.4" cy="15.7" r="1.8" fill="currentColor"/><circle cx="12" cy="20.5" r="1.8" fill="currentColor"/><circle cx="4.6" cy="15.7" r="1.8" fill="currentColor"/><circle cx="4.6" cy="8.3" r="1.8" fill="currentColor"/>`,
  hexHoles: `<circle cx="12" cy="6" r="2" fill="currentColor"/><circle cx="6.8" cy="9" r="2" fill="currentColor"/><circle cx="17.2" cy="9" r="2" fill="currentColor"/><circle cx="6.8" cy="15" r="2" fill="currentColor"/><circle cx="17.2" cy="15" r="2" fill="currentColor"/><circle cx="12" cy="18" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/>`,
  honeycomb: `<polygon points="12,2 16,4.5 16,9.5 12,12 8,9.5 8,4.5" fill="none"/><polygon points="12,12 16,14.5 16,19.5 12,22 8,19.5 8,14.5" fill="none"/><polygon points="20,7 24,9.5 24,14.5 20,17 16,14.5 16,9.5" fill="none"/><polygon points="4,7 8,9.5 8,14.5 4,17 0,14.5 0,9.5" fill="none"/>`,
  gridHoles: `<circle cx="6" cy="6" r="2" fill="currentColor"/><circle cx="12" cy="6" r="2" fill="currentColor"/><circle cx="18" cy="6" r="2" fill="currentColor"/><circle cx="6" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="18" cy="12" r="2" fill="currentColor"/><circle cx="6" cy="18" r="2" fill="currentColor"/><circle cx="12" cy="18" r="2" fill="currentColor"/><circle cx="18" cy="18" r="2" fill="currentColor"/>`,
  centerRectangle: `<rect x="4" y="6" width="16" height="12" rx="0.5"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="12" y1="9" x2="12" y2="15"/>`,
  circle2: `<circle cx="12" cy="12" r="8"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="19.5" cy="12" r="1.4" fill="currentColor"/>`,
  circle3: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="4" r="1.4" fill="currentColor"/><circle cx="19" cy="16" r="1.4" fill="currentColor"/><circle cx="5" cy="16" r="1.4" fill="currentColor"/>`,
  dimension: `<line x1="4" y1="7" x2="4" y2="17"/><line x1="20" y1="7" x2="20" y2="17"/><line x1="4" y1="12" x2="20" y2="12"/><path d="M7 9l-3 3 3 3"/><path d="M17 9l3 3-3 3"/>`,
  // Project: a 3D curve above, an arrow projecting it down onto a plane
  project: `<path d="M5 6 Q 12 1 19 6" fill="none"/><line x1="12" y1="7" x2="12" y2="13"/><path d="M9.5 11 L12 14 L14.5 11"/><path d="M3 19l5-4h13l-5 4z"/><path d="M6.5 17.4 Q 12 13.6 17.5 17.4" fill="none" stroke-dasharray="2 1.4"/>`,

  // inspect
  measure: `<rect x="3" y="9" width="18" height="6" rx="0.5"/><line x1="7" y1="9" x2="7" y2="12"/><line x1="11" y1="9" x2="11" y2="12.5"/><line x1="15" y1="9" x2="15" y2="12"/><line x1="19" y1="9" x2="19" y2="12.5"/>`,
  properties: `<rect x="4" y="3" width="16" height="18" rx="1"/><line x1="7" y1="7" x2="17" y2="7"/><line x1="7" y1="11" x2="17" y2="11"/><line x1="7" y1="15" x2="13" y2="15"/>`,
  parameters: `<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="7" cy="17" r="2"/>`,
  section: `<path d="M4 8 L12 4 L20 8 L20 16 L12 20 L4 16 Z"/><line x1="4" y1="8" x2="20" y2="16" stroke-dasharray="2 2"/>`,
  componentColors: `<rect x="3" y="3" width="9" height="9" rx="1"/><rect x="12" y="12" width="9" height="9" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/>`,
  draftAnalysis: `<path d="M5 4 L5 20 L19 20"/><line x1="5" y1="20" x2="17" y2="6"/><polyline points="13,6 17,6 17,10"/>`,
  // The filled lens is the whole point — without it this was pixel-for-pixel the
  // `combine` icon, and the two sit in the same ribbon.
  interference: `<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/><path d="M12 6.8a6 6 0 0 1 0 10.4a6 6 0 0 1 0-10.4z" fill="currentColor" stroke="none"/>`,
  zebra: `<path d="M3 21 L9 3"/><path d="M9 21 L15 3"/><path d="M15 21 L21 3"/>`,
  curvature: `<path d="M3 17 Q12 3 21 17" fill="none"/><line x1="7" y1="11" x2="6" y2="7"/><line x1="12" y1="8" x2="12" y2="3.5"/><line x1="17" y1="11" x2="18" y2="7"/>`,

  // sketch modify
  trim: `<path d="M5 5l6 6"/><path d="M19 5l-6 6"/><path d="M11 13l-6 6"/><circle cx="13" cy="13" r="2"/>`,
  offset: `<rect x="7" y="7" width="10" height="10"/><rect x="3.5" y="3.5" width="17" height="17" stroke-dasharray="2 2"/>`,
  extend: `<line x1="4" y1="12" x2="14" y2="12"/><path d="M14 8l4 4-4 4"/>`,
  fillet: `<path d="M5 4 L5 11 Q5 19 13 19 L20 19 M5 11 L5 19 L13 19" fill="none"/>`,
  break: `<line x1="4" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="20" y2="12"/><line x1="11" y1="7" x2="11" y2="17"/><line x1="13" y1="7" x2="13" y2="17"/>`,

  // modeling create
  sketch: `<path d="M14 4l6 6L9 21l-6 1 1-6z"/><line x1="13" y1="5" x2="19" y2="11"/>`,
  // Axonometric: the sketch profile at the base, the prism it becomes, and the
  // direction of travel. Tested against a flat version at 24px — this one wins
  // because the operation IS the whole shape, so the silhouette carries it.
  extrude: `<path d="M12 13l7 4-7 4-7-4z"/><path d="M5 17v-5l7-4 7 4v5"/><path d="M12 8V2m0 0L9.6 4.4M12 2l2.4 2.4"/>`,
  revolve: `<path d="M12 4v16"/><ellipse cx="12" cy="12" rx="7" ry="3"/><path d="M5 12a7 3 0 0 0 14 0"/>`,
  // Loft: two profiles of different size joined by ruled lines — the ruling is what
  // distinguishes it from a plain tapered solid. Axonometric profiles rather than
  // ellipses, so it reads as two SKETCHES being blended, not a lathe shape.
  loft: `<path d="M12 3l4.5 2.5-4.5 2.5-4.5-2.5z"/><path d="M12 14l7.5 4-7.5 4-7.5-4z"/><path d="M7.5 5.5L4.5 18M16.5 5.5L19.5 18"/>`,
  sweep: `<circle cx="5" cy="18" r="2.4"/><path d="M5 18 C 5 9, 12 6, 20 6" fill="none"/><path d="M16 3l4 3-4 3"/>`,

  // modeling modify
  chamfer: `<path d="M4 20V12l8-8h8" fill="none"/>`,
  mirror: `<line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/><path d="M9 7L4 12l5 5z"/><path d="M15 7l5 5-5 5z"/>`,
  // Press/Pull: the face lifted clear of the body it came from (dashed = where it
  // started). Needs ~32px to be fully legible; at 24 it still reads as "a face
  // moving", which is the essential half.
  presspull: `<path d="M12 13l7 4-7 4-7-4z"/><path d="M5 17v-3M19 17v-3"/><path d="M12 7l7 4-7 4-7-4z" stroke-dasharray="2 2"/><path d="M12 5.5V2.5m0 0L9.9 4.6M12 2.5l2.1 2.1"/>`,
  // body ops: split a body by a plane; boolean-combine bodies
  split: `<rect x="4" y="7" width="16" height="10" rx="0.5"/><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/>`,
  combine: `<circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/>`,
  shell: `<rect x="4" y="4" width="16" height="16" rx="1"/><rect x="8" y="8" width="8" height="8" rx="0.5" stroke-dasharray="2 2"/>`,
  // Draft: the dashed vertical is the untilted reference the angle is measured from.
  // Without it a lone trapezoid reads as a generic taper, not a draft angle.
  draft: `<line x1="7" y1="4" x2="7" y2="20" stroke-dasharray="2 2"/><path d="M7 20L13 4"/><line x1="4" y1="20" x2="20" y2="20"/><path d="M7 9.5a4.5 4.5 0 0 0 2.1-3.9"/>`,
  offsetFace: `<rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 4h12v12" stroke-dasharray="2 2"/><line x1="16" y1="8" x2="20" y2="4"/>`,
  thicken: `<path d="M4 12c4-6 12-6 16 0" fill="none"/><path d="M4 17c4-6 12-6 16 0" fill="none"/><line x1="4" y1="12" x2="4" y2="17"/><line x1="20" y1="12" x2="20" y2="17"/>`,
  texture: `<rect x="4" y="4" width="16" height="16" rx="1"/><line x1="4" y1="9.3" x2="20" y2="9.3"/><line x1="4" y1="14.7" x2="20" y2="14.7"/><line x1="9.3" y1="4" x2="9.3" y2="20"/><line x1="14.7" y1="4" x2="14.7" y2="20"/>`,
  // Solid original + dashed copies. Four equal squares made this a twin of
  // `patternRect`, and it also says which one is the source.
  pattern: `<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1" stroke-dasharray="2 2"/><rect x="3.5" y="14.5" width="6" height="6" rx="1" stroke-dasharray="2 2"/><rect x="14.5" y="14.5" width="6" height="6" rx="1" stroke-dasharray="2 2"/>`,
  // A triangulated patch, not a cube: this used to be indistinguishable from
  // `primitive` and `box`, and it is about MESH density.
  simplifyMesh: `<path d="M4 17.5l4.5-11.5 7.5 3 4 8.5z"/><path d="M8.5 6L16 17.5M4 17.5l12-8.5M16 9l4 8.5"/>`,
  cleanUp: `<path d="M15 4l1.2 2.8L19 8l-2.8 1.2L15 12l-1.2-2.8L11 8l2.8-1.2z"/><path d="M4 20l5-5M7 20.5l3.5-3.5M4 16.5L7.5 13"/>`,
  computeAll: `<path d="M12 4a8 8 0 1 1-7.4 5"/><path d="M4 4v5h5"/>`,
  scale: `<path d="M4 10V4h6"/><path d="M20 14v6h-6"/><rect x="4" y="4" width="10" height="10" rx="0.5"/>`,
  move: `<path d="M12 3v18M3 12h18"/><path d="M12 3l-3 3m3-3l3 3M12 21l-3-3m3 3l3-3M3 12l3-3m-3 3l3 3M21 12l-3-3m3 3l-3 3"/>`,
  rotate: `<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>`,
  copy: `<rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>`,
  // insert / construct
  import: `<path d="M12 3v11m0 0l-4-4m4 4l4-4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>`,
  datumPlane: `<path d="M3 9l9-4 9 4-9 4z"/><line x1="12" y1="13" x2="12" y2="20"/><circle cx="12" cy="20" r="1.4" fill="currentColor"/>`,
  // More than one solid, because it opens a MENU of primitives — and because a
  // lone cube collided with `box` and `simplifyMesh`.
  primitive: `<path d="M9 4l6 3.5v7L9 18l-6-3.5v-7z"/><path d="M3 7.5l6 3.5 6-3.5M9 11v7"/><circle cx="17" cy="16" r="4.5"/>`,

  // file / general
  save: `<path d="M5 4h11l3 3v13H5z"/><rect x="8" y="4" width="6" height="5"/><rect x="8" y="13" width="8" height="5"/>`,
  open: `<path d="M3 7h6l2 2h10v9H3z"/>`,
  export: `<path d="M5 12v7h14v-7"/><path d="M12 15V4m0 0l-3 3m3-3l3 3"/>`,
  check: `<path d="M4 12l5 5L20 6"/>`,
  palette: `<rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/>`,
  offsetPlane: `<path d="M3 8l8-4 10 4-8 4z"/><path d="M3 15l8-4 10 4-8 4z" stroke-dasharray="2 2"/>`,

  // print pipeline
  print: `<path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1"/><rect x="7" y="14" width="10" height="6"/><circle cx="17" cy="12" r="0.9" fill="currentColor"/>`,
  slicer: `<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><path d="M11 14h5m0 0l-2-2m2 2l-2 2"/>`,
  printerSend: `<path d="M6 8V3h9l3 3v2"/><rect x="4" y="8" width="16" height="7" rx="1"/><path d="M8 15h5v6H8z"/><path d="M15 19h6m0 0l-2-2m2 2l-2 2"/>`,

  // sketch constraints
  horizontal: `<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="9" x2="3" y2="15"/><line x1="21" y1="9" x2="21" y2="15"/>`,
  vertical: `<line x1="12" y1="3" x2="12" y2="21"/><line x1="9" y1="3" x2="15" y2="3"/><line x1="9" y1="21" x2="15" y2="21"/>`,
  parallel: `<line x1="6" y1="20" x2="12" y2="4"/><line x1="13" y1="20" x2="19" y2="4"/>`,
  perpendicular: `<path d="M5 4v15h15"/><line x1="5" y1="14" x2="10" y2="14"/><line x1="10" y1="14" x2="10" y2="19"/>`,
  equal: `<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/>`,
  tangent: `<circle cx="9" cy="14" r="5"/><line x1="3" y1="5" x2="21" y2="9"/>`,
  coincident: `<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>`,
  concentric: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>`,
  symmetric: `<line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/>`,
  midpoint: `<line x1="3" y1="12" x2="21" y2="12"/><circle cx="12" cy="12" r="2" fill="currentColor"/>`,
  collinear: `<line x1="3" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="21" y2="12"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>`,
  fix: `<line x1="12" y1="4" x2="12" y2="14"/><path d="M8 4h8"/><path d="M9 14h6l-3 6z" fill="currentColor"/>`,

  // --- solid primitives (timeline / browser tree) ---
  // `primitive` above is the generic insert-menu cube; these three are the specific
  // feature types, drawn so they stay distinguishable at 16px in the timeline.
  box: `<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4"/><line x1="12" y1="12" x2="12" y2="20"/>`,
  cylinder: `<ellipse cx="12" cy="6.5" rx="7" ry="3"/><path d="M5 6.5v11a7 3 0 0 0 14 0v-11" fill="none"/>`,
  sphere: `<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4"/>`,
  body: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/>`,

  // --- destructive / removal ---
  deleteFace: `<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M9 10.5l6 6M15 10.5l-6 6"/>`,
  removeBody: `<path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M6.5 7l1 13h9l1-13"/>`,

  // Text driven onto a face: the plane carries the glyph, which is what separates it
  // from `text` (sketch text, no face involved).
  textOnFace: `<path d="M3 16l9-4.5 9 4.5-9 4.5z"/><path d="M8.5 5h7M12 5v6"/>`,

  // --- browser tree ---
  origin: `<circle cx="12" cy="12" r="1.7" fill="currentColor"/><path d="M12 3v5.5M12 15.5V21M3 12h5.5M15.5 12H21"/>`,
  // Cross lines make it read as a surface. The bare rhombus was so flat it
  // reduced to a sliver at the tree's 15px.
  plane: `<path d="M2.5 9.5L12 4.5l9.5 5-9.5 5z"/><path d="M7.25 7l9.5 5M16.75 7l-9.5 5"/>`,
  assembly: `<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M11 7h4a2 2 0 0 1 2 2v4"/>`,
  printerSync: `<path d="M4 10a8 8 0 0 1 13.2-3.4" fill="none"/><path d="M20 14a8 8 0 0 1-13.2 3.4" fill="none"/><path d="M17.5 3v4h-4M6.5 21v-4h4"/>`,
  eyeOpen: `<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" fill="none"/><circle cx="12" cy="12" r="2.6"/>`,
  // Eye + slash. The old lashes-and-curve version read as a stray X at 14px.
  eyeClosed: `<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" fill="none"/><circle cx="12" cy="12" r="2.6"/><path d="M4 4l16 16"/>`,

  // --- window chrome / controls ---
  close: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  // The three window buttons, drawn to the same 20x20 live area as `close` so
  // the set reads as one row. Deliberately geometric rather than the platform's
  // own glyphs: SindriCAD draws its own title bar on every OS (decorations are
  // off), so a Windows-looking chevron on KDE would be worse than a neutral mark.
  minimize: `<path d="M6.5 12h11"/>`,
  maximize: `<rect x="6.5" y="6.5" width="11" height="11" rx="1"/>`,
  // Restore: the front pane with the one behind it peeking out, the universal
  // "put it back" mark. Two rects, not an overlapping outline, so nothing has to
  // be knocked out at 14px.
  restore: `<rect x="6.5" y="9.5" width="8" height="8" rx="1"/><path d="M9.5 6.5h8v8"/>`,
  undo: `<path d="M4.5 10.5h11a5 5 0 0 1 0 10H9" fill="none"/><path d="M8.5 6.5l-4 4 4 4"/>`,
  redo: `<path d="M19.5 10.5h-11a5 5 0 0 0 0 10H15" fill="none"/><path d="M15.5 6.5l4 4-4 4"/>`,
  stepFirst: `<line x1="6" y1="5" x2="6" y2="19"/><path d="M19 5.5L9.5 12l9.5 6.5z"/>`,
  stepBack: `<path d="M16.5 5.5L7 12l9.5 6.5z"/>`,
  stepFwd: `<path d="M7.5 5.5L17 12l-9.5 6.5z"/>`,
  stepLast: `<line x1="18" y1="5" x2="18" y2="19"/><path d="M5 5.5L14.5 12 5 18.5z"/>`,
  overflow: `<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>`,
  caretDown: `<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>`,
  caretRight: `<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>`,
  arrowRight: `<path d="M4 12h14.5"/><path d="M13.5 7l5 5-5 5"/>`,
  warning: `<path d="M12 3.8L21.2 20H2.8z"/><line x1="12" y1="10" x2="12" y2="14.4"/><circle cx="12" cy="17.3" r="1.1" fill="currentColor"/>`,
  bug: `<path d="M7 11a5 5 0 0 1 10 0v3a5 5 0 0 1-10 0z" fill="none"/><path d="M9 6.8a3 3 0 0 1 6 0"/><path d="M2.5 12H7M17 12h4.5M3.5 7l3 2M20.5 7l-3 2M3.5 18l3-2M20.5 18l-3-2"/>`,
  randomize: `<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="8.4" cy="8.4" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="15.6" cy="15.6" r="1.5" fill="currentColor"/>`,
};

/**
 * Every valid icon name. Typing call sites against this turns a misspelled icon —
 * which used to render as a silent empty <svg> — into a compile error, and keeps
 * untrusted strings (STEP product names) from ever reaching icon().
 */
export type IconName = keyof typeof PATHS;

export function icon(name: IconName): string {
  // aria-hidden + focusable="false": an icon is decorative, and the accessible
  // name belongs to the CONTROL around it. Icon-only controls therefore carry
  // their own aria-label — without one they announce as an empty button, which
  // is exactly what happens if you drop a glyph and add nothing back.
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}
