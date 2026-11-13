import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_SORT, isSortMode, SORT_MODES, type SortMode } from "./sort";

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
    home_sort: z.enum(SORT_MODES).optional() }),
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
type DisplayClient = { rpc: (contract: never, input: never) => Promise<unknown> };
/**
 * Home's order against the Display setting `home_sort`. `read` takes the host's order (true when it changed this
 * device's); with none stored yet, this device's old per-device choice becomes everyone's, once. `write` saves an
 * order, re-reading once when another write got there first.
 */
export function homeSortSync(client: DisplayClient, current: () => SortMode, adopt: (sort: SortMode) => void) {
  const call = (contract: unknown, input: unknown) => client.rpc(contract as never, input as never);
  const write = async (next: SortMode) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const doc = await call(displayRpc.read, {}) as { status: string; revision: string; values: unknown };
      if (doc.status !== "ready") return;
      const out = await call(displayRpc.write, { revision: doc.revision, values: { ...(doc.values as Record<string, unknown>), home_sort: next } }) as { status: string };
      if (out.status !== "conflict") return;
    }
  };
  /** Applies a Display document (read, or pushed by follow.display-feed): true when this device's order changed. */
  const apply = async (doc: { status: string; values?: unknown }): Promise<boolean> => {
    if (doc.status !== "ready") return false;
    const stored = (doc.values as { home_sort?: unknown }).home_sort;
    if (!isSortMode(stored)) { if (current() !== DEFAULT_SORT) await write(current()); return false; }
    const changed = stored !== current();
    adopt(stored);
    return changed;
  };
  const read = async (): Promise<boolean> => apply(await call(displayRpc.read, {}) as { status: string; values: unknown });
  return { read, write, apply };
}
