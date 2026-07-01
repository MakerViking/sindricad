// Escape a string for safe interpolation into HTML text or an attribute value.
// Use for ANY value sourced from a loaded document (body/sketch/plane names,
// palette slots, import filenames) before placing it into innerHTML/markup.
// Defence-in-depth alongside the CSP: stops stored-XSS payloads carried in a
// crafted .sindri from executing in the privileged webview.
const RE = /[&<>"'`=]/g;
const MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;",
};

export const esc = (s: unknown): string =>
  String(s ?? "").replace(RE, (c) => MAP[c] ?? c);
