import { Text, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { checkPrActionRpc, controlRpc, sendRpc } from "../shared/contracts";
import { needsYou, shortRefs, type NeedItem } from "../shared/attention";
import type { Workspace } from "../shared/model";
import { Button, Card, CardRow, errorText, text, type Theme } from "./kit";
import type { Colors } from "./theme";

export const workspaceKey = (id: string) => ["follow-through", "workspace", id];
export const overviewKey = ["follow-through", "overview"];

function glyph(item: NeedItem, colors: Colors): { name: string; color: string } {
  switch (item.kind) {
    case "hold": return { name: "CirclePause", color: colors.statusWarning };
    case "retry": return { name: "OctagonAlert", color: colors.statusDanger };
    case "check": return { name: "CircleHelp", color: colors.statusWarning };
    case "decision": return { name: "MessageCircleQuestion", color: colors.statusWarning };
    case "send": return { name: "Send", color: colors.statusWarning };
    case "merge": return { name: "GitMerge", color: colors.statusSuccess };
    case "reviewers": return { name: "UserPlus", color: colors.foregroundMuted };
  }
}

export type NeedActions = {
  openAgent?: (agentId: string) => void;
  openPr?: (prKey: string, intent: "merge" | "reviewers") => void;
  after?: () => void;
};

/** The developer's queue: one row per decision, each with its single action inline. */
export function NeedsYouList({ workspace: w, theme, compact, actions, now = Date.now(), flush = false }: { workspace: Workspace; theme: Theme; compact: boolean; actions: NeedActions; now?: number; flush?: boolean }) {
  const c = theme.colors; const t = text(c);
  const toast = useToast();
  const cache = useQueryClient();
  const control = useRpc(controlRpc); const send = useRpc(sendRpc); const check = useRpc(checkPrActionRpc);
  const refresh = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const fail = (error: Error) => { toast.error(errorText(error)); refresh(); };
  const resume = useMutation({ mutationFn: () => control({ workspaceId: w.id, clearHold: true }), onSuccess: () => { toast.show("Follow-up resumed", { variant: "success" }); refresh(); actions.after?.(); }, onError: fail });
  const retry = useMutation({ mutationFn: (batchId: string) => control({ workspaceId: w.id, retryBatchId: batchId }), onSuccess: () => { toast.show("Repairs queued again"); refresh(); actions.after?.(); }, onError: fail });
  // Say what actually happened to the batch: delivery can be deferred or unconfirmed without an error.
  const deliver = useMutation({ mutationFn: (batchId: string) => send({ workspaceId: w.id, batchId }), onSuccess: (result, batchId) => {
    const b = result.batches.find(x => x.id === batchId);
    if (!b || ["sent", "sending", "completed"].includes(b.state)) toast.show("Sent to the main agent", { variant: "success" });
    else if (b.state === "uncertain") toast.show("Delivery wasn't confirmed. Check the agent before retrying.", { variant: "warning" });
    else if (b.state === "pending") toast.show("Queued. It goes out when the agent is free.", { variant: "info" });
    else toast.error(b.result || "The repairs couldn't be sent.");
    refresh(); actions.after?.();
  }, onError: fail });
  const inspect = useMutation({ mutationFn: (actionId: string) => check({ workspaceId: w.id, actionId }), onSuccess: reply => { toast.show(reply.result, { variant: reply.state === "failed" ? "warning" : "info" }); refresh(); }, onError: fail });
  const items = needsYou(w, now);
  if (!items.length) return null;
  const busy = resume.isPending || retry.isPending || deliver.isPending || inspect.isPending;
  const openMain = actions.openAgent ? () => actions.openAgent!(w.mainAgentId) : undefined;
  const action = (item: NeedItem) => {
    switch (item.kind) {
      case "hold": return <Button theme={theme} compact={compact} kind="primary" icon="Play" title="Resume follow-up" loading={resume.isPending} disabled={busy} onPress={() => resume.mutate()} />;
      case "retry": return item.exhausted
        ? openMain && <Button theme={theme} compact={compact} icon="MessageSquare" title="Open main agent" onPress={openMain} />
        : <>
          <Button theme={theme} compact={compact} icon="RotateCcw" title="Retry" accessibilityLabel="Queue the repairs again" loading={retry.isPending} disabled={busy} onPress={() => retry.mutate(item.batchId)} />
          {openMain && <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquare" title="Open agent" accessibilityLabel="Open main agent" onPress={openMain} />}
        </>;
      case "check": return <Button theme={theme} compact={compact} icon="RefreshCw" title="Check state" loading={inspect.isPending} disabled={busy} onPress={() => inspect.mutate(item.actionId)} />;
      case "decision": return openMain && <Button theme={theme} compact={compact} icon="MessageSquare" title="Answer in chat" onPress={openMain} />;
      case "send": return <Button theme={theme} compact={compact} kind="primary" icon="Send" title="Send to main agent" accessibilityLabel={`Send ${item.tasks.length} repairs to the main agent`} loading={deliver.isPending} disabled={busy || !!item.blocker} onPress={() => deliver.mutate(item.batchId)} />;
      case "merge": return actions.openPr && <Button theme={theme} compact={compact} icon="GitMerge" title={`Merge #${item.number}`} accessibilityLabel={`Review and merge pull request ${item.number}`} onPress={() => actions.openPr!(item.prKey, "merge")} />;
      case "reviewers": return actions.openPr && <Button theme={theme} compact={compact} icon="UserPlus" title="Add reviewers" onPress={() => actions.openPr!(item.prKey, "reviewers")} />;
    }
  };
  return <View>
    {items.map((item, index) => {
      const g = glyph(item, c);
      const button = action(item);
      return <CardRow key={item.key} theme={theme} first={index === 0 && flush} style={flush ? { paddingHorizontal: 0 } : undefined}>
        <View style={{ flexDirection: "row", gap: 9 }}>
          <View style={{ paddingTop: 2 }}><Icon name={g.name} size={14} color={g.color} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={t.body}>{item.title}</Text>
            {"detail" in item && !!item.detail && <Text numberOfLines={3} style={t.meta}>{item.detail}</Text>}
            {item.kind === "send" && <View style={{ gap: 2 }}>
              {item.tasks.slice(0, 4).map((task, i) => <Text key={i} numberOfLines={2} style={t.meta}><Text style={{ fontVariant: ["tabular-nums"] }}>{`${i + 1}. `}</Text>{shortRefs(task, w)}</Text>)}
              {item.tasks.length > 4 && <Text style={t.meta}>{`and ${item.tasks.length - 4} more`}</Text>}
            </View>}
            {(button || (item.kind === "send" && item.blocker)) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 5 }}>
              {button}
              {item.kind === "send" && item.blocker && <Text style={[t.small, { flexShrink: 1 }]}>{item.blocker}</Text>}
            </View>}
          </View>
        </View>
      </CardRow>;
    })}
  </View>;
}

export function NeedsYouCard({ workspace, theme, compact, actions, now }: { workspace: Workspace; theme: Theme; compact: boolean; actions: NeedActions; now: number }) {
  const count = needsYou(workspace, now).length;
  if (!count) return null;
  return <Card theme={theme} compact={compact} icon="CircleAlert" title="Needs you" tone="attention" count={count}>
    <NeedsYouList workspace={workspace} theme={theme} compact={compact} actions={actions} now={now} />
  </Card>;
}
