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
    // The "Needs you N" header item hides at zero unless this is on.
    enable_inbox_header_when_empty: z.boolean().default(false),
    // D6: a merged or closed PR flags its agent at the lowest priority.
    enable_inbox_pr_closed: z.boolean().default(true) }),
});

export const displayRpc = settingsRpc(displayPreferences.id);
