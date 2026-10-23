import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectSettingsRpc, setProjectTrackingRpc } from "../shared/contracts";
import { Button } from "./components";

export function FollowSettings({ theme, layout }: PluginSurfaceProps) {
  const read = useRpc(projectSettingsRpc); const write = useRpc(setProjectTrackingRpc); const cache = useQueryClient();
  const query = useQuery({ queryKey: ["follow-through", "project-settings"], queryFn: () => read({}), refetchInterval: 15000 });
  const change = useMutation({ mutationFn: (input: Parameters<typeof write>[0]) => write(input), onSuccess: value => { cache.setQueryData(["follow-through", "project-settings"], value); void cache.invalidateQueries({ queryKey: ["follow-through", "overview"] }); void cache.invalidateQueries({ queryKey: ["follow-through", "workspace"] }); } });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 14, maxWidth: 820, width: "100%", alignSelf: "center", paddingBottom: 40 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}><Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600", flex: 1 }}>Follow-up settings</Text><Button title="Refresh" icon="RefreshCw" theme={theme} compact={layout.compact} onPress={() => void query.refetch()} /></View>
    <Text style={muted}>Choose which projects track workspaces by default. Turning a project on adds its existing and new workspaces when a main agent is available. Turning it off keeps workspaces already tracked.</Text>
    <Text style={muted}>Auto sends stay off for newly tracked workspaces. Recovery and follow-up wait for your click unless you turn on Auto in that workspace.</Text>
    <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", marginTop: 12 }}>Default tracking by project</Text>
    {query.isPending && <ActivityIndicator color={theme.colors.accent} />}
    {(query.error || change.error) && <Text accessibilityRole="alert" style={{ ...muted, color: theme.colors.statusDanger }}>{change.error?.message ?? query.error?.message}</Text>}
    {query.data?.projects.length === 0 && <Text style={muted}>Projects appear here after you add them to Paseo.</Text>}
    {query.data?.projects.map(project => <Pressable key={project.id} accessibilityRole="switch" accessibilityLabel={`Default tracking for ${project.name}, ${project.key}`} aria-checked={project.enable_default_tracking} accessibilityState={{ checked: project.enable_default_tracking, disabled: change.isPending }} disabled={change.isPending} onPress={() => change.mutate({ projectId: project.id, enable_default_tracking: !project.enable_default_tracking })} style={({ pressed }) => ({ minHeight: layout.compact ? 64 : 58, paddingVertical: 12, borderTopWidth: 1, borderColor: theme.colors.border, flexDirection: "row", alignItems: "center", gap: 16, backgroundColor: pressed ? theme.colors.surface1 : "transparent", opacity: change.isPending && change.variables?.projectId === project.id ? 0.5 : 1 })}>
      <View style={{ flex: 1, gap: 4 }}><Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{project.name}</Text><Text style={{ ...muted, fontSize: 12 }}>{project.key.startsWith("remote:") ? project.key.slice(7) : project.path}</Text></View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={muted}>{project.enable_default_tracking ? "On" : "Off"}</Text><View style={{ width: 30, height: 18, borderRadius: 9, backgroundColor: project.enable_default_tracking ? theme.colors.accent : theme.colors.surface2, borderWidth: 1, borderColor: project.enable_default_tracking ? theme.colors.accent : theme.colors.border }}><View style={{ width: 12, height: 12, borderRadius: 6, position: "absolute", top: 2, left: project.enable_default_tracking ? 14 : 2, backgroundColor: project.enable_default_tracking ? theme.colors.accentForeground : theme.colors.foregroundMuted }} /></View></View>
    </Pressable>)}
    {change.isSuccess && <Text accessibilityLiveRegion="polite" style={muted}>Project default saved.</Text>}
  </ScrollView>;
}
