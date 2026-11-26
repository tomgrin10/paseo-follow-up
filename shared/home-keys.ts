/**
 * Home's keys (desktop and web), the one list the keys sheet draws (client/home.tsx `HomeKeysSheet`). The handlers are
 * the list walk (`listMove`, shared/list-keys.ts), the search field and Search from anywhere; a letter Catch up also
 * uses does the same thing here (O opens the chat, S shows the keys).
 */
export const HOME_KEYS: readonly { key: string; what: string; when?: "search" | "pane"; combos?: readonly string[] }[] = [
  { key: "↑ ↓ / J K", what: "Move through the list" },
  { key: "Home / End", what: "First or last row" },
  { key: "↵ / O", what: "Open the selected workspace's chat" },
  { key: "Double-click", what: "Open a workspace's chat" },
  { key: "S", what: "Show the keys" },
  { key: "/", what: "Search", when: "search" },
  { key: "↑ / ↓", what: "Move through the results", when: "search" },
  { key: "↵", what: "Show the result; ↵ again opens its chat", when: "search" },
  { key: "Esc", what: "Clear the search, then leave it", when: "search" },
  { key: "⌘↵", what: "Send the answer you're writing", when: "pane", combos: ["Cmd+Enter", "Ctrl+Enter"] },
];
