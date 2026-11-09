import { reviewerLabel, type ReviewerConfig, type ReviewerEntry } from "./reviewers";

/**
 * The settings screen's categories, summaries and saved view state. Pure, so grouping, summaries and persistence are
 * testable without rendering. UI only: every setting keeps its own RPC and storage.
 */

export const SETTINGS_CATEGORIES = [
  { id: "following", title: "Following", icon: "Radar", blurb: "Projects, workspaces, auto-send" },
  { id: "reviewers", title: "Reviewers", icon: "UserCheck", blurb: "Default and per-repo lists" },
  { id: "agents", title: "Agents", icon: "Bot", blurb: "Questions, Overseer, models" },
  { id: "display", title: "Inbox & display", icon: "Inbox", blurb: "Sidebar, pills, Needs-you inbox" },
] as const;
export type SettingsCategory = typeof SETTINGS_CATEGORIES[number]["id"];
export const DEFAULT_CATEGORY: SettingsCategory = "following";
export const isCategory = (v: unknown): v is SettingsCategory => typeof v === "string" && SETTINGS_CATEGORIES.some(c => c.id === v);
export const categoryTitle = (id: SettingsCategory) => SETTINGS_CATEGORIES.find(c => c.id === id)!.title;

/** Per-device view state (web and desktop storage); blocked or missing storage falls back to memory. */
export type KeyValue = { get(key: string): string | null; set(key: string, value: string): void };
const memory = new Map<string, string>();
export const deviceStorage: KeyValue = {
  get(key) { try { const v = (globalThis as { localStorage?: Storage }).localStorage?.getItem(key); if (v != null) return v; } catch { /* memory only */ } return memory.get(key) ?? null; },
  set(key, value) { memory.set(key, value); try { (globalThis as { localStorage?: Storage }).localStorage?.setItem(key, value); } catch { /* memory only */ } },
};
export const CATEGORY_KEY = "follow-up.settings.category";
export const collapseKey = (id: string) => `follow-up.settings.fold.${id}`;
export function readCategory(store: KeyValue = deviceStorage): SettingsCategory {
  const v = store.get(CATEGORY_KEY);
  return isCategory(v) ? v : DEFAULT_CATEGORY;
}
/** Whether a category was ever picked on this device: then the phone reopens inside it, like desktop. */
export const hasSavedCategory = (store: KeyValue = deviceStorage) => isCategory(store.get(CATEGORY_KEY));
export const writeCategory = (id: SettingsCategory, store: KeyValue = deviceStorage) => store.set(CATEGORY_KEY, id);
/** Open or closed as the developer left it; otherwise `fallback` (each section decides its own default). */
export function readOpen(id: string, fallback: boolean, store: KeyValue = deviceStorage): boolean {
  const v = store.get(collapseKey(id));
  return v === "1" ? true : v === "0" ? false : fallback;
}
export const writeOpen = (id: string, open: boolean, store: KeyValue = deviceStorage) => store.set(collapseKey(id), open ? "1" : "0");

const names = (list: readonly ReviewerEntry[], max = 3) => list.length <= max ? list.map(reviewerLabel).join(", ") : `${list.slice(0, max).map(reviewerLabel).join(", ")} +${list.length - max}`;
/** Anything saved: then Reviewers starts collapsed, since it's set up. */
export const reviewersConfigured = (config: Pick<ReviewerConfig, "defaults" | "repos">) => config.defaults.length > 0 || Object.values(config.repos).some(l => l.length > 0);
/** "3 own lists · default: Uri, Yuval", "No lists yet". Counts repositories with their own list. */
export function reviewersSummary(config: Pick<ReviewerConfig, "defaults" | "repos">): string {
  const own = Object.values(config.repos).filter(l => l.length > 0).length;
  const parts = [own ? `${own} own list${own === 1 ? "" : "s"}` : "", config.defaults.length ? `default: ${names(config.defaults)}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No lists yet; Add reviewers opens a picker";
}
/** The folded Repositories block: "3 own lists · 2 on the default". */
export function reposSummary(repos: readonly string[], config: Pick<ReviewerConfig, "repos">): string {
  const own = repos.filter(r => (config.repos[r] ?? []).length > 0).length;
  const rest = repos.length - own;
  return [own ? `${own} own list${own === 1 ? "" : "s"}` : "", rest ? `${rest} on the default` : ""].filter(Boolean).join(" · ") || "None yet";
}
/** One repository's collapsed line: its names, or what it falls back to. */
export function repoSummary(list: readonly ReviewerEntry[], defaults: readonly ReviewerEntry[]): string {
  if (list.length) return names(list);
  return defaults.length ? `Uses the default (${names(defaults, 2)})` : "Nobody; opens the picker";
}

export type WorkspaceSetting = { id: string; title: string; enable_tracking: boolean; enable_auto_sends: boolean; optedOut: boolean; dormant?: boolean; parked?: boolean };
/** Differs from the defaults: not followed, or auto-send unlike the default (resting auto-send pauses don't count). */
export const isException = (w: WorkspaceSetting, autoDefault: boolean) => w.optedOut || !w.enable_tracking || (!w.parked && w.enable_auto_sends !== autoDefault);
/** The Workspaces list: matches for the query (title words), exceptions first, then by title; capped, with the rest counted. */
export function workspaceRows(all: readonly WorkspaceSetting[], autoDefault: boolean, query: string, cap = 25): { rows: WorkspaceSetting[]; hidden: number; total: number; exceptions: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = all.filter(w => words.every(q => w.title.toLowerCase().includes(q)));
  // Exceptions first, then active before resting, then by title. While searching, every match shows.
  const rank = (w: WorkspaceSetting) => isException(w, autoDefault) ? 0 : w.dormant ? 2 : 1;
  const sorted = [...matched].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  const limit = words.length ? sorted.length : cap;
  return { rows: sorted.slice(0, limit), hidden: Math.max(0, sorted.length - limit), total: matched.length, exceptions: all.filter(w => isException(w, autoDefault)).length };
}
export function workspaceState(w: WorkspaceSetting): string {
  if (w.optedOut || !w.enable_tracking) return "Not followed";
  return (w.enable_auto_sends ? "Followed · sends repairs automatically" : "Followed · repairs wait for you") + (w.parked ? " · paused while resting" : w.dormant ? " · resting" : "");
}
/** "120 workspaces · 3 exceptions". */
export function workspacesSummary(all: readonly WorkspaceSetting[], autoDefault: boolean): string {
  const ex = all.filter(w => isException(w, autoDefault)).length;
  return `${all.length} workspace${all.length === 1 ? "" : "s"} · ${ex ? `${ex} exception${ex === 1 ? "" : "s"}` : "no exceptions"}`;
}
/** "18 of 22 followed", "All 22 followed". */
export function projectsSummary(projects: readonly { enable_default_tracking: boolean }[]): string {
  const on = projects.filter(p => p.enable_default_tracking).length;
  return on === projects.length ? `All ${projects.length} followed` : `${on} of ${projects.length} followed`;
}
/** Projects start folded past six; Workspaces start folded unless something is an exception. */
export const projectsOpenByDefault = (count: number) => count <= 6;
export const workspacesOpenByDefault = (exceptions: number) => exceptions > 0;
/** The Following tab's line: "Following every workspace · 3 exceptions · auto-send on". */
export function followingSummary(d: { enable_follow_every: boolean; enable_auto_sends_default: boolean; workspaces: readonly WorkspaceSetting[] }): string {
  const ex = d.workspaces.filter(w => isException(w, d.enable_auto_sends_default)).length;
  return [d.enable_follow_every ? "Following every workspace" : "Following chosen projects", ex ? `${ex} exception${ex === 1 ? "" : "s"}` : "no exceptions", `auto-send ${d.enable_auto_sends_default ? "on" : "off"}`].join(" · ");
}
