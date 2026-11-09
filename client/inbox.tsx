import { useEffect, useRef, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { flagHeadline, type Headline } from "../shared/headline";
import { nextAfter, snoozeUntil, type InboxRow } from "../shared/inbox";
import { Button, type Theme } from "./kit";
import { raised } from "./theme";
import type { InboxStore } from "./inbox-store";


export function useInbox<T>(store: InboxStore, select: () => T): T {
  useSyncExternalStore(store.subscribe, store.version, store.version);
  return select();
}

/** The row's headline, the same one the pill and the brief card use. A snoozed row keeps its reason, in muted tones. */
export const rowHeadline = (row: InboxRow, now: number): Headline | null => flagHeadline({ ...row, snooze: null }, now);

/** The undo bar: in-surface, so it can carry an Undo action that host toasts can't. Lasts 6 s. */
export function UndoBar({ store, theme, touch }: { store: InboxStore; theme: Theme; touch: boolean }) {
  const c = theme.colors;
  const recent = useInbox(store, () => store.recent());
  useEffect(() => {
    if (!recent) return;
    const id = setTimeout(() => store.clearRecent(), Math.max(0, 6_000 - (Date.now() - recent.at)));
    return () => clearTimeout(id);
  }, [recent, store]);
  if (!recent) return null;
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch ? 52 : 40, paddingLeft: 12, paddingRight: 4, borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, ...raised(c) }}>
    <Icon name="CircleCheck" size={15} color={c.statusSuccess} />
    <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12 }}>Signed off <Text style={{ color: c.foregroundMuted }}>{recent.label}</Text></Text>
    <Button theme={theme} compact={touch} kind="ghost" icon="Undo2" title="Undo" onPress={() => void store.undo()} />
  </View>;
}

/** Whether the Phase 2 sidebar view is mounted: it lists the same agents, so the sidebar item's badge would repeat it. */
const sidebarViews = { mounted: 0, listeners: new Set<() => void>() };
const subscribeSidebarViews = (fn: () => void) => { sidebarViews.listeners.add(fn); return () => { sidebarViews.listeners.delete(fn); }; };
export function useSidebarViewMounted() {
  useEffect(() => {
    sidebarViews.mounted += 1; sidebarViews.listeners.forEach(fn => fn());
    return () => { sidebarViews.mounted -= 1; sidebarViews.listeners.forEach(fn => fn()); };
  }, []);
}
export function useSidebarViewActive(): boolean {
  return useSyncExternalStore(subscribeSidebarViews, () => sidebarViews.mounted > 0, () => false);
}

/** ⌘K items and /ok. The keyboard path is ⌘K, "ok", Enter. */
export function contributeInboxCommands(client: PluginClientContext, store: InboxStore, openNext: (from: string | null) => void) {
  const removers = [
    client.addCommandCenterItem({ id: "inbox-sign-off-next", title: "Follow-up: Sign off & next", icon: "ArrowRight", keywords: ["ok", "done", "ack", "needs you", "sign off", "next"], context: "agent",
      onSelect({ agent }) { void store.signOff([agent.id]); openNext(agent.id); } }),
    client.addCommandCenterItem({ id: "inbox-sign-off", title: "Follow-up: sign off", icon: "Check", keywords: ["ok", "done", "ack", "needs you", "sign off"], context: "agent",
      onSelect({ agent }) { void store.signOff([agent.id]); } }),
    client.addCommandCenterItem({ id: "inbox-later", title: "Follow-up: Later (tomorrow 09:00)", icon: "AlarmClock", keywords: ["ok", "snooze", "later", "needs you"], context: "agent",
      onSelect({ agent }) { void store.snooze([agent.id], snoozeUntil("tomorrow", new Date())); } }),
    client.addCommandCenterItem({ id: "inbox-undo", title: "Follow-up: undo last sign-off", icon: "Undo2", keywords: ["ok", "undo", "needs you", "sign off"], context: "global",
      onSelect() { void store.undo(); } }),
    client.addCommandCenterItem({ id: "inbox-next", title: "Follow-up: Next needs-you", icon: "Inbox", keywords: ["ok", "next", "needs you", "inbox"], context: "global",
      onSelect() { openNext(null); } }),
    client.addSlashCommand({ name: "ok", description: "Sign off this agent (Needs you). /ok next opens the next one", argumentHint: "[next]", context: "agent",
      onSubmit({ agent, args }) { void store.signOff([agent.id]); if (/^\s*next\b/i.test(args)) openNext(agent.id); } }),
  ];
  return () => { for (const r of removers) r(); };
}

/** "Sign off & next" target, honouring D9 and skipping the agent just signed off. */
export function nextTarget(store: InboxStore, from: string | null): InboxRow | null {
  return nextAfter(store.rows(), from, Date.now());
}

/** Follow-up's screen relays "& next": opening the screen with `next` hands off to the host's navigation. */
export function useNextRelay(store: InboxStore, params: Record<string, string>, openAgent: ((row: InboxRow) => void) | undefined) {
  const done = useRef<string | null>(null);
  const ready = useInbox(store, () => !!store.data());
  useEffect(() => {
    const token = params.next;
    if (!token || !openAgent || !ready || done.current === token) return;
    done.current = token;
    // The brief card can't navigate on its own (timeline items get no navigation), so it relays "open this agent" here.
    if (params.open) { openAgent({ agentId: params.open } as InboxRow); return; }
    const target = nextTarget(store, params.from ?? null);
    if (target) openAgent(target);
  }, [params.next, params.from, params.open, ready, openAgent, store]);
}
