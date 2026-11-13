import { useState } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import { Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { prWorkflowRpc, setPrWorkflowRpc } from "../shared/contracts";
import {
  MERGE_METHOD_LABELS, MERGE_METHOD_SHORT, REVIEW_MODE_LABELS, setNoReviewRepos, PR_WORKFLOWS, setupValue, setupWrite, type setPrWorkflowInputSchema, PR_WORKFLOW_LABELS, commandName, repoShippingSummary, reposShippingSummary, reviewFixLabel, shippingSummary, workflowName,
  type MergeMethod, type PrWorkflowSetting, type PrWorkflowView, type RepoWorkflowView, type ReviewFix,
} from "../shared/pr-workflow";
import { Button, errorText, text, type Theme, SubmitScope } from "./kit";
import { Disclosure } from "./settings-shell";
import { ReviewModeRow } from "./review-mode";
import { reviewerSettingsKey } from "./reviewers";
import { overviewKey } from "./keys";

export const shippingKey = ["follow-up", "pr-workflow"];
type Write = z.input<typeof setPrWorkflowInputSchema>;

/** The section's info tip. Graphite is explained only on a machine where it's in play. */
export function shippingInfo(view: PrWorkflowView | undefined): string {
  const base = "How Follow-up checks and merges each repository's PRs, and what it tells agents about review comments. Auto picks per repository from what's set up on this machine.";
  const graphite = !!view && (view.gt.installed || view.repos.some(r => r.effective === "graphite" || r.detected === "graphite"));
  return graphite ? `${base} It picks Graphite where the gt CLI is signed in and the repository is initialised, and only reads files to decide.` : base;
}
const BUILTIN_HINT = "Agents read the unresolved threads with gh, fix and push, then reply to each thread and resolve it.";

/** Where a nested fold's title starts (Disclosure: 36 in, 14 chevron, 8 gap) less a settings row's own 16 padding. */
const REPO_INSET = 36 + 14 + 8 - 16;
const ago = (at: number, now = Date.now()) => { const m = Math.round((now - at) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

/** Settings → Following → Shipping PRs: the default, review comments, then one fold per repository. */
export function ShippingSettings({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(prWorkflowRpc); const write = useRpc(setPrWorkflowRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: shippingKey, queryFn: () => read({}), staleTime: 60_000 });
  const recheck = useMutation({ mutationFn: () => read({ refresh: true }), onSuccess: v => { cache.setQueryData(shippingKey, v); toast.show("Checked again", { variant: "success" }); }, onError: e => toast.error(errorText(e)) });
  const change = useMutation({
    mutationFn: (input: Write & { toast?: string }) => { const { toast: _, ...rest } = input; return write(rest); },
    onSuccess: (v, input) => { cache.setQueryData(shippingKey, v); if (input.toast) toast.show(input.toast, { variant: "success" }); void cache.invalidateQueries({ queryKey: ["follow-up", "workspace"] });
      // Review mode lives in the reviewer-settings payload too (noReview), which Needs you reads: fetch it again.
      if (input.review !== undefined) { setNoReviewRepos(v.repos.filter(r => r.review === "none").map(r => r.repo)); void cache.invalidateQueries({ queryKey: reviewerSettingsKey }); void cache.invalidateQueries({ queryKey: overviewKey }); } },
    onError: e => toast.error(errorText(e)),
  });
  const data = query.data;
  const checked = query.dataUpdatedAt ? ago(query.dataUpdatedAt) : null;
  return <SettingsSection title="Shipping PRs" info={shippingInfo(data)}>
    {query.isPending && <ActivityIndicator accessibilityLabel="Loading how PRs ship" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {query.error && <SettingsCard><SettingsAction label="Couldn't load how PRs ship" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
    {data && <>
      <SettingsCard>
        <SettingsSelect<PrWorkflowSetting> label="Ship PRs with" hint={defaultHint(data)} value={data.default} disabled={change.isPending}
          options={PR_WORKFLOWS.map(w => ({ value: w, label: PR_WORKFLOW_LABELS[w].label }))}
          onValueChange={value => change.mutate({ default: value, toast: `Default: ship with ${PR_WORKFLOW_LABELS[value].label}` })} />
        <ReviewFixSelect label="Review comments" value={data.reviewFix} theme={theme} compact={compact} busy={change.isPending}
          onSave={fix => { if (fix) change.mutate({ reviewFix: fix, toast: `Default: review comments → ${reviewFixLabel(fix)}` }); }} />
      </SettingsCard>
      {signInWarning(data) && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusWarning }]}>{signInWarning(data)}</Text>}
      {data.repos.length ? <Disclosure id="shipping.repos" title="Repositories" summary={reposShippingSummary(data.repos)}
        defaultOpen={data.repos.length <= 6} theme={theme} compact={compact}>
        {data.repos.map((row, i) => <View key={row.repo} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.border }}>
          <Disclosure framed={false} id={`shipping.repo.${row.repo}`} title={row.repo} summary={repoShippingSummary(row)} defaultOpen={false} theme={theme} compact={compact}>
            <RepoShipping row={row} view={data} theme={theme} compact={compact} busy={change.isPending} set={(input, label) => change.mutate({ repo: row.repo, ...input, toast: `${row.repo}: ${label}` })} />
          </Disclosure>
        </View>)}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: compact ? 16 : 14, paddingVertical: 8 }}>
          <Text style={[t.meta, { flex: 1 }]}>{`${checked ? `Checked ${checked}` : "Not checked yet"} · looks at what's installed and how each repository is set up.`}</Text>
          <Button theme={theme} compact={compact} title={recheck.isPending ? "Checking…" : "Check again"} disabled={recheck.isPending} loading={recheck.isPending} onPress={() => recheck.mutate()} />
        </View>
      </Disclosure> : <Text style={t.meta}>Repositories show here once Follow-up sees a PR in them or a project with a GitHub remote.</Text>}
    </>}
  </SettingsSection>;
}

function defaultHint(view: PrWorkflowView): string {
  const now = shippingSummary(view).split(" · ").slice(1).join(" · ");
  return view.default === "auto" ? (now ? `Right now: ${now}.` : PR_WORKFLOW_LABELS.auto.hint) : PR_WORKFLOW_LABELS[view.default].hint;
}
/** Only when a repository is on Graphite and the CLI can't merge for it; a missing gt is normal otherwise. */
function signInWarning(view: PrWorkflowView): string | null {
  if (!view.repos.some(r => r.effective === "graphite") || view.gt.installed && view.gt.signedIn) return null;
  return view.gt.installed ? "The Graphite CLI isn't signed in on this machine. Run gt auth, or merges in Graphite repositories will fail." : "A repository is set to Graphite, but the gt CLI isn't installed on this machine.";
}

function RepoShipping({ row, view, theme, compact, busy, set }: { row: RepoWorkflowView; view: PrWorkflowView; theme: Theme; compact: boolean; busy: boolean; set: (input: Omit<Write, "repo">, label: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const fallback = view.default === "auto" ? `Default · Auto → ${workflowName(row.detected)}` : `Default · ${PR_WORKFLOW_LABELS[view.default].label}`;
  const methods = row.github?.methods ?? [];
  const preferred = row.github?.preferred ?? methods[0] ?? null;
  // A hairline that starts on the text column, without shifting the row under it.
  const rule = <View style={{ height: 1, backgroundColor: c.border, marginLeft: 16 }} />;
  const autoMerge = row.effective !== "github" || !row.github ? undefined : row.github.autoMerge ? "Auto-merge is available for PRs here." : "Auto-merge is off in this repository's GitHub settings, so its PRs have no Auto-merge switch.";
  const pinned = !row.inherits && row.setting !== "auto";
  const reason = pinned ? `Set here.${row.detected !== row.effective ? ` Auto would use ${workflowName(row.detected)}.` : ""}` : row.reason;
  // Flat rows inside the fold: no inner card. Text and hairlines start on the repository name's column.
  return <View style={{ paddingLeft: REPO_INSET, paddingBottom: 4 }}>
    <Text style={[t.meta, { paddingHorizontal: 16, paddingBottom: 4 }]}>{reason}</Text>
    <SettingsSelect<"inherit" | PrWorkflowSetting> label="Ship with" hint={autoMerge} value={row.inherits ? "inherit" : row.setting} disabled={busy}
      options={[{ value: "inherit", label: fallback }, ...(view.default !== "auto" ? [{ value: "auto" as const, label: `Auto (picks ${workflowName(row.detected)} here)` }] : []), ...PR_WORKFLOWS.filter(w => w !== "auto").map(w => ({ value: w, label: PR_WORKFLOW_LABELS[w].label }))]}
      onValueChange={value => set({ setting: value === "inherit" ? null : value }, value === "inherit" ? "back to the default" : PR_WORKFLOW_LABELS[value].label)} />
    {row.effective === "github" && <View>{rule}{row.github?.mergeQueue
      ? <SettingsAction label="Merge method" hint="This repository merges through a merge queue, which picks the method." actionLabel="GitHub" disabled onPress={() => undefined} />
      : <SettingsSelect<"default" | MergeMethod> label="Merge method" disabled={busy || !row.github}
        hint={!row.github ? "Shows after Follow-up reads a PR here." : `This repository allows ${listMethods(methods)}.`}
        value={row.mergeMethod && methods.includes(row.mergeMethod) ? row.mergeMethod : "default"}
        options={[{ value: "default", label: preferred ? `Default · ${MERGE_METHOD_SHORT[preferred]}` : "Repository default" }, ...methods.map(m => ({ value: m, label: MERGE_METHOD_LABELS[m] }))]}
        onValueChange={value => set({ mergeMethod: value === "default" ? null : value }, value === "default" ? "GitHub's default merge method" : MERGE_METHOD_LABELS[value])} />}</View>}
    <View style={{ zIndex: 2 }}>{rule}<ReviewModeRow repo={row.repo} value={row.review} theme={theme} compact={compact} busy={busy}
      onChange={mode => set({ review: mode === "team" ? null : mode }, mode === "none" ? `no review. ${REVIEW_MODE_LABELS.none.hint}` : `team review. ${REVIEW_MODE_LABELS.team.hint}`)} /></View>
    <View>{rule}<ReviewFixSelect label="Review comments" value={row.reviewFix} inherited={view.reviewFix} theme={theme} compact={compact} busy={busy}
      onSave={fix => set({ reviewFix: fix }, fix ? `review comments: ${reviewFixLabel(fix)}` : "review comments back to the default")} /></View>
  </View>;
}
/** "squash", "squash and rebase", "squash, merge commits and rebase". */
function listMethods(methods: MergeMethod[]): string {
  const words = methods.map(m => ({ squash: "squash", merge: "merge commits", rebase: "rebase" })[m]);
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * Built-in steps or a skill/command name. Choosing "A skill or command" opens a one-line field with Save; an
 * inherited row (`inherited` set) adds "Same as default".
 */
function ReviewFixSelect({ label, value, inherited, theme, compact, busy, onSave }: { label: string; value: ReviewFix | null; inherited?: ReviewFix; theme: Theme; compact: boolean; busy: boolean; onSave: (fix: ReviewFix | null) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const current = value ? value.kind : inherited ? "inherit" : "builtin";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value && commandName(value) || "");
  const valid = /^\/?[\w:.-]{1,80}$/.test(draft.trim());
  const shown = editing ? "command" : current;
  const hint = shown === "inherit" ? `Uses the default: ${reviewFixLabel(inherited!)}.` : shown === "builtin" ? BUILTIN_HINT : value?.kind === "command" && !editing ? `Agents run ${commandName(value)} for review comments.` : "The skill or slash command agents run for review comments, such as /fix-pr.";
  return <View>
    <SettingsSelect<"inherit" | "builtin" | "command"> label={label} hint={hint} value={shown} disabled={busy}
      options={[...(inherited ? [{ value: "inherit" as const, label: `Default · ${reviewFixLabel(inherited)}` }] : []), { value: "builtin" as const, label: "Built-in steps" }, { value: "command" as const, label: value?.kind === "command" ? commandName(value)! : "A skill or command…" }]}
      onValueChange={next => { if (next === "command") { setEditing(true); return; } setEditing(false); onSave(next === "inherit" ? null : { kind: "builtin" }); }} />
    {/* Phones: the field gets the full width and Save / Cancel split the row under it. */}
    {editing && <SubmitScope enabled={valid && !busy} onSubmit={() => { onSave({ kind: "command", command: draft.trim() }); setEditing(false); }} style={compact ? { gap: 8, paddingHorizontal: 16, paddingBottom: 12 } : { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}>
      <TextInput accessibilityLabel="Skill or command for review comments" value={draft} onChangeText={setDraft} placeholder="/fix-pr" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} autoFocus
        style={{ flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: draft && !valid ? c.statusDanger : c.border, color: c.foreground, fontSize: compact ? 15 : 13, backgroundColor: c.surface0, fontFamily: "monospace", ...(compact ? { flex: undefined } : {}) }} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button shortcut theme={theme} compact={compact} grow={compact} kind="primary" title="Save" disabled={!valid || busy} onPress={() => { onSave({ kind: "command", command: draft.trim() }); setEditing(false); }} />
        <Button theme={theme} compact={compact} grow={compact} kind={compact ? "secondary" : "ghost"} title="Cancel" onPress={() => setEditing(false)} />
      </View>
    </SubmitScope>}
    {editing && draft !== "" && !valid && <Text style={[t.meta, { color: c.statusDanger, paddingHorizontal: compact ? 16 : 14, paddingBottom: 10 }]}>Use a name like /fix-pr: letters, digits, dashes, dots or colons.</Text>}
  </View>;
}

/**
 * Setup's "How do you ship PRs?" step: one row per repository with what Auto picked and why, and a select that writes
 * the same setting as Settings. Graphite is named only as an option, or on a repository that already ships with it.
 */
export function ShippingStep({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(prWorkflowRpc); const write = useRpc(setPrWorkflowRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: shippingKey, queryFn: () => read({}), staleTime: 60_000 });
  const change = useMutation({
    mutationFn: (input: Write) => write(input),
    onSuccess: v => cache.setQueryData(shippingKey, v),
    onError: e => toast.error(errorText(e)),
  });
  const later = <Text style={t.meta}>Change this later in Settings → Following → Shipping PRs.</Text>;
  if (query.isPending) return <ActivityIndicator accessibilityLabel="Checking how your repositories ship PRs" color={c.foregroundMuted} style={{ alignSelf: "flex-start" }} />;
  if (query.error) return <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{errorText(query.error)}</Text>;
  const data = query.data!;
  if (!data.repos.length) return <View style={{ gap: 10 }}><Text style={t.body}>Follow-up works this out per repository when it sees the first PR.</Text>{later}</View>;
  const warning = signInWarning(data);
  // Graphite repositories first: they're the ones worth a look.
  const rows = [...data.repos].sort((a, b) => Number(b.effective === "graphite") - Number(a.effective === "graphite"));
  const uniform = rows.every(r => r.effective === "github" && r.inherits);
  const row = (r: RepoWorkflowView) => <SettingsSelect<PrWorkflowSetting> key={r.repo} label={r.repo} hint={r.reason} value={setupValue(data, r)} disabled={change.isPending}
    options={PR_WORKFLOWS.map(w => ({ value: w, label: w === "auto" ? `Auto (${workflowName(r.detected)})` : PR_WORKFLOW_LABELS[w].label }))}
    onValueChange={choice => change.mutate(setupWrite(data, r.repo, choice))} />;
  // Nothing to decide (every repository on GitHub by Auto): one row for the default, the repositories folded.
  if (uniform) return <View style={{ gap: 10 }}>
    <SettingsCard>
      <SettingsSelect<PrWorkflowSetting> label={`All ${rows.length} repositor${rows.length === 1 ? "y ships" : "ies ship"} with GitHub`} hint={rows[0].reason} value={data.default} disabled={change.isPending}
        options={PR_WORKFLOWS.map(w => ({ value: w, label: PR_WORKFLOW_LABELS[w].label }))}
        onValueChange={value => change.mutate({ default: value })} />
    </SettingsCard>
    <Disclosure id="setup.shipping.repos" title="Show repositories" summary={`${rows.length} on GitHub`} defaultOpen={false} theme={theme} compact={compact}>
      {rows.map((r, i) => <View key={r.repo} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.border }}>{row(r)}</View>)}
    </Disclosure>
    {later}
  </View>;
  return <View style={{ gap: 10 }}>
    <SettingsCard>{rows.map(row)}</SettingsCard>
    {warning && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusWarning }]}>{warning}</Text>}
    {later}
  </View>;
}
