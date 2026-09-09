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

/** True while an IME is mid-composition — the state a Japanese, Chinese or
 *  Korean user is in for most of the keystrokes they type.
 *
 *  Every keystroke that reaches the app during composition belongs to the IME,
 *  not to the app: Escape CANCELS the conversion, Enter CONFIRMS it, and the
 *  arrow keys move through the candidate list. A handler that acts on those
 *  keys anyway closes the dialog, commits a half-typed name, or drops the tool
 *  out from under the person typing. So every keyboard handler asks this first.
 *
 *  Two signals, because no single one is reliable across the engines we ship on
 *  (WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows):
 *   - `isComposing` is the spec answer, true from compositionstart until after
 *     compositionend — including on the keydown that ends the composition.
 *   - keyCode 229 is what an engine reports for a key it handed to the IME
 *     ("key" reads "Process" there); some engines set it without ever setting
 *     `isComposing` on that event.
 *  Neither is a superset of the other, so both are checked.
 *
 *  Takes a structural type rather than KeyboardEvent so a test can pass a plain
 *  object, and so a `keypress`/`keyup` event works too. */
export function isImeComposing(e: { isComposing?: boolean; keyCode?: number } | null): boolean {
  if (!e) return false;
  return e.isComposing === true || e.keyCode === 229;
}
