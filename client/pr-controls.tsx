import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirmPrActionRpc, preparePrActionRpc, prControlStatusRpc, requestReviewersRpc } from "../shared/contracts";
import { mergeBlockers, prActionBlocks, type ActionPlan, type PrActionKind } from "../shared/pr-actions";
import { mergeQueued, mergeReady } from "../shared/attention";
import type { Pr, Workspace } from "../shared/model";
import { Button, Switch, text, type Theme } from "./kit";
import { defaultReviewers, noReviewers } from "../shared/reviewers";

/**
 * Merge, merge-when-ready and reviewer requests for one PR. Every write needs a click; Merge always
 * prepares a fresh plan and asks again before anything reaches Graphite.
 */
export function PrControls({ pr, workspace, theme, compact, browserReady, intent }: { browserReady: boolean; pr: Pr; workspace: Workspace; theme: Theme; compact: boolean; intent?: "merge" | "reviewers" | null }) {
  const read = useRpc(prControlStatusRpc); const prepare = useRpc(preparePrActionRpc); const confirm = useRpc(confirmPrActionRpc); const cache = useQueryClient();
  const requestReviewers = useRpc(requestReviewersRpc);
  const toast = useToast();
  const c = theme.colors; const t = text(c);
  const [plan, setPlan] = useState<ActionPlan | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const statusKey = ["follow-through", "pr-controls", workspace.id, pr.key, pr.snapshot?.head];
  const status = useQuery({ queryKey: statusKey, queryFn: () => read({ workspaceId: workspace.id, prKey: pr.key }), refetchInterval: 5000, enabled: browserReady });
  const invalidate = () => { void cache.invalidateQueries({ queryKey: ["follow-through", "workspace", workspace.id] }); void cache.invalidateQueries({ queryKey: ["follow-through", "pr-controls", workspace.id] }); void cache.invalidateQueries({ queryKey: ["follow-through", "overview"] }); };
  const reviewRequest = useMutation({ mutationFn: () => requestReviewers({ workspaceId: workspace.id, prKey: pr.key }), onSuccess: reply => { setNotice(reply.result); if (reply.state === "submitted") toast.show(reply.result, { variant: "success" }); invalidate(); }, onError: invalidate });
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
  const reviewers = defaultReviewers(pr.repo).filter(r => r.login.toLowerCase() !== pr.snapshot?.reviewers?.author?.toLowerCase());
  const begin = (kind: PrActionKind) => { setPlan(null); setNotice(null); submit.reset(); checking.reset(); checking.mutate(kind); };
  const error = checking.error?.message ?? submit.error?.message ?? reviewRequest.error?.message ?? (browserReady ? status.data?.error : null) ?? null;
  const scopeBlocked = (scope: "target" | "downstack") => !!plan && (plan.blockers.length > 0 || (scope === "target" ? plan.prs.slice(-1) : plan.prs).some(p => p.blockers.length > 0));
  const act = (scope: "target" | "downstack") => { if (plan) submit.mutate({ planId: plan.id, scope }); };
  // Opening the sheet from "Merge…" starts the read-only check; the merge itself still needs the confirm click.
  const started = useRef(false);
  useEffect(() => { if (intent === "merge" && canMerge && !disabled && !started.current) { started.current = true; begin("merge"); } }, [intent, canMerge]);
  if (pr.snapshot?.state !== "OPEN") return null;
  const waitingFor = mergeBlockers(pr).filter(b => !b.startsWith("Graphite "));
  return <View style={{ gap: 10 }}>
    {missingReviewers && <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Icon name="UserX" size={14} color={c.statusWarning} />
      <Text style={[t.meta, { flex: 1, minWidth: 120, color: c.statusWarning }]}>No reviewers yet</Text>
      {!pr.snapshot?.draft && reviewers.length > 0 && <Button title={reviewRequest.isPending ? "Requesting…" : "Add reviewers"} accessibilityLabel={`Add reviewers: ${reviewers.map(r => r.name).join(" and ")} for ${pr.repo} pull request ${pr.number}`} icon="UserPlus" theme={theme} compact={compact} disabled={disabled} loading={reviewRequest.isPending} onPress={() => { setNotice(null); reviewRequest.mutate(); }} />}
    </View>}
    {!plan && <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
      {(canMerge || queued || recentlySubmitted || busy) ? <Button title={busy ? checking.isPending ? "Checking…" : "Submitting…" : queued ? "Queued to merge" : recentlySubmitted ? "Submitted" : `Merge #${pr.number}`} icon={queued ? "Clock" : "GitMerge"} theme={theme} compact={compact} kind={canMerge ? "primary" : "secondary"} loading={busy} disabled={disabled || !canMerge} onPress={() => begin("merge")} />
        : <Text style={[t.meta, { flex: 1 }]}>{waitingFor.length ? `Merge opens when it clears: ${waitingFor.join(", ").toLowerCase()}.` : "Waiting for Graphite to report it ready to merge."}</Text>}
      {browserReady && <Switch theme={theme} compact={compact} label={`When ready${known ? "" : " · unknown"}`} accessibilityLabel={`Merge when ready for ${pr.repo} pull request ${pr.number}`} value={known ? !!enabled : null} disabled={disabled} onChange={() => begin(enabled ? "disable_mwr" : "enable_mwr")} />}
    </View>}
    {error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{error}</Text>}
    {notice && <Text accessibilityLiveRegion="polite" style={t.meta}>{notice}</Text>}
    {plan && (plan.kind === "merge" || browserReady) && <View accessibilityRole="summary" style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={[t.label, { fontSize: 14, lineHeight: 20 }]}>{plan.kind === "merge" ? plan.prs.length > 1 ? "Merge the PRs underneath too?" : "Merge this PR?" : `${plan.kind === "enable_mwr" ? "Enable" : "Disable"} for downstack too?`}</Text>
      <Text style={t.meta}>{plan.kind === "merge" ? plan.prs.length > 1 ? `#${pr.number} depends on ${plan.prs.length - 1} unmerged PR${plan.prs.length === 2 ? "" : "s"}. Merge these ${plan.prs.length} PRs in order:` : "Graphite will merge using this repository’s settings and required protections." : `Change merge when ready for #${pr.number} only, or for all ${plan.prs.length} listed PRs.`}</Text>
      {plan.prs.map((p, i) => <View key={p.key} style={{ flexDirection: "row", gap: 8 }}>
        <Text style={[t.meta, { width: 16, textAlign: "right", fontVariant: ["tabular-nums"] }]}>{i + 1}.</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[t.body, { fontSize: 12, lineHeight: 17 }]}>#{p.number} · {p.title}</Text>
          {p.blockers.length > 0 && <Text style={[t.meta, { color: c.statusWarning }]}>{p.blockers.join(" · ")}</Text>}
        </View>
      </View>)}
      {plan.blockers.map(blocker => <Text key={blocker} style={[t.meta, { color: c.statusWarning }]}>{blocker}</Text>)}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 }}>
        <Button title={plan.kind === "merge" ? plan.prs.length > 1 ? `Merge all ${plan.prs.length} PRs` : `Merge #${pr.number}` : `${plan.kind === "enable_mwr" ? "Enable" : "Disable"} for all ${plan.prs.length} PRs`} kind="primary" theme={theme} compact={compact} loading={submit.isPending} disabled={submit.isPending || scopeBlocked("downstack")} onPress={() => act("downstack")} />
        {plan.kind !== "merge" && plan.prs.length > 1 && <Button title="Just this PR" theme={theme} compact={compact} disabled={submit.isPending || scopeBlocked("target")} onPress={() => act("target")} />}
        <Button title="Cancel" kind="ghost" theme={theme} compact={compact} disabled={submit.isPending} onPress={() => { setPlan(null); checking.reset(); submit.reset(); }} />
      </View>
    </View>}
  </View>;
}
