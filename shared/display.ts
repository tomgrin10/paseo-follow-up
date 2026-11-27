import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_SORT, isSortMode, SORT_MODES, type SortMode } from "./sort";
import { homeViewSchema, parseHomeView, type HomeView } from "./home-arrange";
import { DEFAULT_SEARCH_SHORTCUT, NEW_SHORTCUTS, SEARCH_SHORTCUTS } from "./search-key";

/** Home's right pane as a share of Home's width: the default and the range set_display and the divider accept. */
export const HOME_DETAIL_DEFAULT = 0.42;
export const HOME_DETAIL_MIN = 0.2;
export const HOME_DETAIL_MAX = 0.8;
/** Catch up's queue rail on desktop (side-panes-are-resizable): its share of the width. */
export const CATCH_UP_RAIL_DEFAULT = 0.28;
export const CATCH_UP_RAIL_MIN = 0.16;
export const CATCH_UP_RAIL_MAX = 0.5;

/** Where opening a workspace lands (Display `open_workspace_on`): its workspace view's tab, or its main agent's chat. */
export const OPEN_WORKSPACE_ON = ["view", "chat"] as const;
export type OpenWorkspaceOn = typeof OPEN_WORKSPACE_ON[number];
export const DEFAULT_OPEN_WORKSPACE_ON: OpenWorkspaceOn = "view";

/**
 * Where a picked row opens (Display `open_workspace_on`, invariant 135): a row with a workspace opens it on its
 * workspace view's tab (the default) or its agent's chat; Cmd/Ctrl-click opens the other one. A row with no workspace
 * opens its chat.
 */
export function rowOpens(row: { agentId: string | null; workspaceId: string | null }, setting: OpenWorkspaceOn | undefined, modified: boolean): "view" | "chat" | null {
  if (!row.workspaceId) return row.agentId ? "chat" : null;
  const want = setting ?? DEFAULT_OPEN_WORKSPACE_ON;
  const pick = modified ? (want === "view" ? "chat" : "view") : want;
  return pick === "chat" && !row.agentId ? "view" : pick;
}

export const displayPreferences = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  // Fields only ever gain defaults, so documents saved by older versions keep parsing unchanged.
  schema: z.object({ enable_header_button: z.boolean().default(true), showSidebar: z.boolean().default(true), enable_composer_pill: z.boolean().default(true),
    // Needs-you inbox (beta). Off means nothing flags and no pill or header item shows.
    enable_inbox: z.boolean().default(true),
    // 1.2.0-beta.1 removed "Show the sidebar item at zero" (enable_inbox_header_when_empty): the one Follow-up
    // item always shows and hides only its badge at zero. zod drops the old key on read, so saved documents parse.
    // D6: a merged or closed PR flags its agent at the lowest priority.
    enable_inbox_pr_closed: z.boolean().default(true),
    // R2: Claude Code root agents that end a turn without needs_you are asked once to state what you need.
    enable_brief_nudge: z.boolean().default(true),
    // 1.4.0-beta.0: the Overseer row on Home and its per-turn digest. Off never archives an existing Overseer.
    enable_overseer: z.boolean().default(true),
    // 1.4.0-beta.0: the ranker behind Home's Priority sort (Linear, Slack, GitHub reviews, the CPO's plan).
    enable_ranker: z.boolean().default(true),
    // Trust bypass agents: a plain tool permission from an agent whose current mode is bypassPermissions (Claude) or
    // full-access (Codex) is approved automatically. Off restores the prompt.
    enable_trust_bypass: z.boolean().default(true),
    // 2.1: Home's and the sidebar view's order, one setting for both, on the host so it follows the developer across
    // devices and set_display covers it. Absent until first chosen: the first client to load writes the order it kept
    // per device before (client/home-view.ts), then everyone reads it from here.
    home_sort: z.enum(SORT_MODES).optional(),
    // 2.5: how Home and the sidebar view arrange their rows (shared/home-arrange.ts): Grouping, Title, Show, the Project
    // and Labels filters and Show background, the choices of Paseo's own sidebar menu. One value for both lists.
    home_view: homeViewSchema.optional(),
    // 2.1: the share of Home's width the right pane (the brief or the selected item) takes, set by dragging the divider
    // (client/split.tsx). A fraction, so it carries across window sizes; absent means HOME_DETAIL_DEFAULT.
    home_detail_fraction: z.number().min(HOME_DETAIL_MIN).max(HOME_DETAIL_MAX).optional(),
    // 2.2: the share of Catch up's width its queue rail takes on desktop (client/catch-up.tsx, client/split.tsx).
    // Absent means CATCH_UP_RAIL_DEFAULT.
    catch_up_rail_fraction: z.number().min(CATCH_UP_RAIL_MIN).max(CATCH_UP_RAIL_MAX).optional(),
    // 2.1: the key that opens Home with the cursor in its search from anywhere in Paseo (shared/search-key.ts).
    // Absent means DEFAULT_SEARCH_SHORTCUT (⌘⇧K or Ctrl+Shift+K); "none" turns it off.
    // The retired preset must not invalidate the entire saved Display document.
    search_shortcut: z.preprocess(value => value === "mod-slash" ? DEFAULT_SEARCH_SHORTCUT : value, z.enum(SEARCH_SHORTCUTS).optional()),
    /** New from anywhere (docs/dispatch.md); absent: ⌘⇧N in Paseo's desktop app, ⌘⇧O in a browser tab. */
    new_shortcut: z.enum(NEW_SHORTCUTS).optional(),
    // 2.4: the sidebar's New row (client/new-entry.tsx). Off removes the row; New stays on Home, in ⌘K and on its key
    // (new-row-is-optional). Settings → New work and setup's tour show it; set_display sets it.
    enable_new_sidebar_row: z.boolean().default(true),
    // 2.x (invariant 135): what opening a workspace from Follow-up's sidebar list (and Home's Open) shows: its
    // workspace view as a tab in the main area ("view", the default when absent) or its main agent's chat ("chat").
    open_workspace_on: z.enum(OPEN_WORKSPACE_ON).optional() }),
});

/** Every Display key, set or not: what set_display accepts. */
export const DISPLAY_KEYS = Object.keys(displayPreferences.schema.shape);

export const displayRpc = settingsRpc(displayPreferences.id);

/** "3 prompts approved today · latest Bash: cd repo && git status". Nothing until the first approval. */
export function trustCountText(stats: { today: number; recent: { summary: string }[] } | undefined): string | null {
  if (!stats) return null;
  // On but unused reads differently from loading or failed (both blank).
  if (!stats.today && !stats.recent.length) return "None approved yet";
  const count = stats.today ? `${stats.today} ${stats.today === 1 ? "prompt" : "prompts"} approved today` : "None approved today";
  const last = stats.recent[0]?.summary;
  return `${count}${last ? ` · latest ${last}` : ""}`;
}

/** Anything that calls plugin RPCs (the client context; a fake in tests). */
export type DisplayClient = { rpc: (contract: never, input: never) => Promise<unknown> };

/**
 * Merges `patch` into the Display document, re-reading once when another write got there first. Every client write
 * of a Display field goes through here (Home's order, Home's pane width), so one never drops another's field.
 * True when it saved.
 */
export async function writeDisplay(client: DisplayClient, patch: Record<string, unknown>): Promise<boolean> {
  const call = (contract: unknown, input: unknown) => client.rpc(contract as never, input as never);
  for (let attempt = 0; attempt < 2; attempt++) {
    const doc = await call(displayRpc.read, {}) as { status: string; revision: string; values: unknown };
    if (doc.status !== "ready") return false;
    const out = await call(displayRpc.write, { revision: doc.revision, values: { ...(doc.values as Record<string, unknown>), ...patch } }) as { status: string };
    if (out.status !== "conflict") return out.status === "saved";
  }
  return false;
}
/**
 * Home's order against the Display setting `home_sort`. `read` takes the host's order (true when it changed this
 * device's); with none stored yet, this device's old per-device choice becomes everyone's, once. `write` saves an
 * order, re-reading once when another write got there first.
 */
export function homeSortSync(client: DisplayClient, current: () => SortMode, adopt: (sort: SortMode) => void, view?: { current: () => HomeView; adopt: (v: HomeView) => void }) {
  const call = (contract: unknown, input: unknown) => client.rpc(contract as never, input as never);
  const write = async (next: SortMode) => { await writeDisplay(client, { home_sort: next }); };
  /** Applies a Display document (read, or pushed by follow.display-feed): true when this device's order or view changed. */
  const apply = async (doc: { status: string; values?: unknown }): Promise<boolean> => {
    if (doc.status !== "ready") return false;
    const values = doc.values as { home_sort?: unknown; home_view?: unknown };
    let stored = values.home_sort;
    let storedView = values.home_view === undefined ? undefined : parseHomeView(values.home_view);
    // "By project" was a sort until 2.5; it is Grouping › Project now, with Priority inside each project.
    const legacy = legacyProjectSort(values);
    if (legacy) { stored = legacy.home_sort; storedView = legacy.home_view; await writeDisplay(client, legacy); }
    let changed = false;
    if (view && storedView && JSON.stringify(storedView) !== JSON.stringify(view.current())) { view.adopt(storedView); changed = true; }
    if (!isSortMode(stored)) { if (current() !== DEFAULT_SORT) await write(current()); return changed; }
    changed = changed || stored !== current();
    adopt(stored);
    return changed;
  };
  const read = async (): Promise<boolean> => apply(await call(displayRpc.read, {}) as { status: string; values: unknown });
  return { read, write, apply };
}

/** A saved `home_sort: "project"` (before 2.5) as the patch that replaces it: Grouping › Project, Priority inside. */
export function legacyProjectSort(values: { home_sort?: unknown; home_view?: unknown }): { home_sort: SortMode; home_view: HomeView } | null {
  if (values.home_sort !== "project") return null;
  return { home_sort: DEFAULT_SORT, home_view: { ...parseHomeView(values.home_view), grouping: "project" } };
}
