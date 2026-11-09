import { useState } from "react";
import { ActivityIndicator, ScrollView, Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { QUESTION_MODES, QUESTION_MODE_RULES, questionPreferences, type QuestionMode } from "../shared/questions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { followSettingsRpc, projectSettingsRpc, setFollowSettingsRpc, setProjectTrackingRpc } from "../shared/contracts";
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

const followKey = ["follow-through", "follow-settings"];

/**
 * Following (1.3.0-beta.2): Follow-up follows every workspace by default, so tracking never shows anywhere else.
 * The rare exception is a per-workspace switch here, next to that workspace's own auto-send switch.
 */
function FollowingSettings({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors; const t = text(c);
  const read = useRpc(followSettingsRpc); const write = useRpc(setFollowSettingsRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: followKey, queryFn: () => read({}), refetchInterval: 30000 });
  const [picked, setPicked] = useState("");
  const change = useMutation({
    mutationFn: (input: Parameters<typeof write>[0]) => write(input),
    onSuccess: value => { cache.setQueryData(followKey, value); void cache.invalidateQueries({ queryKey: settingsKey }); },
    onError: error => toast.error(errorText(error)),
  });
  const data = query.data;
  const chosen = data?.workspaces.find(w => w.id === picked) ?? null;
  const exceptions = data?.workspaces.filter(w => w.optedOut || (w.enable_tracking && w.enable_auto_sends !== data.enable_auto_sends_default)) ?? [];
  return <>
    <SettingsSection title="Following" info="Follow-up follows every workspace's PR stack, tasks and repairs as soon as the workspace has an agent. Turn Follow every workspace off to follow only the projects switched on below. Follow-up never merges, requests reviewers or archives on its own.">
      {query.isPending && <ActivityIndicator accessibilityLabel="Loading following settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
      {query.error && <SettingsCard><SettingsAction label="Couldn't load following settings" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
      {data && <SettingsCard>
        <SettingsSwitch label="Follow every workspace" hint="New and existing workspaces, except the exceptions below." value={data.enable_follow_every} disabled={change.isPending}
          onValueChange={value => change.mutate({ enable_follow_every: value })} />
        <SettingsSwitch label="Send repairs automatically" hint="Review threads and red CI go to the workspace's agent on their own. Applies to workspaces Follow-up starts following from now on." value={data.enable_auto_sends_default} disabled={change.isPending}
          onValueChange={value => change.mutate({ enable_auto_sends_default: value })} />
      </SettingsCard>}
    </SettingsSection>
    {!!data?.workspaces.length && <SettingsSection title="Workspace exceptions" info="Stop following one workspace, or change its auto-send. Following it again picks up its PRs on the next refresh.">
      <SettingsCard>
        <SettingsSelect label="Workspace" value={picked} options={[{ value: "", label: "Choose a workspace" }, ...data.workspaces.map(w => ({ value: w.id, label: w.title }))]} onValueChange={setPicked} />
        {chosen && <SettingsSwitch label="Follow this workspace" value={!chosen.optedOut && chosen.enable_tracking} disabled={change.isPending}
          onValueChange={value => change.mutate({ workspace: { workspaceId: chosen.id, follow: value } }, { onSuccess: () => toast.show(value ? `Following ${chosen.title}` : `Stopped following ${chosen.title}`, { variant: "success" }) })} />}
        {chosen && !chosen.optedOut && chosen.enable_tracking && <SettingsSwitch label="Send repairs automatically" value={chosen.enable_auto_sends} disabled={change.isPending}
          onValueChange={value => change.mutate({ workspace: { workspaceId: chosen.id, enable_auto_sends: value } })} />}
      </SettingsCard>
      {exceptions.length > 0 && <SettingsCard>
        {exceptions.map(w => <SettingsAction key={w.id} label={w.title} hint={w.optedOut || !w.enable_tracking ? "Not followed" : w.enable_auto_sends ? "Sends repairs automatically" : "Repairs wait for you"}
          actionLabel="Edit" onPress={() => setPicked(w.id)} />)}
      </SettingsCard>}
      {!exceptions.length && <Text style={t.meta}>No exceptions. Every workspace is followed the same way.</Text>}
    </SettingsSection>}
  </>;
}

/**
 * Follow-up's one settings screen: Following (and its exceptions), Projects, Questions, Sidebar & pills and the
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
      toast.show(input.enable_default_tracking ? `Following ${project?.name ?? "the project"}'s workspaces` : `New ${project?.name ?? "project"} workspaces won't be followed`, { variant: "success" });
      void cache.invalidateQueries({ queryKey: ["follow-through", "overview"] }); void cache.invalidateQueries({ queryKey: ["follow-through", "workspace"] }); void cache.invalidateQueries({ queryKey: followKey });
    },
    onError: error => toast.error(errorText(error)),
  });
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 18, maxWidth: 720, width: "100%", alignSelf: "center", paddingBottom: 40 }}>
    <FollowingSettings theme={theme} />
    <SettingsSection title="Projects" info="Turn a project off to stop following its new workspaces. Workspaces already followed stay followed; stop one under Workspace exceptions.">
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
