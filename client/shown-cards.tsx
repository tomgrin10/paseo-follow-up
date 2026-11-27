import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { usePaseo, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Pressable, Text } from "./text";
import { Skeleton } from "./motion";
import { Button, IconButton, text, useNow, type Theme } from "./kit";
import { readable, withAlpha } from "./theme";
import { FoldButton, PANEL_FOLDS, useFold } from "./fold";
import { RowMenu, type DomNode, type RowMenuOpen } from "./row-menu";
import { runCardAction } from "./row-actions";
import { DockedPane } from "./docked-pane";
import { QuestionBody } from "./questions";
import { ReplyBox } from "./home";
import { useWorkspace } from "./workspace-data";
import type { LiveStore } from "./live";
import type { Workspace } from "../shared/model";
import type { RowMenuItem } from "../shared/row-menu";
import type { Workstream } from "../shared/home";
import { CARD_VIEW, cardMode, foldedBudget, freshLabel, pointedCards, stableOrder, startsFolded } from "../shared/card-view";
import { BlockView, MiniThumb, firstImage, flushBlock, type BlockCtx } from "./card-blocks";
import { CardHere, canOpenLarge, goToCard, openCardLarge, registerCard, useCardAct, useCards, type ViewCard } from "./card-data";

/**
 * What agents show the developer in the workspace view (docs/cards.md, the design's "Where cards live"): each card is the
 * agent's own title and its blocks, never a concept name. It folds like every section (panel-sections-fold, per device
 * and per card); a card not updated for 7 days starts folded with its date. Its ⋯ menu: Open large (the card's own
 * screen), Keep (never folds as old) and Remove (two clicks in place, then a toast with Undo). A card an open question
 * points at sits right under Needs you with an amber edge; opened large, it carries the question and its answers.
 */

/** Days for a folded old card's date: "8 d ago", with the day. */
const dayOf = (iso: string) => { try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return ""; } };

export type CardPlace = "view" | "large";

export function ShownCard({ card, workspace: w, theme, compact, now, place = "view", pointed = false, openQuestion }: {
  card: ViewCard; workspace: Pick<Workspace, "id" | "mainAgentId">; theme: Theme; compact: boolean; now: number;
  place?: CardPlace;
  /** An open question points at it: the amber edge (the question is the Needs you row right above). */
  pointed?: boolean;
  openQuestion?: (id: string) => void;
}) {
  const c = theme.colors; const t = text(c, compact);
  const [width, setWidth] = useState(0);
  // What the blocks get: the card's inside, its 1 px borders off (laid out at the outer width, a two-up grid wrapped).
  const inside = width ? width - 2 : 0;
  const mode = cardMode(inside || (compact ? 328 : 400), compact);
  const fold = useFold(place === "large" ? null : `${PANEL_FOLDS.cards}.${card.id}`, !startsFolded(card, now));
  const open = place === "large" || fold.open;
  const root = useRef<View>(null);
  useCardWidth(root, setWidth);
  useEffect(() => registerCard(w.id, card.id, { node: root.current, open: () => openCardLarge(w.id, card.id) }), [w.id, card.id]);
  // Changed rows: a thin blue edge until the card has been open on screen for 3 s (no animation).
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => { if (!open || seen === card.updatedAt) return; const id = setTimeout(() => setSeen(card.updatedAt), CARD_VIEW.changedSeenMs); return () => clearTimeout(id); }, [open, card.updatedAt, seen]);
  const stale = card.freshness.kind === "stale";
  const fresh = freshLabel(card.freshness.kind, card.freshness.label, card.updatedAt, now);
  const freshColor = card.freshness.kind === "live" ? readable(c.statusSuccess, c) : stale ? readable(c.statusWarning, c) : c.foregroundMuted;
  const by = card.by !== w.mainAgentId ? (card.byTitle?.trim() || "Another agent") : null;
  const old = card.freshness.kind === "old";
  const sub = [by, card.summary, old && !open ? dayOf(card.updatedAt) : null].filter(Boolean).join(" · ");
  const freshNode = (size: number) => <Text numberOfLines={1} style={{ color: freshColor, fontSize: size, lineHeight: size + 4, fontVariant: ["tabular-nums"] }}>
    {card.freshness.kind === "live" ? "● " : ""}{fresh}
  </Text>;
  const [menu, setMenu] = useState<RowMenuOpen | null>(null);
  const act = useCardAct(w.id);
  const items: RowMenuItem[] = [
    ...(place !== "large" && canOpenLarge() ? [{ key: "open", action: "card_open" as const, label: "Open large", icon: "Maximize2" }] : []),
    card.keep ? { key: "unkeep", action: "card_keep" as const, label: "Let it fold when old", icon: "PinOff", hint: "Folds once it's a week old" }
      : { key: "keep", action: "card_keep" as const, label: "Keep", icon: "Pin", hint: "Never folds as old" },
    { key: "remove", action: "card_remove" as const, label: "Remove", icon: "Trash2", confirm: "Remove this from the view? The agent isn't told. Undo brings it back." },
  ];
  const pick = (item: RowMenuItem) => { void runCardAction(item, { workspaceId: w.id, id: card.id, title: card.title, keep: !!card.keep, act, openLarge: () => openCardLarge(w.id, card.id) }); };
  const anchor = useRef<View>(null);
  const showMenu = () => {
    const node = anchor.current as unknown as DomNode | null;
    const r = !compact && Platform.OS === "web" ? node?.getBoundingClientRect?.() as { right?: number; left: number; bottom: number } | undefined : null;
    setMenu({ s: { key: `card:${card.id}`, title: card.title } as unknown as Workstream, anchor: r ? { x: r.right ?? r.left, y: r.bottom + 4 } : null, sections: [{ key: "card", items }], returnTo: node });
  };
  const ctx = (blockId: string): BlockCtx => ({ workspaceId: w.id, theme, compact, width: inside || (compact ? 328 : 400), stale, changed: seen === card.updatedAt ? [] : card.changed[blockId] ?? [], openQuestion });
  const head = <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
    {/* The title and its line are the fold's button; ⋯ sits outside it (a button never holds another). */}
    <View style={{ flex: 1, minWidth: 0 }}>
      {place === "large"
        ? <View style={{ paddingHorizontal: mode.pad, paddingTop: 10, paddingBottom: 8, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>{title()}</View>
        : <FoldButton open={open} onToggle={fold.toggle} label={`${card.title}, ${sub}${fresh ? `, ${fresh}` : ""}`} theme={theme} chevron="end"
          style={(hovered, pressed) => ({ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingLeft: mode.pad, paddingRight: 4, paddingTop: 10, paddingBottom: open ? 8 : 10, minHeight: compact ? 44 : undefined, backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent" })}>
          {title()}
        </FoldButton>}
    </View>
    <View ref={anchor} collapsable={false} style={{ paddingTop: compact ? 0 : 6, paddingRight: compact ? 4 : 6 }}>
      <IconButton icon="Ellipsis" label={`More actions for ${card.title}`} onPress={showMenu} theme={theme} compact={compact} />
    </View>
  </View>;
  function title() {
    return <>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text accessibilityRole="header" numberOfLines={2} style={[compact ? t.label : { color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }, Platform.OS === "web" ? { overflowWrap: "anywhere" } as object : null]}>{card.title}</Text>
        {(!!sub || mode.freshInSubtitle) && <Text numberOfLines={1} style={t.small}>
          {/* Narrow: freshness first, so a long summary is what truncates, never "Updated…". */}
          {mode.freshInSubtitle && fresh ? <Text style={{ color: freshColor }}>{fresh}{sub ? " · " : ""}</Text> : null}{sub}
        </Text>}
      </View>
      {!mode.freshInSubtitle && !!fresh && <View style={{ flexShrink: 0, maxWidth: "40%", paddingTop: 2 }}>{freshNode(11)}</View>}
    </>;
  }
  return <View ref={root} collapsable={false} testID={`follow-up-card-${card.id}`} {...({ dataSet: { shownCard: card.id, folded: open ? "0" : "1", budget: String(foldedBudget(compact)) } } as object)}
    onLayout={e => { const next = Math.round(e.nativeEvent.layout.width); if (next > 0 && next !== width) setWidth(next); }}
    style={[{ marginHorizontal: place === "large" ? 0 : compact ? 16 : 12, marginTop: place === "large" ? 0 : 12, borderRadius: 8, overflow: menu ? "visible" : "hidden", zIndex: menu ? 40 : undefined, backgroundColor: c.surface0 },
      pointed ? { borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.7) } : { borderWidth: 1, borderColor: c.border }]}>
    {head}
    {open && card.blocks.map(b => <View key={b.id} style={[{ borderTopWidth: 1, borderTopColor: c.border }, flushBlock(b) ? { paddingTop: 4, paddingBottom: 10 } : { paddingHorizontal: mode.pad, paddingVertical: compact ? 12 : 10 }]}>
      <BlockView block={b} ctx={ctx(b.id)} />
    </View>)}
    {menu && <RowMenu menu={menu} theme={theme} onClose={() => setMenu(null)} onPick={pick} />}
  </View>;
}

/** A card the view knows about (`shownCards`) whose content is still loading: its title, folded, never a jump. */
function CardLoading({ title, theme, compact }: { title: string; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  return <View accessibilityLabel={`Loading ${title}`} style={{ marginHorizontal: compact ? 16 : 12, marginTop: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, padding: 12, gap: 8 }}>
    <Text numberOfLines={2} style={text(c, compact).label}>{title}</Text>
    <Skeleton width="60%" height={9} color={c.surface2} />
  </View>;
}

/**
 * The workspace view's cards, placed: `pointed` right under Needs you (a card an open question points at), `others`
 * after Your questions in one column, or one slot each in the movable pool. The order is newest update first when the
 * view opens, then stable: a card that updates keeps its place.
 */
export function useShownCards(w: Workspace, { theme, compact, now, openQuestion }: { theme: Theme; compact: boolean; now: number; openQuestion?: (id: string) => void }): { pointed: ReactNode; others: { id: string; node: ReactNode }[] } {
  const data = useCards(w.id, w.shownCards);
  const asked = useMemo(() => pointedCards(w.questions), [w.questions]);
  const order = useRef<string[] | null>(null);
  const listed = w.shownCards ?? [];
  if (listed.length) order.current = stableOrder(order.current, listed);
  const byId = new Map(data.cards.map(cd => [cd.id, cd]));
  const node = (id: string, pointed: boolean) => {
    const cd = byId.get(id);
    if (!cd) return data.pending ? <CardLoading key={id} title={listed.find(s => s.id === id)?.title ?? ""} theme={theme} compact={compact} /> : null;
    return <ShownCard key={id} card={cd} workspace={w} theme={theme} compact={compact} now={now} pointed={pointed} openQuestion={openQuestion} />;
  };
  const ids = order.current ?? [];
  const pointedIds = ids.filter(id => asked.has(id));
  return {
    pointed: pointedIds.length ? <>{pointedIds.map(id => node(id, true))}</> : null,
    others: ids.filter(id => !asked.has(id)).map(id => ({ id, node: node(id, false) })).filter(x => !!x.node),
  };
}

/**
 * The row under a question that points at a card (and Needs you's line): a thumbnail (its first image), the card's
 * title, what it holds and "below". A tap scrolls to the card on desktop, or opens it full screen on a phone.
 */
export function CardLinkRow({ workspace: w, cardId, theme, compact, dense = false }: { workspace: Pick<Workspace, "id" | "shownCards">; cardId: string; theme: Theme; compact: boolean; dense?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const data = useCards(w.id, w.shownCards, !dense);
  const listed = w.shownCards?.find(s => s.id === cardId);
  if (!listed) return <Text style={t.meta}>The card this pointed at was removed.</Text>;
  const card = data.cards.find(x => x.id === cardId);
  const thumb = card ? firstImage(card.blocks) : null;
  const where = compact ? "open" : "below";
  if (dense) return <Pressable accessibilityRole="link" accessibilityLabel={`${listed.title}, ${where}`} onPress={() => goToCard(w.id, cardId, compact)}>
    <Text numberOfLines={1} style={t.meta}><Text style={{ color: c.foreground, fontWeight: "600" }}>{listed.title}</Text> {where}</Text>
  </Pressable>;
  return <Pressable accessibilityRole="link" accessibilityLabel={`${listed.title}${card?.contents ? `, ${card.contents}` : ""}, ${compact ? "opens it" : "below"}`} onPress={() => goToCard(w.id, cardId, compact)}
    style={s => ({ flexDirection: "row", alignItems: "center", gap: 10, padding: 6, marginHorizontal: -6, borderRadius: 6, minHeight: compact ? 48 : undefined, backgroundColor: s.pressed ? c.surface2 : (s as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    {thumb ? <MiniThumb src={thumb} workspaceId={w.id} theme={theme} size={{ width: 48, height: 30 }} />
      : <View style={{ width: 30, height: 30, borderRadius: 6, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}><Icon name="LayoutList" size={14} color={c.foregroundMuted} /></View>}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={[t.body, { fontWeight: "600" }]}>{listed.title}</Text>
      {!!card?.contents && <Text numberOfLines={1} style={t.small}>{card.contents}</Text>}
    </View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <Text style={t.meta}>{where}</Text>
      <Icon name={compact ? "ChevronRight" : "ArrowDown"} size={13} color={c.foregroundMuted} />
    </View>
  </Pressable>;
}

/**
 * A card on its own screen (`follow-up-card`): Open large on desktop, a card opened from a question on a phone. The card
 * full width; docked under it, the question that points at it with its answers (the one answer flow, QuestionBody),
 * else a reply box to the agent that wrote it.
 */
export function CardScreen({ params, theme, layout, live, navigation }: PluginScreenProps & { live?: LiveStore }) {
  const c = theme.colors; const compact = layout.compact;
  const workspaceId = params.workspaceId ?? ""; const cardId = params.card ?? "";
  const query = useWorkspace(live, workspaceId);
  const w = query.workspace;
  const now = useNow(30_000);
  const data = useCards(workspaceId, w?.shownCards);
  const card = data.cards.find(x => x.id === cardId);
  const paseo = usePaseo();
  const asked = w ? pointedCards(w.questions).get(cardId) ?? null : null;
  const question = asked && w ? w.questions.find(q => q.id === asked) ?? null : null;
  const t = text(c, compact);
  const pad = compact ? 16 : 24;
  const missing = !query.pending && (!w || (!data.pending && !card));
  const dock = (card && w) ? () => <View style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface0, paddingHorizontal: pad, paddingTop: 10, paddingBottom: 12, maxHeight: compact ? 420 : 360 }}>
    {/* Docked under its own card: no row pointing back at it, no More context (the card is the context). */}
    {question ? <CardHere.Provider value={card.id}><QuestionBody workspace={w as never} question={question as never} theme={theme} compact={compact} now={now} moreContext={false} /></CardHere.Provider>
      : <ReplyBox theme={theme} compact={compact} agentName={card.byTitle?.trim() || "the agent"} hint={null} placeholder="Message the agent about this" target={{ kind: "agent", agentId: card.by }}
        onSend={async (words, images) => { await paseo.agents.ref(card.by).send(`About "${card.title}": ${words}`, images?.length ? { images } : undefined); }} />}
  </View> : undefined;
  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    <DockedPane compact={compact} dock={dock} style={{ flex: 1 }} contentContainerStyle={{ padding: pad, paddingBottom: 24 }}>
      {missing ? <View style={{ gap: 8, maxWidth: 520 }}>
        <Text accessibilityRole="header" style={t.title}>This is no longer shown</Text>
        <Text style={t.meta}>The agent removed it, or it was removed from the view. Open the workspace to see what it shows now.</Text>
        {w && navigation && <Button theme={theme} compact={compact} title="Open the workspace" icon="ArrowLeft" onPress={() => navigation.openWorkspace({ workspaceId })} />}
      </View>
        : !card || !w ? <CardLoading title={w?.shownCards?.find(s => s.id === cardId)?.title ?? ""} theme={theme} compact={compact} />
        : <ShownCard card={card} workspace={w} theme={theme} compact={compact} now={now} place="large" pointed={!!question} />}
    </DockedPane>
  </View>;
}

/** The header's spec link when the agent keeps its spec as the card `spec`: it goes to that card. */
export function SpecCardChip({ workspace: w, theme, compact }: { workspace: Pick<Workspace, "id" | "shownCards">; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  const spec = w.shownCards?.find(s => s.id === "spec");
  if (!spec) return null;
  return <Pressable accessibilityRole="link" accessibilityLabel={`The spec: ${spec.title}`} onPress={() => goToCard(w.id, "spec", compact)} hitSlop={compact ? 0 : 6}
    style={s => ({ flexDirection: "row", alignItems: "center", gap: 4, minHeight: compact ? 32 : 20, paddingHorizontal: 6, borderRadius: 999, maxWidth: 260, backgroundColor: s.pressed ? c.surface2 : c.surface1 })}>
    <Icon name="FileText" size={11} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 11, lineHeight: 16, flexShrink: 1 }}>Spec · {spec.title}</Text>
  </Pressable>;
}

type Observed = { getBoundingClientRect?(): { width: number } };
type Observer = new (f: () => void) => { observe(n: unknown): void; disconnect(): void };
/**
 * The card's width on the web, read from its element and kept by a ResizeObserver. onLayout alone left a card in the
 * side panel at the fallback width (the harness: blocks laid out 82 px wider than the card); native keeps onLayout.
 */
function useCardWidth(ref: { current: unknown }, set: (w: number) => void) {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = ref.current as Observed | null;
    const RO = (globalThis as { ResizeObserver?: Observer }).ResizeObserver;
    if (!el?.getBoundingClientRect) return;
    const read = () => { const w = Math.round(el.getBoundingClientRect!().width); if (w > 0) set(w); };
    read();
    if (!RO) return;
    const ro = new RO(read); ro.observe(el);
    return () => ro.disconnect();
  }, [ref, set]);
}
