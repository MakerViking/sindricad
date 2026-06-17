// The single owner of the #prompt banner. Any tool that wants to show a
// transient instruction routes through here so there's one convention.

const el = () => document.getElementById("prompt");

export function setPrompt(text: string | null) {
  const p = el();
  if (!p) return;
  if (text) {
    p.textContent = text;
    p.classList.remove("hidden");
  } else {
    p.classList.add("hidden");
  }
}
