// Shared plumbing for panels whose text inputs commit on change and which
// re-render from store doc subscriptions.

/** Text input that commits on change: `commit` returns an error message to
 *  show (input turns red, keeps the rejected text so the user can fix it) or
 *  null on success. Typing clears the error state. */
export function validatedInput(value: string, commit: (raw: string) => string | null, title = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  if (title) input.title = title;
  input.addEventListener("input", () => input.classList.remove("input-error"));
  input.addEventListener("change", () => {
    const err = commit(input.value.trim());
    if (err) {
      input.classList.add("input-error");
      input.title = err;
    }
  });
  return input;
}

/** Wrap a panel's render for its doc subscription so a refresh (async commits
 *  landing, undo, load) never clobbers an edit in progress inside `root`.
 *  Focus alone is the wrong guard (commits land async while the panel keeps
 *  focus); track uncommitted KEYSTROKES instead: typing sets the flag, the
 *  change event (Enter/blur = commit or revert) clears it. */
export function keystrokeGuard(root: HTMLElement, render: () => void): () => void {
  let editing = false;
  root.addEventListener("input", () => (editing = true), true);
  root.addEventListener("change", () => (editing = false), true);
  return () => {
    if (!editing) render();
  };
}
