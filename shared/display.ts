import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
    enable_trust_bypass: z.boolean().default(true) }),
});

export const displayRpc = settingsRpc(displayPreferences.id);

/** "3 approved today · last: Bash: cd repo && git status". Nothing until the first approval. */
export function trustCountText(stats: { today: number; recent: { summary: string }[] } | undefined): string | null {
  if (!stats || (!stats.today && !stats.recent.length)) return null;
  const last = stats.recent[0]?.summary;
  return `${stats.today} approved today${last ? ` · last: ${last}` : ""}`;
}
