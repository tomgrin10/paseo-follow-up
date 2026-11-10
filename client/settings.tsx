import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { QUESTION_MODES, QUESTION_MODE_RULES, questionPreferences, type QuestionMode } from "../shared/questions";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { followSettingsRpc, projectSettingsRpc, setFollowSettingsRpc, setProjectTrackingRpc } from "../shared/contracts";
import { Switch, bottomInset, errorText, space, text, type Theme } from "./kit";
import { DisplaySections, PermissionsSection, PreferenceSwitch } from "./display";
import { ReviewerSettings, reviewerSettingsKey } from "./reviewers";
import { AgentSettings, WaitSettings, agentSettingsKey } from "./agents";
import { ShippingSettings } from "./shipping";
import { BackHeader, CategoryList, CategoryTabs, Disclosure } from "./settings-shell";
import {
  categoryTitle, followingSummary, hasSavedCategory, projectsOpenByDefault, projectsSummary, readCategory, reviewersSummary, workspaceRows, workspaceState, workspacesOpenByDefault, workspacesSummary,
  writeCategory, type SettingsCategory, type WorkspaceSetting,
} from "../shared/settings-nav";
import type { AgentSettingsView } from "../shared/agent-settings";
import type { ReviewerConfig } from "../shared/reviewers";

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
 * Following: the three switches, then Projects and Workspaces as folds. Both lists are exceptions to "Follow every
 * workspace", so they stay next to it. Workspaces replaces the old 100-option select: search, exceptions first,
 * one row open at a time, 25 rows and "Show more".
 */
function FollowingCategory({ theme, compact, openSetup }: { theme: Theme; compact: boolean; openSetup?: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(followSettingsRpc); const write = useRpc(setFollowSettingsRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: followKey, queryFn: () => read({}), refetchInterval: 30000 });
  const change = useMutation({
    mutationFn: (input: Parameters<typeof write>[0]) => write(input),
    onSuccess: value => { cache.setQueryData(followKey, value); void cache.invalidateQueries({ queryKey: settingsKey }); },
    onError: error => toast.error(errorText(error)),
  });
  const data = query.data;
  const windowDays = data?.activeWindowDays ?? 3;
  return <>
    {openSetup && <SettingsCard><SettingsAction label="Set up Follow-up again" hint="Check GitHub and the helper agents, and review what Follow-up does on its own. About two minutes." actionLabel="Open setup" onPress={openSetup} /></SettingsCard>}
    <SettingsSection title="Defaults" info="Follow-up follows every workspace's PR stack, tasks and repairs as soon as the workspace has an agent. Turn Follow every workspace off to follow only the projects switched on below. Follow-up never merges, requests reviewers or archives on its own.">
      {query.isPending && <ActivityIndicator accessibilityLabel="Loading following settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
      {query.error && <SettingsCard><SettingsAction label="Couldn't load following settings" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
      {data && <SettingsCard>
        <SettingsSwitch label="Follow every workspace" hint="New and existing workspaces, except the ones turned off under Workspaces below." value={data.enable_follow_every} disabled={change.isPending}
          onValueChange={value => change.mutate({ enable_follow_every: value })} />
        <SettingsSwitch label="Send repairs automatically" hint="Review threads and red CI go to the workspace's agent on their own. Applies to workspaces Follow-up starts following from now on." value={data.enable_auto_sends_default} disabled={change.isPending}
          onValueChange={value => change.mutate({ enable_auto_sends_default: value })} />
        <SettingsSelect label="Rest workspaces after" hint="A workspace rests when you haven't messaged it in this long, its agent isn't loaded and it has no open PR. It stays listed, but isn't checked and gets nothing sent until you start a turn there."
          value={String(windowDays)} disabled={change.isPending}
          options={[...new Set([1, 3, 7, 14, windowDays])].sort((a, b) => a - b).map(d => ({ value: String(d), label: d === 1 ? "1 day" : `${d} days` }))}
          onValueChange={value => change.mutate({ activeWindowDays: Number(value) })} />
      </SettingsCard>}
    </SettingsSection>
    <ShippingSettings theme={theme} compact={compact} />
    <PermissionsSection theme={theme} />
    <ProjectsFold theme={theme} compact={compact} />
    {data && (data.workspaces.length
      ? <WorkspacesFold theme={theme} compact={compact} all={data.workspaces} autoDefault={data.enable_auto_sends_default} busy={change.isPending}
        set={(workspace, label) => change.mutate({ workspace }, { onSuccess: () => { if (label) toast.show(label, { variant: "success" }); } })} />
      : <Text style={t.meta}>Workspaces appear here once they have an agent.</Text>)}
  </>;
}

function ProjectsFold({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
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
  const projects = query.data?.projects;
  if (query.isPending) return <ActivityIndicator accessibilityLabel="Loading projects" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />;
  if (query.error || !projects) return <SettingsCard><SettingsAction label="Couldn't load projects" hint={query.error ? errorText(query.error) : undefined} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>;
  if (!projects.length) return <Text style={t.meta}>Projects appear here once you add them to Paseo.</Text>;
  return <Disclosure id="following.projects" title="Projects" summary={projectsSummary(projects)} defaultOpen={projectsOpenByDefault(projects.length)} theme={theme} compact={compact}>
      <Text style={[t.meta, { paddingHorizontal: 14, paddingTop: 10 }]}>With Follow every workspace on, a project that's off stops following its new workspaces; ones already followed stay followed (turn one off under Workspaces). With it off, only the projects on here are followed.</Text>
      <View style={{ padding: 8 }}><SettingsCard>
        {projects.map(project => <SettingsSwitch key={project.id} label={project.name}
          hint={project.key.startsWith("remote:") ? project.key.slice(7) : project.path.split("/").filter(Boolean).slice(-2).join("/")}
          value={project.enable_default_tracking} disabled={change.isPending}
          onValueChange={value => change.mutate({ projectId: project.id, enable_default_tracking: value })} />)}
      </SettingsCard></View>
    </Disclosure>;
}

function WorkspacesFold({ theme, compact, all, autoDefault, busy, set }: { theme: Theme; compact: boolean; all: WorkspaceSetting[]; autoDefault: boolean; busy: boolean;
  set: (w: { workspaceId: string; follow?: boolean; enable_auto_sends?: boolean }, toast?: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const [q, setQ] = useState("");
  const [cap, setCap] = useState(25);
  const [openId, setOpenId] = useState<string | null>(null);
  const view = workspaceRows(all, autoDefault, q, cap);
  return <Disclosure id="following.workspaces" title="Workspaces" summary={workspacesSummary(all, autoDefault)} defaultOpen={workspacesOpenByDefault(view.exceptions)} theme={theme} compact={compact}>
    <View style={{ padding: 10, paddingBottom: 6 }}>
      <TextInput accessibilityLabel="Search workspaces" value={q} onChangeText={v => { setQ(v); setOpenId(null); }} placeholder={`Search ${all.length} workspaces`} placeholderTextColor={c.foregroundMuted}
        autoCapitalize="none" autoCorrect={false}
        style={{ minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0 }} />
    </View>
    {!view.rows.length && <Text style={[t.meta, { paddingHorizontal: 14, paddingBottom: 12 }]}>{`No workspace matches "${q.trim()}".`}</Text>}
    {view.rows.map(w => {
      const open = openId === w.id;
      const followed = !w.optedOut && w.enable_tracking;
      const exception = view.exceptions > 0 && (w.optedOut || !w.enable_tracking || (!w.parked && w.enable_auto_sends !== autoDefault));
      return <View key={w.id} style={{ borderTopWidth: 1, borderTopColor: c.border }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open} accessibilityLabel={`${w.title}, ${workspaceState(w)}`} onPress={() => setOpenId(open ? null : w.id)}
          style={state => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: compact ? 52 : 44, paddingHorizontal: compact ? 16 : 14, paddingVertical: compact ? 12 : 6, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <Text numberOfLines={1} style={t.body}>{w.title}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {exception && <View accessibilityLabel="Exception" style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.statusWarning }} />}
              <Text numberOfLines={1} style={[t.meta, { flex: 1 }]}>{workspaceState(w)}</Text>
            </View>
          </View>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
        </Pressable>
        {/* Compact rows: two switches under the open workspace, not two full settings rows. */}
        {open && <View style={{ paddingLeft: 14, paddingRight: 14, paddingBottom: 10, gap: 4 }}>
          <Switch theme={theme} compact={compact} label="Follow this workspace" value={followed} disabled={busy}
            onChange={value => set({ workspaceId: w.id, follow: value }, value ? `Following ${w.title}` : `Stopped following ${w.title}`)} />
          {followed && <Switch theme={theme} compact={compact} label="Send repairs automatically" hint={w.parked ? "Resting. Auto-send was paused and comes back when the workspace is active again. Changing it here makes your choice stick." : w.dormant ? "Resting. Nothing is sent until you start a turn there." : undefined}
            value={w.enable_auto_sends} disabled={busy} onChange={value => set({ workspaceId: w.id, enable_auto_sends: value })} />}
        </View>}
      </View>;
    })}
    {view.hidden > 0 && <Pressable accessibilityRole="button" onPress={() => setCap(n => n + 25)}
      style={state => ({ minHeight: compact ? 44 : 36, justifyContent: "center", paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
      <Text style={[t.meta, { color: c.foreground }]}>{`Show ${Math.min(25, view.hidden)} more (${view.hidden} left)`}</Text>
    </Pressable>}
  </Disclosure>;
}

/** Agents: Questions, Wait for background jobs, then the four agent cards. The Overseer and AI priority switches lead their own cards. */
function AgentsCategory({ theme, compact }: { theme: Theme; compact: boolean }) {
  return <>
    <QuestionSettings theme={theme} />
    <WaitSettings theme={theme} />
    <AgentSettings theme={theme} compact={compact} toggles={{ overseer: <PreferenceSwitch field="enable_overseer" theme={theme} />, ranker: <PreferenceSwitch field="enable_ranker" theme={theme} /> }} />
  </>;
}

/** Each category's one line, from data already loaded (never fetched for it). */
function useSummaries(): Partial<Record<SettingsCategory, string | null>> {
  // skipToken: subscribe to what's cached (re-rendering when it arrives) without ever fetching for the summary.
  const follow = useQuery({ queryKey: followKey, queryFn: skipToken }).data as Parameters<typeof followingSummary>[0] | undefined;
  const reviewers = useQuery({ queryKey: reviewerSettingsKey, queryFn: skipToken }).data as { config: ReviewerConfig } | undefined;
  const agents = useQuery({ queryKey: agentSettingsKey, queryFn: skipToken }).data as AgentSettingsView | undefined;
  const changed = agents?.roles.filter(r => !r.isDefault).length ?? 0;
  return {
    following: follow ? followingSummary(follow) : null,
    reviewers: reviewers ? reviewersSummary(reviewers.config) : null,
    agents: agents ? (changed ? `${changed} of ${agents.roles.length} changed from the defaults` : "Every agent on its default") : null,
  };
}

/**
 * Follow-up's settings, in four categories. Desktop: tabs under the host's own settings nav, the last one remembered
 * on this device. Phone: the category list, drilling in with a back row. Only the open category mounts, so only its
 * data loads.
 */
export function FollowSettings({ theme, layout, openSetup }: PluginSurfaceProps & { openSetup?: () => void }) {
  const compact = layout.compact;
  const c = theme.colors; const t = text(c, compact);
  const [category, setCategory] = useState<SettingsCategory>(() => readCategory());
  // The phone reopens in the last category, like desktop; before any pick it starts on the list.
  const [drilled, setDrilled] = useState(() => hasSavedCategory());
  const summaries = useSummaries();
  const pick = (id: SettingsCategory) => { writeCategory(id); setCategory(id); };
  const content = category === "following" ? <FollowingCategory theme={theme} compact={compact} openSetup={openSetup} />
    : category === "reviewers" ? <View style={{ gap: 8 }}>
      <Text style={t.meta}>Who Add reviewers asks on a PR: a list per repository, or the default for every repository without one. A login is a GitHub user (octocat) or a team (org/team). Teammates each keep their own lists.</Text>
      <ReviewerSettings theme={theme} compact={compact} />
    </View>
    : category === "agents" ? <AgentsCategory theme={theme} compact={compact} />
    : <DisplaySections theme={theme} />;
  // Phones: the shared gutter and the bottom inset (the gesture bar), like every other Follow-up surface.
  const page = { padding: compact ? space(true).gutter : 24, gap: 18, maxWidth: 720, width: "100%" as const, alignSelf: "center" as const, paddingBottom: 40 };
  // The host's header sits right above: no extra top space on a phone.
  if (compact) return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ ...page, paddingTop: 4, ...bottomInset(true, 28) }}>
    {drilled ? <>
      <BackHeader title={categoryTitle(category)} onBack={() => setDrilled(false)} theme={theme} />
      {content}
    </> : <CategoryList summaries={summaries} theme={theme} onOpen={id => { pick(id); setDrilled(true); }} />}
  </ScrollView>;
  const line = summaries[category];
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} stickyHeaderIndices={[0]} contentContainerStyle={{ ...page, paddingTop: 0 }}>
    <View style={{ paddingTop: 24, backgroundColor: c.surface0 }}><CategoryTabs value={category} onChange={pick} theme={theme} /></View>
    {line ? <Text style={[t.meta, { marginTop: -6 }]}>{line}</Text> : null}
    {content}
  </ScrollView>;
}
