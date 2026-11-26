import { useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
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

export function usePagedList<T>({ items, open = true, onToggle, searching = false, resetKey = "", follow, preview = PAGE.preview, size = PAGE.size, theme, compact, icon = "List", noun }: {
  items: readonly T[];
  /**
   * The list's own fold state ("Show all" pressed) and its toggle. Without `onToggle` the list has no fold of its own
   * (a card that folds whole, a settings section): it pages from the first row, with no Show all or Show less.
   */
  open?: boolean; onToggle?: () => void;
  /** A search is narrowing the list: page its hits, no fold. */
  searching?: boolean;
  /** Anything that changes what the list is (a tab, the query): back to the first page. */
  resetKey?: string;
  /** A row the list keeps in view (Catch up's card on screen): a reset lands on its page, not the first. */
  follow?: number;
  preview?: number; size?: number; theme: Theme; compact: boolean; icon?: string;
  /** What a row is, for the spoken pager ("questions"). */
  noun?: string;
}): Paged<T> {
  const [state, setState] = useState({ key: resetKey, page: 0 });
  const page = state.key === resetKey ? state.page : follow !== undefined && follow >= 0 ? Math.floor(follow / size) : 0;
  const setPage = (p: number) => setState({ key: resetKey, page: p });
  const c = theme.colors;
  const folds = !!onToggle && !searching;
  if (folds && !open) {
    const footer = items.length > preview ? <FoldRow theme={theme} compact={compact} open={false} onPress={onToggle!} icon={icon} iconColor={c.foregroundMuted} label={`Show all ${items.length}`} /> : null;
    return { shown: items.slice(0, preview), footer, info: null };
  }
  const info = pageInfo(items.length, page, size);
  const shown = items.slice(info.from, info.to);
  const footer = info.pages > 1 || (folds && items.length > preview)
    ? <Pager theme={theme} compact={compact} info={info} onPage={setPage} onLess={folds ? () => { setPage(0); onToggle!(); } : undefined} noun={noun} />
    : null;
  return { shown, footer, info };
}

/** The pager row: Show less on the left; Previous, "26–50 of 312", Next on the right. A server-paged list draws it with its own PageInfo. */
export function Pager({ theme, compact, info, onPage: setPage, onLess, noun, busy = false }: { theme: Theme; compact: boolean; info: PageInfo; onPage: (page: number) => void; onLess?: () => void; noun?: string; busy?: boolean }) {
  const c = theme.colors;
  const self = useRef<View>(null);
  // A new page starts at its first row: when the list's top has scrolled out of view (a long page, the pager at the
  // bottom), bring it back, or the reader lands at the end of the page they asked for.
  const onPage = (to: number) => { setPage(to); if (Platform.OS === "web") setTimeout(() => toListStart(self.current as unknown as El | null), 0); };
  const size = compact ? 44 : 28;
  const arrow = (iconName: string, label: string, to: number, enabled: boolean) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !enabled }} aria-disabled={!enabled}
    disabled={!enabled} onPress={() => onPage(to)} hitSlop={compact ? 0 : 4}
    style={state => ({ width: size, height: size, borderRadius: 6, alignItems: "center", justifyContent: "center", opacity: enabled ? 1 : 0.35,
      backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered && enabled ? c.surface1 : "transparent", ...focusRing((state as { focused?: boolean }).focused, c) })}>
    <Icon name={iconName} size={15} color={c.foregroundMuted} />
  </Pressable>;
  const spoken = `${pageSpoken(info)}${noun ? ` ${noun}` : ""}, page ${info.page + 1} of ${info.pages}`;
  return <View ref={self} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: compact ? 8 : 6, paddingVertical: compact ? 2 : 4, minHeight: compact ? 48 : 36, borderTopWidth: 1, borderTopColor: c.border }}>
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

/** The few DOM calls toListStart makes (react-native-web hands a View's ref its element; the client has no DOM lib). */
type El = { parentElement: El | null; getBoundingClientRect(): { top: number }; scrollIntoView?(o: { block: "start" }): void };

/** Scroll the pager's list (its parent) to its top when that top sits above its scroll container's view (web only). */
function toListStart(pager: El | null) {
  const list = pager?.parentElement;
  const style = (globalThis as { getComputedStyle?(e: El): { overflowY: string } }).getComputedStyle;
  if (!list || !style) return;
  let box: El | null = list.parentElement;
  while (box && !/(auto|scroll)/.test(style(box).overflowY)) box = box.parentElement;
  const top = box ? box.getBoundingClientRect().top : 0;
  if (list.getBoundingClientRect().top < top) list.scrollIntoView?.({ block: "start" });
}

/**
 * A list drawn inside a condition or a fold (a settings section, a sheet): its rows and pager as one element, so it
 * pages without a hook in its parent. `row` gets the item and its index in the whole list.
 */
export function PagedRows<T>({ items, row, ...opts }: { items: readonly T[]; row: (item: T, index: number) => ReactNode } & Omit<Parameters<typeof usePagedList<T>>[0], "items">) {
  const page = usePagedList({ items, ...opts });
  const from = page.info?.from ?? 0;
  return <>{page.shown.map((x, i) => row(x, from + i))}{page.footer}</>;
}
