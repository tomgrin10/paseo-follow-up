import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "./text";
import { FoldRow, focusRing, type Theme } from "./kit";
import { PAGE, pageInfo, pageLabel, pageSpoken, type PageInfo } from "../shared/paged";

/**
 * Every list that grows with use draws through here (invariant pr-scale-lists-batch-not-throw, "every list pages"):
 * folded it shows `preview` rows and "Show all N"; opened it shows one page of `size` rows with the pager
 * ("26–50 of 312", Previous, Next, Show less), never every row. A search pages its hits from the first page and has
 * no fold. The same on desktop and phone; the pager's buttons are plain buttons, so Tab reaches them and Enter or
 * Space presses them. 2026-11-26, Tom: "Show all" on a busy workspace lagged, then made the sidebar scroll for ever.
 *
 * Adopting it: keep the list's own rows and fold state; pass every item (or a server page's `total`, `Pager`).
 */
export type Paged<T> = { shown: T[]; footer: ReactNode; info: PageInfo | null };

export function usePagedList<T>({ items, open, onToggle, searching = false, resetKey = "", preview = PAGE.preview, size = PAGE.size, theme, compact, icon = "List", noun }: {
  items: readonly T[];
  /** The list's own fold state ("Show all" pressed). */
  open: boolean; onToggle: () => void;
  /** A search is narrowing the list: page its hits, no fold. */
  searching?: boolean;
  /** Anything that changes what the list is (a tab, the query): back to the first page. */
  resetKey?: string;
  preview?: number; size?: number; theme: Theme; compact: boolean; icon?: string;
  /** What a row is, for the spoken pager ("questions"). */
  noun?: string;
}): Paged<T> {
  const [state, setState] = useState({ key: resetKey, page: 0 });
  const page = state.key === resetKey ? state.page : 0;
  const setPage = (p: number) => setState({ key: resetKey, page: p });
  const c = theme.colors;
  if (!searching && !open) {
    const footer = items.length > preview ? <FoldRow theme={theme} compact={compact} open={false} onPress={onToggle} icon={icon} iconColor={c.foregroundMuted} label={`Show all ${items.length}`} /> : null;
    return { shown: items.slice(0, preview), footer, info: null };
  }
  const info = pageInfo(items.length, page, size);
  const shown = items.slice(info.from, info.to);
  const footer = info.pages > 1 || (!searching && items.length > preview)
    ? <Pager theme={theme} compact={compact} info={info} onPage={setPage} onLess={searching ? undefined : () => { setPage(0); onToggle(); }} noun={noun} />
    : null;
  return { shown, footer, info };
}

/** The pager row: Show less on the left; Previous, "26–50 of 312", Next on the right. A server-paged list draws it with its own PageInfo. */
export function Pager({ theme, compact, info, onPage, onLess, noun, busy = false }: { theme: Theme; compact: boolean; info: PageInfo; onPage: (page: number) => void; onLess?: () => void; noun?: string; busy?: boolean }) {
  const c = theme.colors;
  const size = compact ? 44 : 28;
  const arrow = (iconName: string, label: string, to: number, enabled: boolean) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !enabled }} aria-disabled={!enabled}
    disabled={!enabled} onPress={() => onPage(to)} hitSlop={compact ? 0 : 4}
    style={state => ({ width: size, height: size, borderRadius: 6, alignItems: "center", justifyContent: "center", opacity: enabled ? 1 : 0.35,
      backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered && enabled ? c.surface1 : "transparent", ...focusRing((state as { focused?: boolean }).focused, c) })}>
    <Icon name={iconName} size={15} color={c.foregroundMuted} />
  </Pressable>;
  const spoken = `${pageSpoken(info)}${noun ? ` ${noun}` : ""}, page ${info.page + 1} of ${info.pages}`;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: compact ? 8 : 6, paddingVertical: compact ? 2 : 4, minHeight: compact ? 48 : 36, borderTopWidth: 1, borderTopColor: c.border }}>
    {onLess && <Pressable accessibilityRole="button" accessibilityLabel="Show less" onPress={onLess} hitSlop={compact ? 0 : 4}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: size, paddingHorizontal: 8, borderRadius: 6,
        backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent", ...focusRing((state as { focused?: boolean }).focused, c) })}>
      <Icon name="ChevronUp" size={14} color={c.foregroundMuted} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontWeight: "600" }}>Show less</Text>
    </Pressable>}
    <View style={{ flex: 1 }} />
    {info.pages > 1 && <>
      {arrow("ChevronLeft", "Previous page", info.page - 1, info.page > 0 && !busy)}
      <Text accessibilityLabel={spoken} accessibilityLiveRegion="polite" aria-live="polite" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"], minWidth: 72, textAlign: "center", opacity: busy ? 0.6 : 1 }}>{pageLabel(info)}</Text>
      {arrow("ChevronRight", "Next page", info.page + 1, info.page < info.pages - 1 && !busy)}
    </>}
  </View>;
}
