import { ActivityIndicator, ScrollView, Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectSettingsRpc, setProjectTrackingRpc } from "../shared/contracts";
import { errorText, text } from "./kit";

const settingsKey = ["follow-through", "project-settings"];

/** Per-project default tracking. Each switch is one project; the hint shows which repository it is. */
export function FollowSettings({ theme, layout }: PluginSurfaceProps) {
  const c = theme.colors; const t = text(c);
  const read = useRpc(projectSettingsRpc); const write = useRpc(setProjectTrackingRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: settingsKey, queryFn: () => read({}), refetchInterval: 15000 });
  const change = useMutation({
    mutationFn: (input: Parameters<typeof write>[0]) => write(input),
    onSuccess: (value, input) => {
      cache.setQueryData(settingsKey, value);
      const project = value.projects.find(p => p.id === input.projectId);
      toast.show(input.enable_default_tracking ? `Tracking ${project?.name ?? "the project"}'s workspaces` : `New ${project?.name ?? "project"} workspaces won't be tracked`, { variant: "success" });
      void cache.invalidateQueries({ queryKey: ["follow-through", "overview"] }); void cache.invalidateQueries({ queryKey: ["follow-through", "workspace"] });
    },
    onError: error => toast.error(errorText(error)),
  });
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 18, maxWidth: 720, width: "100%", alignSelf: "center", paddingBottom: 40 }}>
    <SettingsSection title="Track by project" info="When a project is on, Follow-up tracks its existing and new workspaces as soon as each has a main agent. Turning it off stops new tracking and keeps everything already tracked. Auto-send starts off for every newly tracked workspace, and Follow-up never merges, requests reviewers or archives on its own.">
      {query.isPending && <ActivityIndicator accessibilityLabel="Loading projects" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
      {query.error && <SettingsCard><SettingsAction label="Couldn't load projects" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
      {query.data?.projects.length === 0 && <Text style={t.meta}>Projects appear here once you add them to Paseo.</Text>}
      {!!query.data?.projects.length && <SettingsCard>
        {query.data.projects.map(project => <SettingsSwitch key={project.id} label={project.name}
          hint={project.key.startsWith("remote:") ? project.key.slice(7) : project.path}
          value={project.enable_default_tracking} disabled={change.isPending}
          onValueChange={value => change.mutate({ projectId: project.id, enable_default_tracking: value })} />)}
      </SettingsCard>}
    </SettingsSection>
  </ScrollView>;
}
