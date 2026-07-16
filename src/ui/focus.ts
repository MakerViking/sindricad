/** True when a keyboard event targets a text-entry field — inputs, textareas,
 *  selects, or contentEditable — so global/tool keyboard shortcuts must NOT fire
 *  (otherwise typing "T" in a field would trigger the Text tool, etc.). */
export function isEditableTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}
