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

  // modeling modify
  chamfer: `<path d="M4 20V12l8-8h8" fill="none"/>`,
  mirror: `<line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/><path d="M9 7L4 12l5 5z"/><path d="M15 7l5 5-5 5z"/>`,

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
};

export function icon(name: string): string {
  const p = PATHS[name] ?? "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
