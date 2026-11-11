import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View, type TextInput as NativeTextInput } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { linkedIndexRpc, linkedItemsRpc, setLinkedItemsRpc } from "../shared/contracts";
import type { LinkedKind, LinkedView, LinkedViewItem } from "../shared/linked";
import type { Workspace } from "../shared/model";
import { CHIP_MAX, LINKED_EMPTY, linkedChip, linkedGroups, linkedRow, linkedSpec, pasteToAdd, referencesShown, type LinkedChipModel, type RowGlyph } from "../shared/linked-display";
import { BRAND_ICONS } from "./brand-icons";
import { Button, CardRow, IconButton, errorText, space, text, type Theme } from "./kit";
import { Skeleton } from "./motion";
import { SpecChip, SpecSheet } from "./spec";
import type { Colors } from "./theme";

/**
 * Linked items on screen (design §5): the references line (Spec and Linked chips) under the Summary, the Linked
 * sheet, and the "Linked items" row in the panel's disclosure. Copy, order, folding and paste-to-add are pure, in
 * shared/linked-display.ts; this file only draws them.
 */

export const linkedKey = (workspaceId: string) => ["follow-through", "linked", workspaceId] as const;
export const linkedIndexKey = ["follow-through", "linked-index"] as const;

/** One workspace's linked view. Read when a surface showing it mounts, then kept a minute; never polled. */
export function useLinked(workspaceId: string) {
  const read = useRpc(linkedItemsRpc);
  return useQuery({ queryKey: linkedKey(workspaceId), queryFn: () => read({ workspaceId }), staleTime: 60_000 });
}

/**
 * Home's search index of linked keys and titles. Home's hot path stays as it was: the list's poll never touches
 * linked.json. This one small read happens only while the search field has text, and its answer is kept for a minute,
 * so typing doesn't refetch. A server-side cached index would be fresher but would need invalidation on every link
 * change; a read on demand needs none.
 */
export function useLinkedIndex(searching: boolean): Record<string, { key: string; kind: LinkedKind; title: string | null }[]> | undefined {
  const read = useRpc(linkedIndexRpc);
  return useQuery({ queryKey: linkedIndexKey, queryFn: () => read({}), enabled: searching, staleTime: 60_000 }).data?.workspaces;
}

const openUrl = (url: string) => { void openExternalUrl(url).catch(() => undefined); };
const hovered = (state: unknown) => !!(state as { hovered?: boolean }).hovered;

/** A brand mark, lucide File or Link, or a Linear state glyph. Hidden from screen readers: the text says it all. */
export function LinkedGlyph({ glyph, colors: c, size }: { glyph: RowGlyph | { type: "kind"; kind: LinkedKind }; colors: Colors; size: number }) {
  let g: RowGlyph;
  if (glyph.type === "kind") {
    const k = glyph.kind;
    g = k === "linear" ? { type: "brand", icon: "linear" } : k === "slack" ? { type: "brand", icon: "slack" } : k === "artifact" ? { type: "brand", icon: "claude" }
      : k === "issue" ? { type: "brand", icon: "github" } : k === "doc" ? { type: "lucide", name: "File" } : { type: "lucide", name: "Link" };
  } else g = glyph;
  const hide = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const };
  if (g.type === "brand") return <View {...hide}><Icon icon={BRAND_ICONS[g.icon]} size={size} color={c.foregroundMuted} /></View>;
  if (g.type === "lucide") return <View {...hide}><Icon name={g.name} size={size} color={c.foregroundMuted} /></View>;
  const state = { todo: ["CircleDashed", c.foregroundMuted], active: ["Contrast", c.foreground], done: ["CircleCheck", c.statusSuccess], cancelled: ["CircleSlash", c.foregroundMuted] }[g.tone];
  return <View {...hide}><Icon name={state[0]} size={size} color={state[1]} /></View>;
}

/**
 * The Linked chip: the Spec chip's anatomy (hairline pill, 24px plus hit slop on desktop, 36 plus slop on phones), one
 * mark and count per kind, then +N. No status colour and no arrow: it opens an in-app list.
 */
export function LinkedChip({ model, theme, compact, onPress }: { model: LinkedChipModel; theme: Theme; compact: boolean; onPress: () => void }) {
  const c = theme.colors;
  // 14 on both: at 12 the Linear mark's stripes blur into a blob.
  const mark = 14;
  const count = { color: c.foreground, fontSize: 12, lineHeight: 16, fontWeight: "600" as const, fontVariant: ["tabular-nums" as const] };
  // The desktop tooltip: React Native Web drops `title` on a Pressable, so it goes on the DOM node itself.
  const ref = useRef<View | null>(null);
  useEffect(() => { if (Platform.OS === "web") (ref.current as unknown as { setAttribute?: (k: string, v: string) => void } | null)?.setAttribute?.("title", model.tooltip); }, [model.tooltip]);
  return <Pressable ref={ref} accessibilityRole="button" accessibilityLabel={model.label} onPress={onPress} hitSlop={compact ? 4 : 6}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 36 : 24, paddingHorizontal: compact ? 10 : 8, borderRadius: 999, borderWidth: 1, borderColor: c.border,
      backgroundColor: state.pressed ? c.surface2 : hovered(state) ? c.surface1 : "transparent" })}>
    {model.parts.map(p => <View key={p.kind} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <LinkedGlyph glyph={{ type: "kind", kind: p.kind }} colors={c} size={mark} />
      <Text style={count}>{p.count}</Text>
    </View>)}
    {model.more > 0 && <Text style={[count, { color: c.foregroundMuted }]}>+{model.more}</Text>}
  </Pressable>;
}

/**
 * The Linked sheet plus the spec sheet its spec row edits, as one unit any surface can host. `open(focus)` shows the
 * list; "Edit spec link…" swaps to the spec sheet (one modal at a time).
 */
export function useLinkedSheets(workspace: Workspace, theme: Theme, compact: boolean): { open: () => void; editSpec: () => void; element: ReactNode } {
  const [which, setWhich] = useState<"linked" | "spec" | null>(null);
  // Mounted on first open and kept (so closing still animates): a panel hosts this twice (references line and the
  // disclosure row), and a surface that's never opened mounts no sheet at all.
  const [used, setUsed] = useState(false);
  useEffect(() => { if (which) setUsed(true); }, [which]);
  const element = (used || which) && <>
    <LinkedSheet workspace={workspace} theme={theme} compact={compact} open={which === "linked"} onClose={() => setWhich(null)} onEditSpec={() => setWhich("spec")} />
    <SpecSheet workspace={workspace} open={which === "spec"} theme={theme} compact={compact} onClose={() => setWhich(null)} />
  </>;
  return { open: () => setWhich("linked"), editSpec: () => setWhich("spec"), element };
}

/**
 * The references line: the Spec chip (moved out of the title row, so it never jumps) and the Linked chip. Nothing at
 * all when there's no spec and nothing linked, so such a panel looks exactly as before. Phones too:
 * it wraps under the Summary, never in the 44px bar (which can't hold it beside Home and settings at 390pt).
 */
export function ReferencesLine({ workspace: w, theme, compact }: { workspace: Workspace; theme: Theme; compact: boolean }) {
  const query = useLinked(w.id);
  const sheets = useLinkedSheets(w, theme, compact);
  const counts = query.data?.counts as LinkedView["counts"] | undefined;
  if (!referencesShown(w.spec?.url, counts)) return sheets.element;
  const model = linkedChip(counts, compact ? CHIP_MAX.phone : CHIP_MAX.desktop);
  return <>
    <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 6 : 8, flexWrap: "wrap", marginTop: 2 }}>
      {!!w.spec?.url && <SpecChip workspace={w} theme={theme} compact={compact} />}
      {model && <LinkedChip model={model} theme={theme} compact={compact} onPress={sheets.open} />}
    </View>
    {sheets.element}
  </>;
}

/** The way in when nothing is linked: a row in "Spec, agent and recovery", under the spec row. */
export function LinkedItemsRow({ workspace: w, theme, compact }: { workspace: Workspace; theme: Theme; compact: boolean }) {
  const t = text(theme.colors, compact);
  const query = useLinked(w.id);
  const sheets = useLinkedSheets(w, theme, compact);
  const model = linkedChip(query.data?.counts as LinkedView["counts"] | undefined, 6);
  const line = query.error ? `Couldn't load: ${errorText(query.error)}` : query.isPending ? "Loading…" : model ? model.tooltip : "None yet. Agents link the issues and threads they start from.";
  return <CardRow theme={theme} compact={compact}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
        <Text style={t.label}>Linked items</Text>
        <Text numberOfLines={2} style={t.meta}>{line}</Text>
      </View>
      <Button theme={theme} compact={compact} icon={model ? "List" : "Plus"} title={model ? "Open" : "Add"}
        accessibilityLabel={model ? "Open linked items" : "Add a linked item"} onPress={sheets.open} />
    </View>
    {sheets.element}
  </CardRow>;
}

type Removed = { key: string; label: string };

/** The list: one field (filter, or paste a link or key to add), groups by kind, row menus, and Undo for a removal. */
export function LinkedSheet({ workspace: w, theme, compact, open, onClose, onEditSpec }: { workspace: Workspace; theme: Theme; compact: boolean; open: boolean; onClose: () => void; onEditSpec: () => void }) {
  const c = theme.colors; const t = text(c, compact); const sp = space(compact);
  const query = useLinked(w.id);
  const cache = useQueryClient(); const toast = useToast();
  const write = useRpc(setLinkedItemsRpc);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<LinkedKind>>(new Set());
  const [doneOpen, setDoneOpen] = useState<ReadonlySet<LinkedKind>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const field = useRef<NativeTextInput | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (open) { setFilter(""); setError(null); setNote(null); setMenu(null); setRemoved(null); } }, [open]);
  // Undo waits while the pointer or focus is on it, and a little longer on phones.
  const [holdUndo, setHoldUndo] = useState(false);
  useEffect(() => { if (!removed || holdUndo) return; const id = setTimeout(() => setRemoved(null), compact ? 8000 : 6000); return () => clearTimeout(id); }, [removed, holdUndo, compact]);
  // Desktop focuses the field; phones don't, so the keyboard doesn't cover the list.
  useEffect(() => { if (open && !compact) { const id = setTimeout(() => field.current?.focus(), 50); return () => clearTimeout(id); } }, [open, compact]);
  const settle = (view: LinkedView) => {
    cache.setQueryData(linkedKey(w.id), view);
    void cache.invalidateQueries({ queryKey: linkedIndexKey });
  };
  const run = useMutation({
    mutationFn: (input: { action: "add" | "remove" | "undo"; ref: string; label?: string }) => write({ workspaceId: w.id, action: input.action, ref: input.ref }),
    onMutate: () => { setError(null); setNote(null); },
    onSuccess: ({ message, ...view }, input) => {
      settle(view as LinkedView);
      if (input.action === "add") { setFilter(""); if (message) setNote(message); else toast.show(`Linked ${input.label ?? input.ref}`, { variant: "success" }); }
      if (input.action === "remove") setRemoved({ key: input.ref, label: input.label ?? input.ref });
      if (input.action === "undo") { setRemoved(null); if (message) setNote(message); }
    },
    onError: (e, input) => { if (input.action === "add") setError(errorText(e)); else toast.error(errorText(e)); },
  });
  const items = (query.data?.items ?? []) as LinkedViewItem[];
  const paste = pasteToAdd(filter, items);
  const groups = useMemo(() => linkedGroups(items, { query: paste ? "" : filter, expanded }), [items, filter, expanded, paste]);
  // The spec stands alone above the groups: the chip doesn't count it, so it sits under no head.
  const spec = linkedSpec(items, paste ? "" : filter);
  const add = () => { if (paste?.action === "add" && !run.isPending) run.mutate({ action: "add", ref: paste.ref, label: paste.label }); };
  const toggle = (set: ReadonlySet<LinkedKind>, kind: LinkedKind) => { const next = new Set(set); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; };
  const gutter = sp.gutter + (compact ? 0 : 8);
  const quiet = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontWeight: "600" as const, fontVariant: ["tabular-nums" as const] };

  return <Modal title="Linked" icon={<Icon name="Link" size={18} color={c.foregroundMuted} />} open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ paddingHorizontal: 0, paddingTop: compact ? 4 : 8, paddingBottom: compact ? 16 : 20, gap: 0 }}>
      <View style={{ paddingHorizontal: gutter, paddingBottom: 10, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 34, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1,
          borderColor: error ? c.statusDanger : focused ? c.foregroundMuted : c.border, backgroundColor: c.surface1 }}>
          <Icon name="Search" size={compact ? 16 : 14} color={c.foregroundMuted} />
          <TextInput ref={field} accessibilityLabel="Filter, or paste a link or key" placeholder="Filter, or paste a link or key" placeholderTextColor={c.foregroundMuted}
            value={filter} onChangeText={v => { setFilter(v); setError(null); setNote(null); }} onSubmitEditing={add} blurOnSubmit={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} autoCapitalize="none" autoCorrect={false} returnKeyType={paste?.action === "add" ? "done" : "search"}
            style={[t.body, { flex: 1, minWidth: 0, paddingVertical: 6, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : null) }]} />
          {!!filter && <IconButton theme={theme} compact={compact} icon="X" label="Clear" onPress={() => { setFilter(""); setError(null); field.current?.focus(); }} />}
        </View>
        {error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{error}</Text>}
        {note && <Text accessibilityLiveRegion="polite" style={t.meta}>{note}</Text>}
      </View>

      {/* Host toasts can't carry an action, so Undo lives in the sheet for 6 s (8 on phones; held while hovered or focused), like Home's undo bar,
          right under the field so it's on screen however far the list scrolled. */}
      {removed && <View accessibilityLiveRegion="polite" {...({ onMouseEnter: () => setHoldUndo(true), onMouseLeave: () => setHoldUndo(false), onFocus: () => setHoldUndo(true), onBlur: () => setHoldUndo(false) } as object)} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: gutter, marginBottom: 10, paddingLeft: 12, paddingRight: 4, paddingVertical: 4,
        borderRadius: 8, backgroundColor: c.surface2 }}>
        <Text numberOfLines={1} style={[t.meta, { flex: 1, color: c.foreground }]}>Removed {removed.label}</Text>
        <Button theme={theme} compact={compact} kind="ghost" icon="Undo2" title="Undo" accessibilityLabel={`Undo: link ${removed.label} again`} disabled={run.isPending}
          onPress={() => run.mutate({ action: "undo", ref: removed.key, label: removed.label })} />
      </View>}
      {paste?.action === "add" && <Pressable accessibilityRole="button" accessibilityLabel={`Add ${paste.label}`} accessibilityHint="Adds it to this workspace's linked items" disabled={run.isPending} onPress={add}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: gutter, paddingVertical: sp.rowV, minHeight: sp.row, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.border,
          backgroundColor: state.pressed ? c.surface2 : hovered(state) ? c.surface2 : c.surface1 })}>
        <View style={{ width: 16, alignItems: "center" }}><LinkedGlyph glyph={{ type: "kind", kind: paste.kind }} colors={c} size={14} /></View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={1} style={[t.body, { fontWeight: "600" }]}>+ Add {paste.label}</Text>
          <Text numberOfLines={1} style={t.meta}>{run.isPending ? "Adding…" : `${paste.hint}${compact ? "" : " · Enter to add"}`}</Text>
        </View>
      </Pressable>}
      {paste?.action === "refuse" && <Text accessibilityRole="alert" style={[t.meta, { paddingHorizontal: gutter, paddingBottom: 8 }]}>{paste.message}</Text>}

      {query.isPending ? <View accessibilityLabel="Loading linked items" style={{ paddingHorizontal: gutter, paddingTop: 12, gap: 18 }}>
        {[0, 1, 2].map(i => <View key={i} style={{ flexDirection: "row", gap: 12 }}>
          <Skeleton width={14} height={14} radius={7} color={c.surface2} />
          <View style={{ flex: 1, gap: 7 }}><Skeleton width={i === 1 ? "62%" : "78%"} height={10} color={c.surface2} /><Skeleton width="44%" height={8} color={c.surface2} /></View>
        </View>)}
      </View>
      : query.error ? <Text accessibilityRole="alert" style={[t.meta, { paddingHorizontal: gutter, paddingTop: 8, color: c.statusDanger }]}>Couldn't load the list: {errorText(query.error)}</Text>
      : !items.length ? <Text style={[t.meta, { paddingHorizontal: gutter, paddingTop: 8, fontSize: compact ? 14 : 13, lineHeight: compact ? 20 : 18 }]}>{LINKED_EMPTY}</Text>
      : !groups.length && !spec && !paste ? <Text style={[t.meta, { paddingHorizontal: gutter, paddingTop: 8 }]}>Nothing linked matches “{filter.trim()}”.</Text>
      : <>{spec && <View style={{ paddingTop: compact ? 10 : 8 }}>
        <LinkedRow item={spec} mainAgentId={w.mainAgentId} theme={theme} compact={compact} gutter={gutter} menuOpen={menu === spec.key}
          onMenu={() => setMenu(m => m === spec.key ? null : spec.key)} onEditSpec={() => { setMenu(null); onEditSpec(); }} onRemove={() => undefined} />
      </View>}
      {groups.map(g => <View key={g.kind} style={{ paddingTop: compact ? 14 : 12 }}>
        <Text accessibilityRole="header" style={[t.section, { paddingHorizontal: gutter, paddingBottom: 4 }]}>{g.head} · {g.count}</Text>
        {g.rows.map(i => <LinkedRow key={i.key} item={i} mainAgentId={w.mainAgentId} theme={theme} compact={compact} gutter={gutter} menuOpen={menu === i.key}
          onMenu={() => setMenu(m => m === i.key ? null : i.key)} onEditSpec={() => { setMenu(null); onEditSpec(); }}
          onRemove={label => { setMenu(null); run.mutate({ action: "remove", ref: i.key, label }); }} />)}
        {g.moreOpen > 0 && <FoldLine theme={theme} compact={compact} gutter={gutter} open={false} label={`Show ${g.moreOpen} more`} onPress={() => setExpanded(s => toggle(s, g.kind))} />}
        {g.done.length > 0 && <>
          <FoldLine theme={theme} compact={compact} gutter={gutter} open={doneOpen.has(g.kind)} label={`${g.done.length} done`} onPress={() => setDoneOpen(s => toggle(s, g.kind))} />
          {doneOpen.has(g.kind) && g.done.map(i => <LinkedRow key={i.key} item={i} mainAgentId={w.mainAgentId} theme={theme} compact={compact} gutter={gutter} menuOpen={menu === i.key}
            onMenu={() => setMenu(m => m === i.key ? null : i.key)} onEditSpec={() => { setMenu(null); onEditSpec(); }}
            onRemove={label => { setMenu(null); run.mutate({ action: "remove", ref: i.key, label }); }} />)}
        </>}
      </View>)}</>}

    </Modal.Content>
  </Modal>;
}

function FoldLine({ theme, compact, gutter, open, label, onPress }: { theme: Theme; compact: boolean; gutter: number; open: boolean; label: string; onPress: () => void }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={open ? `Hide ${label}` : label} onPress={onPress}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: gutter + 28, paddingRight: gutter, minHeight: compact ? 44 : 30,
      backgroundColor: state.pressed ? c.surface2 : hovered(state) ? c.surface1 : "transparent" })}>
    <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={c.foregroundMuted} />
    <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{label}</Text>
  </Pressable>;
}

/**
 * One item: the row opens it in the browser; `⋯` (desktop: on hover or focus; phones: always, 44pt) opens its actions
 * inline: Copy link and Remove, or Edit spec link… on the spec.
 */
function LinkedRow({ item: i, mainAgentId, theme, compact, gutter, menuOpen, onMenu, onRemove, onEditSpec }: {
  item: LinkedViewItem; mainAgentId: string | null; theme: Theme; compact: boolean; gutter: number; menuOpen: boolean; onMenu: () => void; onRemove: (label: string) => void; onEditSpec: () => void;
}) {
  const c = theme.colors; const t = text(c, compact);
  const r = linkedRow(i, mainAgentId);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const toast = useToast();
  const url = i.url;
  const showMenu = compact || hover || focus || menuOpen;
  const finished = i.statusTone === "done" || i.statusTone === "cancelled";
  // Focus anywhere in the row (the row link or ⋯ itself) shows ⋯: a focused control is never left at opacity 0.
  return <View {...({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), onFocus: () => setFocus(true), onBlur: () => setFocus(false) } as object)}
    style={{ backgroundColor: menuOpen ? c.surface1 : "transparent" }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      <Pressable accessibilityRole="link" accessibilityLabel={`${r.lead ? `${r.lead} ` : ""}${r.title}${r.spec ? ", spec" : ""}. ${r.meta}`} accessibilityHint={url ? "Opens in the browser" : undefined}
        disabled={!url} onPress={() => url && openUrl(url)}
        style={state => ({ flex: 1, minWidth: 0, flexDirection: "row", gap: 12, paddingLeft: gutter, paddingRight: 4, paddingVertical: compact ? 10 : 8,
          backgroundColor: state.pressed ? c.surface2 : hovered(state) && !menuOpen ? c.surface1 : "transparent" })}>
        <View style={{ width: 16, alignItems: "center", paddingTop: compact ? 3 : 2 }}><LinkedGlyph glyph={r.glyph} colors={c} size={compact ? 15 : 14} /></View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          {/* Phones: the key on its own line, so long titles get the full width. */}
          {compact && r.lead && <Text numberOfLines={1} style={[t.body, { color: finished ? c.foregroundMuted : c.foreground, fontVariant: ["tabular-nums"] }]}>{r.lead}</Text>}
          <Text numberOfLines={compact ? 2 : 1} style={[t.body, { color: finished ? c.foregroundMuted : c.foreground }]}>
            {!compact && r.lead ? <Text style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }}>{r.lead}  </Text> : null}
            {r.title}
          </Text>
          <Text numberOfLines={1} style={t.meta}>{r.meta}</Text>
        </View>
      </Pressable>
      <View style={{ paddingRight: gutter - (compact ? 10 : 4), paddingTop: compact ? 2 : 6, opacity: showMenu ? 1 : 0 }}>
        <IconButton theme={theme} compact={compact} icon="Ellipsis" label={`Actions for ${r.label}`} onPress={onMenu} />
      </View>
    </View>
    {menuOpen && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: gutter + 28, paddingRight: gutter, paddingBottom: 10 }}>
      {url && <Button theme={theme} compact={compact} icon="Copy" title="Copy link" onPress={() => { void copyText(url).then(() => toast.show("Link copied"), () => toast.error("Couldn't copy the link")); onMenu(); }} />}
      {r.spec ? <Button theme={theme} compact={compact} icon="Pencil" title="Edit spec link…" onPress={onEditSpec} />
        : <Button theme={theme} compact={compact} kind="danger" icon="Trash2" title="Remove" accessibilityLabel={`Remove ${r.label}`} onPress={() => onRemove(r.label)} />}
    </View>}
  </View>;
}
