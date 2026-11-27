import { reviewerLabel, type ReviewerConfig, type ReviewerEntry } from "./reviewers";
import { NEW_OF, NEW_WORK } from "./new-name";
import { SETUP_CLOSED_KEY } from "./setup-popup";

/**
 * The settings screen's categories, summaries and saved view state. Pure, so grouping, summaries and persistence are
 * testable without rendering. UI only: every setting keeps its own RPC and storage.
 */

export const SETTINGS_CATEGORIES = [
  // First and the default on a device that never picked one: setup, the installed version and its updates.
  { id: "general", title: "General", icon: "Settings2", blurb: "Updates, setup, version" },
  { id: "following", title: "Following", icon: "Radar", blurb: "Projects, workspaces, auto-send" },
  { id: "reviewers", title: "Reviewers", icon: "UserCheck", blurb: "Default and per-repo lists" },
  { id: "agents", title: "Agents", icon: "Bot", blurb: "Questions, Overseer, models" },
  { id: "new", title: NEW_WORK, icon: "SquarePlus", blurb: `${NEW_OF} actions, where work goes, bases` },
  { id: "display", title: "Inbox & display", icon: "Inbox", blurb: "Sidebar, pills, Needs-you inbox" },
  // Was Morning brief: the one place for what sets the developer's priorities (one-place-for-priority-inputs). The id
  // stays, so saved links and screen ids land here.
  { id: "brief", title: "Compass", icon: "Compass", blurb: "What sets your priorities, this week's plan" },
] as const;
export type SettingsCategory = typeof SETTINGS_CATEGORIES[number]["id"];
export const DEFAULT_CATEGORY: SettingsCategory = "general";
export const isCategory = (v: unknown): v is SettingsCategory => typeof v === "string" && SETTINGS_CATEGORIES.some(c => c.id === v);
export const categoryTitle = (id: SettingsCategory) => SETTINGS_CATEGORIES.find(c => c.id === id)!.title;

/**
 * Per-device view state: the settings category, its section folds, Home's group folds and What's new "seen"
 * (`view-state-is-per-device-settings-are-per-host`). On Paseo 0.16 these live in the device settings document
 * `follow-up-view` (client/view-store.ts sets it as the backend once it loads; on the phone that is native storage that
 * survives reopening the app). Until then, and on 0.15, web and desktop storage (localStorage), else memory. Reads take
 * the document's value when it has one, else the localStorage cache, so the first paint never flashes the default;
 * writes go to both while the localStorage cache is kept (one release after 2.1's device settings).
 * Anything an agent can set (Display, home_sort) stays host-scoped and never comes here.
 */
export type KeyValue = { get(key: string): string | null; set(key: string, value: string): void };
const memory = new Map<string, string>();
let backend: KeyValue | null = null;
const viewListeners = new Set<() => void>();
let viewVersion = 0;
/**
 * Writes made while the document is still loading (`writes-while-loading-reach-the-document`): a surface opened at
 * start-up (a settings tab straight from a link, a fold) writes before the document arrives, and the document's older
 * value must not win over it. They are replayed into the document when it arrives. A value merely cached from an
 * earlier session is not one of them, so the document still wins over that.
 */
const pending = new Map<string, string>();
/** Swap in (or out, with null) the device document behind deviceStorage; re-renders whatever reads view state. */
export function setDeviceBackend(next: KeyValue | null) {
  backend = next;
  if (next) { status = "ready"; for (const [key, value] of pending) next.set(key, value); }
  pending.clear();
  viewChanged();
}
/** none: this host keeps no device document (0.15). loading: expected, not loaded yet. ready / failed. */
export type ViewStatus = "none" | "loading" | "ready" | "failed";
let status: ViewStatus = "none";
export const viewStatus = (): ViewStatus => status;
export function setViewStatus(next: ViewStatus) { if (status !== next) { status = next; viewChanged(); } }
export function viewChanged() { viewVersion++; for (const l of viewListeners) l(); }
export const subscribeView = (l: () => void) => { viewListeners.add(l); return () => { viewListeners.delete(l); }; };
export const viewSnapshot = () => viewVersion;
const local = {
  get(key: string): string | null { try { const v = (globalThis as { localStorage?: Storage }).localStorage?.getItem(key); if (v != null) return v; } catch { /* memory only */ } return memory.get(key) ?? null; },
  set(key: string, value: string) { memory.set(key, value); try { (globalThis as { localStorage?: Storage }).localStorage?.setItem(key, value); } catch { /* memory only */ } },
};
export const deviceStorage: KeyValue = {
  get(key) { return backend?.get(key) ?? local.get(key); },
  set(key, value) { local.set(key, value); if (backend) backend.set(key, value); else if (status === "loading") pending.set(key, value); viewChanged(); },
};
/** The localStorage cache alone: what a device migrates into its document once. */
export const localViewStorage: KeyValue = local;
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
/**
 * The workspace panel's sections, each with its own fold id (client/fold.tsx, invariant 132, panel-sections-fold): the
 * same id in every workspace, so a fold is the developer's choice for that section on this device. A new section
 * joins this list (tests/panel-folds.test.ts).
 */
export const PANEL_FOLDS = {
  needs: "panel.needs",
  questions: "panel.questions",
  messages: "panel.messages",
  prs: "panel.prs",
  tasks: "panel.tasks",
  activity: "panel.activity",
  workspace: "panel.workspace",
  /** The agent card's Recent steps (and its reply box): open by default, folded by default in the side panel. */
  steps: "panel.steps",
  /** What an agent shows (client/shown-cards.tsx): one fold per card, `panel.card.<id>`; a card a week old starts folded. */
  cards: "panel.card",
} as const;
export type PanelFold = keyof typeof PANEL_FOLDS;

/**
 * Home's group folds persist per device, except Needs you: it always opens on mount, because asks are the one thing
 * the developer must not miss behind a fold made days ago (closing it holds only for this mount). Quiet starts closed.
 */
export const homeFoldKey = (group: string) => `follow-up.home.fold.${group}`;
export const homeGroupOpen = (group: string, store: KeyValue = deviceStorage): boolean => {
  if (group === "needs") return true;
  const v = store.get(homeFoldKey(group));
  return v === "1" ? true : v === "0" ? false : group !== "quiet" && group !== "older";
};
export const writeHomeGroupOpen = (group: string, open: boolean, store: KeyValue = deviceStorage) => { if (group !== "needs") store.set(homeFoldKey(group), open ? "1" : "0"); };
/** Every key that is view state: what a device copies into its document the first time (never home_sort). */
// Setup's Close (shared/setup-popup.ts) is this device's: a put-away popup stays away after a reload.
export const isViewKey = (key: string) => key === CATEGORY_KEY || key.startsWith("follow-up.settings.fold.") || (key.startsWith("follow-up.home.fold.") && key !== homeFoldKey("needs")) || key === "follow-up.whats-new.seen" || key === SETUP_CLOSED_KEY;

const names = (list: readonly ReviewerEntry[], max = 3) => list.length <= max ? list.map(reviewerLabel).join(", ") : `${list.slice(0, max).map(reviewerLabel).join(", ")} +${list.length - max}`;
/** Anything saved: then Reviewers starts collapsed, since it's set up. */
export const reviewersConfigured = (config: Pick<ReviewerConfig, "defaults" | "repos">) => config.defaults.length > 0 || Object.values(config.repos).some(l => l.length > 0);
/** "3 own lists · default: Omar, Lena", "No lists yet". Counts repositories with their own list. */
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
