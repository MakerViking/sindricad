// Recent-files list for the welcome screen. Display concern → localStorage
// (same convention as sindri.activePrinter); paths are not secrets. Newest
// first, deduped by path, capped.

const KEY = "sindri.recentFiles";
const MAX = 10;

export interface RecentFile {
  path: string;
  openedAt: number; // ms since epoch
}

export function getRecentFiles(): RecentFile[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.filter(
      (r): r is RecentFile => !!r && typeof r.path === "string" && typeof r.openedAt === "number",
    );
  } catch {
    return [];
  }
}

export function noteRecent(path: string): void {
  const rest = getRecentFiles().filter((r) => r.path !== path);
  const next = [{ path, openedAt: Date.now() }, ...rest].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
}

/** Drop an entry (e.g. the file no longer exists on disk). */
export function forgetRecent(path: string): void {
  const next = getRecentFiles().filter((r) => r.path !== path);
  localStorage.setItem(KEY, JSON.stringify(next));
}
