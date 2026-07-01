// Minimal stroke icons (24×24, currentColor) for the Fusion-style ribbon.
// Each entry is the inner SVG markup; icon() wraps it.

const PATHS: Record<string, string> = {
  // sketch create
  line: `<line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="1.6" fill="currentColor"/><circle cx="20" cy="4" r="1.6" fill="currentColor"/>`,
  rectangle: `<rect x="4" y="6" width="16" height="12" rx="0.5"/>`,
  circle: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1" fill="currentColor"/>`,
  arc: `<path d="M4 19 A 14 14 0 0 1 20 11"/><circle cx="4" cy="19" r="1.5" fill="currentColor"/><circle cx="20" cy="11" r="1.5" fill="currentColor"/>`,
  spline: `<path d="M3 17 C 7 5, 11 5, 13 12 S 19 19, 21 7" fill="none"/><circle cx="3" cy="17" r="1.5" fill="currentColor"/><circle cx="13" cy="12" r="1.5" fill="currentColor"/><circle cx="21" cy="7" r="1.5" fill="currentColor"/>`,
  polygon: `<polygon points="12,3 20,9 17,19 7,19 4,9"/>`,
  point: `<circle cx="12" cy="12" r="2.2" fill="currentColor"/>`,
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

  // inspect
  measure: `<rect x="3" y="9" width="18" height="6" rx="0.5"/><line x1="7" y1="9" x2="7" y2="12"/><line x1="11" y1="9" x2="11" y2="12.5"/><line x1="15" y1="9" x2="15" y2="12"/><line x1="19" y1="9" x2="19" y2="12.5"/>`,
  properties: `<rect x="4" y="3" width="16" height="18" rx="1"/><line x1="7" y1="7" x2="17" y2="7"/><line x1="7" y1="11" x2="17" y2="11"/><line x1="7" y1="15" x2="13" y2="15"/>`,
  section: `<path d="M4 8 L12 4 L20 8 L20 16 L12 20 L4 16 Z"/><line x1="4" y1="8" x2="20" y2="16" stroke-dasharray="2 2"/>`,
  componentColors: `<rect x="3" y="3" width="9" height="9" rx="1"/><rect x="12" y="12" width="9" height="9" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/>`,
  draftAnalysis: `<path d="M5 4 L5 20 L19 20"/><line x1="5" y1="20" x2="17" y2="6"/><polyline points="13,6 17,6 17,10"/>`,
  interference: `<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>`,
  zebra: `<path d="M3 21 L9 3"/><path d="M9 21 L15 3"/><path d="M15 21 L21 3"/>`,
  curvature: `<path d="M3 17 Q12 3 21 17" fill="none"/><line x1="7" y1="11" x2="6" y2="7"/><line x1="12" y1="8" x2="12" y2="3.5"/><line x1="17" y1="11" x2="18" y2="7"/>`,

  // sketch modify
  trim: `<path d="M5 5l6 6"/><path d="M19 5l-6 6"/><path d="M11 13l-6 6"/><circle cx="13" cy="13" r="2"/>`,
  offset: `<rect x="7" y="7" width="10" height="10"/><rect x="3.5" y="3.5" width="17" height="17" stroke-dasharray="2 2"/>`,
  extend: `<line x1="4" y1="12" x2="14" y2="12"/><path d="M14 8l4 4-4 4"/>`,
  fillet: `<path d="M4 20 L4 10 A 10 10 0 0 1 14 10 L20 10" fill="none"/>`,
  break: `<line x1="4" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="20" y2="12"/><line x1="11" y1="7" x2="11" y2="17"/><line x1="13" y1="7" x2="13" y2="17"/>`,

  // modeling create
  sketch: `<path d="M14 4l6 6L9 21l-6 1 1-6z"/><line x1="13" y1="5" x2="19" y2="11"/>`,
  extrude: `<rect x="4" y="13" width="10" height="7"/><path d="M9 11V4m0 0l-3 3m3-3l3 3"/>`,
  revolve: `<path d="M12 4v16"/><ellipse cx="12" cy="12" rx="7" ry="3"/><path d="M5 12a7 3 0 0 0 14 0"/>`,
  loft: `<path d="M4 18h16M7 8h10M4 18l3-10M20 18L17 8"/>`,
  sweep: `<circle cx="5" cy="18" r="2.4"/><path d="M5 18 C 5 9, 12 6, 20 6" fill="none"/><path d="M16 3l4 3-4 3"/>`,

  // modeling modify
  chamfer: `<path d="M4 20V12l8-8h8" fill="none"/>`,
  mirror: `<line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/><path d="M9 7L4 12l5 5z"/><path d="M15 7l5 5-5 5z"/>`,
  presspull: `<path d="M4 16l6-3 8 3-6 3z" fill="none"/><path d="M10 13V4m0 0l-3 3m3-3l3 3"/>`,
  // body ops: split a body by a plane; boolean-combine bodies
  split: `<rect x="4" y="7" width="16" height="10" rx="0.5"/><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/>`,
  combine: `<circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/>`,
  shell: `<rect x="4" y="4" width="16" height="16" rx="1"/><rect x="8" y="8" width="8" height="8" rx="0.5" stroke-dasharray="2 2"/>`,
  draft: `<path d="M7 20l4-16h2l4 16z" fill="none"/><line x1="5" y1="20" x2="19" y2="20"/>`,
  pattern: `<rect x="4" y="4" width="5" height="5"/><rect x="15" y="4" width="5" height="5"/><rect x="4" y="15" width="5" height="5"/><rect x="15" y="15" width="5" height="5"/>`,
  simplifyMesh: `<polygon points="12,3 21,8 21,16 12,21 3,16 3,8"/><path d="M3 8l9 5 9-5M12 13v8"/>`,
  scale: `<path d="M4 10V4h6"/><path d="M20 14v6h-6"/><rect x="4" y="4" width="10" height="10" rx="0.5"/>`,
  move: `<path d="M12 3v18M3 12h18"/><path d="M12 3l-3 3m3-3l3 3M12 21l-3-3m3 3l3-3M3 12l3-3m-3 3l3 3M21 12l-3-3m3 3l-3 3"/>`,
  // insert / construct
  import: `<path d="M12 3v11m0 0l-4-4m4 4l4-4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>`,
  datumPlane: `<path d="M3 9l9-4 9 4-9 4z"/><line x1="12" y1="13" x2="12" y2="20"/><circle cx="12" cy="20" r="1.4" fill="currentColor"/>`,
  primitive: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><line x1="12" y1="12" x2="12" y2="21"/>`,

  // file / general
  save: `<path d="M5 4h11l3 3v13H5z"/><rect x="8" y="4" width="6" height="5"/><rect x="8" y="13" width="8" height="5"/>`,
  open: `<path d="M3 7h6l2 2h10v9H3z"/>`,
  export: `<path d="M5 12v7h14v-7"/><path d="M12 15V4m0 0l-3 3m3-3l3 3"/>`,
  check: `<path d="M4 12l5 5L20 6"/>`,
  palette: `<rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/>`,
  offsetPlane: `<path d="M3 8l8-4 10 4-8 4z"/><path d="M3 15l8-4 10 4-8 4z" stroke-dasharray="2 2"/>`,

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
};

export function icon(name: string): string {
  const p = PATHS[name] ?? "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
