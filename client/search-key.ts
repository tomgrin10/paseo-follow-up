import { Platform } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { isDesktopApp, isMac, matchesShortcut, newShortcutPreset, searchShortcutOf, shortcutLabel, type KeyEventLike, type NewShortcut, type SearchShortcut } from "../shared/search-key";
import { displayValues, subscribeDisplay } from "./display";
import { requestSearch } from "./search-focus";
import type { SearchFocus } from "../shared/search-focus";

type DomKey = KeyEventLike & { target?: { closest?(selector: string): unknown } | null; preventDefault(): void; stopPropagation(): void };

/**
 * Code editors keep their own keys: Paseo 0.16's file editor (CodeMirror) binds Mod-/ to toggle comment, so with the
 * cursor in one the key does what the editor says.
 */
export const EDITOR_SELECTOR = ".cm-editor, .monaco-editor";
type Win = {
  navigator?: { platform?: string; userAgent?: string };
  document?: { addEventListener(t: "keydown", f: (e: DomKey) => void, capture?: boolean): void; removeEventListener(t: "keydown", f: (e: DomKey) => void, capture?: boolean): void };
};

/** The current key and its label, kept in step with the Display setting; listeners hear every change. */
export function createSearchKey() {
  let preset: SearchShortcut = searchShortcutOf(undefined);
  const listeners = new Set<() => void>();
  const set = (next: unknown) => { const p = searchShortcutOf(next); if (p === preset) return; preset = p; for (const l of listeners) l(); };
  return {
    preset: () => preset,
    label: () => shortcutLabel(preset, isMac()),
    set,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type SearchKey = ReturnType<typeof createSearchKey>;

/**
 * New from anywhere's key (`new_shortcut`): unset means the host's default, ⌘⇧N in Paseo's desktop app and ⌘⇧O in a
 * browser tab (Chrome keeps Ctrl/Cmd+Shift+N for a new incognito window and never hands it to the page). A pick wins
 * everywhere.
 */
export function createNewKey(desktop = isDesktopApp()) {
  let preset: NewShortcut = newShortcutPreset(undefined, desktop);
  const listeners = new Set<() => void>();
  const set = (next: unknown) => { const p = newShortcutPreset(next, desktop); if (p === preset) return; preset = p; for (const l of listeners) l(); };
  return {
    preset: () => preset,
    label: () => shortcutLabel(preset, isMac()),
    set,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type NewKey = ReturnType<typeof createNewKey>;

/**
 * Search from anywhere (every-shortcut-is-configurable-and-never-paseo-s): one document listener, web and desktop
 * only, in the capture phase so it works with focus in a text field (it's a chord, like ⌘K). On a match it opens Home
 * (or stays there) and asks Home's search for the cursor; anything else passes through untouched. The key is the
 * Display setting `search_shortcut`, read once at start and then from the Display feed or poll. Inside a code editor
 * the key stays the editor's (EDITOR_SELECTOR). New from anywhere (`extra`) is matched by the same listener.
 */
export function installSearchShortcut(client: PluginClientContext, key: SearchKey, open: { screenId: string; focus: SearchFocus }, extra?: { key: NewKey; open: () => void }): () => void {
  const win = globalThis as Win;
  const doc = win.document;
  if (Platform.OS !== "web" || !doc) return () => undefined;
  const mac = isMac();
  let live = true;
  // The Display store's copy (client/display.tsx: the feed, or its poll on 0.15), never a read of its own
  // (one-read-per-key-at-mount): the values it already has, then every change.
  const now = displayValues(); if (now) { key.set(now.search_shortcut); extra?.key.set(now.new_shortcut); }
  const offDisplay = subscribeDisplay(values => { key.set(values.search_shortcut); extra?.key.set(values.new_shortcut); });
  const onKey = (e: DomKey) => {
    // New from anywhere shares this one listener (every-shortcut-is-configurable-and-never-paseo-s).
    if (extra && matchesShortcut(e, extra.key.preset(), mac) && !e.target?.closest?.(EDITOR_SELECTOR)) { e.preventDefault(); e.stopPropagation(); extra.open(); return; }
    if (!matchesShortcut(e, key.preset(), mac) || e.target?.closest?.(EDITOR_SELECTOR)) return;
    e.preventDefault(); e.stopPropagation();
    // every-search-request-lands-in-the-visible-search: one request, held until the developer acts; Home opens unless
    // its search is on screen, and the search field that comes on screen takes the caret.
    requestSearch(open.focus, () => client.openScreen({ screenId: open.screenId }));
  };
  doc.addEventListener("keydown", onKey, true);
  return () => { live = false; offDisplay(); doc.removeEventListener("keydown", onKey, true); };
}
