/** What the Browser calls a sketch: the name it was given, or `Sketch<n>` by its
 *  place `i` among the document's sketches. A message that sends the user to a
 *  sketch names it the same way, so it names a row they can find: the
 *  lost-projection warning used to say "f5", the sketch's internal id. */
export function sketchLabel(f: { name?: string }, i: number): string {
  return f.name || `Sketch${i + 1}`;
}
