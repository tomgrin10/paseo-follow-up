import { queueMoved } from "../shared/linear-queue";
import { useCallback, useEffect, useRef, useState } from "react";
import { PagedRows } from "./paged-list";
import { Platform, View } from "react-native";
import { Pressable, Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { dispatchActionsRpc, dispatchRpc, linearQueueRpc, sweepQueueRpc } from "../shared/contracts";
import { changeChip, openedLine, queueRowMeta, sinceBlock, type SinceChange, type SinceLine } from "../shared/brief-since";
import { nobodyRow, type CompassSince } from "../shared/nobody";
import { PriorityLine } from "./home-chrome";
import { actionIcon, stateIcon } from "../shared/new-view";
import type { QueueNeeds } from "./home-view";
import type { DispatchAction } from "../shared/dispatch";
import { errorText } from "../shared/errors";
import { age } from "../shared/inbox";
import { BarBtn, focusRing } from "./action-row";
import { DismissX, RevealScope, useDismiss } from "./dismiss";
import { Button, text, type Theme } from "./kit";
import { openNew } from "./new";
import { withAlpha, type Colors } from "./theme";
import { NEW_NAME } from "../shared/new-name";

/**
 * The Morning brief's Linear queue on screen (docs/morning-brief.md#in-the-brief): the "Since" block in the brief pane,
 * the queue screen it opens ("47 issues by priority ›"), and decision Q8's raised issues in Needs you. Words come from
 * shared/brief-since.ts; the data is `follow.linear-queue` (server/linear-queue.ts). Starting work is New's: the brief's
 * lines carry New's own actions (follow.dispatch, Q9) and ⋯ opens New on the issue; a queue row's Start… opens New.
 */

type Workspace = { workspaceId: string; title: string } | null;
type QueueIssueRow = { key: string; title: string; priority: number; state: string | null; stateType: string | null; due: string | null; url: string | null; workspace: Workspace; change: string | null;
  createdAt?: string | null; creator?: string | null; openedByYou?: boolean | null };
type QueueViewData = {
  status: { sweptAt: string | null; complete: boolean | null; running: boolean; total: number; stale: boolean; timeZone: string; sweepAt: string; last: { ok: boolean; error: string | null } | null };
  since: string | null;
  changes: SinceChange[];
  groups: { priority: number; name: string; count: number; issues: QueueIssueRow[] }[];
  counts: { all: number; noWorkspace: number; changed: number };
  more: number;
  raised: unknown[];
  /** What Compass heard since the same point: the one Since block (design §8). */
  compass?: CompassSince | null;
};
type Filter = "all" | "no-workspace" | "changed";
type Nav = { openWorkspace(i: { workspaceId: string }): void } | undefined;
type Hover = { hovered?: boolean; pressed?: boolean; focused?: boolean };

const hhmm = (iso: string, timeZone: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });

/** One read of the queue view; `open` marks the developer's read (only the brief pane passes it, once per mount). */
function useQueueView(input: { open?: boolean; filter?: Filter }) {
  const read = useRpc(linearQueueRpc);
  const [view, setView] = useState<QueueViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);
  const load = useCallback(async (filter?: Filter) => {
    const open = !!input.open && !opened.current;
    opened.current = opened.current || open;
    try { const v = await read({ ...(open ? { open: true } : {}), ...(filter ?? input.filter ? { filter: filter ?? input.filter } : {}) }) as QueueViewData; setView(v); setError(null); return v; }
    catch (e) { setError(errorText(e)); return null; }
  }, [read, input.open, input.filter]);
  useEffect(() => { void load(); }, [load]);
  return { view, error, reload: load };
}

/** New's configured actions (Settings → New), read once per mount: the brief's lines show the first two. */
function useActions() {
  const read = useRpc(dispatchActionsRpc);
  const [actions, setActions] = useState<DispatchAction[]>([]);
  useEffect(() => { let live = true; read({}).then(r => { if (live) setActions(r.actions); }).catch(() => undefined); return () => { live = false; }; }, [read]);
  return actions;
}

const ICON_TONE = (l: SinceLine, c: Colors) => l.warn ? c.statusWarning : c.foregroundMuted;

/** A Since line's actions (Q9): New's first two, bordered (Catch up stays the one filled button), and ⋯ for New itself. */
function LineActions({ source, actions, c, compact, onStarted }: { source: string; actions: DispatchAction[]; c: Colors; compact: boolean; onStarted: () => void }) {
  const send = useRpc(dispatchRpc);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const start = async (a: DispatchAction) => {
    if (busy) return;
    setBusy(a.id);
    try { await send({ source, actionId: a.id }); toast.show(`${a.name} started for ${source}. Undo is on Home.`, { variant: "success" }); onStarted(); }
    // A source New can't place on its own (two projects fit) opens New on it, where the developer picks.
    catch (e) { toast.error(errorText(e)); openNew({ source }); }
    finally { setBusy(null); }
  };
  // Each button keeps its whole label (never squeezed to "Plan as ar…"): a row that doesn't fit wraps instead.
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
    {actions.slice(0, 2).map(a => <BarBtn key={a.id} c={c} compact={compact} small primary={false} disabled={!!busy} b={{ name: busy === a.id ? `${a.name}…` : a.name, icon: actionIcon(a.icon), key: null }} onPress={() => void start(a)} />)}
    <Pressable accessibilityRole="button" accessibilityLabel={`More ways to start ${source} in ${NEW_NAME}`} onPress={() => openNew({ source })}
      style={(s: Hover) => ({ minHeight: compact ? 44 : 32, minWidth: compact ? 44 : 32, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: s.pressed ? c.surface2 : s.hovered ? c.surface1 : "transparent", ...focusRing(c, s.focused) })}>
      <Icon name="Ellipsis" size={16} color={c.foreground} />
    </Pressable>
  </View>;
}

function Line({ l, c, compact, actions, onStarted, navigation }: { l: SinceLine; c: Colors; compact: boolean; actions: DispatchAction[]; onStarted: () => void; navigation: Nav }) {
  const t = text(c, compact);
  const ws = l.workspace;
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 4 }}>
    <View style={{ paddingTop: 3, width: 16, alignItems: "center" }}><Icon name={l.icon} size={15} color={ICON_TONE(l, c)} /></View>
    <View style={{ flex: 1, minWidth: 0 }}>
      {/* One label for the line, so a screen reader says it once instead of fragments and "·" separators. */}
      <Text accessibilityLabel={[l.head, l.meta, l.sub].filter(Boolean).join(". ")} style={t.body}><Text style={{ fontWeight: "600", color: c.foreground }}>{l.head}</Text>{l.meta ? <Text style={{ color: c.foregroundMuted }}> · {l.meta}</Text> : null}</Text>
      {!!l.sub && (ws && navigation
        ? <Pressable accessibilityRole="link" accessibilityLabel={`Open ${ws.title}`} onPress={() => navigation.openWorkspace({ workspaceId: ws.workspaceId })} style={(s: Hover) => ({ alignSelf: "flex-start", ...focusRing(c, s.focused) })}>
          <Text numberOfLines={2} style={t.meta}>{l.sub}</Text>
        </Pressable>
        : <Text numberOfLines={2} style={t.meta}>{l.sub}</Text>)}
      {!!l.source && actions.length > 0 && <LineActions source={l.source} actions={actions} c={c} compact={compact} onStarted={onStarted} />}
    </View>
  </View>;
}

/** The brief pane's "Since Friday · your Linear queue" block. Opening it is the developer's read (follow.linear-queue open). */
export function SinceBlock({ theme, compact, openQueue, onStarted, navigation, raised, revision }: { theme: Theme; compact: boolean; openQueue: () => void; onStarted: () => void; navigation: Nav; raised: ReadonlySet<string>; revision: string }) {
  const c = theme.colors; const t = text(c, compact);
  const { view, error, reload } = useQueueView({ open: true });
  // The home feed's queue revision moved (a sweep ended, or a dismissal): an open brief pane re-reads, no timer.
  const seen = useRef(revision);
  useEffect(() => { const moved = queueMoved(seen.current, revision); seen.current = revision; if (moved) void reload(); }, [revision, reload]);
  const actions = useActions();
  if (error && !view) return <View style={{ gap: 4, marginTop: 6 }}>
    <Text accessibilityRole="header" style={t.section}>Your Linear queue</Text>
    <Text style={t.meta}>Couldn't read it: {error}</Text>
  </View>;
  // Nothing swept yet and nothing to say: no block (a fresh install before its first sweep, or no Linear).
  if (!view || (!view.status.sweptAt && !view.changes.length && !view.compass?.lines.length)) return null;
  const now = Date.now();
  const b = sinceBlock(view, now, view.status.timeZone, raised);
  const link = <Pressable accessibilityRole="link" accessibilityLabel={`Open your Linear queue: ${b.link}`} onPress={openQueue} hitSlop={compact ? 0 : 8}
    style={(s: Hover) => ({ flexDirection: "row", alignItems: "center", gap: 4, minHeight: compact ? 44 : undefined, ...focusRing(c, s.focused) })}>
    <Text style={[t.small, { color: c.foreground, textDecorationLine: "underline" }]}>{b.link}</Text>
    <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
  </Pressable>;
  // The section gap after the last line too, so "Waiting on others" doesn't run on from it.
  return <View style={{ gap: 4, marginTop: 6, marginBottom: compact ? 8 : 16 }}>
    <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "flex-start" : "center", gap: compact ? 0 : 8 }}>
      <Text accessibilityRole="header" style={[t.section, { flex: compact ? undefined : 1 }]}>{b.title}</Text>
      {!compact && link}
    </View>
    {view.status.stale && view.status.sweptAt && <Text style={[t.meta, { color: c.statusWarning }]}>The last sweep didn't finish, so this is {hhmm(view.status.sweptAt, view.status.timeZone)}'s queue.</Text>}
    {b.empty ? <Text style={t.meta}>{b.empty}</Text> : b.lines.map(l => <Line key={l.id} l={l} c={c} compact={compact} actions={actions} onStarted={onStarted} navigation={navigation} />)}
    {b.more > 0 && <Text style={t.meta}>{b.more} more changed. The queue's Changed filter has them.</Text>}
    {compact && link}
  </View>;
}

// ---------- the queue screen ----------

const FILTERS: { id: Filter; label: string; count: (v: QueueViewData) => number }[] = [
  { id: "all", label: "All", count: v => v.counts.all },
  { id: "no-workspace", label: "No workspace", count: v => v.counts.noWorkspace },
  { id: "changed", label: "Changed", count: v => v.counts.changed },
];

/** "opened by Dana · 12 days ago", with the exact time as the desktop tooltip (React Native Web drops `title`, so it goes on the node). */
function OpenedText({ text: words, tooltip }: { text: string; tooltip: string }) {
  const ref = useRef<View | null>(null);
  useEffect(() => { if (Platform.OS === "web") (ref.current as unknown as { setAttribute?: (k: string, v: string) => void } | null)?.setAttribute?.("title", tooltip); }, [tooltip]);
  return <Text ref={ref as never}>{words}</Text>;
}

function QueueRow({ i, change, c, compact, timeZone, navigation }: { i: QueueIssueRow; change: SinceChange | undefined; c: Colors; compact: boolean; timeZone: string; navigation: Nav }) {
  const t = text(c, compact);
  const now = Date.now();
  const chip = changeChip(change ?? null, now, timeZone);
  const meta = queueRowMeta(i, now, timeZone, change);
  const opened = openedLine({ createdAt: i.createdAt ?? null, creator: i.creator ?? null }, i.openedByYou ?? null, now, timeZone);
  const ws = i.workspace;
  const open = ws ? () => navigation?.openWorkspace({ workspaceId: ws.workspaceId }) : () => openNew({ source: i.key });
  const label = `${i.key} ${i.title}. ${meta}${opened ? `. ${opened.label}` : ""}${chip ? `. ${chip.text}` : ""}${ws ? `. In ${ws.title}` : ". No workspace"}`;
  const body = <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, flex: 1, minWidth: 0 }}>
    <View style={{ paddingTop: 2 }}><Icon name={stateIcon(i.stateType)} size={15} color={c.foregroundMuted} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text style={t.body}><Text style={{ color: c.foregroundMuted }}>{i.key}</Text>  {i.title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 }}>
        {/* One run of quiet ink, so a phone wraps it word by word and never cuts the state: "Todo · due Wed · opened by Dana · 12 days ago". */}
        {(!!meta || !!opened) && <Text style={t.meta}>{meta}{opened && <OpenedText text={`${meta ? " · " : ""}${opened.text}`} tooltip={opened.label} />}</Text>}
        {/* The change since the brief: a tinted chip, so the Changed filter's subjects stand out from the plain meta. */}
        {chip && <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, backgroundColor: withAlpha(chip.warn ? c.statusWarning : c.foregroundMuted, chip.warn ? 0.12 : 0.1) }}>
          {chip.icon && <Icon name={chip.icon} size={12} color={chip.warn ? c.statusWarning : c.foregroundMuted} />}
          <Text style={[t.meta, { color: chip.warn ? c.statusWarning : c.foreground }]}>{chip.text}</Text>
        </View>}
        {/* Phones: the workspace is a word on the meta line; the row itself opens it. */}
        {compact && ws && <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}><Icon name="Folder" size={12} color={c.foregroundMuted} /><Text numberOfLines={1} style={[t.meta, { color: c.foreground }]}>{ws.title}</Text></View>}
      </View>
    </View>
  </View>;
  // Phones: the row is the target (44px+), opening the workspace or New on the issue; no column of identical buttons.
  if (compact) return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={ws ? `Opens ${ws.title}` : `Opens ${NEW_NAME} on this issue`} disabled={!!ws && !navigation} onPress={open}
    style={(s: Hover) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 56, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: withAlpha(c.border, 0.6), backgroundColor: s.pressed ? c.surface2 : "transparent", ...focusRing(c, s.focused) })}>
    {body}
    <Icon name={ws ? "ChevronRight" : "Play"} size={15} color={c.foregroundMuted} />
  </Pressable>;
  // Desktop: the workspace chip, or a quiet Start… (Catch up stays the one filled button, and 20 rows of bordered
  // buttons would be a wall).
  const right = ws
    ? <Pressable accessibilityRole="button" accessibilityLabel={`Open ${ws.title}`} disabled={!navigation} onPress={open}
      style={(s: Hover) => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: s.pressed ? c.surface2 : s.hovered ? c.surface1 : "transparent", maxWidth: 240, ...focusRing(c, s.focused) })}>
      <Icon name="Folder" size={14} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={[t.small, { fontSize: 12, color: c.foreground, flexShrink: 1 }]}>{ws.title}</Text>
      <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
    </Pressable>
    : <Pressable accessibilityRole="button" accessibilityLabel={`Start ${i.key} in ${NEW_NAME}`} onPress={open}
      style={(s: Hover) => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingHorizontal: 10, borderRadius: 8, backgroundColor: s.pressed ? c.surface2 : s.hovered ? c.surface1 : "transparent", ...focusRing(c, s.focused) })}>
      <Icon name="Play" size={13} color={c.foregroundMuted} />
      <Text style={[t.small, { fontSize: 12, color: c.foreground, fontWeight: "500" }]}>Start…</Text>
    </Pressable>;
  return <View accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}>
    {body}
    {right}
  </View>;
}

/** The queue screen (`?view=queue`): every issue by Linear priority, filters All / No workspace / Changed (Q10). */
export function QueueScreen({ theme, compact, onHome, navigation }: { theme: Theme; compact: boolean; onHome: () => void; navigation: Nav }) {
  const c = theme.colors; const t = text(c, compact);
  const [filter, setFilter] = useState<Filter>("all");
  const { view, error, reload } = useQueueView({ filter });
  const sweep = useRpc(sweepQueueRpc);
  const toast = useToast();
  const [sweeping, setSweeping] = useState(false);
  // Sweep now replies at once (`wait: false`): the screen reads the view every 3 s while the sweep runs (up to 2 min),
  // so a slow Linear never holds the button's RPC.
  const sweepNow = async () => {
    setSweeping(true);
    try {
      await sweep({ wait: false });
      for (let n = 0; n < 40; n++) {
        await new Promise(r => setTimeout(r, 3000));
        const v = await reload();
        if (!v?.status.running) { if (v?.status.last && !v.status.last.ok) toast.error(v.status.last.error ?? "The sweep failed."); break; }
      }
    } catch (e) { toast.error(errorText(e)); } finally { setSweeping(false); }
  };
  const tz = view?.status.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const changes = new Map((view?.changes ?? []).map(ch => [ch.key, ch]));
  const swept = view?.status.sweptAt ? `Swept ${hhmm(view.status.sweptAt, tz)}${view.status.complete === false ? " · partial" : ""}` : "Not swept yet";
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 28, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      {!compact && <Button theme={theme} compact={compact} kind="ghost" icon="ArrowLeft" title="Brief" onPress={onHome} />}
      <Text accessibilityRole="header" style={[t.title, { fontSize: 20, lineHeight: 26, flex: 1 }]}>Your Linear queue</Text>
      {!compact && <Text style={t.meta}>{swept}</Text>}
      <Button theme={theme} compact={compact} kind="secondary" icon="RefreshCw" title={sweeping || view?.status.running ? "Sweeping…" : "Sweep now"} loading={sweeping} disabled={sweeping} onPress={() => void sweepNow()} />
    </View>
    {compact && <Text style={[t.meta, { marginTop: -6 }]}>{swept}{view ? ` · ${view.counts.all} issue${view.counts.all === 1 ? "" : "s"}` : ""}</Text>}
    {view?.status.last && !view.status.last.ok && <Text style={[t.meta, { color: c.statusWarning }]}>The last sweep failed{view.status.last.error ? `: ${view.status.last.error}` : ""}. This is {view.status.sweptAt ? `${hhmm(view.status.sweptAt, tz)}'s` : "the last"} queue.</Text>}
    <View accessibilityRole="tablist" style={{ flexDirection: "row", alignSelf: compact ? "stretch" : "flex-start", padding: 3, gap: 2, borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
      {FILTERS.map(f => {
        const on = f.id === filter;
        return <Pressable key={f.id} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={`${f.label}${view ? `, ${f.count(view)}` : ""}`} onPress={() => setFilter(f.id)}
          style={(s: Hover) => ({ flexGrow: compact ? 1 : 0, alignItems: "center", justifyContent: "center", minHeight: compact ? 44 : 30, paddingHorizontal: 12, borderRadius: 7, backgroundColor: on ? c.surface0 : s.hovered ? withAlpha(c.foreground, 0.05) : "transparent", ...(on ? { borderWidth: 1, borderColor: c.border } : {}), ...focusRing(c, s.focused) })}>
          <Text numberOfLines={1} style={[t.small, { color: on ? c.foreground : c.foregroundMuted, fontWeight: on ? "600" : "400" }]}>{f.label}{view ? ` ${f.count(view)}` : ""}</Text>
        </Pressable>;
      })}
    </View>
    {error && <Text style={[t.meta, { color: c.statusDanger }]}>{error}</Text>}
    {!view && !error && <Text style={t.meta}>Reading the queue…</Text>}
    {view && !view.groups.length && <Text style={t.meta}>{filter === "all" ? "Nothing is assigned to you in the queue's states." : filter === "changed" ? "Nothing changed since you last read the brief." : "Every issue in your queue has a workspace."}</Text>}
    {view?.groups.map(g => <View key={g.priority} style={{ gap: 0 }}>
      <Text accessibilityRole="header" style={[t.section, { marginTop: 8 }]}>{g.name} · {g.count}</Text>
      <PagedRows items={g.issues} resetKey={filter} theme={theme} compact={compact} noun="issues" row={i => <QueueRow key={i.key} i={i} change={changes.get(i.key)} c={c} compact={compact} timeZone={tz} navigation={navigation} />} />
    </View>)}
  </ScrollView>;
}

// ---------- "Nobody's on it": raised issues and urgent Compass asks in Needs you ----------

/**
 * "Nobody's on it" rows (nobody-s-on-it-is-needs-you), shaped like Home's: an amber ↑ for a raise or the compass glyph
 * for a Compass ask, the key, "Nobody's on it", then "title · due Thu"; under it the reason
 * line with its source, as Home's rows carry AI priority's ("Dana: renewal call Thu · Compass", "Linear  Raised Low →
 * Urgent"). One Start… (New on the issue, `{why}` filled) and the two-click Remove of every Needs-you item (invariant
 * 59: follow.dismiss `issue`, which takes the raise and every Compass ask on it).
 */
export function NobodyRows({ theme, compact, data, onDismissed }: { theme: Theme; compact: boolean; data: QueueNeeds; onDismissed: () => void }) {
  const c = theme.colors;
  // The same Dismiss as every Needs-you item (invariant 59): two clicks in place, one toast with Undo. The worker
  // pushes the new list on the home feed; without the feed, onDismissed reads it once.
  const dismiss = useDismiss(onDismissed);
  const now = Date.now();
  return <PagedRows items={data.needs} theme={theme} compact={compact} noun="issues" row={r => {
    const row = nobodyRow(r, now, data.timeZone);
    const first = r.reasons[0]!;
    const reason = <PriorityLine reason={first.line} source={first.from === "compass" ? { kind: "compass", label: first.source } : { kind: "linear", label: first.source }} c={c} size={compact ? 12 : 11} lines={compact ? 2 : 1} />;
    const when = age(r.at, now);
    const start = <BarBtn c={c} compact={compact} small primary={false} disabled={false} b={{ name: "Start…", icon: "Play", key: null }} onPress={() => openNew({ source: r.key })} />;
    const x = <DismissX theme={theme} compact={compact} label={`Remove ${r.key}`} onPress={() => dismiss({ issue: r.key })} />;
    const glyph = <View style={{ width: compact ? 18 : 16, alignItems: "center", paddingTop: compact ? 2 : 0 }}><Icon name={row.compass ? "Compass" : "ArrowUp"} size={compact ? 17 : 15} color={c.statusWarning} /></View>;
    return <RevealScope key={r.key} accessibilityLabel={`Needs you: ${row.label}`}
      style={{ flexDirection: "row", alignItems: compact ? "flex-start" : "center", gap: 10, minHeight: compact ? 56 : 46, paddingLeft: compact ? 14 : 16, paddingRight: compact ? 16 : 16, paddingVertical: compact ? 12 : 5,
        borderLeftWidth: 2, borderLeftColor: withAlpha(c.statusWarning, 0.9), ...(compact ? { borderBottomWidth: 1, borderBottomColor: withAlpha(c.border, 0.6) } : {}) }}>
      {glyph}
      {compact ? <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 15, lineHeight: 20, fontWeight: "500" }}>{row.title}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, paddingTop: 2, fontVariant: ["tabular-nums"] }}>{when}</Text>
        </View>
        <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}><Text style={{ color: c.statusWarning, fontWeight: "600" }}>{row.word}</Text> · {row.line}</Text>
        {reason}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>{start}{x}</View>
      </View> : <>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ flexShrink: 0, color: c.foreground, fontSize: 13, fontWeight: "500" }}>{row.title}</Text>
            <Text numberOfLines={1} style={{ flexShrink: 0, color: c.statusWarning, fontSize: 12 }}>{row.word}</Text>
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 12, marginLeft: -10 }}>{"\u00a0· "}{row.line}</Text>
          </View>
          <View style={{ paddingRight: 40 }}>{reason}</View>
        </View>
        {start}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{when}</Text>
          {x}
        </View>
      </>}
    </RevealScope>;
  }} />;
}
