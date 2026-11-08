import { ActivityIndicator, ScrollView, Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { QUESTION_MODES, QUESTION_MODE_RULES, questionPreferences, type QuestionMode } from "../shared/questions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectSettingsRpc, setProjectTrackingRpc } from "../shared/contracts";
import { errorText, text } from "./kit";
import { DisplaySections } from "./display";

const settingsKey = ["follow-through", "project-settings"];

/** What agents do between asking a question and getting the answer. Applies to questions asked from now on. */
function QuestionSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors;
  const settings = useSettings(questionPreferences);
  const toast = useToast();
  const info = "Agents ask decisions they can't make themselves in Follow-up, with lettered options and a recommendation. The mode tells the agent what to do until you answer, and applies to questions asked from now on. Big questions, ones that would reach outside this computer or that most of the work depends on, always wait.";
  return <SettingsSection title="Questions" info={info}>
    {settings.status === "loading" && <ActivityIndicator accessibilityLabel="Loading question settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {(settings.status === "error" || settings.status === "invalid") && <SettingsCard>
      <SettingsAction label="Couldn't load the question mode" hint={settings.error} actionLabel="Retry" onPress={() => void settings.reload()} />
      {settings.status === "invalid" && <SettingsAction label="Use the default, Work around" actionLabel="Reset" disabled={settings.saving} onPress={() => void settings.reset()} />}
    </SettingsCard>}
    {settings.status === "ready" && <SettingsCard>
      <SettingsSelect<QuestionMode> label="While a question is open" hint={QUESTION_MODE_RULES[settings.values.mode].hint} value={settings.values.mode} disabled={settings.saving}
        options={QUESTION_MODES.map(mode => ({ value: mode, label: QUESTION_MODE_RULES[mode].label }))}
        onValueChange={mode => { void settings.save({ ...settings.values, mode }, settings.revision).then(saved => { if (saved) toast.show(`Questions: ${QUESTION_MODE_RULES[mode].label}`, { variant: "success" }); }, () => undefined); }} />
    </SettingsCard>}
    {settings.status === "ready" && settings.saveError && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{settings.saveError}</Text>}
  </SettingsSection>;
}

/**
 * Follow-up's one settings screen: Projects (tracking per project), Questions, Sidebar & pills and the
 * Needs-you inbox. Each project switch is one project; the hint shows which repository it is.
 */
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
    <SettingsSection title="Projects" info="When a project is on, Follow-up tracks its existing and new workspaces as soon as each has a main agent. Turning it off stops new tracking and keeps everything already tracked. Auto-send starts on for a newly tracked workspace, so review threads and red CI go to the agent, and Follow-up never merges, requests reviewers or archives on its own.">
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
    <QuestionSettings theme={theme} />
    <DisplaySections theme={theme} />
  </ScrollView>;
}
