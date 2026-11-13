import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { TextInput, View } from "react-native";
import { Pressable, Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reviewerSettingsRpc, reviewerSuggestionsRpc, saveReviewersRpc } from "../shared/contracts";
import { MAX_REVIEWERS, TEAM_SLUG, USER_LOGIN, isTeam, resolveReviewers, reviewerConfig, reviewerLabel, sameLogin, setReviewerConfig, type ReviewerEntry } from "../shared/reviewers";
import { noReviewRepoList, noReviewReposVersion, onNoReviewRepos, setNoReviewRepos } from "../shared/pr-workflow";
import { Button, Switch, errorText, text, type Theme, SubmitScope } from "./kit";
import { Disclosure } from "./settings-shell";
import { repoSummary, reposSummary, reviewersConfigured } from "../shared/settings-nav";

export const reviewerSettingsKey = ["follow-up", "reviewer-settings"];

/** The saved reviewer lists. Loading them also updates what Needs you and the briefs read. */
export function useReviewerSettings() {
  const read = useRpc(reviewerSettingsRpc);
  const cache = useQueryClient();
  const query = useQuery({ queryKey: reviewerSettingsKey, queryFn: () => read({}), staleTime: 60_000 });
  // A No review change (here, Settings or the Needs-you link) re-renders every surface that computed Needs you.
  useSyncExternalStore(onNoReviewRepos, noReviewReposVersion, noReviewReposVersion);
  useEffect(() => {
    // Every mounted user shares one query; only a real change re-renders what read the old lists.
    if (!query.data) return;
    // No review repositories decide agentMerges (shared/pr-workflow.ts), so Needs you agrees with the server's.
    const noReview = query.data.noReview ?? [];
    if (JSON.stringify(query.data.config) === JSON.stringify(reviewerConfig()) && JSON.stringify([...noReview].sort()) === JSON.stringify(noReviewRepoList())) return;
    setReviewerConfig(query.data.config); setNoReviewRepos(noReview);
    // Needs-you rows and counts were computed with the previous lists.
    void cache.invalidateQueries({ queryKey: ["follow-up", "workspace"] }); void cache.invalidateQueries({ queryKey: ["follow-up", "overview"] });
  }, [query.data]);
  return query;
}

const valid = (login: string) => USER_LOGIN.test(login) || TEAM_SLUG.test(login);

function ReviewerChip({ r, theme, compact, onRemove }: { r: ReviewerEntry; theme: Theme; compact: boolean; onRemove?: () => void }) {
  const c = theme.colors;
  const label = reviewerLabel(r);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: 8, paddingRight: onRemove ? 2 : 8, minHeight: compact ? 44 : 28, borderRadius: 6, backgroundColor: c.surface2 }}>
    <Icon name={isTeam(r.login) ? "Users" : "User"} size={12} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, lineHeight: 16, fontWeight: "500", maxWidth: 200 }}>{label}</Text>
    {label !== r.login && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16, maxWidth: 160 }}>{r.login}</Text>}
    {onRemove && <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${label}`} onPress={onRemove} hitSlop={compact ? 0 : 5}
      style={({ pressed }) => ({ width: compact ? 44 : 24, height: compact ? 44 : 24, borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surface1 : "transparent" })}>
      <Icon name="X" size={12} color={c.foregroundMuted} />
    </Pressable>}
  </View>;
}

/**
 * "Add reviewer": free text (a login or org/team), with the repository's collaborators and teams as suggestions.
 * Suggestions load when the field is focused, once per repository (cached on the server too).
 */
function AddReviewer({ repo, theme, compact, taken, onAdd }: { repo: string | null; theme: Theme; compact: boolean; taken: string[]; onAdd: (r: ReviewerEntry) => void }) {
  const c = theme.colors; const t = text(c);
  const suggestRead = useRpc(reviewerSuggestionsRpc);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  // The list shows while the field has focus; blur closes it a beat later so a tap on a suggestion still lands.
  const [open, setOpen] = useState(false);
  const suggestions = useQuery({ queryKey: ["follow-up", "reviewer-suggestions", repo], queryFn: () => suggestRead({ repo: repo! }), enabled: !!repo && focused, staleTime: 600_000, retry: false });
  const q = value.trim().replace(/^@/, "");
  const matches = (suggestions.data?.suggestions ?? []).filter(s => !taken.some(l => sameLogin(l, s.login)) && (!q || s.login.toLowerCase().includes(q.toLowerCase()) || (s.name ?? "").toLowerCase().includes(q.toLowerCase()))).slice(0, 6);
  const add = (r: ReviewerEntry) => { onAdd(r); setValue(""); setOpen(false); };
  const typed = !!q && valid(q) && !taken.some(l => sameLogin(l, q));
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <TextInput accessibilityLabel={repo ? `Add a reviewer for ${repo}` : "Add a default reviewer"} value={value} placeholder="Login or org/team" placeholderTextColor={c.foregroundMuted}
        autoCapitalize="none" autoCorrect={false} onFocus={() => { setFocused(true); setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyPress={e => { if (e.nativeEvent.key === "Escape") setOpen(false); }} onChangeText={v => { setValue(v); setOpen(true); }} onSubmitEditing={() => { if (typed) add({ login: q, name: null }); }}
        style={{ flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0 }} />
      <Button theme={theme} compact={compact} icon="Plus" title="Add" disabled={!typed} accessibilityLabel={typed ? `Add ${q}` : "Add reviewer"} onPress={() => add({ login: q, name: null })} />
    </View>
    {!!q && !valid(q) && <Text style={[t.small, { color: c.statusWarning }]}>Use a GitHub login like octocat, or a team as org/team.</Text>}
    {open && suggestions.isFetching && !suggestions.data && <Text style={t.small}>Loading collaborators…</Text>}
    {open && suggestions.data?.error && <Text style={t.small}>{suggestions.data.error}</Text>}
    {open && matches.length > 0 && <View style={{ borderRadius: 6, borderWidth: 1, borderColor: c.border, overflow: "hidden" }}>
      {matches.map((s, i) => <Pressable key={s.login} accessibilityRole="button" accessibilityLabel={`Add ${s.name ?? s.login}`} onPress={() => add({ login: s.login, name: s.kind === "team" ? s.name : null })}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 30, paddingHorizontal: 10, borderTopWidth: i ? 1 : 0, borderTopColor: c.border, backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent" })}>
        <Icon name={s.kind === "team" ? "Users" : "User"} size={12} color={c.foregroundMuted} />
        <Text numberOfLines={1} style={[t.body, { flexShrink: 1 }]}>{s.login}</Text>
        {s.name && <Text numberOfLines={1} style={[t.small, { flexShrink: 1 }]}>{s.name}</Text>}
      </Pressable>)}
    </View>}
  </View>;
}

/** One list (a repository, or the default for all repos) with its chips and Add reviewer. Saves on every change. */
function ReviewerList({ repo, list, theme, compact, fallback, first, titled = true, startAdding = false }: { repo: string | null; list: ReviewerEntry[]; theme: Theme; compact: boolean; fallback?: string | null; first?: boolean; titled?: boolean; startAdding?: boolean }) {
  const c = theme.colors; const t = text(c);
  const save = useRpc(saveReviewersRpc); const cache = useQueryClient(); const toast = useToast();
  const [adding, setAdding] = useState(startAdding);
  const change = useMutation({ mutationFn: (next: ReviewerEntry[]) => save({ repo, reviewers: next }), onSuccess: data => { cache.setQueryData(reviewerSettingsKey, data); setReviewerConfig(data.config); }, onError: error => toast.error(errorText(error)) });
  const action = adding ? <Button theme={theme} compact={compact} kind="ghost" icon="Check" title="Done" accessibilityLabel={`Done adding to ${repo ?? "the default list"}`} onPress={() => setAdding(false)} />
    : list.length < MAX_REVIEWERS ? <Button theme={theme} compact={compact} kind="ghost" icon="UserPlus" title="Add reviewer" accessibilityLabel={`Add reviewer to ${repo ?? "the default list"}`} onPress={() => setAdding(true)} /> : null;
  const chips = list.length > 0 ? list.map((r, i) => <ReviewerChip key={r.login} r={r} theme={theme} compact={compact} onRemove={change.isPending ? undefined : () => change.mutate(list.filter((_, j) => j !== i))} />)
    : <Text style={[t.meta, titled ? null : { flex: 1, minWidth: 0 }]}>{fallback ?? "Nobody yet. Add reviewers opens a picker."}</Text>;
  return <View style={{ gap: 8, paddingHorizontal: 14, paddingVertical: titled ? 12 : 8, paddingLeft: titled ? 14 : 58, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
    {titled ? <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={repo ? "GitPullRequest" : "Globe"} size={13} color={c.foregroundMuted} />
        <Text numberOfLines={1} style={[t.label, { flex: 1, minWidth: 0 }]}>{repo ?? "Default for all repos"}</Text>
        {action}
      </View>
      {list.length > 0 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{chips}</View> : chips}
    </> : /* Inside a fold the header already names the repo: chips and Add share one row, indented under it. */
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>{chips}<View style={{ flex: 1 }} />{action}</View>}
    {adding && <AddReviewer repo={repo} theme={theme} compact={compact} taken={list.map(r => r.login)} onAdd={r => change.mutate([...list, r])} />}
  </View>;
}

/**
 * Settings → Reviewers: who "Add reviewers" asks. The default list stays open; the repositories fold away behind one
 * line ("3 with their own list · 5 use the default"), collapsed by default once anything is set. Inside, each
 * repository with a list folds to its names, and the ones on the default fold together.
 */
export function ReviewerSettings({ theme, compact = false }: { theme: Theme; compact?: boolean }) {
  const c = theme.colors; const t = text(c);
  const query = useReviewerSettings();
  const data = query.data;
  if (query.isPending) return <Text style={t.meta}>Loading reviewers…</Text>;
  if (query.error || !data) return <SettingsCard><SettingsAction label="Couldn't load reviewers" hint={query.error ? errorText(query.error) : undefined} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>;
  const own = data.repos.filter(r => (data.config.repos[r] ?? []).length > 0).sort((a, b) => a.localeCompare(b));
  const rest = data.repos.filter(r => !own.includes(r));
  const fallback = data.config.defaults.length ? `Uses the default: ${data.config.defaults.map(reviewerLabel).join(", ")}` : null;
  return <View style={{ gap: 8 }}>
    <View style={{ borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
      <ReviewerList first repo={null} list={data.config.defaults} theme={theme} compact={compact} fallback="Nobody. Repositories without their own list open the picker." />
    </View>
    {data.repos.length > 0 ? <Disclosure id="reviewers.repos" title="Repositories" summary={reposSummary(data.repos, data.config)}
      defaultOpen={!reviewersConfigured(data.config)} theme={theme} compact={compact}>
      {own.map((repo, i) => <View key={repo} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.border }}>
        <Disclosure framed={false} id={`reviewers.repo.${repo}`} title={repo} summary={repoSummary(data.config.repos[repo] ?? [], data.config.defaults)} defaultOpen={false} theme={theme} compact={compact}>
          <ReviewerList first titled={false} repo={repo} list={data.config.repos[repo] ?? []} theme={theme} compact={compact} fallback={fallback} />
        </Disclosure>
      </View>)}
      {rest.length > 0 && <DefaultRepos repos={rest} defaults={data.config.defaults} theme={theme} compact={compact} first={!own.length} />}
    </Disclosure> : <Text style={t.meta}>Repositories show here once Follow-up has seen a PR in them.</Text>}
  </View>;
}

/**
 * Repositories on the default, in one row: their names, each a button that gives it its own list (it then moves up
 * with the others). No third level, and the default's names aren't repeated per repository.
 */
function DefaultRepos({ repos, defaults, theme, compact, first }: { repos: string[]; defaults: ReviewerEntry[]; theme: Theme; compact: boolean; first: boolean }) {
  const c = theme.colors; const t = text(c);
  const [editing, setEditing] = useState<string | null>(null);
  return <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
    <View style={{ paddingLeft: 36, paddingRight: 14, paddingVertical: 10, gap: 6 }}>
      <Text style={t.meta}>{`On the default${defaults.length ? ` (${defaults.map(reviewerLabel).join(", ")})` : ""}. Give one its own list:`}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {repos.map(repo => <Pressable key={repo} accessibilityRole="button" accessibilityLabel={`Give ${repo} its own list`} accessibilityState={{ selected: editing === repo }} onPress={() => setEditing(editing === repo ? null : repo)}
          style={state => ({ flexDirection: "row", alignItems: "center", gap: 5, minHeight: compact ? 44 : 28, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: editing === repo ? c.foregroundMuted : c.border, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
          <Icon name="GitPullRequest" size={12} color={c.foregroundMuted} />
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, lineHeight: 16 }}>{repo}</Text>
          <Icon name={editing === repo ? "X" : "Plus"} size={12} color={c.foregroundMuted} />
        </Pressable>)}
      </View>
    </View>
    {editing && <ReviewerList key={editing} repo={editing} list={[]} theme={theme} compact={compact} startAdding fallback="Add the first reviewer for this repository." />}
  </View>;
}

/**
 * The picker in the PR sheet: check who to ask on this PR only; "Remember for <repo>" also saves them as its list.
 * The author is listed but can't be picked.
 */
export function ReviewerPicker({ repo, author, theme, compact, busy, onCancel, onRequest }: {
  repo: string; author: string | null; theme: Theme; compact: boolean; busy: boolean;
  onCancel: () => void; onRequest: (reviewers: ReviewerEntry[], remember: boolean) => void;
}) {
  const c = theme.colors; const t = text(c);
  const settings = useReviewerSettings();
  const config = settings.data?.config;
  const saved = useMemo(() => config ? resolveReviewers(config, repo).reviewers : [], [config, repo]);
  const [options, setOptions] = useState<ReviewerEntry[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [remember, setRemember] = useState(false);
  const [init, setInit] = useState(false);
  useEffect(() => { if (config && !init) { setOptions(saved); setChecked(saved.filter(r => !isAuthor(r)).map(r => r.login.toLowerCase())); setRemember(!saved.length); setInit(true); } }, [config]);
  const isAuthor = (r: ReviewerEntry) => !!author && !isTeam(r.login) && sameLogin(r.login, author);
  const picked = options.filter(r => checked.includes(r.login.toLowerCase()) && !isAuthor(r));
  const toggle = (r: ReviewerEntry) => setChecked(v => v.includes(r.login.toLowerCase()) ? v.filter(x => x !== r.login.toLowerCase()) : [...v, r.login.toLowerCase()]);
  const sameAsSaved = picked.length === saved.length && picked.every((r, i) => sameLogin(r.login, saved[i].login));
  return <SubmitScope enabled={picked.length > 0 && !busy} onSubmit={() => onRequest(picked, remember && !sameAsSaved)} accessibilityRole="summary" accessibilityLabel="Pick reviewers for this PR" style={{ gap: 8 }}>
    {!options.length && <Text style={t.meta}>{`No reviewers set for ${repo}. Add who to ask on this PR.`}</Text>}
    {options.map(r => {
      const on = checked.includes(r.login.toLowerCase()) && !isAuthor(r);
      return <Pressable key={r.login} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: isAuthor(r) }} aria-checked={on} disabled={isAuthor(r)}
        accessibilityLabel={`${reviewerLabel(r)}${isAuthor(r) ? ", the PR author" : ""}`} onPress={() => toggle(r)}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: compact ? 44 : 30, paddingHorizontal: 4, borderRadius: 6, backgroundColor: pressed ? c.surface2 : "transparent", opacity: isAuthor(r) ? 0.5 : 1 })}>
        <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
          {on && <Icon name="Check" size={11} color={c.accentForeground} />}
        </View>
        <Icon name={isTeam(r.login) ? "Users" : "User"} size={12} color={c.foregroundMuted} />
        <Text numberOfLines={1} style={[t.body, { flexShrink: 1 }]}>{reviewerLabel(r)}</Text>
        {reviewerLabel(r) !== r.login && <Text numberOfLines={1} style={[t.small, { flexShrink: 1 }]}>{r.login}</Text>}
        {isAuthor(r) && <Text style={t.small}>author</Text>}
      </Pressable>;
    })}
    {options.length < MAX_REVIEWERS && <AddReviewer repo={repo} theme={theme} compact={compact} taken={[...options.map(r => r.login), ...(author ? [author] : [])]}
      onAdd={r => { setOptions(v => [...v, r]); setChecked(v => [...v, r.login.toLowerCase()]); }} />}
    {picked.length > 0 && !sameAsSaved && <Switch theme={theme} compact={compact} label={saved.length ? `Remember for ${repo}` : `Remember for ${repo} (no list yet)`} value={remember} onChange={setRemember}
      hint="Saves the checked reviewers as this repository's list." />}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button shortcut theme={theme} compact={compact} kind="primary" icon="UserPlus" loading={busy} disabled={!picked.length || busy}
        title={picked.length ? `Request ${picked.length === 1 ? reviewerLabel(picked[0]) : `${picked.length} reviewers`}` : "Request reviewers"}
        accessibilityLabel={`Request ${picked.map(reviewerLabel).join(", ") || "nobody"}`} onPress={() => onRequest(picked, remember && !sameAsSaved)} />
      <Button theme={theme} compact={compact} kind="ghost" title="Cancel" disabled={busy} onPress={onCancel} />
    </View>
  </SubmitScope>;
}

/** "Will ask Omar and Lena": the configured reviewers for a PR, minus its author. */
export function willAsk(list: ReviewerEntry[]): string {
  const names = list.map(reviewerLabel);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}
