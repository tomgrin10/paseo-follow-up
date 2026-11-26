/**
 * What the developer sees Dispatch called (docs/dispatch.md#the-name): the dialog, the sidebar row, ⌘K, Home's
 * button, Settings and every message that names it. It was "New" until 2.4 (Q160); internal ids (`follow.dispatch`,
 * the `dispatch` tool, the Settings id `new`) never changed. Every user-facing string builds from these, so a rename is
 * a change here and nowhere else; tests/new-row.test.ts fails on a literal name anywhere else.
 */
export const NEW_NAME = "Dispatch" as const;
/** "Dispatch's actions". */
export const NEW_OF = `${NEW_NAME}'s` as const;
/** The Settings tab and the agent role that starts Dispatch's work. */
export const NEW_WORK = NEW_NAME;
/** Words people who learned the old name still type in ⌘K. */
export const OLD_NAMES = ["new"] as const;

/** The sidebar row's switch (Display `enable_new_sidebar_row`), in Settings → Dispatch. One copy for every place it shows. */
export const NEW_ROW = {
  label: `${NEW_NAME} in the sidebar`,
  hint: (key: string | null, palette = "⌘K") => `A row at the top of the sidebar that opens ${NEW_NAME}. Off: ${NEW_NAME} stays on Home${key ? `, under ${key}` : ""} and in ${palette}.`,
  /**
   * Paseo's own "New workspace" row sits beside it and does less (an empty workspace, no issue or action). Paseo
   * 0.17 keeps which sidebar rows show per device in its own settings and gives plugins no way to change them or to
   * open that page (docs/dispatch.md#paseos-new-workspace), so this names the place instead of a button.
   */
  /** Setup's tour: the same tip as one line (Q163). */
  paseoShort: "To hide Paseo's own New workspace row, switch it off in Paseo Settings → Sidebar → Header.",
  paseo: `Paseo's own New workspace row starts an empty workspace; ${NEW_NAME} starts one from an issue, a PR or your words. To hide Paseo's row, switch off New workspace in Paseo Settings → Sidebar → Header, on each device.`,
} as const;
