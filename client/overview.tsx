import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { listRpc } from "../shared/contracts";
import { summary, type Status } from "../shared/model";
import { Button, colorFor } from "./components";
import { overviewKey } from "./panel";

export function FollowOverview({ theme, layout, navigation }: PluginSurfaceProps) {
  const list = useRpc(listRpc);
  const [showArchived, setShowArchived] = useState(false);
  const query = useQuery({ queryKey: overviewKey, queryFn: () => list({}), refetchInterval: 5000 });
  const groups: { status: Status; title: string }[] = [{ status: "needs-you", title: "Needs you" }, { status: "handling", title: "Agent handling" }, { status: "waiting", title: "Waiting" }, { status: "active", title: "Active" }, { status: "done", title: "Done · ready to archive" }];
  const workspaces = (query.data?.workspaces ?? []).filter(w => !w.archived || showArchived);
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 8, maxWidth: 960, width: "100%", alignSelf: "center", paddingBottom: 40 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}><View style={{ flex: 1, gap: 7 }}><Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>Workspace follow-up</Text><Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>What needs you, what the agents are handling, and what is finished.</Text></View><Button title="Refresh" icon="RefreshCw" theme={theme} compact={layout.compact} onPress={() => void query.refetch()} /></View>
    {query.isPending && <ActivityIndicator color={theme.colors.accent} />}{(query.error || query.data?.error) && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>Could not refresh all workspace state. Try Refresh.</Text>}
    {!query.isPending && !query.error && !workspaces.length && <View style={{ marginTop: 28, gap: 9 }}><Text style={{ color: theme.colors.foreground, fontSize: 16 }}>No workspaces tracked yet</Text><Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>Open Follow-up in a workspace and click Track this workspace. Tracking and messages stay scoped to workspaces you choose.</Text></View>}
    {groups.map(group => {
      const rows = workspaces.filter(w => summary(w).status === group.status);
      if (!rows.length) return null;
      return <View key={group.status} style={{ marginTop: 24, gap: 9 }}><View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><Text style={{ color: colorFor(theme, group.status), fontSize: 14, fontWeight: "600" }}>{group.title}</Text><Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{rows.length}</Text></View>{rows.map(w => <Pressable key={w.id} accessibilityRole="button" accessibilityLabel={`Open ${w.title}`} disabled={!navigation} onPress={() => navigation?.openWorkspace({ workspaceId: w.id })} style={({ pressed }) => ({ paddingVertical: 14, borderTopWidth: 1, borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surface1 : "transparent", flexDirection: "row", alignItems: "flex-start", gap: 12 })}><Icon name={group.status === "done" ? "CircleCheck" : group.status === "needs-you" ? "CircleAlert" : "GitPullRequest"} size={17} color={colorFor(theme, group.status)} /><View style={{ flex: 1, gap: 6 }}><Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{w.title}{w.archived ? " · archived" : ""}</Text><Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{summary(w).reason}</Text><Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{new Set(w.prs.map(p => p.stack)).size} stacks · {w.prs.length} PRs · {w.obligations.filter(o => !["done", "waived"].includes(o.status)).length} remaining tasks</Text></View>{navigation && <Icon name="ArrowUpRight" size={14} color={theme.colors.foregroundMuted} />}</Pressable>)}</View>;
    })}
    {query.data?.workspaces.some(w => w.archived) && <Button title={showArchived ? "Hide archived workspaces" : "Show archived history"} theme={theme} compact={layout.compact} onPress={() => setShowArchived(!showArchived)} />}
  </ScrollView>;
}
