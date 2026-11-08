import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@getpaseo/plugin/client/ui";
import { listRpc } from "../shared/contracts";
import type { Status, Workspace } from "../shared/model";
import { followUpObligations } from "../shared/follow-up";
import { ago, liveLine, needsYou, overviewStatus, stackBar, statusGroups } from "../shared/attention";
import { summary } from "../shared/model";
import { Button, IconButton, text, useNow, type Theme } from "./kit";
import { StackBar } from "./header";
import { Skeleton } from "./motion";
import { raised, type Colors } from "./theme";
import { overviewKey } from "./needs-you";
import { SpecChip } from "./spec";
import { InboxSections, UndoBar, useInbox, useNextRelay } from "./inbox";
import type { InboxStore } from "./inbox-store";
import type { InboxRow } from "../shared/inbox";

// Accent stays for actions: working is plain foreground, waiting is muted, and only Done is green.
export const statusColor = (c: Colors, status: Status) => status === "done" ? c.statusSuccess : status === "needs-you" ? c.statusWarning : status === "handling" ? c.foreground : c.foregroundMuted;
const statusIcon = (status: Status) => status === "done" ? "CircleCheck" : status === "needs-you" ? "CircleAlert" : status === "handling" ? "LoaderCircle" : status === "waiting" ? "Clock" : "GitPullRequest";

function reasonFor(w: Workspace, status: Status, now: number): string {
  if (status === "needs-you") {
    const items = needsYou(w, now);
    const first = items[0]?.kind === "question" && items[0].state === "stopped" ? `Agent stopped · ${items[0].title}` : items[0]?.title;
    return items.length > 1 ? `${first} · and ${items.length - 1} more` : first ?? summary(w, now).reason;
  }
  if (status === "done") return w.completion?.summary ?? "Ready to archive";
  return liveLine(w, now).text;
}

function WorkspaceRow({ w, theme, compact, now, onOpen, first }: { w: Workspace; theme: Theme; compact: boolean; now: number; onOpen?: () => void; first: boolean }) {
  const c = theme.colors; const t = text(c);
  const status = overviewStatus(w, now);
  const bar = stackBar(w);
  const left = followUpObligations(w).filter(o => !["done", "waived"].includes(o.status)).length;
  const meta = [bar.total ? bar.merged === bar.total ? `${bar.total} merged` : `${bar.merged} of ${bar.total} merged` : "No PRs yet", left ? `${left} task${left === 1 ? "" : "s"} left` : null, w.enable_auto_sends ? "Auto-send on" : null].filter(Boolean).join(" · ");
  return <Pressable accessibilityRole="button" accessibilityLabel={`${w.title}. ${statusGroups.find(g => g.status === status)?.title}. Open workspace`} disabled={!onOpen} onPress={onOpen}
    style={state => ({ flexDirection: "row", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ paddingTop: 2 }}><Icon name={statusIcon(status)} size={16} color={statusColor(c, status)} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={[t.label, { flex: 1, fontSize: 14, lineHeight: 19 }]}>{w.title}{w.archived ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}> · archived</Text> : null}</Text>
        {!!w.spec?.url && <View style={{ marginVertical: -4 }}><SpecChip workspace={w} theme={theme} compact={false} /></View>}
        <Text style={[t.small, { fontVariant: ["tabular-nums"] }]}>{ago(w.updatedAt, now)}</Text>
      </View>
      <Text numberOfLines={2} style={[t.meta, { color: status === "needs-you" ? c.foreground : c.foregroundMuted }]}>{reasonFor(w, status, now)}</Text>
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: compact ? 6 : 10, marginTop: 3 }}>
        {bar.total > 0 && <View style={{ width: compact ? "100%" : 140 }}><StackBar workspace={w} theme={theme} height={4} /></View>}
        <Text numberOfLines={1} style={[t.small, { fontVariant: ["tabular-nums"] }]}>{meta}</Text>
      </View>
    </View>
    {onOpen && <View style={{ paddingTop: 2 }}><Icon name="ChevronRight" size={15} color={c.foregroundMuted} /></View>}
  </Pressable>;
}

export function FollowOverview({ theme, layout, navigation, openSettings, params = {}, inbox }: PluginScreenProps & { openSettings: () => void; inbox: InboxStore }) {
  const c = theme.colors; const t = text(c);
  const openAgent = navigation ? (row: InboxRow) => navigation.openAgent({ agentId: row.agentId }) : undefined;
  useNextRelay(inbox, params, openAgent);
  const inboxOn = useInbox(inbox, () => inbox.enabled());
  const list = useRpc(listRpc);
  const now = useNow(30_000);
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<Status | "all">("all");
  const query = useQuery({ queryKey: overviewKey, queryFn: () => list({}), refetchInterval: 5000 });
  const compact = layout.compact;
  const all = query.data?.workspaces ?? [];
  const archived = all.filter(w => w.archived).length;
  const workspaces = all.filter(w => !w.archived || showArchived);
  const counts = new Map<Status, number>(statusGroups.map(g => [g.status, workspaces.filter(w => overviewStatus(w, now) === g.status).length]));
  const need = counts.get("needs-you") ?? 0;
  const groups = statusGroups.filter(g => filter === "all" || g.status === filter);
  const chip = (id: Status | "all", label: string, count: number, color?: string) => {
    const selected = filter === id;
    return <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected }} aria-selected={selected} accessibilityLabel={`${label}, ${count}`} onPress={() => setFilter(id)}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: compact ? 40 : 30, paddingHorizontal: 11, borderRadius: 999, backgroundColor: selected ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent", borderWidth: 1, borderColor: selected ? c.border : "transparent" })}>
      {color && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />}
      <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{count}</Text>
    </Pressable>;
  };
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 28, paddingBottom: 48, maxWidth: 880, width: "100%", alignSelf: "center", gap: 14 }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text accessibilityRole="header" style={[t.title, { fontSize: 20, lineHeight: 26 }]}>Tracked workspaces</Text>
        <Text style={t.meta}>{query.isPending ? "Loading…" : workspaces.length ? `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}${need ? "" : " · nothing needs you"}` : "None yet"}{need ? <Text style={{ color: c.statusWarning, fontWeight: "600" }}>{` · ${need} need${need === 1 ? "s" : ""} you`}</Text> : null}</Text>
      </View>
      <IconButton icon="RefreshCw" label="Refresh" onPress={() => void query.refetch()} theme={theme} compact={compact} spinning={query.isRefetching} />
      <IconButton icon="Settings" label="Follow-up settings" onPress={openSettings} theme={theme} compact={compact} />
    </View>
    {(query.error || query.data?.error) && <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.statusWarning }}>
      <View style={{ paddingTop: 2 }}><Icon name="TriangleAlert" size={14} color={c.statusWarning} /></View>
      <Text style={[t.meta, { flex: 1, color: c.statusWarning }]}>{query.error ? "Couldn't refresh tracked workspaces. Showing what was last loaded." : query.data?.error}</Text>
    </View>}
    {inboxOn && <View style={{ borderRadius: 10, backgroundColor: c.surface0, ...raised(c), paddingHorizontal: compact ? 4 : 8, paddingVertical: 6 }}>
      <InboxSections store={inbox} theme={theme} touch={compact} dense={false} nav={{ openAgent }} />
    </View>}
    {inboxOn && <UndoBar store={inbox} theme={theme} touch={compact} />}
    {workspaces.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginHorizontal: compact ? -16 : 0 }} contentContainerStyle={{ gap: 4, paddingHorizontal: compact ? 16 : 0 }}>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4 }}>
        {chip("all", "All", workspaces.length)}
        {statusGroups.filter(g => (counts.get(g.status) ?? 0) > 0).map(g => chip(g.status, g.short, counts.get(g.status) ?? 0, statusColor(c, g.status)))}
      </View>
    </ScrollView>}
    {query.isPending && <View style={{ borderRadius: 10, ...raised(c), padding: 14, gap: 12 }}>{[0, 1, 2].map(i => <View key={i} style={{ gap: 7 }}><Skeleton width="40%" height={11} color={c.surface2} /><Skeleton width="75%" height={9} color={c.surface2} /></View>)}</View>}
    {!query.isPending && !workspaces.length && <View style={{ borderRadius: 10, ...raised(c), padding: compact ? 16 : 20, gap: 10 }}>
      <Icon name="GitPullRequest" size={20} color={c.foregroundMuted} />
      <Text style={[t.label, { fontSize: 14 }]}>No tracked workspaces yet</Text>
      <Text style={t.meta}>Open a workspace, open Follow-up from its side panel or header, and choose Track this workspace. To track a whole project's workspaces automatically, turn the project on in settings.</Text>
      <Button theme={theme} compact={compact} icon="Settings" title="Project settings" onPress={openSettings} />
    </View>}
    {groups.map(group => {
      // Within Needs you, a workspace whose agent stopped for a question comes first.
      const stopped = (w: Workspace) => Number(needsYou(w, now).some(i => i.kind === "question" && i.state === "stopped"));
      const rows = workspaces.filter(w => overviewStatus(w, now) === group.status).sort((a, b) => stopped(b) - stopped(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      if (!rows.length) return null;
      return <View key={group.status} style={{ gap: 8, marginTop: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text accessibilityRole="header" style={[t.label, { color: statusColor(c, group.status) }]}>{group.title}</Text>
          <Text style={[t.small, { fontVariant: ["tabular-nums"] }]}>{rows.length}</Text>
        </View>
        <View style={{ borderRadius: 10, overflow: "hidden", backgroundColor: c.surface0, ...raised(c) }}>
          {rows.map((w, i) => <WorkspaceRow key={w.id} w={w} theme={theme} compact={compact} now={now} first={i === 0} onOpen={navigation && !w.archived ? () => navigation.openWorkspace({ workspaceId: w.id }) : undefined} />)}
        </View>
      </View>;
    })}
    {archived > 0 && <Button theme={theme} compact={compact} kind="ghost" icon={showArchived ? "EyeOff" : "Archive"} title={showArchived ? "Hide archived workspaces" : `Show ${archived} archived`} onPress={() => setShowArchived(!showArchived)} />}
  </ScrollView>;
}
