import { useRef, useState, type ReactNode } from "react";
import { View, type StyleProp, type TextInput, type TextStyle } from "react-native";
import { Text } from "./text";
import { excerpt, filterItems, type ItemField, type ItemHit, type Range } from "../shared/search";
import { matchCount, noMatchLine, queryFor, SECTION_PLACEHOLDER, type SectionId, type SectionQuery } from "../shared/section-search";
import { QueryField } from "./home-chrome";
import { RichText } from "./rich-text";
import { focusSoon, IconButton, text, type Theme } from "./kit";

/**
 * Section search (the workspace panel's Pull requests, Tasks and Activity): a search icon at the right of the header;
 * pressing it turns the header into the shared QueryField with "n of N" and ✕. It filters with the matcher every
 * workspace search uses (`filterItems`, invariant one-ranking-for-every-workspace-search) and keeps the list's order.
 * While a query is typed the section's folds are ignored. Esc or ✕ closes it; another workspace starts closed.
 * No key binding: Ctrl/Cmd+F stays the browser's find.
 */
export type SectionSearch<T> = {
  /** The typed query, or null while closed (the field may be open and still empty: "" is not searching). */
  query: string | null;
  /** Every item that matches and how, or null while not searching (no query): the section draws as usual. */
  hits: Map<T, ItemHit> | null;
  /** The Card's header while open, else undefined. */
  header: ReactNode | undefined;
  /** The search icon for the header's right slot; null while open. */
  button: ReactNode;
};

export function useSectionSearch<T>(workspaceId: string, section: SectionId, { theme, compact, items, fields, remote }: {
  theme: Theme; compact: boolean;
  /** Every item of the section, folded ones included, in the order the section draws them. */
  items: readonly T[];
  fields: (item: T) => readonly ItemField[];
  /** The section searches on the worker (a paged list, follow.activity): no local matching, and "n of N" from its answer. */
  remote?: { matches: number; total: number } | null;
}): SectionSearch<T> {
  const [state, setState] = useState<SectionQuery>(null);
  const inputRef = useRef<TextInput | null>(null);
  const query = queryFor(state, workspaceId);
  const placeholder = SECTION_PLACEHOLDER[section];
  const buttonId = `follow-section-search-${section}`;
  const close = () => { setState(null); focusSoon(buttonId); };
  const results = query === null || remote !== undefined ? null : filterItems(items, fields, query);
  const hits = results ? new Map(results.map(r => [r.item, r.hit])) : null;
  const header = query === null ? undefined : <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: compact ? 4 : 6, marginVertical: -4 }}>
    <QueryField theme={theme} value={query} onChange={q => setState({ workspaceId, query: q })} placeholder={placeholder} icon="Search" dense={compact}
      inputRef={inputRef} slashHint={false} autoFocus onEscape={close} count={results ? matchCount(results.length, items.length) : remote && query?.trim() ? matchCount(remote.matches, remote.total) : ""} />
    <IconButton icon="X" label={`Close ${placeholder.toLowerCase()}`} onPress={close} theme={theme} compact={compact} />
  </View>;
  const button = query === null ? <IconButton nativeID={buttonId} icon="Search" label={placeholder} tooltip onPress={() => setState({ workspaceId, query: "" })} theme={theme} compact={compact} /> : null;
  return { query, hits, header, button };
}

/** A shown field inside a pressable row, its matched words in the hit style: RichText, inert (`plain`), like the row's own title. */
export function Marked({ text: body, ranges, theme, style, numberOfLines }: { text: string; ranges: Range[] | undefined; theme: Theme; style: StyleProp<TextStyle>; numberOfLines?: number }) {
  return <RichText plain numberOfLines={numberOfLines} style={style} marks={{ ranges: ranges ?? [], colors: theme.colors }}>{body}</RichText>;
}

/** Line 2 for a hit only in a hidden field: "Evidence · …the upload over 10 MB…". */
export function ViaLine({ via, theme, compact }: { via: NonNullable<ItemHit["via"]>; theme: Theme; compact: boolean }) {
  const t = text(theme.colors, compact);
  const cut = excerpt(via.text.replace(/\s/g, " "), via.ranges, 48, 12);
  return <Text numberOfLines={1} style={t.meta}>{via.label} · <RichText plain style={t.meta} marks={{ ranges: cut.ranges, colors: theme.colors }}>{cut.text}</RichText></Text>;
}

/** "No tasks match ‘zebra’": the section's one line when nothing matches. */
export function NoMatchRow({ section, query, theme, compact }: { section: SectionId; query: string; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ paddingHorizontal: compact ? 14 : 12, paddingVertical: compact ? 14 : 10, borderTopWidth: 1, borderTopColor: c.border }}>
    <Text accessibilityLiveRegion="polite" style={t.meta}>{noMatchLine(section, query)}</Text>
  </View>;
}
