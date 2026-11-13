import { useState, type ReactNode } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { confirmPrActionRpc, preparePrActionRpc } from "../shared/contracts";
import { mergeClick, mergeScope, type MergeClickResult, type MergeScope } from "../shared/merge-click";
import type { Workspace } from "../shared/model";
import { Button, errorText, text, type ButtonKind, type Theme } from "./kit";
import { Text } from "./text";

type Outcome = MergeClickResult | { state: "error"; result: string };
const whyNot = (o: Outcome | undefined) => o?.state === "blocked" ? `Not merged: ${o.blockers.join(" · ")}` : o?.state === "failed" || o?.state === "error" ? `Not merged: ${o.result}` : null;
type Control = { button: ReactNode; notice: ReactNode; label: string | null };

/**
 * Every Merge button (a Needs-you row, the composer pill, Home, a brief, the PR card): one click merges what the
 * button names (a-click-on-merge-merges, shared/merge-click.ts). The button says "Merging…" while it runs; a toast
 * says what happened and the row clears on the next read. A blocker found at click time merges nothing and comes back
 * as `notice`, for the surface to put under its row. One hook per surface (a list draws many rows), so `control`
 * is a plain function. `fallback` is the PR sheet's confirm, only for a PR whose scope can't be known (mergeScope is
 * null: a parent cycle or a downstack PR outside the inventory).
 */
export type MergeButtons = ((prKey: string, o: { theme: Theme; compact: boolean; kind?: ButtonKind; grow?: boolean; disabled?: boolean; fallback?: () => void }) => Control) & {
  /** For a surface with its own buttons (the brief card): the label to show, and the one-click run. Null: no scope. */
  view: (prKey: string) => { label: string; a11y: string; running: boolean; submitted: boolean; why: string | null; run: () => void } | null;
};
export function useMergeButtons(w: Workspace | undefined): MergeButtons {
  const prepare = useRpc(preparePrActionRpc); const confirm = useRpc(confirmPrActionRpc);
  const cache = useQueryClient(); const toast = useToast();
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const settle = (prKey: string, o: Outcome | null) => setOutcomes(all => { const next = { ...all }; if (o) next[prKey] = o; else delete next[prKey]; return next; });
  const refresh = () => { if (w) for (const key of [["follow-up", "workspace", w.id], ["follow-up", "pr-controls", w.id], ["follow-up", "overview"]]) void cache.invalidateQueries({ queryKey: key }); };
  const merge = useMutation({
    mutationFn: ({ prKey, scope }: { prKey: string; scope: MergeScope }) => mergeClick({ prepare: key => prepare({ workspaceId: w!.id, prKey: key, kind: "merge" }), confirm: input => confirm(input) }, prKey, scope),
    onMutate: ({ prKey }) => settle(prKey, null),
    onSuccess: (result, { prKey }) => {
      settle(prKey, result);
      if (result.state === "submitted") toast.show(result.result, { variant: "success" });
      else if (result.state === "uncertain") toast.show(result.result, { variant: "warning" });
      refresh();
    },
    onError: (e, { prKey }) => { settle(prKey, { state: "error", result: errorText(e) }); refresh(); },
  });
  const control = (prKey: string, { theme, compact, kind = "secondary", grow, disabled, fallback }: Parameters<MergeButtons>[1]): Control => {
    const c = theme.colors; const t = text(c, compact);
    const scope = w ? mergeScope(w, prKey) : null;
    const pr = w?.prs.find(p => p.key === prKey);
    if (!scope) return { label: null, notice: null, button: fallback ? <Button theme={theme} compact={compact} kind={kind} grow={grow} icon="GitMerge" title={`Merge #${pr?.number ?? ""}…`} accessibilityLabel={`Review and merge pull request ${pr?.number ?? ""}`} disabled={disabled} onPress={fallback} /> : null };
    const running = merge.isPending && merge.variables?.prKey === prKey;
    const outcome = outcomes[prKey];
    const submitted = outcome?.state === "submitted" || outcome?.state === "uncertain";
    const title = running ? scope.queue ? "Adding to queue…" : "Merging…" : submitted ? scope.queue ? "Added to merge queue" : "Merge submitted" : scope.label;
    const button = <Button theme={theme} compact={compact} kind={kind} grow={grow} icon={submitted ? "Check" : scope.queue ? "ListPlus" : "GitMerge"} title={title} accessibilityLabel={scope.a11y}
      loading={running} disabled={disabled || merge.isPending || submitted} onPress={() => merge.mutate({ prKey, scope })} />;
    const why = whyNot(outcome);
    const notice = why ? <Text accessibilityRole="alert" style={[t.meta, { color: c.statusWarning }]}>{why}</Text> : null;
    return { button, notice, label: scope.label };
  };
  const view: MergeButtons["view"] = prKey => {
    const scope = w ? mergeScope(w, prKey) : null;
    if (!scope) return null;
    const running = merge.isPending && merge.variables?.prKey === prKey;
    const o = outcomes[prKey]; const submitted = o?.state === "submitted" || o?.state === "uncertain";
    return { why: whyNot(o), label: running ? scope.queue ? "Adding to queue…" : "Merging…" : submitted ? scope.queue ? "Added to merge queue" : "Merge submitted" : scope.label, a11y: scope.a11y, running, submitted,
      run: () => { if (!merge.isPending && !submitted) merge.mutate({ prKey, scope }); } };
  };
  return Object.assign(control, { view });
}
