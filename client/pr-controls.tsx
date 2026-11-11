import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirmPrActionRpc, preparePrActionRpc, prControlStatusRpc, requestReviewersRpc } from "../shared/contracts";
import { isGithubFlow, mergeBlockers, prActionBlocks, type ActionPlan, type PrActionKind } from "../shared/pr-actions";
import type { MergeMethod } from "../shared/pr-workflow";
import { mergeQueued, mergeReady } from "../shared/attention";
import type { Pr, Workspace } from "../shared/model";
import { Button, Switch, errorText, text, type Theme } from "./kit";
import { noReviewers, resolveReviewers, withoutAuthor, type ReviewerEntry } from "../shared/reviewers";
import { ReviewerPicker, reviewerSettingsKey, useReviewerSettings, willAsk } from "./reviewers";
import { runAction } from "./toasts";

const METHOD_SENTENCE: Record<MergeMethod, string> = { squash: "squash and merge it", merge: "merge it with a merge commit", rebase: "rebase and merge it" };
/** Blockers read as nouns after "clears:"; proper names (GitHub, Graphite) keep their capital. */
const lowerFirst = (b: string) => /^(GitHub|Graphite)\b/.test(b) ? b : b[0].toLowerCase() + b.slice(1);

/**
 * Merge, merge-when-ready and reviewer requests for one PR. Every write needs a click; Merge always
 * prepares a fresh plan and asks again before anything reaches Graphite or GitHub. In GitHub mode When ready is
 * GitHub's auto-merge, read with the PR, so it needs no browser companion; it's hidden when the repository disallows it.
 */
export function PrControls({ pr, workspace, theme, compact, browserReady: companionReady, intent }: { browserReady: boolean; pr: Pr; workspace: Workspace; theme: Theme; compact: boolean; intent?: "merge" | "reviewers" | null }) {
  const read = useRpc(prControlStatusRpc); const prepare = useRpc(preparePrActionRpc); const confirm = useRpc(confirmPrActionRpc); const cache = useQueryClient();
  const requestReviewers = useRpc(requestReviewersRpc);
  const toast = useToast();
  const c = theme.colors; const t = text(c);
  const github = isGithubFlow(pr.snapshot);
  const browserReady = github ? !!pr.snapshot?.repoMerge?.autoMerge : companionReady;
  const [plan, setPlan] = useState<ActionPlan | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const statusKey = ["follow-up", "pr-controls", workspace.id, pr.key, pr.snapshot?.head];
  const status = useQuery({ queryKey: statusKey, queryFn: () => read({ workspaceId: workspace.id, prKey: pr.key }), refetchInterval: 10_000, enabled: browserReady });
  const invalidate = () => { void cache.invalidateQueries({ queryKey: ["follow-up", "workspace", workspace.id] }); void cache.invalidateQueries({ queryKey: ["follow-up", "pr-controls", workspace.id] }); void cache.invalidateQueries({ queryKey: ["follow-up", "overview"] }); };
  const [picking, setPicking] = useState(false);
  const reviewerSettings = useReviewerSettings();
  // `picked`: this PR only, from the picker; `remember` also saves them for the repository.
  const reviewRequest = useMutation({ mutationFn: (input?: { picked: ReviewerEntry[]; remember: boolean }) => requestReviewers({ workspaceId: workspace.id, prKey: pr.key, ...(input ? { reviewers: input.picked, remember: input.remember } : {}) }),
    onSuccess: (reply, input) => { setNotice(reply.result); if (reply.state === "submitted") toast.show(reply.result, { variant: "success" }); if (input?.remember) void cache.invalidateQueries({ queryKey: reviewerSettingsKey }); invalidate(); }, onError: invalidate });
  const submit = useMutation({ mutationFn: (input: { planId: string; scope: "target" | "downstack" }) => confirm(input), onSuccess: reply => { setPlan(null); setNotice(reply.result); if (reply.state === "submitted") toast.show(reply.result, { variant: "success" }); invalidate(); }, onError: invalidate });
  const checking = useMutation({ mutationFn: (kind: PrActionKind) => prepare({ workspaceId: workspace.id, prKey: pr.key, kind }), onSuccess: result => {
    if (result.kind !== "merge" && result.prs.length === 1 && !result.blockers.length && !result.prs[0].blockers.length) submit.mutate({ planId: result.id, scope: "target" });
    else setPlan(result);
  } });
  const pendingAction = workspace.prActions.some(a => prActionBlocks(a, [pr.key]));
  const busy = checking.isPending || submit.isPending;
  const actual = browserReady ? status.data?.pr : null;
  const known = !!actual && !status.error && !status.data?.error;
  const enabled = known && actual.mergeWhenReady;
  const queued = actual?.merging || mergeQueued(pr);
  const recentlySubmitted = workspace.prActions.some(a => a.kind === "merge" && a.state === "submitted" && a.heads[pr.key] === pr.snapshot?.head && Date.now() - Date.parse(a.createdAt) < 30_000);
  const canMerge = mergeReady(pr, workspace) && !actual?.merging;
  const disabled = busy || reviewRequest.isPending || pendingAction || workspace.archived;
  const missingReviewers = noReviewers(pr);
  const reviewers = reviewerSettings.data ? withoutAuthor(resolveReviewers(reviewerSettings.data.config, pr.repo).reviewers, pr.snapshot?.reviewers?.author) : [];
  const begin = (kind: PrActionKind) => { setPlan(null); setNotice(null); submit.reset(); checking.reset(); checking.mutate(kind); };
  const failure = checking.error ?? submit.error ?? reviewRequest.error;
  const error = failure ? errorText(failure) : (browserReady ? status.data?.error : null) ?? null;
  const scopeBlocked = (scope: "target" | "downstack") => !!plan && (plan.blockers.length > 0 || (scope === "target" ? plan.prs.slice(-1) : plan.prs).some(p => p.blockers.length > 0));
  const act = (scope: "target" | "downstack") => { if (plan) submit.mutate({ planId: plan.id, scope }); };
  // Opening the sheet from "Merge…" starts the read-only check; the merge itself still needs the confirm click.
  const started = useRef(false);
  useEffect(() => { if (intent === "merge" && canMerge && !disabled && !started.current) { started.current = true; begin("merge"); } }, [intent, canMerge]);
  // Opening from "Add reviewers" with nobody set goes straight to the picker instead of an error.
  const loaded = !!reviewerSettings.data;
  useEffect(() => { if (intent === "reviewers" && loaded && missingReviewers && !pr.snapshot?.draft && !reviewers.length) setPicking(true); }, [intent, loaded]);
  if (pr.snapshot?.state !== "OPEN") return null;
  const waitingFor = mergeBlockers(pr).filter(b => !b.startsWith("Graphite ")).map(lowerFirst);
  // GitHub refuses auto-merge on a PR it can already merge, so the switch shows only while Merge is waiting, or to turn it off.
  const showSwitch = browserReady && (!github || !canMerge || !!enabled);
  const autoMergeOff = github && !!pr.snapshot?.repoMerge && !pr.snapshot.repoMerge.autoMerge && !canMerge && !queued;
  return <View style={{ gap: 10 }}>
    {/* Phones: the reviewer sentence gets its own line, the two actions share the row under it (no floating ghost). */}
    {missingReviewers && compact && <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="UserX" size={14} color={c.statusWarning} />
        <Text style={[t.meta, { flex: 1, minWidth: 120, color: c.statusWarning }]}>{!pr.snapshot?.draft && !picking && reviewers.length ? <>No reviewers yet<Text style={{ color: c.foregroundMuted }}>{` · will ask ${willAsk(reviewers)}`}</Text></> : "No reviewers yet"}</Text>
      </View>
      {!pr.snapshot?.draft && !picking && reviewerSettings.data && <View style={{ flexDirection: "row", gap: 8 }}>
        {reviewers.length > 0 && <Button grow title={reviewRequest.isPending ? "Requesting…" : "Add reviewers"} accessibilityLabel={`Add reviewers: ${willAsk(reviewers)} for ${pr.repo} pull request ${pr.number}`} icon="UserPlus" theme={theme} compact disabled={disabled} loading={reviewRequest.isPending} onPress={() => { setNotice(null); reviewRequest.mutate(undefined); }} />}
        <Button grow title={reviewers.length ? "Choose others…" : "Add reviewers…"} icon={reviewers.length ? "Users" : "UserPlus"} accessibilityLabel={reviewers.length ? "Pick different reviewers for this PR" : `Pick reviewers for ${pr.repo} pull request ${pr.number}`} theme={theme} compact disabled={disabled} onPress={() => { setNotice(null); setPicking(true); }} />
      </View>}
    </View>}
    {missingReviewers && !compact && <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Icon name="UserX" size={14} color={c.statusWarning} />
      <Text style={[t.meta, { flex: 1, minWidth: 120, color: c.statusWarning }]}>{!pr.snapshot?.draft && !picking && reviewers.length ? <>No reviewers yet<Text style={{ color: c.foregroundMuted }}>{` · will ask ${willAsk(reviewers)}`}</Text></> : "No reviewers yet"}</Text>
      {!pr.snapshot?.draft && !picking && reviewerSettings.data && <>
        {reviewers.length > 0 && <Button title={reviewRequest.isPending ? "Requesting…" : "Add reviewers"} accessibilityLabel={`Add reviewers: ${willAsk(reviewers)} for ${pr.repo} pull request ${pr.number}`} icon="UserPlus" theme={theme} compact={compact} disabled={disabled} loading={reviewRequest.isPending} onPress={() => { setNotice(null); reviewRequest.mutate(undefined); }} />}
        <Button title={reviewers.length ? "Choose others…" : "Add reviewers…"} kind={reviewers.length ? "ghost" : "secondary"} icon={reviewers.length ? undefined : "UserPlus"} accessibilityLabel={reviewers.length ? "Pick different reviewers for this PR" : `Pick reviewers for ${pr.repo} pull request ${pr.number}`} theme={theme} compact={compact} disabled={disabled} onPress={() => { setNotice(null); setPicking(true); }} />
      </>}
    </View>}
    {missingReviewers && !pr.snapshot?.draft && picking && <ReviewerPicker repo={pr.repo} author={pr.snapshot?.reviewers?.author ?? null} theme={theme} compact={compact} busy={reviewRequest.isPending}
      onCancel={() => setPicking(false)} onRequest={(picked, remember) => {
        // Quick action: the picker closes at once; a toast says what GitHub did (Retry and Open on failure).
        setPicking(false);
        void runAction({
          label: "Reviewers", toast, run: () => requestReviewers({ workspaceId: workspace.id, prKey: pr.key, reviewers: picked, remember }),
          success: reply => ({ tone: reply.state === "submitted" ? "success" : "info", message: reply.result }),
          onSuccess: reply => { setNotice(reply.result); if (remember) void cache.invalidateQueries({ queryKey: reviewerSettingsKey }); invalidate(); },
          onError: e => { setNotice(`Reviewers not requested: ${errorText(e)}`); invalidate(); }, failure: `Reviewers not requested on #${pr.number}`, open: () => setPicking(true),
        });
      }} />}
    {!plan && <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
      {(canMerge || queued || recentlySubmitted || busy) ? <Button title={busy ? checking.isPending ? "Checking…" : "Submitting…" : queued ? "Queued to merge" : recentlySubmitted ? "Submitted" : `Merge #${pr.number}`} icon={queued ? "Clock" : "GitMerge"} theme={theme} compact={compact} kind={canMerge ? "primary" : "secondary"} loading={busy} disabled={disabled || !canMerge} onPress={() => begin("merge")} />
        : <Text style={[t.meta, { flex: 1 }]}>{waitingFor.length ? `Merge opens when it clears: ${waitingFor.join(", ")}.` : github ? "Waiting for GitHub to confirm it can merge." : "Waiting for Graphite to report it ready to merge."}</Text>}
      {showSwitch && <Switch theme={theme} compact={compact} label={`${github ? "Auto-merge" : "When ready"}${known ? "" : " · unknown"}`} accessibilityLabel={`${github ? "Auto-merge" : "Merge when ready"} for ${pr.repo} pull request ${pr.number}`} value={known ? !!enabled : null} disabled={disabled} onChange={() => begin(enabled ? "disable_mwr" : "enable_mwr")} />}
    </View>}
    {!plan && autoMergeOff && <Text style={t.meta}>Auto-merge is off for this repository. Turn on Allow auto-merge in its GitHub settings.</Text>}
    {error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{error}</Text>}
    {notice && <Text accessibilityLiveRegion="polite" style={t.meta}>{notice}</Text>}
    {plan && (plan.kind === "merge" || browserReady) && <View accessibilityRole="summary" style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={[t.label, { fontSize: 14, lineHeight: 20 }]}>{plan.kind === "merge" ? plan.prs.length > 1 ? "Merge the PRs underneath too?" : "Merge this PR?" : `${plan.kind === "enable_mwr" ? "Enable" : "Disable"} for downstack too?`}</Text>
      <Text style={t.meta}>{plan.kind === "merge" ? plan.prs.length > 1 ? `#${pr.number} depends on ${plan.prs.length - 1} unmerged PR${plan.prs.length === 2 ? "" : "s"}. ${plan.mergeQueue ? `This repository merges through a merge queue, so #${plan.prs[0].number} goes in first; merge the next one after it lands:` : `Merge these ${plan.prs.length} PRs in order:`}` : plan.via === "github" ? plan.mergeQueue ? "GitHub adds it to this repository’s merge queue, which merges it once its checks pass." : `GitHub will ${METHOD_SENTENCE[plan.method ?? "squash"]} once this repository’s required protections pass.` : "Graphite will merge using this repository’s settings and required protections." : `Change ${plan.via === "github" ? "auto-merge" : "merge when ready"} for #${pr.number} only, or for all ${plan.prs.length} listed PRs.`}</Text>
      {(plan.via !== "github" || plan.prs.length > 1 || plan.prs.some(p => p.blockers.length > 0)) && plan.prs.map((p, i) => <View key={p.key} style={{ flexDirection: "row", gap: 8 }}>
        <Text style={[t.meta, { width: 16, textAlign: "right", fontVariant: ["tabular-nums"] }]}>{i + 1}.</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[t.body, { fontSize: 12, lineHeight: 17 }]}>#{p.number} · {p.title}</Text>
          {p.blockers.length > 0 && <Text style={[t.meta, { color: c.statusWarning }]}>{p.blockers.join(" · ")}</Text>}
        </View>
      </View>)}
      {plan.blockers.map(blocker => <Text key={blocker} style={[t.meta, { color: c.statusWarning }]}>{blocker}</Text>)}
      {/* Phones: the confirm is full width with Cancel under it; desktop keeps one row. */}
      <View style={compact ? { gap: 8, marginTop: 4 } : { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 }}>
        <Button grow={compact} title={plan.kind === "merge" ? plan.mergeQueue ? `Add #${plan.prs[0].number} to merge queue` : plan.prs.length > 1 ? `Merge all ${plan.prs.length} PRs` : `Merge #${pr.number}` : `${plan.kind === "enable_mwr" ? "Enable" : "Disable"} for all ${plan.prs.length} PRs`} kind="primary" theme={theme} compact={compact} loading={submit.isPending} disabled={submit.isPending || scopeBlocked("downstack")} onPress={() => act("downstack")} />
        {plan.kind !== "merge" && plan.prs.length > 1 && <Button grow={compact} title="Just this PR" theme={theme} compact={compact} disabled={submit.isPending || scopeBlocked("target")} onPress={() => act("target")} />}
        <Button grow={compact} title="Cancel" kind="ghost" theme={theme} compact={compact} disabled={submit.isPending} onPress={() => { setPlan(null); checking.reset(); submit.reset(); }} />
      </View>
    </View>}
  </View>;
}
