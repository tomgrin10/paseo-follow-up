import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirmPrActionRpc, preparePrActionRpc, prControlStatusRpc, requestReviewersRpc } from "../shared/contracts";
import type { ActionPlan, PrActionKind } from "../shared/pr-actions";
import type { Pr, Workspace } from "../shared/model";
import { Button, type Theme } from "./components";
import { defaultReviewers, noReviewers } from "../shared/reviewers";

export function PrControls({ pr, workspace, theme, compact, browserReady }: { browserReady: boolean; pr: Pr; workspace: Workspace; theme: Theme; compact: boolean }) {
  const read = useRpc(prControlStatusRpc); const prepare = useRpc(preparePrActionRpc); const confirm = useRpc(confirmPrActionRpc); const cache = useQueryClient();
  const requestReviewers = useRpc(requestReviewersRpc);
  const [plan, setPlan] = useState<ActionPlan | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const statusKey = ["follow-through", "pr-controls", workspace.id, pr.key, pr.snapshot?.head];
  const status = useQuery({ queryKey: statusKey, queryFn: () => read({ workspaceId: workspace.id, prKey: pr.key }), refetchInterval: 5000, enabled: browserReady });
  const invalidate = () => { void cache.invalidateQueries({ queryKey: ["follow-through", "workspace", workspace.id] }); void cache.invalidateQueries({ queryKey: ["follow-through", "pr-controls", workspace.id] }); void cache.invalidateQueries({ queryKey: ["follow-through", "overview"] }); };
  const reviewRequest = useMutation({ mutationFn: () => requestReviewers({ workspaceId: workspace.id, prKey: pr.key }), onSuccess: reply => { setNotice(reply.result); invalidate(); }, onError: invalidate });
  const submit = useMutation({ mutationFn: (input: { planId: string; scope: "target" | "downstack" }) => confirm(input), onSuccess: reply => { setPlan(null); setNotice(reply.result); invalidate(); }, onError: invalidate });
  const checking = useMutation({ mutationFn: (kind: PrActionKind) => prepare({ workspaceId: workspace.id, prKey: pr.key, kind }), onSuccess: result => {
    if (result.kind !== "merge" && result.prs.length === 1 && !result.blockers.length && !result.prs[0].blockers.length) submit.mutate({ planId: result.id, scope: "target" });
    else setPlan(result);
  } });
  const pendingAction = workspace.prActions.some(a => ["sending", "uncertain"].includes(a.state));
  const busy = checking.isPending || submit.isPending;
  const actual = browserReady ? status.data?.pr : null;
  const known = !!actual && !status.error && !status.data?.error;
  const enabled = known && actual.mergeWhenReady;
  const queued = actual?.merging || ["QUEUED_TO_MERGE", "WAITING_TO_MERGE", "REBASING", "HANDED_OFF_TO_EXTERNAL_MERGE_QUEUE"].includes(pr.snapshot?.graphiteMergeStatus ?? "");
  const recentlySubmitted = workspace.prActions.some(a => a.kind === "merge" && a.state === "submitted" && a.heads[pr.key] === pr.snapshot?.head && Date.now() - Date.parse(a.createdAt) < 30_000);
  const canMerge = !pr.error && pr.snapshot?.complete && pr.snapshot.state === "OPEN" && pr.snapshot.reviewDecision === "APPROVED" && !pr.snapshot.draft && !pr.snapshot.conflict && !pr.snapshot.failedChecks.length && !pr.snapshot.checksPending && !queued && !recentlySubmitted;
  const disabled = busy || reviewRequest.isPending || pendingAction || workspace.archived;
  const missingReviewers = noReviewers(pr);
  const reviewers = defaultReviewers(pr.repo).filter(r => r.login.toLowerCase() !== pr.snapshot?.reviewers?.author?.toLowerCase());
  const begin = (kind: PrActionKind) => { setPlan(null); setNotice(null); submit.reset(); checking.reset(); checking.mutate(kind); };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 };
  const error = checking.error?.message ?? submit.error?.message ?? reviewRequest.error?.message ?? (browserReady ? status.data?.error : null) ?? null;
  const scopeBlocked = (scope: "target" | "downstack") => !!plan && (plan.blockers.length > 0 || (scope === "target" ? plan.prs.slice(-1) : plan.prs).some(p => p.blockers.length > 0));
  const act = (scope: "target" | "downstack") => { if (plan) submit.mutate({ planId: plan.id, scope }); };
  if (!browserReady && !canMerge && !queued && !recentlySubmitted && !busy && !error && !notice && !plan && !missingReviewers) return null;
  return <View style={{ gap: 5, paddingLeft: 0 }}>
    {missingReviewers && <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ ...muted, color: theme.colors.statusWarning }}>No reviewers</Text>
      {!pr.snapshot?.draft && reviewers.length > 0 && <Button title={reviewRequest.isPending ? "Requesting…" : "Add reviewers"} accessibilityLabel={`Add reviewers: ${reviewers.map(r => r.name).join(" and ")} for ${pr.repo} pull request ${pr.number}`} icon="UserPlus" theme={theme} compact={compact} disabled={disabled} onPress={() => { setNotice(null); reviewRequest.mutate(); }} />}
    </View>}
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
      {browserReady && <Pressable accessibilityRole="switch" aria-checked={known ? !!enabled : "mixed"} aria-valuetext={known ? enabled ? "On" : "Off" : "Unknown"} accessibilityLabel={`Merge when ready for ${pr.repo} pull request ${pr.number}`} accessibilityValue={{ text: known ? enabled ? "On" : "Off" : "Unknown" }} accessibilityState={{ checked: !!enabled, disabled: disabled || !known }} disabled={disabled || !known} onPress={() => begin(enabled ? "disable_mwr" : "enable_mwr")} style={{ minHeight: compact ? 44 : 36, flex: 1, flexDirection: "row", gap: 7, alignItems: "center", opacity: disabled ? 0.5 : 1 }}>
        <View style={{ width: 30, height: 18, borderRadius: 9, backgroundColor: enabled ? theme.colors.accent : theme.colors.surface2, borderWidth: 1, borderColor: enabled ? theme.colors.accent : theme.colors.border }}><View style={{ width: 12, height: 12, borderRadius: 6, position: "absolute", top: 2, left: enabled ? 14 : 2, backgroundColor: known ? enabled ? theme.colors.accentForeground : theme.colors.foregroundMuted : theme.colors.border }} /></View>
        <Text style={{ ...muted, flexShrink: 1 }}>When ready{!known ? " · unknown" : ""}</Text>
      </Pressable>}
      {(canMerge || queued || recentlySubmitted || busy) && <Button title={busy ? checking.isPending ? "Checking…" : "Saving…" : queued ? "Queued" : recentlySubmitted ? "Submitted" : "Merge"} icon={queued ? "Clock" : "GitMerge"} theme={theme} compact={compact} primary={!!canMerge} disabled={disabled || !canMerge} onPress={() => begin("merge")} />}
    </View>
    {error && <Text accessibilityRole="alert" style={{ ...muted, color: theme.colors.statusDanger }}>{error}</Text>}
    {notice && <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text>}
    {plan && (plan.kind === "merge" || browserReady) && <View style={{ gap: 8, backgroundColor: theme.colors.surface1, borderRadius: 6, padding: 10 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", lineHeight: 19 }}>{plan.kind === "merge" ? plan.prs.length > 1 ? "Merge the PRs underneath too?" : "Merge this PR?" : `${plan.kind === "enable_mwr" ? "Enable" : "Disable"} for downstack too?`}</Text>
      <Text style={muted}>{plan.kind === "merge" ? plan.prs.length > 1 ? `#${pr.number} depends on ${plan.prs.length - 1} unmerged PR${plan.prs.length === 2 ? "" : "s"}. Merge these ${plan.prs.length} PRs in order:` : "Graphite will merge using this repository’s settings and required protections." : `Change merge when ready for #${pr.number} only, or for all ${plan.prs.length} listed PRs.`}</Text>
      {plan.prs.map(p => <View key={p.key} style={{ gap: 2 }}><Text style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>#{p.number} · {p.title}</Text>{p.blockers.length > 0 && <Text style={{ ...muted, color: theme.colors.statusWarning }}>{p.blockers.join(" · ")}</Text>}</View>)}
      {plan.blockers.map(blocker => <Text key={blocker} style={{ ...muted, color: theme.colors.statusWarning }}>{blocker}</Text>)}
      <View style={{ gap: 6 }}>
        <Button title={submit.isPending ? "Submitting…" : plan.kind === "merge" ? plan.prs.length > 1 ? `Merge all ${plan.prs.length} PRs` : `Merge #${pr.number}` : `${plan.kind === "enable_mwr" ? "Enable" : "Disable"} for all ${plan.prs.length} PRs`} primary theme={theme} compact={compact} disabled={submit.isPending || scopeBlocked("downstack")} onPress={() => act("downstack")} />
        {plan.kind !== "merge" && plan.prs.length > 1 && <Button title="Just this PR" theme={theme} compact={compact} disabled={submit.isPending || scopeBlocked("target")} onPress={() => act("target")} />}
        <Button title="Cancel" theme={theme} compact={compact} disabled={submit.isPending} onPress={() => { setPlan(null); checking.reset(); submit.reset(); }} />
      </View>
    </View>}
  </View>;
}
